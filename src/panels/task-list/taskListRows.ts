import type { StatusRegistry } from '../../status/StatusRegistry';
import type { TaskLinkValues } from '../../task-lists/taskLinkValues';
import type { TaskSnapshot } from '../../tasks';
import { taskNodeLine, type TaskSelectionNode } from '../../ui/taskSelection';
import {
  groupTasksByDate,
  groupTasksByOutgoingLink,
  groupTasksByPriority,
  groupTasksBySourceNote,
  groupTasksByStatus,
  groupTasksByTag,
  type TaskGroup,
} from '../../views/taskGrouping';

/** How the centre list groups its rows. */
export type TaskListGrouping =
  | { readonly by: 'source-note' }
  | { readonly by: 'outgoing-link'; readonly values: TaskLinkValues }
  | { readonly by: 'none' }
  | { readonly by: 'priority' }
  | { readonly by: 'tag' }
  | { readonly by: 'date'; readonly today: string; readonly tomorrow: string }
  | { readonly by: 'status'; readonly statuses: StatusRegistry };

/** A group header: `Label  count` above its tasks, `first` on the list's first header. */
export interface TaskListGroupRow {
  readonly kind: 'group';
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly first: boolean;
}

/** One visual occurrence of a root task, with its separate physical source identity. */
export interface TaskListTaskRow {
  readonly kind: 'task';
  readonly key: string;
  readonly taskKey: string;
  readonly task: TaskSnapshot;
}

export type TaskListRow = TaskListGroupRow | TaskListTaskRow;

/** The rows of one render in display order, with lookups for the task rows among them. */
export interface TaskListRows {
  readonly rows: readonly TaskListRow[];
  /** The task occurrence keys in display order (the historic property name is retained). */
  readonly taskKeys: readonly string[];
  /** A task row's place in `taskKeys`; -1 for a header or an unknown key. */
  indexOf(key: string): number;
  occurrencesOf(taskKey: string): readonly string[];
  physicalKey(occurrenceKey: string): string | undefined;
  /** The snapshot a task row was built from; undefined for a header or an unknown key. */
  task(key: string): TaskSnapshot | undefined;
}

/** What a selection reads of the list: the task keys in display order and their places. */
export type TaskListOrder = Pick<TaskListRows, 'taskKeys' | 'indexOf'>;

/** A root task's physical key: its note and line, independent of visual occurrences. */
export function taskRowKey(task: TaskSnapshot): string {
  return `${task.source.filePath}:${task.source.line}`;
}

/** A proven source-line successor keeps the visual group of an existing occurrence. */
export function rebaseTaskRowKey(key: string, previous: string, next: string): string {
  if (key === previous) return next;
  const suffix = `,${JSON.stringify(previous)}]`;
  return key.startsWith('["task-occurrence","outgoing-link",') && key.endsWith(suffix)
    ? `${key.slice(0, -suffix.length)},${JSON.stringify(next)}]`
    : key;
}

/** The grouping for a stored `groupBy`; a value the list does not know groups by tag. */
export function taskListGrouping(
  groupBy: string,
  context: {
    readonly today: string;
    readonly tomorrow: string;
    readonly statuses: StatusRegistry;
    readonly outgoingLinks?: TaskLinkValues;
  },
): TaskListGrouping {
  if (groupBy === 'source-note') return { by: 'source-note' };
  if (groupBy === 'outgoing-link')
    return { by: 'outgoing-link', values: context.outgoingLinks ?? new Map() };
  if (groupBy === 'none') return { by: 'none' };
  if (groupBy === 'date') return { by: 'date', today: context.today, tomorrow: context.tomorrow };
  if (groupBy === 'priority') return { by: 'priority' };
  if (groupBy === 'status') return { by: 'status', statuses: context.statuses };
  return { by: 'tag' };
}

function taskRow(task: TaskSnapshot, key = taskRowKey(task)): TaskListTaskRow {
  return { kind: 'task', key, taskKey: taskRowKey(task), task };
}

function taskGroups(
  tasks: readonly TaskSnapshot[],
  grouping: Exclude<TaskListGrouping, { readonly by: 'none' }>,
): readonly TaskGroup[] {
  switch (grouping.by) {
    case 'source-note':
      return groupTasksBySourceNote(tasks);
    case 'outgoing-link':
      return groupTasksByOutgoingLink(tasks, grouping.values);
    case 'date':
      return groupTasksByDate(tasks, grouping.today, grouping.tomorrow);
    case 'priority':
      return groupTasksByPriority(tasks);
    case 'status':
      return groupTasksByStatus(tasks, grouping.statuses);
    case 'tag':
      return groupTasksByTag(tasks);
  }
}

function groupedRows(
  tasks: readonly TaskSnapshot[],
  grouping: Exclude<TaskListGrouping, { readonly by: 'none' }>,
): TaskListRow[] {
  const rows: TaskListRow[] = [];
  for (const group of taskGroups(tasks, grouping)) {
    if (group.tasks.length === 0) continue;
    rows.push({
      kind: 'group',
      key: `group:${grouping.by}:${group.key}`,
      label: group.label,
      count: group.tasks.length,
      first: rows.length === 0,
    });
    for (const task of group.tasks)
      rows.push(
        taskRow(
          task,
          grouping.by === 'outgoing-link'
            ? JSON.stringify(['task-occurrence', 'outgoing-link', group.key, taskRowKey(task)])
            : taskRowKey(task),
        ),
      );
  }
  return rows;
}

function indexedRows(rows: readonly TaskListRow[]): TaskListRows {
  const taskKeys: string[] = [];
  const places = new Map<string, number>();
  const occurrences = new Map<string, string[]>();
  const physical = new Map<string, string>();
  const snapshots = new Map<string, TaskSnapshot>();
  for (const row of rows) {
    if (row.kind !== 'task') continue;
    if (!places.has(row.key)) {
      places.set(row.key, taskKeys.length);
      snapshots.set(row.key, row.task);
    }
    taskKeys.push(row.key);
    physical.set(row.key, row.taskKey);
    const keys = occurrences.get(row.taskKey) ?? [];
    keys.push(row.key);
    occurrences.set(row.taskKey, keys);
  }
  return {
    rows,
    taskKeys,
    indexOf: (key) => places.get(key) ?? -1,
    task: (key) => snapshots.get(key),
    occurrencesOf: (key) => occurrences.get(key) ?? [],
    physicalKey: (key) => physical.get(key),
  };
}

/**
 * The list's rows for the selected, sorted root tasks: one row per task in input order, or per
 * non-empty group a header followed by its tasks in input order.
 */
export function buildTaskListRows(
  tasks: readonly TaskSnapshot[],
  grouping: TaskListGrouping,
): TaskListRows {
  return indexedRows(
    grouping.by === 'none' ? tasks.map((task) => taskRow(task)) : groupedRows(tasks, grouping),
  );
}

/** The row key of the node open in the detail pane: its root's note and the node's own line. */
export function taskStackRowKey(stack: readonly TaskSelectionNode[]): string | undefined {
  const root = stack[0];
  const current = stack[stack.length - 1];
  if (root === undefined || current === undefined || !('source' in root)) return undefined;
  return `${root.source.filePath}:${taskNodeLine(root, current)}`;
}

/** The order of a surface that has no list: no rows, so no ranges, arrows, or bulk menu. */
export const NO_TASK_LIST_ROWS: TaskListRows = indexedRows([]);
