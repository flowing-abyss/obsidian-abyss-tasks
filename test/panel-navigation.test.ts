import { describe, expect, it, vi } from 'vitest';
import { AppState, type ListSelection } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import type { CalendarSettings, ListViewState } from '../src/settings/types';
import {
  PanelNavigator,
  type CalViewType,
  type PanelNavigationCenterPort,
} from '../src/views/panelNavigation';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  methodOf,
  useRealMoment,
} from './helpers';

useRealMoment();

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

function listState(groupBy: ListViewState['groupBy']): ListViewState {
  return {
    groupBy,
    sortBy: { field: 'title', dir: 'desc' },
    filters: [],
    statusGroups: ['todo'],
  };
}

function harness(
  options: {
    mode?: 'tasks' | 'calendar' | 'projects' | 'search';
    selection?: ListSelection;
    calendarView?: CalViewType;
    settings?: CalendarSettings;
  } = {},
) {
  const state = new AppState();
  if (options.mode !== undefined) state.set('mode', options.mode);
  if (options.selection !== undefined) state.set('selectedList', options.selection);
  let calendarView = options.calendarView ?? 'month';
  const center: PanelNavigationCenterPort = {
    calendarView: vi.fn(() => calendarView),
    setCalendarView: vi.fn((view: CalViewType) => {
      calendarView = view;
    }),
    openQuickCapture: vi.fn(),
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const navigator = new PanelNavigator(state, options.settings ?? settings(), center, save);
  return { state, center, navigator, save };
}

describe('center inspector selection', () => {
  it.each(['A', 'B'])(
    'clears dependency history when an ordinary center card selects %s',
    async (title) => {
      const app = await createAppWithFiles({
        'tasks.md': '\n- [ ] A #task/inbox\n- [ ] B #task/inbox\n',
      });
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await application.index.initialize();
      const state = new AppState();
      state.set('selectedList', 'inbox');
      const center = new CenterPanel(
        state,
        app,
        DEFAULT_SETTINGS,
        application.index,
        application.statusRegistry,
      );
      const container = activeDocument.body.createDiv();
      center.mount(container);
      try {
        const nodes = application.index.listNodes();
        const a = expectDefined(nodes.find(({ node }) => node.title === 'A'));
        const b = expectDefined(nodes.find(({ node }) => node.title === 'B'));
        state.set('taskStack', [a.root]);
        state.openInspectorDependency(b);
        const card = expectDefined(
          container.querySelector<HTMLElement>(
            `.abyss-task-card[data-line="${title === 'A' ? '1' : '2'}"]`,
          ),
        );
        card.click();
        expect(state.get('taskStack').map((node) => node.title)).toEqual([title]);
        expect(state.get('inspectorBackStack')).toEqual([]);
        expect(state.backInspectorDependency()).toBe(false);
      } finally {
        center.destroy();
        container.remove();
        application.index.destroy();
      }
    },
  );
});

describe('PanelNavigator', () => {
  it('opens a list atomically after saving outgoing state and restoring incoming state', () => {
    const todayState = listState('priority');
    const inboxState = listState('status');
    const calendarSettings = settings({ listViewStates: { inbox: inboxState } });
    const { state, navigator, save } = harness({ settings: calendarSettings });
    const commits: Array<{
      changed: ReadonlySet<string>;
      mode: string;
      selection: ListSelection;
      viewState: ListViewState;
      filter: string;
    }> = [];
    state.set('centerListViewState', todayState);
    state.set('centerFilter', 'needle');
    state.onCommit((changed) =>
      commits.push({
        changed: new Set(changed),
        mode: state.get('mode'),
        selection: state.get('selectedList'),
        viewState: state.get('centerListViewState'),
        filter: state.get('centerFilter'),
      }),
    );

    navigator.openList('inbox');

    expect(calendarSettings.listViewStates?.['today']).toBe(todayState);
    expect(save).toHaveBeenCalledOnce();
    expect(commits).toEqual([
      {
        changed: new Set(['selectedList', 'centerListViewState', 'centerFilter']),
        mode: 'tasks',
        selection: 'inbox',
        viewState: inboxState,
        filter: '',
      },
    ]);
  });

  it('restores defaults for a list without saved state', () => {
    const { state, navigator } = harness();

    navigator.openList({ type: 'tag', tag: '#work' });

    expect(state.get('centerListViewState')).toEqual(getListViewDefaults('tag:#work'));
  });

  it('preserves the last Tasks list across other modes', () => {
    const selection = { type: 'project', path: 'Projects/A.md' } as const;
    const { state, navigator } = harness();

    navigator.openList(selection);
    navigator.openCalendar();
    navigator.openSearch();
    navigator.openTasks();

    expect(state.get('mode')).toBe('tasks');
    expect(state.get('selectedList')).toEqual(selection);
  });

  it('preserves and normalizes the current Calendar view when opening Calendar', () => {
    const { state, center, navigator } = harness({ calendarView: 'week' });

    navigator.openCalendar();

    expect(methodOf(center, 'calendarView')).toHaveBeenCalledOnce();
    expect(methodOf(center, 'setCalendarView')).toHaveBeenCalledWith('week');
    expect(state.get('mode')).toBe('calendar');
  });

  it.each(['today', 'week', 'month'] as const)(
    'opens and normalizes the explicit %s Calendar view',
    (view) => {
      const { state, center, navigator } = harness({ mode: 'calendar' });

      navigator.openCalendarView(view);

      expect(methodOf(center, 'setCalendarView')).toHaveBeenCalledWith(view);
      expect(state.get('mode')).toBe('calendar');
    },
  );

  it('opens Projects and Search through complete semantic transitions', () => {
    const projects = harness();
    const search = harness();

    projects.navigator.openProjects();
    search.navigator.openSearch();

    expect(projects.state.get('mode')).toBe('projects');
    expect(search.state.get('mode')).toBe('search');
  });

  it('opens Quick Capture through its port without changing the active mode or list', () => {
    const selection = { type: 'tag', tag: '#next' } as const;
    const { state, center, navigator } = harness({ mode: 'search', selection });
    const commits = vi.fn();
    state.onCommit(commits);

    navigator.openQuickCapture();

    expect(state.get('mode')).toBe('search');
    expect(state.get('selectedList')).toEqual(selection);
    expect(methodOf(center, 'openQuickCapture')).toHaveBeenCalledOnce();
    expect(commits).not.toHaveBeenCalled();
  });

  it.each(['calendar', 'search', 'projects'] as const)(
    'rebases a renamed list identity in %s without opening Tasks',
    (mode) => {
      const previous = { type: 'tag', tag: '#work' } as const;
      const renamed = { type: 'tag', tag: '#focus' } as const;
      const current = listState('priority');
      const calendarSettings = settings({ listViewStates: { 'tag:#work': current } });
      const { state, navigator, save } = harness({
        mode,
        selection: previous,
        settings: calendarSettings,
      });
      state.set('centerListViewState', current);
      state.set('centerFilter', 'needle');
      const commits = vi.fn();
      state.onCommit(commits);

      navigator.rebaseListIdentity(renamed);

      expect(state.get('mode')).toBe(mode);
      expect(state.get('selectedList')).toEqual(renamed);
      expect(state.get('centerListViewState')).toBe(current);
      expect(state.get('centerFilter')).toBe('');
      expect(calendarSettings.listViewStates?.['tag:#work']).toBeUndefined();
      expect(calendarSettings.listViewStates?.['tag:#focus']).toBe(current);
      expect(save).toHaveBeenCalledOnce();
      expect(commits).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      'tag',
      { type: 'tag', tag: '#work' } as const,
      { type: 'tag', tag: '#focus' } as const,
      'tag:#work',
      'tag:#focus',
    ],
    [
      'project',
      { type: 'project', path: 'Projects/Before.md' } as const,
      { type: 'project', path: 'Projects/After.md' } as const,
      'project:Projects/Before.md',
      'project:Projects/After.md',
    ],
  ])(
    'migrates an active %s list identity without losing its view state',
    (
      ...[_kind, previous, renamed, previousKey, renamedKey]: readonly [
        string,
        ListSelection,
        ListSelection,
        string,
        string,
      ]
    ) => {
      const current = listState('priority');
      const calendarSettings = settings({ listViewStates: { [previousKey]: current } });
      const { state, navigator, save } = harness({
        mode: 'tasks',
        selection: previous,
        settings: calendarSettings,
      });
      state.set('centerListViewState', current);
      state.set('centerFilter', 'needle');
      const commits = vi.fn();
      state.onCommit(commits);

      navigator.rebaseListIdentity(renamed);

      expect(state.get('mode')).toBe('tasks');
      expect(state.get('selectedList')).toEqual(renamed);
      expect(state.get('centerListViewState')).toBe(current);
      expect(state.get('centerFilter')).toBe('');
      expect(calendarSettings.listViewStates?.[previousKey]).toBeUndefined();
      expect(calendarSettings.listViewStates?.[renamedKey]).toBe(current);
      expect(save).toHaveBeenCalledOnce();
      expect(commits).toHaveBeenCalledOnce();
    },
  );

  it('preserves the complete foreground Tasks transition when rebasing identity', () => {
    const current = listState('priority');
    const inbox = listState('status');
    const calendarSettings = settings({ listViewStates: { inbox } });
    const { state, navigator, save } = harness({ settings: calendarSettings });
    state.set('centerListViewState', current);
    state.set('centerFilter', 'needle');

    navigator.rebaseListIdentity('inbox');

    expect(state.get('mode')).toBe('tasks');
    expect(state.get('selectedList')).toBe('inbox');
    expect(state.get('centerListViewState')).toBe(inbox);
    expect(state.get('centerFilter')).toBe('');
    expect(calendarSettings.listViewStates?.['today']).toBe(current);
    expect(save).toHaveBeenCalledOnce();
  });

  it('restores the fallback list state instead of migrating a deleted project state', () => {
    const project = { type: 'project', path: 'Projects/Gone.md' } as const;
    const projectState = listState('priority');
    const todayState = listState('date');
    const calendarSettings = settings({ listViewStates: { today: todayState } });
    const { state, navigator } = harness({
      mode: 'calendar',
      selection: project,
      settings: calendarSettings,
    });
    state.set('centerListViewState', projectState);

    navigator.rebaseListIdentity('today');

    expect(state.get('mode')).toBe('calendar');
    expect(state.get('selectedList')).toBe('today');
    expect(state.get('centerListViewState')).toBe(todayState);
    expect(calendarSettings.listViewStates?.['project:Projects/Gone.md']).toBe(projectState);
    expect(calendarSettings.listViewStates?.['today']).toBe(todayState);
  });

  it.each([
    ['openTasks', { mode: 'search' }],
    ['openList', { mode: 'calendar' }],
    ['openCalendar', {}],
    ['openCalendarView', { mode: 'calendar' }],
    ['openProjects', {}],
    ['openSearch', {}],
  ] as const)('%s emits exactly one outer commit', (action, options) => {
    const { state, navigator } = harness(options);
    const commits = vi.fn();
    state.onCommit(commits);

    if (action === 'openList') navigator.openList('upcoming');
    else if (action === 'openCalendarView') navigator.openCalendarView('today');
    else navigator[action]();

    expect(commits).toHaveBeenCalledOnce();
  });
});
