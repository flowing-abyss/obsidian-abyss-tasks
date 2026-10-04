import type { ListSelection } from '../app/AppState';
import { resolveListViewStateKey } from '../app/listViewState';
import { sameTag } from '../markdown/tagSyntax';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../settings/types';
import {
  resolveEffectiveTagGroups,
  tagMatchesGroup,
  type EffectiveTagGroup,
} from '../tags/effectiveTagGroups';
import {
  normalizeTaskTagInput,
  subtreeTotal,
  totalMs,
  type LocalDate,
  type SubtaskSnapshot,
  type TaskSnapshot,
  type TaskStatusType,
} from '../tasks';
import type { TaskLinkValue, TaskLinkValues } from './taskLinkValues';
import { todayTaskCategory } from './todayTaskCategory';

export interface TaskListSelectionInput {
  readonly tasks: readonly TaskSnapshot[];
  readonly selection: ListSelection | null;
  readonly viewState: ListViewState;
  readonly settings: CalendarSettings;
  readonly today: LocalDate;
  /** The one instant a running timer is read against, so every row of a pass agrees on it. */
  readonly nowMs: number;
  readonly textQuery?: string;
  readonly outgoingLinks?: TaskLinkValues;
}

/** What an ordering needs beyond the tasks themselves, read once rather than per comparison. */
export type TaskListValue = Pick<
  TaskSnapshot,
  'title' | 'planning' | 'tags' | 'status' | 'statusSymbol' | 'priority'
> & { readonly source: Pick<TaskSnapshot['source'], 'filePath' | 'line'> };

export interface TaskValueSelectionInput<T extends TaskListValue> {
  readonly tasks: readonly T[];
  readonly selection: ListSelection | null;
  readonly viewState: ListViewState;
  readonly settings: CalendarSettings;
  readonly today: LocalDate;
  readonly nowMs: number;
  readonly outgoingLinks?: TaskLinkValues;
  readonly treeTags: (task: T) => readonly string[];
  readonly trackedMs: (task: T) => number;
}

interface TaskOrder<T extends TaskListValue> {
  readonly input: TaskValueSelectionInput<T>;
  /** Distinct outgoing labels/identities in canonical order, derived before comparisons. */
  readonly linkOrder: ReadonlyMap<T, readonly TaskLinkValue[]>;
  /** Tracked totals by task, so a sort walks each subtree once instead of on every comparison. */
  readonly trackedMs: ReadonlyMap<T, number>;
}

function dateOf(task: TaskListValue): string | undefined {
  return task.planning.due ?? task.planning.scheduled ?? task.planning.start;
}

interface SelectionContext {
  readonly selection: ListSelection | null;
  readonly settings: CalendarSettings;
  readonly today: LocalDate;
  readonly groups: readonly EffectiveTagGroup[];
}

function selected(
  task: TaskListValue,
  treeTags: readonly string[],
  context: SelectionContext,
): boolean {
  const { selection, settings, today, groups } = context;
  if (selection === null) return true;
  if (selection === 'inbox' || selection === 'today' || selection === 'upcoming') {
    return selectedNamedList(task, selection, settings, today);
  }
  if (typeof selection === 'string') return true;
  if (selection.type === 'tag') return treeTags.some((tag) => sameTag(tag, selection.tag));
  if (selection.type === 'project') return task.source.filePath === selection.path;
  return selectedTagGroup(treeTags, selection.groupId, groups);
}

function visitTaskTags(
  node: Pick<TaskSnapshot | SubtaskSnapshot, 'tags' | 'subtasks'>,
  visit: (tag: string) => boolean,
): boolean {
  if (node.tags.some(visit)) return true;
  return node.subtasks.some((child) => visitTaskTags(child, visit));
}

function taskTreeTags(task: TaskSnapshot): readonly string[] {
  const tags: string[] = [];
  visitTaskTags(task, (tag) => {
    tags.push(tag);
    return false;
  });
  return tags;
}

function selectedNamedList(
  task: TaskListValue,
  selection: 'inbox' | 'today' | 'upcoming',
  settings: CalendarSettings,
  today: LocalDate,
): boolean {
  if (selection === 'inbox') return selectedInbox(task, settings);
  if (selection === 'today') return todayTaskCategory(task, today) !== undefined;
  const date = task.planning.due ?? task.planning.scheduled;
  return date !== undefined && date > today;
}

function selectedInbox(task: TaskListValue, settings: CalendarSettings): boolean {
  const normalized = normalizeTaskTagInput(settings.inbox.tag);
  const inboxTag = normalized?.length === 1 ? normalized[0] : undefined;
  const tagged =
    settings.inbox.mode !== 'untagged' &&
    inboxTag !== undefined &&
    task.tags.some((candidate) => sameTag(candidate, inboxTag));
  const untagged = settings.inbox.mode !== 'tag' && task.tags.length === 0;
  return tagged || untagged;
}

function selectedTagGroup(
  treeTags: readonly string[],
  groupId: string,
  groups: readonly EffectiveTagGroup[],
): boolean {
  const configuredIds = new Set(
    groups
      .filter((candidate) => candidate.origin === 'configured')
      .map((candidate) => candidate.id),
  );
  const key = resolveListViewStateKey({ type: 'group', groupId }, undefined, configuredIds);
  const group =
    groups.find((candidate) => candidate.id === groupId) ??
    groups.find(
      (candidate) =>
        candidate.origin === 'discovered' &&
        resolveListViewStateKey(
          { type: 'group', groupId: candidate.id },
          undefined,
          configuredIds,
        ) === key,
    );
  if (group == null) return false;
  return treeTags.some((tag) => tagMatchesGroup(tag, group));
}

function statusTypeOf(task: TaskListValue): TaskStatusType {
  if (task.status === 'open') return 'todo';
  return task.status;
}

function matchesProperty(task: TaskListValue, filter: PropertyFilter): boolean {
  if (filter.type === 'tag') {
    return task.tags.some((candidate) => sameTag(candidate, filter.value));
  }
  if (filter.type === 'file') return task.source.filePath === filter.filePath;
  if (filter.type === 'time') return String(task.planning.time) === filter.value;
  if (filter.type === 'priority') return task.priority === filter.value;
  if (filter.type === 'status') return task.statusSymbol === filter.value;
  const date = dateOf(task);
  return date !== undefined && String(date) === filter.value;
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function compareLinkValue(left: TaskLinkValue, right: TaskLinkValue): number {
  const label = left.label.localeCompare(right.label);
  return label !== 0 ? label : left.key.localeCompare(right.key);
}

function compareLinkSequence(
  left: readonly TaskLinkValue[] | undefined,
  right: readonly TaskLinkValue[] | undefined,
): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a !== undefined && b !== undefined) {
      const order = compareLinkValue(a, b);
      if (order !== 0) return order;
    }
  }
  return left.length - right.length;
}

function compareCreated(left: TaskListValue, right: TaskListValue): number {
  const a = left.planning.created;
  const b = right.planning.created;
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a.localeCompare(b);
}

function compareDate(left: TaskListValue, right: TaskListValue): number {
  const dateOrder = compareOptional(dateOf(left), dateOf(right));
  return dateOrder !== 0 ? dateOrder : compareOptional(left.planning.time, right.planning.time);
}

function compare<T extends TaskListValue>(left: T, right: T, order: TaskOrder<T>): number {
  const { input } = order;
  const field = input.viewState.sortBy.field;
  if (field === 'date') return compareDate(left, right);
  if (field === 'priority') return left.priority.localeCompare(right.priority);
  if (field === 'title') return left.title.localeCompare(right.title);
  if (field === 'source-note') return left.source.filePath.localeCompare(right.source.filePath);
  if (field === 'outgoing-link')
    return compareLinkSequence(order.linkOrder.get(left), order.linkOrder.get(right));
  if (field === 'tag') return compareOptional(left.tags[0], right.tags[0]);
  if (field === 'tracked') {
    return (order.trackedMs.get(left) ?? 0) - (order.trackedMs.get(right) ?? 0);
  }
  const symbols = input.settings.taskStatuses.map((status) => status.symbol);
  const statusOrder = (symbol: string): number => {
    const index = symbols.indexOf(symbol === 'X' ? 'x' : symbol);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return statusOrder(left.statusSymbol) - statusOrder(right.statusSymbol);
}

export function filterTaskValues<T extends TaskListValue>(input: TaskValueSelectionInput<T>): T[] {
  const allowed = input.viewState.statusGroups;
  const groups = resolveEffectiveTagGroups(input.settings, input.tasks.flatMap(input.treeTags));
  return input.tasks
    .filter((task) => selected(task, input.treeTags(task), { ...input, groups }))
    .filter(
      (task) =>
        allowed == null ||
        allowed.length === 0 ||
        allowed.length >= 4 ||
        allowed.includes(statusTypeOf(task)),
    )
    .filter((task) => input.viewState.filters.every((filter) => matchesProperty(task, filter)));
}

export function selectTaskValues<T extends TaskListValue>(input: TaskValueSelectionInput<T>): T[] {
  const matching = filterTaskValues(input);
  const order: TaskOrder<T> = {
    input,
    linkOrder: new Map(
      matching.flatMap((task) => {
        const values = input.outgoingLinks?.get(`${task.source.filePath}:${task.source.line}`);
        const sequence = [...new Map(values?.map((value) => [value.key, value])).values()].sort(
          compareLinkValue,
        );
        return sequence.length === 0 ? [] : [[task, sequence] as const];
      }),
    ),
    trackedMs:
      input.viewState.sortBy.field === 'tracked'
        ? new Map(matching.map((task) => [task, input.trackedMs(task)]))
        : new Map(),
  };
  return matching.sort((left, right) => {
    const explicit = compare(left, right, order);
    if (explicit !== 0) return input.viewState.sortBy.dir === 'asc' ? explicit : -explicit;
    return compareCreated(left, right);
  });
}

export function selectTaskList(input: TaskListSelectionInput): readonly TaskSnapshot[] {
  const query = input.textQuery?.toLowerCase() ?? '';
  const tasks = input.tasks.filter(
    (task) =>
      query.length === 0 ||
      task.title.toLowerCase().includes(query) ||
      task.source.originalMarkdown.toLowerCase().includes(query),
  );
  return selectTaskValues({
    ...input,
    tasks,
    treeTags: taskTreeTags,
    trackedMs: (task) => totalMs(subtreeTotal(task), input.nowMs),
  });
}

export function searchTaskList(
  tasks: readonly TaskSnapshot[],
  textQuery: string,
): readonly TaskSnapshot[] {
  const query = textQuery.toLowerCase();
  if (query.length === 0) return [];
  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query) ||
      task.source.originalMarkdown.toLowerCase().includes(query),
  );
}
