import { APICallError, generateText, isStepCount, wrapLanguageModel, type ModelMessage } from 'ai';
import type { TasksApiV1 } from '../../api';
import { CommandReferenceBook } from './CommandReferenceBook';
import type { CommandSession } from './CommandSession';
import { commandPrompt } from './commandPrompt';
import { commandReferences } from './commandReferences';
import { planToolOutput } from './commandSchemas';
import { commandTools, type CommandToolContext } from './commandTools';
import {
  CommandFailure,
  type CommandAgentPort,
  type CommandResearchPort,
  type CommandSessionSnapshot,
} from './commandTypes';
import type { ProviderConnections } from './providers/ProviderConnections';
import { ProviderFailure } from './providers/providerFailure';
import { parseProviderSettings } from './providers/providerSettings';

export interface CommandAgentOptions {
  readonly api: TasksApiV1;
  readonly session: CommandSession;
  readonly connections: Pick<ProviderConnections, 'model'>;
  readonly settings: () => unknown;
  readonly now: () => number;
  readonly research?: CommandResearchPort;
  readonly temporalContext?: () => string;
}
function retryable(cause: unknown): boolean {
  if (APICallError.isInstance(cause)) return cause.isRetryable;
  return cause instanceof ProviderFailure && ['unavailable', 'rate-limit'].includes(cause.code);
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
    Math.max(1, Math.min(ctx.deadline - ctx.now(), ctx.researchMode ? 45000 : 25000)),
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
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    let nested: unknown = Reflect.get(parsed, 'input');
    // Inspect only the discriminator for feedback. Never execute a coerced payload.
    if (typeof nested === 'string') nested = JSON.parse(nested) as unknown;
    if (nested === null || typeof nested !== 'object') return undefined;
    const kind: unknown = Reflect.get(nested, 'kind');
    return typeof kind === 'string' ? kind : undefined;
  } catch {
    return undefined;
  }
}
function taskSchemaRepair(input: string): string {
  const kind = rejectedKind(input),
    object = 'input must be an object, never a JSON string. ';
  if (kind === 'create')
    return `${object}Use input.kind=create, destination and tree. tree contains markdownTitle, optional description/comments/children and tree.initial. Put scheduled/due/start/time/durationMinutes/tags/statusSymbol only in tree.initial; field assignments use {type:set,value} or {type:clear}. Children have that same tree shape. Do not change to append or invent plan references.`;
  if (kind === 'append' || kind === 'batch')
    return `${object}Use input.kind=append with ONE operation object, or input.kind=batch with an operations array directly beside plan and expectedPlanRevision. Never put batch inside operation. Use each target’s own exact editBasis; append/batch can only refine nodes in that one plan, never combine independent roots.`;
  return `${object}Keep the intended kind; match its advertised fields. Do not switch to append/batch or invent references. If creating, use destination and tree; metadata belongs in tree.initial. Example: {"input":{"kind":"create","destination":{"type":"configured-default"},"tree":{"markdownTitle":"Task","initial":{"scheduled":{"type":"set","value":"2026-08-02"}}}}}.`;
}
function schemaRepairMessage(name: string, input: string): string {
  const common =
    'Arguments were rejected; no operation ran. Repair their format without changing the intended content or target. ';
  if (name === 'task') return common + taskSchemaRepair(input);
  if (name === 'interpret')
    return `${common}For new-session use disposition=keep|discard, not transitionDisposition. For a current pendingTransition use resolve-transition and transitionDisposition=save|keep|discard|cancel; use plan with transitionDisposition when resolving and continuing requested work in the same turn. Omit unrelated voiceMode/disposition fields. No pendingTransition means ordinary work uses plan. To cancel an unsaved task in this same session, use plan with no disposition, then task append/batch with a sole remove on its exact draft root.`;
  if (name === 'finish')
    return `${
      common
    }Use state=ready with message, or state=question with message and blockingIssue {kind:missing-information|conflict, detail}. Every selection entry needs kind=task|project|note and its exact returned target/basis; a project is never a task. A ready proposal does not need saving permission.`;
  if (name === 'read' || name === 'note')
    return `${
      common
    }Use an object input. Match one advertised kind and only its fields; tree selects an opaque target, while note selectors can use a path. Never encode input as a string.`;
  return `${common}Follow this tool’s exact object schema; do not add undeclared fields.`;
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
export class CommandAgent implements CommandAgentPort {
  private turnSequence = 0;
  constructor(private readonly options: CommandAgentOptions) {}
  private model(
    ctx: CommandToolContext,
    signal: AbortSignal,
  ): ReturnType<typeof wrapLanguageModel> {
    return wrapLanguageModel({
      model: this.options.connections.model(parseProviderSettings(this.options.settings())),
      middleware: {
        wrapGenerate: async ({ model: underlying, params }) => {
          const lifetime = generationLifetime(params.abortSignal, ctx);
          try {
            for (let attempt = 0; ; attempt++) {
              signal.throwIfAborted();
              if (this.options.now() >= ctx.deadline)
                throw new CommandFailure(
                  'TIMEOUT',
                  'This request took too long. Your draft is retained.',
                );
              try {
                return await underlying.doGenerate({ ...params, abortSignal: lifetime.signal });
              } catch (cause) {
                lifetime.checkDeadline();
                if (attempt >= 2 || lifetime.signal.aborted || !retryable(cause)) throw cause;
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
    let repairsUsed = 0;
    const context: CommandToolContext = {
      api: this.options.api,
      session: this.options.session,
      basis: input.session,
      signal: input.signal,
      now: this.options.now,
      deadline: start + 60000,
      researchMode: false,
      researchCalls: 0,
      interpreted: false,
      immediate: false,
      done: false,
      errors: new Set(),
      feedback: new Map(),
      repairExhausted: false,
      references: new CommandReferenceBook((++this.turnSequence).toString(36)),
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
      ...snapshot,
      exchanges: snapshot.exchanges.filter(
        (entry) => entry.role === 'user' || recentReplies.has(entry),
      ),
      references: commandReferences(snapshot),
      submissionBasis: undefined,
      journal: undefined,
      trees: undefined,
      proposal: {
        revision: snapshot.proposal.revision,
        operations: snapshot.proposal.operations,
        changes: snapshot.proposal.changes.map((change) => {
          if (change.kind !== 'task') return change;
          return {
            ...change,
            plan: planToolOutput(change.plan),
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
    };
  }
  private activeTools(ctx: CommandToolContext): string[] {
    if (!ctx.interpreted) return ['interpret'];
    if (this.options.session.readOnly()) return ['read', 'research', 'finish'];
    return ['read', 'task', 'status', 'note', 'project', 'link', 'cleanup', 'research', 'finish'];
  }
  async run(input: Parameters<CommandAgentPort['run']>[0]): Promise<void> {
    const start = this.options.now();
    const ctx = this.context(input, start);
    const model = this.model(ctx, input.signal);
    const tools = commandTools(ctx);
    const prompt = JSON.stringify({
      temporalContext: this.options.temporalContext?.() ?? new Date(start).toISOString(),
      userMessage: input.text,
      visibleSession: ctx.references?.project(this.modelContext(input.session)),
    });
    if (prompt.length + commandPrompt.length > 96000)
      throw new CommandFailure(
        'CONTEXT_LIMIT',
        'This session is too large for another model turn. Save or start a new session.',
      );
    const result = await generateText({
      model,
      instructions: commandPrompt,
      prompt,
      tools,
      toolChoice: 'required',
      toolCallConcurrency: 1,
      maxRetries: 0,
      maxOutputTokens: 4096,
      abortSignal: input.signal,
      timeout: { totalMs: 180000, stepMs: 45000 },
      stopWhen: [
        isStepCount(12),
        ({ steps }) =>
          ctx.done || ctx.repairExhausted || steps.length >= (ctx.researchMode ? 12 : 6),
      ],
      prepareStep: ({ messages }) => {
        input.signal.throwIfAborted();
        if (ctx.repairExhausted)
          throw new CommandFailure(
            'REPAIR_LIMIT',
            'The request could not be prepared reliably. Your draft is retained.',
          );
        ctx.deadline = start + (ctx.researchMode ? 180000 : 60000);
        if (this.options.now() >= ctx.deadline || ctx.done)
          throw new CommandFailure('TIMEOUT', 'This request stopped. Your draft is retained.');
        return {
          activeTools: this.activeTools(ctx),
          maxOutputTokens: ctx.researchMode ? 8192 : 4096,
          messages: repairMessages(messages, ctx.feedback),
        };
      },
      repairToolCall: async ({ toolCall }) => {
        const kind = rejectedKind(toolCall.input);
        if (
          toolCall.toolName === 'task' &&
          ['append', 'batch', 'edit', 'refresh', 'hierarchy'].includes(kind ?? '')
        )
          ctx.unresolvedTaskRefinement = true;
        ctx.feedback.set(
          toolCall.toolCallId,
          schemaRepairMessage(toolCall.toolName, toolCall.input),
        );
        ctx.repair(toolCall.toolCallId);
        ctx.errors.add(toolCall.toolName);
        return null;
      },
      onStepEnd: ({ content }) => {
        for (const part of content) {
          if (part.type === 'tool-error') ctx.errors.add(part.toolName);
          if (part.type === 'tool-result') ctx.errors.delete(part.toolName);
        }
      },
    });
    input.signal.throwIfAborted();
    if (ctx.repairExhausted)
      throw new CommandFailure(
        'REPAIR_LIMIT',
        'The request could not be prepared reliably. Your draft is retained.',
      );
    this.requireFinished(
      ctx.done,
      result.steps.some((step) => step.content.some((part) => part.type === 'tool-error')),
    );
  }
  private requireFinished(done: boolean, failed: boolean): void {
    if (done) return;
    throw new CommandFailure(
      failed ? 'TOOL_ERROR' : 'INCOMPLETE',
      failed
        ? 'Some requested changes could not be prepared. Your draft is retained.'
        : 'The request stopped before it was complete. Review the retained draft.',
    );
  }
}
