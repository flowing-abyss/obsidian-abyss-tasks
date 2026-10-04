import { noteNameOfPath, withoutMarkdownExtension } from '../markdown/noteName';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskLinkValue, TaskLinkValues } from '../task-lists/taskLinkValues';
import type { TaskSnapshot, TaskStatusType } from '../tasks';

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

function appendToBucket<T>(buckets: Map<string, T[]>, key: string, task: T): void {
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

/**
 * One bucket of a grouped list: a key that names the bucket whatever its label says, the label its
 * header shows, and its tasks in input order.
 */
export type TaskGroupValue = Pick<
  TaskSnapshot,
  'priority' | 'statusSymbol' | 'tags' | 'planning'
> & { readonly source: Pick<TaskSnapshot['source'], 'filePath' | 'line'> };
export interface TaskGroup<T extends TaskGroupValue = TaskSnapshot> {
  readonly key: string;
  readonly label: string;
  readonly tasks: T[];
}

export function groupTasksByPriority<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  const PRIORITY_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    appendToBucket(map, t.priority, t);
  }
  return PRIORITY_ORDER.flatMap((priority) => {
    const bucket = map.get(priority);
    return bucket === undefined
      ? []
      : [{ key: priority, label: PRIORITY_LABELS[priority] ?? priority, tasks: bucket }];
  });
}

export function groupTasksByStatus<T extends TaskGroupValue>(
  tasks: readonly T[],
  registry: StatusRegistry,
): Array<TaskGroup<T>> {
  const buckets = new Map<string, { key: string; order: number; label: string; tasks: T[] }>();
  for (const t of tasks) {
    const def = registry.bySymbol(t.statusSymbol);
    const key = def?.id ?? '__other__';
    const label = def?.name ?? 'Other';
    const order = def != null ? registry.orderIndex(t.statusSymbol) : Number.MAX_SAFE_INTEGER;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, { key, order, label, tasks: [t] });
    else bucket.tasks.push(t);
  }
  return [...buckets.values()]
    .sort((x, y) => x.order - y.order)
    .map(({ key, label, tasks }) => ({ key, label, tasks }));
}

export function groupTasksByTag<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    const tag = t.tags[0] ?? '';
    const key = tag.length > 0 ? tag : 'No tag';
    appendToBucket(map, key, t);
  }
  const groups: Array<TaskGroup<T>> = [];
  for (const [label, gtasks] of map) {
    if (label !== 'No tag') groups.push({ key: label, label, tasks: gtasks });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  const noTag = map.get('No tag');
  if (noTag !== undefined) groups.push({ key: 'No tag', label: 'No tag', tasks: noTag });
  return groups;
}

type DateGroupLabel = 'Overdue' | 'Today' | 'Tomorrow' | 'Upcoming' | 'No date';

function dateGroupLabel(task: TaskGroupValue, today: string, tomorrow: string): DateGroupLabel {
  const date = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
  if (date === undefined) return 'No date';
  if (date < today) return 'Overdue';
  if (date === today) return 'Today';
  return date === tomorrow ? 'Tomorrow' : 'Upcoming';
}

export function groupTasksByDate<T extends TaskGroupValue>(
  tasks: readonly T[],
  today: string,
  tomorrow: string,
): Array<TaskGroup<T>> {
  const buckets = new Map<DateGroupLabel, T[]>();
  for (const task of tasks) appendToBucket(buckets, dateGroupLabel(task, today, tomorrow), task);
  const order: readonly DateGroupLabel[] = ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'No date'];
  return order.flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket === undefined ? [] : [{ key: label, label, tasks: bucket }];
  });
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

/** Canonical note names; same-name notes show their paths instead of ambiguous basenames. */
function orderedNoteGroups<T extends TaskGroupValue>(
  groups: Array<TaskGroup<T>>,
  paths: ReadonlyMap<string, string> = new Map(),
): Array<TaskGroup<T>> {
  const labels = new Map<string, number>();
  for (const group of groups) labels.set(group.label, (labels.get(group.label) ?? 0) + 1);
  return groups
    .map((group) => ({
      ...group,
      label:
        (labels.get(group.label) ?? 0) > 1
          ? (paths.get(group.key) ?? withoutMarkdownExtension(group.key))
          : group.label,
    }))
    .sort((a, b) => {
      const labelOrder = a.label.localeCompare(b.label);
      return labelOrder !== 0 ? labelOrder : a.key.localeCompare(b.key);
    });
}

export function groupTasksBySourceNote<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  const buckets = new Map<string, T[]>();
  for (const task of tasks) appendToBucket(buckets, task.source.filePath, task);
  return orderedNoteGroups(
    [...buckets].map(([key, tasks]) => ({ key, label: noteNameOfPath(key), tasks })),
  );
}

function appendLinkedTask<T extends TaskGroupValue>(
  groups: Map<string, TaskGroup<T>>,
  link: TaskLinkValue,
  task: T,
): void {
  const group = groups.get(link.key);
  if (group === undefined)
    groups.set(link.key, { key: link.key, label: link.label, tasks: [task] });
  else group.tasks.push(task);
}

function disambiguatedLinkLabel(link: TaskLinkValue, sourcePath: string): string {
  return link.key.startsWith('note:')
    ? withoutMarkdownExtension(link.target)
    : `${link.target} (${sourcePath})`;
}

export function groupTasksByOutgoingLink<T extends TaskGroupValue>(
  tasks: readonly T[],
  values: TaskLinkValues,
): Array<TaskGroup<T>> {
  const groups = new Map<string, TaskGroup<T>>();
  const paths = new Map<string, string>();
  const missing: T[] = [];
  const roots = new Map(tasks.map((task) => [`${task.source.filePath}:${task.source.line}`, task]));
  for (const task of roots.values()) {
    const links = values.get(`${task.source.filePath}:${task.source.line}`) ?? [];
    if (links.length === 0) missing.push(task);
    const seen = new Set<string>();
    for (const link of links) {
      if (seen.has(link.key)) continue;
      seen.add(link.key);
      paths.set(link.key, disambiguatedLinkLabel(link, task.source.filePath));
      appendLinkedTask(groups, link, task);
    }
  }
  const ordered = orderedNoteGroups([...groups.values()], paths);
  if (missing.length > 0)
    ordered.push({ key: 'no-outgoing-links', label: 'No outgoing links', tasks: missing });
  return ordered;
}
