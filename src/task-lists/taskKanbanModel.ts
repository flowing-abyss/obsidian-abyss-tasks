import {
  indexedRows,
  type TaskListRow,
  type TaskListRows,
  type TaskListTaskRow,
} from '../panels/task-list/taskListRows';
import { PRIORITY_LEVELS } from '../priority';
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
function columnRows<T>(
  key: string,
  tasks: ReadonlyArray<TaskListTaskRow<T>>,
  settings: TaskKanbanSettings,
  metadata: (task: T) => TaskKanbanMetadata,
): TaskListRows<T> {
  if (settings.groupBy === 'none') return indexedRows(tasks);
  const groups = new Map<TaskPriority, Array<TaskListTaskRow<T>>>();
  for (const row of tasks) {
    const priority = metadata(row.task).priority;
    const group = groups.get(priority) ?? [];
    group.push(row);
    groups.set(priority, group);
  }
  const rows: Array<TaskListRow<T>> = [];
  for (const level of PRIORITY_LEVELS) {
    const group = groups.get(level.value);
    if (group === undefined) continue;
    rows.push(
      {
        kind: 'group',
        key: `kanban-group:${key}:${level.value}`,
        label: level.value === 'D' ? 'Normal' : level.label,
        count: group.length,
        first: rows.length === 0,
      },
      ...group,
    );
  }
  return indexedRows(rows);
}
function columnBuckets<T>(
  rows: TaskListRows<T>,
  statuses: readonly TaskStatusDef[],
  hidden: ReadonlySet<string>,
  metadata: (task: T) => TaskKanbanMetadata,
): { buckets: Map<string, Array<TaskListTaskRow<T>>>; unknown: Map<string, string> } {
  const catalog = new Map(statuses.map((status) => [status.symbol, status]));
  const buckets = new Map<string, Array<TaskListTaskRow<T>>>();
  const unknown = new Map<string, string>();
  const seen = new Set<string>();

  for (const row of rows.slice(0, rows.rowCount)) {
    if (row.kind !== 'task' || seen.has(row.taskKey)) continue;
    seen.add(row.taskKey);
    const symbol = metadata(row.task).statusSymbol;
    const status = catalog.get(symbol);
    if (status !== undefined && hidden.has(status.id)) continue;
    const key = status === undefined ? `unknown:${symbol}` : `status:${status.id}`;
    if (status === undefined) unknown.set(key, symbol);
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
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
        rows: columnRows(key, buckets.get(key) ?? [], settings, metadata),
      };
    });
  for (const [key, symbol] of unknown) {
    columns.push({
      key,
      label: `Unknown [${symbol}]`,
      rows: columnRows(key, buckets.get(key) ?? [], settings, metadata),
    });
  }
  return {
    columns,
    rows: indexedRows(columns.flatMap((column) => [...column.rows.slice(0, column.rows.rowCount)])),
  };
}
