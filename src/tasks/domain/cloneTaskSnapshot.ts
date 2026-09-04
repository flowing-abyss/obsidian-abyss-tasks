import type {
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
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
