import type { ListSelection } from '../app/AppState';
import { resolveListViewStateKey } from '../app/listViewState';
import { drainCollectionSteps, stableSortSteps, type CollectionSteps } from '../collectionSteps';
import { sameTag } from '../markdown/tagSyntax';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../settings/types';
import {
  resolveEffectiveTagGroups,
  resolveEffectiveTagGroupsSteps,
  tagMatchesGroup,
  tagMatchesGroupSteps,
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
import { taskListDate, todayTaskCategory } from './todayTaskCategory';

export type TaskOrganizationSettings = Pick<
  CalendarSettings,
  'inbox' | 'taskStatuses' | 'tagGroups' | 'archivedTags' | 'archivedTagPrefixes'
>;

export interface TaskListSelectionInput {
  readonly tasks: readonly TaskSnapshot[];
  readonly selection: ListSelection | null;
  readonly viewState: ListViewState;
  readonly settings: TaskOrganizationSettings;
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
  /** Canonical catalog input when the candidate tasks have already been narrowed. */
  readonly observedTags?: readonly string[];
  readonly tasks: readonly T[];
  readonly selection: ListSelection | null;
  readonly viewState: ListViewState;
  readonly settings: TaskOrganizationSettings;
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
  readonly statusOrder: ReadonlyMap<string, number>;
}

function dateOf(task: TaskListValue): string | undefined {
  return task.planning.due ?? task.planning.scheduled ?? task.planning.start;
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

function statusTypeOf(task: TaskListValue): TaskStatusType {
  if (task.status === 'open') return 'todo';
  return task.status;
}

function* matchesTags(
  tags: readonly string[],
  target: string,
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const candidate of tags) {
    const matches = sameTag(candidate, target);
    if (cooperative) yield 'atom';
    if (matches) return true;
  }
  return false;
}
function* matchesProperty(
  task: TaskListValue,
  filter: PropertyFilter,
  cooperative: boolean,
): CollectionSteps<boolean> {
  if (filter.type === 'tag') return yield* matchesTags(task.tags, filter.value, cooperative);
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

function compareDate(
  left: TaskListValue,
  right: TaskListValue,
  input: Pick<TaskValueSelectionInput<TaskListValue>, 'selection' | 'today'>,
): number {
  const todayListDate = input.selection === 'today' ? input.today : undefined;
  const dateOrder = compareOptional(
    taskListDate(left, todayListDate),
    taskListDate(right, todayListDate),
  );
  return dateOrder !== 0 ? dateOrder : compareOptional(left.planning.time, right.planning.time);
}

function compare<T extends TaskListValue>(left: T, right: T, order: TaskOrder<T>): number {
  const { input } = order;
  const field = input.viewState.sortBy.field;
  if (field === 'date') return compareDate(left, right, input);
  if (field === 'priority') return left.priority.localeCompare(right.priority);
  if (field === 'title') return left.title.localeCompare(right.title);
  if (field === 'source-note') return left.source.filePath.localeCompare(right.source.filePath);
  if (field === 'outgoing-link')
    return compareLinkSequence(order.linkOrder.get(left), order.linkOrder.get(right));
  if (field === 'tag') return compareOptional(left.tags[0], right.tags[0]);
  if (field === 'tracked') {
    return (order.trackedMs.get(left) ?? 0) - (order.trackedMs.get(right) ?? 0);
  }
  const statusOrder = (symbol: string): number =>
    order.statusOrder.get(symbol === 'X' ? 'x' : symbol) ?? Number.MAX_SAFE_INTEGER;
  return statusOrder(left.statusSymbol) - statusOrder(right.statusSymbol);
}

function filterTaskValues<T extends TaskListValue>(input: TaskValueSelectionInput<T>): T[] {
  return drainCollectionSteps(filterValues(input, false));
}
export function filterTaskValuesSteps<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
): CollectionSteps<T[]> {
  return filterValues(input, true);
}
interface MembershipContext {
  readonly group: EffectiveTagGroup | undefined;
  readonly inboxTag: string | undefined;
  readonly allowed: ReadonlySet<TaskStatusType>;
}
function* observedTags<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<string[]> {
  const observed: string[] = [];
  for (const task of input.tasks) {
    const tags = input.treeTags(task);
    if (cooperative) yield 'atom';
    for (const tag of tags) {
      observed.push(tag);
      if (cooperative) yield 'cheap';
    }
  }
  return observed;
}
function* configuredGroupIds(
  groups: readonly EffectiveTagGroup[],
  cooperative: boolean,
): CollectionSteps<Set<string>> {
  const configuredIds = new Set<string>();
  for (const group of groups) {
    if (group.origin === 'configured') configuredIds.add(group.id);
    if (cooperative) yield 'cheap';
  }
  return configuredIds;
}
function* exactGroup(
  groups: readonly EffectiveTagGroup[],
  groupId: string,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup | null> {
  for (const group of groups) {
    if (cooperative) yield 'cheap';
    if (group.id === groupId) return group;
  }
  return null;
}
function* findSelectedGroup(
  groups: readonly EffectiveTagGroup[],
  groupId: string,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup | null> {
  const configuredIds = yield* configuredGroupIds(groups, cooperative);
  if (configuredIds === undefined) throw new Error('Group identities ended without a result');
  const key = resolveListViewStateKey({ type: 'group', groupId }, undefined, configuredIds);
  if (cooperative) yield 'atom';
  const exact = yield* exactGroup(groups, groupId, cooperative);
  if (exact === undefined) throw new Error('Group lookup ended without a result');
  if (exact !== null) return exact;
  for (const group of groups) {
    const matches =
      group.origin === 'discovered' &&
      resolveListViewStateKey({ type: 'group', groupId: group.id }, undefined, configuredIds) ===
        key;
    if (cooperative) yield 'atom';
    if (matches) return group;
  }
  return null;
}
function* selectedGroup<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup | null> {
  const selection = input.selection;
  if (selection === null || typeof selection === 'string' || selection.type !== 'group')
    return null;
  const observed = input.observedTags ?? (yield* observedTags(input, cooperative));
  if (observed === undefined) throw new Error('Observed tags ended without a result');
  const catalog = cooperative
    ? yield* resolveEffectiveTagGroupsSteps(input.settings, observed)
    : resolveEffectiveTagGroups(input.settings, observed);
  if (catalog === undefined) throw new Error('Catalog ended without a result');
  return yield* findSelectedGroup(catalog, selection.groupId, cooperative);
}
function* allowedStatuses(
  view: ListViewState,
  cooperative: boolean,
): CollectionSteps<Set<TaskStatusType>> {
  const allowed = new Set<TaskStatusType>(),
    subset = view.statusGroups ?? [];
  if (subset.length < 4)
    for (const status of subset) {
      allowed.add(status);
      if (cooperative) yield 'cheap';
    }
  return allowed;
}
function* membershipContext<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<MembershipContext> {
  const group = yield* selectedGroup(input, cooperative);
  if (group === undefined) throw new Error('Group selection ended without a result');
  let inboxTag: string | undefined;
  if (input.selection === 'inbox') {
    const tags = normalizeTaskTagInput(input.settings.inbox.tag);
    if (cooperative) yield 'atom';
    inboxTag = tags?.length === 1 ? tags[0] : undefined;
  }
  const allowed = yield* allowedStatuses(input.viewState, cooperative);
  if (allowed === undefined) throw new Error('Statuses ended without a result');
  return { group: group ?? undefined, inboxTag, allowed };
}
function* selectedInbox(
  task: TaskListValue,
  settings: TaskOrganizationSettings,
  inboxTag: string | undefined,
  cooperative: boolean,
): CollectionSteps<boolean> {
  let tagged = false;
  if (settings.inbox.mode !== 'untagged' && inboxTag !== undefined) {
    const matches = yield* matchesTags(task.tags, inboxTag, cooperative);
    if (matches === undefined) throw new Error('Inbox membership ended without a result');
    tagged = matches;
  }
  return tagged || (settings.inbox.mode !== 'tag' && task.tags.length === 0);
}
function* selectedTree(
  tags: readonly string[],
  group: EffectiveTagGroup | undefined,
  cooperative: boolean,
): CollectionSteps<boolean> {
  if (group === undefined) return false;
  for (const tag of tags) {
    const matches = cooperative
      ? yield* tagMatchesGroupSteps(tag, group)
      : tagMatchesGroup(tag, group);
    if (matches === undefined) throw new Error('Membership ended without a result');
    if (cooperative) yield 'cheap';
    if (matches) return true;
  }
  return false;
}
function* selectedObject<T extends TaskListValue>(
  task: T,
  input: TaskValueSelectionInput<T>,
  context: MembershipContext & { selection: Exclude<ListSelection, string> },
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { selection } = context;
  if (selection.type === 'project') return task.source.filePath === selection.path;
  const tags = input.treeTags(task);
  if (cooperative) yield 'atom';
  if (selection.type === 'tag') return yield* matchesTags(tags, selection.tag, cooperative);
  return yield* selectedTree(tags, context.group, cooperative);
}
function* selected<T extends TaskListValue>(
  task: T,
  input: TaskValueSelectionInput<T>,
  context: MembershipContext,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { selection, settings, today } = input;
  if (selection === 'inbox')
    return yield* selectedInbox(task, settings, context.inboxTag, cooperative);
  if (selection === 'today') return todayTaskCategory(task, today) !== undefined;
  if (selection === 'upcoming') {
    const date = task.planning.due ?? task.planning.scheduled;
    return date !== undefined && date > today;
  }
  if (selection === null || typeof selection === 'string') return true;
  return yield* selectedObject(task, input, { ...context, selection }, cooperative);
}
function* matchesProperties(
  task: TaskListValue,
  filters: readonly PropertyFilter[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const filter of filters) {
    const matches = yield* matchesProperty(task, filter, cooperative);
    if (matches === undefined) throw new Error('Property filter ended without a result');
    if (cooperative) yield 'cheap';
    if (!matches) return false;
  }
  return true;
}
function* matchesTask<T extends TaskListValue>(
  task: T,
  input: TaskValueSelectionInput<T>,
  context: MembershipContext,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const included = yield* selected(task, input, context, cooperative);
  if (included === undefined) throw new Error('Membership ended without a result');
  if (cooperative) yield 'cheap';
  if (!included) return false;
  if (context.allowed.size > 0 && !context.allowed.has(statusTypeOf(task))) return false;
  const properties = yield* matchesProperties(task, input.viewState.filters, cooperative);
  if (properties === undefined) throw new Error('Properties ended without a result');
  return properties;
}
function* filterValues<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<T[]> {
  const context = yield* membershipContext(input, cooperative);
  if (context === undefined) throw new Error('Membership context ended without a result');
  const matching: T[] = [];
  for (const task of input.tasks) {
    const properties = yield* matchesTask(task, input, context, cooperative);
    if (properties === undefined) throw new Error('Task matching ended without a result');
    if (properties) matching.push(task);
    if (cooperative) yield 'cheap';
  }
  return matching;
}

export function selectTaskValues<T extends TaskListValue>(input: TaskValueSelectionInput<T>): T[] {
  return drainCollectionSteps(selectValues(input, false));
}
export function selectTaskValuesSteps<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
): CollectionSteps<T[]> {
  return selectValues(input, true);
}
function* linkSequence(
  values: readonly TaskLinkValue[],
  cooperative: boolean,
): CollectionSteps<TaskLinkValue[]> {
  const unique = new Map<string, TaskLinkValue>(),
    sequence: TaskLinkValue[] = [];
  for (const value of values) {
    unique.set(value.key, value);
    if (cooperative) yield 'cheap';
  }
  for (const value of unique.values()) {
    sequence.push(value);
    if (cooperative) yield 'cheap';
  }
  if (cooperative) return yield* stableSortSteps(sequence, compareLinkValue);
  sequence.sort(compareLinkValue);
  return sequence;
}
function* prepareLinks<T extends TaskListValue>(
  tasks: readonly T[],
  values: TaskLinkValues | undefined,
  cooperative: boolean,
): CollectionSteps<Map<T, readonly TaskLinkValue[]>> {
  const output = new Map<T, readonly TaskLinkValue[]>();
  for (const task of tasks) {
    const sequence = yield* linkSequence(
      values?.get(`${task.source.filePath}:${task.source.line}`) ?? [],
      cooperative,
    );
    if (sequence === undefined) throw new Error('Link sort ended without a result');
    if (sequence.length > 0) output.set(task, sequence);
    if (cooperative) yield 'cheap';
  }
  return output;
}
function* prepareTracked<T extends TaskListValue>(
  tasks: readonly T[],
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<Map<T, number>> {
  const totals = new Map<T, number>();
  for (const task of tasks) {
    const total = input.trackedMs(task);
    if (cooperative) yield 'atom';
    totals.set(task, total);
    if (cooperative) yield 'cheap';
  }
  return totals;
}
function* prepareStatuses(
  settings: TaskOrganizationSettings,
  cooperative: boolean,
): CollectionSteps<Map<string, number>> {
  const ranks = new Map<string, number>();
  let index = 0;
  for (const status of settings.taskStatuses) {
    if (!ranks.has(status.symbol)) ranks.set(status.symbol, index);
    index++;
    if (cooperative) yield 'cheap';
  }
  return ranks;
}
function* prepareOrder<T extends TaskListValue>(
  tasks: readonly T[],
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<TaskOrder<T>> {
  const field = input.viewState.sortBy.field;
  const linkOrder =
    field === 'outgoing-link'
      ? yield* prepareLinks(tasks, input.outgoingLinks, cooperative)
      : new Map<T, readonly TaskLinkValue[]>();
  const trackedMs =
    field === 'tracked' ? yield* prepareTracked(tasks, input, cooperative) : new Map<T, number>();
  const statusOrder =
    field === 'status'
      ? yield* prepareStatuses(input.settings, cooperative)
      : new Map<string, number>();
  if (linkOrder === undefined || trackedMs === undefined || statusOrder === undefined)
    throw new Error('Order preparation ended without a result');
  return { input, linkOrder, trackedMs, statusOrder };
}
function* selectValues<T extends TaskListValue>(
  input: TaskValueSelectionInput<T>,
  cooperative: boolean,
): CollectionSteps<T[]> {
  const matching = cooperative ? yield* filterTaskValuesSteps(input) : filterTaskValues(input);
  if (matching === undefined) throw new Error('Selection ended without a result');
  if (matching.length < 2) return matching;
  const order = yield* prepareOrder(matching, input, cooperative);
  if (order === undefined) throw new Error('Order ended without a result');
  const comparator = (left: T, right: T): number => {
    const explicit = compare(left, right, order);
    if (explicit !== 0) return input.viewState.sortBy.dir === 'asc' ? explicit : -explicit;
    return compareCreated(left, right);
  };
  if (cooperative) return yield* stableSortSteps(matching, comparator);
  matching.sort(comparator);
  return matching;
}

export function selectTaskList(input: TaskListSelectionInput): readonly TaskSnapshot[] {
  const query = input.textQuery?.toLowerCase() ?? '';
  const tasks = input.tasks.filter(
    (task) =>
      query.length === 0 ||
      task.title.toLowerCase().includes(query) ||
      task.source.originalMarkdown.toLowerCase().includes(query),
  );
  const values: TaskValueSelectionInput<TaskSnapshot> = {
    ...input,
    treeTags: taskTreeTags,
    trackedMs: (task) => totalMs(subtreeTotal(task), input.nowMs),
  };
  const selection = input.selection;
  return selectTaskValues({
    ...values,
    tasks,
    ...(selection !== null && typeof selection === 'object' && selection.type === 'group'
      ? { observedTags: drainCollectionSteps(observedTags(values, false)) }
      : {}),
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
