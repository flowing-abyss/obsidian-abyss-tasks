import type {
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
  TaskStatus,
} from './types';

function cloneTaskRef(ref: TaskRef): TaskRef {
  return { ...ref };
}

function cloneNodeRef(ref: TaskNodeRef): TaskNodeRef {
  if (ref.type === 'task') return { type: 'task', ref: cloneTaskRef(ref.ref) };
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

function cloneSubtask(task: SubtaskSnapshot): SubtaskSnapshot {
  return {
    ...task,
    ref: { ...task.ref, parent: cloneNodeRef(task.ref.parent) },
    planning: { ...task.planning },
    tags: [...task.tags],
    dependsOn: [...task.dependsOn],
    subtasks: task.subtasks.map(cloneSubtask),
    comments: task.comments.map(cloneComment),
  };
}

export function cloneTaskSnapshot(task: TaskSnapshot): TaskSnapshot {
  return {
    ...task,
    ref: cloneTaskRef(task.ref),
    planning: { ...task.planning },
    tags: [...task.tags],
    dependsOn: [...task.dependsOn],
    subtasks: task.subtasks.map(cloneSubtask),
    comments: task.comments.map(cloneComment),
    source: { ...task.source },
    presentation: { ...task.presentation },
  };
}

/** Reclassify a detached aggregate without changing its persisted identity or source bytes. */
export function taskSnapshotWithStatuses(
  task: TaskSnapshot,
  statusForSymbol: (symbol: string) => TaskStatus,
): TaskSnapshot {
  const child = (node: SubtaskSnapshot): SubtaskSnapshot => ({
    ...node,
    status: statusForSymbol(node.statusSymbol),
    subtasks: node.subtasks.map(child),
  });
  const cloned = cloneTaskSnapshot(task);
  return {
    ...cloned,
    status: statusForSymbol(cloned.statusSymbol),
    subtasks: cloned.subtasks.map(child),
  };
}
