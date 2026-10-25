import {
  indexedRows,
  type TaskListGroupRow,
  type TaskListRow,
  type TaskListRows,
} from '../panels/task-list/taskListRows';
import type { TaskStatusDef } from '../settings/types';
import type { TaskPlanning } from '../tasks';
import type { TaskTimelineSettings } from './taskTimelineSettings';

/** Filter finite collection rows while retaining their canonical task occurrence identity. */
export function buildTaskTimelineRows<T>(
  rows: TaskListRows<T>,
  settings: TaskTimelineSettings,
  statuses: readonly TaskStatusDef[],
  read: (task: T) => { readonly statusSymbol: string; readonly planning: TaskPlanning },
): TaskListRows<T> {
  const hidden = new Set(
    statuses.filter((s) => settings.hiddenStatuses.includes(s.id)).map((s) => s.symbol),
  );
  const result: Array<TaskListRow<T>> = [];
  let group: TaskListGroupRow | undefined;
  let tasks: Array<Extract<TaskListRow<T>, { kind: 'task' }>> = [];
  const flush = (): void => {
    if (tasks.length === 0) return;
    if (group !== undefined)
      result.push({ ...group, count: tasks.length, first: result.length === 0 });
    result.push(...tasks);
    tasks = [];
  };
  for (const row of rows.slice(0, rows.rowCount)) {
    if (row.kind === 'group') {
      flush();
      group = row;
      continue;
    }
    const value = read(row.task);
    if (hidden.has(value.statusSymbol)) continue;
    if (!settings.showUnscheduled && !hasDate(value.planning)) continue;
    tasks.push(row);
  }
  flush();
  return indexedRows(result);
}
function hasDate(planning: TaskPlanning): boolean {
  return (
    planning.start !== undefined || planning.due !== undefined || planning.scheduled !== undefined
  );
}
