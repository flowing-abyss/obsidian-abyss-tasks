// eslint-disable-next-line import/no-nodejs-modules -- geometry contract loads the shipped CSS.
import { readFileSync } from 'node:fs';
import { Menu, TFile, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { createProjectBoardMutation } from '../src/panels/projects/boardProjection';
import { BoundedWindow, computeBoundedWindow } from '../src/panels/projects/BoundedWindow';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import { renderProjectsBoard } from '../src/panels/projects/ProjectsBoardView';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { renderProjectsList } from '../src/panels/projects/ProjectsListView';
import { ProjectsPanel } from '../src/panels/projects/ProjectsPanel';
import { ProjectWorkspaceSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type { ProjectChildRenderHandle } from '../src/panels/projects/viewContext';
import { selectWorkNotes } from '../src/panels/projects/WorkNotesView';
import { parseProjectRange } from '../src/projects/projectDates';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import { computeWorkNotePresetFingerprint } from '../src/projects/work-notes/compatibility';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, flushMicrotasks, freshContainer, task } from './helpers';

const ACTIVE_ID = DEFAULT_SETTINGS.projects.statuses[0]!.id;
const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return shippedStyles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
}

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
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
    ...over,
  };
}

function projectPointer(
  el: HTMLElement,
  sourceColumnId: string,
  destinationColumnId: string,
  pointerId = 21,
): (type: string, x: number) => void {
  const card = el.querySelector<HTMLElement>('[data-board-item="Projects/A.md"]')!;
  const source = el.querySelector<HTMLElement>(`[data-board-column="${sourceColumnId}"]`)!;
  const destination = el.querySelector<HTMLElement>(
    `[data-board-column="${destinationColumnId}"]`,
  )!;
  const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
  card.getBoundingClientRect = () => new DOMRect(20, 40, 220, 72);
  source.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
  destination.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 560, 500);
  return (type, x) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 60,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      isPrimary: { value: true },
    });
    card.dispatchEvent(event);
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
  it('reserves a compact in-flow Board toolbar instead of overlaying Undo on content', () => {
    const toolbar = declarationsFor('.abyss-board-toolbar');
    expect(toolbar).toContain('block-size: var(--input-height)');
    expect(toolbar).toContain('display: flex');
    expect(declarationsFor('.abyss-board-undo')).not.toMatch(/position:\s*(?:absolute|fixed)/u);
  });

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
    await flushMicrotasks();

    expect(settings.projects.view.portfolioLayout).toBe('board');
    expect(settings.projects.view.visibleStatusIds).toEqual([ACTIVE_ID]);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onPortfolioLayoutChanged).toHaveBeenCalledOnce();
  });

  it('keeps Timeline in the portfolio switcher and disables it only without a renderer', async () => {
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
    await flushMicrotasks();
    expect(settings.projects.view.portfolioLayout).toBe('timeline');
    expect(onPortfolioLayoutChanged).toHaveBeenCalledOnce();

    const unavailable = freshContainer();
    renderProjectsList(unavailable, [workspace()], {
      ...ctx,
      settings: structuredClone(DEFAULT_SETTINGS),
      timelineAvailable: false,
    });
    expect(
      unavailable.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="timeline"]')
        ?.disabled,
    ).toBe(true);
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

  it('renders terminal and regular collapsed rails while removing hidden columns from the DOM', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.statuses.push(
      {
        id: 'dropped',
        label: 'Dropped',
        behavior: 'dropped',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'dropped' },
      },
      {
        id: 'published',
        label: 'Published',
        behavior: 'published',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'published' },
      },
    );
    const [active, planned] = settings.projects.statuses;
    const dropped = settings.projects.statuses.find(({ behavior }) => behavior === 'dropped')!;
    const published = settings.projects.statuses.find(({ behavior }) => behavior === 'published')!;
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    settings.projects.view.board = {
      version: 1,
      columnOrder: [dropped.id, active!.id, planned!.id, published.id],
      collapsedColumnIds: [dropped.id, planned!.id, published.id],
      hiddenColumnIds: [active!.id],
    };
    const el = freshContainer();

    renderProjectsBoard(el, {
      ...ctx,
      settings,
      snapshots: [workspace()],
      onMoveStatus: vi.fn(),
      onUndoStatus: vi.fn(),
    });

    expect(el.querySelector(`[data-board-column="${active!.id}"]`)).toBeNull();
    expect(el.querySelectorAll('.abyss-board-column.is-column-collapsed')).toHaveLength(3);
    const hidden = el.querySelector<HTMLButtonElement>('[data-board-hidden-disclosure]');
    expect(hidden?.textContent).toContain('Hidden');
    expect(hidden?.textContent).toContain('1');
  });

  it('shows one repair diagnostic and disables every lifecycle mutation for duplicate terminals', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const hiddenStatus = settings.projects.statuses[1]!;
    settings.projects.statuses.push(
      {
        id: 'dropped',
        label: 'Dropped',
        behavior: 'dropped',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'dropped' },
      },
      {
        id: 'second-dropped',
        label: 'Abandoned',
        behavior: 'dropped',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'abandoned' },
      },
    );
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    settings.projects.view.board = {
      ...settings.projects.view.board,
      orderOverride: true,
      columnOrder: [...settings.projects.view.board.columnOrder].reverse(),
      hiddenColumnIds: [hiddenStatus.id],
    };
    const preferenceBefore = structuredClone(settings.projects.view.board);
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    const el = freshContainer();

    renderProjectsBoard(el, {
      ...ctx,
      settings,
      snapshots: [workspace()],
      onSaveSettings,
      onMoveStatus: vi.fn(),
      onUndoStatus: vi.fn(),
    });

    expect(el.querySelectorAll('[data-board-lifecycle-diagnostic]')).toHaveLength(1);
    expect(el.querySelector('[data-board-lifecycle-diagnostic]')?.textContent).toMatch(
      /only one.*dropped/i,
    );
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('[data-board-status-menu]')).every(
        ({ disabled }) => disabled,
      ),
    ).toBe(true);
    expect(el.querySelector('[data-board-interaction-root]')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('[data-board-reorder-handle]')).every(
        ({ disabled }) => disabled,
      ),
    ).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-board-reset-order]')?.disabled).toBe(true);
    const preferenceControls = Array.from(
      el.querySelectorAll<HTMLButtonElement>(
        '[data-board-collapse-column], [data-board-hide-column], [data-board-column-menu], [data-board-restore-column]',
      ),
    );
    expect(preferenceControls.length).toBeGreaterThan(0);
    expect(preferenceControls.every(({ disabled }) => disabled)).toBe(true);
    for (const control of preferenceControls) control.click();
    expect(settings.projects.view.board).toEqual(preferenceBefore);
    expect(onSaveSettings).not.toHaveBeenCalled();
  });

  it('persists regular column collapse, hide, restore, reorder, and reset from Board controls', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const regular = settings.projects.statuses.filter(
      ({ behavior }) => behavior !== 'dropped' && behavior !== 'published',
    );
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    const el = freshContainer();

    const render = () =>
      renderProjectsBoard(el, {
        ...ctx,
        settings,
        onSaveSettings,
        snapshots: [workspace()],
        onMoveStatus: vi.fn(),
        onUndoStatus: vi.fn(),
      });
    let handle = render();
    el.querySelector<HTMLButtonElement>(
      `[data-board-collapse-column="${regular[0]!.id}"]`,
    )!.click();
    await Promise.resolve();
    expect(settings.projects.view.board.collapsedColumnIds).toContain(regular[0]!.id);

    el.querySelector<HTMLButtonElement>(`[data-board-hide-column="${regular[1]!.id}"]`)!.click();
    await Promise.resolve();
    expect(settings.projects.view.board.hiddenColumnIds).toContain(regular[1]!.id);
    handle.destroy();
    handle = render();
    el.querySelector<HTMLButtonElement>('[data-board-hidden-disclosure]')!.click();
    el.querySelector<HTMLButtonElement>(`[data-board-restore-column="${regular[1]!.id}"]`)!.click();
    await Promise.resolve();
    expect(settings.projects.view.board.hiddenColumnIds).not.toContain(regular[1]!.id);

    el.querySelector<HTMLButtonElement>(
      `[data-board-reorder-handle="${regular[0]!.id}"]`,
    )!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await Promise.resolve();
    expect(settings.projects.view.board.columnOrder.indexOf(regular[0]!.id)).toBeGreaterThan(
      settings.projects.view.board.columnOrder.indexOf(regular[1]!.id),
    );
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-column]'))
        .map(({ dataset }) => dataset['boardColumn'])
        .filter((id) => id !== 'unmapped'),
    ).toEqual(settings.projects.view.board.columnOrder);
    handle.destroy();
    handle = render();
    el.querySelector<HTMLButtonElement>('[data-board-reset-order]')!.click();
    await Promise.resolve();
    expect(settings.projects.view.board.columnOrder).toEqual(
      settings.projects.statuses.map(({ id }) => id),
    );
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-column]'))
        .map(({ dataset }) => dataset['boardColumn'])
        .filter((id) => id !== 'unmapped'),
    ).toEqual(settings.projects.view.board.columnOrder);
    expect(onSaveSettings).toHaveBeenCalled();
    handle.destroy();
  });

  it('uses the shared pointer controller for an exact single Project lifecycle move', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const state = new AppState();
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: active!.id,
      nextStatusId: planned!.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state,
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="Projects/A.md"]')!;
    const source = el.querySelector<HTMLElement>(`[data-board-column="${active!.id}"]`)!;
    const target = el.querySelector<HTMLElement>(`[data-board-column="${planned!.id}"]`)!;
    const columns = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 40, 220, 72);
    source.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    target.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    columns.getBoundingClientRect = () => new DOMRect(0, 0, 560, 500);
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 60,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 9 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    expect(card.getAttribute('draggable')).toBe('false');
    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    expect(el.querySelector('[data-board-drag-preview]')?.textContent).toContain('A');
    expect(el.querySelector('[data-board-landing-gap]')).not.toBeNull();
    pointer('pointerup', 320);
    card.querySelector<HTMLButtonElement>('[data-project-identity-control]')!.click();
    pointer('pointerup', 320);
    await Promise.resolve();
    await Promise.resolve();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(onMoveStatus).toHaveBeenCalledWith('Projects/A.md', planned!.id);
    expect(state.get('projectsPanel')).toEqual({ view: 'list' });
    expect(el.querySelector('[data-board-drag-preview]')).toBeNull();
  });

  it.each([
    { label: 'Dropped rail', behavior: 'dropped' as const, id: 'dropped', collapsed: true },
    { label: 'Published rail', behavior: 'published' as const, id: 'published', collapsed: true },
    {
      label: 'collapsed regular column',
      behavior: 'regular' as const,
      id: 'planned',
      collapsed: true,
    },
  ])('moves a Project by pointer into a $label', async ({ behavior, id, collapsed }) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const active = settings.projects.statuses[0]!;
    const existing = settings.projects.statuses.find(({ label }) => label === 'Planned');
    const target =
      behavior === 'regular'
        ? existing!
        : {
            ...active,
            id,
            label: behavior === 'dropped' ? 'Dropped' : 'Published',
            behavior,
            match: { kind: 'property' as const, property: 'status', value: id },
          };
    if (behavior !== 'regular') settings.projects.statuses.push(target);
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    settings.projects.view.board = {
      ...settings.projects.view.board,
      collapsedColumnIds: collapsed ? [target.id] : [],
    };
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: active.id,
      nextStatusId: target.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    const pointer = projectPointer(el, active.id, target.id);

    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    pointer('pointerup', 320);
    await flushMicrotasks();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(onMoveStatus).toHaveBeenCalledWith('Projects/A.md', target.id);
  });

  it('moves a Project through the hidden-column disclosure destination', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    settings.projects.view.board = {
      ...settings.projects.view.board,
      hiddenColumnIds: [planned!.id],
    };
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: active!.id,
      nextStatusId: planned!.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="Projects/A.md"]')!;
    const source = el.querySelector<HTMLElement>(`[data-board-column="${active!.id}"]`)!;
    const disclosure = el.querySelector<HTMLElement>('[data-board-hidden-disclosure]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 80, 220, 72);
    source.getBoundingClientRect = () => new DOMRect(0, 60, 272, 500);
    disclosure.getBoundingClientRect = () => new DOMRect(300, 0, 120, 44);
    scroller.getBoundingClientRect = () => new DOMRect(0, 60, 560, 500);
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 24 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 40, 100);
    pointer('pointermove', 340, 22);
    const hiddenTarget = el.querySelector<HTMLElement>(
      `[data-board-hidden-target="${planned!.id}"]`,
    )!;
    expect(hiddenTarget).not.toBeNull();
    hiddenTarget.getBoundingClientRect = () => new DOMRect(300, 50, 120, 44);
    pointer('pointermove', 340, 72);
    expect(el.querySelector('[data-board-drag-preview]')?.textContent).toContain('Planned');
    el.querySelector<HTMLElement>(
      `[data-board-hidden-target="${planned!.id}"]`,
    )!.getBoundingClientRect = () => new DOMRect(300, 50, 120, 44);
    pointer('pointerup', 340, 72);
    await flushMicrotasks();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(onMoveStatus).toHaveBeenCalledWith('Projects/A.md', planned!.id);
  });

  it('cancels an invalid pointer landing and restores the source after a conflict', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'conflict',
      currentStatusId: active!.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    let pointer = projectPointer(el, active!.id, planned!.id);
    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    el.querySelector<HTMLElement>('[data-board-item-focus="Projects/A.md"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    pointer('pointerup', 320);
    expect(onMoveStatus).not.toHaveBeenCalled();
    expect(el.querySelector('[data-board-drag-preview]')).toBeNull();

    pointer = projectPointer(el, active!.id, planned!.id, 22);
    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    pointer('pointerup', 320);
    await flushMicrotasks();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(
      el.querySelector(`[data-board-column="${active!.id}"] [data-board-item="Projects/A.md"]`),
    ).not.toBeNull();
    expect(el.querySelector('[data-board-drag-preview]')).toBeNull();
  });

  it('does not commit a Project move when the pointer lands outside every destination', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onMoveStatus = vi.fn();
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    const pointer = projectPointer(el, active!.id, planned!.id, 25);

    pointer('pointerdown', 40);
    pointer('pointermove', 900);
    pointer('pointerup', 900);
    await flushMicrotasks();

    expect(onMoveStatus).not.toHaveBeenCalled();
    expect(
      el.querySelector(`[data-board-column="${active!.id}"] [data-board-item="Projects/A.md"]`),
    ).not.toBeNull();
    expect(el.querySelector('[data-board-drag-preview]')).toBeNull();
  });

  it('restores the Project source and reports one local error after a failed command', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onMoveStatus = vi.fn().mockResolvedValue({ type: 'io-error' });
    const onAnnounce = vi.fn();
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
      onAnnounce,
    });
    const pointer = projectPointer(el, active!.id, planned!.id, 26);

    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    pointer('pointerup', 320);
    await flushMicrotasks();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(
      el.querySelector(`[data-board-column="${active!.id}"] [data-board-item="Projects/A.md"]`),
    ).not.toBeNull();
    expect(el.querySelector('[data-board-drag-preview]')).toBeNull();
    expect(onAnnounce.mock.calls.filter(([message]) => message === 'io-error')).toHaveLength(1);
  });

  it('preserves the Project destination when Undo is refused by a conflict', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: active!.id,
      nextStatusId: planned!.id,
    });
    const onUndoStatus = vi
      .fn()
      .mockResolvedValue({ type: 'conflict', currentStatusId: planned!.id });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus,
    });
    const pointer = projectPointer(el, active!.id, planned!.id);
    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    pointer('pointerup', 320);
    await flushMicrotasks();

    el.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    await flushMicrotasks();
    expect(onUndoStatus).toHaveBeenCalledOnce();
    expect(
      el.querySelector(`[data-board-column="${planned!.id}"] [data-board-item="Projects/A.md"]`),
    ).not.toBeNull();
    expect(el.querySelector('[data-board-undo]')).toBeNull();
  });

  it('restores the Project source after a successful Undo', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const onUndoStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: planned!.id,
      nextStatusId: active!.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots: [workspace()],
      onMoveStatus: vi.fn().mockResolvedValue({
        type: 'ok',
        previousStatusId: active!.id,
        nextStatusId: planned!.id,
      }),
      onUndoStatus,
    });
    const pointer = projectPointer(el, active!.id, planned!.id, 23);
    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    pointer('pointerup', 320);
    await flushMicrotasks();

    el.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    await flushMicrotasks();
    expect(onUndoStatus).toHaveBeenCalledOnce();
    expect(
      el.querySelector(`[data-board-column="${active!.id}"] [data-board-item="Projects/A.md"]`),
    ).not.toBeNull();
  });

  it('offers the same controller move through Space and arrow keys', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const [active, planned] = settings.projects.statuses;
    settings.projects.view.visibleStatusIds = settings.projects.statuses.map(({ id }) => id);
    const state = new AppState();
    const onMoveStatus = vi.fn().mockResolvedValue({
      type: 'ok',
      previousStatusId: active!.id,
      nextStatusId: planned!.id,
    });
    const el = freshContainer();
    renderProjectsBoard(el, {
      ...ctx,
      state,
      settings,
      snapshots: [workspace()],
      onMoveStatus,
      onUndoStatus: vi.fn(),
    });
    const identity = el.querySelector<HTMLElement>('[data-board-item-focus="Projects/A.md"]')!;
    identity.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(state.get('projectsPanel')).toEqual({ view: 'list' });
    identity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    identity.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onMoveStatus).toHaveBeenCalledOnce();
    expect(onMoveStatus).toHaveBeenCalledWith('Projects/A.md', planned!.id);
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
      deepRow.querySelector<HTMLElement>('[data-board-item-focus="Projects/22.md"]')!.focus();
      for (let index = 0; index < 5; index += 1) {
        activeDocument.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }

      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Projects/27.md',
      );
      expect(scroll.scrollTop).toBe(26 * 88);
      expect(el.querySelector('[data-board-item-focus="Projects/27.md"]')).not.toBeNull();
    } finally {
      style.remove();
      el.remove();
    }
  });

  it('reveals and focuses a created Project beyond the first bounded Board window in its narrow column', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const targetStatus = settings.projects.statuses.find(({ id }) => id !== ACTIVE_ID)!;
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.view.visibleStatusIds = [ACTIVE_ID, targetStatus.id];
    const targetPath = 'Projects/Z-created.md';
    const snapshots = Array.from({ length: 120 }, (_, index) =>
      workspace(
        proj({
          path: index === 119 ? targetPath : `Projects/P${String(index).padStart(3, '0')}.md`,
          name: index === 119 ? 'Z created' : `P${String(index).padStart(3, '0')}`,
          statusId: targetStatus.id,
        }),
      ),
    );
    const session = new ProjectWorkspaceSession();
    session.portfolioCapture.createdPath = targetPath;
    const el = attachedContainer();

    renderProjectsBoard(el, {
      ...ctx,
      state: new AppState(),
      settings,
      snapshots,
      captureSession: session.portfolioCapture,
      session: session.portfolioBoard,
      onMoveStatus: vi.fn(),
      onUndoStatus: vi.fn(),
    });
    await Promise.resolve();

    expect(
      el.querySelector<HTMLElement>('[data-board-column-tab][aria-selected="true"]')?.dataset[
        'boardColumnTab'
      ],
    ).toBe(targetStatus.id);
    const target = el.querySelector<HTMLElement>(`[data-project-path="${targetPath}"]`)!;
    expect(target).not.toBeNull();
    expect(target.classList.contains('is-just-created')).toBe(true);
    expect(activeDocument.activeElement).toBe(
      target.querySelector<HTMLElement>('[data-project-identity-control]'),
    );
    expect(session.portfolioCapture.createdPath).toBeNull();
    el.remove();
  });

  it('constrains a long Project title to its Board identity control', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'board';
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const el = attachedContainer();
    try {
      renderProjectsBoard(el, {
        ...ctx,
        state: new AppState(),
        settings,
        snapshots: [
          workspace(
            proj({
              name: 'A deliberately long Project title that must not escape its Board card',
            }),
            {
              workNoteRollup: { active: 12, completed: 8, dropped: 4 },
              overdue: { tasks: 3, workNotes: 2 },
              diagnostics: [
                {
                  type: 'work-note',
                  path: 'Work Notes/Dense fixture.md',
                  diagnostic: { type: 'broken-relation', field: 'blockedBy' },
                },
              ],
            },
          ),
        ],
        onMoveStatus: vi.fn(),
        onUndoStatus: vi.fn(),
      });

      const identity = el.querySelector<HTMLElement>('.abyss-project-row-name')!;
      const title = el.querySelector<HTMLElement>('.abyss-project-name')!;
      expect(getComputedStyle(identity).minWidth).toBe('0px');
      expect(getComputedStyle(title).minWidth).toBe('0px');
      expect(getComputedStyle(title).maxWidth).toBe('100%');
    } finally {
      style.remove();
      el.remove();
    }
  });

  it('keeps the native Overview title button quiet and left-aligned under Obsidian button chrome', () => {
    const style = activeDocument.head.createEl('style');
    style.textContent = `${shippedStyles}\nbutton:not(.clickable-icon) {
      background-color: rgb(51, 51, 51);
      justify-content: center;
    }`;
    const el = attachedContainer();
    try {
      renderProjectsList(el, [workspace()], { ...ctx, state: new AppState() });

      const identity = el.querySelector<HTMLElement>('.abyss-project-row-name')!;
      const computed = getComputedStyle(identity);
      expect(computed.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(computed.justifyContent).toBe('flex-start');
      expect(computed.textAlign).toBe('start');
    } finally {
      style.remove();
      el.remove();
    }
  });

  it('contains dense Board evidence in the same two-line Project card without metadata overflow', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'board';
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const el = attachedContainer();
    try {
      renderProjectsBoard(el, {
        ...ctx,
        state: new AppState(),
        settings,
        snapshots: [
          workspace(proj({ name: 'Dense metadata Project' }), {
            workNoteRollup: { active: 12, completed: 8, dropped: 4 },
            overdue: { tasks: 3, workNotes: 2 },
            diagnostics: [
              {
                type: 'work-note',
                path: 'Work Notes/Dense fixture.md',
                diagnostic: { type: 'broken-relation', field: 'blockedBy' },
              },
            ],
          }),
        ],
        onMoveStatus: vi.fn(),
        onUndoStatus: vi.fn(),
      });

      const row = el.querySelector<HTMLElement>('.abyss-project-row')!;
      const lines = row.querySelectorAll<HTMLElement>('.abyss-project-row-line');
      expect(lines).toHaveLength(2);
      expect(Array.from(lines).every((line) => getComputedStyle(line).overflow === 'hidden')).toBe(
        true,
      );
      expect(row.querySelector('.abyss-project-row-meta')).toBeNull();
      expect(row.textContent).not.toMatch(/\bTasks\b|\bWork Notes\b/u);
    } finally {
      style.remove();
      el.remove();
    }
  });

  it('row click switches to the dashboard view', () => {
    const state = new AppState();
    const el = freshContainer();
    renderProjectsList(el, [workspace()], { ...ctx, state });
    el.querySelector<HTMLButtonElement>('[data-project-identity-control]')!.click();
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
    await flushMicrotasks();

    expect(settings.projects.view.visibleStatusIds).toEqual(['wip']);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onSetStatus).not.toHaveBeenCalled();
    expect(openNote).not.toHaveBeenCalled();
  });

  it('restores a persisted filter semantically only when that filter owned focus', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const root = attachedContainer();
    const outside = activeDocument.body.createEl('button');
    let forceOutsideFocus = false;
    let cleanup = (): void => undefined;
    const context = {
      ...ctx,
      state: new AppState(),
      settings,
      onSaveSettings: vi.fn().mockResolvedValue(undefined),
      onFiltersChanged: () => {
        cleanup();
        root.empty();
        cleanup = renderProjectsList(root, [workspace()], context);
        if (forceOutsideFocus) outside.focus();
      },
    };
    try {
      cleanup = renderProjectsList(root, [workspace()], context);
      const active = root.querySelector<HTMLButtonElement>(
        `[data-project-status-filter="${ACTIVE_ID}"]`,
      )!;
      active.focus();
      active.click();
      await flushMicrotasks();
      expect(activeDocument.activeElement?.getAttribute('data-project-status-filter')).toBe(
        ACTIVE_ID,
      );

      const unmapped = root.querySelector<HTMLButtonElement>('[data-project-unmapped-filter]')!;
      unmapped.focus();
      unmapped.click();
      await flushMicrotasks();
      expect(activeDocument.activeElement?.hasAttribute('data-project-unmapped-filter')).toBe(true);

      const pointerFilter = root.querySelector<HTMLButtonElement>(
        `[data-project-status-filter="${ACTIVE_ID}"]`,
      )!;
      pointerFilter.focus();
      pointerFilter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      forceOutsideFocus = true;
      pointerFilter.click();
      await flushMicrotasks();
      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      cleanup();
      outside.remove();
      root.remove();
    }
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
    await flushMicrotasks();

    expect(settings.projects.view.includeUnmapped).toBe(true);
    expect(onSaveSettings).toHaveBeenCalledOnce();
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it('keeps joined rollups available as compact progress without redundant metric labels', () => {
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

    expect(el.querySelector('.abyss-project-task-progress')?.textContent).toBe('1/3');
    expect(el.querySelector('.abyss-project-work-note-count')?.getAttribute('aria-label')).toBe(
      '2 Work Notes',
    );
    expect(el.querySelector('.abyss-project-work-note-count')?.textContent).toBe('2');
    expect(el.querySelector('.abyss-project-diagnostic-count')).not.toBeNull();
    expect(el.querySelector('.abyss-project-row-meta')).toBeNull();
    expect(el.textContent).not.toMatch(/\bTasks\b|\bWork Notes\b/u);
    expect(el.textContent).not.toMatch(/\bActions?\b|Action progress/u);
  });

  it('includes milestone-only Work Notes and invalid dependency evidence in the two-line identity', () => {
    const el = freshContainer();
    const milestone = {
      ...workNote('Work Notes/Release.md', ACTIVE_ID, '2026-08-29'),
      kind: 'milestone' as const,
    };
    const cleanup = renderProjectsList(
      el,
      [
        workspace(proj({}), {
          workNotes: [],
          milestones: [milestone],
          workNoteRollup: { active: 0, completed: 0, dropped: 0 },
          dependencies: { blocked: 0, invalid: 2, diagnostics: [] },
        }),
      ],
      { ...ctx, state: new AppState() },
    );

    expect(el.querySelector('.abyss-project-work-note-count')?.textContent).toBe('1');
    expect(el.querySelector('.abyss-project-diagnostic-count')?.textContent).toBe('2');
    expect(el.querySelectorAll('.abyss-project-row-line')).toHaveLength(2);
    cleanup();
  });

  it('opens the joined Next Action from its visible second-line title', () => {
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
              dependency: { type: 'allowed' },
              owner: { type: 'project', path: 'Projects/A.md' },
            },
          ],
        }),
      ],
      { ...ctx, state },
    );
    const control = el.querySelector<HTMLButtonElement>('[aria-label="Open Next Action"]')!;

    expect(control.textContent?.trim()).toBe('Do this');
    expect(control.getAttribute('title')).toBeTruthy();
    expect(el.querySelector('.abyss-next-action-slot')).toBeNull();
    control.click();
    expect(state.get('taskStack')).toEqual([next]);
  });

  it('renders the deterministic actionable Next Action selected by health', () => {
    const completed = task({
      title: 'Completed tag must not win',
      tags: ['#task/next_action'],
      status: 'done',
    });
    const actionable = task({
      title: 'Actionable candidate',
      tags: ['#task/next_action'],
      status: 'open',
      planning: { due: '2026-08-29' },
    });
    const el = freshContainer();
    renderProjectsList(
      el,
      [
        workspace(proj({}), {
          tasks: [completed, actionable].map((candidate) => ({
            task: candidate,
            projectPath: 'Projects/A.md',
            dependency: { type: 'allowed' as const },
            owner: { type: 'project' as const, path: 'Projects/A.md' },
          })),
        }),
      ],
      { ...ctx, state: new AppState(), today: () => '2026-08-28' },
    );

    expect(el.querySelector('.abyss-project-next-action-title')?.textContent).toBe(
      'Actionable candidate',
    );
  });

  it('keeps row extent and overlaid actions stable with or without a secondary line', () => {
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
            dependency: { type: 'allowed' },
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
      expect(unsetRow.querySelectorAll('.abyss-project-row-line')).toHaveLength(1);
      expect(setRow.querySelectorAll('.abyss-project-row-line')).toHaveLength(2);
      expect(unsetRow.querySelector('.abyss-project-row-meta')).toBeNull();
      expect(setRow.querySelector('.abyss-project-row-meta')).toBeNull();
      expect(getComputedStyle(unsetActions).position).toBe('absolute');
      expect(getComputedStyle(setActions).position).toBe('absolute');
      expect(unsetActions.getBoundingClientRect()).toEqual(setActions.getBoundingClientRect());
      expect(unsetRow.lastElementChild).toBe(unsetActions);
      expect(setRow.lastElementChild).toBe(setActions);
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
    expect(input.closest('.abyss-projects-new-input-host')).not.toBeNull();
    expect(input.closest('.abyss-projects-toolbar')).not.toBeNull();
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
    const focused = el.querySelector<HTMLElement>('[data-project-identity-control]')!;
    focused.focus();

    scroll.scrollTop = 1;
    scroll.dispatchEvent(new Event('scroll'));

    expect(el.querySelector<HTMLElement>('[data-project-identity-control]')).toBe(focused);
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
    const focused = el.querySelector<HTMLElement>('[data-project-identity-control]')!;
    focused.focus();

    scroll.scrollTop = 52;
    scroll.dispatchEvent(new Event('scroll'));

    const remounted = el
      .querySelector<HTMLElement>('[data-bounded-key="project:Projects/P00.md"]')!
      .querySelector<HTMLElement>('[data-project-identity-control]')!;
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
    el.querySelector<HTMLElement>('[data-project-identity-control]')!.focus();

    scroll.scrollTop = 20 * 52;
    scroll.dispatchEvent(new Event('scroll'));

    expect(activeDocument.activeElement).toBe(windowOwner);
    expect(windowOwner.dataset['boundedFocusKey']).toBe('project:Projects/P00.md');
    windowOwner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement).toBe(
      el
        .querySelector<HTMLElement>('[data-bounded-key="project:Projects/P01.md"]')
        ?.querySelector<HTMLElement>('[data-project-identity-control]'),
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
    const first = el.querySelector<HTMLElement>('[data-project-identity-control]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const keyboardFocused = el
      .querySelector<HTMLElement>('[data-bounded-key="project:Projects/P01.md"]')!
      .querySelector<HTMLElement>('[data-project-identity-control]')!;
    expect(activeDocument.activeElement).toBe(keyboardFocused);

    scroll.dispatchEvent(new Event('scroll'));

    expect(
      el
        .querySelector<HTMLElement>('[data-bounded-key="project:Projects/P01.md"]')
        ?.querySelector<HTMLElement>('[data-project-identity-control]'),
    ).toBe(keyboardFocused);
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
      expect(disconnect).toHaveBeenCalledTimes(2);
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
  it('keeps the Project summary to two semantic rows and nests scope in collection controls', () => {
    const el = freshContainer();
    const project = proj({
      priority: 'A',
      description: 'Inspector-only description',
      frontmatter: { description: 'Inspector-only description' },
    });
    renderProjectDashboard(el, workspace(project), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
    });

    const summary = el.querySelector('[data-project-summary]')!;
    expect(summary.querySelectorAll(':scope > [data-project-summary-row]')).toHaveLength(2);
    expect(summary.textContent).toContain('A');
    expect(summary.textContent).not.toContain('Inspector-only description');
    expect(el.querySelector('.abyss-project-description')).toBeNull();
    const scopeRow = el.querySelector('[data-project-scope-controls]')!;
    const collectionRow = el.querySelector('[data-collection-controls]')!;
    expect(scopeRow.closest('[data-collection-controls]')).toBe(collectionRow);
    expect(scopeRow.querySelector('[data-project-layout]')).toBeNull();
    expect(collectionRow.querySelector('[data-project-scope]')).not.toBeNull();
    expect(collectionRow.querySelectorAll('input[aria-label="Filter tasks"]')).toHaveLength(1);
    expect(collectionRow.querySelector('[data-collection-filter]')).not.toBeNull();
    expect(collectionRow.querySelector('[data-collection-group]')).not.toBeNull();
    expect(collectionRow.querySelector('[data-collection-sort]')).not.toBeNull();
    expect(el.querySelector('button button, button input, a button, button a')).toBeNull();
  });

  it('mounts shared Filter, Group, and Sort controls for Project-local view intents', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.tasks = {
      ...settings.projects.view.tasks,
      filters: [{ type: 'tag', value: '#focus' }],
    };
    const renderTasks = vi.fn((..._args: unknown[]) => ({ destroy: () => undefined }));
    const el = freshContainer();

    renderProjectDashboard(el, workspace(), {
      state: new AppState(),
      settings,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
    });

    expect(el.querySelector('[data-collection-filter]')).not.toBeNull();
    expect(el.querySelector('[data-collection-group]')).not.toBeNull();
    expect(el.querySelector('[data-collection-sort]')).not.toBeNull();
    expect(el.textContent).not.toContain('Show');
  });

  it('ships bounded two-row summary and wrapping collection controls for narrow panes', () => {
    expect(declarationsFor('.abyss-project-dashboard-summary')).toContain('overflow: hidden');
    expect(declarationsFor('.abyss-project-dashboard-header')).toContain('flex-wrap: nowrap');
    expect(declarationsFor('.abyss-project-dashboard-stats')).toContain('white-space: nowrap');
    expect(declarationsFor('.abyss-project-scope-controls')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.abyss-collection-controls')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.abyss-collection-search')).toContain('min-width: 8rem');
  });

  it('keeps the scope row visually singular and defeats native title-button chrome', () => {
    expect(declarationsFor('.abyss-project-tasks-title')).toContain('display: none');
    const title = declarationsFor(
      '.abyss-project-dashboard-header > button.abyss-project-dashboard-title',
    );
    expect(title).toContain('background: transparent');
    expect(title).toContain('box-shadow: none');
    expect(title).toContain('text-align: start');
  });

  it('keeps shared Task identities readable inside Board and Timeline adapters', () => {
    const projectTaskNextAction = declarationsFor(
      '.abyss-projects-dashboard .abyss-task-next-action',
    );
    expect(projectTaskNextAction).toContain('flex: 0 0 24px');
    expect(projectTaskNextAction).toContain('inline-size: 24px');

    const compactMeta = declarationsFor(
      '.abyss-board-items > .abyss-task-card .abyss-task-meta-right,\n.abyss-board-items > .abyss-task-card .abyss-task-delete-btn,\n.abyss-timeline-identity > .abyss-task-card .abyss-task-meta-right,\n.abyss-timeline-identity > .abyss-task-card .abyss-task-delete-btn',
    );
    expect(compactMeta).toContain('display: none');

    const nextAction = declarationsFor(
      '.abyss-board-items > .abyss-task-card .abyss-task-next-action,\n.abyss-timeline-identity > .abyss-task-card .abyss-task-next-action',
    );
    expect(nextAction).toContain('display: inline-flex');
    expect(nextAction).toContain('flex: 0 0 24px');

    const compactTitle = declarationsFor(
      '.abyss-board-items > .abyss-task-card .abyss-task-title,\n.abyss-timeline-identity > .abyss-task-card .abyss-task-title',
    );
    expect(compactTitle).toContain('overflow: hidden');
    expect(compactTitle).toContain('text-overflow: ellipsis');
    expect(compactTitle).toContain('white-space: nowrap');
    expect(compactTitle).toContain('word-break: normal');
  });

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

  it('reconciles a stale selection to the open Project but retains a child of that Project', async () => {
    const state = new AppState();
    state.set('inspectorSelection', { type: 'project', path: 'Projects/Stale.md' });
    const el = freshContainer();
    renderProjectDashboard(el, workspace(), {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });
    await Promise.resolve();
    expect(state.get('inspectorSelection')).toEqual({ type: 'project', path: 'Projects/A.md' });
    expect(state.get('inspectorOrigin')).toEqual({
      selection: { type: 'project', path: 'Projects/A.md' },
      element: el.querySelector('.abyss-project-dashboard-title'),
    });

    state.set('inspectorSelection', {
      type: 'work-note',
      path: 'Notes/A.md',
      projectPath: 'Projects/A.md',
    });
    const sameProject = freshContainer();
    renderProjectDashboard(sameProject, workspace(), {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });
    await Promise.resolve();
    expect(state.get('inspectorSelection')).toEqual({ type: 'project', path: 'Projects/A.md' });
    expect(state.get('inspectorOrigin')).toEqual({
      selection: { type: 'project', path: 'Projects/A.md' },
      element: sameProject.querySelector('.abyss-project-dashboard-title'),
    });
  });

  it('arbitrates the real dashboard host by active scope and restores remembered visible children', async () => {
    const state = new AppState();
    const session = new ProjectWorkspaceSession();
    const selectedTask = task({
      source: { filePath: 'Projects/A.md', line: 4 },
      ref: { filePath: 'Projects/A.md', line: 4, revision: 'selected-task' },
      title: 'Selected task',
    });
    const selectedNote = workNote('Work Notes/Selected.md', ACTIVE_ID, '2026-08-27');
    const snapshot = workspace(proj({}), {
      tasks: [
        {
          task: selectedTask,
          projectPath: 'Projects/A.md',
          dependency: { type: 'allowed' },
          owner: { type: 'project', path: 'Projects/A.md' },
        },
      ],
      workNotes: [selectedNote],
    });
    session.openProject('Projects/A.md');
    session.tasks.reconcile(snapshot.tasks);
    session.tasks.activate(selectedTask.ref);
    session.tasks.consumeEffect();
    session.scopeSession('work-notes').selection.inspectorKey = selectedNote.path;
    session.scope = 'work-notes';
    const staleTask = task({ title: 'Stale task from another scope' });
    state.set('taskStack', [staleTask]);
    state.set('inspectorSelection', { type: 'task', task: staleTask.ref });
    const el = freshContainer();
    renderProjectDashboard(el, snapshot, {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      workspaceSession: session,
      renderTasks: vi.fn(),
      renderWorkNotes: vi.fn(),
    });
    await Promise.resolve();
    expect(state.get('inspectorSelection')).toEqual({
      type: 'work-note',
      path: selectedNote.path,
      projectPath: 'Projects/A.md',
    });
    expect(state.get('inspectorOrigin')?.selection).toEqual({
      type: 'work-note',
      path: selectedNote.path,
      projectPath: 'Projects/A.md',
    });

    el.querySelector<HTMLButtonElement>('[data-project-scope="tasks"]')!.click();
    await Promise.resolve();
    expect(state.get('inspectorSelection')).toEqual({ type: 'task', task: selectedTask.ref });
    expect(state.get('inspectorOrigin')?.selection).toEqual({
      type: 'task',
      task: selectedTask.ref,
    });

    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    await Promise.resolve();
    expect(state.get('inspectorSelection')).toEqual({
      type: 'work-note',
      path: selectedNote.path,
      projectPath: 'Projects/A.md',
    });
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

  it('uses configured Project status color only as an accent on the themed dashboard status', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.statuses[0] = { ...settings.projects.statuses[0]!, color: '#123456' };
    const el = freshContainer();

    renderProjectDashboard(el, workspace(), {
      state: new AppState(),
      settings,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    });

    const status = el.querySelector<HTMLElement>('.abyss-status-pill')!;
    expect(status.style.getPropertyValue('--abyss-project-status-accent')).toBe('#123456');
    expect(status.style.background).toBe('');
    expect(status.style.color).toBe('');
  });

  it('uses the same status actions and icons as the Project board menu', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const current = proj({});
    const expected = createProjectBoardMutation(settings.projects.statuses, async () => ({
      type: 'unchanged',
    })).menuItems(current);
    const captured: Array<{
      label: string;
      icon: string;
      checked: boolean;
      disabled: boolean;
    }> = [];
    const addItem = vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      build,
    ) {
      let label = '';
      let icon = '';
      let checked = false;
      let disabled = false;
      const item = {
        setTitle(value: string) {
          label = value;
          return this;
        },
        setIcon(value: string) {
          icon = value;
          return this;
        },
        setChecked(value: boolean) {
          checked = value;
          return this;
        },
        setDisabled(value: boolean) {
          disabled = value;
          return this;
        },
        onClick() {
          captured.push({
            get label() {
              return label;
            },
            get icon() {
              return icon;
            },
            get checked() {
              return checked;
            },
            get disabled() {
              return disabled;
            },
          });
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    try {
      const el = freshContainer();
      renderProjectDashboard(el, workspace(current), {
        state: new AppState(),
        settings,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
      });

      el.querySelector<HTMLButtonElement>('.abyss-status-pill')!.click();

      expect(captured).toEqual(
        expected.map(({ label, icon, checked, disabled }) => ({
          label,
          icon,
          checked,
          disabled,
        })),
      );
    } finally {
      addItem.mockRestore();
    }
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

  it('preserves Timeline layout while a Work Note filter temporarily hides every dated row', () => {
    const el = freshContainer();
    const datedTask = task({ planning: { due: '2026-08-30' } });
    const renderWorkNoteTimeline = vi.fn();
    let filtered = true;
    renderProjectDashboard(
      el,
      workspace(proj({}), {
        tasks: [
          {
            task: datedTask,
            projectPath: 'Projects/A.md',
            dependency: { type: 'allowed' },
            owner: { type: 'project', path: 'Projects/A.md' },
          },
        ],
        workNotes: [workNote('Work Notes/Filtered dated.md', 'done', '2026-08-29')],
      }),
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
        renderTaskTimeline: vi.fn(),
        renderWorkNotes: vi.fn(),
        renderWorkNoteTimeline,
        selectWorkNotes: (notes) => (filtered ? [] : notes),
      },
    );

    expect(el.querySelector('[data-project-layout="timeline"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    const timeline = el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!;
    expect(timeline).not.toBeNull();
    timeline.click();
    expect(timeline.getAttribute('aria-pressed')).toBe('true');
    expect(renderWorkNoteTimeline.mock.lastCall?.[2]).toEqual([]);

    filtered = false;
    const search = el.querySelector<HTMLInputElement>('.abyss-collection-search')!;
    search.value = 'restored';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.querySelector('[data-project-layout="timeline"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(renderWorkNoteTimeline.mock.lastCall?.[2]).toHaveLength(1);
  });

  it('builds the Work Note Filter menu from the audited Work Note status catalog', () => {
    const titles: string[] = [];
    const addItem = vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      build,
    ) {
      const item = {
        setTitle(value: string) {
          titles.push(value);
          return this;
        },
        setChecked() {
          return this;
        },
        onClick() {
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (
      this: Menu,
    ) {
      return this;
    });
    try {
      const el = freshContainer();
      renderProjectDashboard(
        el,
        workspace(proj({}), {
          workNotes: [workNote('Work Notes/A.md', 'mapped-complete', '2026-08-29')],
        }),
        {
          state: new AppState(),
          settings: DEFAULT_SETTINGS,
          onSetStatus: vi.fn(),
          openNote: vi.fn(),
          renderTasks: vi.fn(),
          renderWorkNotes: vi.fn(),
          workNotesAvailability: { state: 'available' },
          workNoteStatuses: [{ id: 'mapped-complete', label: 'Mapped Complete' }],
          selectWorkNotes: (notes) => notes,
        },
      );

      el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
      el.querySelector<HTMLButtonElement>('[aria-label="Filter"]')!.click();

      expect(titles).toEqual(['All', 'Mapped Complete']);
    } finally {
      addItem.mockRestore();
      show.mockRestore();
    }
  });

  it('adds Timeline only in Work Notes scope when only the selected Work Notes are dated', () => {
    const el = freshContainer();
    renderProjectDashboard(
      el,
      workspace(proj({}), {
        workNotes: [workNote('Work Notes/Selected dated.md', 'done', '2026-08-29')],
      }),
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
        renderTaskTimeline: vi.fn(),
        renderWorkNotes: vi.fn(),
        renderWorkNoteTimeline: vi.fn(),
        selectWorkNotes: (notes) => notes,
      },
    );

    expect(el.querySelector('[data-project-layout="timeline"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    expect(el.querySelector('[data-project-layout="timeline"]')).not.toBeNull();
  });

  it('opens the compact-summary Next Action in the Task inspector and shows a calm reason when unset', async () => {
    const next = task({ title: 'Do this', tags: ['#task/next_action'] });
    const action = {
      task: next,
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    };
    const state = new AppState();
    const workspaceSession = new ProjectWorkspaceSession();
    workspaceSession.openProject('Projects/A.md');
    workspaceSession.scope = 'work-notes';
    const ctx = {
      state,
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
      renderWorkNotes: vi.fn(),
      workNotesAvailability: { state: 'available' as const },
      workspaceSession,
    };
    const set = freshContainer();
    const unset = freshContainer();

    renderProjectDashboard(
      set,
      workspace(proj({}), {
        tasks: [action],
        workNotes: [workNote('Work Notes/Remembered.md', ACTIVE_ID, '2026-08-29')],
      }),
      ctx,
    );
    renderProjectDashboard(unset, workspace(), {
      ...ctx,
      state: new AppState(),
      workspaceSession: new ProjectWorkspaceSession(),
    });
    const control = set.querySelector<HTMLButtonElement>('[aria-label="Open Next Action"]')!;

    expect(control.textContent?.trim()).toBe('');
    expect(control.getAttribute('title')).toBeTruthy();
    expect(set.querySelector('.abyss-next-action-slot')).toBeNull();
    control.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.get('taskStack')).toEqual([next]);
    expect(state.get('inspectorSelection')).toMatchObject({ type: 'task', task: next.ref });
    expect(workspaceSession.tasks.inspectorRef()).toEqual(next.ref);
    expect(workspaceSession.scope).toBe('tasks');
    expect(set.querySelector('[data-project-scope="tasks"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(unset.querySelector('[aria-label="Open Next Action"]')).toBeNull();
    expect(unset.querySelector('[data-project-summary-reason]')?.textContent).not.toBe('');
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

  it('keeps a Task scoped preference out of the global settings baseline', async () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = new ProjectWorkspaceSession();
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    session.bindCollectionPreferences(settings, onSaveSettings);
    session.openProject('Projects/A.md');
    await session.updateCollectionPreference('Projects/A.md', 'tasks', (current) => ({
      ...current,
      group: 'priority',
    }));
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace()],
      workspaceSession: session,
      onSaveSettings,
    });
    const el = freshContainer();

    panel.mount(el);
    expect(el.querySelector('[data-project-use-as-default]')).toBeNull();
    expect(settings.projects.view.tasks.groupBy).not.toBe('priority');
    expect(settings.projects.view.collectionPreferences['Projects/A.md']?.tasks.group).toBe(
      'priority',
    );
    panel.destroy();
  });

  it('uses the scoped Work Note query, status filter, and sort identically in List, Board, and Timeline', async () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.workNotes = {
      ...settings.projects.view.workNotes,
      statusIds: ['done'],
      sortBy: { field: 'updated', dir: 'desc' },
    };
    const notes = [
      workNote('Work Notes/Alpha.md', ACTIVE_ID, '2026-08-30'),
      workNote('Work Notes/Beta.md', ACTIVE_ID, '2026-08-28'),
      workNote('Work Notes/Done.md', 'done', '2026-08-29'),
    ];
    const session = new ProjectWorkspaceSession();
    session.bindCollectionPreferences(settings, async () => undefined);
    session.openProject('Projects/A.md');
    session.scopeSession('work-notes').textQuery = 'Beta';
    await session.updateCollectionPreference('Projects/A.md', 'work-notes', (current) => ({
      ...current,
      filters: [ACTIVE_ID],
      sort: { field: 'title', dir: 'asc' },
    }));
    const timelinePaths: string[][] = [];
    const commands = {
      capabilities: () => ({ update: true, create: true }),
      statuses: () => [
        { id: ACTIVE_ID, label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      observe: (note: WorkNoteSnapshot) => note,
      setStatus: vi.fn(),
      create: vi.fn(),
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      snapshots: [
        workspace(proj({}), {
          workNotes: notes,
          workNoteRollup: { active: 2, completed: 1, dropped: 0 },
        }),
      ],
      workNoteCommands: commands,
      workspaceSession: session,
      renderTaskTimeline: () => ({ destroy: () => undefined }),
      renderTasks: () => ({ destroy: () => undefined }),
      onAnnounce: vi.fn(),
    });
    const el = freshContainer();
    const originalRenderWorkNoteTimeline = (
      panel as unknown as {
        renderWorkNoteTimeline: (
          host: HTMLElement,
          notes: readonly WorkNoteSnapshot[],
        ) => ProjectChildRenderHandle;
      }
    ).renderWorkNoteTimeline;
    (
      panel as unknown as {
        renderWorkNoteTimeline: (
          host: HTMLElement,
          notes: readonly WorkNoteSnapshot[],
        ) => ProjectChildRenderHandle;
      }
    ).renderWorkNoteTimeline = (host, selected) => {
      timelinePaths.push(selected.map(({ path }) => path));
      host.createDiv({ text: 'Timeline' });
      return { destroy: () => host.empty() };
    };

    panel.mount(el);
    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    const listPaths = Array.from(el.querySelectorAll<HTMLElement>('[data-work-note-path]')).map(
      ({ dataset }) => dataset['workNotePath'],
    );
    el.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    const boardPaths = Array.from(el.querySelectorAll<HTMLElement>('[data-work-note-path]')).map(
      ({ dataset }) => dataset['workNotePath'],
    );
    el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!.click();

    expect(listPaths).toEqual(['Work Notes/Beta.md']);
    expect(boardPaths).toEqual(['Work Notes/Beta.md']);
    expect(timelinePaths).toEqual([['Work Notes/Beta.md']]);
    (
      panel as unknown as { renderWorkNoteTimeline: typeof originalRenderWorkNoteTimeline }
    ).renderWorkNoteTimeline = originalRenderWorkNoteTimeline;
    panel.destroy();
  });

  it('keeps portfolio layout focus on the corresponding current control across sync remounts', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'overview';
    const datedProject = proj({
      frontmatter: { start: '2026-08-26', end: '2026-08-30' },
      range: parseProjectRange('2026-08-26', '2026-08-30'),
    });
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace(datedProject)],
      projectCommands: {
        observeRange: vi.fn().mockReturnValue({
          path: datedProject.path,
          start: '2026-08-26',
          end: '2026-08-30',
        }),
        setRange: vi.fn(),
      } as never,
    });
    const el = attachedContainer();
    panel.mount(el);
    try {
      for (const layout of ['board', 'timeline', 'overview'] as const) {
        const current = el.querySelector<HTMLButtonElement>(
          `[data-project-portfolio-layout="${layout}"]`,
        )!;
        current.focus();
        current.click();
        const replacement = el.querySelector<HTMLButtonElement>(
          `[data-project-portfolio-layout="${layout}"]`,
        )!;
        expect(replacement.isConnected).toBe(true);
        expect(el.contains(replacement)).toBe(true);
        expect(activeDocument.activeElement).toBe(replacement);
      }
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('routes portfolio Overview through the real bounded configurable table', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'overview';
    const snapshots = Array.from({ length: 120 }, (_, index) =>
      workspace(proj({ path: `Projects/${String(index)}.md`, name: `Project ${String(index)}` })),
    );
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots,
    });
    const el = freshContainer();
    panel.mount(el);
    try {
      expect(el.querySelector('[role="table"]')?.getAttribute('aria-label')).toBe(
        'Projects overview table',
      );
      expect(el.querySelectorAll('[data-project-table-row]').length).toBeLessThan(120);
    } finally {
      panel.destroy();
    }
  });

  it.each(
    (['overview', 'board', 'timeline'] as const).flatMap((layout) => [
      {
        layout,
        name: 'status',
        selector: `[data-project-status-filter="${ACTIVE_ID}"]`,
      },
      { layout, name: 'unmapped', selector: '[data-project-unmapped-filter]' },
    ]),
  )('keeps $layout $name filter focus and scroll across a sync remount', ({ layout, selector }) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = layout;
    const secondStatus = settings.projects.statuses.find((status) => status.id !== ACTIVE_ID)!;
    settings.projects.view.visibleStatusIds = [ACTIVE_ID, secondStatus.id];
    const datedProject = proj({
      frontmatter: { start: '2026-08-26', end: '2026-08-30' },
      range: parseProjectRange('2026-08-26', '2026-08-30'),
    });
    const survivingProject = proj({
      path: 'Projects/B.md',
      name: 'B',
      statusId: secondStatus.id,
      frontmatter: { start: '2026-08-27', end: '2026-08-31' },
      range: parseProjectRange('2026-08-27', '2026-08-31'),
    });
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace(datedProject), workspace(survivingProject)],
      projectCommands: {
        observeRange: vi.fn((project: Project) => ({
          path: project.path,
          start: project.frontmatter['start'],
          end: project.frontmatter['end'],
        })),
        setRange: vi.fn(),
      } as never,
    });
    const el = attachedContainer();
    panel.mount(el);
    try {
      const scrollSelector =
        layout === 'overview'
          ? '.abyss-projects-scroll'
          : layout === 'board'
            ? `[data-board-column="${secondStatus.id}"] .abyss-board-column-scroll`
            : '.abyss-timeline-scroll';
      const scroll = el.querySelector<HTMLElement>(scrollSelector)!;
      scroll.scrollTop = 91;
      scroll.dispatchEvent(new Event('scroll'));
      const control = el.querySelector<HTMLButtonElement>(selector)!;
      control.focus();
      control.click();
      const replacement = el.querySelector<HTMLButtonElement>(selector)!;
      expect(replacement.isConnected).toBe(true);
      expect(el.contains(replacement)).toBe(true);
      expect(activeDocument.activeElement).toBe(replacement);
      expect(settings.projects.view.portfolioLayout).toBe(layout);
      expect(el.querySelector<HTMLElement>(scrollSelector)?.scrollTop).toBe(91);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it.each(['overview', 'board', 'timeline'] as const)(
    'returns overflow-filter focus to Filter after a %s remount',
    async (layout) => {
      let invokeFirstItem: (() => void) | undefined;
      vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
        const item = {
          setTitle: () => item,
          setDisabled: () => item,
          setChecked: () => item,
          onClick: (handler: () => void) => {
            invokeFirstItem ??= handler;
            return item;
          },
        };
        callback(item as never);
        return this;
      });
      vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
        return this;
      });
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.projects.view.portfolioLayout = layout;
      const project = proj({
        frontmatter: { start: '2026-08-26', end: '2026-08-30' },
        range: parseProjectRange('2026-08-26', '2026-08-30'),
      });
      const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
        snapshots: [workspace(project)],
        projectCommands: {
          observeRange: vi.fn().mockReturnValue({
            path: project.path,
            start: '2026-08-26',
            end: '2026-08-30',
          }),
          setRange: vi.fn(),
        } as never,
      });
      const el = attachedContainer();
      panel.mount(el);
      try {
        const filter = el.querySelector<HTMLButtonElement>('[data-collection-filter]')!;
        filter.focus();
        filter.click();
        expect(filter.getAttribute('aria-expanded')).toBe('true');

        invokeFirstItem?.();
        await flushMicrotasks();

        const replacement = el.querySelector<HTMLButtonElement>('[data-collection-filter]')!;
        expect(replacement).not.toBe(filter);
        expect(activeDocument.activeElement).toBe(replacement);
        expect(replacement.getAttribute('aria-expanded')).toBe('false');
      } finally {
        panel.destroy();
        el.remove();
      }
    },
  );

  it('reveals and focuses a created undated Project beyond the first Timeline diagnostic window', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'timeline';
    const targetPath = 'Projects/Z-created.md';
    const snapshots = Array.from({ length: 40 }, (_, index) =>
      workspace(
        proj({
          path: index === 39 ? targetPath : `Projects/P${String(index).padStart(2, '0')}.md`,
          name: index === 39 ? 'Z created' : `P${String(index).padStart(2, '0')}`,
        }),
      ),
    );
    const session = new ProjectWorkspaceSession();
    session.portfolioCapture.createdPath = targetPath;
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots,
      workspaceSession: session,
      projectCommands: {
        observeRange: vi.fn((project: Project) => ({ path: project.path })),
        setRange: vi.fn(),
      } as never,
    });
    const el = attachedContainer();
    panel.mount(el);
    try {
      const identity = el.querySelector<HTMLElement>(
        `[data-timeline-key="project:${targetPath}"] [data-project-identity-control]`,
      )!;
      expect(identity).not.toBeNull();
      expect(identity.closest('.abyss-timeline-undated-row')?.classList).toContain(
        'is-just-created',
      );
      expect(activeDocument.activeElement).toBe(identity);
      expect(session.portfolioCapture.createdPath).toBeNull();
    } finally {
      panel.destroy();
      el.remove();
    }
  });

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

  it('omits the Work Notes scope when no eligible notes or audited creation are available', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const commands = {
      capabilities: () => ({ update: false, create: false }),
      statuses: () => DEFAULT_SETTINGS.projects.statuses,
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
      workNoteCommands: commands,
    });
    const el = freshContainer();

    panel.mount(el);

    expect(el.querySelector('[data-project-scope="work-notes"]')).toBeNull();
    panel.destroy();
  });

  it('offers the Work Notes scope without existing notes when audited creation is available', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const commands = {
      capabilities: () => ({ update: true, create: true }),
      statuses: () => DEFAULT_SETTINGS.projects.statuses,
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
      workNoteCommands: commands,
    });
    const el = freshContainer();

    panel.mount(el);

    expect(el.querySelector('[data-project-scope="work-notes"]')).not.toBeNull();
    panel.destroy();
  });

  it('shows an enabled but unaccepted Work Notes scope disabled with one settings action', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.workNoteCompatibility = {
      ...settings.projects.workNoteCompatibility,
      enabled: true,
      acceptedAudit: undefined,
    };
    const openSettings = vi.fn();
    const openSettingsTab = vi.fn();
    const app = {
      vault: { getAbstractFileByPath: () => null },
      workspace: { getLeaf: () => ({ openFile: vi.fn() }) },
      setting: { open: openSettings, openTabById: openSettingsTab },
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, app, {
      snapshots: [workspace()],
      workNoteCommands: {
        capabilities: () => ({ update: false, create: false }),
        statuses: () => settings.projects.statuses,
      } as never,
    });
    const el = freshContainer();

    panel.mount(el);
    const scope = el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!;
    expect(scope.disabled).toBe(true);
    expect(scope.getAttribute('aria-label')).toContain('needs validation');
    el.querySelector<HTMLButtonElement>('[data-work-notes-settings]')!.click();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(openSettingsTab).toHaveBeenCalledWith('task-calendar');
    panel.destroy();
  });

  it('keeps a coherent layout when an empty creatable Work Notes workspace retained Board', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/A.md');
    session.scope = 'work-notes';
    session.layout = 'board';
    const commands = {
      capabilities: () => ({ update: true, create: true }),
      statuses: () => DEFAULT_SETTINGS.projects.statuses,
      create: vi.fn(),
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
      workNoteCommands: commands,
      workspaceSession: session,
    });
    const el = freshContainer();

    panel.mount(el);

    const workspaceEl = el.querySelector<HTMLElement>('[data-project-workspace]')!;
    const activeLayout = el.querySelector<HTMLButtonElement>(
      `[data-project-layout="${workspaceEl.dataset['layout']}"]`,
    );
    expect(String(session.layout)).toBe(workspaceEl.dataset['layout']);
    expect(activeLayout).not.toBeNull();
    expect(activeLayout?.disabled).toBe(false);
    expect(activeLayout?.getAttribute('aria-pressed')).toBe('true');
    panel.destroy();
  });

  it('presents and opens milestone Work Notes with their automatic rollup', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const milestone = {
      ...workNote('Work Notes/Release milestone.md', ACTIVE_ID, '2026-08-30'),
      kind: 'milestone' as const,
      range: {},
    };
    const ordinary = {
      ...workNote('Work Notes/Ship build.md', ACTIVE_ID, '2026-08-29'),
      milestonePath: milestone.path,
    };
    const snapshot = workspace(proj({}), {
      workNotes: [ordinary],
      milestones: [milestone],
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
      milestoneRollups: new Map([
        [milestone.path, { active: 1, completed: 2, dropped: 0, progress: 2 / 3 }],
      ]),
    });
    const file = Object.assign(Object.create(TFile.prototype) as object, {
      path: milestone.path,
      extension: 'md',
    }) as TFile;
    const openFile = vi.fn().mockResolvedValue(undefined);
    const app = {
      vault: { getAbstractFileByPath: (path: string) => (path === file.path ? file : null) },
      workspace: { getLeaf: () => ({ openFile }) },
    } as never;
    const commands = {
      capabilities: () => ({ update: false, create: true }),
      statuses: () => DEFAULT_SETTINGS.projects.statuses,
      create: vi.fn(),
    } as never;
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, app, {
      snapshots: [snapshot],
      workNoteCommands: commands,
    });
    const el = freshContainer();

    panel.mount(el);
    el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    const milestoneRow = el.querySelector<HTMLElement>(
      `.abyss-work-note-row[data-work-note-path="${milestone.path}"]`,
    );

    expect(milestoneRow).not.toBeNull();
    expect(milestoneRow?.textContent).toContain('2/3');
    milestoneRow?.querySelector<HTMLButtonElement>('.abyss-work-note-open')?.click();
    expect(openFile).toHaveBeenCalledWith(file);
    panel.destroy();
  });

  it.each([
    {
      name: 'empty',
      workNotes: [] as WorkNoteSnapshot[],
      milestones: [] as WorkNoteSnapshot[],
      available: false,
      planningKeys: [] as string[],
      datedKeys: [] as string[],
    },
    {
      name: 'all-undated ordinary',
      workNotes: [
        {
          ...workNote('Work Notes/Undated ordinary.md', ACTIVE_ID, '2026-08-30'),
          updated: undefined,
          range: {},
        },
      ],
      milestones: [] as WorkNoteSnapshot[],
      available: true,
      planningKeys: ['work-note:Work Notes/Undated ordinary.md'],
      datedKeys: [] as string[],
    },
    {
      name: 'undated milestone',
      workNotes: [] as WorkNoteSnapshot[],
      milestones: [
        {
          ...workNote('Work Notes/Undated milestone.md', ACTIVE_ID, '2026-08-30'),
          kind: 'milestone' as const,
          updated: undefined,
          range: {},
        },
      ],
      available: true,
      planningKeys: ['work-note:Work Notes/Undated milestone.md'],
      datedKeys: [] as string[],
    },
    {
      name: 'dated ordinary',
      workNotes: [workNote('Work Notes/Dated ordinary.md', ACTIVE_ID, '2026-08-30')],
      milestones: [] as WorkNoteSnapshot[],
      available: true,
      planningKeys: [] as string[],
      datedKeys: ['work-note:Work Notes/Dated ordinary.md'],
    },
    {
      name: 'mixed dated and undated',
      workNotes: [
        workNote('Work Notes/Dated mixed.md', ACTIVE_ID, '2026-08-30'),
        {
          ...workNote('Work Notes/Undated mixed.md', ACTIVE_ID, '2026-08-29'),
          updated: undefined,
          range: {},
        },
      ],
      milestones: [] as WorkNoteSnapshot[],
      available: true,
      planningKeys: ['work-note:Work Notes/Undated mixed.md'],
      datedKeys: ['work-note:Work Notes/Dated mixed.md'],
    },
  ])(
    'derives Work Notes Timeline availability and Planning rows for $name input',
    ({ workNotes, milestones, available, planningKeys, datedKeys }) => {
      const state = new AppState();
      state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
      const commands = {
        capabilities: () => ({ update: false, create: true }),
        statuses: () => DEFAULT_SETTINGS.projects.statuses,
        create: vi.fn(),
      } as never;
      const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
        snapshots: [workspace(proj({}), { workNotes, milestones })],
        workNoteCommands: commands,
      });
      const el = freshContainer();

      panel.mount(el);
      el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
      const timeline = el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]');
      expect(timeline === null).toBe(!available);
      timeline?.click();

      const planning = new Set(
        Array.from(
          el.querySelectorAll<HTMLElement>(
            '.abyss-timeline-undated-row[data-timeline-key], .abyss-timeline-diagnostic-row[data-timeline-key]',
          ),
          ({ dataset }) => dataset['timelineKey']!,
        ),
      );
      const dated = new Set(
        Array.from(
          el.querySelectorAll<HTMLElement>('.abyss-timeline-row[data-timeline-key]'),
          ({ dataset }) => dataset['timelineKey']!,
        ),
      );
      expect([...planning]).toEqual(planningKeys);
      expect([...dated]).toEqual(datedKeys);
      panel.destroy();
    },
  );

  it('destroys the active dashboard child renderer when the real ProjectsPanel is destroyed', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const childDestroy = vi.fn();
    const renderTasks = (host: HTMLElement): ProjectChildRenderHandle => {
      const owned = host.createDiv({ attr: { 'data-test-panel-child': '' } });
      return {
        destroy: () => {
          expect(owned.isConnected).toBe(true);
          childDestroy();
        },
      };
    };
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace()],
      renderTasks,
    });
    const el = attachedContainer();
    panel.mount(el);

    panel.destroy();

    expect(childDestroy).toHaveBeenCalledOnce();
  });

  it('keeps the portfolio Board selected column and semantic focus through mutation settlement and refresh', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const secondStatus = settings.projects.statuses.find(({ id }) => id !== ACTIVE_ID)!;
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.view.visibleStatusIds = [ACTIVE_ID, secondStatus.id];
    const projectA = proj({ path: 'Projects/A.md', name: 'A', statusId: ACTIVE_ID });
    const projectB = proj({ path: 'Projects/B.md', name: 'B', statusId: secondStatus.id });
    const snapshots = [workspace(projectA), workspace(projectB)];
    const pending = deferred<{
      readonly type: 'ok';
      readonly previousStatusId: string;
      readonly nextStatusId: string;
    }>();
    const manager = {
      setStatus: vi.fn(() => pending.promise),
      undoStatus: vi.fn(),
      create: vi.fn(),
    } as never;
    const store = {
      list: () => [projectA, projectB],
      get: () => projectA,
      activeForLeftPanel: () => [projectA, projectB],
      onUpdate: () => () => {},
      refresh: () => {},
    } as never;
    const session = new ProjectWorkspaceSession();
    const portfolioBoard = session.portfolioBoard;
    portfolioBoard.selectedColumnKey = secondStatus.id;
    portfolioBoard.focusedKey = projectB.path;
    portfolioBoard.restoreFocus = true;
    const panel = new ProjectsPanel(new AppState(), store, manager, settings, null as never, {
      snapshots,
      workspaceSession: session,
    });
    const el = attachedContainer();
    panel.mount(el);
    expect(
      el.querySelector<HTMLElement>('[data-board-column-tab][aria-selected="true"]')?.dataset[
        'boardColumnTab'
      ],
    ).toBe(secondStatus.id);
    const item = el.querySelector<HTMLElement>('[data-board-item="Projects/B.md"]')!;
    const identity = item.querySelector<HTMLElement>('[data-project-identity-control]')!;
    expect(activeDocument.activeElement).toBe(identity);
    item.dispatchEvent(new Event('dragstart', { bubbles: true }));
    el.querySelector<HTMLElement>(`[data-board-column="${ACTIVE_ID}"]`)!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    pending.resolve({
      type: 'ok',
      previousStatusId: secondStatus.id,
      nextStatusId: ACTIVE_ID,
    });
    await Promise.resolve();
    await Promise.resolve();

    portfolioBoard.selectedColumnKey = ACTIVE_ID;
    portfolioBoard.focusedKey = projectA.path;
    portfolioBoard.restoreFocus = true;
    panel.refresh();

    expect(session.portfolioBoard).toMatchObject({
      selectedColumnKey: ACTIVE_ID,
      focusedKey: 'Projects/A.md',
      restoreFocus: true,
    });
    expect(
      el.querySelector<HTMLElement>('[data-board-column-tab][aria-selected="true"]')?.dataset[
        'boardColumnTab'
      ],
    ).toBe(ACTIVE_ID);
    expect(activeDocument.activeElement).toBe(
      el
        .querySelector<HTMLElement>('[data-board-item="Projects/A.md"]')
        ?.querySelector<HTMLElement>('[data-project-identity-control]'),
    );
  });

  it('prevents a replaced portfolio Board Undo from clearing a newer pending owner', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const secondStatus = settings.projects.statuses.find(({ id }) => id !== ACTIVE_ID)!;
    settings.projects.view.portfolioLayout = 'board';
    settings.projects.view.visibleStatusIds = [ACTIVE_ID, secondStatus.id];
    const projectA = proj({ path: 'Projects/A.md', name: 'A', statusId: ACTIVE_ID });
    const projectB = proj({ path: 'Projects/B.md', name: 'B', statusId: secondStatus.id });
    const snapshots = [workspace(projectA), workspace(projectB)];
    const pendingA = {
      path: projectA.path,
      columnKey: ACTIVE_ID,
      result: {
        type: 'ok' as const,
        previousStatusId: secondStatus.id,
        nextStatusId: ACTIVE_ID,
      },
    };
    const pendingB = {
      path: projectB.path,
      columnKey: secondStatus.id,
      result: {
        type: 'ok' as const,
        previousStatusId: ACTIVE_ID,
        nextStatusId: secondStatus.id,
      },
    };
    const undoA = deferred<typeof pendingA.result>();
    const undoB = deferred<typeof pendingB.result>();
    const manager = {
      setStatus: vi.fn(),
      undoStatus: vi.fn((path: string) => (path === projectA.path ? undoA.promise : undoB.promise)),
      create: vi.fn(),
    };
    const refresh = vi.fn();
    const store = {
      list: () => [projectA, projectB],
      get: () => projectA,
      activeForLeftPanel: () => [projectA, projectB],
      onUpdate: () => () => {},
      refresh,
    };
    let parentPending: typeof pendingA | typeof pendingB | undefined = pendingA;
    const onUndoResolved = vi.fn(() => {
      parentPending = undefined;
      refresh();
    });
    const session = new ProjectWorkspaceSession();
    const first = new ProjectsPanel(
      new AppState(),
      store as never,
      manager as never,
      settings,
      null as never,
      {
        snapshots,
        pendingBoardUndo: pendingA,
        onBoardUndoResolved: onUndoResolved,
        workspaceSession: session,
      },
    );
    const firstRoot = attachedContainer();
    first.mount(firstRoot);
    firstRoot.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    expect(manager.undoStatus).toHaveBeenLastCalledWith(projectA.path, ACTIVE_ID, secondStatus.id);
    first.destroy();

    parentPending = pendingB;
    session.portfolioBoard.selectedColumnKey = secondStatus.id;
    session.portfolioBoard.focusedKey = projectB.path;
    session.portfolioBoard.restoreFocus = true;
    const current = new ProjectsPanel(
      new AppState(),
      store as never,
      manager as never,
      settings,
      null as never,
      {
        snapshots,
        pendingBoardUndo: pendingB,
        onBoardUndoResolved: onUndoResolved,
        workspaceSession: session,
      },
    );
    const currentRoot = attachedContainer();
    current.mount(currentRoot);
    const currentBoard = currentRoot.querySelector<HTMLElement>('.abyss-board')!;
    const currentIdentity = currentRoot
      .querySelector<HTMLElement>(`[data-board-item="${projectB.path}"]`)!
      .querySelector<HTMLElement>('[data-project-identity-control]')!;
    expect(activeDocument.activeElement).toBe(currentIdentity);

    undoA.resolve(pendingA.result);
    await Promise.resolve();
    await Promise.resolve();

    expect(onUndoResolved).not.toHaveBeenCalled();
    expect(parentPending).toBe(pendingB);
    expect(refresh).not.toHaveBeenCalled();
    expect(currentBoard.isConnected).toBe(true);
    expect(currentRoot.querySelector('[data-board-undo]')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(currentIdentity);
    expect(session.portfolioBoard).toMatchObject({
      selectedColumnKey: secondStatus.id,
      focusedKey: projectB.path,
      restoreFocus: true,
    });

    currentRoot.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    expect(manager.undoStatus).toHaveBeenLastCalledWith(projectB.path, secondStatus.id, ACTIVE_ID);
    current.destroy();
  });

  it('emits Work Note selection to the common host and cleans its observer', () => {
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const note = workNote('Work Notes/A.md', ACTIVE_ID, '2026-08-28');
    const snapshot = workspace(proj({}), {
      workNotes: [note],
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
    });
    let ownerWidth = 900;
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('abyss-project-tasks-content') ? ownerWidth : 900;
      },
    });
    const records: Array<{
      readonly callback: ResizeObserverCallback;
      readonly targets: Set<Element>;
      readonly disconnect: () => void;
    }> = [];
    class ControlledResizeObserver implements ResizeObserver {
      private readonly record: (typeof records)[number];

      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set(), disconnect: vi.fn() };
        records.push(this.record);
      }

      observe(target: Element): void {
        this.record.targets.add(target);
      }

      unobserve(target: Element): void {
        this.record.targets.delete(target);
      }

      disconnect(): void {
        this.record.targets.clear();
        this.record.disconnect();
      }
    }
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const commands = {
      capabilities: () => ({ update: true, create: true }),
      statuses: () => DEFAULT_SETTINGS.projects.statuses,
      observe: (current: WorkNoteSnapshot) => current,
      setStatus: vi.fn().mockResolvedValue({ type: 'ok', path: note.path }),
      create: vi.fn(),
    } as never;
    const session = new ProjectWorkspaceSession();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [snapshot],
      workNoteCommands: commands,
      workspaceSession: session,
    });
    const el = attachedContainer();
    try {
      panel.mount(el);
      el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
      const owner = el.querySelector<HTMLElement>('.abyss-project-tasks-content')!;
      const ownerRecord = records.find(({ targets }) => targets.has(owner));
      expect(ownerRecord).toBeDefined();
      el.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!.click();
      expect(el.querySelector('.abyss-work-note-inspector-host')).toBeNull();
      expect(session.workNotes.inspectorPath).toBe(note.path);

      ownerWidth = 600;
      ownerRecord!.callback(
        [
          {
            target: owner,
            contentRect: owner.getBoundingClientRect(),
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      expect(el.querySelector('.abyss-work-note-inspector-host')).toBeNull();
      expect(session.workNotes.inspectorPath).toBe(note.path);

      ownerWidth = 900;
      ownerRecord!.callback(
        [
          {
            target: owner,
            contentRect: owner.getBoundingClientRect(),
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      expect(el.querySelector('.abyss-work-note-inspector-host')).toBeNull();
      expect(session.workNotes.inspectorPath).toBe(note.path);

      el.querySelector<HTMLButtonElement>('[data-project-scope="tasks"]')!.click();
      expect(ownerRecord!.disconnect).toHaveBeenCalledOnce();
    } finally {
      panel.destroy();
      vi.unstubAllGlobals();
      if (originalWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      }
    }
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

  it('renders the production Portfolio Timeline as an agenda from its container width', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'timeline';
    const project = proj({
      frontmatter: { start: '2026-08-27', end: '2026-08-29' },
      range: parseProjectRange('2026-08-27', '2026-08-29'),
    });
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('abyss-projects-timeline-host') ? 600 : 900;
      });
    const panel = new ProjectsPanel(new AppState(), stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace(project)],
      projectCommands: {
        observeRange: () => ({ path: project.path, start: '2026-08-27', end: '2026-08-29' }),
        setRange: vi.fn(),
      } as never,
    });
    const el = freshContainer();
    try {
      panel.mount(el);
      expect(el.querySelector('.abyss-timeline')?.classList).toContain('is-agenda');
      expect(el.querySelector('.abyss-timeline-axis')).toBeNull();
    } finally {
      panel.destroy();
      width.mockRestore();
    }
  });

  it('renders the production Work Note Timeline as an agenda from its container width', () => {
    const project = proj({});
    const note = {
      ...workNote('Work Notes/Narrow.md', ACTIVE_ID, '2026-08-27'),
      range: parseProjectRange('2026-08-27', '2026-08-29'),
    };
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('abyss-project-tasks-content') ? 600 : 900;
      });
    const panel = new ProjectsPanel(state, stubStore, stubMgr, DEFAULT_SETTINGS, null as never, {
      snapshots: [workspace(project, { workNotes: [note] })],
      workNoteCommands: {
        capabilities: () => ({ update: true, create: true }),
        statuses: () => DEFAULT_SETTINGS.projects.statuses,
        observeRange: () => ({
          observed: { path: note.path, fields: {} },
          start: note.range.start,
          end: note.range.end,
        }),
        setRange: vi.fn(),
      } as never,
    });
    const el = freshContainer();
    try {
      panel.mount(el);
      el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
      el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!.click();
      expect(el.querySelector('.abyss-timeline')?.classList).toContain('is-agenda');
      expect(el.querySelector('.abyss-timeline-axis')).toBeNull();
    } finally {
      panel.destroy();
      width.mockRestore();
    }
  });

  it('routes a portfolio Timeline Project identity through the real ProjectsPanel state', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.portfolioLayout = 'timeline';
    const datedProject = proj({
      frontmatter: { start: '2026-08-26' },
      range: parseProjectRange('2026-08-26', undefined),
    });
    const state = new AppState();
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, null as never, {
      snapshots: [workspace(datedProject)],
      projectCommands: {
        observeRange: vi.fn().mockReturnValue({
          path: datedProject.path,
          start: '2026-08-26',
          end: undefined,
        }),
        setRange: vi.fn(),
      } as never,
    });
    const el = attachedContainer();
    panel.mount(el);
    try {
      const identity = el.querySelector<HTMLButtonElement>('[data-project-identity-control]')!;
      expect(identity.tagName).toBe('BUTTON');
      identity.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(state.get('projectsPanel')).toEqual({
        view: 'dashboard',
        path: 'Projects/A.md',
      });
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('selects and remembers a read-only Work Note Timeline identity through the real dashboard adapter', async () => {
    const project = proj({});
    const note = {
      ...workNote('Work Notes/Read only.md', ACTIVE_ID, '2026-08-27'),
      range: parseProjectRange('2026-08-27', undefined),
    };
    const state = new AppState();
    const workspaceSession = new ProjectWorkspaceSession();
    state.set('projectsPanel', { view: 'dashboard', path: project.path });
    const app = {
      vault: { getAbstractFileByPath: () => null },
      workspace: { getLeaf: () => ({ openFile: vi.fn() }) },
    } as never;
    const settings = structuredClone(DEFAULT_SETTINGS);
    const enabledPreset = { ...settings.projects.workNoteCompatibility, enabled: true };
    settings.projects.workNoteCompatibility = {
      ...enabledPreset,
      acceptedAudit: {
        presetFingerprint: computeWorkNotePresetFingerprint(enabledPreset),
        acceptedRevision: enabledPreset.revision,
        acceptedAt: '2026-08-28T00:00:00.000Z',
        capabilities: { update: false, create: false },
      },
    };
    const panel = new ProjectsPanel(state, stubStore, stubMgr, settings, app, {
      snapshots: [workspace(project, { workNotes: [note] })],
      workNoteCommands: {
        capabilities: () => ({ update: false, create: false }),
        statuses: () => DEFAULT_SETTINGS.projects.statuses,
        observeRange: vi.fn(),
        setRange: vi.fn(),
      } as never,
      workspaceSession,
    });
    const el = attachedContainer();
    panel.mount(el);
    try {
      el.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
      el.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!.click();
      const identity = el.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!;
      expect(identity.tagName).toBe('BUTTON');
      identity.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(state.get('taskStack')).toEqual([]);
      expect(state.get('inspectorSelection')).toEqual({
        type: 'work-note',
        path: note.path,
        projectPath: project.path,
      });
      expect(state.get('inspectorOrigin')?.element).toBe(identity);
      el.querySelector<HTMLButtonElement>('[data-project-layout="list"]')!.click();
      await Promise.resolve();
      expect(state.get('inspectorSelection')).toEqual({
        type: 'work-note',
        path: note.path,
        projectPath: project.path,
      });
    } finally {
      panel.destroy();
      el.remove();
    }
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
