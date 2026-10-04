import type { ListSelection } from '../app/AppState';
import { stableSortSteps, type CollectionSteps } from '../collectionSteps';
import type { SearchViewState } from '../panels/center/SearchViewState';
import { StatusRegistry } from '../status/StatusRegistry';
import type { LocalDate, TaskOrganizationRecord, TaskSearchAddress, TaskSearchHit } from '../tasks';
import { TaskSearchError, shiftLocalDate, totalMs } from '../tasks';
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
export interface TaskSearchOccurrence {
  readonly key: string;
  readonly address: TaskSearchAddress;
  readonly score: number;
  readonly group: { readonly key: string; readonly label: string } | null;
}
export interface TaskSearchOrganization {
  readonly generation: number;
  readonly rootTotal: number;
  readonly revealIndex?: number;
  readonly occurrences: readonly TaskSearchOccurrence[];
  readonly groupCounts: ReadonlyMap<string, number>;
}
export interface TaskSearchOrganizationInput {
  /** Full canonical tags, independent of query hits, for selected group identity. */
  readonly observedTags?: readonly string[];
  readonly generation: number;
  readonly reveal?: TaskSearchAddress | undefined;
  readonly records: readonly TaskOrganizationRecord[];
  readonly hits: readonly TaskSearchHit[] | null;
  readonly selection: ListSelection | null;
  readonly view: SearchViewState;
  readonly settings: TaskOrganizationSettings;
  readonly today: LocalDate;
  readonly nowMs: number;
  readonly outgoingLinks: TaskLinkValues;
}
function* scoreMap(input: TaskSearchOrganizationInput): CollectionSteps<Map<number, number>> {
  const scores = new Map<number, number>();
  for (const hit of input.hits ?? []) {
    scores.set(hit.address.rootId, hit.score);
    yield 'cheap';
  }
  return scores;
}
function* canonicalRecords(
  input: TaskSearchOrganizationInput,
  scores: ReadonlyMap<number, number>,
): CollectionSteps<TaskOrganizationRecord[]> {
  const canonical: TaskOrganizationRecord[] = [];
  for (const record of input.records) {
    if (input.hits === null || scores.has(record.address.rootId)) canonical.push(record);
    yield 'cheap';
  }
  if (input.view.relevance) return canonical;
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
  scores: ReadonlyMap<number, number>,
): CollectionSteps<TaskOrganizationRecord[]> {
  const canonical = yield* canonicalRecords(input, scores);
  if (canonical === undefined) throw new Error('Canonical ordering ended without a result');
  const selection = {
    ...input,
    tasks: canonical,
    viewState: input.view.list,
    treeTags: (r: TaskOrganizationRecord) => r.treeTags,
    trackedMs: (r: TaskOrganizationRecord) => totalMs(r.tracked, input.nowMs),
  };
  const selected = yield* input.view.relevance
    ? filterTaskValuesSteps(selection)
    : selectTaskValuesSteps(selection);
  if (selected === undefined) throw new Error('Selection ended without a result');
  if (input.view.relevance && input.hits !== null)
    return yield* restoreRelevance(selected, input.hits);
  return selected;
}
function occurrence(
  record: TaskOrganizationRecord,
  group: TaskSearchOccurrence['group'],
  outgoing: boolean,
  scores: ReadonlyMap<number, number>,
): TaskSearchOccurrence {
  const physical = `${record.source.filePath}:${record.source.line}`;
  return {
    key:
      outgoing && group !== null
        ? JSON.stringify(['task-occurrence', 'outgoing-link', group.key, physical])
        : physical,
    address: record.address,
    score: scores.get(record.address.rootId) ?? 0,
    group,
  };
}
function* appendOccurrences(
  records: readonly TaskOrganizationRecord[],
  group: TaskSearchOccurrence['group'],
  context: {
    outgoing: boolean;
    scores: ReadonlyMap<number, number>;
    output: TaskSearchOccurrence[];
  },
): CollectionSteps<boolean> {
  const { output, outgoing, scores } = context;
  for (const record of records) {
    output.push(occurrence(record, group, outgoing, scores));
    yield 'atom';
  }
  return true;
}
function* groupedOccurrences(
  input: TaskSearchOrganizationInput,
  records: readonly TaskOrganizationRecord[],
  scores: ReadonlyMap<number, number>,
  output: { counts: Map<string, number>; occurrences: TaskSearchOccurrence[] },
): CollectionSteps<boolean> {
  const groups = yield* organizationGroups(records, input);
  if (groups === undefined) throw new Error('Grouping ended without a result');
  for (const group of groups) {
    output.counts.set(group.key, group.tasks.length);
    yield 'cheap';
    const appended = yield* appendOccurrences(
      group.tasks,
      { key: group.key, label: group.label },
      { outgoing: input.view.list.groupBy === 'outgoing-link', scores, output: output.occurrences },
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
        ? yield* appendOccurrences(matching, null, { outgoing: false, scores, output: occurrences })
        : yield* groupedOccurrences(input, matching, scores, { counts: groupCounts, occurrences });
    if (appended === undefined) throw new Error('Organization ended without a result');
    const revealIndex = yield* revealOccurrence(input, occurrences, groupCounts);
    return {
      generation: input.generation,
      rootTotal: rootTotal + Number(revealIndex?.added === true),
      groupCounts,
      occurrences,
      ...(revealIndex === undefined ? {} : { revealIndex: revealIndex.index }),
    };
  } finally {
    scores.clear();
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

function* revealOccurrence(
  input: TaskSearchOrganizationInput,
  occurrences: TaskSearchOccurrence[],
  counts: Map<string, number>,
): CollectionSteps<{ index: number; added: boolean } | undefined> {
  const target = input.reveal;
  if (target === undefined) return undefined;
  let record: TaskOrganizationRecord | undefined;
  for (const candidate of input.records) {
    if (
      candidate.address.rootId === target.rootId &&
      candidate.address.epoch === target.epoch &&
      candidate.address.version === target.version
    )
      record = candidate;
    yield 'cheap';
  }
  if (record === undefined) throw new TaskSearchError('stale', 'Reveal target changed');
  for (let index = 0; index < occurrences.length; index++) {
    if (occurrences[index]?.address.rootId === target.rootId) return { index, added: false };
    yield 'cheap';
  }
  const index = occurrences.length;
  const group = { key: 'search-reveal', label: 'Revealed from search' };
  counts.set(group.key, 1);
  occurrences.push({
    key: `search-reveal:${target.rootId}`,
    address: record.address,
    score: 0,
    group,
  });
  yield 'atom';
  return { index, added: true };
}
