import type { ListSelection } from '../app/AppState';
import { stableSortSteps, type CollectionSteps } from '../collectionSteps';
import type { SearchViewState } from '../panels/center/SearchViewState';
import { buildTaskDailyRowsSteps } from '../panels/task-list/taskDailyRows';
import {
  dateGroupMetadata,
  indexedRows,
  omitLoneTodayHeader,
  type TaskListRow,
  type TaskListRows,
} from '../panels/task-list/taskListRows';
import { withTaskRevealRows } from '../panels/task-list/taskRevealRows';
import { StatusRegistry } from '../status/StatusRegistry';
import type { LocalDate, TaskOrganizationRecord, TaskSearchAddress, TaskSearchHit } from '../tasks';
import { TaskSearchError, shiftLocalDate, taskSearchAddressKey, totalMs } from '../tasks';
import {
  groupTasksByDateSteps,
  groupTasksByOutgoingLinkSteps,
  groupTasksByPrioritySteps,
  groupTasksBySourceNoteSteps,
  groupTasksByStatusSteps,
  groupTasksByTagSteps,
  type TaskGroup,
} from '../views/taskGrouping';
import type { TaskLinkValues } from './taskLinkValues';
import {
  filterTaskValuesSteps,
  selectTaskValuesSteps,
  taskValueComparatorSteps,
  type TaskOrganizationSettings,
} from './TaskListSelector';
import type { TaskOccurrencePresentation } from './taskOccurrencePresentation';
import { todayTaskOccurrence } from './todayTaskCategory';
export type TaskSearchMenuSummary = Pick<
  TaskOrganizationRecord,
  'status' | 'statusSymbol' | 'priority' | 'planning' | 'tags'
>;
export interface TaskSearchOccurrence {
  readonly depth: number;
  readonly presentation: TaskOccurrencePresentation;
  readonly taskKey: string;
  readonly menu: TaskSearchMenuSummary;
  readonly key: string;
  readonly address: TaskSearchAddress;
  readonly score: number;
  readonly group: { readonly key: string; readonly label: string } | null;
}
export type TaskSearchOrganization = {
  readonly generation: number;
  readonly revealIndex?: number;
  readonly revealTarget?: TaskSearchAddress | undefined;
  readonly rows: TaskListRows<TaskSearchOccurrence>;
} & (
  | { readonly scope: 'roots'; readonly rootTotal: number }
  | { readonly scope: 'nodes'; readonly nodeTotal: number }
);
export interface TaskSearchOrganizationInput {
  readonly scope?: 'roots' | 'nodes';
  readonly revision?: string;
  readonly revealReceiptId?: string | undefined;
  readonly formatDate?: (date: LocalDate) => string;
  /** Full canonical tags, independent of query hits, for selected group identity. */
  readonly observedTags?: readonly string[];
  readonly generation: number;
  readonly reveal?: TaskSearchAddress | undefined;
  readonly revealKind?: 'navigation' | 'creation' | undefined;
  readonly records: readonly TaskOrganizationRecord[];
  readonly hits: readonly TaskSearchHit[] | null;
  readonly selection: ListSelection | null;
  readonly view: SearchViewState;
  readonly settings: TaskOrganizationSettings;
  readonly today: LocalDate;
  readonly nowMs: number;
  readonly outgoingLinks: TaskLinkValues;
}
function rootRelevance(input: TaskSearchOrganizationInput): boolean {
  return input.scope !== 'nodes' && input.view.relevance;
}
function* scoreMap(input: TaskSearchOrganizationInput): CollectionSteps<Map<string, number>> {
  const scores = new Map<string, number>();
  for (const hit of input.hits ?? []) {
    scores.set(taskSearchAddressKey(hit.address), hit.score);
    yield 'cheap';
  }
  return scores;
}
function* canonicalRecords(
  input: TaskSearchOrganizationInput,
  scores: ReadonlyMap<string, number>,
): CollectionSteps<TaskOrganizationRecord[]> {
  const canonical: TaskOrganizationRecord[] = [];
  for (const record of input.records) {
    if (
      ((input.scope ?? 'roots') === 'nodes' || record.depth === 0) &&
      (input.hits === null || scores.has(taskSearchAddressKey(record.address)))
    )
      canonical.push(record);
    yield 'cheap';
  }
  if (rootRelevance(input)) return canonical;
  return yield* stableSortSteps(canonical, compareSource);
}
function* restoreRelevance(
  selected: readonly TaskOrganizationRecord[],
  hits: readonly TaskSearchHit[],
): CollectionSteps<TaskOrganizationRecord[]> {
  const byRoot = new Map<number, TaskOrganizationRecord>();
  const matching: TaskOrganizationRecord[] = [];
  try {
    for (const record of selected) {
      byRoot.set(record.address.rootId, record);
      yield 'cheap';
    }
    for (const hit of hits) {
      const record = byRoot.get(hit.address.rootId);
      if (record !== undefined) matching.push(record);
      yield 'cheap';
    }
    return matching;
  } finally {
    byRoot.clear();
  }
}
function* matchingRecords(
  input: TaskSearchOrganizationInput,
  scores: ReadonlyMap<string, number>,
): CollectionSteps<TaskOrganizationRecord[]> {
  const canonical = yield* canonicalRecords(input, scores);
  if (canonical === undefined) throw new Error('Canonical ordering ended without a result');
  const selection = {
    ...input,
    tasks: canonical,
    viewState: input.view.list,
    depth: (r: TaskOrganizationRecord) => r.depth,
    treeTags: (r: TaskOrganizationRecord) => r.treeTags,
    trackedMs: (r: TaskOrganizationRecord) => totalMs(r.tracked, input.nowMs),
  };
  const selected = yield* rootRelevance(input)
    ? filterTaskValuesSteps(selection)
    : selectTaskValuesSteps(selection);
  if (selected === undefined) throw new Error('Selection ended without a result');
  if (rootRelevance(input) && input.hits !== null)
    return yield* restoreRelevance(selected, input.hits);
  return selected;
}
interface AncestryNode {
  readonly children: Map<number, AncestryNode>;
  record?: TaskOrganizationRecord;
}
function rootIdentity(address: TaskSearchAddress): string {
  return JSON.stringify([address.epoch, address.version, address.rootId]);
}
function* insertAddress(
  roots: Map<string, AncestryNode>,
  record: TaskOrganizationRecord,
): CollectionSteps<boolean> {
  const key = rootIdentity(record.address);
  let node = roots.get(key);
  if (node === undefined) {
    node = { children: new Map() };
    roots.set(key, node);
  }
  for (const line of record.address.childLines) {
    let child: AncestryNode | undefined = node.children.get(line);
    if (child === undefined) {
      child = { children: new Map() };
      node.children.set(line, child);
    }
    node = child;
    yield 'cheap';
  }
  node.record = record;
  yield 'cheap';
  return true;
}
function* addressOwner(
  roots: ReadonlyMap<string, AncestryNode>,
  address: TaskSearchAddress,
): CollectionSteps<TaskOrganizationRecord | null> {
  let node = roots.get(rootIdentity(address));
  if (node?.record !== undefined) return node.record;
  for (const line of address.childLines) {
    node = node?.children.get(line);
    yield 'cheap';
    if (node?.record !== undefined) return node.record;
    if (node === undefined) return null;
  }
  return null;
}
function* revealRecord(
  input: TaskSearchOrganizationInput,
): CollectionSteps<TaskOrganizationRecord | null> {
  if (input.reveal === undefined) return null;
  const key = taskSearchAddressKey(input.reveal);
  for (const record of input.records) {
    yield 'cheap';
    if (taskSearchAddressKey(record.address) === key) return record;
  }
  throw new TaskSearchError('stale', 'Reveal target changed');
}
function* matchingRoots(records: readonly TaskOrganizationRecord[]): CollectionSteps<Set<number>> {
  const roots = new Set<number>();
  for (const record of records) {
    roots.add(record.address.rootId);
    yield 'cheap';
  }
  return roots;
}
function* outermostRecords(
  roots: ReadonlyMap<string, AncestryNode>,
  matching: readonly TaskOrganizationRecord[],
): CollectionSteps<TaskOrganizationRecord[]> {
  const retained: TaskOrganizationRecord[] = [];
  for (const record of matching) {
    const owner = yield* addressOwner(roots, record.address);
    if (owner?.address.childLines.length === record.address.childLines.length)
      retained.push(record);
    yield 'cheap';
  }
  return retained;
}
function dailyOrganization(input: TaskSearchOrganizationInput): boolean {
  return (
    input.scope === 'nodes' &&
    input.selection === 'upcoming' &&
    input.view.list.groupBy === 'date' &&
    (input.view.list.view === undefined || input.view.list.view === 'list')
  );
}
function* ownedRecords(
  input: TaskSearchOrganizationInput,
  matching: readonly TaskOrganizationRecord[],
): CollectionSteps<{
  matching: readonly TaskOrganizationRecord[];
  reveal: TaskOrganizationRecord | null;
}> {
  let reveal = (yield* revealRecord(input)) ?? null;
  if (input.scope !== 'nodes' || input.hits === null) return { matching, reveal };
  const roots = new Map<string, AncestryNode>();
  // Populate every candidate before querying: ordinary sorting may put children first.
  for (const record of matching) yield* insertAddress(roots, record);
  if (reveal !== null) yield* insertAddress(roots, reveal);
  const retained = yield* outermostRecords(roots, matching);
  if (retained === undefined) throw new Error('Ancestry traversal ended without a result');
  if (reveal !== null) reveal = (yield* addressOwner(roots, reveal.address)) ?? null;
  return { matching: retained, reveal };
}
function occurrence(
  record: TaskOrganizationRecord,
  group: TaskSearchOccurrence['group'],
  outgoing: boolean,
  context: { scores: ReadonlyMap<string, number>; menus: Map<string, TaskSearchMenuSummary> },
): TaskSearchOccurrence {
  const physical = `${record.source.filePath}:${record.source.line}`;
  const { scores, menus } = context;
  let menu = menus.get(taskSearchAddressKey(record.address));
  if (menu === undefined) {
    menu = {
      status: record.status,
      statusSymbol: record.statusSymbol,
      priority: record.priority,
      planning: record.planning,
      tags: record.tags,
    };
    menus.set(taskSearchAddressKey(record.address), menu);
  }
  return {
    depth: record.depth,
    presentation: { kind: 'node', completion: { kind: 'allowed' } },
    taskKey: physical,
    menu,
    key:
      outgoing && group !== null
        ? JSON.stringify(['task-occurrence', 'outgoing-link', group.key, physical])
        : physical,
    address: record.address,
    score: scores.get(taskSearchAddressKey(record.address)) ?? 0,
    group,
  };
}
function authoredInterval(record: TaskOrganizationRecord): TaskOccurrencePresentation['interval'] {
  const { start, due } = record.planning;
  return start !== undefined && due !== undefined && start <= due ? { start, due } : undefined;
}
function presentation(
  record: TaskOrganizationRecord,
  input: TaskSearchOrganizationInput,
): TaskOccurrencePresentation {
  const interval = authoredInterval(record);
  const today =
    input.scope === 'nodes' && input.selection === 'today'
      ? todayTaskOccurrence(record, input.today)
      : undefined;
  return {
    kind: today === undefined ? 'node' : 'today',
    ...(interval === undefined ? {} : { interval }),
    ...(today === undefined ? {} : { displayDate: today.displayDate }),
    completion: today?.completion ?? { kind: 'allowed' },
  };
}
interface OrganizationContext {
  readonly input: TaskSearchOrganizationInput;
  readonly matching: readonly TaskOrganizationRecord[];
  readonly revision: string;
  makeOccurrence(
    this: void,
    record: TaskOrganizationRecord,
    group: TaskSearchOccurrence['group'],
  ): TaskSearchOccurrence;
}
function* dailyRows(
  context: OrganizationContext,
): CollectionSteps<TaskListRows<TaskSearchOccurrence>> {
  const { input, matching, revision, makeOccurrence } = context;
  const compare = yield* taskValueComparatorSteps(
    {
      ...input,
      tasks: matching,
      viewState: input.view.list,
      depth: (r) => r.depth,
      treeTags: (r) => r.treeTags,
      trackedMs: (r) => totalMs(r.tracked, input.nowMs),
    },
    { kind: 'same-day' },
  );
  if (compare === undefined) throw new Error('Comparator ended without a result');
  const daily = yield* buildTaskDailyRowsSteps({
    revision,
    records: matching,
    today: input.today,
    direction: input.view.list.sortBy.field === 'date' ? input.view.list.sortBy.dir : 'asc',
    compareWithinDay: compare,
    formatDate: input.formatDate ?? ((date) => date),
    occurrence: (record, date) =>
      makeOccurrence(record, { key: date, label: input.formatDate?.(date) ?? date }),
  });
  if (daily === undefined) throw new Error('Daily rows ended without a result');
  return daily;
}
function* appendGroupRows(
  context: OrganizationContext,
  group: { key: string; label: string; tasks: readonly TaskOrganizationRecord[] },
  finite: Array<TaskListRow<TaskSearchOccurrence>>,
): CollectionSteps<boolean> {
  const grouped = context.input.view.list.groupBy !== 'none';
  const groupKey = grouped ? `group:${context.input.view.list.groupBy}:${group.key}` : undefined;
  for (const record of group.tasks) {
    const task = context.makeOccurrence(
      record,
      grouped ? { key: group.key, label: group.label } : null,
    );
    finite.push({
      kind: 'task',
      key: task.key,
      taskKey: task.taskKey,
      task,
      ...(groupKey === undefined ? {} : { groupKey }),
      presentation: task.presentation,
    });
    yield 'atom';
  }
  return true;
}
function* finiteRows(
  context: OrganizationContext,
): CollectionSteps<TaskListRows<TaskSearchOccurrence>> {
  const { input, matching, revision } = context;
  const finite: Array<TaskListRow<TaskSearchOccurrence>> = [];
  const groups =
    input.view.list.groupBy === 'none'
      ? [{ key: '', label: '', tasks: matching }]
      : yield* organizationGroups(matching, input);
  if (groups === undefined) throw new Error('Groups ended without a result');
  const nonempty = groups.filter((group) => group.tasks.length > 0);
  const omitTodayHeader = omitLoneTodayHeader(nonempty, {
    by: input.view.list.groupBy,
    todayList: input.selection === 'today',
  });
  for (const group of nonempty) {
    const grouped = input.view.list.groupBy !== 'none';
    if (grouped && !omitTodayHeader)
      finite.push({
        kind: 'group',
        key: `group:${input.view.list.groupBy}:${group.key}`,
        label: group.label,
        ...(input.view.list.groupBy === 'date' && {
          dateGroup: dateGroupMetadata(
            group.key,
            input.today,
            shiftLocalDate(input.today, 1) ?? input.today,
          ),
        }),
        count: group.tasks.length,
        first: finite.length === 0,
        ...(input.view.list.groupBy === 'source-note' ? { sourcePath: group.key } : {}),
      });
    yield 'cheap';
    yield* appendGroupRows(context, group, finite);
  }

  return indexedRows(finite, revision);
}
function* revealRows(
  context: OrganizationContext,
  rows: TaskListRows<TaskSearchOccurrence>,
  ownerRoots: ReadonlySet<number>,
  record: TaskOrganizationRecord | null,
): CollectionSteps<ReturnType<typeof withTaskRevealRows> | null> {
  const { input, makeOccurrence } = context;
  if (record === null) return null;
  yield 'cheap';
  const reveal = withTaskRevealRows(rows, {
    occurrence: makeOccurrence(record, null),
    generation: input.generation,
    kind: input.revealKind ?? 'navigation',
    receiptId: input.revealReceiptId ?? taskSearchAddressKey(record.address),
    ownerRootPresent: ownerRoots.has(record.address.rootId),
  });
  return reveal;
}
export function* organizeTaskSearch(
  input: TaskSearchOrganizationInput,
): CollectionSteps<TaskSearchOrganization> {
  const scores = yield* scoreMap(input);
  if (scores === undefined) throw new Error('Scores ended without a result');
  const selected = yield* matchingRecords(input, scores);
  if (selected === undefined) throw new Error('Matching ended without a result');
  const owned = yield* ownedRecords(input, selected);
  if (owned === undefined) throw new Error('Ownership ended without a result');
  const { matching } = owned;
  const menus = new Map<string, TaskSearchMenuSummary>();
  const context: OrganizationContext = {
    input,
    matching,
    revision:
      input.revision ??
      JSON.stringify([
        'organization',
        input.generation,
        input.scope,
        input.selection,
        input.view,
        input.today,
        input.nowMs,
      ]),
    makeOccurrence: (record, group) => ({
      ...occurrence(record, group, input.view.list.groupBy === 'outgoing-link', { scores, menus }),
      presentation: presentation(record, input),
    }),
  };
  const ownerRoots = (yield* matchingRoots(matching)) ?? new Set<number>();
  const daily = dailyOrganization(input);
  const base = yield* daily ? dailyRows(context) : finiteRows(context);
  if (base === undefined) throw new Error('Rows ended without a result');
  const reveal = yield* revealRows(context, base, ownerRoots, owned.reveal);
  if (reveal === undefined) throw new Error('Reveal ended without a result');
  return organizationResult(context, base, reveal, ownerRoots);
}
function organizationResult(
  context: OrganizationContext,
  base: TaskListRows<TaskSearchOccurrence>,
  reveal: ReturnType<typeof withTaskRevealRows> | null,
  ownerRoots: ReadonlySet<number>,
): TaskSearchOrganization {
  const { input, matching } = context;
  return {
    generation: input.generation,
    rows: reveal?.rows ?? base,
    ...(reveal === null ? {} : { revealIndex: reveal.revealIndex, revealTarget: input.reveal }),
    ...(input.scope === 'nodes'
      ? { scope: 'nodes', nodeTotal: matching.length + (reveal?.addedNodeCount ?? 0) }
      : { scope: 'roots', rootTotal: ownerRoots.size + (reveal?.addedRootCount ?? 0) }),
  };
}
function* organizationGroups(
  records: readonly TaskOrganizationRecord[],
  input: TaskSearchOrganizationInput,
): CollectionSteps<Array<TaskGroup<TaskOrganizationRecord>>> {
  switch (input.view.list.groupBy) {
    case 'none':
      return [];
    case 'priority':
      return yield* groupTasksByPrioritySteps(records);
    case 'date':
      return yield* groupTasksByDateSteps(
        records,
        input.today,
        shiftLocalDate(input.today, 1) ?? input.today,
        input.selection === 'today',
      );
    case 'tag':
      return yield* groupTasksByTagSteps(records);
    case 'status': {
      const registry = new StatusRegistry(input.settings.taskStatuses);
      yield 'atom';
      return yield* groupTasksByStatusSteps(records, registry);
    }
    case 'source-note':
      return yield* groupTasksBySourceNoteSteps(records);
    case 'outgoing-link':
      return yield* groupTasksByOutgoingLinkSteps(records, input.outgoingLinks);
  }
}

function compareSource(a: TaskOrganizationRecord, b: TaskOrganizationRecord): number {
  const path = a.source.filePath.localeCompare(b.source.filePath);
  return path !== 0 ? path : a.source.line - b.source.line;
}
