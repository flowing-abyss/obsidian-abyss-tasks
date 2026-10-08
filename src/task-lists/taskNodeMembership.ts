import type { ListSelection } from '../app/AppState';
import { resolveListViewStateKey } from '../app/listViewState';
import { drainCollectionSteps, type CollectionSteps } from '../collectionSteps';
import { sameTag } from '../markdown/tagSyntax';
import {
  resolveEffectiveTagGroups,
  resolveEffectiveTagGroupsSteps,
  tagMatchesGroup,
  tagMatchesGroupSteps,
  type EffectiveTagGroup,
} from '../tags/effectiveTagGroups';
import {
  normalizeTaskTagInput,
  taskHasFutureDate,
  taskNodeSourceLine,
  taskTodayOccurrence,
  type LocalDate,
  type TaskNodeSnapshot,
  type TaskPlanning,
  type TaskStatus,
} from '../tasks';
import type { TaskOrganizationSettings } from './TaskListSelector';

export interface TaskMembershipValue {
  readonly depth: number;
  readonly tags: readonly string[];
  readonly planning: TaskPlanning;
  readonly status: TaskStatus;
  readonly statusSymbol: string;
  readonly source: { readonly filePath: string; readonly line: number };
}
export interface TaskMembershipContext {
  readonly selection: ListSelection | null;
  readonly settings: TaskOrganizationSettings;
  readonly today: LocalDate;
  readonly observedTags: readonly string[];
}
interface MembershipContext {
  readonly group: EffectiveTagGroup | undefined;
  readonly inboxTag: string | undefined;
}
export function isActiveTaskNode(value: Pick<TaskMembershipValue, 'status'>): boolean {
  return value.status === 'open' || value.status === 'in-progress';
}
export function taskNodeMembershipValue(task: TaskNodeSnapshot): TaskMembershipValue {
  return {
    depth: task.path.length,
    tags: task.node.tags,
    planning: task.node.planning,
    status: task.node.status,
    statusSymbol: task.node.statusSymbol,
    source: { filePath: task.root.source.filePath, line: taskNodeSourceLine(task.target) },
  };
}
/** Prepare catalog identity once per pass; cooperative callers retain nested checkpoints. */
export function* prepareTaskNodeMembershipSteps(
  input: TaskMembershipContext,
  cooperative: boolean,
): CollectionSteps<(value: TaskMembershipValue) => CollectionSteps<boolean>> {
  const group = yield* selectedGroup(input, cooperative);
  if (group === undefined) throw new Error('Group selection ended without a result');
  let inboxTag: string | undefined;
  if (input.selection === 'inbox') {
    const tags = normalizeTaskTagInput(input.settings.inbox.tag);
    if (cooperative) yield 'atom';
    inboxTag = tags?.length === 1 ? tags[0] : undefined;
  }
  return (value) => selected(value, input, { group: group ?? undefined, inboxTag }, cooperative);
}
function prepareTaskNodeMembership(
  context: TaskMembershipContext,
): (value: TaskMembershipValue) => boolean {
  const admits = drainCollectionSteps(prepareTaskNodeMembershipSteps(context, false));
  return (value) => drainCollectionSteps(admits(value));
}
export function admitsTaskNode(
  value: TaskMembershipValue,
  context: TaskMembershipContext,
): boolean {
  return prepareTaskNodeMembership(context)(value);
}
/** Navigation totals deliberately ignore center filters and count each physical node once. */
export function activeTaskNodes(
  tasks: readonly TaskNodeSnapshot[],
  context: TaskMembershipContext,
): readonly TaskNodeSnapshot[] {
  const admits = prepareTaskNodeMembership(context);
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const value = taskNodeMembershipValue(task);
    if (!isActiveTaskNode(value) || !admits(value)) return false;
    const key = JSON.stringify([value.source.filePath, value.source.line]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
function* selectedGroup(
  input: TaskMembershipContext,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup | null> {
  const selection = input.selection;
  if (selection === null || typeof selection === 'string' || selection.type !== 'group')
    return null;
  const observed = input.observedTags;
  const catalog = cooperative
    ? yield* resolveEffectiveTagGroupsSteps(input.settings, observed)
    : resolveEffectiveTagGroups(input.settings, observed);
  if (catalog === undefined) throw new Error('Catalog ended without a result');
  return yield* findSelectedGroup(catalog, selection.groupId, cooperative);
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
function* selectedInbox(
  task: TaskMembershipValue,
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
  return tagged || (settings.inbox.mode !== 'tag' && task.depth === 0 && task.tags.length === 0);
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
function* selectedObject(
  task: TaskMembershipValue,
  context: MembershipContext & { selection: Exclude<ListSelection, string> },
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { selection } = context;
  if (selection.type === 'project')
    return task.depth === 0 && task.source.filePath === selection.path;
  const tags = task.tags;
  if (cooperative) yield 'atom';
  if (selection.type === 'tag') return yield* matchesTags(tags, selection.tag, cooperative);
  return yield* selectedTree(tags, context.group, cooperative);
}
function* selected(
  task: TaskMembershipValue,
  input: TaskMembershipContext,
  context: MembershipContext,
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { selection, settings, today } = input;
  if (selection === 'inbox')
    return yield* selectedInbox(task, settings, context.inboxTag, cooperative);
  if (selection === 'today') return taskTodayOccurrence(task.planning, today) !== undefined;
  if (selection === 'upcoming') return taskHasFutureDate(task.planning, today);
  if (selection === null || typeof selection === 'string') return task.depth === 0;
  return yield* selectedObject(task, { ...context, selection }, cooperative);
}
