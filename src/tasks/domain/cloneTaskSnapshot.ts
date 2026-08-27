import type {
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from './types';
import { taskDependencyId, taskDependencyIds } from './validation';

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
    ref: { ...comment.ref, parent: cloneNodeRef(comment.ref.parent) },
  };
}

function cloneSubtask(task: SubtaskSnapshot): SubtaskSnapshot {
  return {
    ...task,
    ref: { ...task.ref, parent: cloneNodeRef(task.ref.parent) },
    planning: { ...task.planning },
    tags: [...task.tags],
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
    subtasks: task.subtasks.map(cloneSubtask),
    comments: task.comments.map(cloneComment),
    ...(task.dependency !== undefined && {
      dependency: {
        ...(task.dependency.id !== undefined && { id: taskDependencyId(task.dependency.id) }),
        dependsOn: taskDependencyIds(task.dependency.dependsOn),
      },
    }),
    source: { ...task.source },
    presentation: { ...task.presentation },
  };
}
