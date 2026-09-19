import type { Clock, ClockReading } from '../domain/clock';
import { cloneTaskSnapshot, taskSnapshotWithStatuses } from '../domain/cloneTaskSnapshot';
import type {
  TaskCommand,
  TaskCommandResult,
  TaskPatch,
  TaskStatusTarget,
} from '../domain/commands';
import { formatNewCommentTimestamp } from '../domain/commentTimestamp';
import { shiftLocalDate } from '../domain/localDateMath';
import { parseRecurrenceRule } from '../domain/recurrence';
import { type StatusCatalog } from '../domain/StatusCatalog';
import {
  isOwnedLineTarget,
  taskCommandMutationTarget as mutationTargetForCommand,
  rebaseTaskCommand as rebaseCommandRoot,
  rebaseTaskNode as rebaseStatusTarget,
  taskCommandRootRef as rootRefForCommand,
  taskNodeRootRef as rootRefOf,
  taskNodeAtSourcePath as snapshotForTarget,
  taskMutationNodeRef,
} from '../domain/taskCommandTargets';
import { reconcileTaskNodeRef, type TaskResolution } from '../domain/taskReconciliation';
import { applyTaskCreationTagPolicy, normalizeTaskTagInput } from '../domain/taskTags';
import type {
  LocalDate,
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
import { invalidTaskResult, invalidTaskTarget, isSingleLineText } from '../domain/validation';
import type {
  CreateTaskCommand,
  CreateTaskCommandDestination,
  CreateTaskCommandInitial,
  TaskApplicationApi,
  TaskArchiveSession,
  TaskCaptureApplicationApi,
  TaskCreateSession,
  TaskDependencyQueryApi,
  TaskQueryApi,
  TimeTrackingQueryApi,
} from './TaskApplicationApi';
import type { TaskBehaviorSettings, TaskBehaviorSettingsProvider } from './TaskBehaviorSettings';
import {
  DependencyCompletionConflict,
  nextTaskDependencyId,
  TaskDependencyService,
  type TaskDiagnosticSink,
} from './TaskDependencyService';
import type {
  TaskDestinationPlan,
  TaskDestinationProvider,
  TaskDestinationResolution,
} from './TaskDestinationProvider';
import type {
  RecurrenceCompletionRequest,
  RecurrenceCompletionRevisionRequest,
  TaskEditCommand,
  TaskEditRequest,
  TaskMoveRequest,
  TaskRepository,
  TaskRepositoryResult,
} from './TaskRepository';
import { subtaskRestorationIssues, taskEditMutationTarget } from './TaskRepository';
import {
  prepareRetry,
  rebaseTaskEditCommand,
  reconcileSubtaskRestoration,
  recurrenceCompletionPreconditionHolds,
  type PreparedMutation,
  type RetryPolicy,
} from './taskRetryPolicy';
import { TimeTrackingService } from './TimeTrackingService';

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeTagValues(values: readonly string[]): readonly string[] | undefined {
  const normalized: string[] = [];
  for (const value of values) {
    const tags = normalizeTaskTagInput(value);
    if (tags === undefined) return undefined;
    normalized.push(...tags);
  }
  return uniqueInOrder(normalized);
}

function configuredInboxTag(settings: TaskBehaviorSettings): string | undefined {
  if (settings.inbox.mode === 'untagged') return undefined;
  const tags = normalizeTaskTagInput(settings.inbox.tag);
  return tags?.length === 1 ? tags[0] : undefined;
}

function automaticInboxRemoval(
  additionsProvided: boolean,
  additions: readonly string[],
  explicitRemovals: readonly string[],
  settings: TaskBehaviorSettings,
): readonly string[] {
  if (!additionsProvided || !settings.inbox.removeTagOnAssign) return [];
  const inboxTag = configuredInboxTag(settings);
  if (inboxTag === undefined || explicitRemovals.includes(inboxTag)) return [];
  return additions.some((tag) => tag !== inboxTag) ? [inboxTag] : [];
}

function normalizeTagChange(
  tags: NonNullable<TaskPatch['tags']>,
  settings: TaskBehaviorSettings,
): TaskPatch['tags'] | undefined {
  const add = normalizeTagValues(tags.add ?? []);
  const explicitRemove = normalizeTagValues(tags.remove ?? []);
  if (add === undefined || explicitRemove === undefined) return undefined;
  const remove = uniqueInOrder([
    ...explicitRemove,
    ...automaticInboxRemoval(tags.add !== undefined, add, explicitRemove, settings),
  ]);
  const removed = new Set(remove);
  return {
    ...(tags.add !== undefined && { add: add.filter((tag) => !removed.has(tag)) }),
    ...((tags.remove !== undefined || remove.length > 0) && { remove }),
  };
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
    const rebasedTarget = reconcileTaskNodeRef(
      resolution.previous,
      resolution.current,
      rebaseStatusTarget(target, resolution.previous.ref),
      { dependencyChanges: resolution.evidence === 'authority-transition' },
    );
    return {
      root: resolution.current,
      target: rebasedTarget ?? target,
      current:
        rebasedTarget === undefined
          ? undefined
          : snapshotForTarget(resolution.current, rebasedTarget),
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
  taskPrefix: '',
  inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
  taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
  recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
};
type DependencyCommand = Extract<
  TaskCommand,
  {
    readonly type:
      | 'add-dependency'
      | 'remove-dependency'
      | 'restore-dependency'
      | 'reverse-dependency'
      | 'create-dependency-subtask';
  }
>;
type TrackingCommand = Extract<TaskCommand, { readonly type: 'start-tracking' | 'stop-tracking' }>;
type ExistingTaskCommand = Exclude<
  TaskCommand,
  DependencyCommand | TrackingCommand | { readonly type: 'create' }
>;
type EditableTaskCommand = Exclude<ExistingTaskCommand, { readonly type: 'move' | 'archive' }>;
type PreparedTaskCommand =
  | { readonly command: TaskEditCommand }
  | { readonly recurrence: RecurrenceCompletionRequest }
  | { readonly result: TaskCommandResult };
interface RecentOutcome {
  readonly task: TaskSnapshot;
  readonly permittedTarget?: TaskNodeRef;
}

type ProvenResolution = Extract<TaskResolution, { readonly type: 'exact' | 'rebased' }>;
type LegacyClock = { today(): LocalDate };
type MoveScheduleCommand = Extract<
  TaskCommand,
  { readonly type: 'move-time-slot' | 'move-to-all-day' }
>;
type StatusCommand = Extract<TaskCommand, { readonly type: 'set-status' | 'toggle-completion' }>;

const COMMUTATIVE_COMMAND_TYPES = new Set<TaskEditCommand['type']>([
  'add-comment',
  'add-subtask',
  'add-time-entry',
]);
const FIELD_COMPARE_COMMAND_TYPES = new Set<TaskEditCommand['type']>([
  'patch',
  'set-status',
  'reschedule',
  'shift-schedule',
  'move-time-slot',
  'move-to-all-day',
  'set-time-slot',
  'convert-to-all-day',
  'set-span-boundary',
  'extend-span',
]);

function isStatusCommand(command: TaskCommand): command is StatusCommand {
  return command.type === 'set-status' || command.type === 'toggle-completion';
}

function isTrackingCommand(command: TaskCommand): command is TrackingCommand {
  return command.type === 'start-tracking' || command.type === 'stop-tracking';
}

function invalidStatusResult(): PreparedTaskCommand {
  return {
    result: { type: 'invalid', issues: [{ code: 'invalid-status', field: 'status' }] },
  };
}

function moveExceedsDateBounds(task: TaskSnapshot, command: MoveScheduleCommand): boolean {
  const { start, due, scheduled } = task.planning;
  const dates = start != null && due != null ? [start, due] : [scheduled ?? due];
  return dates.some(
    (date) => date !== undefined && shiftLocalDate(date, command.days) === undefined,
  );
}

function scheduleInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    (command.type === 'shift-schedule' ||
      command.type === 'move-time-slot' ||
      command.type === 'move-to-all-day') &&
    (!Number.isSafeInteger(command.days) ||
      (command.type === 'shift-schedule' && command.days === 0))
  ) {
    return invalidTaskTarget('days');
  }
  return undefined;
}

function titleInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'patch' &&
    command.patch.markdownTitle?.type === 'set' &&
    !isSingleLineText(command.patch.markdownTitle.value)
  ) {
    return invalidTaskTarget('title');
  }
  if (command.type === 'append-title' && !isSingleLineText(command.markdown)) {
    return invalidTaskTarget('title');
  }
  if (command.type === 'edit-link' && !isSingleLineText(command.replacement)) {
    return invalidTaskTarget('link');
  }
  return undefined;
}

function commentInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    (command.type === 'add-comment' || command.type === 'update-comment') &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return invalidTaskTarget('comment');
  }
  return undefined;
}

function subtaskInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'add-subtask' &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return invalidTaskTarget('subtask');
  }
  return undefined;
}

function timeEntryInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'restore-time-entry' &&
    (!isSingleLineText(command.markdown) || command.markdown.trim().length === 0)
  ) {
    return invalidTaskTarget('time-entry');
  }
  return undefined;
}

function descriptionInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'set-description' &&
    (command.text?.replace(/\r\n/gu, '').includes('\r') ?? false)
  ) {
    return invalidTaskTarget('description');
  }
  return undefined;
}

function multilineInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  return (
    scheduleInputIssue(command) ??
    titleInputIssue(command) ??
    commentInputIssue(command) ??
    subtaskInputIssue(command) ??
    timeEntryInputIssue(command) ??
    descriptionInputIssue(command)
  );
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

function retryPolicy(command: TaskEditCommand): RetryPolicy {
  if (command.type === 'restore-subtask') return 'exact-target';
  if (command.type === 'delete') return 'relocation-only';
  if (command.type === 'reorder-subtask') return 'never';
  const tagOnlyPatch =
    command.type === 'patch' &&
    command.patch.tags !== undefined &&
    Object.keys(command.patch).every((field) => field === 'tags');
  if (COMMUTATIVE_COMMAND_TYPES.has(command.type) || tagOnlyPatch) {
    return 'commutative';
  }
  return FIELD_COMPARE_COMMAND_TYPES.has(command.type) ? 'field-compare' : 'exact-target';
}

function ownedDescendants(task: TaskSnapshot | SubtaskSnapshot): string {
  const block = 'source' in task ? task.source.originalBlock : task.ref.originalBlock;
  const newline = block.search(/\r?\n/u);
  return newline < 0 ? '' : block.slice(newline);
}

function snapshotBehaviorSettings(provider: TaskBehaviorSettingsProvider): TaskBehaviorSettings {
  const settings = provider();
  return {
    taskPrefix: settings.taskPrefix,
    inbox: { ...settings.inbox },
    taskLifecycle: { ...settings.taskLifecycle },
    recurrence: { ...settings.recurrence },
  };
}

function captureClock(
  clock: Clock | LegacyClock,
): ClockReading | { readonly localDate: ClockReading['localDate'] } {
  return 'read' in clock ? clock.read() : { localDate: clock.today() };
}

interface TaskCreateRequest {
  readonly markdownBody: string;
  readonly initial?: CreateTaskCommandInitial;
}

type PreparedCreateInitial =
  | { readonly type: 'valid'; readonly initial?: CreateTaskCommandInitial }
  | { readonly type: 'invalid' };

function hasInvalidCreateTitle(markdownBody: string): boolean {
  return (
    markdownBody.replace(/\r\n/gu, '').includes('\r') ||
    markdownBody.split(/\r?\n/u)[0]?.trim().length === 0
  );
}

function prepareCreateInitial(
  request: TaskCreateRequest,
  settings: TaskBehaviorSettings,
): PreparedCreateInitial {
  const source = request.initial;
  if (source === undefined) return { type: 'valid' };
  if (source.tags === undefined) return { type: 'valid', initial: source };
  const tags = normalizeTagChange(source.tags, settings);
  return tags === undefined ? { type: 'invalid' } : { type: 'valid', initial: { ...source, tags } };
}

function preparedCreateDraft(
  request: TaskCreateRequest,
  preparedInitial: Extract<PreparedCreateInitial, { readonly type: 'valid' }>,
  settings: TaskBehaviorSettings,
): TaskCreateRequest {
  const creationPolicy = applyTaskCreationTagPolicy(
    settings.taskPrefix,
    request.markdownBody,
    settings.inbox,
    preparedInitial.initial?.tags,
  );
  if (preparedInitial.initial === undefined) return { markdownBody: creationPolicy.markdown };
  return {
    markdownBody: creationPolicy.markdown,
    initial: {
      ...preparedInitial.initial,
      ...(creationPolicy.tags !== undefined && { tags: creationPolicy.tags }),
    },
  };
}

function destinationUnavailableResult(): TaskCommandResult {
  return {
    type: 'invalid',
    issues: [{ code: 'destination-unavailable', field: 'destination' }],
  };
}

function sameFilePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

type TaskApplicationServiceDependencies = [
  queries: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi,
  repository: TaskRepository,
  statusCatalog: StatusCatalog,
  clock: Clock | LegacyClock,
  destinationProvider?: TaskDestinationProvider,
  behaviorSettings?: TaskBehaviorSettingsProvider,
  dependencies?: TaskDependencyService,
  diagnostics?: TaskDiagnosticSink,
];

type ArchiveDestinationResolution =
  | { readonly type: 'ready'; readonly destination: TaskDestination }
  | { readonly type: 'result'; readonly result: TaskCommandResult };

export class TaskApplicationService implements TaskApplicationApi, TaskCaptureApplicationApi {
  // Bridges the index-event lag only for exact refs returned by this service. The cache shares the
  // service lifetime and is bounded so revision churn cannot retain an unbounded snapshot history.
  private readonly recentOutcomes_abyssPrivate = new Map<string, RecentOutcome>();

  readonly queries: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi;
  private readonly dependencies_abyssPrivate: TaskDependencyService;
  private readonly tracking_abyssPrivate: TimeTrackingService;
  private readonly diagnostics_abyssPrivate: TaskDiagnosticSink;
  private readonly repository_abyssPrivate: TaskRepository;
  private readonly statusCatalog_abyssPrivate: StatusCatalog;
  private readonly clock_abyssPrivate: Clock | LegacyClock;
  private readonly destinationProvider_abyssPrivate: TaskDestinationProvider | undefined;
  private readonly behaviorSettings_abyssPrivate: TaskBehaviorSettingsProvider;

  constructor(...dependencies: TaskApplicationServiceDependencies) {
    const [
      queries,
      repository,
      statusCatalog,
      clock,
      destinationProvider,
      behaviorSettings = () => DEFAULT_BEHAVIOR_SETTINGS,
      dependencyService,
      diagnostics = () => {},
    ] = dependencies;
    this.queries = queries;
    this.repository_abyssPrivate = repository;
    this.statusCatalog_abyssPrivate = statusCatalog;
    this.clock_abyssPrivate = clock;
    this.destinationProvider_abyssPrivate = destinationProvider;
    this.behaviorSettings_abyssPrivate = behaviorSettings;
    this.dependencies_abyssPrivate =
      dependencyService ??
      new TaskDependencyService(queries, repository, nextTaskDependencyId, diagnostics);
    this.diagnostics_abyssPrivate = diagnostics;
    this.tracking_abyssPrivate = new TimeTrackingService({
      queries,
      resolveRoot: (ref, node) => this.resolveRoot_abyssPrivate(ref, node),
      edit: async (command) => await this.executeTrackingEdit_abyssPrivate(command),
      statusOf: (symbol) => statusCatalog.statusForSymbol(symbol),
      // Tracking and dependency operations share one queue, so their writes never interleave.
      serialize: async (operation) =>
        await this.dependencies_abyssPrivate.serializeMutation(async () => await operation()),
      diagnostics,
    });
  }

  async planCreate(destination: CreateTaskCommandDestination): Promise<TaskCreateSession> {
    const settings = snapshotBehaviorSettings(this.behaviorSettings_abyssPrivate);
    const reading = captureClock(this.clock_abyssPrivate);
    try {
      const plan = await this.destinationPlan_abyssPrivate(destination);
      if (plan === undefined) return this.unavailableCreateSession_abyssPrivate();
      return this.readyCreateSession_abyssPrivate(plan, settings, reading);
    } catch (error) {
      this.diagnostics_abyssPrivate(
        { operation: 'create', phase: 'unexpected', cause: 'destination-plan' },
        error,
      );
      return this.unavailableCreateSession_abyssPrivate();
    }
  }

  async planArchive(): Promise<TaskArchiveSession> {
    try {
      const plan = await this.destinationProvider_abyssPrivate?.planArchive?.();
      if (plan === undefined) return this.unavailableArchiveSession_abyssPrivate();
      let prepared: Promise<TaskDestinationResolution> | undefined;
      return {
        type: 'ready',
        filePath: plan.destination.filePath,
        execute: async (ref) => {
          return await this.executeArchiveSession_abyssPrivate(ref, plan, () => {
            prepared ??= Promise.resolve().then(() => plan.prepare());
            return prepared;
          });
        },
      };
    } catch (error) {
      this.diagnostics_abyssPrivate(
        { operation: 'archive', phase: 'unexpected', cause: 'destination-plan' },
        error,
      );
      return this.unavailableArchiveSession_abyssPrivate();
    }
  }

  private unavailableArchiveSession_abyssPrivate(): TaskArchiveSession {
    return { type: 'unavailable', execute: async () => destinationUnavailableResult() };
  }

  private async executeArchiveSession_abyssPrivate(
    ref: TaskRef,
    plan: TaskDestinationPlan,
    prepare: () => Promise<TaskDestinationResolution>,
  ): Promise<TaskCommandResult> {
    try {
      const command = { type: 'archive' as const, ref };
      const resolution = this.resolveForCommand_abyssPrivate(command, ref);
      const unavailable = this.unavailableResult_abyssPrivate(command, resolution);
      if (unavailable != null) return unavailable;
      if (sameFilePath(ref.filePath, plan.destination.filePath)) {
        return invalidTaskTarget('destination');
      }
      return await this.archive_abyssPrivate(
        command,
        resolution as ProvenResolution,
        plan,
        prepare(),
      );
    } catch (error) {
      this.diagnostics_abyssPrivate(
        { operation: 'archive', phase: 'unexpected', cause: 'repository-error' },
        error,
      );
      return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
  }

  async execute(command: TaskCommand): Promise<TaskCommandResult> {
    try {
      return await this.executeCommand_abyssPrivate(command);
    } catch {
      this.diagnostics_abyssPrivate({
        operation: command.type,
        phase: 'unexpected',
        cause: 'repository-error',
      });
      return {
        type: 'io-error',
        cause: 'repository-error',
        ...(command.type === 'move' && { path: command.destination.filePath }),
        contentState: 'unknown',
      };
    }
  }

  private async executeCommand_abyssPrivate(command: TaskCommand): Promise<TaskCommandResult> {
    const restorationIssues = subtaskRestorationIssues(command);
    if (restorationIssues.length > 0) return invalidTaskResult(restorationIssues);
    if ('dependent' in command) return await this.dependencies_abyssPrivate.execute(command);
    const inputIssue = multilineInputIssue(command);
    if (inputIssue != null) return inputIssue;
    const settings = snapshotBehaviorSettings(this.behaviorSettings_abyssPrivate);
    const reading = captureClock(this.clock_abyssPrivate);
    if (command.type === 'add-comment' && !('atom' in reading)) return invalidTaskTarget('comment');
    if (isTrackingCommand(command)) return await this.track_abyssPrivate(command, reading);
    if (command.type === 'create-dependency-subtask')
      return this.createDependencySubtask_abyssPrivate(command, {
        today: reading.localDate,
        addCreatedDate: settings.taskLifecycle.addCreatedDate,
        taskPrefix: settings.taskPrefix,
        inbox: settings.inbox,
      });
    if (command.type === 'create')
      return await this.create_abyssPrivate(command, settings, reading);
    return await this.executeExistingCommand_abyssPrivate(command, settings, reading);
  }

  private async track_abyssPrivate(
    command: TrackingCommand,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    if (!('atom' in reading)) return invalidTaskTarget('time-entry');
    return command.type === 'start-tracking'
      ? await this.tracking_abyssPrivate.start(command.parent, reading)
      : await this.tracking_abyssPrivate.stopAll(reading);
  }

  /** Writes one internal tracking edit through the resolution, retry and outcome path of a command. */
  private async executeTrackingEdit_abyssPrivate(
    command: TaskEditCommand,
  ): Promise<TaskCommandResult> {
    const settings = snapshotBehaviorSettings(this.behaviorSettings_abyssPrivate);
    const reading = captureClock(this.clock_abyssPrivate);
    const targetBase = taskEditMutationTarget(command);
    const resolution = this.resolveRoot_abyssPrivate(
      rootRefOf(targetBase),
      taskMutationNodeRef(targetBase),
    );
    const unavailable = this.unavailableTarget_abyssPrivate(targetBase, resolution);
    if (unavailable != null) return unavailable;
    const proven = resolution as ProvenResolution;
    const currentRoot = proven.type === 'exact' ? proven.task : proven.current;
    return await this.dispatchPrepared_abyssPrivate({
      repositoryRequest: {
        command: rebaseTaskEditCommand(command, currentRoot.ref),
        baseRoot: currentRoot,
        baseTarget: targetBase,
        reconciliation: proven.basis,
      },
      base: proven.type === 'exact' ? proven.task : proven.previous,
      targetBase,
      clock: reading,
      settings,
      retry: retryPolicy(command),
    });
  }

  /**
   * Closes the entries a completed node was still tracking, as a follow-up write with the same
   * clock reading. The status command keeps its own result apart from one note: a session the
   * follow-up dropped for being under a minute is said so on the outcome, because the reader would
   * otherwise see the line vanish without a word. A failed follow-up only reports to diagnostics
   * and leaves the running entry visible for repair.
   */
  private async closeTrackingAfterCompletion_abyssPrivate(
    command: EditableTaskCommand,
    result: TaskCommandResult,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    if (!isStatusCommand(command) || result.type !== 'ok' || !('atom' in reading)) return result;
    const outcome = result.outcome;
    if (outcome.type !== 'task' && outcome.type !== 'recurrence') return result;
    const follow =
      outcome.type === 'task' ? { root: outcome.task, target: command.target } : outcome.completed;
    if (follow === undefined) return result;
    const closed = await this.tracking_abyssPrivate.closeAfterCompletion(
      follow.root,
      follow.target,
      reading,
    );
    if (!closed.discardedShortEntry) return result;
    return { ...result, outcome: { ...outcome, discardedShortEntry: true } };
  }

  private async createDependencySubtask_abyssPrivate(
    command: Extract<TaskCommand, { type: 'create-dependency-subtask' }>,
    lifecycle: Parameters<TaskDependencyService['createSubtask']>[1],
  ): Promise<TaskCommandResult> {
    const result = await this.dependencies_abyssPrivate.createSubtask(command, lifecycle);
    if (result.type === 'ok' && result.outcome.type === 'dependency-subtask')
      this.remember_abyssPrivate(result.outcome.current.root);
    return result;
  }

  private async executeExistingCommand_abyssPrivate(
    command: ExistingTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    serialized = false,
  ): Promise<TaskCommandResult> {
    const rootRef = rootRefForCommand(command);
    const resolution = this.resolveForCommand_abyssPrivate(command, rootRef);
    const unavailable = this.unavailableResult_abyssPrivate(command, resolution);
    if (unavailable != null) return unavailable;
    const proven = resolution as ProvenResolution;
    if (command.type === 'move')
      return await this.move_abyssPrivate(command, proven, settings, reading);
    if (command.type === 'archive') return await this.archive_abyssPrivate(command, proven);
    return await this.executeEditableCommand_abyssPrivate(command, proven, {
      settings,
      reading,
      serialized,
    });
  }

  private resolveForCommand_abyssPrivate(
    command: ExistingTaskCommand,
    rootRef: TaskRef,
  ): TaskResolution {
    const recent = this.recentForCommand_abyssPrivate(command, rootRef);
    if (recent === undefined) return this.queries.resolve(rootRef);
    if (isStatusCommand(command)) {
      const indexed = this.queries.resolve(rootRef);
      if (indexed.type === 'rebased') return indexed;
    }
    return { type: 'exact', task: recent, basis: { observed: recent } };
  }

  private async executeEditableCommand_abyssPrivate(
    command: EditableTaskCommand,
    resolution: ProvenResolution,
    context: {
      settings: TaskBehaviorSettings;
      reading: ClockReading | { readonly localDate: ClockReading['localDate'] };
      serialized: boolean;
    },
  ): Promise<TaskCommandResult> {
    const { settings, reading, serialized } = context;
    const currentRoot = resolution.type === 'exact' ? resolution.task : resolution.current;
    const baseRoot = resolution.type === 'exact' ? resolution.task : resolution.previous;
    const currentCommand =
      command.type === 'restore-subtask'
        ? reconcileSubtaskRestoration(command, baseRoot, currentRoot)
        : rebaseCommandRoot(command, currentRoot.ref);
    if (currentCommand === undefined) return { type: 'conflict', current: currentRoot };
    const preparedCommand = this.prepare_abyssPrivate(
      currentCommand,
      settings,
      reading,
      resolution,
    );
    if ('result' in preparedCommand) return preparedCommand.result;
    const targetBase = mutationTargetForCommand(command);
    const repositoryRequest = this.repositoryRequest_abyssPrivate(
      preparedCommand,
      currentRoot,
      targetBase,
      resolution,
    );
    const validateCurrent = this.completionValidation_abyssPrivate(
      preparedCommand,
      targetBase,
      resolution.basis.observed,
    );
    const prepared: PreparedMutation = {
      repositoryRequest,
      base: baseRoot,
      targetBase,
      clock: reading,
      settings,
      retry:
        'recurrence' in preparedCommand ? 'exact-target' : retryPolicy(preparedCommand.command),
      ...(validateCurrent === undefined ? {} : { validateCurrent }),
    };
    // A completion validation means the command lands on done or cancelled, which is exactly when
    // the tracking follow-up belongs inside the same serialized mutation.
    if (validateCurrent !== undefined && !serialized) {
      return await this.dependencies_abyssPrivate.serializeMutation(async (queued) => {
        const result = queued
          ? await this.executeExistingCommand_abyssPrivate(command, settings, reading, true)
          : await this.dispatchPrepared_abyssPrivate(prepared);
        return await this.closeTrackingAfterCompletion_abyssPrivate(command, result, reading);
      });
    }
    return await this.dispatchPrepared_abyssPrivate(prepared);
  }

  private async dispatchPrepared_abyssPrivate(
    prepared: PreparedMutation,
  ): Promise<TaskCommandResult> {
    const invalidCurrent = this.validateCompletion_abyssPrivate(
      prepared,
      prepared.repositoryRequest,
    );
    if (invalidCurrent !== undefined) return invalidCurrent;
    return await this.finishPrepared_abyssPrivate(
      prepared,
      await this.dispatch_abyssPrivate(prepared.repositoryRequest),
    );
  }

  private completionValidation_abyssPrivate(
    prepared: Exclude<PreparedTaskCommand, { readonly result: TaskCommandResult }>,
    predecessor: TaskMutationTarget,
    previous: TaskSnapshot,
  ): PreparedMutation['validateCurrent'] {
    let symbol: string | undefined;
    if ('recurrence' in prepared) symbol = prepared.recurrence.doneSymbol;
    else if (prepared.command.type === 'set-status') symbol = prepared.command.symbol;
    if (symbol === undefined || isOwnedLineTarget(predecessor)) return undefined;
    const type = this.statusCatalog_abyssPrivate.statusForSymbol(symbol);
    if (type !== 'done' && type !== 'cancelled') return undefined;
    return (root, target) => {
      const current = taskSnapshotWithStatuses(root, (status) =>
        this.statusCatalog_abyssPrivate.statusForSymbol(status),
      );
      try {
        const indexed = this.queries
          .listNodes()
          .some((node) => sameTaskNodeRef(node.target, target));
        const blockers = this.dependencies_abyssPrivate.withCompletionBasis(
          { previous, current },
          () =>
            this.dependencies_abyssPrivate.blockersForCompletion(
              current,
              indexed ? target : predecessor,
            ),
        );
        return blockers.length === 0 ? undefined : { type: 'blocked', target, blockers };
      } catch (error) {
        if (error instanceof DependencyCompletionConflict) return { type: 'conflict', current };
        throw error;
      }
    };
  }

  private validateCompletion_abyssPrivate(
    prepared: PreparedMutation,
    request: PreparedMutation['repositoryRequest'],
  ): TaskCommandResult | undefined {
    if (!('command' in request)) return undefined;
    const command = request.command;
    if (!('doneSymbol' in command) && command.type !== 'set-status') return undefined;
    return prepared.validateCurrent?.(request.baseRoot, command.target);
  }

  private repositoryRequest_abyssPrivate(
    prepared: Exclude<PreparedTaskCommand, { readonly result: TaskCommandResult }>,
    currentRoot: TaskSnapshot,
    targetBase: TaskMutationTarget,
    resolution: ProvenResolution,
  ): TaskEditRequest | RecurrenceCompletionRevisionRequest {
    const precondition = {
      baseRoot: currentRoot,
      baseTarget: targetBase,
      reconciliation: resolution.basis,
    };
    if ('command' in prepared) return { command: prepared.command, ...precondition };
    return {
      command: prepared.recurrence,
      ...precondition,
      baseOwnedDescendants: ownedDescendants(
        snapshotForTarget(currentRoot, prepared.recurrence.target) ?? currentRoot,
      ),
    };
  }

  private async move_abyssPrivate(
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
      repositoryRequest: request,
      base,
      targetBase: { type: 'task', ref: command.ref },
      clock: reading,
      settings,
      retry: 'never',
    };
    return await this.finishPrepared_abyssPrivate(
      prepared,
      await this.dispatch_abyssPrivate(request),
    );
  }

  private async archive_abyssPrivate(
    command: Extract<TaskCommand, { readonly type: 'archive' }>,
    resolution: ProvenResolution,
    frozenPlan?: TaskDestinationPlan,
    frozenPreparation?: Promise<TaskDestinationResolution>,
  ): Promise<TaskCommandResult> {
    const destination = await this.archiveDestination_abyssPrivate(
      command.ref,
      frozenPlan,
      frozenPreparation,
    );
    if (destination.type === 'result') return destination.result;
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const request: TaskMoveRequest = {
      destination: destination.destination,
      baseRoot: current,
      baseTarget: { type: 'task', ref: command.ref },
      reconciliation: resolution.basis,
    };
    if (this.repository_abyssPrivate.archive === undefined) return destinationUnavailableResult();
    const result = await this.repository_abyssPrivate.archive(request);
    return this.finishArchiveResult_abyssPrivate(command.ref, result);
  }

  private async archiveDestination_abyssPrivate(
    ref: TaskRef,
    frozenPlan?: TaskDestinationPlan,
    frozenPreparation?: Promise<TaskDestinationResolution>,
  ): Promise<ArchiveDestinationResolution> {
    const plan = frozenPlan ?? (await this.destinationProvider_abyssPrivate?.planArchive?.());
    if (plan === undefined) return { type: 'result', result: destinationUnavailableResult() };
    if (sameFilePath(ref.filePath, plan.destination.filePath)) {
      return { type: 'result', result: invalidTaskTarget('destination') };
    }
    const prepared = await (frozenPreparation ?? plan.prepare());
    if (prepared.type !== 'resolved') {
      return { type: 'result', result: destinationUnavailableResult() };
    }
    return sameFilePath(ref.filePath, prepared.destination.filePath)
      ? { type: 'result', result: invalidTaskTarget('destination') }
      : { type: 'ready', destination: prepared.destination };
  }

  private finishArchiveResult_abyssPrivate(
    ref: TaskRef,
    result: TaskRepositoryResult,
  ): TaskCommandResult {
    if (result.type === 'committed' && result.outcome.type === 'archived') {
      this.forget_abyssPrivate(ref);
      return { type: 'ok', outcome: result.outcome, changed: result.changed };
    }
    return this.terminalRepositoryResult_abyssPrivate(result);
  }

  private async create_abyssPrivate(
    command: CreateTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    const resolveDestination = async (): Promise<TaskDestinationResolution | undefined> => {
      if (command.destination.type === 'explicit') {
        return await (await this.destinationPlan_abyssPrivate(command.destination))?.prepare();
      }
      return await this.destinationProvider_abyssPrivate?.resolveConfiguredDefault();
    };
    return await this.executePlannedCreate_abyssPrivate(
      command,
      resolveDestination,
      settings,
      reading,
    );
  }

  private async executePlannedCreate_abyssPrivate(
    request: TaskCreateRequest,
    resolveDestination: () => Promise<TaskDestinationResolution | undefined>,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    if (hasInvalidCreateTitle(request.markdownBody)) {
      return { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] };
    }
    const resolution = await resolveDestination();
    if (resolution?.type !== 'resolved') {
      return destinationUnavailableResult();
    }
    const preparedInitial = prepareCreateInitial(request, settings);
    if (preparedInitial.type === 'invalid') {
      return invalidTaskTarget('tags');
    }
    const draft = preparedCreateDraft(request, preparedInitial, settings);
    const result = await this.repository_abyssPrivate.create(resolution.destination, {
      ...draft,
      today: reading.localDate,
      addCreatedDate: settings.taskLifecycle.addCreatedDate,
    });
    if (result.type !== 'committed') return this.terminalRepositoryResult_abyssPrivate(result);
    if (result.outcome.type === 'task') this.remember_abyssPrivate(result.outcome.task);
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private async destinationPlan_abyssPrivate(
    destination: CreateTaskCommandDestination,
  ): Promise<TaskDestinationPlan | undefined> {
    if (destination.type === 'configured-default') {
      return await this.destinationProvider_abyssPrivate?.planConfiguredDefault();
    }
    if (this.destinationProvider_abyssPrivate !== undefined) {
      return await this.destinationProvider_abyssPrivate.planExplicit(destination.destination, {
        provision: destination.provision !== undefined,
      });
    }
    if (destination.provision !== undefined) return undefined;
    const planned: TaskDestination = {
      filePath: destination.destination.filePath,
      insertion: { ...destination.destination.insertion },
    };
    return {
      destination: planned,
      prepare: async () => ({ type: 'resolved', destination: planned }),
    };
  }

  private readyCreateSession_abyssPrivate(
    plan: TaskDestinationPlan,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): TaskCreateSession {
    const destination: TaskDestination = {
      filePath: plan.destination.filePath,
      insertion: { ...plan.destination.insertion },
    };
    let preparation: Promise<TaskDestinationResolution> | undefined;
    const prepareOnce = async (): Promise<TaskDestinationResolution> => {
      if (preparation === undefined) {
        const active = Promise.resolve().then(() => plan.prepare());
        preparation = active;
        void active.then(
          (resolution) => {
            if (resolution.type !== 'resolved' && preparation === active) preparation = undefined;
          },
          () => {
            if (preparation === active) preparation = undefined;
          },
        );
      }
      const resolution = await preparation;
      if (
        resolution.type === 'resolved' &&
        plan.validate !== undefined &&
        !(await plan.validate(resolution.destination))
      ) {
        return { type: 'unavailable' };
      }
      return resolution;
    };
    return {
      type: 'ready',
      destination,
      execute: async (request) => {
        try {
          return await this.executePlannedCreate_abyssPrivate(
            request,
            prepareOnce,
            settings,
            reading,
          );
        } catch (error) {
          this.diagnostics_abyssPrivate(
            { operation: 'create', phase: 'unexpected', cause: 'destination-provision' },
            error,
          );
          return {
            type: 'io-error',
            cause: 'repository-error',
            contentState: 'unknown',
          };
        }
      },
    };
  }

  private unavailableCreateSession_abyssPrivate(): TaskCreateSession {
    return {
      type: 'unavailable',
      execute: async () => destinationUnavailableResult(),
    };
  }

  private prepare_abyssPrivate(
    command: EditableTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    return isStatusCommand(command)
      ? this.prepareStatusCommand_abyssPrivate(command, settings, reading, resolution)
      : this.prepareNonStatusCommand_abyssPrivate(command, settings, reading, resolution);
  }

  private prepareNonStatusCommand_abyssPrivate(
    command: Exclude<EditableTaskCommand, StatusCommand>,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    if (isBlockCommand(command)) return prepareBlockCommand(command, reading as ClockReading);
    if (command.type === 'add-subtask') {
      return {
        command: {
          ...command,
          text: applyTaskCreationTagPolicy(settings.taskPrefix, command.text, settings.inbox)
            .markdown,
          today: reading.localDate,
          addCreatedDate: settings.taskLifecycle.addCreatedDate,
        },
      };
    }

    if (command.type === 'patch' && command.patch.tags !== undefined) {
      return this.prepareTagPatch_abyssPrivate(command, settings);
    }

    if (command.type === 'move-time-slot' || command.type === 'move-to-all-day') {
      return this.prepareMoveSchedule_abyssPrivate(
        command,
        resolution.type === 'exact' ? resolution.task : resolution.current,
      );
    }
    return { command };
  }

  private prepareTagPatch_abyssPrivate(
    command: Extract<TaskCommand, { readonly type: 'patch' }>,
    settings: TaskBehaviorSettings,
  ): PreparedTaskCommand {
    const sourceTags = command.patch.tags;
    if (sourceTags === undefined) return { command };
    const tags = normalizeTagChange(sourceTags, settings);
    if (tags === undefined) return { result: invalidTaskTarget('tags') };
    return { command: { ...command, patch: { ...command.patch, tags } } };
  }

  private prepareStatusCommand_abyssPrivate(
    command: StatusCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    const resolved = resolvedStatusSelection(resolution, command.target);
    if (resolved.current == null) return { result: { type: 'conflict', current: resolved.root } };
    const current = resolved.current;
    const currentRule = this.statusCatalog_abyssPrivate.ruleForSymbol(current.statusSymbol);
    const currentSemanticStatus =
      currentRule == null
        ? this.statusCatalog_abyssPrivate.statusForSymbol(current.statusSymbol)
        : statusForRuleType(currentRule.type);
    const rule = this.requestedStatusRule_abyssPrivate(command, currentSemanticStatus);
    if (rule === undefined) return invalidStatusResult();
    const recurrence = this.prepareRecurrenceCompletion_abyssPrivate({
      current,
      target: resolved.target,
      currentSemanticStatus,
      requestedRule: rule,
      settings,
      reading,
    });
    if (recurrence !== undefined) {
      return this.validateRecurrencePreparation_abyssPrivate(recurrence, resolution);
    }
    return this.preparedStatusEdit_abyssPrivate(
      resolved.target,
      current,
      currentRule,
      currentSemanticStatus,
      rule,
      settings,
      reading,
    );
  }

  private requestedStatusRule_abyssPrivate(
    command: StatusCommand,
    currentSemanticStatus: TaskStatus,
  ): TaskStatusRule | undefined {
    if (command.type === 'set-status')
      return this.statusCatalog_abyssPrivate.ruleForSymbol(command.symbol);
    const targetType = currentSemanticStatus === 'done' ? 'todo' : 'done';
    return this.statusCatalog_abyssPrivate.defaultForType(targetType);
  }

  private validateRecurrencePreparation_abyssPrivate(
    recurrence: Exclude<PreparedTaskCommand, { readonly command: TaskEditCommand }>,
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    if (
      'recurrence' in recurrence &&
      resolution.type === 'rebased' &&
      !recurrenceCompletionPreconditionHolds(
        resolution.previous,
        resolution.current,
        recurrence.recurrence.target,
        resolution.evidence,
      )
    ) {
      return { result: { type: 'conflict', current: resolution.current } };
    }
    return recurrence;
  }

  private preparedStatusEdit_abyssPrivate(
    ...args: [
      target: TaskStatusTarget,
      current: TaskSnapshot | SubtaskSnapshot,
      currentRule: TaskStatusRule | undefined,
      currentSemanticStatus: TaskStatus,
      rule: TaskStatusRule,
      settings: TaskBehaviorSettings,
      reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    ]
  ): PreparedTaskCommand {
    const [target, current, currentRule, currentSemanticStatus, rule, settings, reading] = args;
    const sameConfiguredStatus = currentRule?.symbol === rule.symbol;
    const requestedSemanticStatus = statusForRuleType(rule.type);
    const entersStampedState =
      currentSemanticStatus !== requestedSemanticStatus &&
      (rule.type === 'done' || rule.type === 'cancelled');
    return {
      command: {
        type: 'set-status',
        target,
        symbol: sameConfiguredStatus ? current.statusSymbol : rule.symbol,
        ...(entersStampedState && { stamp: reading.localDate }),
        ...(rule.type === 'done' && {
          addCompletionDate: settings.taskLifecycle.addCompletionDate,
        }),
      },
    };
  }

  private prepareRecurrenceCompletion_abyssPrivate(context: {
    readonly current: TaskSnapshot | SubtaskSnapshot;
    readonly target: TaskStatusTarget;
    readonly currentSemanticStatus: TaskStatus;
    readonly requestedRule: TaskStatusRule;
    readonly settings: TaskBehaviorSettings;
    readonly reading: ClockReading | { readonly localDate: ClockReading['localDate'] };
  }): Exclude<PreparedTaskCommand, { readonly command: TaskEditCommand }> | undefined {
    const { current, target, currentSemanticStatus, requestedRule, settings, reading } = context;
    if (
      currentSemanticStatus === 'done' ||
      requestedRule.type !== 'done' ||
      current.recurrence === undefined ||
      parseRecurrenceRule(current.recurrence).type !== 'valid'
    ) {
      return undefined;
    }
    const todoRule = this.statusCatalog_abyssPrivate.defaultForType('todo');
    if (todoRule == null) {
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

  private prepareMoveSchedule_abyssPrivate(
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

  private unavailableResult_abyssPrivate(
    command: ExistingTaskCommand,
    resolution: TaskResolution,
  ): TaskCommandResult | undefined {
    if (resolution.type === 'exact' || resolution.type === 'rebased') return undefined;
    const target =
      command.type === 'move'
        ? ({ type: 'task', ref: command.ref } as const)
        : mutationTargetForCommand(command);
    return this.unavailableTarget_abyssPrivate(target, resolution);
  }

  private unavailableTarget_abyssPrivate(
    target: TaskMutationTarget,
    resolution: TaskResolution,
  ): TaskCommandResult | undefined {
    if (resolution.type === 'exact' || resolution.type === 'rebased') return undefined;
    if (resolution.type === 'ambiguous') {
      return {
        type: 'ambiguous',
        candidates: resolution.candidates.map((candidate) => ({
          root: candidate.root,
          target: rebaseStatusTarget(target, candidate.root.ref),
        })),
      };
    }
    return { type: 'not-found', target };
  }

  private dispatch_abyssPrivate(
    request: TaskEditRequest | RecurrenceCompletionRevisionRequest | TaskMoveRequest,
  ): Promise<TaskRepositoryResult> {
    const prepared = this.repository_abyssPrivate.supportsRevisionPreconditions === true;
    if ('destination' in request) {
      return prepared
        ? this.repository_abyssPrivate.move(request)
        : this.repository_abyssPrivate.move(request.baseRoot.ref, request.destination);
    }
    if ('baseOwnedDescendants' in request) {
      return this.repository_abyssPrivate.completeRecurrence(prepared ? request : request.command);
    }
    return this.repository_abyssPrivate.edit(prepared ? request : request.command);
  }

  private committedResult_abyssPrivate(
    prepared: PreparedMutation,
    result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
  ): TaskCommandResult {
    if (result.outcome.type === 'task') this.remember_abyssPrivate(result.outcome.task);
    if (result.outcome.type === 'recurrence') {
      if ('baseOwnedDescendants' in prepared.repositoryRequest) {
        this.forget_abyssPrivate(rootRefOf(prepared.repositoryRequest.command.target));
      }
      this.remember_abyssPrivate(result.outcome.active.root, result.outcome.active.target);
    }
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private terminalRepositoryResult_abyssPrivate(result: TaskRepositoryResult): TaskCommandResult {
    switch (result.type) {
      case 'committed':
        return { type: 'ok', outcome: result.outcome, changed: result.changed };
      case 'rebased':
        return { type: 'conflict', current: result.current };
      case 'uncertain':
        return { type: 'not-found', target: result.target };
      case 'partial':
      case 'invalid':
      case 'not-found':
      case 'ambiguous':
      case 'conflict':
      case 'io-error':
        return result;
    }
  }

  private async finishPrepared_abyssPrivate(
    prepared: PreparedMutation,
    first: TaskRepositoryResult,
  ): Promise<TaskCommandResult> {
    if (first.type === 'committed') return this.committedResult_abyssPrivate(prepared, first);
    if (first.type !== 'rebased') return this.terminalRepositoryResult_abyssPrivate(first);
    const retry = prepareRetry(prepared, first);
    if (retry.type === 'unsafe') return { type: 'conflict', current: first.current };
    const invalidCurrent = this.validateCompletion_abyssPrivate(prepared, retry.request);
    if (invalidCurrent !== undefined) return invalidCurrent;
    const second = await this.dispatch_abyssPrivate(retry.request);
    return second.type === 'committed'
      ? this.committedResult_abyssPrivate(prepared, second)
      : this.terminalRepositoryResult_abyssPrivate(second);
  }

  private remember_abyssPrivate(task: TaskSnapshot, permittedTarget?: TaskNodeRef): void {
    const key = refKey(task.ref);
    this.recentOutcomes_abyssPrivate.delete(key);
    this.recentOutcomes_abyssPrivate.set(key, {
      task: cloneTaskSnapshot(task),
      ...(permittedTarget != null && { permittedTarget }),
    });
    if (this.recentOutcomes_abyssPrivate.size <= RECENT_OUTCOME_LIMIT) return;
    const oldest = this.recentOutcomes_abyssPrivate.keys().next().value;
    if (oldest !== undefined) this.recentOutcomes_abyssPrivate.delete(oldest);
  }

  private forget_abyssPrivate(ref: TaskRef): void {
    for (const [key, outcome] of this.recentOutcomes_abyssPrivate) {
      if (
        outcome.task.ref.filePath === ref.filePath &&
        outcome.task.ref.revision === ref.revision
      ) {
        this.recentOutcomes_abyssPrivate.delete(key);
      }
    }
  }

  private recentForCommand_abyssPrivate(
    command: ExistingTaskCommand,
    ref: TaskRef,
  ): TaskSnapshot | undefined {
    if (command.type !== 'move') {
      return this.recentOutcome_abyssPrivate(
        ref,
        taskMutationNodeRef(mutationTargetForCommand(command)),
      );
    }
    const outcome = this.recentOutcomes_abyssPrivate.get(refKey(ref));
    return outcome?.permittedTarget == null ? outcome?.task : undefined;
  }

  /** The shared root resolution every rooted write uses, bridging the index-event lag first. */
  private resolveRoot_abyssPrivate(ref: TaskRef, node: TaskNodeRef): TaskResolution {
    const recent = this.recentOutcome_abyssPrivate(ref, node);
    return recent === undefined
      ? this.queries.resolve(ref)
      : { type: 'exact', task: recent, basis: { observed: recent } };
  }

  /** A remembered outcome is authority only for the node the mutation that produced it owned. */
  private recentOutcome_abyssPrivate(ref: TaskRef, node: TaskNodeRef): TaskSnapshot | undefined {
    const outcome = this.recentOutcomes_abyssPrivate.get(refKey(ref));
    if (outcome == null) return undefined;
    if (outcome.permittedTarget == null) return outcome.task;
    return sameTaskNodeRef(outcome.permittedTarget, node) ? outcome.task : undefined;
  }
}
