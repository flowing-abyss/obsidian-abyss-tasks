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

/**
 * One bucket of a grouped list: a key that names the bucket whatever its label says, the label its
 * header shows, and its tasks in input order.
 */
export interface TaskGroup {
  readonly key: string;
  readonly label: string;
  readonly tasks: TaskSnapshot[];
}

export function groupTasksByPriority(tasks: readonly TaskSnapshot[]): TaskGroup[] {
  const PRIORITY_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
  const map = new Map<string, TaskSnapshot[]>();
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

export function groupTasksByStatus(
  tasks: readonly TaskSnapshot[],
  registry: StatusRegistry,
): TaskGroup[] {
  const buckets = new Map<
    string,
    { key: string; order: number; label: string; tasks: TaskSnapshot[] }
  >();
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

export function groupTasksByTag(tasks: readonly TaskSnapshot[]): TaskGroup[] {
  const map = new Map<string, TaskSnapshot[]>();
  for (const t of tasks) {
    const tag = t.tags[0] ?? '';
    const key = tag.length > 0 ? tag : 'No tag';
    appendToBucket(map, key, t);
  }
  const groups: TaskGroup[] = [];
  for (const [label, gtasks] of map) {
    if (label !== 'No tag') groups.push({ key: label, label, tasks: gtasks });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  const noTag = map.get('No tag');
  if (noTag !== undefined) groups.push({ key: 'No tag', label: 'No tag', tasks: noTag });
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
  tasks: readonly TaskSnapshot[],
  today: string,
  tomorrow: string,
): TaskGroup[] {
  const buckets = new Map<DateGroupLabel, TaskSnapshot[]>();
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
function orderedNoteGroups(
  groups: TaskGroup[],
  paths: ReadonlyMap<string, string> = new Map(),
): TaskGroup[] {
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

export function groupTasksBySourceNote(tasks: readonly TaskSnapshot[]): TaskGroup[] {
  const buckets = new Map<string, TaskSnapshot[]>();
  for (const task of tasks) appendToBucket(buckets, task.source.filePath, task);
  return orderedNoteGroups(
    [...buckets].map(([key, tasks]) => ({ key, label: noteNameOfPath(key), tasks })),
  );
}

function appendLinkedTask(
  groups: Map<string, TaskGroup>,
  link: TaskLinkValue,
  task: TaskSnapshot,
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

export function groupTasksByOutgoingLink(
  tasks: readonly TaskSnapshot[],
  values: TaskLinkValues,
): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  const paths = new Map<string, string>();
  const missing: TaskSnapshot[] = [];
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
