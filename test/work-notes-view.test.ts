import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  createWorkNoteBoardMutation,
  workNoteBoardColumns,
} from '../src/panels/projects/boardProjection';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import {
  WORK_NOTE_FALLBACK_VISIBLE_ROWS,
  WORK_NOTE_OVERSCAN,
  WORK_NOTE_ROW_EXTENT,
  renderWorkNotesView,
} from '../src/panels/projects/WorkNotesView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer } from './helpers';

function note(index: number, over: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  const ordinal = String(index).padStart(3, '0');
  return {
    path: `Work Notes/Work note ${ordinal}.md`,
    presetRevision: 7,
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
});
