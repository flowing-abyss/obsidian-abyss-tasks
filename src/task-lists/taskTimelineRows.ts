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
  let tasks: Array<{ row: Extract<TaskListRow<T>, { kind: 'task' }>; planning: TaskPlanning }> = [];
  const flush = (): void => {
    if (tasks.length === 0) return;
    if (group !== undefined)
      result.push({ ...group, count: tasks.length, first: result.length === 0 });
    if (settings.sortBy.field === 'date') {
      const direction = settings.sortBy.dir === 'asc' ? 1 : -1;
      tasks.sort((a, b) => {
        const left = timelineStart(a.planning);
        const right = timelineStart(b.planning);
        if (left === undefined) return right === undefined ? 0 : 1;
        if (right === undefined) return -1;
        const startOrder = left.localeCompare(right);
        const endOrder = (a.planning.due ?? left).localeCompare(b.planning.due ?? right);
        return direction * (startOrder === 0 ? endOrder : startOrder);
      });
    }
    result.push(...tasks.map(({ row }) => row));
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
    tasks.push({ row, planning: value.planning });
  }
  flush();
  return indexedRows(result);
}
function hasDate(planning: TaskPlanning): boolean {
  return (
    planning.start !== undefined || planning.due !== undefined || planning.scheduled !== undefined
  );
}

/** Lone endpoints and Scheduled-only tasks remain positioned by their visible date. */
function timelineStart(planning: TaskPlanning): string | undefined {
  return planning.start ?? planning.due ?? planning.scheduled;
}
