import { describe, expect, it, vi } from 'vitest';
import { ProjectWorkspaceSessionRegistry } from '../src/panels/projects/ProjectWorkspaceSession';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

describe('ProjectWorkspaceSessionRegistry', () => {
  it('constructs one coordinator-backed session per exact Project scope without persisting interaction state', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.bindCollectionPreferences(settings);
    registry.openProject('Projects/A.md');
    const tasks = registry.scopeSession('tasks');
    const workNotes = registry.scopeSession('work-notes');
    const tasksListener = vi.fn();
    const stop = registry.subscribeCollectionSession('Projects/A.md', 'tasks', tasksListener);

    tasks.textQuery = 'ship';
    tasks.selection.inspectorKey = 'task-1';
    tasks.viewport.focusedKey = 'task-1';
    tasks.viewport.firstKey = 'task-1';
    workNotes.textQuery = 'retro';

    expect(registry.collectionScopeKey('Projects/A.md', 'tasks')).toBe(
      'project:Projects/A.md:tasks',
    );
    expect(registry.collectionSession('Projects/A.md', 'tasks')).toMatchObject({
      query: 'ship',
      selectionKey: 'task-1',
      focusedKey: 'task-1',
      scrollAnchor: 'task-1',
    });
    expect(registry.collectionSession('Projects/A.md', 'tasks')).not.toHaveProperty('layout');
    expect(registry.collectionSession('Projects/A.md', 'work-notes').query).toBe('retro');
    expect(registry.collectionPreference('Projects/A.md', 'tasks').group).toBe(
      settings.projects.view.tasks.groupBy,
    );
    expect(tasksListener).toHaveBeenCalledWith(expect.objectContaining({ query: 'ship' }));
    expect(settings.projects.view.tasks).toEqual(DEFAULT_SETTINGS.projects.view.tasks);

    stop();
    registry.releaseProject('Projects/A.md');
    expect(registry.collectionSession('Projects/A.md', 'tasks')).toMatchObject({
      query: '',
      selectionKey: null,
      focusedKey: null,
      scrollAnchor: null,
    });
  });

  it('persists versioned preferences per Project scope, publishes once, and reloads without leaking global defaults', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const save = vi.fn().mockResolvedValue(undefined);
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.bindCollectionPreferences(settings, save);
    const listener = vi.fn();
    registry.subscribeCollectionPreference('Projects/A.md', 'tasks', listener);

    await registry.updateCollectionPreference('Projects/A.md', 'tasks', (current) => ({
      ...current,
      layout: 'board',
      group: 'priority',
    }));

    expect(settings.projects.view.collectionPreferences['Projects/A.md']?.tasks).toMatchObject({
      version: 1,
      layout: 'board',
      group: 'priority',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledOnce();
    expect(registry.collectionPreference('Projects/B.md', 'tasks')).toMatchObject({
      layout: 'list',
      group: settings.projects.view.tasks.groupBy,
    });

    const reloaded = new ProjectWorkspaceSessionRegistry();
    reloaded.bindCollectionPreferences(settings);
    expect(reloaded.collectionPreference('Projects/A.md', 'tasks')).toMatchObject({
      layout: 'board',
      group: 'priority',
    });
    expect(settings.projects.view.tasks.groupBy).toBe('none');
  });

  it('normalizes dormant partial scope records before a coordinator read and reload', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.view.collectionPreferences['Projects/A.md'] = {
      tasks: { version: 1, layout: 'board' },
      workNotes: { version: 3, layout: 'invalid' },
      dormantScope: { keep: 'future data' },
    } as never;

    const registry = new ProjectWorkspaceSessionRegistry();
    registry.bindCollectionPreferences(settings);
    registry.openProject('Projects/A.md');

    expect(registry.collectionPreference('Projects/A.md', 'tasks')).toMatchObject({
      version: 1,
      layout: 'board',
      filters: [],
      group: 'none',
      sort: { field: 'date', dir: 'asc' },
      visibleFields: ['task', 'status', 'priority', 'due', 'nextAction'],
      layoutPreferences: { primary: { table: { version: 1 } } },
    });
    expect(registry.collectionView('Projects/A.md', 'tasks')).toMatchObject({
      filters: [],
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      table: { version: 1 },
    });
    expect(registry.collectionPreference('Projects/A.md', 'work-notes')).toMatchObject({
      version: 1,
      layout: 'list',
      filters: settings.projects.view.workNotes.statusIds,
      group: 'none',
      sort: { field: 'updated', dir: 'desc' },
      visibleFields: [],
      layoutPreferences: {},
    });
    expect(settings.projects.view.collectionPreferences['Projects/A.md']).toMatchObject({
      dormantScope: { keep: 'future data' },
    });

    const reloaded = new ProjectWorkspaceSessionRegistry();
    reloaded.bindCollectionPreferences(settings);
    expect(reloaded.collectionView('Projects/A.md', 'tasks').table).toMatchObject({ version: 1 });
  });

  it('owns independent session-only Timeline presentation state for every scope', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/A.md');

    expect(registry.portfolioTimeline).toMatchObject({
      focalDate: null,
      scrollLeft: 0,
      scale: 'quarter',
      identityWidth: 240,
      focusedInteraction: null,
    });
    expect(registry.timelines.tasks).toMatchObject({
      focalDate: null,
      scrollLeft: 0,
      scale: 'week',
      identityWidth: 240,
      focusedInteraction: null,
    });
    expect(registry.timelines.workNotes).toMatchObject({
      focalDate: null,
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    });

    registry.timelines.tasks.focalDate = '2026-08-30';
    registry.timelines.tasks.scrollLeft = 420;
    expect(registry.timelines.workNotes.focalDate).toBeNull();
    expect(registry.portfolioTimeline.scrollLeft).toBe(0);
  });

  it('keeps independent Task and Work Note slices, including their scope-local continuity', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/A.md');
    const tasks = registry.scopeSession('tasks');
    const workNotes = registry.scopeSession('work-notes');

    tasks.layout = 'board';
    tasks.textQuery = 'ship';
    tasks.viewport.firstKey = 'task-1';
    tasks.selection.selectedKeys = ['task-1'];
    workNotes.layout = 'timeline';
    workNotes.textQuery = 'retro';
    workNotes.viewport.firstKey = 'note-1';
    workNotes.selection.selectedKeys = ['note-1'];
    workNotes.captureDraft = 'Untitled work note';

    registry.scope = 'tasks';
    expect(registry.layout).toBe('board');
    registry.scope = 'work-notes';
    expect(registry.layout).toBe('timeline');
    expect(registry.scopeSession('tasks')).toMatchObject({
      textQuery: 'ship',
      viewport: { firstKey: 'task-1' },
      selection: { selectedKeys: ['task-1'] },
    });
    expect(registry.scopeSession('work-notes')).toMatchObject({
      textQuery: 'retro',
      viewport: { firstKey: 'note-1' },
      selection: { selectedKeys: ['note-1'] },
      captureDraft: 'Untitled work note',
    });
  });

  it('reads the scoped persisted preference instead of a session view override', async () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    const settings = structuredClone(DEFAULT_SETTINGS);
    registry.bindCollectionPreferences(settings);
    registry.openProject('Projects/A.md');
    await registry.updateCollectionPreference('Projects/A.md', 'tasks', (current) => ({
      ...current,
      group: 'priority',
    }));

    expect(registry.collectionView('Projects/A.md', 'tasks')).toMatchObject({
      groupBy: 'priority',
    });
  });

  it('evicts the least-recently-used clean Project session after twelve entries', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    for (let index = 0; index < 13; index += 1) registry.openProject(`Projects/${index}.md`);

    expect(registry.hasProject('Projects/0.md')).toBe(false);
    expect(registry.hasProject('Projects/1.md')).toBe(true);
    expect(registry.size).toBe(12);
  });

  it('allows dirty Project sessions to overflow the clean LRU bound', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    for (let index = 0; index < 13; index += 1) {
      registry.openProject(`Projects/${index}.md`);
      registry.scopeSession('work-notes').captureDraft = `draft ${index}`;
    }

    expect(registry.size).toBe(13);
    expect(registry.hasProject('Projects/0.md')).toBe(true);
  });

  it('restores each Project path and scope from its own registry entry', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/A.md');
    registry.scope = 'work-notes';
    registry.layout = 'board';
    registry.scopeSession('tasks').textQuery = 'alpha';
    registry.openProject('Projects/B.md');
    registry.scope = 'tasks';
    registry.layout = 'timeline';
    registry.scopeSession('tasks').textQuery = 'beta';

    registry.openProject('Projects/A.md');
    expect(registry.scope).toBe('work-notes');
    expect(registry.layout).toBe('board');
    expect(registry.scopeSession('tasks').textQuery).toBe('alpha');
  });

  it('keeps Task and Work Note board presentation independent per Project and through rename', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/A.md');
    registry.taskBoard.preference = {
      version: 1,
      columnOrder: ['todo', 'done', 'dormant'],
      collapsedColumnIds: ['done'],
      hiddenColumnIds: ['todo'],
    };
    registry.workNotes.board.preference = {
      version: 1,
      columnOrder: ['active', 'done'],
      collapsedColumnIds: [],
      hiddenColumnIds: ['done'],
    };
    registry.openProject('Projects/B.md');

    expect(registry.taskBoard.preference).toBeUndefined();
    expect(registry.workNotes.board.preference).toBeUndefined();

    registry.renameProject('Projects/A.md', 'Projects/Renamed.md');
    registry.openProject('Projects/Renamed.md');
    expect(registry.taskBoard.preference).toMatchObject({
      columnOrder: ['todo', 'done', 'dormant'],
      collapsedColumnIds: ['done'],
      hiddenColumnIds: ['todo'],
    });
    expect(registry.workNotes.board.preference).toMatchObject({ hiddenColumnIds: ['done'] });
  });

  it('moves a session key without collision', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/Before.md');
    registry.scopeSession('tasks').textQuery = 'keep me';

    registry.renameProject('Projects/Before.md', 'Projects/After.md');

    expect(registry.hasProject('Projects/Before.md')).toBe(false);
    registry.openProject('Projects/After.md');
    expect(registry.scopeSession('tasks').textQuery).toBe('keep me');
  });

  it('makes live source session state authoritative on rename collisions', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/Source.md');
    registry.scopeSession('tasks').textQuery = 'source';
    registry.openProject('Projects/Destination.md');
    registry.scopeSession('tasks').textQuery = 'destination';
    registry.openProject('Projects/Source.md');

    registry.renameProject('Projects/Source.md', 'Projects/Destination.md');
    registry.openProject('Projects/Destination.md');

    expect(registry.scopeSession('tasks').textQuery).toBe('source');
  });

  it('retains a dirty dormant collision destination as an explicit recovery entry', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/Source.md');
    registry.openProject('Projects/Destination.md');
    registry.scopeSession('work-notes').captureDraft = 'Recover this';
    registry.taskBoard.preference = {
      version: 1,
      columnOrder: ['todo', 'done'],
      collapsedColumnIds: ['done'],
      hiddenColumnIds: [],
    };
    registry.openProject('Projects/Source.md');

    registry.renameProject('Projects/Source.md', 'Projects/Destination.md');

    expect(registry.recoveryEntries()).toHaveLength(1);
    expect(registry.recoveryEntries()[0]).toMatchObject({
      sourcePath: 'Projects/Source.md',
      destinationPath: 'Projects/Destination.md',
      workNotes: { captureDraft: 'Recover this' },
      taskBoardPreference: { collapsedColumnIds: ['done'] },
    });
  });

  it('rebases Project and Work Note scope-local identities on rename', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/Before.md');
    const workNotes = registry.scopeSession('work-notes');
    workNotes.selection.selectedKeys = ['Work Notes/Before.md'];
    workNotes.selection.focusedKey = 'Work Notes/Before.md';
    workNotes.selection.inspectorKey = 'Work Notes/Before.md';
    workNotes.viewport.firstKey = 'Work Notes/Before.md';
    registry.workNotes.inspectorPath = 'Work Notes/Before.md';
    registry.workNotes.pendingCreatedPath = 'Work Notes/Before.md';
    registry.timelines.workNotes.firstKey = 'Work Notes/Before.md';
    registry.workNotes.board.focusedKey = 'Work Notes/Before.md';
    registry.workNotes.board.columns['active'] = {
      firstKey: 'Work Notes/Before.md',
      firstIndex: 0,
      focusedKey: 'Work Notes/Before.md',
      restoreFocus: true,
    };

    registry.renamePath('Projects/Before.md', 'Projects/After.md');
    expect(registry.hasProject('Projects/Before.md')).toBe(false);
    registry.openProject('Projects/After.md');
    registry.renamePath('Work Notes/Before.md', 'Work Notes/After.md');

    expect(registry.scopeSession('work-notes')).toMatchObject({
      selection: {
        selectedKeys: ['Work Notes/After.md'],
        focusedKey: 'Work Notes/After.md',
        inspectorKey: 'Work Notes/After.md',
      },
      viewport: { firstKey: 'Work Notes/After.md' },
    });
    expect(registry.workNotes).toMatchObject({
      inspectorPath: 'Work Notes/After.md',
      pendingCreatedPath: 'Work Notes/After.md',
      board: {
        focusedKey: 'Work Notes/After.md',
        columns: {
          active: { firstKey: 'Work Notes/After.md', focusedKey: 'Work Notes/After.md' },
        },
      },
    });
    expect(registry.timelines.workNotes.firstKey).toBe('Work Notes/After.md');
  });

  it('atomically rebases every portfolio Project and Work Note identity on rename', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    const projectBefore = 'Projects/Before.md';
    const projectAfter = 'Projects/After.md';
    registry.portfolioBoard.focusedKey = projectBefore;
    registry.portfolioBoard.columns['active'] = {
      firstKey: projectBefore,
      firstIndex: 3,
      focusedKey: projectBefore,
      restoreFocus: true,
    };
    registry.portfolioTimeline.firstKey = `project:${projectBefore}`;
    registry.portfolioTimeline.focusedKey = `project:${projectBefore}`;
    registry.portfolioTimeline.focusedInteraction = {
      itemKey: `project:${projectBefore}`,
      role: 'range',
    };
    registry.portfolioCapture.createdPath = projectBefore;
    registry.portfolioCapture.terminalResult = {
      type: 'file-created',
      path: projectBefore,
      indexed: false,
      status: 'applied',
    };

    registry.renamePath(projectBefore, projectAfter);

    expect(registry.portfolioBoard).toMatchObject({
      focusedKey: projectAfter,
      columns: {
        active: { firstKey: projectAfter, focusedKey: projectAfter, firstIndex: 3 },
      },
    });
    expect(registry.portfolioTimeline).toMatchObject({
      firstKey: `project:${projectAfter}`,
      focusedKey: `project:${projectAfter}`,
      focusedInteraction: { itemKey: `project:${projectAfter}`, role: 'range' },
    });
    expect(registry.portfolioCapture).toMatchObject({
      createdPath: projectAfter,
      terminalResult: { path: projectAfter, indexed: false, status: 'applied' },
    });

    const noteBefore = 'Work Notes/Before.md';
    const noteAfter = 'Work Notes/After.md';
    registry.portfolioTimeline.firstKey = `work-note:${noteBefore}`;
    registry.portfolioTimeline.focusedKey = `work-note:${noteBefore}`;
    registry.portfolioTimeline.focusedInteraction = {
      itemKey: `work-note:${noteBefore}`,
      role: 'start',
    };

    registry.renamePath(noteBefore, noteAfter);

    expect(registry.portfolioTimeline).toMatchObject({
      firstKey: `work-note:${noteAfter}`,
      focusedKey: `work-note:${noteAfter}`,
      focusedInteraction: { itemKey: `work-note:${noteAfter}`, role: 'start' },
    });
  });
});
