import {
  indexedRows,
  type TaskListGroupRow,
  type TaskListRow,
  type TaskListRows,
} from '../panels/task-list/taskListRows';
import type { TaskStatusDef } from '../settings/types';
import type { TaskPlanning } from '../tasks';
import type { TaskTimelineSettings } from './taskTimelineSettings';

interface TimelineValue {
  readonly statusSymbol: string;
  readonly planning: TaskPlanning;
  readonly source?: { readonly filePath: string; readonly line: number };
}
function sourceOrder(a: TimelineValue, b: TimelineValue): number {
  if (a.source === undefined || b.source === undefined) return 0;
  const path = a.source.filePath.localeCompare(b.source.filePath);
  return path === 0 ? a.source.line - b.source.line : path;
}

/** Filter finite collection rows while retaining their canonical task occurrence identity. */
export function buildTaskTimelineRows<T>(
  rows: TaskListRows<T>,
  settings: TaskTimelineSettings,
  statuses: readonly TaskStatusDef[],
  read: (task: T) => TimelineValue,
): TaskListRows<T> {
  const hidden = new Set(
    statuses.filter((s) => settings.hiddenStatuses.includes(s.id)).map((s) => s.symbol),
  );
  const result: Array<TaskListRow<T>> = [];
  let group: TaskListGroupRow | undefined;
  let tasks: Array<{ row: Extract<TaskListRow<T>, { kind: 'task' }>; value: TimelineValue }> = [];
  const flush = (): void => {
    if (tasks.length === 0) return;
    if (group !== undefined)
      result.push({ ...group, count: tasks.length, first: result.length === 0 });
    if (settings.sortBy.field === 'date') {
      const direction = settings.sortBy.dir === 'asc' ? 1 : -1;
      tasks.sort((a, b) => {
        const left = timelineStart(a.value.planning);
        const right = timelineStart(b.value.planning);
        if (left === undefined) return right === undefined ? sourceOrder(a.value, b.value) : 1;
        if (right === undefined) return -1;
        const startOrder = left.localeCompare(right);
        const endOrder = (a.value.planning.due ?? left).localeCompare(
          b.value.planning.due ?? right,
        );
        const dates = startOrder === 0 ? endOrder : startOrder;
        return dates === 0 ? sourceOrder(a.value, b.value) : direction * dates;
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
    tasks.push({ row, value });
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
