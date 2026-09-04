import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskSnapshot, TaskStatusType } from '../tasks';
import { calendarOccurrenceForRender, type CalendarOccurrence } from './calendarOccurrences';

export interface TaskGroup {
  due: TaskSnapshot[];
  recurrence: TaskSnapshot[];
  overdue: TaskSnapshot[];
  start: TaskSnapshot[];
  scheduled: TaskSnapshot[];
  inProcess: TaskSnapshot[];
  dailyNote: TaskSnapshot[];
  allDone: TaskSnapshot[];
  cancelled: TaskSnapshot[];
}

function isSameDay(value: string | undefined, date: string): boolean {
  return value !== undefined && value.length > 0 && window.moment(value).isSame(date, 'day');
}

function isBeforeDay(value: string | undefined, date: string): boolean {
  return value !== undefined && value.length > 0 && window.moment(value).isBefore(date, 'day');
}

function isAfterDay(value: string | undefined, date: string): boolean {
  return value !== undefined && value.length > 0 && window.moment(value).isAfter(date, 'day');
}

function isOpen(task: TaskSnapshot): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

export function getTasksForDate(tasks: TaskSnapshot[], date: string, today: string): TaskGroup {
  return {
    allDone: tasks.filter(
      (task) =>
        task.status === 'done' &&
        (isSameDay(task.planning.due, date) ||
          (task.planning.due === undefined && isSameDay(task.planning.completion, date))),
    ),
    due: tasks.filter(
      (task) => isOpen(task) && task.recurrence === undefined && isSameDay(task.planning.due, date),
    ),
    recurrence: tasks.filter(
      (task) => isOpen(task) && task.recurrence !== undefined && isSameDay(task.planning.due, date),
    ),
    overdue: tasks.filter(
      (task) =>
        isOpen(task) &&
        calendarOccurrenceForRender(task).kind === 'materialized' &&
        isBeforeDay(task.planning.due, today),
    ),
    start: tasks.filter(
      (task) =>
        isOpen(task) && isSameDay(task.planning.start, date) && !isSameDay(task.planning.due, date),
    ),
    scheduled: tasks.filter((task) => isOpen(task) && isSameDay(task.planning.scheduled, date)),
    inProcess: tasks.filter(
      (task) =>
        isOpen(task) &&
        isAfterDay(task.planning.due, date) &&
        isBeforeDay(task.planning.start, today),
    ),
    dailyNote: tasks.filter(
      (task) => isOpen(task) && isSameDay(task.presentation.dailyNoteDate, date),
    ),
    cancelled: tasks.filter(
      (task) => task.status === 'cancelled' && isSameDay(task.planning.due, date),
    ),
  };
}

function compareTaskDateTime(left: TaskSnapshot, right: TaskSnapshot): number {
  const leftDate = left.planning.due ?? left.planning.scheduled ?? left.planning.start ?? '';
  const rightDate = right.planning.due ?? right.planning.scheduled ?? right.planning.start ?? '';
  const dateComparison = compareNullableLast(leftDate, rightDate);
  if (dateComparison !== 0) return dateComparison;
  return compareNullableLast(left.planning.time ?? '', right.planning.time ?? '');
}

export function sortTasksByDateTime(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return [...tasks].sort(compareTaskDateTime);
}

function compareTaskPriorityTime(left: TaskSnapshot, right: TaskSnapshot): number {
  const priorityComparison = compareStrings(left.priority, right.priority);
  if (priorityComparison !== 0) return priorityComparison;
  const timeComparison = compareNullableLast(left.planning.time ?? '', right.planning.time ?? '');
  return timeComparison !== 0 ? timeComparison : left.title.localeCompare(right.title);
}

export function sortTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return [...tasks].sort(compareTaskPriorityTime);
}

const PRIORITY_LABELS: Record<string, string> = {
  A: '🔺 Highest',
  B: '⏫ High',
  C: '🔼 Medium',
  D: 'Normal',
  E: '🔽 Low',
  F: '⏬ Lowest',
};

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNullableLast(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  return compareStrings(a, b);
}

function compareByDate(a: TaskSnapshot, b: TaskSnapshot): number {
  const da = a.planning.due ?? a.planning.scheduled ?? a.planning.start ?? '';
  const db = b.planning.due ?? b.planning.scheduled ?? b.planning.start ?? '';
  const dateCmp = compareNullableLast(da, db);
  if (dateCmp !== 0) return dateCmp;
  const ta = a.planning.time ?? '';
  const tb = b.planning.time ?? '';
  return compareNullableLast(ta, tb);
}

function compareByTag(a: TaskSnapshot, b: TaskSnapshot): number {
  const ta = a.tags[0] ?? '';
  const tb = b.tags[0] ?? '';
  if (ta.length === 0 && tb.length === 0) return 0;
  if (ta.length === 0) return 1;
  if (tb.length === 0) return -1;
  return ta.localeCompare(tb);
}

function appendToBucket(
  buckets: Map<string, TaskSnapshot[]>,
  key: string,
  task: TaskSnapshot,
): void {
  const existing = buckets.get(key);
  if (existing === undefined) buckets.set(key, [task]);
  else existing.push(task);
}

export function compareByStatus(
  a: TaskSnapshot,
  b: TaskSnapshot,
  registry: StatusRegistry,
): number {
  return registry.orderIndex(a.statusSymbol) - registry.orderIndex(b.statusSymbol);
}

export function sortTasksByField(
  tasks: TaskSnapshot[],
  field: 'date' | 'priority' | 'title' | 'tag' | 'status',
  dir: 'asc' | 'desc',
  registry?: StatusRegistry,
): TaskSnapshot[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    let cmp: number;
    if (field === 'date') {
      cmp = compareByDate(a, b);
    } else if (field === 'priority') {
      cmp = compareStrings(a.priority, b.priority);
    } else if (field === 'title') {
      cmp = a.title.localeCompare(b.title);
    } else if (field === 'status' && registry != null) {
      cmp = compareByStatus(a, b, registry);
    } else {
      cmp = compareByTag(a, b);
    }
    return cmp * sign;
  });
}

export function groupTasksByPriority(
  tasks: TaskSnapshot[],
): Array<{ label: string; tasks: TaskSnapshot[] }> {
  const PRIORITY_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
  const map = new Map<string, TaskSnapshot[]>();
  for (const t of tasks) {
    appendToBucket(map, t.priority, t);
  }
  return PRIORITY_ORDER.flatMap((priority) => {
    const bucket = map.get(priority);
    return bucket === undefined
      ? []
      : [{ label: PRIORITY_LABELS[priority] ?? priority, tasks: bucket }];
  });
}

export function groupTasksByStatus(
  tasks: TaskSnapshot[],
  registry: StatusRegistry,
): Array<{ label: string; tasks: TaskSnapshot[] }> {
  const buckets = new Map<string, { order: number; label: string; tasks: TaskSnapshot[] }>();
  for (const t of tasks) {
    const def = registry.bySymbol(t.statusSymbol);
    const key = def?.id ?? '__other__';
    const label = def?.name ?? 'Other';
    const order = def != null ? registry.orderIndex(t.statusSymbol) : Number.MAX_SAFE_INTEGER;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, { order, label, tasks: [t] });
    else bucket.tasks.push(t);
  }
  return [...buckets.values()]
    .sort((x, y) => x.order - y.order)
    .map(({ label, tasks }) => ({ label, tasks }));
}

export function groupTasksByTag(
  tasks: TaskSnapshot[],
): Array<{ label: string; tasks: TaskSnapshot[] }> {
  const map = new Map<string, TaskSnapshot[]>();
  for (const t of tasks) {
    const tag = t.tags[0] ?? '';
    const key = tag.length > 0 ? tag : 'No tag';
    appendToBucket(map, key, t);
  }
  const groups: Array<{ label: string; tasks: TaskSnapshot[] }> = [];
  for (const [label, gtasks] of map) {
    if (label !== 'No tag') groups.push({ label, tasks: gtasks });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  const noTag = map.get('No tag');
  if (noTag !== undefined) groups.push({ label: 'No tag', tasks: noTag });
  return groups;
}

type DateGroupLabel = 'Overdue' | 'Today' | 'Tomorrow' | 'Upcoming' | 'No date';

function dateGroupLabel(task: TaskSnapshot, today: string, tomorrow: string): DateGroupLabel {
  const date = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
  if (date === undefined) return 'No date';
  if (date < today) return 'Overdue';
  if (date === today) return 'Today';
  return date === tomorrow ? 'Tomorrow' : 'Upcoming';
}

export function groupTasksByDate(
  tasks: TaskSnapshot[],
  today: string,
  tomorrow: string,
): Array<{ label: string; tasks: TaskSnapshot[] }> {
  const buckets = new Map<DateGroupLabel, TaskSnapshot[]>();
  for (const task of tasks) appendToBucket(buckets, dateGroupLabel(task, today, tomorrow), task);
  const order: readonly DateGroupLabel[] = ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'No date'];
  return order.flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket === undefined ? [] : [{ label, tasks: bucket }];
  });
}

export function renderTaskGroup(
  container: HTMLElement,
  groups: TaskGroup,
  ...context: [
    date: string,
    today: string,
    renderCard: (task: TaskSnapshot, cls: string, occurrence: CalendarOccurrence) => HTMLElement,
  ]
): void {
  const [date, today, renderCard] = context;
  const show = (group: TaskSnapshot[], cls: string): void => {
    for (const t of sortTasks(group)) {
      container.appendChild(renderCard(t, cls, calendarOccurrenceForRender(t)));
    }
  };
  if (date === today) show(groups.overdue, 'overdue');
  show(groups.due, 'due');
  show(groups.recurrence, 'recurrence');
  show(groups.start, 'start');
  show(groups.scheduled, 'scheduled');
  show(groups.inProcess, 'process');
  show(groups.dailyNote, 'dailyNote');
  show(groups.allDone, 'done');
  show(groups.cancelled, 'cancelled');
}

// undefined, or all 4 status groups selected, means "no filtering".
// A real subset (1-3 groups) restricts tasks to those status groups.
export function filterTasksByStatusGroups(
  tasks: TaskSnapshot[],
  statusGroups: TaskStatusType[] | undefined,
  registry: StatusRegistry,
): TaskSnapshot[] {
  if (statusGroups == null || statusGroups.length === 0 || statusGroups.length >= 4) return tasks;
  const allowed = new Set(statusGroups);
  return tasks.filter((t) => {
    const type = registry.bySymbol(t.statusSymbol)?.type ?? 'todo';
    return allowed.has(type);
  });
}
