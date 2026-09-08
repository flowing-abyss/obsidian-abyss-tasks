import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { renderProjectsList } from '../src/panels/projects/ProjectsListView';
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

describe('renderProjectsList', () => {
  const ctx = {
    state: new AppState(),
    settings: DEFAULT_SETTINGS,
    onCreate: vi.fn().mockResolvedValue(undefined),
    onSetStatus: vi.fn(),
    openNote: vi.fn(),
  };

  it('groups projects under status headers in settings order + discovered after', () => {
    const el = freshContainer();
    renderProjectsList(
      el,
      [proj({}), proj({ path: 'Projects/B.md', name: 'B', statusId: null, rawStatus: 'archive' })],
      { ...ctx, state: new AppState() },
    );
    const headers = Array.from(el.querySelectorAll('.abyss-projects-group-label')).map(
      (h) => h.textContent,
    );
    expect(headers[0]).toBe('Active');
    expect(headers).toContain('archive');
    expect(headers.indexOf('archive')).toBeGreaterThan(headers.indexOf('Active'));
  });

  it('row click switches to the dashboard view', () => {
    const state = new AppState();
    const el = freshContainer();
    renderProjectsList(el, [proj({})], { ...ctx, state });
    (el.querySelector('.abyss-project-row') as HTMLElement).click();
    expect(state.get('projectsPanel')).toEqual({ view: 'dashboard', path: 'Projects/A.md' });
  });

  it('New project button reveals an inline input that calls onCreate (no modal)', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const el = freshContainer();
    renderProjectsList(el, [proj({})], { ...ctx, state: new AppState(), onCreate });
    (el.querySelector('.abyss-projects-new') as HTMLElement).click();
    const input = el.querySelector('.abyss-projects-new-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Fresh Project';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onCreate).toHaveBeenCalledWith('Fresh Project');
  });
});

describe('renderProjectDashboard', () => {
  it('renders header + back button; back returns to list; renders tasks', () => {
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
    expect(state.get('projectsPanel')).toEqual({ view: 'list' });
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
  const stubMgr = { setStatus: vi.fn().mockResolvedValue(undefined) } as never;

  it('renders the list view by default', () => {
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-list')).toBeTruthy();
  });

  it('renders the dashboard when projectsPanel is dashboard', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-dashboard')).toBeTruthy();
  });
});
