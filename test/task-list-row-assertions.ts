import type { TaskListOrder } from '../src/panels/task-list/taskListRows';
import { expectDefined } from './helpers';

/** Materialize finite fixture order only, to compare the complete expected sequence. */
export function taskKeys(order: TaskListOrder): string[] {
  return Array.from({ length: order.taskCount }, (_, index) =>
    expectDefined(order.taskKeyAt(index)),
  );
}
