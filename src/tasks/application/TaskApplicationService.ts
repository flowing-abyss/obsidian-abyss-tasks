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
import { reconcileTaskNodeRef, type TaskResolution } from '../domain/taskReconciliation';
import type {
  LocalDate,
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
import type {
  CreateTaskCommand,
  CreateTaskCommandDestination,
  CreateTaskCommandInitial,
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCreateSession,
  TaskDependencyQueryApi,
  TaskQueryApi,
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
import { subtaskRestorationIssues } from './TaskRepository';
import {
  prepareRetry,
  reconcileSubtaskRestoration,
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

function normalizeTagChange(tags: NonNullable<TaskPatch['tags']>): TaskPatch['tags'] | undefined {
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
    if (next == null) return undefined;
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
  taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
  recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
};
type DependencyCommand = Extract<
  TaskCommand,
  { readonly type: 'add-dependency' | 'remove-dependency' | 'restore-dependency' }
>;
type ExistingTaskCommand = Exclude<TaskCommand, DependencyCommand | { readonly type: 'create' }>;
type EditableTaskCommand = Exclude<ExistingTaskCommand, { readonly type: 'move' }>;
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
type DirectTargetCommand = Extract<
  TaskCommand,
  {
    readonly type:
      'patch' | 'append-title' | 'set-status' | 'toggle-completion' | 'set-description';
  }
>;
type ParentTargetCommand = Extract<
  TaskCommand,
  { readonly type: 'add-subtask' | 'restore-subtask' | 'add-comment' }
>;
type SubtaskReferenceCommand = Extract<
  TaskCommand,
  { readonly type: 'delete-subtask' | 'reorder-subtask' }
>;
type CommentReferenceCommand = Extract<
  TaskCommand,
  { readonly type: 'update-comment' | 'delete-comment' }
>;
type StatusCommand = Extract<TaskCommand, { readonly type: 'set-status' | 'toggle-completion' }>;

const DIRECT_TARGET_TYPES = new Set<TaskCommand['type']>([
  'patch',
  'append-title',
  'set-status',
  'toggle-completion',
  'set-description',
]);
const PARENT_TARGET_TYPES = new Set<TaskCommand['type']>([
  'add-subtask',
  'restore-subtask',
  'add-comment',
]);
const SUBTASK_REFERENCE_TYPES = new Set<TaskCommand['type']>(['delete-subtask', 'reorder-subtask']);
const COMMENT_REFERENCE_TYPES = new Set<TaskCommand['type']>(['update-comment', 'delete-comment']);
const COMMUTATIVE_COMMAND_TYPES = new Set<TaskEditCommand['type']>(['add-comment', 'add-subtask']);
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

function isDirectTargetCommand(command: TaskCommand): command is DirectTargetCommand {
  return DIRECT_TARGET_TYPES.has(command.type);
}

function isParentTargetCommand(command: TaskCommand): command is ParentTargetCommand {
  return PARENT_TARGET_TYPES.has(command.type);
}

function isSubtaskReferenceCommand(command: TaskCommand): command is SubtaskReferenceCommand {
  return SUBTASK_REFERENCE_TYPES.has(command.type);
}

function isCommentReferenceCommand(command: TaskCommand): command is CommentReferenceCommand {
  return COMMENT_REFERENCE_TYPES.has(command.type);
}

function isStatusCommand(command: TaskCommand): command is StatusCommand {
  return command.type === 'set-status' || command.type === 'toggle-completion';
}

function invalidTarget(field: string): TaskCommandResult {
  return { type: 'invalid', issues: [{ code: 'invalid-target', field }] };
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
    return invalidTarget('days');
  }
  return undefined;
}

function titleInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'patch' &&
    command.patch.markdownTitle?.type === 'set' &&
    !isSingleLineText(command.patch.markdownTitle.value)
  ) {
    return invalidTarget('title');
  }
  if (command.type === 'append-title' && !isSingleLineText(command.markdown)) {
    return invalidTarget('title');
  }
  if (command.type === 'edit-link' && !isSingleLineText(command.replacement)) {
    return invalidTarget('link');
  }
  return undefined;
}

function commentInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    (command.type === 'add-comment' || command.type === 'update-comment') &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return invalidTarget('comment');
  }
  return undefined;
}

function subtaskInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'add-subtask' &&
    (!isSingleLineText(command.text) || command.text.trim().length === 0)
  ) {
    return invalidTarget('subtask');
  }
  return undefined;
}

function descriptionInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  if (
    command.type === 'set-description' &&
    (command.text?.replace(/\r\n/gu, '').includes('\r') ?? false)
  ) {
    return invalidTarget('description');
  }
  return undefined;
}

function multilineInputIssue(command: TaskCommand): TaskCommandResult | undefined {
  return (
    scheduleInputIssue(command) ??
    titleInputIssue(command) ??
    commentInputIssue(command) ??
    subtaskInputIssue(command) ??
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

function rootRefForCommand(command: ExistingTaskCommand): TaskRef {
  if (isDirectTargetCommand(command)) return rootRefOf(command.target);
  if (isParentTargetCommand(command)) return rootRefOf(command.parent);
  if (isSubtaskReferenceCommand(command)) return rootRefOf(command.subtask.parent);
  if (isCommentReferenceCommand(command)) return rootRefOf(command.comment.parent);
  if (command.type === 'edit-link') {
    return rootRefOf(
      command.target.type === 'comment' ? command.target.ref.parent : command.target.target,
    );
  }
  return command.ref;
}

function mutationTargetForCommand(command: EditableTaskCommand): TaskMutationTarget {
  if (isDirectTargetCommand(command)) return command.target;
  if (isParentTargetCommand(command)) return command.parent;
  if (isSubtaskReferenceCommand(command)) return { type: 'subtask', ref: command.subtask };
  if (isCommentReferenceCommand(command)) return { type: 'comment', ref: command.comment };
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target : command.target.target;
  }
  return { type: 'task', ref: command.ref };
}

function rebaseCommandRoot<T extends EditableTaskCommand>(command: T, root: TaskRef): T {
  let rebased: EditableTaskCommand;
  if (isDirectTargetCommand(command)) {
    rebased = {
      ...command,
      target: rebaseStatusTarget(command.target, root),
    } as DirectTargetCommand;
  } else if (isParentTargetCommand(command)) {
    rebased = { ...command, parent: rebaseStatusTarget(command.parent, root) };
  } else if (isSubtaskReferenceCommand(command)) {
    const subtask = {
      ...command.subtask,
      parent: rebaseStatusTarget(command.subtask.parent, root),
    };
    rebased =
      command.type === 'reorder-subtask'
        ? {
            ...command,
            subtask,
            target: { ...command.target, parent: rebaseStatusTarget(command.target.parent, root) },
          }
        : { ...command, subtask };
  } else if (isCommentReferenceCommand(command)) {
    rebased = {
      ...command,
      comment: { ...command.comment, parent: rebaseStatusTarget(command.comment.parent, root) },
    };
  } else if (command.type === 'edit-link') {
    rebased = { ...command, target: rebaseLinkTarget(command.target, root) };
  } else {
    rebased = { ...command, ref: root };
  }
  return rebased as unknown as T;
}

function rebaseLinkTarget(
  target: Extract<TaskCommand, { readonly type: 'edit-link' }>['target'],
  root: TaskRef,
): Extract<TaskCommand, { readonly type: 'edit-link' }>['target'] {
  return target.type === 'comment'
    ? {
        type: 'comment',
        ref: { ...target.ref, parent: rebaseStatusTarget(target.ref.parent, root) },
      }
    : { ...target, target: rebaseStatusTarget(target.target, root) };
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

function prepareCreateInitial(request: TaskCreateRequest): PreparedCreateInitial {
  const source = request.initial;
  if (source === undefined) return { type: 'valid' };
  if (source.tags === undefined) return { type: 'valid', initial: source };
  const tags = normalizeTagChange(source.tags);
  return tags === undefined ? { type: 'invalid' } : { type: 'valid', initial: { ...source, tags } };
}

function destinationUnavailableResult(): TaskCommandResult {
  return {
    type: 'invalid',
    issues: [{ code: 'destination-unavailable', field: 'destination' }],
  };
}

type TaskApplicationServiceDependencies = [
  queries: TaskQueryApi & TaskDependencyQueryApi,
  repository: TaskRepository,
  statusCatalog: StatusCatalog,
  clock: Clock | LegacyClock,
  destinationProvider?: TaskDestinationProvider,
  behaviorSettings?: TaskBehaviorSettingsProvider,
  dependencies?: TaskDependencyService,
  diagnostics?: TaskDiagnosticSink,
];

export class TaskApplicationService implements TaskApplicationApi, TaskCaptureApplicationApi {
  // Bridges the index-event lag only for exact refs returned by this service. The cache shares the
  // service lifetime and is bounded so revision churn cannot retain an unbounded snapshot history.
  private readonly recentOutcomes = new Map<string, RecentOutcome>();

  readonly queries: TaskQueryApi & TaskDependencyQueryApi;
  private readonly dependencies: TaskDependencyService;
  private readonly diagnostics: TaskDiagnosticSink;
  private readonly repository: TaskRepository;
  private readonly statusCatalog: StatusCatalog;
  private readonly clock: Clock | LegacyClock;
  private readonly destinationProvider: TaskDestinationProvider | undefined;
  private readonly behaviorSettings: TaskBehaviorSettingsProvider;

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
    this.repository = repository;
    this.statusCatalog = statusCatalog;
    this.clock = clock;
    this.destinationProvider = destinationProvider;
    this.behaviorSettings = behaviorSettings;
    this.dependencies =
      dependencyService ??
      new TaskDependencyService(queries, repository, nextTaskDependencyId, diagnostics);
    this.diagnostics = diagnostics;
  }

  async planCreate(destination: CreateTaskCommandDestination): Promise<TaskCreateSession> {
    const settings = snapshotBehaviorSettings(this.behaviorSettings);
    const reading = captureClock(this.clock);
    try {
      const plan = await this.destinationPlan(destination);
      if (plan === undefined) return this.unavailableCreateSession();
      return this.readyCreateSession(plan, settings, reading);
    } catch {
      return this.unavailableCreateSession();
    }
  }

  async execute(command: TaskCommand): Promise<TaskCommandResult> {
    try {
      return await this.executeCommand(command);
    } catch {
      this.diagnostics({ operation: command.type, phase: 'unexpected', cause: 'repository-error' });
      return {
        type: 'io-error',
        cause: 'repository-error',
        ...(command.type === 'move' && { path: command.destination.filePath }),
        contentState: 'unknown',
      };
    }
  }

  private async executeCommand(command: TaskCommand): Promise<TaskCommandResult> {
    const restorationIssues = subtaskRestorationIssues(command);
    if (restorationIssues.length > 0) return { type: 'invalid', issues: restorationIssues };
    if (
      command.type === 'add-dependency' ||
      command.type === 'remove-dependency' ||
      command.type === 'restore-dependency'
    )
      return await this.dependencies.execute(command);
    const inputIssue = multilineInputIssue(command);
    if (inputIssue != null) return inputIssue;
    const settings = snapshotBehaviorSettings(this.behaviorSettings);
    const reading = captureClock(this.clock);
    if (command.type === 'add-comment' && !('atom' in reading)) return invalidTarget('comment');
    if (command.type === 'create') return await this.create(command, settings, reading);
    return await this.executeExistingCommand(command, settings, reading);
  }

  private async executeExistingCommand(
    command: ExistingTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    serialized = false,
  ): Promise<TaskCommandResult> {
    const rootRef = rootRefForCommand(command);
    const resolution = this.resolveForCommand(command, rootRef);
    const unavailable = this.unavailableResult(command, resolution);
    if (unavailable != null) return unavailable;
    const proven = resolution as ProvenResolution;
    if (command.type === 'move') return await this.move(command, proven, settings, reading);
    return await this.executeEditableCommand(command, proven, { settings, reading, serialized });
  }

  private resolveForCommand(command: ExistingTaskCommand, rootRef: TaskRef): TaskResolution {
    const recent = this.recentForCommand(command, rootRef);
    if (recent === undefined) return this.queries.resolve(rootRef);
    if (isStatusCommand(command)) {
      const indexed = this.queries.resolve(rootRef);
      if (indexed.type === 'rebased') return indexed;
    }
    return { type: 'exact', task: recent, basis: { observed: recent } };
  }

  private async executeEditableCommand(
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
    const preparedCommand = this.prepare(currentCommand, settings, reading, resolution);
    if ('result' in preparedCommand) return preparedCommand.result;
    const targetBase = mutationTargetForCommand(command);
    const repositoryRequest = this.repositoryRequest(
      preparedCommand,
      currentRoot,
      targetBase,
      resolution,
    );
    const validateCurrent = this.completionValidation(
      preparedCommand,
      targetBase,
      resolution.basis.observed,
    );
    const prepared: PreparedMutation = {
      publicCommand: command,
      repositoryRequest,
      base: baseRoot,
      targetBase,
      clock: reading,
      settings,
      retry:
        'recurrence' in preparedCommand ? 'exact-target' : retryPolicy(preparedCommand.command),
      ...(validateCurrent === undefined ? {} : { validateCurrent }),
    };
    if (validateCurrent !== undefined && !serialized) {
      return await this.dependencies.serializeMutation((queued) =>
        queued
          ? this.executeExistingCommand(command, settings, reading, true)
          : this.dispatchPrepared(prepared),
      );
    }
    return await this.dispatchPrepared(prepared);
  }

  private async dispatchPrepared(prepared: PreparedMutation): Promise<TaskCommandResult> {
    const invalidCurrent = this.validateCompletion(prepared, prepared.repositoryRequest);
    if (invalidCurrent !== undefined) return invalidCurrent;
    return await this.finishPrepared(prepared, await this.dispatch(prepared.repositoryRequest));
  }

  private completionValidation(
    prepared: Exclude<PreparedTaskCommand, { readonly result: TaskCommandResult }>,
    predecessor: TaskMutationTarget,
    previous: TaskSnapshot,
  ): PreparedMutation['validateCurrent'] {
    let symbol: string | undefined;
    if ('recurrence' in prepared) symbol = prepared.recurrence.doneSymbol;
    else if (prepared.command.type === 'set-status') symbol = prepared.command.symbol;
    if (symbol === undefined || predecessor.type === 'comment') return undefined;
    const type = this.statusCatalog.statusForSymbol(symbol);
    if (type !== 'done' && type !== 'cancelled') return undefined;
    return (root, target) => {
      const current = taskSnapshotWithStatuses(root, (status) =>
        this.statusCatalog.statusForSymbol(status),
      );
      try {
        const indexed = this.queries
          .listNodes()
          .some((node) => sameTaskNodeRef(node.target, target));
        const blockers = this.dependencies.withCompletionBasis({ previous, current }, () =>
          this.dependencies.blockersForCompletion(current, indexed ? target : predecessor),
        );
        return blockers.length === 0 ? undefined : { type: 'blocked', target, blockers };
      } catch (error) {
        if (error instanceof DependencyCompletionConflict) return { type: 'conflict', current };
        throw error;
      }
    };
  }

  private validateCompletion(
    prepared: PreparedMutation,
    request: PreparedMutation['repositoryRequest'],
  ): TaskCommandResult | undefined {
    if (!('command' in request)) return undefined;
    const command = request.command;
    if (!('doneSymbol' in command) && command.type !== 'set-status') return undefined;
    return prepared.validateCurrent?.(request.baseRoot, command.target);
  }

  private repositoryRequest(
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
    command: CreateTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): Promise<TaskCommandResult> {
    const resolveDestination = async (): Promise<TaskDestinationResolution | undefined> => {
      if (command.destination.type === 'explicit') {
        if (command.destination.provision === undefined) {
          return {
            type: 'resolved',
            destination: {
              filePath: command.destination.destination.filePath,
              insertion: { ...command.destination.destination.insertion },
            },
          };
        }
        return await this.destinationProvider?.prepare(command.destination.destination);
      }
      return await this.destinationProvider?.resolveConfiguredDefault();
    };
    return await this.executePlannedCreate(command, resolveDestination, settings, reading);
  }

  private async executePlannedCreate(
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
    const preparedInitial = prepareCreateInitial(request);
    if (preparedInitial.type === 'invalid') {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'tags' }] };
    }
    const result = await this.repository.create(resolution.destination, {
      markdownBody: request.markdownBody,
      ...(preparedInitial.initial !== undefined && { initial: preparedInitial.initial }),
      today: reading.localDate,
      addCreatedDate: settings.taskLifecycle.addCreatedDate,
    });
    if (result.type !== 'committed') return this.terminalRepositoryResult(result);
    if (result.outcome.type === 'task') this.remember(result.outcome.task);
    return { type: 'ok', outcome: result.outcome, changed: result.changed };
  }

  private async destinationPlan(
    destination: CreateTaskCommandDestination,
  ): Promise<TaskDestinationPlan | undefined> {
    if (destination.type === 'configured-default') {
      return await this.destinationProvider?.planConfiguredDefault();
    }
    if (destination.provision !== undefined) {
      return await this.destinationProvider?.planExplicit(destination.destination);
    }
    const planned: TaskDestination = {
      filePath: destination.destination.filePath,
      insertion: { ...destination.destination.insertion },
    };
    return {
      destination: planned,
      prepare: async () => ({ type: 'resolved', destination: planned }),
    };
  }

  private readyCreateSession(
    plan: TaskDestinationPlan,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
  ): TaskCreateSession {
    const destination: TaskDestination = {
      filePath: plan.destination.filePath,
      insertion: { ...plan.destination.insertion },
    };
    let preparation: Promise<TaskDestinationResolution> | undefined;
    const prepareOnce = (): Promise<TaskDestinationResolution> => {
      preparation ??= Promise.resolve().then(() => plan.prepare());
      return preparation;
    };
    return {
      type: 'ready',
      destination,
      execute: async (request) => {
        try {
          return await this.executePlannedCreate(request, prepareOnce, settings, reading);
        } catch {
          return {
            type: 'io-error',
            cause: 'repository-error',
            contentState: 'unknown',
          };
        }
      },
    };
  }

  private unavailableCreateSession(): TaskCreateSession {
    return {
      type: 'unavailable',
      execute: async () => destinationUnavailableResult(),
    };
  }

  private prepare(
    command: EditableTaskCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    return isStatusCommand(command)
      ? this.prepareStatusCommand(command, settings, reading, resolution)
      : this.prepareNonStatusCommand(command, settings, reading, resolution);
  }

  private prepareNonStatusCommand(
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
          today: reading.localDate,
          addCreatedDate: settings.taskLifecycle.addCreatedDate,
        },
      };
    }

    if (command.type === 'patch' && command.patch.tags !== undefined) {
      return this.prepareTagPatch(command);
    }

    if (command.type === 'move-time-slot' || command.type === 'move-to-all-day') {
      return this.prepareMoveSchedule(
        command,
        resolution.type === 'exact' ? resolution.task : resolution.current,
      );
    }
    return { command };
  }

  private prepareTagPatch(
    command: Extract<TaskCommand, { readonly type: 'patch' }>,
  ): PreparedTaskCommand {
    const sourceTags = command.patch.tags;
    if (sourceTags === undefined) return { command };
    const tags = normalizeTagChange(sourceTags);
    if (tags === undefined) return { result: invalidTarget('tags') };
    return { command: { ...command, patch: { ...command.patch, tags } } };
  }

  private prepareStatusCommand(
    command: StatusCommand,
    settings: TaskBehaviorSettings,
    reading: ClockReading | { readonly localDate: ClockReading['localDate'] },
    resolution: ProvenResolution,
  ): PreparedTaskCommand {
    const resolved = resolvedStatusSelection(resolution, command.target);
    if (resolved.current == null) return { result: { type: 'conflict', current: resolved.root } };
    const current = resolved.current;
    const currentRule = this.statusCatalog.ruleForSymbol(current.statusSymbol);
    const currentSemanticStatus =
      currentRule == null
        ? this.statusCatalog.statusForSymbol(current.statusSymbol)
        : statusForRuleType(currentRule.type);
    const rule = this.requestedStatusRule(command, currentSemanticStatus);
    if (rule === undefined) return invalidStatusResult();
    const recurrence = this.prepareRecurrenceCompletion({
      current,
      target: resolved.target,
      currentSemanticStatus,
      requestedRule: rule,
      settings,
      reading,
    });
    if (recurrence !== undefined) {
      return this.validateRecurrencePreparation(recurrence, resolution);
    }
    return this.preparedStatusEdit(
      resolved.target,
      current,
      currentRule,
      currentSemanticStatus,
      rule,
      settings,
      reading,
    );
  }

  private requestedStatusRule(
    command: StatusCommand,
    currentSemanticStatus: TaskStatus,
  ): TaskStatusRule | undefined {
    if (command.type === 'set-status') return this.statusCatalog.ruleForSymbol(command.symbol);
    const targetType = currentSemanticStatus === 'done' ? 'todo' : 'done';
    return this.statusCatalog.defaultForType(targetType);
  }

  private validateRecurrencePreparation(
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

  private preparedStatusEdit(
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

  private prepareRecurrenceCompletion(context: {
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
    const todoRule = this.statusCatalog.defaultForType('todo');
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
    command: ExistingTaskCommand,
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
      case 'partial':
      case 'invalid':
      case 'not-found':
      case 'ambiguous':
      case 'conflict':
      case 'io-error':
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
    const invalidCurrent = this.validateCompletion(prepared, retry.request);
    if (invalidCurrent !== undefined) return invalidCurrent;
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
      ...(permittedTarget != null && { permittedTarget }),
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

  private recentForCommand(command: ExistingTaskCommand, ref: TaskRef): TaskSnapshot | undefined {
    const outcome = this.recentOutcomes.get(refKey(ref));
    if (outcome == null) return undefined;
    if (outcome.permittedTarget == null) return outcome.task;
    if (command.type === 'move') return undefined;
    const target = mutationTargetForCommand(command);
    let node: TaskNodeRef;
    if (target.type === 'comment') node = target.ref.parent;
    else if (target.type === 'subtask') node = { type: 'subtask', ref: target.ref };
    else node = target;
    return sameTaskNodeRef(outcome.permittedTarget, node) ? outcome.task : undefined;
  }
}
