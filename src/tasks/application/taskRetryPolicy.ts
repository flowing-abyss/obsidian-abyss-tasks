import type { ClockReading } from '../domain/clock';
import type { TaskCommand, TaskStatusTarget } from '../domain/commands';
import type { RebaseEvidence } from '../domain/taskReconciliation';
import type {
  CommentRef,
  SubtaskRef,
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

export type RetryPolicy =
  | 'commutative'
  | 'field-compare'
  | 'exact-target'
  | 'relocation-only'
  | 'never';

export interface PreparedMutation {
  readonly publicCommand: TaskCommand;
  readonly repositoryRequest:
    | TaskEditRequest
    | RecurrenceCompletionRevisionRequest
    | TaskMoveRequest;
  readonly base: TaskSnapshot;
  readonly targetBase: TaskMutationTarget;
  readonly clock: ClockReading;
  readonly settings: TaskBehaviorSettings;
  readonly retry: RetryPolicy;
}

export type PreparedRetryRequest =
  | { readonly type: 'edit'; readonly request: TaskEditRequest }
  | { readonly type: 'recurrence'; readonly request: RecurrenceCompletionRevisionRequest }
  | { readonly type: 'move'; readonly request: TaskMoveRequest }
  | { readonly type: 'unsafe' };

function rebaseNode(node: TaskNodeRef, root: TaskRef): TaskNodeRef {
  if (node.type === 'task') return { type: 'task', ref: root };
  return { type: 'subtask', ref: { ...node.ref, parent: rebaseNode(node.ref.parent, root) } };
}

function rebaseSubtask(ref: SubtaskRef, root: TaskRef): SubtaskRef {
  return { ...ref, parent: rebaseNode(ref.parent, root) };
}

function rebaseComment(ref: CommentRef, root: TaskRef): CommentRef {
  return { ...ref, parent: rebaseNode(ref.parent, root) };
}

function rebaseTarget(target: TaskMutationTarget, root: TaskRef): TaskMutationTarget {
  if (target.type === 'task') return { type: 'task', ref: root };
  if (target.type === 'subtask') return { type: 'subtask', ref: rebaseSubtask(target.ref, root) };
  return { type: 'comment', ref: rebaseComment(target.ref, root) };
}

function rebaseStatusTarget(target: TaskStatusTarget, root: TaskRef): TaskStatusTarget {
  return rebaseNode(target, root);
}

function childChain(target: TaskStatusTarget): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let current = target;
  while (current.type === 'subtask') {
    chain.unshift(current.ref);
    current = current.ref.parent;
  }
  return chain;
}

function snapshotForTarget(
  root: TaskSnapshot,
  target: TaskStatusTarget,
): TaskSnapshot | SubtaskSnapshot | undefined {
  if (target.type === 'task') return root;
  let current: TaskSnapshot | SubtaskSnapshot = root;
  for (const child of childChain(target)) {
    const matches: readonly SubtaskSnapshot[] = current.subtasks.filter(
      (candidate) => candidate.ref.originalBlock === child.originalBlock,
    );
    if (matches.length !== 1) return undefined;
    current = matches[0]!;
  }
  return current;
}

function ownedDescendants(task: TaskSnapshot | SubtaskSnapshot): string {
  const block = 'source' in task ? task.source.originalBlock : task.ref.originalBlock;
  const newline = block.search(/\r?\n/u);
  return newline < 0 ? '' : block.slice(newline);
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
): boolean {
  const previousTarget = snapshotForTarget(
    previousRoot,
    rebaseStatusTarget(target, previousRoot.ref),
  );
  const currentTarget = snapshotForTarget(currentRoot, rebaseStatusTarget(target, currentRoot.ref));
  return Boolean(
    previousTarget &&
    currentTarget &&
    recurrenceOwnerUnchanged(previousTarget, currentTarget) &&
    ownedDescendants(previousTarget) === ownedDescendants(currentTarget),
  );
}

function rebaseEditCommand(command: TaskEditCommand, root: TaskRef): TaskEditCommand {
  switch (command.type) {
    case 'patch':
    case 'append-title':
    case 'set-status':
      return { ...command, target: rebaseStatusTarget(command.target, root) } as TaskEditCommand;
    case 'set-description':
      return { ...command, target: rebaseStatusTarget(command.target, root) };
    case 'add-subtask':
    case 'add-comment':
      return { ...command, parent: rebaseStatusTarget(command.parent, root) };
    case 'delete-subtask':
      return { ...command, subtask: rebaseSubtask(command.subtask, root) };
    case 'reorder-subtask':
      return {
        ...command,
        subtask: rebaseSubtask(command.subtask, root),
        target: rebaseSubtask(command.target, root),
      };
    case 'update-comment':
    case 'delete-comment':
      return { ...command, comment: rebaseComment(command.comment, root) };
    case 'edit-link':
      return {
        ...command,
        target:
          command.target.type === 'comment'
            ? { type: 'comment', ref: rebaseComment(command.target.ref, root) }
            : { ...command.target, target: rebaseStatusTarget(command.target.target, root) },
      };
    default:
      return { ...command, ref: root };
  }
}

function samePlanning(left: TaskSnapshot, right: TaskSnapshot): boolean {
  return JSON.stringify(left.planning) === JSON.stringify(right.planning);
}

function fieldPreconditionHolds(
  command: TaskEditCommand,
  previous: TaskSnapshot,
  current: TaskSnapshot,
): boolean {
  switch (command.type) {
    case 'patch': {
      const fields = Object.keys(command.patch).filter((field) => field !== 'tags');
      return fields.every((field) => {
        if (field === 'markdownTitle') return previous.markdownTitle === current.markdownTitle;
        if (field === 'priority') return previous.priority === current.priority;
        if (field === 'recurrence') return previous.recurrence === current.recurrence;
        if (field === 'onCompletion') return previous.onCompletion === current.onCompletion;
        return (
          previous.planning[field as keyof TaskSnapshot['planning']] ===
          current.planning[field as keyof TaskSnapshot['planning']]
        );
      });
    }
    case 'set-status':
      return previous.statusSymbol === current.statusSymbol;
    case 'reschedule':
    case 'shift-schedule':
    case 'move-time-slot':
    case 'move-to-all-day':
    case 'set-time-slot':
    case 'convert-to-all-day':
    case 'set-span-boundary':
    case 'extend-span':
      return samePlanning(previous, current);
    default:
      return false;
  }
}

function exactTargetPreconditionHolds(
  command: TaskEditCommand,
  previous: TaskSnapshot,
  current: TaskSnapshot,
): boolean {
  switch (command.type) {
    case 'append-title':
      return previous.markdownTitle === current.markdownTitle;
    case 'set-description':
      return previous.description === current.description;
    case 'edit-link':
    case 'delete-subtask':
    case 'update-comment':
    case 'delete-comment':
      return previous.source.originalBlock === current.source.originalBlock;
    case 'reorder-subtask':
      return false;
    default:
      return command.type === 'add-comment' || command.type === 'add-subtask';
  }
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
  const allowed = (() => {
    switch (prepared.retry) {
      case 'commutative':
        return true;
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
  const rebasedCommand = rebaseEditCommand(command, current.ref);
  return {
    type: 'edit',
    request: {
      command: rebasedCommand,
      baseRoot: current,
      baseTarget: rebaseTarget(prepared.targetBase, current.ref),
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
    const currentTargetRef = rebaseStatusTarget(request.command.target, authoritative.current.ref);
    const currentTarget = snapshotForTarget(authoritative.current, currentTargetRef);
    if (
      !previousTarget ||
      !currentTarget ||
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
        baseTarget: rebaseTarget(prepared.targetBase, authoritative.current.ref),
        reconciliation: { observed: authoritative.current },
        baseOwnedDescendants: request.baseOwnedDescendants,
      },
    };
  }
  return retryEdit(prepared, authoritative.previous, authoritative.current, authoritative.evidence);
}
