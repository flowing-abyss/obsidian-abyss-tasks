import { cloneTaskSnapshot } from '../domain/cloneTaskSnapshot';
import type { Clock, TaskCommand, TaskCommandResult, TaskStatusTarget } from '../domain/commands';
import { shiftLocalDate } from '../domain/localDateMath';
import { parseRecurrenceRule } from '../domain/recurrence';
import { StatusCatalog } from '../domain/StatusCatalog';
import type { TaskResolution } from '../domain/taskReconciliation';
import type {
  SubtaskRef,
  SubtaskSnapshot,
  TaskDestination,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
  TaskStatus,
  TaskStatusRule,
} from '../domain/types';
import { sameTaskNodeRef } from '../domain/types';
import { isSingleLineText } from '../domain/validation';
import type { TaskApplicationApi, TaskQueryApi } from './TaskApplicationApi';
import type { TaskBehaviorSettings, TaskBehaviorSettingsProvider } from './TaskBehaviorSettings';
import type { TaskDestinationProvider } from './TaskDestinationProvider';
import type {
  RecurrenceCompletionRequest,
  TaskEditCommand,
  TaskRepository,
} from './TaskRepository';

const TAG_RE = /^#[\w/-]+$/u;

function normalizeTag(tag: string): string {
  return tag.startsWith('#') ? tag : `#${tag}`;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeTagChange(tags: NonNullable<import('../domain/commands').TaskPatch['tags']>) {
  const add = uniqueInOrder((tags.add ?? []).map(normalizeTag));
  const remove = uniqueInOrder((tags.remove ?? []).map(normalizeTag));
  if ([...add, ...remove].some((tag) => !TAG_RE.test(tag))) return undefined;
  const removed = new Set(remove);
  return {
    ...(tags.add !== undefined && { add: add.filter((tag) => !removed.has(tag)) }),
    ...(tags.remove !== undefined && { remove }),
  };
}

function rootRefOf(target: TaskStatusTarget): TaskRef {
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node.ref;
}

function childChain(target: TaskStatusTarget): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') {
    chain.unshift(node.ref);
    node = node.ref.parent;
  }
  return chain;
}

function rebaseStatusTarget(target: TaskStatusTarget, root: TaskRef): TaskStatusTarget {
  if (target.type === 'task') return { type: 'task', ref: root };
  return {
    type: 'subtask',
    ref: {
      ...target.ref,
      parent: rebaseStatusTarget(target.ref.parent, root),
    },
  };
}

function snapshotForTarget(
  root: TaskSnapshot,
  target: TaskStatusTarget,
): TaskSnapshot | SubtaskSnapshot | undefined {
  if (target.type === 'task') return root;
  let current: TaskSnapshot | SubtaskSnapshot = root;
  for (const ref of childChain(target)) {
    const next: SubtaskSnapshot | undefined = current.subtasks.find(
      (candidate) =>
        candidate.ref.relativeLine === ref.relativeLine &&
        candidate.ref.originalBlock === ref.originalBlock,
    );
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function resolvedStatusSelection(
  resolution: Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>,
  target: TaskStatusTarget,
): {
  readonly root: TaskSnapshot;
  readonly target: TaskStatusTarget;
  readonly current: TaskSnapshot | SubtaskSnapshot | undefined;
} {
  if (resolution.type === 'rebased') {
    const rebasedTarget = rebaseStatusTarget(target, resolution.current.ref);
    return {
      root: resolution.current,
      target: rebasedTarget,
      current:
        resolution.evidence === 'byte-identical-relocation'
          ? snapshotForTarget(resolution.current, rebasedTarget)
          : undefined,
    };
  }
  return {
    root: resolution.task,
    target,
    current: snapshotForTarget(resolution.task, target),
  };
}

function statusForRuleType(type: 'todo' | 'in-progress' | 'done' | 'cancelled'): TaskStatus {
  return type === 'todo' ? 'open' : type;
}

function refKey(ref: TaskRef): string {
  return `${ref.filePath}\0${ref.line}\0${ref.revision}`;
}

const RECENT_OUTCOME_LIMIT = 64;
const DEFAULT_BEHAVIOR_SETTINGS: TaskBehaviorSettings = {
  taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
  recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
};
type EditableTaskCommand = Exclude<TaskCommand, { readonly type: 'create' | 'move' }>;
type PreparedTaskCommand =
  | { readonly command: TaskEditCommand }
  | { readonly recurrence: RecurrenceCompletionRequest }
  | { readonly result: TaskCommandResult };
interface RecentOutcome {
  readonly task: TaskSnapshot;
  readonly permittedTarget?: TaskNodeRef;
}
type MoveScheduleCommand = Extract<
  TaskCommand,
  { readonly type: 'move-time-slot' | 'move-to-all-day' }
>;

function moveExceedsDateBounds(task: TaskSnapshot, command: MoveScheduleCommand): boolean {
  const { start, due, scheduled } = task.planning;
  const dates = start && due ? [start, due] : [scheduled ?? due];
  return dates.some(
    (date) => date !== undefined && shiftLocalDate(date, command.days) === undefined,
  );
}

function multilineInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    (command.type === 'shift-schedule' ||
      command.type === 'move-time-slot' ||
      command.type === 'move-to-all-day') &&
    (!Number.isSafeInteger(command.days) ||
      (command.type === 'shift-schedule' && command.days === 0))
  ) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'days' }] };
  }
  if (
    command.type === 'patch' &&
    command.patch.markdownTitle?.type === 'set' &&
    !isSingleLineText(command.patch.markdownTitle.value)
  ) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'title' }] };
  }
  if (command.type === 'append-title' && !isSingleLineText(command.markdown)) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'title' }] };
  }
  if (command.type === 'edit-link' && !isSingleLineText(command.replacement)) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] };
  }
  if (
    (command.type === 'add-comment' || command.type === 'update-comment') &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'comment' }] };
  }
  if (
    command.type === 'add-subtask' &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] };
  }
  if (command.type === 'set-description' && command.text?.replace(/\r\n/gu, '').includes('\r')) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'description' }] };
  }
  return undefined;
}

type BlockCommand = Extract<TaskCommand, { readonly type: 'set-description' | 'add-comment' }>;

function isBlockCommand(command: TaskCommand): command is BlockCommand {
  return command.type === 'set-description' || command.type === 'add-comment';
}

function prepareBlockCommand(
  command: BlockCommand,
  clock: Clock,
): { readonly command: TaskEditCommand } {
  if (command.type === 'add-comment') {
    return { command: { ...command, stamp: clock.today() } };
  }
  if (command.text === null) return { command };
  const text = command.text.replace(/\r\n/gu, '\n');
  return { command: { ...command, text: text.trim().length > 0 ? text : null } };
}

function snapshotBehaviorSettings(provider: TaskBehaviorSettingsProvider): TaskBehaviorSettings {
  const settings = provider();
  return {
    taskLifecycle: { ...settings.taskLifecycle },
    recurrence: { ...settings.recurrence },
  };
}

export class TaskApplicationService implements TaskApplicationApi {
  // Bridges the index-event lag only for exact refs returned by this service. The cache shares the
  // service lifetime and is bounded so revision churn cannot retain an unbounded snapshot history.
  private readonly recentOutcomes = new Map<string, RecentOutcome>();

  constructor(
    readonly queries: TaskQueryApi,
    private readonly repository: TaskRepository,
    private readonly statusCatalog: StatusCatalog,
    private readonly clock: Clock,
    private readonly destinationProvider?: TaskDestinationProvider,
    private readonly behaviorSettings: TaskBehaviorSettingsProvider = () =>
      DEFAULT_BEHAVIOR_SETTINGS,
  ) {}

  async execute(command: TaskCommand): Promise<TaskCommandResult> {
    try {
      const settings = snapshotBehaviorSettings(this.behaviorSettings);
      if (command.type === 'create') return await this.create(command, settings);
      if (command.type === 'move') return await this.move(command);
      const prepared = this.prepare(command, settings);
      if ('result' in prepared) return prepared.result;
      const result =
        'recurrence' in prepared
          ? await this.repository.completeRecurrence(prepared.recurrence)
          : await this.repository.edit(prepared.command);
      if (result.type === 'committed') {
        if (result.outcome.type === 'task') this.remember(result.outcome.task);
        if (result.outcome.type === 'recurrence') {
          if ('recurrence' in prepared) this.forget(rootRefOf(prepared.recurrence.target));
          this.remember(result.outcome.active.root, result.outcome.active.target);
        }
        return { type: 'ok', outcome: result.outcome, changed: result.changed };
      }
      return result;
    } catch {
      return {
        type: 'io-error',
        cause: 'repository-error',
        ...(command.type === 'move' && { path: command.destination.filePath }),
        contentState: 'unknown',
      };
    }
  }

  private async move(
    command: Extract<TaskCommand, { readonly type: 'move' }>,
  ): Promise<TaskCommandResult> {
    const result = await this.repository.move(command.ref, command.destination);
    if (result.type !== 'committed') return result;
    if (result.outcome.type === 'task') this.remember(result.outcome.task);
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private async create(
    command: Extract<TaskCommand, { readonly type: 'create' }>,
    settings: TaskBehaviorSettings,
  ): Promise<TaskCommandResult> {
    if (
      command.markdownBody.replace(/\r\n/gu, '').includes('\r') ||
      command.markdownBody.split(/\r?\n/u)[0]?.trim().length === 0
    ) {
      return { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] };
    }
    const inputIssue = multilineInputIssue(command);
    if (inputIssue) return inputIssue;
    let destination: TaskDestination;
    if (command.destination.type === 'explicit') {
      if (command.destination.provision === undefined) {
        destination = command.destination.destination;
      } else {
        const resolution = await this.destinationProvider?.prepare(command.destination.destination);
        if (resolution === undefined || resolution.type === 'unavailable') {
          return {
            type: 'invalid',
            issues: [{ code: 'destination-unavailable', field: 'destination' }],
          };
        }
        destination = resolution.destination;
      }
    } else {
      const resolution = await this.destinationProvider?.resolveConfiguredDefault();
      if (resolution === undefined || resolution.type === 'unavailable') {
        return {
          type: 'invalid',
          issues: [{ code: 'destination-unavailable', field: 'destination' }],
        };
      }
      destination = resolution.destination;
    }
    const tags = command.initial?.tags && normalizeTagChange(command.initial.tags);
    if (command.initial?.tags !== undefined && tags === undefined) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'tags' }] };
    }
    const initial =
      command.initial === undefined
        ? undefined
        : { ...command.initial, ...(tags !== undefined && { tags }) };
    const result = await this.repository.create(destination, {
      markdownBody: command.markdownBody,
      ...(initial !== undefined && { initial }),
      today: this.clock.today(),
      addCreatedDate: settings.taskLifecycle.addCreatedDate,
    });
    if (result.type !== 'committed') return result;
    if (result.outcome.type === 'task') this.remember(result.outcome.task);
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private prepare(
    command: EditableTaskCommand,
    settings: TaskBehaviorSettings,
  ): PreparedTaskCommand {
    const inputIssue = multilineInputIssue(command);
    if (inputIssue !== undefined) return { result: inputIssue };
    if (isBlockCommand(command)) return prepareBlockCommand(command, this.clock);
    if (command.type === 'add-subtask') {
      return {
        command: {
          ...command,
          today: this.clock.today(),
          addCreatedDate: settings.taskLifecycle.addCreatedDate,
        },
      };
    }

    if (command.type === 'patch' && command.patch.tags !== undefined) {
      const tags = normalizeTagChange(command.patch.tags);
      if (tags === undefined) {
        return {
          result: {
            type: 'invalid',
            issues: [{ code: 'invalid-target', field: 'tags' }],
          },
        };
      }
      return {
        command: {
          ...command,
          patch: {
            ...command.patch,
            tags,
          },
        },
      };
    }

    if (command.type === 'move-time-slot' || command.type === 'move-to-all-day') {
      return this.prepareMoveSchedule(command);
    }

    if (command.type !== 'set-status' && command.type !== 'toggle-completion') {
      return { command };
    }

    const requestedRule =
      command.type === 'set-status' ? this.statusCatalog.ruleForSymbol(command.symbol) : undefined;
    if (command.type === 'set-status' && !requestedRule) {
      return {
        result: {
          type: 'invalid',
          issues: [{ code: 'invalid-status', field: 'status' }],
        },
      };
    }

    const rootRef = rootRefOf(command.target);
    const recent = this.recentFor(command.target);
    const resolution = recent
      ? { type: 'exact' as const, task: recent, basis: { observed: recent } }
      : this.queries.resolve(rootRef);
    if (resolution.type === 'not-found' || resolution.type === 'uncertain') {
      return { result: { type: 'not-found', target: command.target } };
    }
    if (resolution.type === 'ambiguous') {
      return {
        result: {
          type: 'ambiguous',
          candidates: resolution.candidates.map((candidate) => ({
            root: candidate.root,
            target: rebaseStatusTarget(command.target, candidate.root.ref),
          })),
        },
      };
    }
    const resolved = resolvedStatusSelection(resolution, command.target);
    if (!resolved.current) return { result: { type: 'conflict', current: resolved.root } };
    const current = resolved.current;
    const currentRule = this.statusCatalog.ruleForSymbol(current.statusSymbol);
    const currentSemanticStatus = currentRule
      ? statusForRuleType(currentRule.type)
      : this.statusCatalog.statusForSymbol(current.statusSymbol);

    let rule;
    if (command.type === 'set-status') {
      rule = requestedRule!;
    } else {
      const targetType = currentSemanticStatus === 'done' ? 'todo' : 'done';
      rule = this.statusCatalog.defaultForType(targetType);
      if (!rule) {
        return {
          result: {
            type: 'invalid',
            issues: [{ code: 'invalid-status', field: 'status' }],
          },
        };
      }
    }

    const sameConfiguredStatus = currentRule?.symbol === rule.symbol;
    const requestedSemanticStatus = statusForRuleType(rule.type);
    const entersStampedState =
      currentSemanticStatus !== requestedSemanticStatus &&
      (rule.type === 'done' || rule.type === 'cancelled');
    const recurrence = this.prepareRecurrenceCompletion(
      current,
      resolved.target,
      currentSemanticStatus,
      rule,
      settings,
    );
    if (recurrence !== undefined) return recurrence;
    return {
      command: {
        type: 'set-status',
        target: resolved.target,
        symbol: sameConfiguredStatus ? current.statusSymbol : rule.symbol,
        ...(entersStampedState && { stamp: this.clock.today() }),
        ...(rule.type === 'done' && {
          addCompletionDate: settings.taskLifecycle.addCompletionDate,
        }),
      },
    };
  }

  private prepareRecurrenceCompletion(
    current: TaskSnapshot | SubtaskSnapshot,
    target: TaskStatusTarget,
    currentSemanticStatus: TaskStatus,
    requestedRule: TaskStatusRule,
    settings: TaskBehaviorSettings,
  ): Exclude<PreparedTaskCommand, { readonly command: TaskEditCommand }> | undefined {
    if (
      currentSemanticStatus === 'done' ||
      requestedRule.type !== 'done' ||
      current.recurrence === undefined ||
      parseRecurrenceRule(current.recurrence).type !== 'valid'
    ) {
      return undefined;
    }
    const todoRule = this.statusCatalog.defaultForType('todo');
    if (!todoRule) {
      return {
        result: {
          type: 'invalid',
          issues: [{ code: 'invalid-status', field: 'status' }],
        },
      };
    }
    return {
      recurrence: {
        target,
        doneSymbol: requestedRule.symbol,
        today: this.clock.today(),
        todoSymbol: todoRule.symbol,
        addCreatedDate: settings.taskLifecycle.addCreatedDate,
        addCompletionDate: settings.taskLifecycle.addCompletionDate,
        placement: settings.recurrence.newOccurrencePlacement,
        policy: { removeScheduledDate: settings.recurrence.removeScheduledDate },
      },
    };
  }

  private prepareMoveSchedule(
    command: MoveScheduleCommand,
  ): { readonly command: TaskEditCommand } | { readonly result: TaskCommandResult } {
    const recent = this.recentFor({ type: 'task', ref: command.ref });
    const resolution = recent
      ? { type: 'exact' as const, task: recent, basis: { observed: recent } }
      : this.queries.resolve(command.ref);
    let resolved: TaskSnapshot | undefined;
    if (resolution.type === 'exact') resolved = resolution.task;
    if (resolution.type === 'rebased') resolved = resolution.current;
    if (resolved && moveExceedsDateBounds(resolved, command)) {
      return {
        result: {
          type: 'invalid',
          issues: [{ code: 'invalid-date', field: 'schedule' }],
        },
      };
    }
    return { command };
  }

  private remember(task: TaskSnapshot, permittedTarget?: TaskNodeRef): void {
    const key = refKey(task.ref);
    this.recentOutcomes.delete(key);
    this.recentOutcomes.set(key, {
      task: cloneTaskSnapshot(task),
      ...(permittedTarget && { permittedTarget }),
    });
    if (this.recentOutcomes.size <= RECENT_OUTCOME_LIMIT) return;
    const oldest = this.recentOutcomes.keys().next().value;
    if (oldest !== undefined) this.recentOutcomes.delete(oldest);
  }

  private forget(ref: TaskRef): void {
    for (const [key, outcome] of this.recentOutcomes) {
      if (
        outcome.task.ref.filePath === ref.filePath &&
        outcome.task.ref.revision === ref.revision
      ) {
        this.recentOutcomes.delete(key);
      }
    }
  }

  private recentFor(target: TaskNodeRef): TaskSnapshot | undefined {
    const outcome = this.recentOutcomes.get(refKey(rootRefOf(target)));
    if (!outcome) return undefined;
    return !outcome.permittedTarget || sameTaskNodeRef(outcome.permittedTarget, target)
      ? outcome.task
      : undefined;
  }
}
