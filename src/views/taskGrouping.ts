import { drainCollectionSteps, stableSortSteps, type CollectionSteps } from '../collectionSteps';
import { noteNameOfPath, withoutMarkdownExtension } from '../markdown/noteName';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskLinkValue, TaskLinkValues } from '../task-lists/taskLinkValues';
import { taskListDate } from '../task-lists/todayTaskCategory';
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

function* priorityGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const map = new Map<string, T[]>();
  let groups: Array<TaskGroup<T>> = [];
  try {
    for (const task of tasks) {
      appendToBucket(map, task.priority, task);
      if (cooperative) yield 'cheap';
    }
    for (const priority of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const bucket = map.get(priority);
      if (bucket !== undefined)
        groups.push({ key: priority, label: PRIORITY_LABELS[priority] ?? priority, tasks: bucket });
      if (cooperative) yield 'cheap';
    }
    return groups;
  } finally {
    map.clear();
    groups = [];
  }
}
function* addStatusTask<T extends TaskGroupValue>(
  task: T,
  registry: StatusRegistry,
  buckets: Map<string, TaskGroup<T> & { order: number }>,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const def = registry.bySymbol(task.statusSymbol);
  if (cooperative) yield 'atom';
  const key = def?.id ?? '__other__',
    label = def?.name ?? 'Other';
  const order = def != null ? registry.orderIndex(task.statusSymbol) : Number.MAX_SAFE_INTEGER;
  if (cooperative) yield 'atom';
  const bucket = buckets.get(key);
  if (bucket === undefined) buckets.set(key, { key, label, order, tasks: [task] });
  else bucket.tasks.push(task);
  if (cooperative) yield 'cheap';
  return true;
}
function* orderStatusGroups<T extends TaskGroupValue>(
  values: Array<TaskGroup<T> & { order: number }>,
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T> & { order: number }>> {
  const compare = (a: (typeof values)[number], b: (typeof values)[number]): number =>
    a.order - b.order;
  if (cooperative) return yield* stableSortSteps(values, compare);
  values.sort(compare);
  return values;
}
function* statusGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  registry: StatusRegistry,
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const buckets = new Map<string, TaskGroup<T> & { order: number }>();
  const ordered: Array<TaskGroup<T> & { order: number }> = [];
  let output: Array<TaskGroup<T>> = [];
  try {
    for (const task of tasks) {
      const added = yield* addStatusTask(task, registry, buckets, cooperative);
      if (added === undefined) throw new Error('Status admission ended without a result');
    }
    for (const value of buckets.values()) {
      ordered.push(value);
      if (cooperative) yield 'cheap';
    }
    const sorted = yield* orderStatusGroups(ordered, cooperative);
    if (sorted === undefined) throw new Error('Group sort ended without a result');
    for (const { key, label, tasks } of sorted) {
      output.push({ key, label, tasks });
      if (cooperative) yield 'cheap';
    }
    return output;
  } finally {
    buckets.clear();
    ordered.length = 0;
    output = [];
  }
}
function* orderTagGroups<T extends TaskGroupValue>(
  values: Array<TaskGroup<T>>,
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const compare = (a: TaskGroup<T>, b: TaskGroup<T>): number => a.label.localeCompare(b.label);
  if (cooperative) return yield* stableSortSteps(values, compare);
  values.sort(compare);
  return values;
}
function firstTagGroup(task: TaskGroupValue): string {
  const tag = task.tags[0] ?? '';
  return tag.length > 0 ? tag : 'No tag';
}
function* tagGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const buckets = new Map<string, T[]>();
  let groups: Array<TaskGroup<T>> = [];
  try {
    for (const task of tasks) {
      appendToBucket(buckets, firstTagGroup(task), task);
      if (cooperative) yield 'cheap';
    }
    for (const [label, tasks] of buckets) {
      if (label !== 'No tag') groups.push({ key: label, label, tasks });
      if (cooperative) yield 'cheap';
    }
    const sorted = yield* orderTagGroups(groups, cooperative);
    if (sorted === undefined) throw new Error('Group sort ended without a result');
    const missing = buckets.get('No tag');
    if (missing !== undefined) sorted.push({ key: 'No tag', label: 'No tag', tasks: missing });
    return sorted;
  } finally {
    buckets.clear();
    groups = [];
  }
}
type DateGroupLabel = 'Overdue' | 'Today' | 'Tomorrow' | 'Upcoming' | 'No date';
function dateGroupLabel(
  task: TaskGroupValue,
  today: string,
  tomorrow: string,
  todayList: boolean,
): DateGroupLabel {
  const date = taskListDate(task, todayList ? today : undefined);
  if (date === undefined) return 'No date';
  if (date < today) return 'Overdue';
  if (date === today) return 'Today';
  return date === tomorrow ? 'Tomorrow' : 'Upcoming';
}
function* dateGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  context: { readonly today: string; readonly tomorrow: string; readonly todayList: boolean },
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const { today, tomorrow, todayList } = context;
  const buckets = new Map<string, T[]>();
  let groups: Array<TaskGroup<T>> = [];
  try {
    for (const task of tasks) {
      appendToBucket(buckets, dateGroupLabel(task, today, tomorrow, todayList), task);
      if (cooperative) yield 'cheap';
    }
    for (const label of ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'No date']) {
      const bucket = buckets.get(label);
      if (bucket !== undefined) groups.push({ key: label, label, tasks: bucket });
      if (cooperative) yield 'cheap';
    }
    return groups;
  } finally {
    buckets.clear();
    groups = [];
  }
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
function noteGroupLabel(
  group: { key: string; label: string },
  labels: ReadonlyMap<string, number>,
  paths: ReadonlyMap<string, string>,
): string {
  return (labels.get(group.label) ?? 0) > 1
    ? (paths.get(group.key) ?? withoutMarkdownExtension(group.key))
    : group.label;
}
function* orderedNoteGroups<T extends TaskGroupValue>(
  groups: Array<TaskGroup<T>>,
  paths: ReadonlyMap<string, string>,
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const labels = new Map<string, number>();
  let output: Array<TaskGroup<T>> = [];
  try {
    for (const group of groups) {
      labels.set(group.label, (labels.get(group.label) ?? 0) + 1);
      if (cooperative) yield 'cheap';
    }
    for (const group of groups) {
      const label = noteGroupLabel(group, labels, paths);
      if (cooperative) yield 'atom';
      output.push({ ...group, label });
      if (cooperative) yield 'cheap';
    }
    const compare = (a: TaskGroup<T>, b: TaskGroup<T>): number => {
      const label = a.label.localeCompare(b.label);
      return label !== 0 ? label : a.key.localeCompare(b.key);
    };
    if (cooperative) return yield* stableSortSteps(output, compare);
    output.sort(compare);
    return output;
  } finally {
    labels.clear();
    output = [];
  }
}
function* sourceGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const buckets = new Map<string, T[]>();
  let groups: Array<TaskGroup<T>> = [];
  try {
    for (const task of tasks) {
      appendToBucket(buckets, task.source.filePath, task);
      if (cooperative) yield 'cheap';
    }
    for (const [key, tasks] of buckets) {
      const label = noteNameOfPath(key);
      if (cooperative) yield 'atom';
      groups.push({ key, label, tasks });
      if (cooperative) yield 'cheap';
    }
    return yield* orderedNoteGroups(groups, new Map(), cooperative);
  } finally {
    buckets.clear();
    groups = [];
  }
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
interface OutgoingBuckets<T extends TaskGroupValue> {
  groups: Map<string, TaskGroup<T>>;
  paths: Map<string, string>;
  missing: T[];
  seen: Set<string>;
}
function* admitOutgoingLink<T extends TaskGroupValue>(
  task: T,
  link: TaskLinkValue,
  context: OutgoingBuckets<T>,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { groups, paths, seen } = context;
  seen.add(link.key);
  if (cooperative) yield 'cheap';
  const label = disambiguatedLinkLabel(link, task.source.filePath);
  if (cooperative) yield 'atom';
  paths.set(link.key, label);
  if (cooperative) yield 'cheap';
  appendLinkedTask(groups, link, task);
  if (cooperative) yield 'cheap';
  return true;
}
function* admitOutgoingLinks<T extends TaskGroupValue>(
  task: T,
  links: readonly TaskLinkValue[],
  context: OutgoingBuckets<T>,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { seen } = context;
  for (const link of links) {
    if (seen.has(link.key)) {
      if (cooperative) yield 'cheap';
      continue;
    }
    const added = yield* admitOutgoingLink(task, link, context, cooperative);
    if (added === undefined) throw new Error('Link admission ended without a result');
  }
  return true;
}
function* admitOutgoingRoots<T extends TaskGroupValue>(
  roots: ReadonlyMap<string, T>,
  values: TaskLinkValues,
  context: OutgoingBuckets<T>,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { missing, seen } = context;
  for (const task of roots.values()) {
    const links = values.get(`${task.source.filePath}:${task.source.line}`) ?? [];
    if (links.length === 0) missing.push(task);
    if (cooperative) yield 'cheap';
    seen.clear();
    const added = yield* admitOutgoingLinks(task, links, context, cooperative);
    if (added === undefined) throw new Error('Link admission ended without a result');
  }
  return true;
}
function* outgoingGroups<T extends TaskGroupValue>(
  tasks: readonly T[],
  values: TaskLinkValues,
  cooperative: boolean,
): CollectionSteps<Array<TaskGroup<T>>> {
  const groups = new Map<string, TaskGroup<T>>(),
    paths = new Map<string, string>(),
    roots = new Map<string, T>();
  let missing: T[] = [],
    output: Array<TaskGroup<T>> = [];
  const seen = new Set<string>();
  try {
    for (const task of tasks) {
      roots.set(`${task.source.filePath}:${task.source.line}`, task);
      if (cooperative) yield 'cheap';
    }
    const admitted = yield* admitOutgoingRoots(
      roots,
      values,
      { groups, paths, missing, seen },
      cooperative,
    );
    if (admitted === undefined) throw new Error('Outgoing admission ended without a result');
    for (const group of groups.values()) {
      output.push(group);
      if (cooperative) yield 'cheap';
    }
    const ordered = yield* orderedNoteGroups(output, paths, cooperative);
    if (ordered === undefined) throw new Error('Group ordering ended without a result');
    if (missing.length > 0)
      ordered.push({ key: 'no-outgoing-links', label: 'No outgoing links', tasks: missing });
    return ordered;
  } finally {
    groups.clear();
    paths.clear();
    roots.clear();
    seen.clear();
    missing = [];
    output = [];
  }
}

export function groupTasksByPriority<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  return drainCollectionSteps(priorityGroups(tasks, false));
}
export function groupTasksByPrioritySteps<T extends TaskGroupValue>(
  tasks: readonly T[],
): CollectionSteps<Array<TaskGroup<T>>> {
  return priorityGroups(tasks, true);
}

export function groupTasksByStatus<T extends TaskGroupValue>(
  tasks: readonly T[],
  registry: StatusRegistry,
): Array<TaskGroup<T>> {
  return drainCollectionSteps(statusGroups(tasks, registry, false));
}
export function groupTasksByStatusSteps<T extends TaskGroupValue>(
  tasks: readonly T[],
  registry: StatusRegistry,
): CollectionSteps<Array<TaskGroup<T>>> {
  return statusGroups(tasks, registry, true);
}

export function groupTasksByTag<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  return drainCollectionSteps(tagGroups(tasks, false));
}
export function groupTasksByTagSteps<T extends TaskGroupValue>(
  tasks: readonly T[],
): CollectionSteps<Array<TaskGroup<T>>> {
  return tagGroups(tasks, true);
}

export function groupTasksByDate<T extends TaskGroupValue>(
  tasks: readonly T[],
  today: string,
  tomorrow: string,
  todayList = false,
): Array<TaskGroup<T>> {
  return drainCollectionSteps(dateGroups(tasks, { today, tomorrow, todayList }, false));
}
export function groupTasksByDateSteps<T extends TaskGroupValue>(
  tasks: readonly T[],
  today: string,
  tomorrow: string,
  todayList = false,
): CollectionSteps<Array<TaskGroup<T>>> {
  return dateGroups(tasks, { today, tomorrow, todayList }, true);
}

export function groupTasksBySourceNote<T extends TaskGroupValue>(
  tasks: readonly T[],
): Array<TaskGroup<T>> {
  return drainCollectionSteps(sourceGroups(tasks, false));
}
export function groupTasksBySourceNoteSteps<T extends TaskGroupValue>(
  tasks: readonly T[],
): CollectionSteps<Array<TaskGroup<T>>> {
  return sourceGroups(tasks, true);
}

export function groupTasksByOutgoingLink<T extends TaskGroupValue>(
  tasks: readonly T[],
  values: TaskLinkValues,
): Array<TaskGroup<T>> {
  return drainCollectionSteps(outgoingGroups(tasks, values, false));
}
export function groupTasksByOutgoingLinkSteps<T extends TaskGroupValue>(
  tasks: readonly T[],
  values: TaskLinkValues,
): CollectionSteps<Array<TaskGroup<T>>> {
  return outgoingGroups(tasks, values, true);
}
