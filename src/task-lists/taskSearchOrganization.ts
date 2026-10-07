import type { ListSelection } from '../app/AppState';
import { stableSortSteps, type CollectionSteps } from '../collectionSteps';
import type { SearchViewState } from '../panels/center/SearchViewState';
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
  type TaskOrganizationSettings,
} from './TaskListSelector';
import type { TaskOccurrencePresentation } from './taskOccurrencePresentation';
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
  readonly occurrences: readonly TaskSearchOccurrence[];
  readonly groupCounts: ReadonlyMap<string, number>;
} & (
  | { readonly scope: 'roots'; readonly rootTotal: number }
  | { readonly scope: 'nodes'; readonly nodeTotal: number }
);
export interface TaskSearchOrganizationInput {
  readonly scope?: 'roots' | 'nodes';
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
function* appendOccurrences(
  records: readonly TaskOrganizationRecord[],
  group: TaskSearchOccurrence['group'],
  context: {
    menus: Map<string, TaskSearchMenuSummary>;
    outgoing: boolean;
    scores: ReadonlyMap<string, number>;
    output: TaskSearchOccurrence[];
  },
): CollectionSteps<boolean> {
  const { output, outgoing, scores } = context;
  for (const record of records) {
    output.push(occurrence(record, group, outgoing, { scores, menus: context.menus }));
    yield 'atom';
  }
  return true;
}
function* groupedOccurrences(
  input: TaskSearchOrganizationInput,
  records: readonly TaskOrganizationRecord[],
  scores: ReadonlyMap<string, number>,
  output: {
    counts: Map<string, number>;
    occurrences: TaskSearchOccurrence[];
    menus: Map<string, TaskSearchMenuSummary>;
  },
): CollectionSteps<boolean> {
  const groups = yield* organizationGroups(records, input);
  if (groups === undefined) throw new Error('Grouping ended without a result');
  for (const group of groups) {
    output.counts.set(group.key, group.tasks.length);
    yield 'cheap';
    const appended = yield* appendOccurrences(
      group.tasks,
      { key: group.key, label: group.label },
      {
        menus: output.menus,
        outgoing: input.view.list.groupBy === 'outgoing-link',
        scores,
        output: output.occurrences,
      },
    );
    if (appended === undefined) throw new Error('Occurrences ended without a result');
    group.tasks.length = 0;
    yield 'cheap';
  }
  return true;
}
export function* organizeTaskSearch(
  input: TaskSearchOrganizationInput,
): CollectionSteps<TaskSearchOrganization> {
  const menus = new Map<string, TaskSearchMenuSummary>();
  const scores = yield* scoreMap(input);
  if (scores === undefined) throw new Error('Scores ended without a result');
  let matching: TaskOrganizationRecord[] = [],
    occurrences: TaskSearchOccurrence[] = [];
  let groupCounts = new Map<string, number>();
  try {
    const selected = yield* matchingRecords(input, scores);
    if (selected === undefined) throw new Error('Matching ended without a result');
    matching = selected;
    const rootTotal = matching.length;
    const appended =
      input.view.list.groupBy === 'none'
        ? yield* appendOccurrences(matching, null, {
            menus,
            outgoing: false,
            scores,
            output: occurrences,
          })
        : yield* groupedOccurrences(input, matching, scores, {
            counts: groupCounts,
            occurrences,
            menus,
          });
    if (appended === undefined) throw new Error('Organization ended without a result');
    const revealIndex = yield* revealOccurrence(input, occurrences, groupCounts);
    return {
      generation: input.generation,
      ...(input.scope === 'nodes'
        ? { scope: 'nodes' as const, nodeTotal: rootTotal + Number(revealIndex?.added === true) }
        : { scope: 'roots' as const, rootTotal: rootTotal + Number(revealIndex?.added === true) }),
      groupCounts,
      occurrences,
      ...(revealIndex === undefined ? {} : { revealIndex: revealIndex.index }),
    };
  } finally {
    scores.clear();
    menus.clear();
    matching = [];
    occurrences = [];
    groupCounts = new Map();
  }
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

function revealGroup(kind: TaskSearchOrganizationInput['revealKind']): {
  key: string;
  label: string;
} {
  return { key: 'search-reveal', label: kind === 'creation' ? 'Created task' : 'Revealed task' };
}
function* revealOccurrence(
  input: TaskSearchOrganizationInput,
  occurrences: TaskSearchOccurrence[],
  counts: Map<string, number>,
): CollectionSteps<{ index: number; added: boolean } | undefined> {
  const target = input.reveal;
  if (target === undefined) return undefined;
  let record: TaskOrganizationRecord | undefined;
  for (const candidate of input.records) {
    if (taskSearchAddressKey(candidate.address) === taskSearchAddressKey(target))
      record = candidate;
    yield 'cheap';
  }
  if (record === undefined) throw new TaskSearchError('stale', 'Reveal target changed');
  for (let index = 0; index < occurrences.length; index++) {
    const item = occurrences[index];
    if (item !== undefined && taskSearchAddressKey(item.address) === taskSearchAddressKey(target))
      return { index, added: false };
    yield 'cheap';
  }
  const index = occurrences.length;
  const group = revealGroup(input.revealKind);
  counts.set(group.key, 1);
  occurrences.push({
    depth: record.depth,
    presentation: { kind: 'node', completion: { kind: 'allowed' } },
    taskKey: `${record.source.filePath}:${record.source.line}`,
    menu: {
      status: record.status,
      statusSymbol: record.statusSymbol,
      priority: record.priority,
      planning: record.planning,
      tags: record.tags,
    },
    key: `search-reveal:${taskSearchAddressKey(target)}`,
    address: record.address,
    score: 0,
    group,
  });
  yield 'atom';
  return { index, added: true };
}
