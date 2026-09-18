import type { TaskEditCommand, TaskRepositoryResult } from '../../application/TaskRepository';
import type { TaskCommandOutcome, TimeEntryRemovalRecovery } from '../../domain/commands';
import type { SubtaskSnapshot, TaskNodeRef, TaskSnapshot } from '../../domain/types';
import type { TaskBlockEditResult } from './TaskBlockEditor';

type TaskOutcome = Extract<TaskCommandOutcome, { readonly type: 'task' }>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The owner of a removed entry line keeps its position in the committed root, because every
 * ancestor starts before the line that went away. Only the blocks they quote have changed. The
 * chain is rebuilt rather than borrowed, so freezing the evidence cannot reach a live snapshot.
 */
function committedOwner(task: TaskSnapshot, owner: TaskNodeRef): TaskNodeRef | undefined {
  const path: number[] = [];
  let node = owner;
  while (node.type === 'subtask') {
    path.unshift(node.ref.relativeLine);
    node = node.ref.parent;
  }
  let parent: TaskSnapshot | SubtaskSnapshot = task;
  let target: TaskNodeRef = { type: 'task', ref: { ...task.ref } };
  for (const relativeLine of path) {
    const child: SubtaskSnapshot | undefined = parent.subtasks.find(
      (candidate) => candidate.ref.relativeLine === relativeLine,
    );
    if (child === undefined) return undefined;
    parent = child;
    target = {
      type: 'subtask',
      ref: {
        parent: target,
        relativeLine: child.ref.relativeLine,
        originalBlock: child.ref.originalBlock,
      },
    };
  }
  return target;
}

function removalRecovery(
  command: TaskEditCommand,
  edited: Extract<TaskBlockEditResult, { readonly type: 'changed' }>,
  task: TaskSnapshot,
): TimeEntryRemovalRecovery | undefined {
  const removed = edited.removedTimeEntry;
  if (command.type !== 'delete-time-entry' || removed === undefined) return undefined;
  const parent = committedOwner(task, command.entry.parent);
  if (parent === undefined) return undefined;
  return { parent, markdown: removed.markdown, relativeLine: removed.relativeLine };
}

/** Carries an entry line the block editor removed, plus a discarded session, into the outcome. */
export function recoverTimeEntryRemoval(
  command: TaskEditCommand,
  edited: TaskBlockEditResult,
  result: TaskRepositoryResult,
): TaskRepositoryResult {
  if (edited.type !== 'changed' || result.type !== 'committed' || result.outcome.type !== 'task') {
    return result;
  }
  const recovery = removalRecovery(command, edited, result.outcome.task);
  if (recovery === undefined && edited.discardedShortEntry !== true) return result;
  const outcome: TaskOutcome = {
    ...result.outcome,
    ...(recovery === undefined ? {} : { timeEntryRemovalRecovery: freeze(recovery) }),
    ...(edited.discardedShortEntry === true ? { discardedShortEntry: true } : {}),
  };
  return { ...result, outcome };
}

/** Re-anchors a committed entry removal on another generation of the same root. */
export function withTimeEntryRemovalRecovery(
  task: TaskSnapshot,
  outcome: TaskOutcome,
): TaskOutcome {
  const recovery = outcome.timeEntryRemovalRecovery;
  const parent = recovery === undefined ? undefined : committedOwner(task, recovery.parent);
  return {
    type: 'task',
    task,
    ...(recovery === undefined || parent === undefined
      ? {}
      : { timeEntryRemovalRecovery: freeze({ ...recovery, parent }) }),
    ...(outcome.discardedShortEntry === true ? { discardedShortEntry: true } : {}),
  };
}
