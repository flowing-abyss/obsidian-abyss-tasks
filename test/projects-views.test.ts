import { Component, Menu, Notice, parseYaml } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  disposeProjectDashboard,
  refreshProjectDashboard,
  renderProjectDashboard,
} from '../src/panels/projects/ProjectsDashboardView';
import { ProjectsPanel } from '../src/panels/projects/ProjectsPanel';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import { ObsidianProjectProperties } from '../src/projects/ObsidianProjectProperties';
import { ProjectManager } from '../src/projects/ProjectManager';
import type { ProjectSourceObservation } from '../src/projects/ProjectStore';
import { ProjectCreationError } from '../src/projects/projectCreation';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  freshContainer,
} from './helpers';
import { useProjectTableViewport } from './support/projectTableViewport';
import { projectTimelineLogicalCenter } from './support/projectTimelineGeometry';

useProjectTableViewport();

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
  it('retires an open status menu and rejects its captured choice after definition reuse', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const el = freshContainer();
    const project = proj({});
    const onSetStatus = vi.fn();
    const renderTasks = vi.fn();
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const hide = vi.spyOn(Menu.prototype, 'hide');
    renderProjectDashboard(el, project, {
      state: new AppState(),
      settings,
      onSetStatus,
      openNote: vi.fn(),
      renderTasks,
    });
    expectDefined(el.querySelector<HTMLElement>('.abyss-status-pill')).click();
    const menu = expectDefined(show.mock.instances[show.mock.instances.length - 1]) as {
      menuItems__: Array<{ onClick__: (event: MouseEvent) => void }>;
    };
    const choose = expectDefined(menu.menuItems__[0]).onClick__;
    expectDefined(settings.projects.statuses[0]).name = 'Replacement';
    refreshProjectDashboard(el, project, renderTasks, settings.projects.statuses);
    expect(hide).toHaveBeenCalled();
    choose(new MouseEvent('click'));
    expect(onSetStatus).not.toHaveBeenCalled();
    disposeProjectDashboard(el);
  });
  it('keeps the current status accessible when its visual label is collapsed', () => {
    const el = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const project = proj({});
    const renderTasks = vi.fn();
    renderProjectDashboard(el, project, {
      state: new AppState(),
      settings,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
    });
    const pill = expectDefined(el.querySelector<HTMLElement>('.abyss-status-pill'));
    expect(pill.getAttribute('aria-label')).toBe('Status: inbox');
    expect(pill.getAttribute('aria-haspopup')).toBe('menu');
    refreshProjectDashboard(
      el,
      { ...project, statusId: null, rawStatus: 'Waiting for approval' },
      renderTasks,
      settings.projects.statuses,
    );
    expect(pill.getAttribute('aria-label')).toContain('Waiting for approval');
    expect(pill.textContent).toBe('Waiting for approval');
    disposeProjectDashboard(el);
  });

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

  it('places Back and controls above a retained metadata group for the phone layout', () => {
    const el = freshContainer();
    const state = new AppState();
    const project = proj({});
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    const renderTasks = (host: HTMLElement): void => {
      if (host.querySelector('.abyss-center-header') !== null) return;
      const toolbar = host.createDiv({ cls: 'abyss-center-header' });
      const controls = toolbar.createDiv({ cls: 'abyss-center-controls' });
      controls.createDiv({ cls: 'abyss-task-collection-filters' });
    };
    renderProjectDashboard(el, project, {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
    });
    const toolbar = expectDefined(el.querySelector('.abyss-center-header'));
    const back = expectDefined(el.querySelector('.abyss-project-back'));
    const stats = expectDefined(el.querySelector('.abyss-project-dashboard-stats'));
    expect(back.parentElement).toBe(toolbar);
    expect(stats.parentElement?.classList.contains('abyss-project-dashboard-metadata')).toBe(true);
    const progress = expectDefined(stats.querySelector('.abyss-progress'));
    expect(progress).not.toBeNull();
    expect(
      el
        .querySelector('.abyss-status-pill')
        ?.previousElementSibling?.classList.contains('abyss-task-collection-filters'),
    ).toBe(true);
    disposeProjectDashboard(el);
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

  it.each(['changed', 'unchanged', 'outside', 'removed'] as const)(
    'retains the distant overview row across a hidden metadata refresh (%s)',
    async (scenario) => {
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.isConnected && this.classList.contains('abyss-project-table-scroll') ? 340 : 0;
      });
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.isConnected && this.classList.contains('abyss-project-table-scroll') ? 1000 : 0;
      });
      const config = structuredClone(DEFAULT_SETTINGS);
      config.projects.table.groupBy = 'none';
      config.projects.table.showDescription = true;
      config.projects.table.sortBy = { field: 'name', dir: 'asc' };
      let listed = Array.from({ length: 100 }, (_, index) =>
        proj({
          path: `Projects/P${index}.md`,
          name: `P${String(index).padStart(3, '0')}`,
          frontmatter: { description: 'Before' },
        }),
      );
      const target = expectDefined(listed[80]);
      const app = await createAppWithFiles({ [target.path]: '' });
      const state = new AppState();
      const store = {
        onUpdate: () => () => {},
        onSourceObservation: () => () => {},
        refresh: () => {},
        list: () => listed,
        get: (path: string) => listed.find((p) => p.path === path),
      };
      const panel = new ProjectsPanel(state, store as never, stubMgr, config, app, {
        projectProperties: new ObsidianProjectProperties(app),
      });
      const el = activeDocument.body.createDiv();
      panel.mount(el);
      try {
        const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-scroll'));
        scroll.scrollTop = 2500.25;
        scroll.scrollLeft = 31.5;
        scroll.dispatchEvent(new Event('scroll'));
        const name = expectDefined(
          el.querySelector<HTMLElement>(
            `[data-project-path="${target.path}"] .abyss-project-table-name-cell`,
          ),
        );
        const row = expectDefined(name.parentElement);
        const body = expectDefined(row.parentElement);
        name.focus();
        expectDefined(name.querySelector<HTMLButtonElement>('button')).click();
        await flushMicrotasks();
        expect(el.querySelector('.abyss-project-back')).not.toBeNull();
        expect(name.isConnected).toBe(false);
        const mountedBefore = Array.from(body.children);
        const unload = vi.spyOn(Component.prototype, 'unload');
        scroll.scrollTop = 0;
        scroll.scrollLeft = 0;
        if (scenario !== 'unchanged') {
          listed =
            scenario === 'removed'
              ? listed.filter((p) => p !== target)
              : listed.map((p) =>
                  p === target
                    ? { ...p, frontmatter: { description: 'Current changed description' } }
                    : p,
                );
          const file = expectDefined(app.vault.getFileByPath(target.path));
          app.metadataCache.trigger('changed', file, '', {});
          panel.refresh();
          scroll.dispatchEvent(new Event('scroll'));
          expect.soft(body.contains(name)).toBe(true);
          expect.soft(Array.from(body.children)).toEqual(mountedBefore);
          expect.soft(unload).not.toHaveBeenCalled();
        }
        const outside = activeDocument.body.createEl('input');
        const back = expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back'));
        if (scenario === 'outside') outside.focus();
        else back.focus();
        state.set('projectsPanel', { view: 'table' });
        if (scenario === 'removed') {
          expect(name.isConnected).toBe(false);
          expect(el.querySelector(`[data-project-path="${target.path}"]`)).toBeNull();
        } else {
          expect(
            el.querySelector(`[data-project-path="${target.path}"] .abyss-project-table-name-cell`),
          ).toBe(name);
          expect(activeDocument.activeElement).toBe(scenario === 'outside' ? outside : name);
          expect(name.textContent).toContain(
            scenario === 'unchanged' ? 'Before' : 'Current changed description',
          );
          expect([scroll.scrollTop, scroll.scrollLeft]).toEqual([2500.25, 31.5]);
          if (scenario === 'changed') {
            name.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            expect(
              activeDocument.activeElement?.closest<HTMLElement>('[data-project-path]')?.dataset[
                'projectPath'
              ],
            ).toBe('Projects/P81.md');
          }
        }
        outside.remove();
      } finally {
        panel.destroy();
        el.remove();
        vi.restoreAllMocks();
      }
    },
  );

  it('refreshes dashboard data while keeping the task host and live input connected', () => {
    let project = proj({ frontmatter: { description: 'Before' } });
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    const store = {
      list: () => [project],
      get: () => project,
      onSourceObservation: () => () => {},
    } as never;
    const panel = new ProjectsPanel(state, store, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
      renderTasks: (host) => {
        if (host.querySelector('input') === null) host.createEl('input');
      },
    });
    const el = activeDocument.body.createDiv();
    panel.mount(el);
    const host = expectDefined(el.querySelector('.abyss-project-tasks'));
    const input = expectDefined(host.querySelector('input'));
    input.value = 'Capture draft';
    input.focus();
    input.setSelectionRange(2, 5);
    project = {
      ...project,
      name: 'Renamed',
      frontmatter: { description: 'After' },
      stats: { ...project.stats, done: 3 },
    };
    panel.refresh();
    expect(el.querySelector('.abyss-project-tasks')).toBe(host);
    expect(input.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(el.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('Renamed');
    expectDefined(el.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    expect(el.querySelector('.abyss-project-description')?.textContent).toBe('After');
    expect(el.querySelector('.abyss-progress-label')?.textContent).toBe('3/4');
    panel.destroy();
    el.remove();
  });

  it('keeps changed descriptions in the disclosure without moving the retained task viewport', () => {
    let project = proj({ frontmatter: { description: 'Short' } });
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    const store = {
      list: () => [project],
      get: () => project,
      onSourceObservation: () => () => {},
    } as never;
    const panel = new ProjectsPanel(state, store, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
      renderTasks: (host) => {
        if (host.querySelector('.abyss-center-scroll') !== null) return;
        host.createDiv({ cls: 'abyss-center-header' });
        host.createDiv({ cls: 'abyss-center-scroll' });
      },
    });
    const el = activeDocument.body.createDiv();
    panel.mount(el);
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 612.25;
    project = { ...project, frontmatter: { description: 'A much longer description' } };
    panel.refresh();
    expect(el.querySelector('.abyss-center-scroll')).toBe(scroll);
    expect(scroll.scrollTop).toBe(612.25);
    const details = expectDefined(
      el.querySelector<HTMLButtonElement>('.abyss-project-dashboard-details'),
    );
    expect(details.getAttribute('aria-expanded')).toBe('false');
    details.click();
    expect(el.querySelector('.abyss-project-description')?.textContent).toBe(
      'A much longer description',
    );
    panel.destroy();
    el.remove();
  });

  it.each([false, true])(
    'captures exact overview return focus before task ownership teardown (%s outside)',
    (outsideFocus) => {
      const state = new AppState();
      let taskHost: HTMLElement | undefined;
      const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
        projectProperties,
        renderTasks: (host) => {
          taskHost = host;
          if (host.querySelector('input') === null) host.createEl('input');
        },
        unmountTasks: () => {
          taskHost?.empty();
        },
      });
      const el = activeDocument.body.createDiv();
      panel.mount(el);
      const name = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-name-cell'));
      name.focus();
      expectDefined(name.querySelector<HTMLButtonElement>('button')).click();
      const input = expectDefined(taskHost?.querySelector('input'));
      input.focus();
      panel.refresh();
      expect(activeDocument.activeElement).toBe(input);
      const outside = activeDocument.body.createEl('input');
      if (outsideFocus) outside.focus();
      state.set('projectsPanel', { view: 'table' });
      expect(input.isConnected).toBe(false);
      expect(activeDocument.activeElement).toBe(outsideFocus ? outside : name);
      panel.destroy();
      el.remove();
      outside.remove();
    },
  );

  it('renders the table view by default', () => {
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    el.ownerDocument.body.append(el);
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

    el.ownerDocument.body.append(el);
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
    el.ownerDocument.body.append(el);
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
    el.ownerDocument.body.append(el);
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
    activeDocument.body.append(el);
    panel.mount(el);
    const search = expectDefined(el.querySelector<HTMLInputElement>('.abyss-center-search'));
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    search.value = 'A';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    scroll.scrollTop = 33;

    const name = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-name-cell'));
    name.focus();
    expectDefined(name.querySelector<HTMLButtonElement>('.abyss-project-table-name')).focus();
    expectDefined(name.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    scroll.scrollTop = 0;
    const back = expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back'));
    back.focus();
    back.click();

    expect(el.querySelector<HTMLInputElement>('.abyss-center-search')).toBe(search);
    expect(search.value).toBe('A');
    expect(scroll.scrollTop).toBe(33);
    expect(activeDocument.activeElement).toBe(name);
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect((activeDocument.activeElement as HTMLElement).dataset['columnId']).toBe('status');
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
    activeDocument.body.append(el);
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

    expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name')).focus();
    expectDefined(card.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    board.scrollLeft = 0;
    column.scrollTop = 0;
    const back = expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back'));
    back.focus();
    back.click();

    expect(el.querySelector<HTMLElement>('.abyss-project-kanban-scroll')).toBe(board);
    expect(board.scrollLeft).toBe(47);
    expect(column.scrollTop).toBe(31);
    const name = expectDefined(card.querySelector<HTMLElement>('[data-column-id="name"]'));
    expect(activeDocument.activeElement).toBe(name);
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(activeDocument.activeElement).not.toBe(name);
    expect(panel.selectedProjectPath()).toBe('Projects/A.md');
  });

  it('restores the Table viewport without taking current external input focus on programmatic Back', () => {
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    activeDocument.body.append(el);
    panel.mount(el);
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    const name = expectDefined(el.querySelector<HTMLElement>('.abyss-project-table-name-cell'));
    name.focus();
    scroll.scrollTop = 33;
    expectDefined(name.querySelector<HTMLButtonElement>('button')).click();
    scroll.scrollTop = 0;
    const outside = activeDocument.body.createEl('input');
    outside.focus();
    state.set('projectsPanel', { view: 'table' });
    expect(scroll.scrollTop).toBe(33);
    expect(activeDocument.activeElement).toBe(outside);
    panel.destroy();
    outside.remove();
    el.remove();
  });

  it('keeps the Timeline scroll position when returning from a dashboard', () => {
    const size = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500);
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.timeline = buildDefaultProjectTimelineSettings(settings.projects.table);
    settings.projects.overviewView = 'timeline';
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      projectProperties,
    });
    const el = freshContainer();
    document.body.append(el);
    panel.mount(el);
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-project-timeline-scroll'));
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 900 });
    panel.refreshTableSettings();
    scroll.scrollLeft += 47;
    const center = projectTimelineLogicalCenter(scroll);

    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-table-name')).click();
    expect(el.querySelector('.abyss-projects-dashboard')).not.toBeNull();
    scroll.scrollLeft = 0;
    expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-back')).click();

    expect(el.querySelector<HTMLElement>('.abyss-project-timeline-scroll')).toBe(scroll);
    expect(projectTimelineLogicalCenter(scroll)).toBeCloseTo(center, 8);
    panel.destroy();
    el.remove();
    size.mockRestore();
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
      el.ownerDocument.body.append(el);
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

        expect(dashboard(el)).toBe(before);
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
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.defaultStatusId = status.id;
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
      settings,
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
    el.ownerDocument.body.append(el);
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

  it('reports a failed open from the dashboard title', async () => {
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
    el.ownerDocument.body.append(el);
    panel.mount(el);
    try {
      expectDefined(el.querySelector<HTMLButtonElement>('.abyss-project-dashboard-title')).click();
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

it('retains focused date buttons through late dashboard source refresh', () => {
  const el = document.body.createDiv();
  const renderTasks = (host: HTMLElement): void => {
    if (host.querySelector('.abyss-center-header') === null)
      host.createDiv({ cls: 'abyss-center-header' });
  };
  const project = proj({ frontmatter: { start: '2026-10-26', end: '2026-10-29' } });
  renderProjectDashboard(el, project, {
    state: new AppState(),
    settings: DEFAULT_SETTINGS,
    renderTasks,
    onSetStatus: () => {},
    openNote: () => {},
  });
  const end = expectDefined(el.querySelector<HTMLButtonElement>('[data-project-field="end"]'));
  end.focus();
  refreshProjectDashboard(
    el,
    { ...project, frontmatter: { start: '2026-10-27', end: '2026-10-30' } },
    renderTasks,
    DEFAULT_SETTINGS.projects.statuses,
  );
  expect(el.querySelector('[data-project-field="end"]')).toBe(end);
  expect(document.activeElement).toBe(end);
  expect(end.textContent).toContain('30');
  disposeProjectDashboard(el);
  el.remove();
});

describe('shared project mutation session', () => {
  async function openDashboard(mode: 'table' | 'kanban' | 'timeline' = 'table') {
    if (mode === 'timeline') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 3));
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500);
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(900);
    }
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.propertyDefinitions = {
      'property:Flag': { type: 'checkbox' },
      'property:Labels': { type: 'list' },
      'property:Text': { type: 'text' },
      'property:Budget': { type: 'number' },
    };
    settings.projects.table.groupBy = 'none';
    settings.projects.overviewView = mode;
    settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
    settings.projects.timeline = buildDefaultProjectTimelineSettings(settings.projects.table);
    settings.projects.table.columns.push(
      { id: 'property:Flag', visible: true },
      { id: 'property:Budget', visible: true },
    );
    const status = expectDefined(settings.projects.statuses[0]).name;
    const frontmatter = {
      status,
      Flag: false,
      Labels: ['one', 'two'],
      Text: 'Before',
      Budget: 10,
      start: '2026-10-02',
      end: '2026-10-04',
    };
    const project = proj({ frontmatter });
    const app = await createAppWithFiles({
      [project.path]: `---\nstatus: ${
        status
      }\nFlag: false\nLabels: [one, two]\nText: Before\nBudget: 10\nstart: 2026-10-02\nend: 2026-10-04\n---\n`,
    });
    const state = new AppState();
    state.set('mode', 'projects');
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    let listed = project;
    let source: ((observation: ProjectSourceObservation) => void) | undefined;
    const store = {
      list: () => [listed],
      get: () => listed,
      onSourceObservation: (callback: (observation: ProjectSourceObservation) => void) => {
        source = callback;
        return () => {
          source = undefined;
        };
      },
      revalidateSourceObservation: async () => false,
      refresh: vi.fn(),
    };
    const catalog = new ObsidianProjectProperties(app);
    const manager = new ProjectManager(app, settings, {} as never, {} as never, catalog);
    const panel = new ProjectsPanel(state, store as never, manager, settings, app, {
      projectProperties: catalog,
    });
    const el = activeDocument.body.createDiv();
    panel.mount(el);
    const file = expectDefined(app.vault.getFileByPath(project.path));
    const property = (field: string) =>
      expectDefined(el.querySelector<HTMLElement>(`[data-project-field="${field}"]`));
    const properties = () => {
      expectDefined(el.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    };
    const metadata = async () =>
      parseYaml((await app.vault.read(file)).split('---')[1] ?? '') as Record<string, unknown>;
    return {
      panel,
      el,
      state,
      manager,
      store,
      project,
      app,
      file,
      property,
      properties,
      metadata,
      observe: (frontmatter: Record<string, unknown>) => {
        listed = { ...listed, frontmatter };
        source?.({ path: project.path, revision: 1, project: listed });
      },
      dispose: () => {
        panel.destroy();
        el.remove();
        vi.restoreAllMocks();
        vi.useRealTimers();
      },
    };
  }

  it.each([
    { field: 'property:Flag', property: 'Flag', kind: 'checkbox', expected: true },
    { field: 'property:Labels', property: 'Labels', kind: 'list', expected: ['two'] },
    { field: 'property:Text', property: 'Text', kind: 'text', expected: 'After' },
    { field: 'start', property: 'start', kind: 'date', expected: '2026-10-03' },
  ])(
    'projects a direct dashboard $kind edit through navigation before metadata catches up',
    async ({ field, property, kind, expected }) => {
      const h = await openDashboard();
      const gate = deferred<void>();
      const apply = h.manager.applyEdits.bind(h.manager);
      const writes = vi.spyOn(h.manager, 'applyEdits').mockImplementationOnce(async (changes) => {
        await gate.promise;
        return apply(changes);
      });
      try {
        expect(h.el.querySelector('.abyss-projects-table-session')).toBeNull();
        if (field.startsWith('property:')) h.properties();
        const row = h.property(field);
        if (kind === 'checkbox')
          expectDefined(row.querySelector<HTMLInputElement>('input')).click();
        else if (kind === 'list')
          expectDefined(row.querySelector<HTMLButtonElement>('[aria-label="Remove one"]')).click();
        else {
          row.click();
          const input = expectDefined(
            h.el.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
          );
          input.value = String(expected);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        await flushMicrotasks();
        expect(writes).toHaveBeenCalledOnce();
        h.state.set('projectsPanel', { view: 'table' });
        gate.resolve();
        await flushMicrotasks();
        expect(h.state.get('projectsPanel')).toEqual({ view: 'table' });
        expect((await h.metadata())[property]).toEqual(expected);
        h.state.set('projectsPanel', { view: 'dashboard', path: h.project.path });
        if (field.startsWith('property:')) h.properties();
        if (kind === 'checkbox')
          expect(h.property(field).querySelector<HTMLInputElement>('input')?.checked).toBe(true);
        else if (kind === 'list') {
          expect(h.property(field).textContent).toContain('two');
          expect(h.property(field).textContent).not.toContain('one');
        } else if (kind === 'text') expect(h.property(field).textContent).toContain('After');
        else {
          h.property(field).click();
          const input = expectDefined(
            h.el.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
          );
          expect(input.value).toBe(String(expected));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        h.observe(await h.metadata());
        h.state.set('projectsPanel', { view: 'table' });
        const table = expectDefined(h.el.querySelector<HTMLElement>('.abyss-project-table'));
        table.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
        );
        await flushMicrotasks();
        expect((await h.metadata())[property]).toEqual(h.project.frontmatter[property]);
      } finally {
        gate.resolve();
        h.dispose();
      }
    },
  );

  function submitOverviewAction(
    h: Awaited<ReturnType<typeof openDashboard>>,
    action: 'paste' | 'multi-edit' | 'kanban' | 'timeline',
  ): void {
    if (action === 'paste') {
      const cell = expectDefined(
        h.el.querySelector<HTMLElement>(
          '.abyss-project-table-cell[data-column-id="property:Budget"]',
        ),
      );
      cell.click();
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: {
          types: ['text/plain'],
          getData: (type: string) => (type === 'text/plain' ? '42' : ''),
        },
      });
      cell.dispatchEvent(paste);
    } else if (action === 'multi-edit') {
      expectDefined(
        h.el.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="start"]'),
      ).click();
      const end = expectDefined(
        h.el.querySelector<HTMLElement>('.abyss-project-table-cell[data-column-id="end"]'),
      );
      end.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
      end.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    } else if (action === 'kanban') {
      const card = expectDefined(h.el.querySelector<HTMLElement>('.abyss-project-kanban-card'));
      const targetStatus = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
      const target = expectDefined(
        h.el.querySelector<HTMLElement>(
          `.abyss-project-kanban-column[data-status-key="id:${targetStatus.id}"]`,
        ),
      );
      const values = new Map<string, string>();
      const data = {
        get types() {
          return [...values.keys()];
        },
        setData: (key: string, value: string) => values.set(key, value),
        getData: (key: string) => values.get(key) ?? '',
        dropEffect: 'move',
        effectAllowed: 'all',
        setDragImage: () => {},
      };
      const drag = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: data });
        return event;
      };
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      card.dispatchEvent(drag('dragstart'));
      target.dispatchEvent(drag('drop'));
    }
  }

  it.each(['paste', 'multi-edit', 'kanban', 'timeline'] as const)(
    'orders overview %s and dashboard writes through one shared session',
    async (action) => {
      const modes = {
        paste: 'table',
        'multi-edit': 'table',
        kanban: 'kanban',
        timeline: 'timeline',
      } as const;
      const h = await openDashboard(modes[action]);
      const gate = deferred<void>();
      const apply = h.manager.applyEdits.bind(h.manager);
      const writes = vi.spyOn(h.manager, 'applyEdits').mockImplementationOnce(async (changes) => {
        await gate.promise;
        return apply(changes);
      });
      try {
        if (action === 'timeline') {
          h.state.set('projectsPanel', { view: 'table' });
          await flushMicrotasks();
          expectDefined(
            h.el.querySelector<HTMLElement>('.abyss-project-timeline-bar'),
          ).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          await flushMicrotasks();
          h.state.set('projectsPanel', { view: 'dashboard', path: h.project.path });
        }
        h.properties();
        expectDefined(h.property('property:Flag').querySelector<HTMLInputElement>('input')).click();
        await flushMicrotasks();
        if (action !== 'timeline') h.state.set('projectsPanel', { view: 'table' });
        submitOverviewAction(h, action);
        await flushMicrotasks();
        expect(writes).toHaveBeenCalledOnce();
        gate.resolve();
        await flushMicrotasks();
        expect(writes).toHaveBeenCalledTimes(2);
        const metadata = await h.metadata();
        expect(metadata['Flag']).toBe(true);
        if (action === 'paste') expect(metadata['Budget']).toBe(42);
        if (action === 'multi-edit') {
          expect(metadata).not.toHaveProperty('start');
          expect(metadata).not.toHaveProperty('end');
          expect(writes.mock.calls[1]?.[0]).toHaveLength(2);
        }
        if (action === 'timeline') {
          expect(metadata['start']).toBe('2026-10-03');
          expect(metadata['end']).toBe('2026-10-05');
        }
        if (action === 'kanban')
          expect(metadata['status']).toBe(DEFAULT_SETTINGS.projects.statuses[1]?.name);
      } finally {
        gate.resolve();
        h.dispose();
      }
    },
  );

  it('allows an active manager write to finish without refreshing a retired or replacement panel', async () => {
    const h = await openDashboard();
    const gate = deferred<void>();
    const apply = h.manager.applyEdits.bind(h.manager);
    const writes = vi.spyOn(h.manager, 'applyEdits').mockImplementationOnce(async (changes) => {
      await gate.promise;
      return apply(changes);
    });
    try {
      h.properties();
      expectDefined(h.property('property:Flag').querySelector<HTMLInputElement>('input')).click();
      await flushMicrotasks();
      expect(writes).toHaveBeenCalledOnce();
      h.panel.destroy();
      h.panel.mount(h.el);
      const replacement = h.el.innerHTML;
      gate.resolve();
      await flushMicrotasks();
      expect((await h.metadata())['Flag']).toBe(true);
      expect(h.el.innerHTML).toBe(replacement);
      expect(h.store.refresh).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      h.dispose();
    }
  });
});
