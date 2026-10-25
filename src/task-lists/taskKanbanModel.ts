import {
  indexedRows,
  type TaskListGroupRow,
  type TaskListRow,
  type TaskListRows,
  type TaskListTaskRow,
} from '../panels/task-list/taskListRows';
import type { TaskStatusDef } from '../settings/types';
import type { TaskPriority } from '../tasks';
import type { TaskKanbanSettings } from './taskKanbanSettings';

export interface TaskKanbanColumn<T> {
  readonly key: string;
  readonly label: string;
  readonly status?: TaskStatusDef;
  readonly rows: TaskListRows<T>;
}
export interface TaskKanbanModel<T> {
  readonly rows: TaskListRows<T>;
  readonly columns: ReadonlyArray<TaskKanbanColumn<T>>;
}
export interface TaskKanbanMetadata {
  readonly statusSymbol: string;
  readonly priority: TaskPriority;
}
interface GroupedTask<T> {
  readonly row: TaskListTaskRow<T>;
  readonly group: TaskListGroupRow | undefined;
}
function columnRows<T>(
  key: string,
  tasks: ReadonlyArray<GroupedTask<T>>,
  settings: TaskKanbanSettings,
): TaskListRows<T> {
  if (settings.groupBy === 'none') return indexedRows(tasks.map((entry) => entry.row));
  const rows: Array<TaskListRow<T>> = [];
  let headerIndex = -1;
  let currentGroup: TaskListGroupRow | undefined;
  for (const { row, group } of tasks) {
    if (group !== undefined && group !== currentGroup) {
      currentGroup = group;
      headerIndex = rows.length;
      rows.push({
        ...group,
        key: `kanban-group:${key}:${group.key}`,
        count: 0,
        first: headerIndex === 0,
      });
    }
    const header = rows[headerIndex];
    if (header?.kind === 'group') rows[headerIndex] = { ...header, count: header.count + 1 };
    rows.push(row);
  }
  return indexedRows(rows);
}
function* groupedTasks<T>(rows: TaskListRows<T>): Iterable<GroupedTask<T>> {
  let group: TaskListGroupRow | undefined;
  const seen = new Set<string>();
  for (const row of rows.slice(0, rows.rowCount)) {
    if (row.kind === 'group') group = row;
    else if (!seen.has(row.taskKey)) {
      seen.add(row.taskKey);
      yield { row, group };
    }
  }
}
function columnBuckets<T>(
  rows: TaskListRows<T>,
  statuses: readonly TaskStatusDef[],
  hidden: ReadonlySet<string>,
  metadata: (task: T) => TaskKanbanMetadata,
): { buckets: Map<string, Array<GroupedTask<T>>>; unknown: Map<string, string> } {
  const catalog = new Map(statuses.map((status) => [status.symbol, status]));
  const buckets = new Map<string, Array<GroupedTask<T>>>();
  const unknown = new Map<string, string>();
  for (const { row, group } of groupedTasks(rows)) {
    const symbol = metadata(row.task).statusSymbol;
    const status = catalog.get(symbol);
    if (status !== undefined && hidden.has(status.id)) continue;
    const key = status === undefined ? `unknown:${symbol}` : `status:${status.id}`;
    if (status === undefined) unknown.set(key, symbol);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ row, group });
    buckets.set(key, bucket);
  }
  return { buckets, unknown };
}

/** Input order already follows the task selector. Column grouping never creates task identities. */
export function buildTaskKanbanModel<T>(
  rows: TaskListRows<T>,
  statuses: readonly TaskStatusDef[],
  settings: TaskKanbanSettings,
  metadata: (task: T) => TaskKanbanMetadata,
): TaskKanbanModel<T> {
  const hidden = new Set(settings.hiddenStatuses);
  const { buckets, unknown } = columnBuckets(rows, statuses, hidden, metadata);
  const columns: Array<TaskKanbanColumn<T>> = statuses
    .filter((status) => !hidden.has(status.id))
    .map((status) => {
      const key = `status:${status.id}`;
      return {
        key,
        label: status.name,
        status,
        rows: columnRows(key, buckets.get(key) ?? [], settings),
      };
    });
  for (const [key, symbol] of unknown) {
    columns.push({
      key,
      label: `Unknown [${symbol}]`,
      rows: columnRows(key, buckets.get(key) ?? [], settings),
    });
  }
  return {
    columns,
    rows: indexedRows(columns.flatMap((column) => [...column.rows.slice(0, column.rows.rowCount)])),
  };
}
