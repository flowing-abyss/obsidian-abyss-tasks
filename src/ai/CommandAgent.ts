import {
  generateText,
  isStepCount,
  wrapLanguageModel,
  type ModelMessage,
  type ToolCallRepairFunction,
  type ToolSet,
  type TypedToolCall,
} from 'ai';
import type { TasksApiV1 } from '../../api';
import { repairEncodedContainers } from './commandArgumentRepair';
import { CommandEvidence } from './CommandEvidence';
import { commandEditTools } from './commandModelSchema';
import { CommandPendingOperations } from './CommandPendingOperations';
import { commandPrompt } from './commandPrompt';
import { CommandReferenceBook } from './CommandReferenceBook';
import { commandReferences } from './commandReferences';
import { record } from './commandReferenceShapes';
import { creationGrammar, finishGrammar, planToolOutput } from './commandSchemas';
import type { CommandSession } from './CommandSession';
import { canonicalToolName, commandTools, type CommandToolContext } from './commandTools';
import {
  CommandFailure,
  type CommandAgentPort,
  type CommandResearchPort,
  type CommandSessionSnapshot,
} from './commandTypes';
import { reviewCommandWrite, type WriteReviewer } from './commandWriteAuthorization';
import type { ProviderConnections } from './providers/ProviderConnections';
import { providerRetryable } from './providers/providerFailure';
import { parseAgentSettings } from './providers/providerSettings';

export interface CommandAgentOptions {
  readonly api: TasksApiV1;
  readonly session: CommandSession;
  readonly connections: Pick<ProviderConnections, 'model'>;
  readonly settings: () => unknown;
  readonly now: () => number;
  readonly research?: CommandResearchPort;
  readonly temporalContext?: () => string;
  readonly reviewWrite?: WriteReviewer;
}
function generationLifetime(
  parent: AbortSignal | undefined,
  ctx: CommandToolContext,
): { signal: AbortSignal; checkDeadline(): void; dispose(): void } {
  let expired = false;
  const controller = new AbortController(),
    abort = (): void => {
      controller.abort();
    };
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted === true) abort();
  const timer = window.setTimeout(
    () => {
      expired = true;
      abort();
    },
    Math.max(1, Math.min(ctx.deadline - ctx.now(), ctx.researchMode ? 45000 : 40000)),
  );
  return {
    signal: controller.signal,
    checkDeadline: () => {
      if (expired && !ctx.signal.aborted)
        throw new CommandFailure(
          'TIMEOUT',
          'The provider took too long. Your current session is retained.',
        );
    },
    dispose: () => {
      window.clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
function rejectedKind(input: string): string | undefined {
  try {
    let nested: unknown = record(JSON.parse(input))?.['input'];
    if (typeof nested === 'string') nested = JSON.parse(nested) as unknown;
    const value = record(nested);
    return typeof value?.['kind'] === 'string' ? value['kind'] : undefined;
  } catch {
    return undefined;
  }
}
function taskSchemaRepair(input: string): string {
  const kind = rejectedKind(input);
  let envelope = '';
  try {
    const root = record(JSON.parse(input));
    if (
      root !== undefined &&
      Object.keys(root).length === 3 &&
      typeof root['plan'] === 'string' &&
      typeof root['expectedPlanRevision'] === 'string' &&
      record(root['operation']) !== undefined
    )
      envelope =
        ' Move unchanged operands into {input:{kind:append,plan,expectedPlanRevision,operation}} only if this is the intended pending-plan refinement.';
  } catch {
    /* Invalid JSON has no inferred operation. */
  }
  return `Use outer input object, not encoded JSON; advertised ${kind ?? 'intended'} branch, exact content/references. Missing/malformed kind does not imply create. create requires destination/tree; metadata in tree.initial, set/value or clear. edit: target/expectedRevision beside kind. append: operation; batch: operations beside plan/expectedPlanRevision, never nested. Copy target’s own editBasis; one tree per plan, independent saved roots need separate edits. Never replace failed refinement with creation.${envelope}`;
}
function validationIssue(value: unknown): string {
  const issue = record(value);
  if (!Array.isArray(issue?.['path']) || typeof issue['code'] !== 'string') return '';
  const path = issue['path']
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join('.')
    .slice(0, 160);
  const expected = typeof issue['expected'] === 'string' ? ` (${issue['expected']})` : '';
  const keys =
    issue['code'] === 'unrecognized_keys' && Array.isArray(issue['keys'])
      ? issue['keys']
          .filter(
            (key): key is string =>
              typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key),
          )
          .slice(0, 8)
          .join(', ')
      : '';
  const removed = keys === '' ? '' : `; unrecognized at this level: ${keys}`;
  return `${path === '' ? 'arguments' : path}: ${issue['code']}${expected}${removed}`;
}
function validationLeaves(issues: unknown[], depth = 0): string[] {
  return issues
    .slice(0, 8)
    .flatMap((issue: unknown) => {
      const errors = record(issue)?.['errors'];
      if (depth < 3 && Array.isArray(errors)) {
        const branch = errors
          .slice(0, 32)
          .filter((entry: unknown): entry is unknown[] => Array.isArray(entry))
          .sort((a, b) => a.length - b.length)[0];
        if (branch !== undefined)
          return validationLeaves(branch, depth + 1).map((hint) => `Possible branch: ${hint}`);
      }
      return [validationIssue(issue)];
    })
    .slice(0, 8);
}
function validationHint(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const value = record(cause);
    if (Array.isArray(value?.['issues']))
      return validationLeaves(value['issues']).filter(Boolean).join('; ').slice(0, 1200);
    cause = value?.['cause'];
  }
  return '';
}
function rejectedRemoval(name: string, input: string): boolean {
  if (!['task', 'change_task'].includes(name)) return false;
  try {
    const outer = record(JSON.parse(input));
    const type = record((record(outer?.['input']) ?? outer)?.['operation'])?.['type'];
    return type === 'delete' || type === 'remove';
  } catch {
    return false;
  }
}
function schemaRepairMessage(name: string, input: string, error: unknown): string {
  const common = `Arguments rejected; nothing ran. Retain intended content/target. ${validationHint(error)} `;
  if (rejectedRemoval(name, input))
    return `${common}For whole-task deletion use change_task with the matched row’s issued edit and operation:{"type":"remove"}, complete:true. This previews the entire subtree.`;
  if (name === 'task') return common + taskSchemaRepair(input);
  if (name === 'create_task')
    return `${common}${creationGrammar}; requested facts only, metadata in tree.initial, never stringify containers.`;
  if (name === 'change_task')
    return `${common}Use references.taskReferences[].edit (the b handle, never target). Metadata shape: {"edit":"<issued edit>","operation":{"type":"set","time":"HH:mm"}}; use the requested field/value. Keep exact owner.`;
  if (name === 'interpret') return common + controlSchemaRepair(input);
  if (name === 'finish')
    return `${common}Use ${finishGrammar}; blockers need issued evidence; selection: exact typed targets/revisions/bases. Prepared work needs no selection/saving question.`;
  if (name === 'project')
    return `${common}Read project-schema; use fields:[{fieldId,value}] and target/expectedRevision, not task date patches.`;
  if (name === 'note')
    return `${common}input: create/title/text (path if requested), edit/target/expectedRevision/operation, or refine/plan/expectedPlanRevision/operation. Keep content/frozen path. replace-body: new-note plans only.`;
  return `${common}Match one advertised schema branch; omit unrelated fields. Keep exact references/requested values.`;
}
function controlSchemaRepair(input: string): string {
  try {
    const intent = record(JSON.parse(input))?.['intent'];
    if (intent === 'acknowledge-uncertainty' || intent === 'review')
      return 'That recovery action is unavailable in this session. For ordinary work retry interpret({"intent":"plan"}) first; refine the current draft with its issued edit, or use create_task for an additional requested activity.';
    if (intent === 'confirm')
      return 'Nothing was saved. Confirmation requires approval containing the entire current userMessage verbatim when it approves the displayed proposal as shown. A subset needs nonempty exact issued selections; omit scope only for the whole proposal. If the message requests a revision, return to interpret({intent:"plan"}) and preview it; finish neither saves nor repairs control.';
  } catch {
    // Unparseable control has no known branch.
  }
  return 'Use intended control branch only. Ordinary work needs no interpret. Control precedes work. new-session: disposition; transitionDisposition requires pending transition. Voice: voiceMode; research requires trusted explicit permission.';
}
function repairCall(ctx: CommandToolContext): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error, tools: activeTools }) => {
    const schema = Object.prototype.hasOwnProperty.call(activeTools, toolCall.toolName)
      ? activeTools[toolCall.toolName]?.inputSchema
      : undefined;
    if (schema !== undefined) {
      const repaired = await repairEncodedContainers(toolCall.input, schema);
      if (repaired !== undefined) return { ...toolCall, input: repaired };
    }
    ctx.feedback.set(
      toolCall.toolCallId,
      schemaRepairMessage(toolCall.toolName, toolCall.input, error),
    );
    return null;
  };
}
function accountRejectedMetadata(ctx: CommandToolContext, call: TypedToolCall<ToolSet>): boolean {
  const basis =
    call.toolName === 'change_task'
      ? ctx.references?.schemaRefinement(call.input, commandReferences(ctx.session.snapshot()))
      : undefined;
  if (basis === undefined) return false;
  // A flat request still identifies the exact fields even when one value is invalid.
  if (record(record(call.input)?.['operation'])?.['type'] === 'set')
    ctx.pendingOperations.reject(call.toolName, call.input);
  ctx.pendingOperations.rejectSchema(basis, ctx.generation);
  ctx.repair(call.toolCallId);
  return true;
}
function accountRejected(ctx: CommandToolContext, call: TypedToolCall<ToolSet>): void {
  if (accountRejectedMetadata(ctx, call)) return;
  const input = JSON.stringify(call.input);
  ctx.pendingOperations.reject(call.toolName, call.input);
  const kind = rejectedKind(input);
  if (
    call.toolName === 'change_task' ||
    (call.toolName === 'task' &&
      ['append', 'batch', 'edit', 'refresh', 'hierarchy'].includes(kind ?? ''))
  )
    ctx.unresolvedTaskRefinement = true;
  ctx.errors.add(canonicalToolName(call.toolName));
  ctx.repair(call.toolCallId);
}
function deferControlSiblings(
  ctx: CommandToolContext,
  calls: ReadonlyArray<TypedToolCall<ToolSet>>,
): void {
  const first = calls[0];
  const startsWithControl = first?.toolName === 'interpret';
  if (!ctx.interpreted && startsWithControl && first.invalid === true) {
    const input = record(first.input) ?? {};
    ctx.controlRepair ??= {
      intent: input['intent'],
      scoped: input['scope'] !== undefined,
    };
  }
  if (ctx.controlRepair === undefined) return;
  for (const call of calls.slice(startsWithControl ? 1 : 0)) {
    ctx.deferred.add(call.toolCallId);
    ctx.feedback.set(
      call.toolCallId,
      'Deferred. Correct interpret first, then resubmit this work. Nothing ran.',
    );
  }
}
function accountCalls(ctx: CommandToolContext, calls: Array<TypedToolCall<ToolSet>>): void {
  ctx.generation++;
  ctx.generationCalls = calls.length;
  ctx.deferred.clear();
  ctx.rejected.clear();
  deferControlSiblings(ctx, calls);
  calls.forEach((call) => {
    if (call.invalid === true) ctx.rejected.add(call.toolCallId);
  });
  // Parsing is parallel; admit rejected predecessors only at the serial execution boundary.
  ctx.account = (id) => {
    while (calls.length > 0) {
      const call = calls.shift();
      if (call === undefined || call.toolCallId === id) return;
      if (call.invalid === true && !ctx.deferred.has(call.toolCallId)) accountRejected(ctx, call);
    }
  };
}
function repairMessages(
  messages: ModelMessage[],
  feedback: ReadonlyMap<string, string>,
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const text = feedback.get(part.toolCallId);
        return text === undefined
          ? part
          : { ...part, output: { type: 'error-text' as const, value: text } };
      }),
    };
  });
}
type GenerationPrompt = Parameters<ReturnType<typeof wrapLanguageModel>['doGenerate']>[0]['prompt'];
function requestToolCall(prompt: GenerationPrompt): GenerationPrompt {
  return prompt.map((message) =>
    message.role === 'system'
      ? {
          ...message,
          content: `${message.content}\nReturn a tool call. Read previous tool results; do not repeat successful operations. Complete the remaining request, or call finish if it is complete.`,
        }
      : message,
  );
}
function missingToolCall(result: {
  finishReason: { unified: string };
  content: ReadonlyArray<{ type: string }>;
}): boolean {
  return (
    (result.finishReason.unified === 'stop' || result.finishReason.unified === 'length') &&
    result.content.length > 0 &&
    result.content.every((part) => part.type === 'text' || part.type === 'reasoning')
  );
}
function assertGenerationCurrent(ctx: CommandToolContext, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (ctx.now() >= ctx.deadline)
    throw new CommandFailure('TIMEOUT', 'This request took too long. Your draft is retained.');
}
function requireFormatRetry(alreadyRequested: boolean, attempt: number): void {
  if (alreadyRequested || attempt >= 2)
    throw new CommandFailure(
      'INCOMPLETE',
      'The model returned no action. Review the retained draft.',
    );
}
function canRetryGeneration(attempt: number, signal: AbortSignal, cause: unknown): boolean {
  return attempt < 2 && !signal.aborted && providerRetryable(cause);
}
function soleWorkingCreation(state: CommandSessionSnapshot): string | undefined {
  const change = state.proposal.changes.length === 1 ? state.proposal.changes[0] : undefined;
  if (change?.kind !== 'task' || change.plan.kind !== 'create') return undefined;
  const root = change.plan.after?.target;
  return state.focus.every((row) => row.kind === 'task' && row.target === root) ? root : undefined;
}
export class CommandAgent implements CommandAgentPort {
  private turnSequence = 0;
  constructor(private readonly options: CommandAgentOptions) {}
  private model(
    ctx: CommandToolContext,
    signal: AbortSignal,
  ): ReturnType<typeof wrapLanguageModel> {
    let requestedAction = false;
    return wrapLanguageModel({
      model: this.options.connections.model(parseAgentSettings(this.options.settings())),
      middleware: {
        wrapGenerate: async ({ model: underlying, params }) => {
          const state = ctx.session.snapshot();
          const tools = commandEditTools(
            params.tools,
            ctx.references,
            () => commandReferences(state),
            {
              workingRoot: soleWorkingCreation(state),
              retryEvidence: ctx.evidence?.retryableFindEvidence() ?? [],
            },
          );
          const request = tools === undefined ? params : { ...params, tools };
          const lifetime = generationLifetime(params.abortSignal, ctx);
          let prompt = params.prompt;
          try {
            for (let attempt = 0; ; attempt++) {
              assertGenerationCurrent(ctx, signal);
              try {
                const result = await underlying.doGenerate({
                  ...request,
                  prompt,
                  abortSignal: lifetime.signal,
                });
                if (!missingToolCall(result)) return result;
                lifetime.checkDeadline();
                lifetime.signal.throwIfAborted();
                requireFormatRetry(requestedAction, attempt);
                ctx.repair('missing-action');
                requestedAction = true;
                // This generation ran no tools. Keep the original user request, admitted work and
                // permissions; never turn the model's prose into instructions or confirmation.
                prompt = requestToolCall(params.prompt);
              } catch (cause) {
                lifetime.checkDeadline();
                if (!canRetryGeneration(attempt, lifetime.signal, cause)) throw cause;
              }
            }
          } finally {
            lifetime.dispose();
          }
        },
      },
    });
  }
  private context(
    input: Parameters<CommandAgentPort['run']>[0],
    start: number,
  ): CommandToolContext {
    const repairs = new Set<string>();
    const turn = (++this.turnSequence).toString(36);
    const references = new CommandReferenceBook(turn);
    let repairsUsed = 0;
    const context: CommandToolContext = {
      userMessage: input.text,
      api: this.options.api,
      session: this.options.session,
      basis: input.session,
      signal: input.signal,
      now: this.options.now,
      deadline: start + 120000,
      researchMode: false,
      researchCalls: 0,
      interpreted: false,
      immediate: false,
      done: false,
      errors: new Set(),
      generation: 0,
      deferred: new Set(),
      rejected: new Set(),
      pendingOperations: new CommandPendingOperations((value) => references.identity(value), turn),
      feedback: new Map(),
      repairExhausted: false,
      references,
      evidence: new CommandEvidence(),
      capabilities: new Set(['find', 'inspect', 'create_task', 'change_task']),
      ...(this.options.research === undefined ? {} : { research: this.options.research }),
      repair: (call) => {
        if (repairs.has(call) || ++repairsUsed > 2) {
          context.repairExhausted = true;
          throw new CommandFailure(
            'REPAIR_LIMIT',
            'The request could not be prepared reliably. Your draft is retained.',
          );
        }
        repairs.add(call);
      },
    };
    return context;
  }
  private modelContext(snapshot: CommandSessionSnapshot): unknown {
    const actual = new Map(snapshot.actual.map((tree) => [tree.target, tree]));
    const pages = new Map(snapshot.entities.tasks.map((page) => [page.tree.target, page]));
    for (const target of actual.keys()) pages.delete(target);
    const recentReplies = new Set(
      snapshot.exchanges.filter((entry) => entry.role === 'agent').slice(-16),
    );
    return {
      id: snapshot.id,
      focus: snapshot.focus,
      context: snapshot.context,
      status: snapshot.status,
      activeQuestion: snapshot.activeQuestion,
      pendingTransition: snapshot.pendingTransition,
      recovery: snapshot.recovery,
      blocked: snapshot.blocked,
      voiceMode: snapshot.voiceMode,
      exchanges: snapshot.exchanges.filter(
        (entry) => entry.role === 'user' || recentReplies.has(entry),
      ),
      proposal: {
        revision: snapshot.proposal.revision,
        operations: snapshot.proposal.operations,
        changes: snapshot.proposal.changes.map((change) => {
          if (change.kind !== 'task') return change;
          return {
            ...change,
            plan: planToolOutput(change.plan, false),
            planBasis: {
              plan: change.plan.target,
              expectedPlanRevision: change.plan.revision,
            },
          };
        }),
      },
      entities: { ...snapshot.entities, tasks: [...pages.values()] },
      actual: [...actual.values()],
      projection: 'Current working state; full native pages remain available through read(tree).',
      references: commandReferences(snapshot),
    };
  }
  private activeTools(ctx: CommandToolContext): string[] {
    const allowed = [...(ctx.capabilities ?? [])];
    return [
      ...(!ctx.interpreted ? ['interpret'] : []),
      'expand',
      'finish',
      ...allowed.filter(
        (name) =>
          !this.options.session.readOnly() ||
          ['find', 'inspect', 'read', 'research'].includes(name),
      ),
    ];
  }
  async run(input: Parameters<CommandAgentPort['run']>[0]): Promise<void> {
    const start = this.options.now();
    const ctx = this.context(input, start);
    const model = this.model(ctx, input.signal);
    ctx.reviewWrite =
      this.options.reviewWrite ?? ((request) => reviewCommandWrite(model, request, input.signal));
    const tools = commandTools(ctx);
    const policy = await this.options.api.tasks.creationPolicy?.().catch(() => undefined);
    const clock = this.options.temporalContext?.() ?? new Date(start).toISOString();
    const instructions = `${commandPrompt}\n\ntemporalContext is the vault clock for this request: ${clock}. Resolve all relative dates from this local date.`;
    const prompt = JSON.stringify({
      creationPolicy: policy?.ok === true ? policy.value : undefined,
      visibleSession: ctx.references?.project(this.modelContext(input.session)),
      userMessage: input.text,
    });
    if (prompt.length + instructions.length > 96000)
      throw new CommandFailure(
        'CONTEXT_LIMIT',
        'This session is too large for another model turn. Save or start a new session.',
      );
    const result = await generateText({
      model,
      instructions,
      prompt,
      tools,
      toolChoice: 'required',
      toolCallConcurrency: 1,
      maxRetries: 0,
      maxOutputTokens: 4096,
      abortSignal: input.signal,
      timeout: { totalMs: 180000, stepMs: 45000 },
      stopWhen: [isStepCount(12), () => ctx.done || ctx.repairExhausted],
      prepareStep: ({ messages }) => {
        input.signal.throwIfAborted();
        if (ctx.repairExhausted)
          throw new CommandFailure(
            'REPAIR_LIMIT',
            'The request could not be prepared reliably. Your draft is retained.',
          );
        ctx.deadline = start + (ctx.researchMode ? 180000 : 120000);
        if (this.options.now() >= ctx.deadline || ctx.done)
          throw new CommandFailure('TIMEOUT', 'This request stopped. Your draft is retained.');
        return {
          instructions,
          activeTools: this.activeTools(ctx),
          maxOutputTokens: ctx.researchMode ? 8192 : 4096,
          messages: repairMessages(messages, ctx.feedback),
        };
      },
      repairToolCall: repairCall(ctx),
      onLanguageModelCallEnd: ({ content }) => {
        accountCalls(
          ctx,
          content.filter((part) => part.type === 'tool-call'),
        );
      },
      onStepEnd: ({ content }) => {
        for (const part of content) {
          if (
            'toolCallId' in part &&
            (ctx.deferred.has(part.toolCallId) || ctx.rejected.has(part.toolCallId))
          )
            continue;
          if (part.type === 'tool-error') ctx.errors.add(canonicalToolName(part.toolName));
          if (part.type === 'tool-result') ctx.errors.delete(canonicalToolName(part.toolName));
        }
        ctx.account?.();
      },
    });
    input.signal.throwIfAborted();
    if (ctx.repairExhausted)
      throw new CommandFailure(
        'REPAIR_LIMIT',
        'The request could not be prepared reliably. Your draft is retained.',
      );
    this.requireFinished(
      ctx,
      result.steps.some((step) => step.content.some((part) => part.type === 'tool-error')),
    );
  }
  private requireFinished(ctx: CommandToolContext, failed: boolean): void {
    if (ctx.done && ctx.errors.size === 0 && !ctx.pendingOperations.unresolved) return;
    throw new CommandFailure(
      failed ? 'TOOL_ERROR' : 'INCOMPLETE',
      failed
        ? 'Some requested changes could not be prepared. Your draft is retained.'
        : 'The request stopped before it was complete. Review the retained draft.',
    );
  }
}
