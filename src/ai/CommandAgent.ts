import { APICallError, generateText, isStepCount, wrapLanguageModel, type ModelMessage } from 'ai';
import type { TasksApiV1 } from '../../api';
import type { CommandSession } from './CommandSession';
import { commandPrompt } from './commandPrompt';
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
function schemaRepairMessage(name: string): string {
  const common =
    'Arguments were rejected; no operation ran. Repair their format without changing the intended content or target. ';
  if (name === 'task')
    return `${
      common
    }input must be an object, never a JSON string. Use input.kind=append with ONE operation object, or input.kind=batch with an operations array directly beside plan and expectedPlanRevision. Never put batch inside operation. Use exact opaque plan references.`;
  if (name === 'finish')
    return `${
      common
    }Use state=ready with message, or state=question with message and blockingIssue {kind:missing-information|conflict, detail}. A ready proposal does not need saving permission.`;
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
      submissionBasis: undefined,
      journal: undefined,
      trees: undefined,
      proposal: {
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
      visibleSession: this.modelContext(input.session),
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
        ctx.feedback.set(toolCall.toolCallId, schemaRepairMessage(toolCall.toolName));
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
    if (!ctx.done) {
      const failed = result.steps.some((step) =>
        step.content.some((part) => part.type === 'tool-error'),
      );
      throw new CommandFailure(
        failed ? 'TOOL_ERROR' : 'INCOMPLETE',
        failed
          ? 'Some requested changes could not be prepared. Your draft is retained.'
          : 'The request stopped before it was complete. Review the retained draft.',
      );
    }
  }
}
