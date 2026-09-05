import type { TaskEditCommand, TaskRepositoryResult } from '../../application/TaskRepository';
import { cloneTaskSnapshot } from '../../domain/cloneTaskSnapshot';
import type { SubtaskRemovalRecovery, TaskCommandOutcome } from '../../domain/commands';
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

export function recoverSubtaskRemoval(
  command: TaskEditCommand,
  edited: TaskBlockEditResult,
  result: TaskRepositoryResult,
): TaskRepositoryResult {
  if (
    command.type !== 'delete-subtask' ||
    edited.type !== 'changed' ||
    edited.removedSubtask === undefined ||
    result.type !== 'committed' ||
    result.outcome.type !== 'task'
  )
    return result;
  return {
    ...result,
    outcome: withSubtaskRemovalRecovery(result.outcome.task, {
      parent: command.subtask.parent,
      markdown: edited.removedSubtask.markdown,
      placement: {
        relativeLine: command.subtask.relativeLine,
        ...(edited.removedSubtask.lineEnding === undefined
          ? {}
          : { lineEnding: edited.removedSubtask.lineEnding }),
      },
    }),
  };
}

/** The committed deletion preserves every ancestor's position in its owning root. */
export function withSubtaskRemovalRecovery(
  task: TaskSnapshot,
  recovery: SubtaskRemovalRecovery,
): TaskOutcome {
  const path: number[] = [];
  let previous = recovery.parent;
  while (previous.type === 'subtask') {
    path.unshift(previous.ref.relativeLine);
    previous = previous.ref.parent;
  }
  const detached = cloneTaskSnapshot(task);
  let parent: TaskSnapshot | SubtaskSnapshot = detached;
  let target: TaskNodeRef = { type: 'task', ref: detached.ref };
  for (const relativeLine of path) {
    const child: SubtaskSnapshot | undefined = parent.subtasks.find(
      (candidate) => candidate.ref.relativeLine === relativeLine,
    );
    if (child === undefined) return { type: 'task', task };
    parent = child;
    target = { type: 'subtask', ref: child.ref };
  }
  const relativeLine = recovery.placement.relativeLine;
  const before = parent.subtasks.find((child) => child.ref.relativeLine >= relativeLine);
  const preceding = parent.subtasks.filter((child) => child.ref.relativeLine < relativeLine);
  const after = preceding[preceding.length - 1];
  return freeze({
    type: 'task',
    task: cloneTaskSnapshot(task),
    subtaskRemovalRecovery: {
      parent: target,
      markdown: recovery.markdown,
      placement: {
        relativeLine,
        ...(before === undefined ? {} : { before: before.ref }),
        ...(after === undefined ? {} : { after: after.ref }),
        ...(recovery.placement.lineEnding === undefined
          ? {}
          : { lineEnding: recovery.placement.lineEnding }),
      },
    },
  });
}
