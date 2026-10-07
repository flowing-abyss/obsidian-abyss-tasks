import type { StatusRegistry } from '../../status/StatusRegistry';
import type { TaskLinkValues } from '../../task-lists/taskLinkValues';
import { taskNodeMembershipValue } from '../../task-lists/taskNodeMembership';
import type { TaskOccurrencePresentation } from '../../task-lists/taskOccurrencePresentation';
import { type TaskNodeSnapshot, type TaskSnapshot } from '../../tasks';
import { taskNodeLine, type TaskSelectionNode } from '../../ui/taskSelection';
import {
  groupTasksByDate,
  groupTasksByOutgoingLink,
  groupTasksByPriority,
  groupTasksBySourceNote,
  groupTasksByStatus,
  groupTasksByTag,
  type TaskGroup,
  type TaskGroupValue,
} from '../../views/taskGrouping';
import type { RowAnchorKeyRange, RowViewportSource } from '../virtualization/rowViewport';
import type {
  TaskOccurrenceRange,
  TaskSelectedValue,
  TaskSelectionSpans,
} from './taskOccurrenceSelection';

/** How the centre list groups its rows. */
export type TaskListGrouping =
  | { readonly by: 'source-note' }
  | { readonly by: 'outgoing-link'; readonly values: TaskLinkValues }
  | { readonly by: 'none' }
  | { readonly by: 'priority' }
  | { readonly by: 'tag' }
  | {
      readonly by: 'date';
      readonly today: string;
      readonly tomorrow: string;
      readonly todayList?: boolean;
    }
  | { readonly by: 'status'; readonly statuses: StatusRegistry };

/** A group header: `Label  count` above its tasks, `first` on the list's first header. */
export interface TaskListGroupRow {
  readonly kind: 'group';
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly first: boolean;
  readonly sourcePath?: string;
}

/** One visual occurrence of a task node, with its separate physical source identity. */
export interface TaskListTaskRow<T = TaskSnapshot> {
  readonly kind: 'task';
  readonly key: string;
  readonly taskKey: string;
  readonly task: T;
  readonly presentation?: TaskOccurrencePresentation;
}

export type TaskListRow<T = TaskSnapshot> = TaskListGroupRow | TaskListTaskRow<T>;

/** The rows of one render in display order, with lookups for the task rows among them. */
export interface TaskListRows<T = TaskSnapshot> {
  readonly revision: string;
  readonly rowCount: number;
  readonly taskCount: number;
  anchorRanges(): readonly RowAnchorKeyRange[];
  survivingNeighbor(
    previousIndex: number,
    direction: 1 | -1,
    current: RowViewportSource,
  ): string | undefined;
  rowAt(index: number): TaskListRow<T> | undefined;
  rowIndexOf(key: string): number;
  taskKeyAt(index: number): string | undefined;
  indexOf(key: string): number;
  firstOccurrenceOf(taskKey: string): string | undefined;
  physicalKey(occurrenceKey: string): string | undefined;
  task(key: string): T | undefined;
  slice(from: number, toExclusive: number): Iterable<TaskListRow<T>>;
  captureSelection(selection: TaskSelectionSpans): readonly TaskOccurrenceRange[];
  selectedCount(ranges: readonly TaskOccurrenceRange[]): number;
  isSelected(key: string, ranges: readonly TaskOccurrenceRange[]): boolean;
  selectedNodes(ranges: readonly TaskOccurrenceRange[]): ReadonlyArray<TaskSelectedValue<T>>;
  estimatedOffset(
    index: number,
    heights: { readonly group: number; readonly task: number },
  ): number;
}

/** Indexed access to the complete header-free occurrence order. */
export type TaskListOrder = Pick<TaskListRows, 'revision' | 'taskCount' | 'taskKeyAt' | 'indexOf'>;

/** A root task's physical key: its note and line, independent of visual occurrences. */
export function taskRowKey(task: Pick<TaskGroupValue, 'source'>): string {
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
    readonly todayList?: boolean;
    readonly statuses: StatusRegistry;
    readonly outgoingLinks?: TaskLinkValues;
  },
): TaskListGrouping {
  if (groupBy === 'source-note') return { by: 'source-note' };
  if (groupBy === 'outgoing-link')
    return { by: 'outgoing-link', values: context.outgoingLinks ?? new Map() };
  if (groupBy === 'none') return { by: 'none' };
  if (groupBy === 'date')
    return {
      by: 'date',
      today: context.today,
      tomorrow: context.tomorrow,
      ...(context.todayList === undefined ? {} : { todayList: context.todayList }),
    };
  if (groupBy === 'priority') return { by: 'priority' };
  if (groupBy === 'status') return { by: 'status', statuses: context.statuses };
  return { by: 'tag' };
}

function taskRow<T extends TaskGroupValue>(task: T, key = taskRowKey(task)): TaskListTaskRow<T> {
  return { kind: 'task', key, taskKey: taskRowKey(task), task };
}

function taskGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  grouping: Exclude<TaskListGrouping, { readonly by: 'none' }>,
): ReadonlyArray<TaskGroup<T>> {
  switch (grouping.by) {
    case 'source-note':
      return groupTasksBySourceNote(tasks);
    case 'outgoing-link':
      return groupTasksByOutgoingLink(tasks, grouping.values);
    case 'date':
      return groupTasksByDate(tasks, grouping.today, grouping.tomorrow, grouping.todayList);
    case 'priority':
      return groupTasksByPriority(tasks);
    case 'status':
      return groupTasksByStatus(tasks, grouping.statuses);
    case 'tag':
      return groupTasksByTag(tasks);
  }
}

function groupedRows<T extends TaskGroupValue>(
  tasks: readonly T[],
  grouping: Exclude<TaskListGrouping, { readonly by: 'none' }>,
): Array<TaskListRow<T>> {
  const rows: Array<TaskListRow<T>> = [];
  for (const group of taskGroups(tasks, grouping)) {
    if (group.tasks.length === 0) continue;
    rows.push({
      kind: 'group',
      key: `group:${grouping.by}:${group.key}`,
      label: group.label,
      ...(grouping.by === 'source-note' && { sourcePath: group.key }),
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

let nextRowsRevision = 0;

function occurrenceRange<T>(row: TaskListTaskRow<T>, groupKey: string): TaskOccurrenceRange {
  const presentation = row.presentation;
  if (
    presentation !== undefined &&
    presentation.kind !== 'node' &&
    presentation.displayDate !== undefined
  )
    return {
      kind: 'dates',
      taskKey: row.taskKey,
      occurrenceKind: presentation.kind,
      groupKey: presentation.kind === 'daily' ? 'upcoming-date' : groupKey,
      from: presentation.displayDate,
      to: presentation.displayDate,
    };
  return { kind: 'group', taskKey: row.taskKey, groupKey };
}

function includesOccurrence(
  occurrence: TaskOccurrenceRange,
  ranges: readonly TaskOccurrenceRange[],
): boolean {
  return ranges.some(
    (range) =>
      range.taskKey === occurrence.taskKey &&
      range.groupKey === occurrence.groupKey &&
      (range.kind === 'group'
        ? occurrence.kind === 'group'
        : occurrence.kind === 'dates' &&
          range.occurrenceKind === occurrence.occurrenceKind &&
          range.from <= occurrence.from &&
          range.to >= occurrence.to),
  );
}

function captureArraySelection<T>(
  tasks: ReadonlyArray<TaskListTaskRow<T>>,
  occurrences: ReadonlyMap<string, TaskOccurrenceRange>,
  selection: TaskSelectionSpans,
): readonly TaskOccurrenceRange[] {
  const keys = new Set(selection.include);
  for (const span of selection.spans) {
    if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to)) continue;
    for (
      let index = Math.max(0, span.from);
      index <= Math.min(tasks.length - 1, span.to);
      index++
    ) {
      const row = tasks[index];
      if (row !== undefined) keys.add(row.key);
    }
  }
  for (const key of selection.exclude) keys.delete(key);
  return tasks.flatMap((row) => {
    const occurrence = occurrences.get(row.key);
    return keys.has(row.key) && occurrence !== undefined ? [occurrence] : [];
  });
}

function selectedArrayRows<T>(
  tasks: ReadonlyArray<TaskListTaskRow<T>>,
  occurrences: ReadonlyMap<string, TaskOccurrenceRange>,
  ranges: readonly TaskOccurrenceRange[],
): Array<TaskListTaskRow<T>> {
  const byTask = new Map<string, TaskOccurrenceRange[]>();
  for (const range of ranges) {
    const entries = byTask.get(range.taskKey) ?? [];
    entries.push(range);
    byTask.set(range.taskKey, entries);
  }
  return tasks.filter((row) => {
    const occurrence = occurrences.get(row.key);
    return (
      occurrence !== undefined && includesOccurrence(occurrence, byTask.get(row.taskKey) ?? [])
    );
  });
}

function arrayAnchorOrder(
  keys: readonly string[],
): Pick<TaskListRows, 'anchorRanges' | 'survivingNeighbor'> {
  return {
    anchorRanges: () => keys.map((key) => ({ kind: 'key', key })),
    survivingNeighbor(previousIndex, direction, current) {
      for (
        let index = previousIndex + direction;
        index >= 0 && index < keys.length;
        index += direction
      ) {
        const key = keys[index];
        if (key !== undefined && current.indexOf(key) >= 0) return key;
      }
      return undefined;
    },
  };
}

/** Finite array adapter. Never expand authored date intervals to feed this adapter. */
export function indexedRows<T>(
  rows: ReadonlyArray<TaskListRow<T>>,
  revision = `array:${++nextRowsRevision}`,
): TaskListRows<T> {
  const tasks: Array<TaskListTaskRow<T>> = [];
  const places = new Map<string, number>();
  const rowPlaces = new Map<string, number>();
  const first = new Map<string, string>();
  const occurrences = new Map<string, TaskOccurrenceRange>();
  const headersBefore: number[] = [0];
  let groupKey = '';
  for (const [index, row] of rows.entries()) {
    rowPlaces.set(row.key, index);
    headersBefore.push((headersBefore[index] ?? 0) + (row.kind === 'group' ? 1 : 0));
    if (row.kind === 'group') {
      groupKey = row.key;
      continue;
    }
    if (!places.has(row.key)) places.set(row.key, tasks.length);
    if (!first.has(row.taskKey)) first.set(row.taskKey, row.key);
    tasks.push(row);
    occurrences.set(row.key, occurrenceRange(row, groupKey));
  }
  const taskRowAt = (key: string): TaskListTaskRow<T> | undefined => {
    const index = places.get(key);
    return index === undefined ? undefined : tasks[index];
  };

  return {
    ...arrayAnchorOrder(rows.map(({ key }) => key)),
    revision,
    rowCount: rows.length,
    taskCount: tasks.length,
    rowAt: (index) => (Number.isSafeInteger(index) ? rows[index] : undefined),
    rowIndexOf: (key) => rowPlaces.get(key) ?? -1,
    taskKeyAt: (index) => (Number.isSafeInteger(index) ? tasks[index]?.key : undefined),
    indexOf: (key) => places.get(key) ?? -1,
    task: (key) => taskRowAt(key)?.task,
    firstOccurrenceOf: (key) => first.get(key),
    physicalKey: (key) => taskRowAt(key)?.taskKey,
    *slice(from, toExclusive) {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(toExclusive)) return;
      for (let index = Math.max(0, from); index < Math.min(rows.length, toExclusive); index++) {
        const row = rows[index];
        if (row !== undefined) yield row;
      }
    },
    captureSelection: (selection) => captureArraySelection(tasks, occurrences, selection),
    selectedCount: (ranges) => selectedArrayRows(tasks, occurrences, ranges).length,
    isSelected: (key, ranges) => {
      const occurrence = occurrences.get(key);
      return occurrence !== undefined && includesOccurrence(occurrence, ranges);
    },
    selectedNodes: (ranges) => {
      const nodes = new Map<string, TaskSelectedValue<T>>();
      for (const row of selectedArrayRows(tasks, occurrences, ranges)) {
        const prior = nodes.get(row.taskKey);
        const completion = row.presentation?.completion ?? { kind: 'allowed' as const };
        if (prior === undefined)
          nodes.set(row.taskKey, { taskKey: row.taskKey, task: row.task, completion });
        else if (prior.completion.kind !== 'allowed' && completion.kind === 'allowed')
          nodes.set(row.taskKey, { ...prior, completion });
      }
      return [...nodes.values()];
    },
    estimatedOffset: (index, heights) => {
      if (!Number.isSafeInteger(index)) return 0;
      const end = Math.max(0, Math.min(rows.length, index));
      const groups = headersBefore[end] ?? 0;
      return groups * heights.group + (end - groups) * heights.task;
    },
  };
}

/**
 * The list's rows for the selected, sorted root tasks: one row per task in input order, or per
 * non-empty group a header followed by its tasks in input order.
 */
export function buildTaskListRows<T extends TaskGroupValue>(
  tasks: readonly T[],
  grouping: TaskListGrouping,
): TaskListRows<T> {
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
export const NO_TASK_LIST_ROWS: TaskListRows<never> = indexedRows([]);

/** Group own node metadata while retaining canonical root authority in each row. */
export function buildTaskNodeListRows(
  tasks: readonly TaskNodeSnapshot[],
  grouping: TaskListGrouping,
): TaskListRows<TaskNodeSnapshot> {
  const values = tasks.map((projection) => ({
    ...projection.node,
    ...taskNodeMembershipValue(projection),
    projection,
  }));
  const rows = buildTaskListRows(values, grouping);
  return indexedRows(
    Array.from(rows.slice(0, rows.rowCount), (row) =>
      row.kind === 'group' ? row : { ...row, task: row.task.projection },
    ),
  );
}
