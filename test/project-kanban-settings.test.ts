import { describe, expect, it } from 'vitest';
import type { ProjectTableSettings } from '../src/projects/projectFields';
import {
  buildDefaultProjectKanbanSettings,
  normalizeProjectKanbanSettings,
} from '../src/projects/projectKanbanSettings';

function table(): ProjectTableSettings {
  return {
    columns: [
      { id: 'name', visible: true },
      { id: 'start', label: 'Begins', visible: false, dateDisplay: 'relative' },
      { id: 'end', visible: true },
    ],
    showDescription: false,
    groupBy: 'property:Owner',
    sortBy: { field: 'property:Priority', dir: 'desc' },
    hiddenStatuses: ['id:done'],
  };
}

describe('project Kanban settings', () => {
  it('initializes independent board defaults from the current table filters and ordering', () => {
    const source = table();
    const board = buildDefaultProjectKanbanSettings(source);

    expect(board).toEqual({
      fields: [
        { id: 'start', visible: true },
        { id: 'end', visible: true },
      ],
      showEmptyFields: false,
      descriptionLines: 1,
      progress: 'full',
      showEmptyProgress: false,
      emptyColumns: 'compact',
      groupBy: 'property:Owner',
      sortBy: { field: 'property:Priority', dir: 'desc' },
      hiddenStatuses: ['id:done'],
      collapsedColumns: [],
      manualOrder: {},
    });

    board.sortBy.field = 'name';
    board.hiddenStatuses.push('id:planned');
    expect(source.sortBy).toEqual({ field: 'property:Priority', dir: 'desc' });
    expect(source.hiddenStatuses).toEqual(['id:done']);
  });

  it('normalizes known values without adding optional card fields the user removed', () => {
    const result = normalizeProjectKanbanSettings(
      {
        fields: [
          { id: 'property:Owner', visible: false, label: 'Lead', alignment: 'center' },
          null,
          { id: '', visible: true },
        ],
        showEmptyFields: true,
        descriptionLines: 2,
        progress: 'bar',
        showEmptyProgress: true,
        emptyColumns: 'expanded',
        groupBy: 'none',
        sortBy: { field: 'none', dir: 'asc' },
        hiddenStatuses: ['id:done', 42],
        collapsedColumns: ['id:planned', 'id:planned', false],
        manualOrder: {
          'id:planned': ['Projects/B.md', 'Projects/A.md', 'Projects/B.md', 42],
          broken: 'not an array',
        },
      },
      table(),
    );

    expect(result).toEqual({
      fields: [{ id: 'property:Owner', visible: false, label: 'Lead', alignment: 'center' }],
      showEmptyFields: true,
      descriptionLines: 2,
      progress: 'bar',
      showEmptyProgress: true,
      emptyColumns: 'expanded',
      groupBy: 'none',
      sortBy: { field: 'none', dir: 'asc' },
      hiddenStatuses: ['id:done'],
      collapsedColumns: ['id:planned'],
      manualOrder: { 'id:planned': ['Projects/B.md', 'Projects/A.md'] },
    });
  });

  it('uses detached initialization defaults for malformed known values', () => {
    const source = table();
    const result = normalizeProjectKanbanSettings(
      {
        fields: 'broken',
        showEmptyFields: 'yes',
        descriptionLines: 3,
        progress: 'circle',
        showEmptyProgress: null,
        emptyColumns: 'hidden',
        groupBy: 42,
        sortBy: { field: 42, dir: 'sideways' },
        hiddenStatuses: 'done',
        collapsedColumns: {},
        manualOrder: [],
      },
      source,
    );

    expect(result).toEqual(buildDefaultProjectKanbanSettings(source));
    expect(result.sortBy).not.toBe(source.sortBy);
    expect(result.hiddenStatuses).not.toBe(source.hiddenStatuses);
  });
});
