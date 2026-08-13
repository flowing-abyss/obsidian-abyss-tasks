import type { Clock, ClockReading } from '../domain/clock';
import { cloneTaskSnapshot } from '../domain/cloneTaskSnapshot';
import type { TaskCommand, TaskCommandResult, TaskStatusTarget } from '../domain/commands';
import { formatNewCommentTimestamp } from '../domain/commentTimestamp';
import { shiftLocalDate } from '../domain/localDateMath';
import { parseRecurrenceRule } from '../domain/recurrence';
import { StatusCatalog } from '../domain/StatusCatalog';
import type { TaskResolution } from '../domain/taskReconciliation';
import type {
  SubtaskRef,
  SubtaskSnapshot,
  TaskDestination,
  TaskMutationTarget,
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
  RecurrenceCompletionRevisionRequest,
  TaskEditCommand,
  TaskEditRequest,
  TaskMoveRequest,
  TaskRepository,
  TaskRepositoryResult,
} from './TaskRepository';
import {
  prepareRetry,
  recurrenceCompletionPreconditionHolds,
  type PreparedMutation,
  type RetryPolicy,
} from './taskRetryPolicy';

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
    chain.push(node.ref);
    node = node.ref.parent;
  }
  chain.reverse();
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
      current: snapshotForTarget(resolution.current, rebasedTarget),
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

type ProvenResolution = Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>;
type LegacyClock = { today(): import('../domain/types').LocalDate };
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
  reading: ClockReading,
): { readonly command: TaskEditCommand } {
  if (command.type === 'add-comment') {
    return { command: { ...command, stamp: formatNewCommentTimestamp(reading) } };
  }
  if (command.text === null) return { command };
  const text = command.text.replace(/\r\n/gu, '\n');
  return { command: { ...command, text: text.trim().length > 0 ? text : null } };
}

function rootRefForCommand(command: Exclude<TaskCommand, { readonly type: 'create' }>): TaskRef {
  switch (command.type) {
    case 'patch':
    case 'append-title':
    case 'set-status':
    case 'toggle-completion':
    case 'set-description':
      return rootRefOf(command.target);
    case 'add-subtask':
    case 'add-comment':
      return rootRefOf(command.parent);
    case 'delete-subtask':
    case 'reorder-subtask':
      return rootRefOf(command.subtask.parent);
    case 'update-comment':
    case 'delete-comment':
      return rootRefOf(command.comment.parent);
    case 'edit-link':
      return rootRefOf(
        command.target.type === 'comment' ? command.target.ref.parent : command.target.target,
      );
    default:
      return command.ref;
  }
}

function mutationTargetForCommand(
  command: Exclude<TaskCommand, { readonly type: 'create' | 'move' }>,
): import('../domain/types').TaskMutationTarget {
  switch (command.type) {
    case 'patch':
    case 'append-title':
    case 'set-status':
    case 'toggle-completion':
    case 'set-description':
      return command.target;
    case 'add-subtask':
    case 'add-comment':
      return command.parent;
    case 'delete-subtask':
    case 'reorder-subtask':
      return { type: 'subtask', ref: command.subtask };
    case 'update-comment':
    case 'delete-comment':
      return { type: 'comment', ref: command.comment };
    case 'edit-link':
      return command.target.type === 'comment' ? command.target : command.target.target;
    default:
      return { type: 'task', ref: command.ref };
  }
}

function rebaseCommandRoot<T extends Exclude<TaskCommand, { readonly type: 'create' | 'move' }>>(
  command: T,
  root: TaskRef,
): T {
  const rebased = (() => {
    switch (command.type) {
      case 'patch':
      case 'append-title':
      case 'set-status':
      case 'toggle-completion':
      case 'set-description':
        return { ...command, target: rebaseStatusTarget(command.target, root) };
      case 'add-subtask':
      case 'add-comment':
        return { ...command, parent: rebaseStatusTarget(command.parent, root) };
      case 'delete-subtask':
        return {
          ...command,
          subtask: { ...command.subtask, parent: rebaseStatusTarget(command.subtask.parent, root) },
        };
      case 'reorder-subtask':
        return {
          ...command,
          subtask: { ...command.subtask, parent: rebaseStatusTarget(command.subtask.parent, root) },
          target: { ...command.target, parent: rebaseStatusTarget(command.target.parent, root) },
        };
      case 'update-comment':
      case 'delete-comment':
        return {
          ...command,
          comment: { ...command.comment, parent: rebaseStatusTarget(command.comment.parent, root) },
        };
      case 'edit-link':
        return {
          ...command,
          target:
            command.target.type === 'comment'
              ? {
                  type: 'comment' as const,
                  ref: {
                    ...command.target.ref,
                    parent: rebaseStatusTarget(command.target.ref.parent, root),
                  },
                }
              : { ...command.target, target: rebaseStatusTarget(command.target.target, root) },
        };
      default:
        return { ...command, ref: root };
    }
  })();
  return rebased as unknown as T;
}

function retryPolicy(command: TaskEditCommand): RetryPolicy {
  if (command.type === 'delete') return 'relocation-only';
  if (command.type === 'reorder-subtask') return 'never';
  if (
    command.type === 'add-comment' ||
    command.type === 'add-subtask' ||
    (command.type === 'patch' &&
      command.patch.tags !== undefined &&
      Object.keys(command.patch).every((field) => field === 'tags'))
  ) {
    return 'commutative';
  }
  if (
    command.type === 'patch' ||
    command.type === 'set-status' ||
    command.type === 'reschedule' ||
    command.type === 'shift-schedule' ||
    command.type === 'move-time-slot' ||
    command.type === 'move-to-all-day' ||
    command.type === 'set-time-slot' ||
    command.type === 'convert-to-all-day' ||
    command.type === 'set-span-boundary' ||
    command.type === 'extend-span'
  ) {
    return 'field-compare';
  }
  return 'exact-target';
}

function ownedDescendants(task: TaskSnapshot | SubtaskSnapshot): string {
  const block = 'source' in task ? task.source.originalBlock : task.ref.originalBlock;
  const newline = block.search(/\r?\n/u);
  return newline < 0 ? '' : block.slice(newline);
}

function snapshotBehaviorSettings(provider: TaskBehaviorSettingsProvider): TaskBehaviorSettings {
  const settings = provider();
  return {
    taskLifecycle: { ...settings.taskLifecycle },
    recurrence: { ...settings.recurrence },
  };
}

function captureClock(
  clock: Clock | LegacyClock,
): ClockReading | { readonly localDate: ClockReading['localDate'] } {
  return 'read' in clock ? clock.read() : { localDate: clock.today() };
}

export class TaskApplicationService implements TaskApplicationApi {
  // Bridges the index-event lag only for exact refs returned by this service. The cache shares the
  // service lifetime and is bounded so revision churn cannot retain an unbounded snapshot history.
  private readonly recentOutcomes = new Map<string, RecentOutcome>();

  constructor(
    readonly queries: TaskQueryApi,
    private readonly repository: TaskRepository,
    private readonly statusCatalog: StatusCatalog,
    private readonly clock: Clock | LegacyClock,
    private readonly destinationProvider?: TaskDestinationProvider,
    private readonly behaviorSettings: TaskBehaviorSettingsProvider = () =>
      DEFAULT_BEHAVIOR_SETTINGS,
  ) {}

  async execute(command: TaskCommand): Promise<TaskCommandResult> {
    try {
      const inputIssue = multilineInputIssue(command);
      if (inputIssue) return inputIssue;
      const settings = snapshotBehaviorSettings(this.behaviorSettings);
      const reading = captureClock(this.clock);
      if (command.type === 'add-comment' && !('atom' in reading)) {
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'comment' }] };
      }
      if (command.type === 'create') return await this.create(command, settings, reading);

      const rootRef = rootRefForCommand(command);
      const recent = this.recentForCommand(command, rootRef);
      const resolution: TaskResolution = recent
        ? { type: 'exact', task: recent, basis: { observed: recent } }
        : this.queries.resolve(rootRef);
      const unavailable = this.unavailableResult(command, resolution);
      if (unavailable) return unavailable;
      const proven = resolution as ProvenResolution;
      if (command.type === 'move') return await this.move(command, proven, settings, reading);

      const currentRoot = proven.type === 'exact' ? proven.task : proven.current;
      const baseRoot = proven.type === 'exact' ? proven.task : proven.previous;
      const currentCommand = rebaseCommandRoot(command, currentRoot.ref);
      const preparedCommand = this.prepare(currentCommand, settings, reading, proven);
      if ('result' in preparedCommand) return preparedCommand.result;
      const targetBase = mutationTargetForCommand(command);
      const precondition = {
        baseRoot: currentRoot,
        baseTarget: targetBase,
        reconciliation: proven.basis,
      };
      const repositoryRequest: TaskEditRequest | RecurrenceCompletionRevisionRequest =
        'recurrence' in preparedCommand
          ? {
              command: preparedCommand.recurrence,
              ...precondition,
              baseOwnedDescendants: ownedDescendants(
                snapshotForTarget(currentRoot, preparedCommand.recurrence.target) ?? currentRoot,
              ),
            }
          : { command: preparedCommand.command, ...precondition };
      const prepared: PreparedMutation = {
        publicCommand: command,
        repositoryRequest,
        base: baseRoot,
        targetBase,
        clock: reading,
        settings,
        retry:
          'recurrence' in preparedCommand ? 'exact-target' : retryPolicy(preparedCommand.command),
      };
      return await this.finishPrepared(prepared, await this.dispatch(repositoryRequest));
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
    resolution: ProvenResolution,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const base = resolution.type === 'exact' ? resolution.task : resolution.previous;
    const request: TaskMoveRequest = {
      destination: command.destination,
      baseRoot: current,
      baseTarget: { type: 'task', ref: command.ref },
      reconciliation: resolution.basis,
    };
    const prepared: PreparedMutation = {
      publicCommand: command,
      repositoryRequest: request,
      base,
      targetBase: { type: 'task', ref: command.ref },
      clock: reading,
      settings,
      retry: 'never',
    };
    return await this.finishPrepared(prepared, await this.dispatch(request));
  }

  private async create(
    command: Extract<TaskCommand, { readonly type: 'create' }>,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    if (
      command.markdownBody.replace(/\r\n/gu, '').includes('\r') ||
      command.markdownBody.split(/\r?\n/u)[0]?.trim().length === 0
    ) {
      return { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] };
    }
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
      today: reading.localDate,
      addCreatedDate: settings.taskLifecycle.addCreatedDate,
    });
    if (result.type !== 'committed') return this.terminalRepositoryResult(result);
    if (result.outcome.type === 'task') this.remember(result.outcome.task);
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private prepare(
    command: EditableTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    if (isBlockCommand(command)) return prepareBlockCommand(command, reading as ClockReading);
    if (command.type === 'add-subtask') {
      return {
        command: {
          ...command,
          today: reading.localDate,
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
      return this.prepareMoveSchedule(
        command,
        resolution.type === 'exact' ? resolution.task : resolution.current,
      );
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
      reading,
    );
    if (recurrence !== undefined) {
      if (
        'recurrence' in recurrence &&
        resolution.type === 'rebased' &&
        !recurrenceCompletionPreconditionHolds(
          resolution.previous,
          resolution.current,
          recurrence.recurrence.target,
        )
      ) {
        return { result: { type: 'conflict', current: resolution.current } };
      }
      return recurrence;
    }
    return {
      command: {
        type: 'set-status',
        target: resolved.target,
        symbol: sameConfiguredStatus ? current.statusSymbol : rule.symbol,
        ...(entersStampedState && { stamp: reading.localDate }),
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
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
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
        today: reading.localDate,
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
    resolved: TaskSnapshot,
  ): { readonly command: TaskEditCommand } | { readonly result: TaskCommandResult } {
    if (moveExceedsDateBounds(resolved, command)) {
      return {
        result: {
          type: 'invalid',
          issues: [{ code: 'invalid-date', field: 'schedule' }],
        },
      };
    }
    return { command };
  }

  private unavailableResult(
    command: Exclude<TaskCommand, { readonly type: 'create' }>,
    resolution: TaskResolution,
  ): TaskCommandResult | undefined {
    if (resolution.type === 'exact' || resolution.type === 'rebased') return undefined;
    const target =
      command.type === 'move'
        ? ({ type: 'task', ref: command.ref } as const)
        : mutationTargetForCommand(command);
    if (resolution.type === 'ambiguous') {
      return {
        type: 'ambiguous',
        candidates: resolution.candidates.map((candidate) => {
          let rebasedTarget: TaskMutationTarget;
          if (target.type === 'task') {
            rebasedTarget = { type: 'task', ref: candidate.root.ref };
          } else if (target.type === 'subtask') {
            rebasedTarget = {
              type: 'subtask',
              ref: {
                ...target.ref,
                parent: rebaseStatusTarget(target.ref.parent, candidate.root.ref),
              },
            };
          } else {
            rebasedTarget = {
              type: 'comment',
              ref: {
                ...target.ref,
                parent: rebaseStatusTarget(target.ref.parent, candidate.root.ref),
              },
            };
          }
          return { root: candidate.root, target: rebasedTarget };
        }),
      };
    }
    return { type: 'not-found', target };
  }

  private dispatch(
    request: TaskEditRequest | RecurrenceCompletionRevisionRequest | TaskMoveRequest,
  ): Promise<TaskRepositoryResult> {
    const prepared = this.repository.supportsRevisionPreconditions === true;
    if ('destination' in request) {
      return prepared
        ? this.repository.move(request)
        : this.repository.move(request.baseRoot.ref, request.destination);
    }
    if ('baseOwnedDescendants' in request) {
      return this.repository.completeRecurrence(prepared ? request : request.command);
    }
    return this.repository.edit(prepared ? request : request.command);
  }

  private committedResult(
    prepared: PreparedMutation,
    result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
  ): TaskCommandResult {
    if (result.outcome.type === 'task') this.remember(result.outcome.task);
    if (result.outcome.type === 'recurrence') {
      if ('baseOwnedDescendants' in prepared.repositoryRequest) {
        this.forget(rootRefOf(prepared.repositoryRequest.command.target));
      }
      this.remember(result.outcome.active.root, result.outcome.active.target);
    }
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private terminalRepositoryResult(result: TaskRepositoryResult): TaskCommandResult {
    switch (result.type) {
      case 'committed':
        return { type: 'ok', outcome: result.outcome, changed: result.changed };
      case 'rebased':
        return { type: 'conflict', current: result.current };
      case 'uncertain':
        return { type: 'not-found', target: result.target };
      default:
        return result;
    }
  }

  private async finishPrepared(
    prepared: PreparedMutation,
    first: TaskRepositoryResult,
  ): Promise<TaskCommandResult> {
    if (first.type === 'committed') return this.committedResult(prepared, first);
    if (first.type !== 'rebased') return this.terminalRepositoryResult(first);
    const retry = prepareRetry(prepared, first);
    if (retry.type === 'unsafe') return { type: 'conflict', current: first.current };
    const second = await this.dispatch(retry.request);
    return second.type === 'committed'
      ? this.committedResult(prepared, second)
      : this.terminalRepositoryResult(second);
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

  private recentForCommand(
    command: Exclude<TaskCommand, { readonly type: 'create' }>,
    ref: TaskRef,
  ): TaskSnapshot | undefined {
    const outcome = this.recentOutcomes.get(refKey(ref));
    if (!outcome) return undefined;
    if (!outcome.permittedTarget) return outcome.task;
    if (command.type === 'move') return undefined;
    const target = mutationTargetForCommand(command);
    let node: TaskNodeRef;
    if (target.type === 'comment') node = target.ref.parent;
    else if (target.type === 'subtask') node = { type: 'subtask', ref: target.ref };
    else node = target;
    return sameTaskNodeRef(outcome.permittedTarget, node) ? outcome.task : undefined;
  }
}
