import type { ListSelection, ViewMode } from '../app/AppState';

/** The static tab title on desktop; the phone view header shows the panel title instead. */
export const PANEL_DISPLAY_TEXT = 'Abyss Tasks';

export interface PanelTitleGroup {
  readonly id: string;
  readonly name: string;
}

export function projectNameFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
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
      return projectNameFromPath(selection.path);
    case 'group':
      return groups.find((group) => group.id === selection.groupId)?.name ?? 'Group';
    default:
      return 'Tasks';
  }
}

/** The panel title for one mode; only the tasks mode depends on the selected list. */
export function panelTitle(
  mode: ViewMode,
  selection: ListSelection,
  groups: readonly PanelTitleGroup[],
): string {
  switch (mode) {
    case 'tasks':
      return listSelectionTitle(selection, groups);
    case 'calendar':
      return 'Calendar';
    case 'projects':
      return 'Projects';
    case 'search':
      return 'Search';
  }
}
