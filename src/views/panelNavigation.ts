import type { AppState, ListSelection, ViewMode } from '../app/AppState';
import { listSelectionToKey, resolveListViewStateKey } from '../app/listViewState';
import type { TagRenameChange } from '../markdown/tagSyntax';
import type { CalViewType } from '../panels/calendar/calendarViewType';
import { getListViewDefaults } from '../settings/defaults';
import { renameTagSelection } from '../settings/tagViewState';
import type { CalendarSettings, ListViewState } from '../settings/types';
import { renameFileFilters } from '../settings/viewStatePaths';

export interface PanelNavigationActions {
  openTasks(): void;
  openList(selection: ListSelection): void;
  openCalendar(): void;
  openCalendarView(view: CalViewType): void;
  openProjects(): void;
  openStatistics(): void;
  openSearch(): void;
  openQuickCapture(): void;
  rebaseListIdentity(selection: ListSelection): void;
}

export interface PanelNavigationCenterPort {
  calendarView(): CalViewType;
  setCalendarView(view: CalViewType): void;
  openQuickCapture(): void;
  finishProjectTableEditorBefore?(action: () => void): void;
}

export class PanelNavigator implements PanelNavigationActions {
  private lastTasksList: ListSelection;

  constructor(
    private readonly state: AppState,
    private readonly settings: CalendarSettings,
    private readonly center: PanelNavigationCenterPort,
    private readonly onSaveViewState: () => Promise<void> = async () => {},
  ) {
    this.lastTasksList = state.get('selectedList');
  }

  openTasks(): void {
    this.openList(this.lastTasksList);
  }

  openList(selection: ListSelection): void {
    this.beforeModeChange(() => {
      this.state.batch(() => {
        this.persistListState(this.lastTasksList);
        this.lastTasksList = selection;
        const next = this.listState(selection);
        this.state.set('selectedList', selection);
        this.state.set('centerListViewState', next);
        this.state.set('centerFilter', '');
        this.state.set('mode', 'tasks');
      });
    });
  }

  openCalendar(): void {
    this.openCalendarView(this.center.calendarView());
  }

  openCalendarView(view: CalViewType): void {
    this.openMode('calendar', () => {
      this.center.setCalendarView(view);
    });
  }

  openStatistics(): void {
    this.openMode('statistics');
  }

  openProjects(): void {
    this.openMode('projects');
  }

  openSearch(): void {
    this.openMode('search');
  }

  openQuickCapture(): void {
    this.center.openQuickCapture();
  }

  rebaseListIdentity(selection: ListSelection): void {
    this.state.batch(() => {
      const previous = this.lastTasksList;
      this.storeListState(previous);
      this.moveListStateIdentity(previous, selection);
      this.lastTasksList = selection;
      this.state.set('selectedList', selection);
      this.state.set('centerListViewState', this.listState(selection));
      this.state.set('centerFilter', '');
      this.saveViewState();
    });
  }

  followTagRename(change: TagRenameChange): void {
    const ids = new Set(this.settings.tagGroups.map((g) => g.id));
    this.lastTasksList = renameTagSelection(this.lastTasksList, change, ids);
    this.state.batch(() => {
      const selection = renameTagSelection(this.state.get('selectedList'), change, ids);
      this.state.set('selectedList', selection);
      const current = this.state.get('centerListViewState');
      const filters = current.filters.map((filter) => {
        if (filter.type !== 'tag') return filter;
        const renamed = renameTagSelection({ type: 'tag', tag: filter.value }, change, ids);
        return typeof renamed === 'object' && renamed.type === 'tag'
          ? { ...filter, value: renamed.tag }
          : filter;
      });
      this.state.set('centerListViewState', { ...this.listState(selection), filters });
    });
  }

  /** Leaves a deleted project list for Today without storing its state under the deleted key. */
  followNoteDelete(path: string): void {
    if (!this.isSelectedProject(path)) return;
    this.state.batch(() => {
      this.lastTasksList = 'today';
      this.state.set('selectedList', 'today');
      this.state.set('centerListViewState', this.listState('today'));
      this.state.set('centerFilter', '');
      this.saveViewState();
    });
  }

  /** The list on screen follows a rename: its `file` filters, and a renamed project's selection. */
  followNoteRename(oldPath: string, newPath: string): void {
    const renamed = renameFileFilters(this.state.get('centerListViewState'), oldPath, newPath);
    const selected = this.isSelectedProject(oldPath);
    if (renamed === undefined && !selected) return;
    this.state.batch(() => {
      if (renamed !== undefined) this.state.set('centerListViewState', renamed);
      if (selected) this.rebaseListIdentity({ type: 'project', path: newPath });
    });
  }

  private isSelectedProject(path: string): boolean {
    const selected = this.state.get('selectedList');
    return typeof selected === 'object' && selected.type === 'project' && selected.path === path;
  }

  private openMode(mode: ViewMode, prepare: () => void = () => {}): void {
    this.beforeModeChange(() => {
      this.state.batch(() => {
        if (this.state.get('mode') === 'tasks') this.persistListState(this.lastTasksList);
        prepare();
        this.state.set('mode', mode);
      });
    });
  }

  private beforeModeChange(change: () => void): void {
    if (this.state.get('mode') !== 'projects') {
      change();
      return;
    }
    if (this.center.finishProjectTableEditorBefore === undefined) change();
    else this.center.finishProjectTableEditorBefore(change);
  }

  private persistListState(selection: ListSelection): void {
    this.storeListState(selection);
    this.saveViewState();
  }

  private saveViewState(): void {
    this.onSaveViewState().catch((error: unknown) => {
      console.error('[abyss-tasks] failed to persist list view settings', error);
    });
  }

  private storeListState(selection: ListSelection): void {
    const key = resolveListViewStateKey(
      selection,
      this.settings.listViewStates,
      new Set(this.settings.tagGroups.map((g) => g.id)),
    );
    const current = this.state.get('centerListViewState');
    this.listViewStates()[key] = current;
  }

  private moveListStateIdentity(previous: ListSelection, next: ListSelection): void {
    if (typeof previous !== 'object' || typeof next !== 'object' || previous.type !== next.type) {
      return;
    }
    const previousKey = listSelectionToKey(previous);
    const nextKey = listSelectionToKey(next);
    if (previousKey === nextKey) return;
    const states = this.listViewStates();
    const previousState = states[previousKey];
    if (previousState != null) states[nextKey] = previousState;
    delete states[previousKey];
  }

  private listState(selection: ListSelection): ListViewState {
    const key = resolveListViewStateKey(
      selection,
      this.settings.listViewStates,
      new Set(this.settings.tagGroups.map((g) => g.id)),
    );
    const saved = this.settings.listViewStates?.[key];
    if (saved != null) return saved;
    const defaults = getListViewDefaults(key);
    this.listViewStates()[key] = defaults;
    return defaults;
  }

  private listViewStates(): Record<string, ListViewState> {
    this.settings.listViewStates ??= {};
    return this.settings.listViewStates;
  }
}
