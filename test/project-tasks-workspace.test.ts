import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer, task } from './helpers';

function snapshot(
  fixture: 'empty' | 'small' | 'dated' | 'with-work-notes',
): ProjectWorkspaceSnapshot {
  const tasks =
    fixture === 'empty' || fixture === 'with-work-notes'
      ? []
      : [
          {
            task: task({
              title: 'Project task',
              ...(fixture === 'dated' ? { planning: { due: '2026-08-27' as never } } : {}),
              source: { filePath: 'Projects/A.md', line: 2 },
            }),
            projectPath: 'Projects/A.md',
            owner: { type: 'project' as const, path: 'Projects/A.md' },
          },
        ];
  return {
    project: {
      path: 'Projects/A.md',
      name: 'A',
      frontmatter: {},
      tags: [],
      statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
      rawStatus: null,
      range: {},
      stats: {
        total: tasks.length,
        done: 0,
        cancelled: 0,
        inProgress: 0,
        open: tasks.length,
        progress: tasks.length === 0 ? null : 0,
      },
    },
    tasks,
    workNotes:
      fixture === 'with-work-notes'
        ? [
            {
              path: 'Notes/Work.md',
              presetRevision: 1,
              presetFingerprint: 'fixture-fingerprint',
              kind: 'ordinary',
              projectPath: 'Projects/A.md',
              statusId: null,
              rawStatus: null,
              writableStatusShape: true,
              range: {},
              blockedByPaths: [],
              relatedPaths: [],
              diagnostics: [],
            },
          ]
        : [],
    milestones: [],
    taskRollup: {
      total: tasks.length,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      open: tasks.length,
      progress: tasks.length === 0 ? null : 0,
    },
    workNoteRollup: {
      active: fixture === 'with-work-notes' ? 1 : 0,
      completed: 0,
      dropped: 0,
    },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    diagnostics: [],
  };
}

function render(fixture: Parameters<typeof snapshot>[0]): HTMLElement {
  const container = freshContainer();
  renderProjectDashboard(container, snapshot(fixture), {
    state: new AppState(),
    settings: DEFAULT_SETTINGS,
    onSetStatus: vi.fn(),
    openNote: vi.fn(),
    renderTasks: vi.fn(),
  });
  return container;
}

describe('Project Tasks workspace', () => {
  it.each([
    ['empty', false, false, false],
    ['small', false, true, false],
    ['dated', false, true, true],
    ['with-work-notes', true, false, false],
  ] as const)(
    'opens %s Project in Tasks/List with conditional scopes and layouts',
    (fixture, workNotesVisible, boardVisible, timelineVisible) => {
      const container = render(fixture);
      const workspace = container.querySelector<HTMLElement>('[data-project-workspace]')!;

      expect(workspace.dataset['scope']).toBe('tasks');
      expect(workspace.dataset['layout']).toBe('list');
      expect(container.querySelector('[data-project-scope="work-notes"]') !== null).toBe(
        workNotesVisible,
      );
      expect(container.querySelector('[data-project-layout="board"]') !== null).toBe(boardVisible);
      expect(container.querySelector('[data-project-layout="timeline"]') !== null).toBe(
        timelineVisible,
      );
    },
  );

  it.each([
    ['with-work-notes', '[data-project-scope="work-notes"]'],
    ['dated', '[data-project-layout="timeline"]'],
  ] as const)(
    'keeps the visible %s future control disabled without leaving Tasks/List',
    (fixture, selector) => {
      const container = freshContainer();
      const renderTasks = vi.fn((host: HTMLElement) => {
        host.createDiv({ text: 'Shared task list' });
      });
      renderProjectDashboard(container, snapshot(fixture), {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks,
      });
      const workspace = container.querySelector<HTMLElement>('[data-project-workspace]')!;
      const control = container.querySelector<HTMLButtonElement>(selector)!;

      expect(control.disabled).toBe(true);
      expect(control.getAttribute('aria-disabled')).toBe('true');
      control.click();
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'list' });
      expect(container.querySelector('.abyss-project-tasks-content')?.textContent).toBe(
        'Shared task list',
      );
      expect(renderTasks).toHaveBeenCalledOnce();
    },
  );

  it('activates the Board route and preserves Tasks/List as the default', () => {
    const container = freshContainer();
    const renderTasks = vi.fn((host: HTMLElement) => host.createDiv({ text: 'Shared task list' }));
    const renderTaskBoard = vi.fn((host: HTMLElement) =>
      host.createDiv({ text: 'Shared task board' }),
    );
    renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
      renderTaskBoard,
    });

    const workspace = container.querySelector<HTMLElement>('[data-project-workspace]')!;
    const board = container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!;
    expect(board.disabled).toBe(false);
    expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'list' });

    board.click();

    expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'board' });
    expect(container.querySelector('.abyss-project-tasks-content')?.textContent).toBe(
      'Shared task board',
    );
    expect(renderTaskBoard).toHaveBeenCalledOnce();
  });

  it('preserves the user primary sort and uses ownership, created date, and file order only as equal-key tie-breakers', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.tasks = {
      groupBy: 'none',
      sortBy: { field: 'title', dir: 'asc' },
      filters: [],
      statusGroups: ['todo'],
    };
    const base = snapshot('small');
    const inheritedAlpha = {
      task: task({
        title: 'Alpha',
        planning: { created: '2026-08-01' as never },
        source: { filePath: 'Notes/B.md', line: 2 },
      }),
      projectPath: base.project.path,
      owner: { type: 'work-note' as const, path: 'Notes/B.md' },
    };
    const directAlpha = {
      task: task({
        title: 'Alpha',
        planning: { created: '2026-08-22' as never },
        source: { filePath: base.project.path, line: 7 },
      }),
      projectPath: base.project.path,
      owner: { type: 'project' as const, path: base.project.path },
    };
    const inheritedBeta = {
      task: task({ title: 'Beta', source: { filePath: 'Notes/A.md', line: 1 } }),
      projectPath: base.project.path,
      owner: { type: 'work-note' as const, path: 'Notes/A.md' },
    };
    const done = {
      task: task({
        title: 'Done',
        status: 'done',
        statusSymbol: 'x',
        source: { filePath: base.project.path, line: 9 },
      }),
      projectPath: base.project.path,
      owner: { type: 'project' as const, path: base.project.path },
    };
    const renderTasks = vi.fn();
    const container = freshContainer();

    renderProjectDashboard(
      container,
      { ...base, tasks: [inheritedBeta, inheritedAlpha, done, directAlpha] },
      {
        state: new AppState(),
        settings,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks,
      },
    );

    expect(renderTasks.mock.calls[0]?.[2]).toEqual([directAlpha, inheritedAlpha, inheritedBeta]);
  });
});
