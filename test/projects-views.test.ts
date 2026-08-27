// eslint-disable-next-line import/no-nodejs-modules -- geometry contract loads the shipped CSS.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { BoundedWindow, computeBoundedWindow } from '../src/panels/projects/BoundedWindow';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import { renderProjectsBoard } from '../src/panels/projects/ProjectsBoardView';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { renderProjectsList } from '../src/panels/projects/ProjectsListView';
import { ProjectsPanel } from '../src/panels/projects/ProjectsPanel';
import { selectWorkNotes } from '../src/panels/projects/WorkNotesView';
import { parseProjectRange } from '../src/projects/projectDates';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer, task } from './helpers';

const ACTIVE_ID = DEFAULT_SETTINGS.projects.statuses[0]!.id;
const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

function attachedContainer(): HTMLElement {
  const container = freshContainer();
  container.dataset['projectsFocusTest'] = '';
  activeDocument.body.appendChild(container);
  return container;
}

afterEach(() => {
  for (const container of activeDocument.body.querySelectorAll('[data-projects-focus-test]')) {
    container.remove();
  }
});

function geometryContract(element: HTMLElement): {
  readonly rect: DOMRect;
  readonly display: string;
  readonly gridTemplateColumns: string;
  readonly gap: string;
  readonly paddingInline: string;
} {
  const style = getComputedStyle(element);
  return {
    rect: element.getBoundingClientRect(),
    display: style.display,
    gridTemplateColumns: style.gridTemplateColumns,
    gap: style.gap,
    paddingInline: `${style.paddingInlineStart} ${style.paddingInlineEnd}`,
  };
}

function proj(over: Partial<Project>): Project {
  return {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: ACTIVE_ID,
    rawStatus: null,
    range: {},
    stats: { total: 4, done: 1, cancelled: 0, inProgress: 0, open: 3, progress: 0.25 },
    ...over,
  };
}

function workspace(
  project = proj({}),
  over: Partial<ProjectWorkspaceSnapshot> = {},
): ProjectWorkspaceSnapshot {
  return {
    project,
    tasks: [],
    workNotes: [],
    milestones: [],
    taskRollup: project.stats,
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    diagnostics: [],
    ...over,
  };
}

function workNote(path: string, statusId: string, updated: string): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'accepted',
    kind: 'ordinary',
    projectPath: 'Projects/A.md',
    statusId,
    rawStatus: statusId,
    writableStatusShape: true,
    updated,
    range: parseProjectRange(updated, undefined),
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
  };
}

describe('renderProgressBar', () => {
  it('renders a fill proportional to done/total', () => {
    const el = freshContainer();
    renderProgressBar(el, 3, 4);
    expect((el.querySelector('.abyss-progress-fill') as HTMLElement).style.width).toBe('75%');
    expect(el.querySelector('.abyss-progress-label')?.textContent).toBe('3/4');
  });

  it('handles total=0 without NaN', () => {
    const el = freshContainer();
    renderProgressBar(el, 0, 0);
    expect((el.querySelector('.abyss-progress-fill') as HTMLElement).style.width).toBe('0%');
  });
});

describe('renderProjectsList', () => {
  const ctx = {
    state: new AppState(),
    settings: DEFAULT_SETTINGS,
    onSaveSettings: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onSetStatus: vi.fn(),
    openNote: vi.fn(),
  };

  it('groups projects under status headers in settings order + discovered after', () => {
    const el = freshContainer();
    renderProjectsList(
      el,
      [
        workspace(proj({})),
        workspace(proj({ path: 'Projects/B.md', name: 'B', statusId: null, rawStatus: 'archive' })),
      ],
      { ...ctx, state: new AppState() },
    );
    const headers = Array.from(el.querySelectorAll('.abyss-projects-group-label')).map(
      (h) => h.textContent,
    );
    expect(headers[0]).toBe('Active');
    expect(headers).toContain('archive');
    expect(headers.indexOf('archive')).toBeGreaterThan(headers.indexOf('Active'));
  });

  it('switches the portfolio to its lifecycle Board without changing the configured filters', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'overview';
    settings.projects.view.visibleStatusIds = [ACTIVE_ID];
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    const onPortfolioLayoutChanged = vi.fn();
    const el = freshContainer();

    renderProjectsList(el, [workspace()], {
      ...ctx,
      state: new AppState(),
      settings,
      onSaveSettings,
      onPortfolioLayoutChanged,
    });
    el.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="board"]')!.click();
    await Promise.resolve();

    expect(settings.projects.view.portfolioLayout).toBe('board');
    expect(settings.projects.view.visibleStatusIds).toEqual([ACTIVE_ID]);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onPortfolioLayoutChanged).toHaveBeenCalledOnce();
  });

  it('shows the portfolio Timeline route only when a real dated renderer is available', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const onPortfolioLayoutChanged = vi.fn();
    const available = freshContainer();
    renderProjectsList(available, [workspace()], {
      ...ctx,
      settings,
      timelineAvailable: true,
      onPortfolioLayoutChanged,
    });

    available
      .querySelector<HTMLButtonElement>('[data-project-portfolio-layout="timeline"]')!
      .click();
    await Promise.resolve();
    expect(settings.projects.view.portfolioLayout).toBe('timeline');
    expect(onPortfolioLayoutChanged).toHaveBeenCalledOnce();

    const unavailable = freshContainer();
    renderProjectsList(unavailable, [workspace()], {
      ...ctx,
      settings: structuredClone(DEFAULT_SETTINGS),
    });
    expect(unavailable.querySelector('[data-project-portfolio-layout="timeline"]')).toBeNull();
  });

  it('keeps the shared toolbar available while the lifecycle Board is active', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.statuses.push({
      ...settings.projects.statuses[0]!,
      id: 'published',
      label: 'Published',
      behavior: 'published',
      match: { kind: 'property', property: 'status', value: 'published' },
    });
    const onPortfolioLayoutChanged = vi.fn();
    const el = freshContainer();

    renderProjectsBoard(el, {
      ...ctx,
      settings,
      snapshots: [workspace()],
      onPortfolioLayoutChanged,
      onMoveStatus: vi.fn(),
      onUndoStatus: vi.fn(),
    });

    expect(el.querySelector('[data-project-portfolio-layout="overview"]')).not.toBeNull();
    expect(el.querySelector('[data-project-status-filter]')).not.toBeNull();
    expect(el.querySelector('[aria-label="New project"]')).not.toBeNull();
  });

  it('keeps deep reused Project rows constrained to the Board extent while keyboard traversal remounts', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'board';
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const el = attachedContainer();
    try {
      const snapshots = Array.from({ length: 40 }, (_, index) =>
        workspace(proj({ path: `Projects/${String(index)}.md`, name: `Project ${String(index)}` })),
      );
      renderProjectsBoard(el, {
        ...ctx,
        state: new AppState(),
        settings,
        snapshots,
        onMoveStatus: vi.fn(),
        onUndoStatus: vi.fn(),
      });
      const scroll = el.querySelector<HTMLElement>('.abyss-board-column-scroll')!;
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 176 });
      scroll.scrollTop = 22 * 88;
      scroll.dispatchEvent(new Event('scroll'));

      const deepRow = el.querySelector<HTMLElement>('[data-board-item="Projects/22.md"]')!;
      expect(getComputedStyle(deepRow).blockSize).toBe('88px');
      expect(getComputedStyle(deepRow).overflow).toBe('hidden');
      expect(Number.parseFloat(getComputedStyle(deepRow).marginTop)).toBe(0);
      expect(Number.parseFloat(getComputedStyle(deepRow).marginBottom)).toBe(0);
      expect(
        el.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
      ).toBe('1584px');
      deepRow.focus();
      for (let index = 0; index < 5; index += 1) {
        activeDocument.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }

      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Projects/27.md',
      );
      expect(scroll.scrollTop).toBe(26 * 88);
      expect(el.querySelector('[data-board-item="Projects/27.md"]')).not.toBeNull();
    } finally {
      style.remove();
      el.remove();
    }
  });

  it('row click switches to the dashboard view', () => {
    const state = new AppState();
    const el = freshContainer();
    renderProjectsList(el, [workspace()], { ...ctx, state });
    (el.querySelector('.abyss-project-row') as HTMLElement).click();
    expect(state.get('projectsPanel')).toEqual({ view: 'dashboard', path: 'Projects/A.md' });
  });

  it('New project button reveals an inline input that calls onCreate (no modal)', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const el = freshContainer();
    renderProjectsList(el, [workspace()], { ...ctx, state: new AppState(), onCreate });
    (el.querySelector('.abyss-projects-new') as HTMLElement).click();
    const input = el.querySelector('.abyss-projects-new-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Fresh Project';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onCreate).toHaveBeenCalledWith('Fresh Project');
  });

  it('renders one compact native header and omits an empty metadata row', () => {
    const el = freshContainer();
    const emptyProject = proj({
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    });

    renderProjectsList(el, [workspace(emptyProject)], { ...ctx, state: new AppState() });

    expect(el.querySelectorAll('.abyss-center-header')).toHaveLength(1);
    expect(el.querySelector('.abyss-project-row-meta')).toBeNull();
    expect(el.textContent).not.toContain('Choose Next Action');
  });

  it('persists status filters without invoking a Project note command', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.statuses = [{ ...settings.projects.statuses[0]!, id: 'wip', label: 'WIP' }];
    settings.projects.view.visibleStatusIds = [];
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    const onSetStatus = vi.fn();
    const openNote = vi.fn();
    const el = freshContainer();

    renderProjectsList(el, [workspace(proj({ statusId: 'wip' }))], {
      ...ctx,
      state: new AppState(),
      settings,
      onSaveSettings,
      onSetStatus,
      openNote,
    });
    el.querySelector<HTMLButtonElement>('[data-project-status-filter="wip"]')!.click();
    await Promise.resolve();

    expect(settings.projects.view.visibleStatusIds).toEqual(['wip']);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onSetStatus).not.toHaveBeenCalled();
    expect(openNote).not.toHaveBeenCalled();
  });

  it('persists the Unmapped filter through the same settings-only path', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.includeUnmapped = false;
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    const onSetStatus = vi.fn();
    const el = freshContainer();

    renderProjectsList(el, [workspace(proj({ statusId: null, rawStatus: 'legacy' }))], {
      ...ctx,
      state: new AppState(),
      settings,
      onSaveSettings,
      onSetStatus,
    });
    el.querySelector<HTMLButtonElement>('[data-project-unmapped-filter]')!.click();
    await Promise.resolve();

    expect(settings.projects.view.includeUnmapped).toBe(true);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it('renders joined Task, Work Note, overdue, and diagnostic summary data', () => {
    const project = proj({
      stats: { total: 3, done: 1, cancelled: 0, inProgress: 1, open: 1, progress: 1 / 3 },
    });
    const el = freshContainer();

    renderProjectsList(
      el,
      [
        workspace(project, {
          taskRollup: project.stats,
          workNoteRollup: { active: 1, completed: 1, dropped: 0 },
          overdue: { tasks: 1, workNotes: 2 },
          diagnostics: [
            { type: 'work-note', path: 'Notes/A.md', diagnostic: { type: 'missing-project' } },
          ] as never,
        }),
      ],
      { ...ctx, state: new AppState() },
    );

    expect(el.querySelector('.abyss-project-task-progress')?.textContent).toContain('Tasks');
    expect(el.querySelector('.abyss-project-work-notes')?.textContent).toBe('Work Notes 2');
    expect(el.querySelector('.abyss-project-overdue')?.textContent).toBe('3');
    expect(el.querySelector('.abyss-project-diagnostics')?.textContent).toBe('1');
    expect(el.textContent).not.toMatch(/\bActions?\b|Action progress/u);
  });

  it('opens the joined Next Action in the Task inspector from an icon-only control', () => {
    const state = new AppState();
    const next = task({ title: 'Do this', tags: ['#task/next_action'] });
    const el = freshContainer();

    renderProjectsList(
      el,
      [
        workspace(proj({}), {
          tasks: [
            {
              task: next,
              projectPath: 'Projects/A.md',
              owner: { type: 'project', path: 'Projects/A.md' },
            },
          ],
        }),
      ],
      { ...ctx, state },
    );
    const control = el.querySelector<HTMLButtonElement>('[aria-label="Open Next Action"]')!;

    expect(control.textContent?.trim()).toBe('');
    expect(control.getAttribute('title')).toBeTruthy();
    expect(el.querySelector('.abyss-next-action-slot')).toBeNull();
    control.click();
    expect(state.get('taskStack')).toEqual([next]);
  });

  it('reserves no Next Action geometry when no joined Task is marked', () => {
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const overview = freshContainer();
    const overviewBaseline = freshContainer();
    const compact = freshContainer();
    const compactBaseline = freshContainer();
    activeDocument.body.append(overview, overviewBaseline, compact, compactBaseline);

    try {
      const emptyProject = proj({
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      });
      renderProjectsList(overview, [workspace(emptyProject)], {
        ...ctx,
        state: new AppState(),
      });
      const marked = task({ title: 'Marked', tags: ['#task/next_action'] });
      const markedWorkspace = workspace(emptyProject, {
        tasks: [
          {
            task: marked,
            projectPath: 'Projects/A.md',
            owner: { type: 'project', path: 'Projects/A.md' },
          },
        ],
      });
      renderProjectsList(overviewBaseline, [markedWorkspace], {
        ...ctx,
        state: new AppState(),
      });
      const dashboardContext = {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
      };
      renderProjectDashboard(compact, workspace(), dashboardContext);
      renderProjectDashboard(compactBaseline, markedWorkspace, dashboardContext);
      overviewBaseline.querySelector('[aria-label="Open Next Action"]')?.remove();
      compactBaseline.querySelector('[aria-label="Open Next Action"]')?.remove();

      expect(overview.querySelector('[aria-label="Open Next Action"]')).toBeNull();
      expect(compact.querySelector('[aria-label="Open Next Action"]')).toBeNull();
      expect(overview.querySelector('.abyss-next-action-slot')).toBeNull();
      expect(compact.querySelector('.abyss-next-action-slot')).toBeNull();
      const unsetRow = overview.querySelector<HTMLElement>('.abyss-project-row')!;
      const setRow = overviewBaseline.querySelector<HTMLElement>('.abyss-project-row')!;
      const unsetActions = unsetRow.querySelector<HTMLElement>('.abyss-project-row-actions')!;
      const setActions = setRow.querySelector<HTMLElement>('.abyss-project-row-actions')!;
      const setMeta = setRow.querySelector<HTMLElement>('.abyss-project-row-meta')!;
      expect(getComputedStyle(unsetRow).gridTemplateColumns).not.toContain('[meta]');
      expect(getComputedStyle(setRow).gridTemplateColumns).toContain('[meta]');
      expect(getComputedStyle(unsetActions).gridColumn).toBe('actions');
      expect(getComputedStyle(setActions).gridColumn).toBe('actions');
      expect(getComputedStyle(setMeta).gridColumn).toBe('meta');
      expect(unsetActions.getBoundingClientRect()).toEqual(setActions.getBoundingClientRect());
      expect(unsetRow.lastElementChild).toBe(unsetActions);
      expect(setRow.lastElementChild).toBe(setActions);
      expect(Array.from(setRow.children).indexOf(setMeta)).toBeLessThan(
        Array.from(setRow.children).indexOf(setActions),
      );
      expect(
        geometryContract(compact.querySelector<HTMLElement>('.abyss-project-dashboard-stats')!),
      ).toEqual(
        geometryContract(
          compactBaseline.querySelector<HTMLElement>('.abyss-project-dashboard-stats')!,
        ),
      );
    } finally {
      style.remove();
      overview.remove();
      overviewBaseline.remove();
      compact.remove();
      compactBaseline.remove();
    }
  });

  it('mounts only the viewport plus overscan in the production Overview', () => {
    const el = freshContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );

    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;

    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(16);
    scroll.scrollTop = 20 * 52;
    scroll.dispatchEvent(new Event('scroll'));
    const mounted = Array.from(el.querySelectorAll<HTMLElement>('[data-bounded-key]'));
    expect(mounted).toHaveLength(22);
    expect(mounted[0]?.dataset['boundedKey']).toBe('project:Projects/P13.md');
    expect(mounted[mounted.length - 1]?.dataset['boundedKey']).toBe('project:Projects/P34.md');
  });

  it('uses exact top and bottom coordinates for fractional bounded viewports', () => {
    const el = freshContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 2 * 52 });

    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(8);
    expect(el.querySelector<HTMLElement>('[data-bounded-window-edge="end"]')?.style.blockSize).toBe(
      '1716px',
    );
    scroll.scrollTop = 1;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(9);
    expect(el.querySelector<HTMLElement>('[data-bounded-window-edge="end"]')?.style.blockSize).toBe(
      '1664px',
    );
    scroll.scrollTop = 51;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(9);
    scroll.scrollTop = 52;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(9);

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 103 });
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(8);
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 105 });
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(9);

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 2 * 52 });
    scroll.scrollTop = 41 * 52 - 2 * 52;
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(8);
    expect(
      el.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
    ).toBe('1716px');
    expect(el.querySelector('[data-bounded-window-edge="end"]')).toBeNull();

    const beforeInput = Array.from(
      el.querySelectorAll<HTMLElement>('[data-bounded-key]'),
      (node) => node.dataset['boundedKey'],
    );
    el.querySelector<HTMLButtonElement>('.abyss-projects-new')!.click();
    const input = el.querySelector<HTMLElement>('.abyss-projects-new-input')!;
    expect(scroll.contains(input)).toBe(false);
    expect(input.parentElement?.classList.contains('abyss-projects-new-input-host')).toBe(true);
    scroll.dispatchEvent(new Event('scroll'));
    expect(
      Array.from(
        el.querySelectorAll<HTMLElement>('[data-bounded-key]'),
        (node) => node.dataset['boundedKey'],
      ),
    ).toEqual(beforeInput);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    scroll.dispatchEvent(new Event('scroll'));
    expect(el.querySelectorAll('[data-bounded-key]')).toHaveLength(8);
  });

  it('keeps the focused row mounted when a manual scroll stays in the same range', () => {
    const el = attachedContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    const focused = el.querySelector<HTMLElement>('.abyss-project-row')!;
    focused.focus();

    scroll.scrollTop = 1;
    scroll.dispatchEvent(new Event('scroll'));

    expect(el.querySelector<HTMLElement>('.abyss-project-row')).toBe(focused);
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('restores keyed DOM focus when a changed manual range retains the row', () => {
    const el = attachedContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    const focused = el.querySelector<HTMLElement>('.abyss-project-row')!;
    focused.focus();

    scroll.scrollTop = 52;
    scroll.dispatchEvent(new Event('scroll'));

    const remounted = el.querySelector<HTMLElement>(
      '[data-bounded-key="project:Projects/P00.md"]',
    )!;
    expect(remounted).not.toBe(focused);
    expect(activeDocument.activeElement).toBe(remounted);
  });

  it('hands focus to the stable window owner and continues logical navigation off-window', () => {
    const el = attachedContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    const windowOwner = el.querySelector<HTMLElement>('.abyss-projects-window')!;
    el.querySelector<HTMLElement>('.abyss-project-row')!.focus();

    scroll.scrollTop = 20 * 52;
    scroll.dispatchEvent(new Event('scroll'));

    expect(activeDocument.activeElement).toBe(windowOwner);
    expect(windowOwner.dataset['boundedFocusKey']).toBe('project:Projects/P00.md');
    windowOwner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement).toBe(
      el.querySelector<HTMLElement>('[data-bounded-key="project:Projects/P01.md"]'),
    );
  });

  it('does not remount the focused row on the native scroll after keyboard navigation', () => {
    const el = attachedContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    const first = el.querySelector<HTMLElement>('.abyss-project-row')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const keyboardFocused = el.querySelector<HTMLElement>(
      '[data-bounded-key="project:Projects/P01.md"]',
    )!;
    expect(activeDocument.activeElement).toBe(keyboardFocused);

    scroll.dispatchEvent(new Event('scroll'));

    expect(el.querySelector<HTMLElement>('[data-bounded-key="project:Projects/P01.md"]')).toBe(
      keyboardFocused,
    );
    expect(activeDocument.activeElement).toBe(keyboardFocused);
  });

  it('allows manual scrolling away from a retained logical focus', () => {
    const el = freshContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
    const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;
    el.querySelector<HTMLElement>('.abyss-project-row')!.dispatchEvent(new FocusEvent('focus'));

    scroll.scrollTop = 20 * 52;
    scroll.dispatchEvent(new Event('scroll'));

    expect(scroll.scrollTop).toBe(20 * 52);
    expect(el.querySelector<HTMLElement>('[data-bounded-key]')?.dataset['boundedKey']).toBe(
      'project:Projects/P13.md',
    );
  });

  it('detaches bounded-window scroll ownership when the Overview unmounts', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let resizeCallback: ResizeObserverCallback | undefined;
    const PreviousResizeObserver = globalThis.ResizeObserver;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    const el = freshContainer();
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: `Projects/P${String(index).padStart(2, '0')}.md`,
          name: `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    try {
      const cleanup = renderProjectsList(el, snapshots, { ...ctx, state: new AppState() });
      const scroll = el.querySelector<HTMLElement>('.abyss-projects-scroll')!;

      cleanup();
      scroll.scrollTop = 20 * 52;
      scroll.dispatchEvent(new Event('scroll'));
      resizeCallback?.([], {} as ResizeObserver);

      expect(observe).toHaveBeenCalledWith(scroll);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(el.querySelector<HTMLElement>('.abyss-project-row')?.dataset['boundedKey']).toBe(
        'project:Projects/P00.md',
      );
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: PreviousResizeObserver,
      });
    }
  });
});

describe('renderProjectDashboard', () => {
  it('renders header + back button; back returns to list; renders tasks', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const el = freshContainer();
    const renderTasks = vi.fn();
    renderProjectDashboard(el, workspace(), {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
    });
    expect(el.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('A');
    expect(el.querySelector('.abyss-project-tasks-title')?.textContent).toBe('Tasks');
    expect(el.textContent).not.toMatch(/\bActions?\b|Action progress/u);
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
        open: 3,
        progress: 0.25,
        estimateMin: 90,
        spentMin: 30,
      } as Project['stats'] & { estimateMin: number; spentMin: number },
    });

    renderProjectDashboard(el, workspace(project), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });

    expect(el.querySelector('.abyss-project-time')).toBeNull();
  });

  it('applies the configured Work Note filter and sort before Timeline availability/rendering', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.workNotes = {
      ...settings.projects.view.workNotes,
      statusIds: ['done'],
      sortBy: { field: 'title', dir: 'asc' },
    };
    const renderWorkNoteTimeline = vi.fn();
    const el = freshContainer();
    renderProjectDashboard(
      el,
      workspace(proj({}), {
        workNotes: [
          workNote('Work Notes/Z.md', 'done', '2026-08-29'),
          workNote('Work Notes/A.md', 'active', '2026-08-28'),
          workNote('Work Notes/B.md', 'done', '2026-08-27'),
        ],
      }),
      {
        state: new AppState(),
        settings,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
        renderWorkNotes: vi.fn(),
        renderWorkNoteTimeline,
        selectWorkNotes: (notes) =>
          selectWorkNotes({
            notes,
            statuses: [
              { id: 'active', label: 'Active' },
              { id: 'done', label: 'Done' },
            ],
            viewState: settings.projects.view.workNotes,
          }),
      },
    );
    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!.click();

    expect(renderWorkNoteTimeline).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      'Projects/A.md',
      expect.arrayContaining([]),
    );
    expect(
      renderWorkNoteTimeline.mock.lastCall?.[2].map((note: WorkNoteSnapshot) => note.path),
    ).toEqual(['Work Notes/B.md', 'Work Notes/Z.md']);
  });

  it('renders the compact-summary Next Action as an icon only and nothing when unset', () => {
    const next = task({ title: 'Do this', tags: ['#task/next_action'] });
    const action = {
      task: next,
      projectPath: 'Projects/A.md',
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    };
    const ctx = {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    };
    const set = freshContainer();
    const unset = freshContainer();

    renderProjectDashboard(set, workspace(proj({}), { tasks: [action] }), ctx);
    renderProjectDashboard(unset, workspace(), ctx);
    const control = set.querySelector<HTMLButtonElement>('[aria-label="Open Next Action"]')!;

    expect(control.textContent?.trim()).toBe('');
    expect(control.getAttribute('title')).toBeTruthy();
    expect(set.querySelector('.abyss-next-action-slot')).toBeNull();
    expect(unset.querySelector('[aria-label="Open Next Action"]')).toBeNull();
  });
});

describe('BoundedWindow', () => {
  it('returns exactly the viewport plus configured overscan', () => {
    expect(computeBoundedWindow({ count: 250, first: 20, visible: 12, overscan: 6 })).toEqual({
      start: 14,
      end: 38,
    });
  });

  it('clamps overscan to the collection boundaries', () => {
    expect(computeBoundedWindow({ count: 10, first: 0, visible: 3, overscan: 6 })).toEqual({
      start: 0,
      end: 9,
    });
    expect(computeBoundedWindow({ count: 10, first: 8, visible: 3, overscan: 6 })).toEqual({
      start: 2,
      end: 10,
    });
  });

  it('moves through logical keys that are not mounted and scrolls focus into view', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c', 'd', 'e'], 1);
    bounded.focus('b');

    expect(bounded.move(2)).toBe('d');
    expect(bounded.viewportForFocus({ first: 0, visible: 2 })).toBe(2);
    expect(bounded.bounds({ first: 2, visible: 2 })).toEqual({ start: 1, end: 5 });
  });

  it('preserves focus by stable key and restores it after the key remounts', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c'], 1);
    bounded.focus('b');
    bounded.setKeys(['c', 'b', 'a']);
    const host = freshContainer();
    const mounted = host.createEl('button', { attr: { 'data-bounded-key': 'b' } });
    const focus = vi.spyOn(mounted, 'focus');
    const scrollIntoView = vi.fn();
    mounted.scrollIntoView = scrollIntoView;

    expect(bounded.focusedKey()).toBe('b');
    expect(bounded.restoreFocus(host)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('mounts only the computed slice, scrolls the logical focus, and restores DOM focus', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c', 'd', 'e'], 1);
    const host = freshContainer();
    const scrolled = vi.fn();
    const focused = vi.fn();
    bounded.focus('d');

    const range = bounded.render(host, {
      first: 0,
      visible: 2,
      itemExtent: 40,
      restoreFocus: true,
      render: (container, key) => {
        const button = container.createEl('button');
        if (key === 'd') {
          button.scrollIntoView = scrolled;
          button.focus = focused;
        }
        return button;
      },
    });

    expect(range).toEqual({ start: 1, end: 5, first: 2 });
    expect(Array.from(host.querySelectorAll('[data-bounded-key]'), (el) => el.textContent)).toEqual(
      ['', '', '', ''],
    );
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('[data-bounded-key]'),
        (element) => element.dataset['boundedKey'],
      ),
    ).toEqual(['b', 'c', 'd', 'e']);
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
    expect(focused).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not re-anchor a manual viewport when focus restoration is not requested', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c', 'd', 'e'], 1);
    const host = freshContainer();
    const scrolled = vi.fn();
    bounded.focus('d');

    const range = bounded.render(host, {
      first: 0,
      visible: 2,
      itemExtent: 40,
      restoreFocus: false,
      render: (container, key) => {
        const button = container.createEl('button');
        if (key === 'd') button.scrollIntoView = scrolled;
        return button;
      },
    });

    expect(range).toEqual({ start: 0, end: 3, first: 0 });
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('restores a retained keyed row after manual replacement without scrolling it', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c', 'd'], 1);
    const host = attachedContainer();
    const scrolled = vi.fn();
    const render = (container: HTMLElement, key: string): HTMLElement => {
      const button = container.createEl('button');
      if (key === 'b') button.scrollIntoView = scrolled;
      return button;
    };
    bounded.render(host, { first: 0, visible: 2, itemExtent: 40, render });
    bounded.focus('b');
    host.querySelector<HTMLElement>('[data-bounded-key="b"]')!.focus();

    bounded.render(host, { first: 1, visible: 2, itemExtent: 40, render });

    expect(activeDocument.activeElement).toBe(
      host.querySelector<HTMLElement>('[data-bounded-key="b"]'),
    );
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('remounts an unchanged logical range when its spacer extent changes', () => {
    const bounded = new BoundedWindow(['a', 'b', 'c', 'd'], 0);
    const host = freshContainer();
    const render = (container: HTMLElement): HTMLElement => container.createEl('button');
    bounded.render(host, { first: 1, visible: 2, itemExtent: 40, render });
    const firstMounted = host.querySelector('[data-bounded-key="b"]');
    expect(
      host.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
    ).toBe('40px');

    bounded.render(host, { first: 1, visible: 2, itemExtent: 52, render });

    expect(host.querySelector('[data-bounded-key="b"]')).not.toBe(firstMounted);
    expect(
      host.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
    ).toBe('52px');
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
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
    });
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-list')).toBeTruthy();
  });

  it('renders the dashboard when projectsPanel is dashboard', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
    });
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-projects-dashboard')).toBeTruthy();
  });

  it('renders the dated portfolio Timeline and delegates endpoint changes to ProjectCommandService', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'timeline';
    const datedProject = proj({
      frontmatter: {
        start: '2026-08-26T14:30:00+07:00',
        end: '2026-08-30',
      },
      range: parseProjectRange('2026-08-26T14:30:00+07:00', '2026-08-30'),
    });
    const setRange = vi.fn().mockResolvedValue({
      type: 'ok',
      range: parseProjectRange('2026-08-26T14:30:00+07:00', '2026-09-01'),
    });
    const projectCommands = {
      observeRange: vi.fn().mockReturnValue({
        path: datedProject.path,
        start: datedProject.frontmatter['start'],
        end: datedProject.frontmatter['end'],
      }),
      setRange,
    } as never;
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace(datedProject)],
      projectCommands,
    });
    const el = freshContainer();
    panel.mount(el);
    const end = el.querySelector<HTMLInputElement>('[data-timeline-date-picker="end"]')!;

    expect(el.querySelector('.abyss-timeline')).not.toBeNull();
    end.value = '2026-09-01';
    end.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(setRange).toHaveBeenCalledWith(
      {
        path: 'Projects/A.md',
        start: '2026-08-26T14:30:00+07:00',
        end: '2026-08-30',
      },
      { end: expect.objectContaining({ raw: '2026-09-01', precision: 'date' }) },
    );
  });

  it('retains pending Undo through a synchronous Project store refresh', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.statuses.push({
      ...settings.projects.statuses[0]!,
      id: 'published',
      label: 'Published',
      behavior: 'published',
      match: { kind: 'property', property: 'status', value: 'published' },
    });
    settings.projects.view.visibleStatusIds.push('published');
    const state = new AppState();
    const setStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: ACTIVE_ID,
      nextStatusId: 'published',
    });
    const undoStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: ACTIVE_ID,
      nextStatusId: 'published',
    });
    const manager = {
      setStatus,
      undoStatus,
      create: vi.fn(),
    } as never;
    let panel: ProjectsPanel;
    const store = {
      list: () => [proj({})],
      get: () => proj({}),
      activeForLeftPanel: () => [],
      onUpdate: () => () => {},
      refresh: () => panel.refresh(),
    } as never;
    panel = new ProjectsPanel(state, store, manager, settings, null as never, {
      snapshots: [workspace()],
    });
    const el = freshContainer();
    panel.mount(el);
    const card = el.querySelector<HTMLElement>('[data-board-item="Projects/A.md"]')!;
    const target = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    el.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(undoStatus).toHaveBeenCalledWith('Projects/A.md', 'published', ACTIVE_ID);
  });
});
