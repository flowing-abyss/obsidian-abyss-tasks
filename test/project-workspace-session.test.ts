import { describe, expect, it } from 'vitest';
import { ProjectWorkspaceSessionRegistry } from '../src/panels/projects/ProjectWorkspaceSession';
import type { ProjectTasksViewState } from '../src/settings/types';

const taskDefault: ProjectTasksViewState = {
  groupBy: 'none',
  sortBy: { field: 'date', dir: 'asc' },
  filters: [],
};

describe('ProjectWorkspaceSessionRegistry', () => {
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

  it('uses an override only when the current scope has one and exposes use-as-default intent', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/A.md');
    const tasks = registry.scopeSession('tasks');
    const override = { ...taskDefault, groupBy: 'priority' as const };

    expect(tasks.effectiveView(taskDefault)).toBe(taskDefault);
    tasks.viewOverride = override;
    expect(tasks.effectiveView(taskDefault)).toBe(override);
    expect(registry.consumeUseAsDefaultIntent()).toBeNull();

    registry.requestUseAsDefault('tasks');
    expect(registry.consumeUseAsDefaultIntent()).toEqual({ scope: 'tasks', viewState: override });
    expect(registry.consumeUseAsDefaultIntent()).toBeNull();
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

  it('makes live source state authoritative on rename collisions while reconciling safe arrays source-first', () => {
    const registry = new ProjectWorkspaceSessionRegistry();
    registry.openProject('Projects/Source.md');
    registry.scopeSession('tasks').textQuery = 'source';
    registry.scopeSession('tasks').viewOverride = {
      ...taskDefault,
      filters: [{ type: 'status', value: 'todo' }],
    };
    registry.openProject('Projects/Destination.md');
    registry.scopeSession('tasks').textQuery = 'destination';
    registry.scopeSession('tasks').viewOverride = {
      ...taskDefault,
      filters: [
        { type: 'tag', value: 'me' },
        { type: 'status', value: 'todo' },
      ],
    };
    registry.openProject('Projects/Source.md');

    registry.renameProject('Projects/Source.md', 'Projects/Destination.md');
    registry.openProject('Projects/Destination.md');

    expect(registry.scopeSession('tasks').textQuery).toBe('source');
    expect(registry.scopeSession('tasks').viewOverride).toMatchObject({
      filters: [
        { type: 'status', value: 'todo' },
        { type: 'tag', value: 'me' },
      ],
    });
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
});
