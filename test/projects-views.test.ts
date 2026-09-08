import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { ProjectsPanel } from '../src/panels/projects/ProjectsPanel';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, freshContainer } from './helpers';

const ACTIVE_ID = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id;

function proj(over: Partial<Project>): Project {
  return {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: ACTIVE_ID,
    rawStatus: null,
    stats: { total: 4, done: 1, cancelled: 0, inProgress: 0 },
    ...over,
  };
}

describe('renderProgressBar', () => {
  it('renders a fill proportional to done/total', () => {
    const el = freshContainer();
    renderProgressBar(el, { total: 4, done: 3, cancelled: 0, inProgress: 0 });
    expect((el.querySelector('.abyss-progress-fill') as HTMLElement).style.width).toBe('75%');
    expect(el.querySelector('.abyss-progress-label')?.textContent).toBe('3/4');
  });

  it('handles total=0 without NaN', () => {
    const el = freshContainer();
    renderProgressBar(el, { total: 2, done: 0, cancelled: 2, inProgress: 0 });
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
    refresh: () => {},
  } as never;
  const stubMgr = {
    create: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setProperty: vi.fn().mockResolvedValue(undefined),
  } as never;
  const projectProperties = {
    list: () => [],
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

  it('repaints column settings without a project-data change and defers safely for an active draft', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      projectProperties: {
        list: () => [{ name: 'Budget', type: 'number' }],
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
});
