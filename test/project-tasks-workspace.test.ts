import { Menu } from 'obsidian';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import type { ProjectsPanelOptions } from '../src/panels/projects/ProjectsPanel';
import { ProjectWorkspaceSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type {
  ProjectChildRenderHandle,
  ProjectsDashboardContext,
} from '../src/panels/projects/viewContext';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, flushMicrotasks, freshContainer, task } from './helpers';

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
            dependency: { type: 'allowed' as const },
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
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
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
    renderTasks: vi.fn(() => ({ destroy: () => undefined })),
  });
  return container;
}

describe('Project Tasks workspace', () => {
  it('keeps scope, layouts, actions, search, and add in one named collection toolbar', () => {
    const container = freshContainer();
    const capture = vi.fn();
    renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings: structuredClone(DEFAULT_SETTINGS),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: (host) => {
        const trigger = host.createEl('button', { attr: { 'data-project-task-capture': '' } });
        trigger.addEventListener('click', capture);
        return { destroy: () => undefined };
      },
    });

    const toolbar = container.querySelector<HTMLElement>('[data-collection-controls]')!;
    expect(toolbar.getAttribute('role')).toBe('toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe('Project collection controls');
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(toolbar.querySelector('[data-project-scope-controls]')).not.toBeNull();
    expect(toolbar.querySelector('[data-collection-kind="scope-or-status"]')).not.toBeNull();
    expect(
      Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > [data-collection-kind]')).map(
        (element) => element.dataset['collectionKind'],
      ),
    ).toEqual(['scope-or-status', 'layout', 'filter', 'group', 'sort', 'search', 'add']);

    toolbar.querySelector<HTMLButtonElement>('[data-project-add]')!.click();
    expect(capture).toHaveBeenCalledOnce();
  });

  it('routes Add to Task capture or Work Note creation for the active scope', () => {
    const container = freshContainer();
    const taskCapture = vi.fn();
    const workNoteCreate = vi.fn();
    renderProjectDashboard(container, snapshot('with-work-notes'), {
      state: new AppState(),
      settings: structuredClone(DEFAULT_SETTINGS),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: (host) => {
        const trigger = host.createEl('button', { attr: { 'data-project-task-capture': '' } });
        trigger.addEventListener('click', taskCapture);
        return { destroy: () => undefined };
      },
      renderWorkNotes: (host) => {
        const trigger = host.createEl('button', { attr: { 'data-work-note-create': '' } });
        trigger.addEventListener('click', workNoteCreate);
        return { destroy: () => undefined };
      },
    });

    const add = container.querySelector<HTMLButtonElement>('[data-project-add]')!;
    add.click();
    container.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-project-add]')!.click();

    expect(taskCapture).toHaveBeenCalledOnce();
    expect(workNoteCreate).toHaveBeenCalledOnce();
  });

  it('releases both mounted workspace sessions when the dashboard is destroyed', () => {
    const container = freshContainer();
    const workspaceSession = new ProjectWorkspaceSession();
    const handle = renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings: structuredClone(DEFAULT_SETTINGS),
      workspaceSession,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
    });
    workspaceSession.scopeSession('tasks').textQuery = 'release me';

    handle.destroy();

    expect(workspaceSession.collectionSession('Projects/A.md', 'tasks').query).toBe('');
  });

  it.each(['filter', 'group', 'sort'] as const)(
    'returns focus to the workspace %s trigger when its native menu hides',
    (kind) => {
      let hide: (() => void) | undefined;
      vi.spyOn(Menu.prototype, 'onHide').mockImplementation(function (this: Menu, handler) {
        hide = handler;
        return this;
      });
      vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
        return this;
      });
      const container = freshContainer();
      activeDocument.body.append(container);
      renderProjectDashboard(container, snapshot('small'), {
        state: new AppState(),
        settings: structuredClone(DEFAULT_SETTINGS),
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(() => ({ destroy: () => undefined })),
      });

      const trigger = container.querySelector<HTMLButtonElement>(`[data-collection-${kind}]`)!;
      trigger.focus();
      trigger.click();
      expect(hide).toBeDefined();
      hide?.();

      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(activeDocument.activeElement).toBe(trigger);
      container.remove();
    },
  );

  it('feeds the same canonical Task search result identities to List, Board, and Timeline', () => {
    const container = freshContainer();
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/A.md');
    session.scopeSession('tasks').textQuery = 'ship';
    const matching = {
      task: task({
        title: 'Ship release',
        planning: { due: '2026-08-30' as never },
        source: { filePath: 'Projects/A.md', line: 4 },
      }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    };
    const excluded = {
      task: task({
        title: 'Archive notes',
        planning: { due: '2026-08-31' as never },
        source: { filePath: 'Projects/A.md', line: 5 },
      }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: 'Projects/A.md' },
    };
    const identities: string[][] = [];
    const capture = (
      _host: HTMLElement,
      _path: string,
      actions: ProjectWorkspaceSnapshot['tasks'],
    ): ProjectChildRenderHandle => {
      identities.push(actions.map(({ task: current }) => current.title));
      return { destroy: () => undefined };
    };

    renderProjectDashboard(
      container,
      { ...snapshot('dated'), tasks: [excluded, matching] },
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        workspaceSession: session,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: capture,
        renderTaskBoard: capture,
        renderTaskTimeline: capture,
      },
    );
    container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-project-layout="timeline"]')!.click();

    expect(identities).toEqual([['Ship release'], ['Ship release'], ['Ship release']]);
  });

  it('requires the shared cleanup handle from every child renderer hook', () => {
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderTasks']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderTaskBoard']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderTaskTimeline']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderWorkNotes']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderWorkNoteBoard']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsDashboardContext['renderWorkNoteTimeline']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();

    expectTypeOf<
      ReturnType<NonNullable<ProjectsPanelOptions['renderTasks']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsPanelOptions['renderTaskBoard']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
    expectTypeOf<
      ReturnType<NonNullable<ProjectsPanelOptions['renderTaskTimeline']>>
    >().toEqualTypeOf<ProjectChildRenderHandle>();
  });

  it('delivers the persisted scoped Task view state to List and Board child renderers', async () => {
    const container = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = new ProjectWorkspaceSession();
    session.bindCollectionPreferences(settings);
    session.openProject('Projects/A.md');
    const override = {
      ...settings.projects.view.tasks,
      groupBy: 'priority' as const,
      statusGroups: ['done' as const],
    };
    await session.updateCollectionPreference('Projects/A.md', 'tasks', (current) => ({
      ...current,
      group: override.groupBy,
      sort: override.sortBy,
      filters: override.filters,
      layoutPreferences: {
        ...current.layoutPreferences,
        primary: { table: override.table, statusGroups: ['done'] },
      },
    }));
    const renderTasks = vi.fn<NonNullable<ProjectsDashboardContext['renderTasks']>>(() => ({
      destroy: () => undefined,
    }));
    const renderTaskBoard = vi.fn<NonNullable<ProjectsDashboardContext['renderTaskBoard']>>(() => ({
      destroy: () => undefined,
    }));

    renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      workspaceSession: session,
      renderTasks,
      renderTaskBoard,
    });
    container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();

    expect(renderTasks.mock.calls[0]?.[3]).toMatchObject(override);
    expect(renderTaskBoard.mock.calls[0]?.[3]).toMatchObject(override);
  });

  it('owns Project-card property filters in the Task scoped preference', async () => {
    const container = freshContainer();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const state = new AppState();
    const session = new ProjectWorkspaceSession();
    const renderTasks = vi.fn<NonNullable<ProjectsDashboardContext['renderTasks']>>(
      (host, _path, _tasks, _viewState, _allTasks, onAddPropertyFilter) => {
        const filter = host.createEl('button', { attr: { 'data-test-project-filter': '' } });
        filter.addEventListener('click', () =>
          onAddPropertyFilter?.({ type: 'tag', value: '#project-only' }),
        );
        return { destroy: () => undefined };
      },
    );

    renderProjectDashboard(container, snapshot('small'), {
      state,
      settings,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      workspaceSession: session,
      renderTasks,
    });
    container.querySelector<HTMLButtonElement>('[data-test-project-filter]')!.click();
    await Promise.resolve();

    expect(renderTasks.mock.lastCall?.[3].filters).toContainEqual({
      type: 'tag',
      value: '#project-only',
    });
    expect(session.collectionPreference('Projects/A.md', 'tasks').filters).toContainEqual({
      type: 'tag',
      value: '#project-only',
    });
    expect(state.get('centerListViewState').filters).toEqual([]);
  });

  it('destroys each child renderer before replacement and destroys the active child with the dashboard', () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const listDestroy = vi.fn();
    const boardDestroy = vi.fn();
    const sequence: string[] = [];
    const renderTasks = (host: HTMLElement): ProjectChildRenderHandle => {
      sequence.push('list-render');
      const owned = host.createDiv({ attr: { 'data-test-child-owner': 'list' } });
      return {
        destroy: () => {
          expect(owned.isConnected).toBe(true);
          sequence.push('list-destroy');
          listDestroy();
        },
      };
    };
    const renderTaskBoard = (host: HTMLElement): ProjectChildRenderHandle => {
      sequence.push('board-render');
      const owned = host.createDiv({ attr: { 'data-test-child-owner': 'board' } });
      return {
        destroy: () => {
          expect(owned.isConnected).toBe(true);
          sequence.push('board-destroy');
          boardDestroy();
        },
      };
    };
    const dashboard: ProjectChildRenderHandle = renderProjectDashboard(
      container,
      snapshot('small'),
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks,
        renderTaskBoard,
      },
    );
    expect(dashboard).toEqual(expect.objectContaining({ destroy: expect.any(Function) }));

    container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    expect(listDestroy).toHaveBeenCalledOnce();
    expect(sequence).toEqual(['list-render', 'list-destroy', 'board-render']);
    container.querySelector<HTMLButtonElement>('[data-project-layout="list"]')!.click();
    expect(boardDestroy).toHaveBeenCalledOnce();
    expect(sequence).toEqual([
      'list-render',
      'list-destroy',
      'board-render',
      'board-destroy',
      'list-render',
    ]);

    dashboard.destroy();
    expect(listDestroy).toHaveBeenCalledTimes(2);
    container.remove();
  });

  it('does not let a late Board mutation erase the replacement layout', async () => {
    const container = freshContainer();
    const pending = deferred<{ readonly type: 'ok'; readonly path: string }>();
    renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: (host) => {
        host.createDiv({ cls: 'replacement-list', text: 'Replacement list' });
        return { destroy: () => host.empty() };
      },
      renderTaskBoard: (host) =>
        renderBoard(host, {
          columns: [
            { key: 'active', label: 'Active', role: 'regular', items: [{ key: 'task' }] },
            { key: 'done', label: 'Done', role: 'regular', items: [] },
          ],
          mutation: {
            move: () => pending.promise,
            menuItems: () => [],
          },
          itemKey: ({ key }) => key,
          renderItem: (row, item) =>
            row.createEl('button', {
              text: item.key,
              attr: { type: 'button', 'data-test-board-task': item.key },
            }),
        }),
    });
    container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    const item = container.querySelector<HTMLElement>('[data-board-item="task"]')!;
    item.dispatchEvent(new Event('dragstart', { bubbles: true }));
    container
      .querySelector<HTMLElement>('[data-board-column="done"]')!
      .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    container.querySelector<HTMLButtonElement>('[data-project-layout="list"]')!.click();
    expect(container.querySelector('.replacement-list')).not.toBeNull();
    pending.resolve({ type: 'ok', path: 'task' });
    await flushMicrotasks();

    expect(container.querySelector('.replacement-list')?.textContent).toBe('Replacement list');
    expect(container.querySelector('[data-test-board-task]')).toBeNull();
  });

  it('does not let a late Board Undo erase the replacement layout', async () => {
    const container = freshContainer();
    const pending = deferred<{ readonly type: 'ok'; readonly path: string }>();
    const item = { key: 'task' };
    renderProjectDashboard(container, snapshot('small'), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: (host) => {
        host.createDiv({ cls: 'replacement-after-undo', text: 'Replacement after Undo' });
        return { destroy: () => host.empty() };
      },
      renderTaskBoard: (host) =>
        renderBoard(host, {
          columns: [
            { key: 'active', label: 'Active', role: 'regular', items: [item] },
            { key: 'done', label: 'Done', role: 'regular', items: [] },
          ],
          mutation: { move: vi.fn(), menuItems: () => [] },
          undo: () => pending.promise,
          initialUndo: {
            item,
            columnKey: 'done',
            result: { type: 'ok', path: 'task' },
          },
          itemKey: ({ key }) => key,
          renderItem: (row, current) =>
            row.createEl('button', { text: current.key, attr: { type: 'button' } }),
        }),
    });
    container.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    container.querySelector<HTMLButtonElement>('[data-project-layout="list"]')!.click();
    pending.resolve({ type: 'ok', path: 'task' });
    await flushMicrotasks();

    expect(container.querySelector('.replacement-after-undo')?.textContent).toBe(
      'Replacement after Undo',
    );
  });

  it('retains the portfolio Timeline viewport while project workspaces open and close', () => {
    const session = new ProjectWorkspaceSession();
    Object.assign(session.portfolioTimeline, {
      firstKey: 'project:Projects/Deep.md',
      firstIndex: 80,
      focusedKey: 'project:Projects/Focused.md',
      restoreFocus: true,
    });

    session.openProject('Projects/A.md');
    session.closeProject();

    expect(session.portfolioTimeline).toMatchObject({
      firstIndex: 80,
      focusedKey: 'project:Projects/Focused.md',
    });
  });

  it('retains same-Project Timeline layout and viewport but resets a different Project to Tasks/List', () => {
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/A.md');
    session.scope = 'work-notes';
    session.layout = 'timeline';
    Object.assign(session.timelines.workNotes, {
      firstKey: 'work-note:Work Notes/Deep.md',
      firstIndex: 120,
      focusedKey: 'work-note:Work Notes/Focused.md',
      restoreFocus: true,
    });

    session.openProject('Projects/A.md');
    expect(session).toMatchObject({ scope: 'work-notes', layout: 'timeline' });
    expect(session.timelines.workNotes).toMatchObject({
      firstIndex: 120,
      focusedKey: 'work-note:Work Notes/Focused.md',
    });

    session.openProject('Projects/B.md');
    expect(session).toMatchObject({ scope: 'tasks', layout: 'list' });
    expect(session.timelines.workNotes).toEqual({
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: null,
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    });
  });

  it.each([
    ['empty', false, false, false],
    ['small', false, true, false],
    ['dated', false, true, false],
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

  it.each([['with-work-notes', '[data-project-scope="work-notes"]']] as const)(
    'keeps the visible %s future control disabled without leaving Tasks/List',
    (fixture, selector) => {
      const container = freshContainer();
      const renderTasks = vi.fn((host: HTMLElement) => {
        host.createDiv({ text: 'Shared task list' });
        return { destroy: () => host.empty() };
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
    const renderTasks = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Shared task list' });
      return { destroy: () => host.empty() };
    });
    const renderTaskBoard = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Shared task board' });
      return { destroy: () => host.empty() };
    });
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

  it('enables Timeline only when the active scope has dated data and a real renderer', () => {
    const container = freshContainer();
    const renderTaskTimeline = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Shared task Timeline' });
      return { destroy: () => host.empty() };
    });
    renderProjectDashboard(container, snapshot('dated'), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
      renderTaskTimeline,
    });
    const workspace = container.querySelector<HTMLElement>('[data-project-workspace]')!;
    const timeline = container.querySelector<HTMLButtonElement>(
      '[data-project-layout="timeline"]',
    )!;

    expect(timeline.disabled).toBe(false);
    timeline.click();
    expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'timeline' });
    expect(container.querySelector('.abyss-project-tasks-content')?.textContent).toBe(
      'Shared task Timeline',
    );
    expect(renderTaskTimeline).toHaveBeenCalledOnce();
  });

  it('enables the Work Note Timeline only after selecting a dated Work Note scope', () => {
    const container = freshContainer();
    const base = snapshot('with-work-notes');
    const dated = {
      ...base,
      workNotes: [
        {
          ...base.workNotes[0]!,
          range: {
            start: {
              raw: '2026-08-27',
              precision: 'date' as const,
              instantMs: Date.UTC(2026, 7, 27),
            },
          },
        },
      ],
    };
    const renderWorkNoteTimeline = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Shared Work Note Timeline' });
      return { destroy: () => host.empty() };
    });
    renderProjectDashboard(container, dated, {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
      renderWorkNotes: vi.fn(() => ({ destroy: () => undefined })),
      renderWorkNoteTimeline,
    });

    container.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    const timeline = container.querySelector<HTMLButtonElement>(
      '[data-project-layout="timeline"]',
    )!;
    expect(timeline.disabled).toBe(false);
    timeline.click();
    expect(container.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject(
      {
        scope: 'work-notes',
        layout: 'timeline',
      },
    );
    expect(container.querySelector('.abyss-project-tasks-content')?.textContent).toBe(
      'Shared Work Note Timeline',
    );
  });

  it('synchronizes the shared search field when the workspace scope changes', () => {
    const container = freshContainer();
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/A.md');
    session.scopeSession('tasks').textQuery = 'task query';
    session.scopeSession('work-notes').textQuery = 'note query';

    renderProjectDashboard(container, snapshot('with-work-notes'), {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      workspaceSession: session,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
      renderWorkNotes: vi.fn(() => ({ destroy: () => undefined })),
    });

    const search = container.querySelector<HTMLInputElement>('[data-collection-kind="search"]')!;
    expect(search.value).toBe('task query');
    expect(search.getAttribute('aria-label')).toBe('Filter tasks');

    container.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();

    expect(search.value).toBe('note query');
    expect(search.getAttribute('aria-label')).toBe('Filter Work Notes');
  });

  it('preserves the user primary sort and uses ownership, created date, and file order only as equal-key tie-breakers', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.tasks = {
      ...settings.projects.view.tasks,
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
      dependency: { type: 'allowed' as const },
      owner: { type: 'work-note' as const, path: 'Notes/B.md' },
    };
    const directAlpha = {
      task: task({
        title: 'Alpha',
        planning: { created: '2026-08-22' as never },
        source: { filePath: base.project.path, line: 7 },
      }),
      projectPath: base.project.path,
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: base.project.path },
    };
    const inheritedBeta = {
      task: task({ title: 'Beta', source: { filePath: 'Notes/A.md', line: 1 } }),
      projectPath: base.project.path,
      dependency: { type: 'allowed' as const },
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
      dependency: { type: 'allowed' as const },
      owner: { type: 'project' as const, path: base.project.path },
    };
    const renderTasks = vi.fn(
      (
        _host: HTMLElement,
        _path: string,
        _tasks: ProjectWorkspaceSnapshot['tasks'],
      ): ProjectChildRenderHandle => ({ destroy: () => undefined }),
    );
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
