import { Menu, Notice } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { ProjectsPanel } from '../src/panels/projects/ProjectsPanel';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import { ProjectCreationError } from '../src/projects/projectCreation';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { createAppWithFiles, expectDefined, flushMicrotasks, freshContainer } from './helpers';

const ACTIVE_ID = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id;

function proj(over: Partial<Project>): Project {
  return {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: ACTIVE_ID,
    rawStatus: null,
    stats: {
      total: 4,
      done: 1,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    ...over,
  };
}

const STATUS_VALIDATION = 'Choose a project Status property in settings before changing statuses.';

function spyOnNotices() {
  return vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
    'constructor__',
  );
}

describe('renderProgressBar', () => {
  it('renders a fill proportional to done/total', () => {
    const el = freshContainer();
    renderProgressBar(el, {
      total: 4,
      done: 3,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    });
    expect((el.querySelector('.abyss-progress-fill') as HTMLElement).style.width).toBe('75%');
    expect(el.querySelector('.abyss-progress-label')?.textContent).toBe('3/4');
  });

  it('handles total=0 without NaN', () => {
    const el = freshContainer();
    renderProgressBar(el, {
      total: 2,
      done: 0,
      cancelled: 2,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    });
    expect((el.querySelector('.abyss-progress-fill') as HTMLElement).style.width).toBe('0%');
    expect(el.querySelector('.abyss-progress-label')?.textContent).toBe('—');
  });
});

describe('renderProjectDashboard', () => {
  it('renders header + back button; back returns to table; renders tasks', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const el = freshContainer();
    const renderTasks = vi.fn();
    renderProjectDashboard(el, proj({}), {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
    });
    expect(el.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('A');
    expect(renderTasks).toHaveBeenCalled();
    (el.querySelector('.abyss-project-back') as HTMLElement).click();
    expect(state.get('projectsPanel')).toEqual({ view: 'table' });
  });

  it('shows "not found" when the project is missing', () => {
    const el = freshContainer();
    renderProjectDashboard(el, undefined, {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });
    expect(el.querySelector('.abyss-projects-empty')?.textContent).toBe('Project not found');
  });

  it('does not render premature time statistics from stale runtime data', () => {
    const el = freshContainer();
    const project = proj({
      stats: {
        total: 4,
        done: 1,
        cancelled: 0,
        inProgress: 0,
        tracked: { closedMs: 0, openStartsMs: [] },
        estimateMin: 90,
        spentMin: 30,
      } as Project['stats'] & { estimateMin: number; spentMin: number },
    });

    renderProjectDashboard(el, project, {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });

    expect(el.querySelector('.abyss-project-time')).toBeNull();
  });
});

describe('ProjectsPanel dispatch', () => {
  const stubStore = {
    list: () => [proj({})],
    get: () => proj({}),
    activeForLeftPanel: () => [],
    onUpdate: () => () => {},
    onSourceObservation: () => () => {},
    refresh: () => {},
  } as never;
  const stubMgr = {
    create: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setProperty: vi.fn().mockResolvedValue(undefined),
  } as never;
  const projectProperties = {
    list: () => [],
    inspect: () => ({
      kind: 'available' as const,
      property: undefined,
      assignment: { kind: 'none' as const },
    }),
    values: () => [],
    onChange: () => () => {},
  };

  it('renders the table view by default', () => {
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-table')).toBeTruthy();
  });

  it('reconciles the overview once on mount and again when returning from a dashboard', () => {
    const state = new AppState();
    const list = vi.fn(() => [proj({})]);
    const store = Object.assign({}, stubStore, { list });
    const panel = new ProjectsPanel(state, store, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();

    panel.mount(el);

    expect(list).toHaveBeenCalledOnce();
    const overview = expectDefined(el.querySelector<HTMLElement>('.abyss-projects-table'));
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();

    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();

    expect(list).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.abyss-projects-table')).toBe(overview);
  });

  it('renders the dashboard when projectsPanel is dashboard', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-dashboard')).toBeTruthy();
  });

  it('refreshes mounted dashboard status presentation without remounting its session or tasks', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const settings = structuredClone(DEFAULT_SETTINGS);
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    try {
      const dashboard = expectDefined(
        el.querySelector<HTMLElement>('.abyss-project-dashboard-session'),
      );
      const pill = expectDefined(dashboard.querySelector<HTMLButtonElement>('.abyss-status-pill'));
      const tasks = expectDefined(dashboard.querySelector<HTMLElement>('.abyss-project-tasks'));
      const status = expectDefined(settings.projects.statuses[0]);

      status.displayName = 'Current work';
      status.color = '#28b8a5';
      status.display = 'dot';
      panel.refreshTableSettings();

      expect(el.querySelector('.abyss-project-dashboard-session')).toBe(dashboard);
      expect(dashboard.querySelector('.abyss-status-pill')).toBe(pill);
      expect(dashboard.querySelector('.abyss-project-tasks')).toBe(tasks);
      expect(pill.textContent).toBe('Current work');
      expect(pill.classList).toContain('is-dot');
      expect(pill.style.getPropertyValue('--abyss-project-status-color')).toBe('#28b8a5');

      status.display = 'text';
      status.color = '#965fd4';
      panel.refreshTableSettings();
      expect(dashboard.querySelector('.abyss-status-pill')).toBe(pill);
      expect(pill.classList).toContain('is-text');
      expect(pill.classList).not.toContain('is-dot');
      expect(pill.style.getPropertyValue('--abyss-project-status-color')).toBe('#965fd4');

      delete status.display;
      delete status.color;
      panel.refreshTableSettings();
      expect(dashboard.querySelector('.abyss-status-pill')).toBe(pill);
      expect(pill.classList).not.toContain('is-text');
      expect(pill.classList).not.toContain('is-dot');
      expect(pill.style.getPropertyValue('--abyss-project-status-color')).toBe('');
    } finally {
      panel.destroy();
    }
  });

  it('keeps the table query and scroll position when returning from a dashboard', () => {
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    const search = expectDefined(el.querySelector<HTMLInputElement>('.abyss-center-search'));
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    search.value = 'A';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    scroll.scrollTop = 33;

    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();

    expect(el.querySelector<HTMLInputElement>('.abyss-center-search')).toBe(search);
    expect(search.value).toBe('A');
    expect(scroll.scrollTop).toBe(33);
  });

  it('keeps the selected Kanban card and board scroll positions when returning from a dashboard', async () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.overviewView = 'kanban';
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, app, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    const board = expectDefined(el.querySelector<HTMLElement>('.abyss-project-kanban-scroll'));
    const column = expectDefined(
      el.querySelector<HTMLElement>('.abyss-project-kanban-column-body'),
    );
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-project-kanban-card'));
    board.scrollLeft = 47;
    column.scrollTop = 31;
    card.click();
    expect(panel.selectedProjectPath()).toBe('Projects/A.md');

    expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();

    expect(el.querySelector<HTMLElement>('.abyss-project-kanban-scroll')).toBe(board);
    expect(board.scrollLeft).toBe(47);
    expect(column.scrollTop).toBe(31);
    expect(panel.selectedProjectPath()).toBe('Projects/A.md');
  });

  it('keeps the Timeline scroll position when returning from a dashboard', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.timeline = buildDefaultProjectTimelineSettings(settings.projects.table);
    settings.projects.overviewView = 'timeline';
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-timeline-scroll'));
    scroll.scrollLeft = 47;

    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    scroll.scrollLeft = 0;
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();

    expect(el.querySelector<HTMLElement>('.abyss-project-timeline-scroll')).toBe(scroll);
    expect(scroll.scrollLeft).toBe(47);
  });

  describe('dashboard scroll position', () => {
    function openDashboard(path: string): {
      panel: ProjectsPanel;
      el: HTMLElement;
      state: AppState;
    } {
      const state = new AppState();
      state.set('projectsPanel', { view: 'dashboard', path });
      const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
        projectProperties,
      });
      const el = freshContainer();
      panel.mount(el);
      return { panel, el, state };
    }

    function dashboard(el: HTMLElement): HTMLElement {
      return expectDefined(el.querySelector<HTMLElement>('.abyss-project-dashboard-session'));
    }

    it('keeps its place when its project renders again', () => {
      const { panel, el } = openDashboard('Projects/A.md');
      try {
        const before = dashboard(el);
        // jsdom keeps no layout, so the scrolled host is given its position directly.
        before.scrollTop = 612;

        panel.refresh();

        expect(dashboard(el)).not.toBe(before);
        expect(dashboard(el).scrollTop).toBe(612);
      } finally {
        panel.destroy();
      }
    });

    it('opens another project at its top', () => {
      const { panel, el, state } = openDashboard('Projects/A.md');
      try {
        dashboard(el).scrollTop = 612;

        state.set('projectsPanel', { view: 'dashboard', path: 'Projects/B.md' });

        expect(dashboard(el).scrollTop).toBe(0);
      } finally {
        panel.destroy();
      }
    });

    it('opens the same project at its top again after the overview', () => {
      const { panel, el } = openDashboard('Projects/A.md');
      try {
        dashboard(el).scrollTop = 612;

        expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();
        expect(el.querySelector('.abyss-project-dashboard-session')).toBeNull();
        expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();

        expect(dashboard(el).scrollTop).toBe(0);
      } finally {
        panel.destroy();
      }
    });
  });

  it('repaints column settings without a project-data change and defers safely for an active draft', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      projectProperties: {
        list: () => [
          { name: 'start', type: 'date' },
          { name: 'end', type: 'date' },
          { name: 'Budget', type: 'number' },
        ],
        inspect: () => ({
          kind: 'available',
          property: undefined,
          assignment: { kind: 'none' },
        }),
        values: () => [],
        onChange: () => () => {},
      },
    });
    const el = freshContainer();
    el.ownerDocument.body.append(el);
    panel.mount(el);

    settings.projects.table.columns.push({
      id: 'property:Budget',
      visible: true,
      label: 'Cost',
    });
    panel.refreshTableSettings();
    expect(
      Array.from(el.querySelectorAll('.abyss-project-table-column-button')).map((button) =>
        button.textContent.trim(),
      ),
    ).toContain('Cost');

    const end = expectDefined(
      el.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
    );
    end.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const draft = expectDefined(end.querySelector<HTMLInputElement>('input[type="date"]'));
    draft.value = '2027-01-02';
    draft.focus();
    expectDefined(
      settings.projects.table.columns.find(({ id }) => id === 'property:Budget'),
    ).label = 'Approved budget';
    panel.refreshTableSettings();

    expect(draft.value).toBe('2027-01-02');
    expect(el.contains(draft)).toBe(true);
    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(
      Array.from(el.querySelectorAll('.abyss-project-table-column-button')).map((button) =>
        button.textContent.trim(),
      ),
    ).toContain('Approved budget');
    panel.destroy();
    el.remove();
  });

  it('retries only the owned status write after partial project creation', async () => {
    const state = new AppState();
    const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
    const failure = new ProjectCreationError('status failed', {
      createdPath: 'Projects/Owned.md',
      phase: 'status',
      statusId: status.id,
      cause: new Error('disk full'),
    });
    const create = vi.fn().mockRejectedValueOnce(failure);
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();
    const store = {
      list: () => [proj({})],
      get: () => proj({}),
      activeForLeftPanel: () => [],
      onUpdate: () => () => {},
      onSourceObservation: () => () => {},
      refresh,
    };
    const manager = {
      create,
      setStatus,
      setProperty: vi.fn().mockResolvedValue(undefined),
      applyEdits: vi.fn().mockResolvedValue({ applied: [], failed: [] }),
    };
    const panel = new ProjectsPanel(
      state,
      store as never,
      manager as never,
      structuredClone(DEFAULT_SETTINGS),
      null as never,
      { projectProperties },
    );
    const el = freshContainer();
    el.ownerDocument.body.append(el);
    panel.mount(el);
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-projects-new')).click();
    const input = expectDefined(el.querySelector<HTMLInputElement>('.abyss-project-creation-name'));
    input.value = 'Owned';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-creation-submit')).click();
    await flushMicrotasks();

    expect(create).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith('Projects/Owned.md', status.id);
    expect(refresh).toHaveBeenCalledOnce();
    panel.destroy();
    el.remove();
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not create project', {
      error: failure,
    });
  });

  const WRITE_FAILURE = new Error('disk full');
  const SECOND_STATUS_ID = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]).id;

  /** Chooses the second status from the dashboard's status pill and returns the store's refresh. */
  async function chooseDashboardStatus(setStatus: (path: string, statusId: string) => unknown) {
    const refresh = vi.fn();
    const store = Object.assign({}, stubStore, { refresh });
    const manager = { create: vi.fn(), setStatus, setProperty: vi.fn() } as never;
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const panel = new ProjectsPanel(state, store, manager, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    try {
      const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
      expectDefined(el.querySelector<HTMLButtonElement>('.abyss-status-pill')).click();
      const menu = expectDefined(show.mock.instances[0]) as {
        menuItems__: Array<{ onClick__: ((event: MouseEvent) => void) | null }>;
      };
      expectDefined(expectDefined(menu.menuItems__[1]).onClick__)(new MouseEvent('click'));
      await flushMicrotasks();
    } finally {
      panel.destroy();
    }
    return refresh;
  }

  it.each([
    ['validation', new ProjectEditValidationError(STATUS_VALIDATION), STATUS_VALIDATION, []],
    [
      'write',
      WRITE_FAILURE,
      'Could not change the project status. disk full',
      [
        [
          '[abyss-tasks] Could not change the project status',
          { path: 'Projects/A.md', statusId: SECOND_STATUS_ID, cause: WRITE_FAILURE },
        ],
      ],
    ],
  ])('reports a %s failure from the dashboard status pill', async (_kind, error, message, logs) => {
    // A case that expects no log calls through, so the console guard also fails a stray one.
    const log = vi.spyOn(console, 'error');
    if (logs.length > 0) log.mockImplementation(() => undefined);
    const notices = spyOnNotices();

    const refresh = await chooseDashboardStatus(vi.fn().mockRejectedValue(error));

    expect(notices.mock.calls.map(([text]) => text)).toEqual([message]);
    expect(refresh).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual(logs);
  });

  it('refreshes the project store once after a dashboard status change', async () => {
    const log = vi.spyOn(console, 'error');
    const notices = spyOnNotices();
    const setStatus = vi.fn().mockResolvedValue(undefined);

    const refresh = await chooseDashboardStatus(setStatus);

    expect(setStatus).toHaveBeenCalledExactlyOnceWith('Projects/A.md', SECOND_STATUS_ID);
    expect(refresh).toHaveBeenCalledOnce();
    expect(notices).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('reports a failed open from the dashboard open button', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('leaf closed');
    const notices = spyOnNotices();
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    vi.spyOn(app.workspace, 'getLeaf').mockReturnValue({
      openFile: vi.fn().mockRejectedValue(failure),
    } as never);
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, app, {
      projectProperties,
    });
    const el = freshContainer();
    panel.mount(el);
    try {
      expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-open-btn')).click();
      await flushMicrotasks();

      expect(notices.mock.calls.map(([text]) => text)).toEqual([
        'Could not open Projects/A.md. leaf closed',
      ]);
    } finally {
      panel.destroy();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not open the project note', {
      path: 'Projects/A.md',
      error: failure,
    });
  });
});
