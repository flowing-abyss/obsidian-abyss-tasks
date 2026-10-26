import type {
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskSnapshot,
  TaskStatus,
} from './types';

function cloneNodeRef(ref: TaskNodeRef): TaskNodeRef {
  if (ref.type === 'task') return { type: 'task', ref: { ...ref.ref } };
  return {
    type: 'subtask',
    ref: {
      ...ref.ref,
      parent: cloneNodeRef(ref.ref.parent),
    },
  };
}

function cloneComment(comment: TaskCommentSnapshot): TaskCommentSnapshot {
  return {
    ...comment,
    ...(comment.timestamp === undefined ? {} : { timestamp: { ...comment.timestamp } }),
    ref: { ...comment.ref, parent: cloneNodeRef(comment.ref.parent) },
  };
}

function cloneSubtask(
  task: SubtaskSnapshot,
  statusForSymbol?: (symbol: string) => TaskStatus,
): SubtaskSnapshot {
  return {
    ...task,
    status: statusForSymbol?.(task.statusSymbol) ?? task.status,
    ref: { ...task.ref, parent: cloneNodeRef(task.ref.parent) },
    planning: { ...task.planning },
    tags: [...task.tags],
    dependsOn: [...task.dependsOn],
    subtasks: task.subtasks.map((child) => cloneSubtask(child, statusForSymbol)),
    comments: task.comments.map(cloneComment),
  };
}

/** Reclassify a detached aggregate without changing its persisted identity or source bytes. */
export function taskSnapshotWithStatuses(
  task: TaskSnapshot,
  statusForSymbol?: (symbol: string) => TaskStatus,
): TaskSnapshot {
  return {
    ...task,
    status: statusForSymbol?.(task.statusSymbol) ?? task.status,
    ref: { ...task.ref },
    planning: { ...task.planning },
    tags: [...task.tags],
    dependsOn: [...task.dependsOn],
    subtasks: task.subtasks.map((child) => cloneSubtask(child, statusForSymbol)),
    comments: task.comments.map(cloneComment),
    source: { ...task.source },
    presentation: { ...task.presentation },
  };
}

export function cloneTaskSnapshot(task: TaskSnapshot): TaskSnapshot {
  return taskSnapshotWithStatuses(task);
}
