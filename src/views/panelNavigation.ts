import type { AppState, ListSelection, ViewMode } from '../app/AppState';
import { listSelectionToKey } from '../app/listViewState';
import { getListViewDefaults } from '../settings/defaults';
import type { CalendarSettings, ListViewState } from '../settings/types';

export type CalViewType = 'today' | 'week' | 'month';

export interface PanelNavigationActions {
  openTasks(): void;
  openList(selection: ListSelection): void;
  openCalendar(): void;
  openCalendarView(view: CalViewType): void;
  openProjects(): void;
  openSearch(): void;
  openQuickCapture(): void;
  rebaseListIdentity(selection: ListSelection): void;
}

export interface PanelNavigationCenterPort {
  calendarView(): CalViewType;
  setCalendarView(view: CalViewType): void;
  openQuickCapture(): void;
}

export class PanelNavigator implements PanelNavigationActions {
  private lastTasksList: ListSelection;

  constructor(
    private readonly state: AppState,
    private readonly settings: CalendarSettings,
    private readonly center: PanelNavigationCenterPort,
    private readonly onSaveSettings: () => Promise<void> = async () => {},
  ) {
    this.lastTasksList = state.get('selectedList');
  }

  openTasks(): void {
    this.openList(this.lastTasksList);
  }

  openList(selection: ListSelection): void {
    this.state.batch(() => {
      this.persistListState(this.lastTasksList);
      this.lastTasksList = selection;
      const next = this.listState(selection);
      this.state.set('selectedList', selection);
      this.state.set('centerListViewState', next);
      this.state.set('centerFilter', '');
      this.state.set('mode', 'tasks');
    });
  }

  openCalendar(): void {
    this.openCalendarView(this.center.calendarView());
  }

  openCalendarView(view: CalViewType): void {
    this.openMode('calendar', () => this.center.setCalendarView(view));
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
      void this.onSaveSettings();
    });
  }

  private openMode(mode: ViewMode, prepare: () => void = () => {}): void {
    this.state.batch(() => {
      if (this.state.get('mode') === 'tasks') this.persistListState(this.lastTasksList);
      prepare();
      this.state.set('mode', mode);
    });
  }

  private persistListState(selection: ListSelection): void {
    this.storeListState(selection);
    void this.onSaveSettings();
  }

  private storeListState(selection: ListSelection): void {
    const key = listSelectionToKey(selection);
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
    if (previousState) states[nextKey] = previousState;
    delete states[previousKey];
  }

  private listState(selection: ListSelection): ListViewState {
    const key = listSelectionToKey(selection);
    const saved = this.settings.listViewStates?.[key];
    if (saved) return saved;
    const defaults = getListViewDefaults(key);
    this.listViewStates()[key] = defaults;
    return defaults;
  }

  private listViewStates(): Record<string, ListViewState> {
    this.settings.listViewStates ??= {};
    return this.settings.listViewStates;
  }
}
