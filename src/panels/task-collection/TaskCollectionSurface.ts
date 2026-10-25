import type { TaskListSurface } from '../task-list/TaskListSurface';

/** Layouts retain the existing task-row interaction, receipt and virtualization boundary. */
export type TaskCollectionSurface<T> = Pick<
  TaskListSurface<T>,
  | 'rows'
  | 'element'
  | 'cards'
  | 'mountedKeys'
  | 'refreshMeasurements'
  | 'update'
  | 'reveal'
  | 'pin'
  | 'observeNativeWrites'
  | 'suspend'
  | 'resume'
  | 'destroy'
>;
