import { Menu, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  createWorkNoteBoardMutation,
  workNoteBoardColumns,
} from '../src/panels/projects/boardProjection';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { ProjectWorkspaceSession } from '../src/panels/projects/ProjectWorkspaceSession';
import {
  WORK_NOTE_FALLBACK_VISIBLE_ROWS,
  WORK_NOTE_OVERSCAN,
  WORK_NOTE_ROW_EXTENT,
  renderWorkNotesView,
} from '../src/panels/projects/WorkNotesView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { flushMicrotasks, freshContainer } from './helpers';

interface CapturedMenuItem {
  title: string;
  click: () => unknown;
}

function captureMenuItems(): CapturedMenuItem[] {
  const captured: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
    let title = '';
    let click = (): unknown => undefined;
    const item = {
      setTitle(value: string) {
        title = value;
        return this;
      },
      setIcon() {
        return this;
      },
      setChecked() {
        return this;
      },
      setDisabled() {
        return this;
      },
      onClick(callback: () => unknown) {
        click = callback;
        captured.push({
          get title() {
            return title;
          },
          click: () => click(),
        });
        return this;
      },
    } as unknown as MenuItem;
    build(item);
    return this;
  });
  return captured;
}

afterEach(() => vi.restoreAllMocks());

function note(index: number, over: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  const ordinal = String(index).padStart(3, '0');
  return {
    path: `Work Notes/Work note ${ordinal}.md`,
    presetRevision: 7,
    presetFingerprint: 'fixture-fingerprint',
    kind: 'ordinary',
    projectPath: 'Projects/P.md',
    statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
    rawStatus: 'Active raw',
    writableStatusShape: true,
    priority: index % 2 === 0 ? 'High' : 'Normal',
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...over,
  };
}

describe('renderWorkNotesView', () => {
  it('renders hundreds of Work Notes as dense virtualized rows', () => {
    const root = freshContainer();
    const notes = Array.from({ length: 240 }, (_, index) => note(index));

    renderWorkNotesView(root, {
      notes,
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.querySelectorAll('.abyss-work-note-row')).toHaveLength(
      WORK_NOTE_FALLBACK_VISIBLE_ROWS + WORK_NOTE_OVERSCAN,
    );
    expect(root.textContent).not.toContain('No dates');
    expect(root.querySelector('[data-bounded-window-edge="end"]')).not.toBeNull();
  });

  it('keeps logical keyboard focus and exact row extent while deep scrolling remounts', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const notes = Array.from({ length: 150 }, (_, index) => note(index));
    try {
      renderWorkNotesView(root, {
        notes,
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'list',
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
      });
      const scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;
      Object.defineProperty(scroll, 'clientHeight', {
        configurable: true,
        value: WORK_NOTE_ROW_EXTENT * 5,
      });
      scroll.scrollTop = WORK_NOTE_ROW_EXTENT * 100;
      scroll.dispatchEvent(new Event('scroll'));
      const current = root.querySelector<HTMLElement>(
        '[data-work-note-path="Work Notes/Work note 100.md"]',
      )!;
      current.focus();
      for (let index = 0; index < 7; index += 1) {
        activeDocument.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }

      expect((activeDocument.activeElement as HTMLElement).dataset['workNotePath']).toBe(
        'Work Notes/Work note 107.md',
      );
      expect(scroll.scrollTop).toBe(WORK_NOTE_ROW_EXTENT * 103);
      expect(
        root.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
      ).toBe(`${String((103 - WORK_NOTE_OVERSCAN) * WORK_NOTE_ROW_EXTENT)}px`);
    } finally {
      root.remove();
    }
  });

  it('restores a deep logical list viewport and focus after the renderer is replaced', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const notes = Array.from({ length: 150 }, (_, index) => note(index));
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const options = {
      notes,
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list' as const,
      session: session.workNotes,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    };
    try {
      let handle = renderWorkNotesView(root, options);
      let scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;
      Object.defineProperty(scroll, 'clientHeight', {
        configurable: true,
        value: WORK_NOTE_ROW_EXTENT * 5,
      });
      scroll.scrollTop = WORK_NOTE_ROW_EXTENT * 100;
      scroll.dispatchEvent(new Event('scroll'));
      root
        .querySelector<HTMLElement>('[data-work-note-path="Work Notes/Work note 103.md"]')!
        .focus();

      handle.destroy();
      handle = renderWorkNotesView(root, options);
      scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;

      expect(scroll.scrollTop).toBe(WORK_NOTE_ROW_EXTENT * 100);
      expect((activeDocument.activeElement as HTMLElement).dataset['workNotePath']).toBe(
        'Work Notes/Work note 103.md',
      );
      handle.destroy();
    } finally {
      root.remove();
    }
  });

  it('uses the same row language to expose kind, status, project, and inspector selection', () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [
        note(1, {
          kind: 'milestone',
          statusId: null,
          rawStatus: 'Review',
          projectPath: 'Projects/Canonical.md',
        }),
      ],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    const row = root.querySelector<HTMLElement>('.abyss-work-note-row')!;
    expect(row.textContent).toContain('Milestone');
    expect(row.textContent).toContain('Review');
    expect(row.textContent).toContain('Canonical');
    row.click();
    expect(root.querySelector('.abyss-work-note-inspector')?.textContent).toContain(
      'Work note 001',
    );
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('creates through one guarded inline control without introducing a task checkbox', () => {
    const root = freshContainer();
    const onCreate = vi.fn().mockResolvedValue({
      type: 'ok',
      path: 'Work Notes/New research.md',
    });
    renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      createEnabled: true,
      onCreate,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New work note"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.abyss-work-note-create-input')!;
    input.value = 'New research';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith({
      title: 'New research',
      projectPath: 'Projects/P.md',
    });
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('keeps the creation input and surfaces a typed partial result', async () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      createEnabled: true,
      onCreate: vi.fn().mockResolvedValue({
        type: 'partial',
        path: 'Work Notes/Partial.md',
        reason: 'templater-failure',
      }),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New work note"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.abyss-work-note-create-input')!;
    input.value = 'Partial';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(input.disabled).toBe(false));

    expect(root.contains(input)).toBe(true);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Partial');
  });

  it('sorts the default updated view by audited updated metadata', () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [note(1, { updated: '2026-08-01' }), note(2, { updated: '2026-08-20' })],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      viewState: {
        groupBy: 'none',
        sortBy: { field: 'updated', dir: 'desc' },
        statusIds: [],
      },
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      [...root.querySelectorAll('.abyss-work-note-title')].map(({ textContent }) => textContent),
    ).toEqual(['Work note 002', 'Work note 001']);
  });

  it.each([
    ['compatibility-conflict', { type: 'compatibility-conflict', reason: 'latest-audit-rejected' }],
    ['conflict', { type: 'conflict', field: 'status' }],
    ['invalid', { type: 'invalid', field: 'status' }],
    ['partial', { type: 'partial', path: 'Work Notes/Partial.md', reason: 'shape-changed' }],
    ['io-error', { type: 'io-error' }],
  ] as const)(
    'presents a connected %s failure from the list and restores the initiating status button',
    async (resultType, result) => {
      const root = freshContainer();
      activeDocument.body.appendChild(root);
      const items = captureMenuItems();
      try {
        renderWorkNotesView(root, {
          notes: [note(1)],
          statuses: DEFAULT_SETTINGS.projects.statuses,
          layout: 'list',
          onSetStatus: vi.fn().mockResolvedValue(result),
          openNote: vi.fn(),
        });
        const trigger = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
        trigger.click();
        await items.find(({ title }) => title === 'Done')!.click();

        await vi.waitFor(() => {
          const feedback = root.querySelector<HTMLElement>('[data-work-note-feedback]');
          expect(feedback?.dataset['resultType']).toBe(resultType);
          expect(feedback?.getAttribute('role')).toBe('status');
          expect(feedback?.textContent).not.toBe('');
          expect(activeDocument.activeElement).toBe(trigger);
        });
      } finally {
        root.remove();
      }
    },
  );

  it('makes Work Notes selectable while every dashboard still opens in Tasks/List', () => {
    const root = freshContainer();
    const renderTasks = vi.fn((host: HTMLElement) => host.createDiv({ text: 'Tasks list' }));
    const renderWorkNotes = vi.fn((host: HTMLElement) =>
      host.createDiv({ text: 'Work Notes list' }),
    );
    const snapshot: ProjectWorkspaceSnapshot = {
      project: {
        path: 'Projects/P.md',
        name: 'P',
        frontmatter: {},
        tags: [],
        statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
        rawStatus: null,
        range: {},
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      },
      tasks: [],
      workNotes: [note(1)],
      milestones: [],
      taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
      milestoneRollups: new Map(),
      workNoteRelations: [],
      overdue: { tasks: 0, workNotes: 0 },
      diagnostics: [],
    };
    renderProjectDashboard(root, snapshot, {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
      renderWorkNotes,
      renderWorkNoteBoard: vi.fn(),
    });

    const workspace = root.querySelector<HTMLElement>('[data-project-workspace]')!;
    expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'list' });
    const scope = root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!;
    expect(scope.disabled).toBe(false);
    scope.click();
    expect(workspace.dataset).toMatchObject({ scope: 'work-notes', layout: 'list' });
    expect(renderWorkNotes).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    expect(workspace.dataset).toMatchObject({ scope: 'work-notes', layout: 'board' });
  });

  it('retains the same open Project workspace but resets a newly opened or different Project', () => {
    const root = freshContainer();
    const session = new ProjectWorkspaceSession();
    const context = {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      workspaceSession: session,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
      renderWorkNotes: vi.fn(),
      renderWorkNoteBoard: vi.fn(),
    };
    const snapshot = (path: string): ProjectWorkspaceSnapshot => ({
      project: {
        path,
        name: path,
        frontmatter: {},
        tags: [],
        statusId: null,
        rawStatus: null,
        range: {},
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      },
      tasks: [],
      workNotes: [note(1, { projectPath: path })],
      milestones: [],
      taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
      milestoneRollups: new Map(),
      workNoteRelations: [],
      overdue: { tasks: 0, workNotes: 0 },
      diagnostics: [],
    });

    renderProjectDashboard(root, snapshot('Projects/P.md'), context);
    root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    root.empty();
    renderProjectDashboard(root, snapshot('Projects/P.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'work-notes',
      layout: 'board',
    });

    root.empty();
    renderProjectDashboard(root, snapshot('Projects/Q.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'tasks',
      layout: 'list',
    });
    session.closeProject();
    root.empty();
    renderProjectDashboard(root, snapshot('Projects/Q.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'tasks',
      layout: 'list',
    });
  });

  it('keeps the real Work Notes scope available for creating a project first note', () => {
    const root = freshContainer();
    const renderWorkNotes = vi.fn();
    const project = {
      path: 'Projects/P.md',
      name: 'P',
      frontmatter: {},
      tags: [],
      statusId: null,
      rawStatus: null,
      range: {},
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectDashboard(
      root,
      {
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
      },
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(),
        renderWorkNotes,
      },
    );

    const scope = root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!;
    expect(scope).not.toBeNull();
    scope.click();
    expect(renderWorkNotes).toHaveBeenCalledWith(expect.any(HTMLElement), 'Projects/P.md', []);
  });
});

describe('Work Note board adapter', () => {
  it('uses the complete canonical status menu for both drag and menu commands', async () => {
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const workNote = note(1);
    const command = vi.fn().mockResolvedValue({ type: 'ok', path: workNote.path });
    const board = createWorkNoteBoardMutation(statuses, command);
    const done = statuses[2]!;

    expect(board.menuItems(workNote)).toEqual(
      statuses.map((status) => ({
        columnKey: status.id,
        label: status.label,
        icon: 'circle-dot',
        checked: status.id === workNote.statusId,
        disabled: status.id === workNote.statusId,
      })),
    );
    const drag = await board.move(workNote, done.id);
    const menu = await board.move(workNote, done.id);
    expect(drag).toEqual(menu);
    expect(command).toHaveBeenNthCalledWith(1, workNote, done.id);
    expect(command).toHaveBeenNthCalledWith(2, workNote, done.id);
  });

  it('keeps configured status order and one unmapped column', () => {
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const columns = workNoteBoardColumns(statuses, [note(1), note(2, { statusId: null })]);

    expect(columns.map(({ key }) => key)).toEqual([...statuses.map(({ id }) => id), 'unmapped']);
    expect(columns[columns.length - 1]?.items).toHaveLength(1);
  });

  it('keeps a failed board menu move visibly in place and restores the card focus', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const items = captureMenuItems();
    try {
      renderWorkNotesView(root, {
        notes: [note(1)],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'board',
        onSetStatus: vi.fn().mockResolvedValue({ type: 'conflict', field: 'status' }),
        openNote: vi.fn(),
      });
      const card = root.querySelector<HTMLElement>('[data-board-item]')!;
      const source = card.closest<HTMLElement>('[data-board-column]')!;
      card.focus();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await items.find(({ title }) => title === 'Done')!.click();

      await vi.waitFor(() => {
        expect(card.closest('[data-board-column]')).toBe(source);
        expect(root.querySelector<HTMLElement>('[data-work-note-feedback]')?.dataset).toMatchObject(
          {
            resultType: 'conflict',
          },
        );
        expect(activeDocument.activeElement).toBe(card);
      });
    } finally {
      root.remove();
    }
  });

  it('keeps a failed board drag visibly in place with accessible feedback and card focus', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    try {
      renderWorkNotesView(root, {
        notes: [note(1)],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'board',
        onSetStatus: vi
          .fn()
          .mockResolvedValue({ type: 'compatibility-conflict', reason: 'latest-audit-rejected' }),
        openNote: vi.fn(),
      });
      const card = root.querySelector<HTMLElement>('[data-board-item]')!;
      const source = card.closest<HTMLElement>('[data-board-column]')!;
      const target = root.querySelector<HTMLElement>(
        `[data-board-column="${DEFAULT_SETTINGS.projects.statuses[2]!.id}"]`,
      )!;
      card.focus();
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

      await vi.waitFor(() => {
        expect(card.closest('[data-board-column]')).toBe(source);
        expect(root.querySelector<HTMLElement>('[data-work-note-feedback]')?.dataset).toMatchObject(
          {
            resultType: 'compatibility-conflict',
          },
        );
        expect(activeDocument.activeElement).toBe(card);
      });
    } finally {
      root.remove();
    }
  });

  it('retains deep board scroll and logical card focus through a successful local move and outer replacement', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const notes = Array.from({ length: 140 }, (_, index) => note(index));
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const command = vi.fn().mockResolvedValue({ type: 'ok', path: notes[103]!.path });
    const render = (current: readonly WorkNoteSnapshot[]) =>
      renderWorkNotesView(root, {
        notes: current,
        statuses,
        layout: 'board',
        session: session.workNotes,
        onSetStatus: command,
        openNote: vi.fn(),
      });
    try {
      let handle = render(notes);
      let sourceScroll = root.querySelector<HTMLElement>(
        `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
      )!;
      Object.defineProperty(sourceScroll, 'clientHeight', { configurable: true, value: 5 * 88 });
      sourceScroll.scrollTop = 100 * 88;
      sourceScroll.dispatchEvent(new Event('scroll'));
      const card = root.querySelector<HTMLElement>(
        '[data-board-item="Work Notes/Work note 103.md"]',
      )!;
      card.focus();
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      root
        .querySelector<HTMLElement>(`[data-board-column="${statuses[2]!.id}"]`)!
        .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      await flushMicrotasks();

      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Work Notes/Work note 103.md',
      );
      sourceScroll = root.querySelector<HTMLElement>(
        `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
      )!;
      expect(sourceScroll.scrollTop).toBe(100 * 88);

      handle.destroy();
      const updated = notes.map((current) =>
        current.path === notes[103]!.path ? { ...current, statusId: statuses[2]!.id } : current,
      );
      handle = render(updated);
      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Work Notes/Work note 103.md',
      );
      expect(
        root.querySelector<HTMLElement>(
          `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
        )?.scrollTop,
      ).toBe(100 * 88);
      handle.destroy();
    } finally {
      root.remove();
    }
  });
});
