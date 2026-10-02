import type { ListSelection, ViewMode } from '../app/AppState';
import { resolveListViewStateKey } from '../app/listViewState';
import { noteNameOfPath } from '../markdown/noteName';

/** The static tab title on desktop; the phone view header shows the panel title instead. */
export const PANEL_DISPLAY_TEXT = 'Abyss Tasks';

export interface PanelTitleGroup {
  readonly id: string;
  readonly name: string;
  readonly origin?: 'configured' | 'discovered';
}

/**
 * The heading of the tasks list for one selection, as the center panel and the phone header show
 * it. Persisted state may carry a selection this build does not know; that reads as "Tasks".
 */
export function listSelectionTitle(
  selection: ListSelection,
  groups: readonly PanelTitleGroup[],
): string {
  if (typeof selection === 'string') {
    switch (selection) {
      case 'inbox':
        return 'Inbox';
      case 'today':
        return 'Today';
      case 'upcoming':
        return 'Upcoming';
      default:
        return 'Tasks';
    }
  }
  switch (selection.type) {
    case 'tag':
      return selection.tag;
    case 'project':
      return noteNameOfPath(selection.path);
    case 'group':
      return groupTitle(selection.groupId, groups);
    default:
      return 'Tasks';
  }
}

/**
 * The panel title for one mode. Only the tasks mode shows the list's name, so it is read lazily
 * from the panel that already knows it.
 */
export function panelTitle(mode: ViewMode, listTitle: () => string): string {
  switch (mode) {
    case 'tasks':
      return listTitle();
    case 'calendar':
      return 'Calendar';
    case 'projects':
      return 'Projects';
    case 'search':
      return 'Search';
  }
}

function groupTitle(groupId: string, groups: readonly PanelTitleGroup[]): string {
  const configuredIds = new Set(
    groups.filter((group) => group.origin !== 'discovered').map((group) => group.id),
  );
  const key = resolveListViewStateKey({ type: 'group', groupId }, undefined, configuredIds);
  return (
    (
      groups.find((group) => group.id === groupId) ??
      groups.find(
        (group) =>
          group.origin === 'discovered' &&
          resolveListViewStateKey(
            { type: 'group', groupId: group.id },
            undefined,
            configuredIds,
          ) === key,
      )
    )?.name ?? 'Group'
  );
}
