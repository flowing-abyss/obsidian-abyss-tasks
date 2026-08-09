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

export function getTasksForDate(tasks: TaskSnapshot[], date: string, today: string): TaskGroup {
  const isSame = (d?: string) => (d ? window.moment(d).isSame(date, 'day') : false);
  const isBefore = (d?: string) => (d ? window.moment(d).isBefore(today, 'day') : false);
  const isAfter = (d?: string) => (d ? window.moment(d).isAfter(date, 'day') : false);
  const open = (t: TaskSnapshot) => t.status !== 'done' && t.status !== 'cancelled';

  return {
    allDone: tasks.filter(
      (t) =>
        t.status === 'done' &&
        (isSame(t.planning.due) || (!t.planning.due && isSame(t.planning.completion))),
    ),
    due: tasks.filter((t) => open(t) && !t.recurrence && isSame(t.planning.due)),
    recurrence: tasks.filter((t) => open(t) && t.recurrence && isSame(t.planning.due)),
    overdue: tasks.filter(
      (t) =>
        open(t) &&
        calendarOccurrenceForRender(t).kind === 'materialized' &&
        isBefore(t.planning.due),
    ),
    start: tasks.filter((t) => open(t) && isSame(t.planning.start) && !isSame(t.planning.due)),
    scheduled: tasks.filter((t) => open(t) && isSame(t.planning.scheduled)),
    inProcess: tasks.filter(
      (t) =>
        open(t) &&
        t.planning.due &&
        t.planning.start &&
        isAfter(t.planning.due) &&
        isBefore(t.planning.start),
    ),
    dailyNote: tasks.filter((t) => open(t) && isSame(t.presentation.dailyNoteDate)),
    cancelled: tasks.filter((t) => t.status === 'cancelled' && isSame(t.planning.due)),
  };
}

export function sortTasksByDateTime(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return [...tasks].sort((a, b) => {
    const da = a.planning.due ?? a.planning.scheduled ?? a.planning.start ?? '';
    const db = b.planning.due ?? b.planning.scheduled ?? b.planning.start ?? '';
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    }
    const ta = a.planning.time ?? '';
    const tb = b.planning.time ?? '';
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
}

export function sortTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return [...tasks].sort((a, b) => {
    // Priority first (A=Highest … F=Lowest, D=none — alphabetical order is correct)
    if (a.priority < b.priority) return -1;
    if (a.priority > b.priority) return 1;
    // Tasks with a specific time come before tasks without
    const aTime = a.planning.time ?? '';
    const bTime = b.planning.time ?? '';
    if (aTime && !bTime) return -1;
    if (!aTime && bTime) return 1;
    if (aTime && bTime && aTime !== bTime) return aTime < bTime ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
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
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
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
  const ta = a.tags?.[0] ?? '';
  const tb = b.tags?.[0] ?? '';
  if (!ta && !tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  return ta.localeCompare(tb);
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
    } else if (field === 'status' && registry) {
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
    const key = t.priority ?? 'D';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return PRIORITY_ORDER.filter((p) => map.has(p)).map((p) => ({
    label: PRIORITY_LABELS[p] ?? p,
    tasks: map.get(p)!,
  }));
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
    const order = def ? registry.orderIndex(t.statusSymbol) : Number.MAX_SAFE_INTEGER;
    if (!buckets.has(key)) buckets.set(key, { order, label, tasks: [] });
    buckets.get(key)!.tasks.push(t);
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
    const tag = t.tags?.[0] ?? '';
    const key = tag || 'No tag';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  const groups: Array<{ label: string; tasks: TaskSnapshot[] }> = [];
  for (const [label, gtasks] of map) {
    if (label !== 'No tag') groups.push({ label, tasks: gtasks });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (map.has('No tag')) groups.push({ label: 'No tag', tasks: map.get('No tag')! });
  return groups;
}

export function groupTasksByDate(
  tasks: TaskSnapshot[],
  today: string,
  tomorrow: string,
): Array<{ label: string; tasks: TaskSnapshot[] }> {
  const overdue: TaskSnapshot[] = [];
  const todayTasks: TaskSnapshot[] = [];
  const tomorrowTasks: TaskSnapshot[] = [];
  const upcoming: TaskSnapshot[] = [];
  const noDate: TaskSnapshot[] = [];

  for (const t of tasks) {
    const d = t.planning.due ?? t.planning.scheduled ?? t.planning.start;
    // Tasks without a date are a distinct category, not overdue.
    if (!d) noDate.push(t);
    else if (d < today) overdue.push(t);
    else if (d === today) todayTasks.push(t);
    else if (d === tomorrow) tomorrowTasks.push(t);
    else upcoming.push(t);
  }

  const result: Array<{ label: string; tasks: TaskSnapshot[] }> = [];
  if (overdue.length) result.push({ label: 'Overdue', tasks: overdue });
  if (todayTasks.length) result.push({ label: 'Today', tasks: todayTasks });
  if (tomorrowTasks.length) result.push({ label: 'Tomorrow', tasks: tomorrowTasks });
  if (upcoming.length) result.push({ label: 'Upcoming', tasks: upcoming });
  if (noDate.length) result.push({ label: 'No date', tasks: noDate });
  return result;
}

export function renderTaskGroup(
  container: HTMLElement,
  groups: TaskGroup,
  date: string,
  today: string,
  renderCard: (task: TaskSnapshot, cls: string, occurrence: CalendarOccurrence) => HTMLElement,
): void {
  const show = (group: TaskSnapshot[], cls: string) => {
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
  if (!statusGroups || statusGroups.length === 0 || statusGroups.length >= 4) return tasks;
  const allowed = new Set(statusGroups);
  return tasks.filter((t) => {
    const type = registry.bySymbol(t.statusSymbol)?.type ?? 'todo';
    return allowed.has(type);
  });
}
