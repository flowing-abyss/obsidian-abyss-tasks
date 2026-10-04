import type { ListSelection } from '../app/AppState';
import type { SearchViewState } from '../panels/center/SearchViewState';
import type { CalendarSettings } from '../settings/types';
import { StatusRegistry } from '../status/StatusRegistry';
import type { LocalDate, TaskOrganizationRecord, TaskSearchAddress, TaskSearchHit } from '../tasks';
import { shiftLocalDate, totalMs } from '../tasks';
import {
  groupTasksByDate,
  groupTasksByOutgoingLink,
  groupTasksByPriority,
  groupTasksBySourceNote,
  groupTasksByStatus,
  groupTasksByTag,
  type TaskGroup,
} from '../views/taskGrouping';
import type { TaskLinkValues } from './taskLinkValues';
import { filterTaskValues, selectTaskValues } from './TaskListSelector';
export interface TaskSearchOccurrence {
  readonly key: string;
  readonly address: TaskSearchAddress;
  readonly score: number;
  readonly group: { readonly key: string; readonly label: string } | null;
}
export interface TaskSearchOrganization {
  readonly generation: number;
  readonly rootTotal: number;
  readonly occurrences: readonly TaskSearchOccurrence[];
  readonly groupCounts: ReadonlyMap<string, number>;
}
export interface TaskSearchOrganizationInput {
  readonly generation: number;
  readonly records: readonly TaskOrganizationRecord[];
  readonly hits: readonly TaskSearchHit[] | null;
  readonly selection: ListSelection | null;
  readonly view: SearchViewState;
  readonly settings: CalendarSettings;
  readonly today: LocalDate;
  readonly nowMs: number;
  readonly outgoingLinks: TaskLinkValues;
}
export function organizeTaskSearch(input: TaskSearchOrganizationInput): TaskSearchOrganization {
  const scores = new Map(input.hits?.map((hit) => [hit.address.rootId, hit.score]));
  const records =
    input.hits === null ? input.records : input.records.filter((r) => scores.has(r.address.rootId));
  // Stable canonical order is the last tie break, irrespective of engine relevance ordering.
  const canonical = input.view.relevance ? records : [...records].sort(compareSource);
  const selectionInput = {
    ...input,
    tasks: canonical,
    viewState: input.view.list,
    treeTags: (r: TaskOrganizationRecord) => r.treeTags,
    trackedMs: (r: TaskOrganizationRecord) => totalMs(r.tracked, input.nowMs),
  };
  const selected = input.view.relevance
    ? filterTaskValues(selectionInput)
    : selectTaskValues(selectionInput);
  const selectedByRoot = new Map(selected.map((r) => [r.address.rootId, r]));
  const matching =
    input.view.relevance && input.hits !== null
      ? input.hits.flatMap((hit) => {
          const record = selectedByRoot.get(hit.address.rootId);
          return record === undefined ? [] : [record];
        })
      : selected;
  const groupBy = input.view.list.groupBy;
  const groups = organizationGroups(matching, input);
  const groupCounts = new Map(groups.map((group) => [group.key, group.tasks.length]));
  const occurrence = (
    r: TaskOrganizationRecord,
    group: { key: string; label: string } | null,
  ): TaskSearchOccurrence => {
    const physical = `${r.source.filePath}:${r.source.line}`;
    return {
      key:
        groupBy === 'outgoing-link' && group !== null
          ? JSON.stringify(['task-occurrence', 'outgoing-link', group.key, physical])
          : physical,
      address: r.address,
      score: scores.get(r.address.rootId) ?? 0,
      group,
    };
  };
  return {
    generation: input.generation,
    rootTotal: matching.length,
    groupCounts,
    occurrences:
      groupBy === 'none'
        ? matching.map((r) => occurrence(r, null))
        : groups.flatMap((group) =>
            group.tasks.map((r) => occurrence(r, { key: group.key, label: group.label })),
          ),
  };
}
function organizationGroups(
  records: readonly TaskOrganizationRecord[],
  input: TaskSearchOrganizationInput,
): Array<TaskGroup<TaskOrganizationRecord>> {
  switch (input.view.list.groupBy) {
    case 'none':
      return [];
    case 'priority':
      return groupTasksByPriority(records);
    case 'date':
      return groupTasksByDate(records, input.today, shiftLocalDate(input.today, 1) ?? input.today);
    case 'tag':
      return groupTasksByTag(records);
    case 'status':
      return groupTasksByStatus(records, new StatusRegistry(input.settings.taskStatuses));
    case 'source-note':
      return groupTasksBySourceNote(records);
    case 'outgoing-link':
      return groupTasksByOutgoingLink(records, input.outgoingLinks);
  }
}

function compareSource(a: TaskOrganizationRecord, b: TaskOrganizationRecord): number {
  const path = a.source.filePath.localeCompare(b.source.filePath);
  return path !== 0 ? path : a.source.line - b.source.line;
}
