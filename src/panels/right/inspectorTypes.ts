import type { SubtaskSnapshot, TaskSnapshot } from '../../tasks';
export type TaskLike = TaskSnapshot | SubtaskSnapshot;
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
