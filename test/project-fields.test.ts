import { describe, expect, it } from 'vitest';
import {
  buildProjectFieldCatalog,
  projectFieldValue,
  type ProjectPropertyInfo,
} from '../src/projects/projectFields';
import { normalizeProjectTableSettings } from '../src/projects/projectTableSettings';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';

describe('buildProjectFieldCatalog', () => {
  it('preserves vault property spelling while suppressing curated and status-carrier aliases', () => {
    const settings = buildDefaultProjectsSettings();
    settings.statuses.push({
      id: 'tagged',
      label: 'Tagged',
      onLeftPanel: false,
      match: { kind: 'tag', tag: '#project/tagged' },
    });
    const properties: readonly ProjectPropertyInfo[] = [
      { name: 'Start', type: 'date' },
      { name: 'END', type: 'date' },
      { name: 'STATUS', type: 'text' },
      { name: 'Tags', type: 'tags' },
      { name: 'Budget', type: 'number' },
      { name: 'budget', type: 'number' },
    ];

    const fields = buildProjectFieldCatalog(settings, properties);

    expect(fields.map(({ id }) => id)).toEqual([
      'name',
      'status',
      'progress',
      'start',
      'end',
      'property:Budget',
    ]);
    expect(fields.find(({ id }) => id === 'start')).toMatchObject({
      property: 'Start',
      type: 'date',
    });
    expect(fields.find(({ id }) => id === 'end')).toMatchObject({ property: 'END', type: 'date' });
  });

  it('keeps unsupported vault properties visible as unavailable', () => {
    const fields = buildProjectFieldCatalog(buildDefaultProjectsSettings(), [
      { name: 'Formula result', type: null },
    ]);

    expect(fields[fields.length - 1]).toEqual({
      id: 'property:Formula result',
      property: 'Formula result',
      label: 'Formula result',
      type: null,
    });
  });

  it('keeps saved custom columns visible as unavailable when the vault catalog is missing', () => {
    const settings = buildDefaultProjectsSettings();
    settings.table.columns.push({
      id: 'property:Legacy Key',
      label: 'Friendly label',
      width: 210,
      visible: false,
    });

    const fields = buildProjectFieldCatalog(settings, []);

    expect(fields.find(({ id }) => id === 'property:Legacy Key')).toEqual({
      id: 'property:Legacy Key',
      property: 'Legacy Key',
      label: 'Legacy Key',
      type: null,
    });
  });
});

describe('projectFieldValue', () => {
  it('matches frontmatter keys case-insensitively', () => {
    expect(
      projectFieldValue(
        {
          path: 'Projects/A.md',
          name: 'A',
          frontmatter: { BUDGET: 12 },
          tags: [],
          statusId: null,
          rawStatus: null,
          stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
        },
        { id: 'property:Budget', property: 'Budget', label: 'Budget', type: 'number' },
      ),
    ).toBe(12);
  });
});

describe('normalizeProjectTableSettings', () => {
  it('retains a renamed custom column source key, order, visibility and width', () => {
    const result = normalizeProjectTableSettings({
      columns: [
        {
          id: 'property:ActualKey',
          label: 'Friendly name',
          width: 280,
          visible: false,
        },
        { id: 'name', visible: true },
      ],
      groupBy: 'property:ActualKey',
      sortBy: { field: 'property:ActualKey', dir: 'desc' },
      hiddenStatuses: ['id:done'],
    });

    expect(result.columns[0]).toEqual({
      id: 'property:ActualKey',
      label: 'Friendly name',
      width: 280,
      visible: false,
    });
    expect(result.columns.map(({ id }) => id)).toEqual([
      'property:ActualKey',
      'name',
      'status',
      'progress',
      'start',
      'end',
    ]);
    expect(result.groupBy).toBe('property:ActualKey');
    expect(result.sortBy).toEqual({ field: 'property:ActualKey', dir: 'desc' });
    expect(result.hiddenStatuses).toEqual(['id:done']);
  });
});
