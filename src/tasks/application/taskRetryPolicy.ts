import type { ClockReading } from '../domain/clock';
import type { TaskCommand, TaskCommandResult, TaskStatusTarget } from '../domain/commands';
import { shiftLocalDate } from '../domain/localDateMath';
import {
  taskNodeChain as childChain,
  taskNodeAtSourcePath as exactRestorationNode,
  rebaseTaskCommand,
  rebaseTaskNode,
  taskCommandMutationTarget,
} from '../domain/taskCommandTargets';
import { reconcileTaskNodeRef, type RebaseEvidence } from '../domain/taskReconciliation';
import type {
  CommentRef,
  LocalDate,
  SubtaskSnapshot,
  TaskMutationTarget,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from '../domain/types';
import type { TaskBehaviorSettings } from './TaskBehaviorSettings';
import type {
  RecurrenceCompletionRevisionRequest,
  RepositoryRevisionResult,
  TaskEditCommand,
  TaskEditRequest,
  TaskMoveRequest,
} from './TaskRepository';
import { subtaskRestorationGapIsCurrent } from './TaskRepository';

export type RetryPolicy =
  'commutative' | 'field-compare' | 'exact-target' | 'relocation-only' | 'never';

export interface PreparedMutation {
  readonly publicCommand: TaskCommand;
  readonly repositoryRequest:
    TaskEditRequest | RecurrenceCompletionRevisionRequest | TaskMoveRequest;
  readonly base: TaskSnapshot;
  readonly targetBase: TaskMutationTarget;
  readonly clock: ClockReading | { readonly localDate: ClockReading['localDate'] };
  readonly settings: TaskBehaviorSettings;
  readonly retry: RetryPolicy;
  readonly validateCurrent?: (
    currentRoot: TaskSnapshot,
    rebasedTarget: TaskNodeRef,
  ) => TaskCommandResult | undefined;
}

export type PreparedRetryRequest =
  | { readonly type: 'edit'; readonly request: TaskEditRequest }
  | { readonly type: 'recurrence'; readonly request: RecurrenceCompletionRevisionRequest }
  | { readonly type: 'move'; readonly request: TaskMoveRequest }
  | { readonly type: 'unsafe' };

type TaskStatusSnapshot = TaskSnapshot | SubtaskSnapshot;

function snapshotForTarget(
  root: TaskSnapshot,
  target: TaskStatusTarget,
): TaskStatusSnapshot | undefined {
  if (target.type === 'task') return root;
  let current: TaskStatusSnapshot = root;
  for (const child of childChain(target)) {
    const matches: readonly SubtaskSnapshot[] = current.subtasks.filter(
      (candidate) => candidate.ref.originalBlock === child.originalBlock,
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    if (match === undefined) return undefined;
    current = match;
  }
  return current;
}

function ownedDescendants(task: TaskSnapshot | SubtaskSnapshot): string {
  const block = 'source' in task ? task.source.originalBlock : task.ref.originalBlock;
  const newline = block.search(/\r?\n/u);
  return newline < 0 ? '' : block.slice(newline);
}

export function reconcileSubtaskRestoration(
  command: Extract<TaskCommand, { readonly type: 'restore-subtask' }>,
  previous: TaskSnapshot,
  current: TaskSnapshot,
): Extract<TaskCommand, { readonly type: 'restore-subtask' }> | undefined {
  const parent = reconcileTaskNodeRef(previous, current, command.parent);
  if (parent === undefined) return undefined;
  const beforeNode = exactRestorationNode(previous, command.parent);
  const afterNode = exactRestorationNode(current, parent);
  if (
    afterNode === undefined ||
    !restorationParentUnchanged(beforeNode, afterNode) ||
    !subtaskRestorationGapIsCurrent(command, afterNode)
  )
    return undefined;
  const { before, after } = command.placement;
  if (before === undefined && after === undefined && previous.ref.revision !== current.ref.revision)
    return undefined;
  return {
    ...command,
    parent,
    placement: {
      ...command.placement,
      ...(before === undefined ? {} : { before: { ...before, parent } }),
      ...(after === undefined ? {} : { after: { ...after, parent } }),
    },
  };
}

function restorationParentUnchanged(
  previous: TaskStatusSnapshot | undefined,
  current: TaskStatusSnapshot | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return restorationSource(previous) === restorationSource(current);
}

function restorationSource(node: TaskStatusSnapshot): string {
  return 'source' in node ? node.source.originalBlock : node.ref.originalBlock;
}

type DependencyMetadataCommand = Extract<
  TaskEditCommand,
  { readonly type: 'set-dependency-id' | 'set-depends-on' }
>;

function isDependencyMetadataCommand(
  command: TaskEditCommand,
): command is DependencyMetadataCommand {
  return command.type === 'set-dependency-id' || command.type === 'set-depends-on';
}

function recurrenceOwnerUnchanged(
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  return (
    previous.title === current.title &&
    previous.markdownTitle === current.markdownTitle &&
    previous.statusSymbol === current.statusSymbol &&
    previous.priority === current.priority &&
    previous.recurrence === current.recurrence &&
    previous.onCompletion === current.onCompletion &&
    JSON.stringify(previous.planning) === JSON.stringify(current.planning)
  );
}

export function recurrenceCompletionPreconditionHolds(
  previousRoot: TaskSnapshot,
  currentRoot: TaskSnapshot,
  target: TaskStatusTarget,
  evidence: RebaseEvidence,
): boolean {
  const previousRef = reconcileTaskNodeRef(currentRoot, previousRoot, target, {
    dependencyChanges: evidence === 'authority-transition',
  });
  if (previousRef === undefined) return false;
  const previousTarget = snapshotForTarget(previousRoot, previousRef);
  const currentTarget = snapshotForTarget(currentRoot, target);
  return Boolean(
    previousTarget != null &&
    currentTarget != null &&
    recurrenceOwnerUnchanged(previousTarget, currentTarget) &&
    ownedDescendants(previousTarget) === ownedDescendants(currentTarget),
  );
}

function rebaseEditCommand(command: TaskEditCommand, root: TaskRef): TaskEditCommand {
  return isDependencyMetadataCommand(command)
    ? { ...command, target: rebaseTaskNode(command.target, root) }
    : rebaseTaskCommand(command, root);
}

function nodeForCommand(
  root: TaskSnapshot,
  command: TaskEditCommand,
): TaskStatusSnapshot | undefined {
  const target = isDependencyMetadataCommand(command)
    ? command.target
    : taskCommandMutationTarget(command);
  return snapshotForTarget(root, target.type === 'comment' ? target.ref.parent : target);
}

function requestedFieldValue(update: { readonly type: string; readonly value?: unknown }): unknown {
  return update.type === 'clear' ? undefined : update.value;
}

function fieldUnchangedOrRequested(
  previous: unknown,
  current: unknown,
  update: { readonly type: string; readonly value?: unknown },
): boolean {
  return previous === current || current === requestedFieldValue(update);
}

interface SchedulingContext {
  readonly previous: TaskSnapshot | SubtaskSnapshot;
  readonly current: TaskSnapshot | SubtaskSnapshot;
  readonly anchor: 'scheduled' | 'due';
}

function planningField(
  context: SchedulingContext,
  name: keyof TaskSnapshot['planning'],
  requested: unknown,
): boolean {
  const previousValue = (context.previous.planning as Record<string, unknown>)[name];
  const currentValue = (context.current.planning as Record<string, unknown>)[name];
  return previousValue === currentValue || currentValue === requested;
}

function shiftedDate(
  context: SchedulingContext,
  name: 'start' | 'due' | 'scheduled',
  days: number,
): LocalDate | undefined {
  const value = context.previous.planning[name];
  return value == null ? undefined : shiftLocalDate(value, days);
}

function shiftedPlanningHolds(context: SchedulingContext, days: number): boolean {
  const { previous, anchor } = context;
  if (previous.planning.start != null && previous.planning.due != null) {
    return (
      planningField(context, 'start', shiftedDate(context, 'start', days)) &&
      planningField(context, 'due', shiftedDate(context, 'due', days))
    );
  }
  return planningField(context, anchor, shiftedDate(context, anchor, days));
}

function moveTimeSlotHolds(
  context: SchedulingContext,
  command: Extract<TaskEditCommand, { readonly type: 'move-time-slot' }>,
): boolean {
  return (
    shiftedPlanningHolds(context, command.days) && planningField(context, 'time', command.time)
  );
}

function moveToAllDayHolds(
  context: SchedulingContext,
  command: Extract<TaskEditCommand, { readonly type: 'move-to-all-day' }>,
): boolean {
  return (
    shiftedPlanningHolds(context, command.days) &&
    planningField(context, 'time', undefined) &&
    planningField(context, 'duration', undefined)
  );
}

function setTimeSlotHolds(
  context: SchedulingContext,
  command: Extract<TaskEditCommand, { readonly type: 'set-time-slot' }>,
): boolean {
  return (
    planningField(context, context.anchor, command.date) &&
    planningField(context, 'time', command.time) &&
    (command.duration === undefined || planningField(context, 'duration', command.duration))
  );
}

function extendSpanHolds(
  context: SchedulingContext,
  command: Extract<TaskEditCommand, { readonly type: 'extend-span' }>,
): boolean {
  const planning = context.previous.planning;
  const anchorValue = planning.start ?? planning.scheduled ?? planning.due;
  return (
    anchorValue !== undefined &&
    planningField(context, 'start', planning.start ?? anchorValue) &&
    planningField(context, 'due', command.due)
  );
}

type SchedulingCommand = Extract<
  TaskEditCommand,
  {
    readonly type:
      | 'reschedule'
      | 'shift-schedule'
      | 'move-time-slot'
      | 'move-to-all-day'
      | 'set-time-slot'
      | 'convert-to-all-day'
      | 'set-span-boundary'
      | 'extend-span';
  }
>;

const SCHEDULING_COMMAND_TYPES = new Set<TaskEditCommand['type']>([
  'reschedule',
  'shift-schedule',
  'move-time-slot',
  'move-to-all-day',
  'set-time-slot',
  'convert-to-all-day',
  'set-span-boundary',
  'extend-span',
]);

function isSchedulingCommand(command: TaskEditCommand): command is SchedulingCommand {
  return SCHEDULING_COMMAND_TYPES.has(command.type);
}

function convertToAllDayHolds(
  context: SchedulingContext,
  command: Extract<TaskEditCommand, { readonly type: 'convert-to-all-day' }>,
): boolean {
  return (
    planningField(context, context.anchor, command.date) &&
    planningField(context, 'time', undefined) &&
    planningField(context, 'duration', undefined)
  );
}

function schedulingPreconditionHolds(
  command: SchedulingCommand,
  previous: TaskStatusSnapshot,
  current: TaskStatusSnapshot,
): boolean {
  const anchor = previous.planning.scheduled !== undefined ? 'scheduled' : 'due';
  const context: SchedulingContext = { previous, current, anchor };
  switch (command.type) {
    case 'reschedule':
      return planningField(context, anchor, command.date);
    case 'shift-schedule':
      return shiftedPlanningHolds(context, command.days);
    case 'move-time-slot':
      return moveTimeSlotHolds(context, command);
    case 'move-to-all-day':
      return moveToAllDayHolds(context, command);
    case 'set-time-slot':
      return setTimeSlotHolds(context, command);
    case 'convert-to-all-day':
      return convertToAllDayHolds(context, command);
    case 'set-span-boundary':
      return planningField(context, command.boundary, command.date);
    case 'extend-span':
      return extendSpanHolds(context, command);
  }
}

function patchFieldPreconditionHolds(
  field: string,
  update: { readonly type: string; readonly value?: unknown },
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  if (field === 'markdownTitle') {
    return fieldUnchangedOrRequested(previous.markdownTitle, current.markdownTitle, update);
  }
  if (field === 'priority') {
    return fieldUnchangedOrRequested(previous.priority, current.priority, update);
  }
  if (field === 'recurrence') {
    return fieldUnchangedOrRequested(previous.recurrence, current.recurrence, update);
  }
  if (field === 'onCompletion') {
    return fieldUnchangedOrRequested(previous.onCompletion, current.onCompletion, update);
  }
  return fieldUnchangedOrRequested(
    (previous.planning as Record<string, unknown>)[field],
    (current.planning as Record<string, unknown>)[field],
    update,
  );
}

function patchPreconditionHolds(
  command: Extract<TaskEditCommand, { readonly type: 'patch' }>,
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  const fields = Object.keys(command.patch).filter((field) => field !== 'tags');
  return fields.every((field) => {
    const update = command.patch[field as keyof typeof command.patch];
    return (
      update != null &&
      'type' in update &&
      patchFieldPreconditionHolds(field, update, previous, current)
    );
  });
}

function fieldPreconditionHolds(
  command: TaskEditCommand,
  previous: TaskSnapshot,
  current: TaskSnapshot,
): boolean {
  const previousTarget = nodeForCommand(previous, command);
  const currentTarget = nodeForCommand(current, rebaseEditCommand(command, current.ref));
  if (previousTarget == null || currentTarget == null) return false;
  if (command.type === 'patch') {
    return patchPreconditionHolds(command, previousTarget, currentTarget);
  }
  if (command.type === 'set-status') {
    return (
      previousTarget.statusSymbol === currentTarget.statusSymbol ||
      currentTarget.statusSymbol === command.symbol
    );
  }
  return isSchedulingCommand(command)
    ? schedulingPreconditionHolds(command, previousTarget, currentTarget)
    : false;
}

function commentTargetExists(target: TaskSnapshot | SubtaskSnapshot, ref: CommentRef): boolean {
  return target.comments.some(
    (comment) =>
      comment.ref.relativeLine === ref.relativeLine &&
      comment.ref.originalMarkdown === ref.originalMarkdown,
  );
}

function deletedSubtaskUnchanged(
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  return (
    !('source' in previous) &&
    !('source' in current) &&
    previous.ref.originalBlock === current.ref.originalBlock
  );
}

function editLinkPreconditionHolds(
  command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): boolean {
  if (command.target.type === 'comment') return commentTargetExists(current, command.target.ref);
  return command.target.type === 'description'
    ? previous.description === current.description
    : previous.markdownTitle === current.markdownTitle;
}

type ExactTargetCommand = Extract<
  TaskEditCommand,
  {
    readonly type:
      | 'append-title'
      | 'set-description'
      | 'set-dependency-id'
      | 'set-depends-on'
      | 'delete-subtask'
      | 'update-comment'
      | 'delete-comment'
      | 'edit-link'
      | 'reorder-subtask'
      | 'add-comment'
      | 'add-subtask';
  }
>;

type AdditiveExactTargetCommand = Extract<
  ExactTargetCommand,
  { readonly type: 'add-comment' | 'add-subtask' }
>;

const EXACT_TARGET_COMMAND_TYPES = new Set<TaskEditCommand['type']>([
  'append-title',
  'set-description',
  'set-dependency-id',
  'set-depends-on',
  'delete-subtask',
  'update-comment',
  'delete-comment',
  'edit-link',
  'reorder-subtask',
  'add-comment',
  'add-subtask',
]);

function isExactTargetCommand(command: TaskEditCommand): command is ExactTargetCommand {
  return EXACT_TARGET_COMMAND_TYPES.has(command.type);
}

const ADDITIVE_EXACT_TARGET_TYPES = new Set<TaskEditCommand['type']>([
  'add-comment',
  'add-subtask',
]);

function isAdditiveExactTargetCommand(
  command: ExactTargetCommand,
): command is AdditiveExactTargetCommand {
  return ADDITIVE_EXACT_TARGET_TYPES.has(command.type);
}

function dependencyMetadataPreconditionHolds(
  command: DependencyMetadataCommand,
  previous: TaskStatusSnapshot,
  current: TaskStatusSnapshot,
): boolean {
  return command.type === 'set-dependency-id'
    ? previous.dependencyId === current.dependencyId
    : sameIds(previous.dependsOn, current.dependsOn);
}

function exactCommandPreconditionHolds(
  command: ExactTargetCommand,
  previous: TaskStatusSnapshot,
  current: TaskStatusSnapshot,
): boolean {
  if (isDependencyMetadataCommand(command)) {
    return dependencyMetadataPreconditionHolds(command, previous, current);
  }
  if (isAdditiveExactTargetCommand(command)) return true;
  switch (command.type) {
    case 'append-title':
      return previous.markdownTitle === current.markdownTitle;
    case 'set-description':
      return previous.description === current.description;
    case 'delete-subtask':
      return deletedSubtaskUnchanged(previous, current);
    case 'update-comment':
    case 'delete-comment':
      return commentTargetExists(current, command.comment);
    case 'edit-link':
      return editLinkPreconditionHolds(command, previous, current);
    case 'reorder-subtask':
      return false;
  }
}

function sameIds(previous: readonly string[], current: readonly string[]): boolean {
  return (
    previous.length === current.length && previous.every((value, index) => value === current[index])
  );
}

function exactTargetPreconditionHolds(
  command: TaskEditCommand,
  previous: TaskSnapshot,
  current: TaskSnapshot,
): boolean {
  const rebased = rebaseEditCommand(command, current.ref);
  const previousTarget = nodeForCommand(previous, command);
  const currentTarget = nodeForCommand(current, rebased);
  if (previousTarget == null || currentTarget == null) return false;
  return isExactTargetCommand(command)
    ? exactCommandPreconditionHolds(command, previousTarget, currentTarget)
    : false;
}

function retryEdit(
  prepared: PreparedMutation,
  previous: TaskSnapshot,
  current: TaskSnapshot,
  evidence: RebaseEvidence,
): PreparedRetryRequest {
  if (!('command' in prepared.repositoryRequest)) return { type: 'unsafe' };
  if ('baseOwnedDescendants' in prepared.repositoryRequest) return { type: 'unsafe' };
  const command = prepared.repositoryRequest.command;
  if (command.type === 'restore-subtask') {
    const restored = reconcileSubtaskRestoration(command, previous, current);
    return restored === undefined
      ? { type: 'unsafe' }
      : {
          type: 'edit',
          request: {
            command: restored,
            baseRoot: current,
            baseTarget: restored.parent,
            reconciliation: { observed: current },
          },
        };
  }
  const allowed = (() => {
    switch (prepared.retry) {
      case 'commutative':
        return Boolean(
          nodeForCommand(previous, command) != null &&
          nodeForCommand(current, rebaseEditCommand(command, current.ref)),
        );
      case 'field-compare':
        return fieldPreconditionHolds(command, previous, current);
      case 'exact-target':
        return exactTargetPreconditionHolds(command, previous, current);
      case 'relocation-only':
        return evidence === 'byte-identical-relocation';
      case 'never':
        return false;
    }
  })();
  if (!allowed) return { type: 'unsafe' };
  let rebasedCommand = rebaseEditCommand(command, current.ref);
  if (command.type === 'set-status') {
    const target = reconcileTaskNodeRef(previous, current, command.target);
    if (target === undefined) return { type: 'unsafe' };
    rebasedCommand = { ...command, target };
  }
  return {
    type: 'edit',
    request: {
      command: rebasedCommand,
      baseRoot: current,
      baseTarget:
        rebasedCommand.type === 'set-status'
          ? rebasedCommand.target
          : rebaseTaskNode(prepared.targetBase, current.ref),
      reconciliation: { observed: current },
    },
  };
}

export function prepareRetry(
  prepared: PreparedMutation,
  authoritative: Extract<RepositoryRevisionResult, { readonly type: 'rebased' }>,
): PreparedRetryRequest {
  if ('destination' in prepared.repositoryRequest) return { type: 'unsafe' };
  if ('baseOwnedDescendants' in prepared.repositoryRequest) {
    const request = prepared.repositoryRequest;
    const previousTarget = snapshotForTarget(authoritative.previous, request.command.target);
    const currentTargetRef = reconcileTaskNodeRef(
      authoritative.previous,
      authoritative.current,
      request.command.target,
    );
    if (currentTargetRef === undefined) return { type: 'unsafe' };
    const currentTarget = snapshotForTarget(authoritative.current, currentTargetRef);
    if (
      previousTarget == null ||
      currentTarget == null ||
      !recurrenceOwnerUnchanged(previousTarget, currentTarget) ||
      ownedDescendants(currentTarget) !== request.baseOwnedDescendants
    ) {
      return { type: 'unsafe' };
    }
    return {
      type: 'recurrence',
      request: {
        command: { ...request.command, target: currentTargetRef },
        baseRoot: authoritative.current,
        baseTarget: rebaseTaskNode(prepared.targetBase, authoritative.current.ref),
        reconciliation: { observed: authoritative.current },
        baseOwnedDescendants: request.baseOwnedDescendants,
      },
    };
  }
  return retryEdit(prepared, authoritative.previous, authoritative.current, authoritative.evidence);
}
