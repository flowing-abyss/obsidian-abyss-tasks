// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../src/settings/types';
import {
  type NotePathChange,
  noteDeleteChange,
  noteRenameChange,
  rebaseSavedNotePath,
  renameFileFilters,
} from '../src/settings/viewStatePaths';

function listState(filters: PropertyFilter[] = []): ListViewState {
  return { groupBy: 'none', sortBy: { field: 'date', dir: 'asc' }, filters };
}

function settingsWith(saved: {
  readonly manualOrder?: Record<string, string[]>;
  readonly listViewStates?: Record<string, ListViewState>;
}): CalendarSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (saved.manualOrder !== undefined) {
    settings.projects.kanban = {
      ...buildDefaultProjectKanbanSettings(settings.projects.table),
      manualOrder: saved.manualOrder,
    };
  }
  if (saved.listViewStates !== undefined) settings.listViewStates = saved.listViewStates;
  return settings;
}

describe('rebaseSavedNotePath', () => {
  it('creates no saved view state for a note change', () => {
    const settings = settingsWith({});

    expect(rebaseSavedNotePath(settings, { type: 'deleted', path: 'Projects/A.md' })).toBe(false);
    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Projects/A.md',
        path: 'Projects/B.md',
      }),
    ).toBe(false);
    expect(settings.projects.kanban).toBeUndefined();
    expect(settings.listViewStates).toBeUndefined();
  });

  it("forgets a deleted note's ranks and list state and keeps file filters that name it", () => {
    const today = listState([{ type: 'file', filePath: 'Projects/A.md' }]);
    const settings = settingsWith({
      manualOrder: { 'id:active': ['Projects/A.md', 'Projects/B.md'] },
      listViewStates: { 'project:Projects/A.md': listState(), today },
    });

    expect(rebaseSavedNotePath(settings, { type: 'deleted', path: 'Projects/A.md' })).toBe(true);

    expect(settings.projects.kanban?.manualOrder).toEqual({ 'id:active': ['Projects/B.md'] });
    expect(settings.listViewStates).toEqual({ today });
    expect(settings.listViewStates?.['today']).toBe(today);
  });

  it("moves a renamed note's list state over a stale destination and rewrites file filters", () => {
    const moved = listState();
    const settings = settingsWith({
      manualOrder: { 'id:active': ['Projects/B.md', 'Projects/A.md'] },
      listViewStates: {
        'project:Projects/A.md': moved,
        'project:Projects/New.md': listState([{ type: 'tag', value: '#stale' }]),
        today: listState([
          { type: 'tag', value: '#a' },
          { type: 'file', filePath: 'Projects/A.md', note: 'kept' } as PropertyFilter,
        ]),
      },
    });

    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Projects/A.md',
        path: 'Projects/New.md',
      }),
    ).toBe(true);

    expect(settings.projects.kanban?.manualOrder).toEqual({
      'id:active': ['Projects/B.md', 'Projects/New.md'],
    });
    expect(settings.listViewStates).toEqual({
      'project:Projects/New.md': moved,
      today: listState([
        { type: 'tag', value: '#a' },
        { type: 'file', filePath: 'Projects/New.md', note: 'kept' } as PropertyFilter,
      ]),
    });
    expect(settings.listViewStates?.['project:Projects/New.md']).toBe(moved);
  });

  it('changes and replaces nothing for a path no saved state names', () => {
    const manualOrder = { 'id:active': ['Projects/A.md'] };
    const today = listState([{ type: 'file', filePath: 'Notes/Other.md' }]);
    const listViewStates = { 'project:Projects/A.md': listState(), today };
    const settings = settingsWith({ manualOrder, listViewStates });

    expect(rebaseSavedNotePath(settings, { type: 'deleted', path: 'Projects/Z.md' })).toBe(false);
    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Projects/Z.md',
        path: 'Projects/Y.md',
      }),
    ).toBe(false);

    expect(settings.projects.kanban?.manualOrder).toBe(manualOrder);
    expect(settings.listViewStates).toBe(listViewStates);
    expect(settings.listViewStates?.['today']).toBe(today);
  });

  it('reports a change that touches only ranks or only list state', () => {
    const deleted: NotePathChange = { type: 'deleted', path: 'Projects/A.md' };
    const renamed: NotePathChange = {
      type: 'renamed',
      oldPath: 'Projects/A.md',
      path: 'Projects/New.md',
    };

    const ranksOnly = settingsWith({
      manualOrder: { 'id:active': ['Projects/B.md', 'Projects/A.md'] },
    });
    expect(rebaseSavedNotePath(ranksOnly, renamed)).toBe(true);
    expect(ranksOnly.projects.kanban?.manualOrder).toEqual({
      'id:active': ['Projects/B.md', 'Projects/New.md'],
    });
    expect(ranksOnly.listViewStates).toBeUndefined();

    const stateToForget = settingsWith({
      listViewStates: { 'project:Projects/A.md': listState() },
    });
    expect(rebaseSavedNotePath(stateToForget, deleted)).toBe(true);
    expect(stateToForget.listViewStates).toEqual({});
    expect(stateToForget.projects.kanban).toBeUndefined();

    const moved = listState();
    const stateToMove = settingsWith({ listViewStates: { 'project:Projects/A.md': moved } });
    expect(rebaseSavedNotePath(stateToMove, renamed)).toBe(true);
    expect(stateToMove.listViewStates).toEqual({ 'project:Projects/New.md': moved });
    expect(stateToMove.listViewStates?.['project:Projects/New.md']).toBe(moved);

    const filterOnly = settingsWith({
      listViewStates: { today: listState([{ type: 'file', filePath: 'Projects/A.md' }]) },
    });
    expect(rebaseSavedNotePath(filterOnly, renamed)).toBe(true);
    expect(filterOnly.listViewStates).toEqual({
      today: listState([{ type: 'file', filePath: 'Projects/New.md' }]),
    });
  });

  it('removes a stale destination state when the renamed note had none', () => {
    const settings = settingsWith({
      listViewStates: { 'project:Projects/New.md': listState([{ type: 'tag', value: '#stale' }]) },
    });

    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Projects/A.md',
        path: 'Projects/New.md',
      }),
    ).toBe(true);

    expect(settings.listViewStates).toEqual({});
  });

  it('changes nothing for a rename to the same path', () => {
    const manualOrder = { 'id:active': ['Projects/A.md'] };
    const projectState = listState();
    const today = listState([{ type: 'file', filePath: 'Projects/A.md' }]);
    const listViewStates = { 'project:Projects/A.md': projectState, today };
    const settings = settingsWith({ manualOrder, listViewStates });

    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Projects/A.md',
        path: 'Projects/A.md',
      }),
    ).toBe(false);

    expect(settings.projects.kanban?.manualOrder).toBe(manualOrder);
    expect(settings.listViewStates).toBe(listViewStates);
    expect(settings.listViewStates?.['project:Projects/A.md']).toBe(projectState);
    expect(settings.listViewStates?.['today']).toBe(today);
  });
});

describe('renameFileFilters', () => {
  it('returns undefined when no file filter names the old path', () => {
    expect(
      renameFileFilters(listState([{ type: 'tag', value: '#a' }]), 'Notes/Old.md', 'Notes/New.md'),
    ).toBeUndefined();
  });

  it('keeps the filter order and collapses a duplicate file filter into the first', () => {
    const oldFilter = { type: 'file', filePath: 'Notes/Old.md' } satisfies PropertyFilter;
    const state = listState([
      oldFilter,
      { type: 'tag', value: '#a' },
      { type: 'file', filePath: 'Notes/New.md' },
      { type: 'status', value: 'x' },
    ]);

    expect(renameFileFilters(state, 'Notes/Old.md', 'Notes/New.md')?.filters).toEqual([
      { type: 'file', filePath: 'Notes/New.md' },
      { type: 'tag', value: '#a' },
      { type: 'status', value: 'x' },
    ]);
    expect(oldFilter.filePath).toBe('Notes/Old.md');
    expect(state.filters).toHaveLength(4);
    expect(state.filters[0]).toBe(oldFilter);
  });

  it('keeps status groups and an unknown saved key when a rename rewrites a file filter', () => {
    const saved: ListViewState & { readonly unknownKey: string } = {
      ...listState([{ type: 'file', filePath: 'Notes/Old.md' }]),
      statusGroups: ['todo', 'done'],
      unknownKey: 'kept',
    };
    const renamed = { ...saved, filters: [{ type: 'file', filePath: 'Notes/New.md' }] };
    const settings = settingsWith({ listViewStates: { today: saved } });

    expect(renameFileFilters(saved, 'Notes/Old.md', 'Notes/New.md')).toEqual(renamed);
    expect(
      rebaseSavedNotePath(settings, {
        type: 'renamed',
        oldPath: 'Notes/Old.md',
        path: 'Notes/New.md',
      }),
    ).toBe(true);
    expect(settings.listViewStates).toEqual({ today: renamed });
  });
});

describe('note path changes', () => {
  it('treats only a Markdown delete as a note delete', () => {
    expect(noteDeleteChange('Projects/A.md', 'md')).toEqual({
      type: 'deleted',
      path: 'Projects/A.md',
    });
    expect(noteDeleteChange('Projects/image.png', 'png')).toBeUndefined();
    expect(noteDeleteChange('Projects/A.MD', 'MD')).toBeUndefined();
  });

  it('classifies a rename by its old and new extensions, as the task index does', () => {
    expect(noteRenameChange('Projects/A.md', 'Projects/B.md', 'md')).toEqual({
      type: 'renamed',
      oldPath: 'Projects/A.md',
      path: 'Projects/B.md',
    });
    expect(noteRenameChange('Projects/A.md', 'Projects/A.txt', 'txt')).toEqual({
      type: 'deleted',
      path: 'Projects/A.md',
    });
    expect(noteRenameChange('Projects/A.txt', 'Projects/A.md', 'md')).toBeUndefined();
    expect(noteRenameChange('Projects/A.MD', 'Projects/B.MD', 'MD')).toBeUndefined();
  });
});
