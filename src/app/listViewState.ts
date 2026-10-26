import { tagComparisonKey } from '../markdown/tagSyntax';
import { getListViewDefaults } from '../settings/defaults';
import type { ListViewState } from '../settings/types';
import { ALL_STATUS_GROUPS } from '../status/statusConstants';
import { taskKanbanCustomized } from '../task-lists/taskKanbanSettings';
import { taskTimelineCustomized } from '../task-lists/taskTimelineSettings';
import type { TaskStatusType } from '../tasks/domain/types';
import type { ListSelection } from './AppState';

/** Stable persistence key for a left-panel selection (matches CenterPanel's `listViewStates` keys). */
export function listSelectionToKey(sel: ListSelection): string {
  if (typeof sel === 'string') return sel;
  if (sel.type === 'tag') return `tag:${sel.tag}`;
  if (sel.type === 'project') return `project:${sel.path}`;
  return `group:${sel.groupId}`;
}

function canonicalDerivedKey(key: string, configuredGroupIds: ReadonlySet<string>): string {
  if (key.startsWith('tag:')) return `tag:${tagComparisonKey(key.slice(4))}`;
  const match = /^group:discovered:(tag|prefix):(.+)$/u.exec(key);
  if (match === null || configuredGroupIds.has(key.slice(6))) return key;
  const kind = match[1],
    encoded = match[2];
  if (kind === undefined || encoded === undefined) return key;
  try {
    return `group:discovered:${kind}:${encodeURIComponent(tagComparisonKey(decodeURIComponent(encoded)))}`;
  } catch {
    return key;
  }
}
/** Read-time aliases preserve physical saved keys; configured IDs always retain their own key. */
export function resolveListViewStateKey(
  selection: ListSelection,
  states: Record<string, ListViewState> | undefined,
  configuredGroupIds: ReadonlySet<string>,
): string {
  const exact = listSelectionToKey(selection);
  if (
    typeof selection === 'object' &&
    selection.type === 'group' &&
    configuredGroupIds.has(selection.groupId)
  )
    return exact;
  if (states?.[exact] !== undefined) return exact;
  const wanted = canonicalDerivedKey(exact, configuredGroupIds);
  const alias = Object.keys(states ?? {})
    .filter((key) => canonicalDerivedKey(key, configuredGroupIds) === wanted)
    .sort((a, b) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    })[0];
  return alias ?? wanted;
}

// undefined, or all 4 groups selected, both mean "no filtering" (show everything) —
// normalize to undefined so the two representations compare equal.
export function normalizeStatusGroups(
  statusGroups: TaskStatusType[] | undefined,
): TaskStatusType[] | undefined {
  if (
    statusGroups == null ||
    statusGroups.length === 0 ||
    statusGroups.length >= ALL_STATUS_GROUPS.length
  ) {
    return undefined;
  }
  return statusGroups;
}

export function statusGroupsEqual(
  a: TaskStatusType[] | undefined,
  b: TaskStatusType[] | undefined,
): boolean {
  const na = normalizeStatusGroups(a);
  const nb = normalizeStatusGroups(b);
  if (na === undefined || nb === undefined) return na === nb;
  if (na.length !== nb.length) return false;
  const compare = (x: string, y: string): number => x.localeCompare(y);
  const sa = [...na].sort(compare);
  const sb = [...nb].sort(compare);
  return sa.every((v, i) => v === sb[i]);
}

/**
 * The sidebar marks saved layouts, active-view options, and property filters.
 * The options menu resets only its active preferences and filters; choosing
 * Kanban or Timeline alone is not a reason to offer that reset. Text search is
 * global and is not represented here.
 */
export function isListViewCustomized(vs: ListViewState, listKey: string): boolean {
  return (
    vs.view === 'timeline' ||
    vs.view === 'kanban' ||
    isListViewOptionsCustomized(vs, listKey) ||
    vs.filters.length > 0
  );
}

/** Sort & group indicator excludes property filters, which have their own chips. */
export function isListViewOptionsCustomized(vs: ListViewState, listKey: string): boolean {
  if (vs.view === 'timeline') return taskTimelineCustomized(vs);
  if (vs.view === 'kanban') return taskKanbanCustomized(vs);
  const defaults = getListViewDefaults(listKey);
  return (
    vs.groupBy !== defaults.groupBy ||
    vs.sortBy.field !== defaults.sortBy.field ||
    vs.sortBy.dir !== defaults.sortBy.dir ||
    !statusGroupsEqual(vs.statusGroups, defaults.statusGroups)
  );
}
