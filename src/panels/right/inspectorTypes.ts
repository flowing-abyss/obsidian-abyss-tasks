import type { SubtaskSnapshot, TaskNodeRef, TaskSnapshot } from '../../tasks';
import type { TaskListNavigationRequest } from '../center/TaskListNavigation';
export type TaskLike = TaskSnapshot | SubtaskSnapshot;
export interface InspectorTaskOwner {
  current: TaskLike | undefined;
}
export type SchedulingDateField = 'due' | 'scheduled' | 'start';
export type AddDateField = Exclude<SchedulingDateField, 'due'>;
export type PlanningControlKey =
  | 'date'
  | 'time'
  | 'priority'
  | 'repeat'
  | 'scheduled'
  | 'start'
  | 'add-date'
  | 'add-tag'
  | 'more-actions'
  | 'tracking-toggle'
  | 'tracking-sessions';

export type ShowInTaskList = (
  target: TaskNodeRef,
  request: TaskListNavigationRequest,
) => Promise<void>;
