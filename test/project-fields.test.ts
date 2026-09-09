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
    settings.statusProperty = 'Статус';
    settings.startProperty = 'Начало';
    settings.endProperty = 'Конец';
    const properties: readonly ProjectPropertyInfo[] = [
      { name: 'Начало', type: 'date' },
      { name: 'КОНЕЦ', type: 'date' },
      { name: 'СТАТУС', type: 'text' },
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
      'property:Tags',
      'property:Budget',
    ]);
    expect(fields.find(({ id }) => id === 'start')).toMatchObject({
      property: 'Начало',
      type: 'date',
    });
    expect(fields.find(({ id }) => id === 'end')).toMatchObject({
      property: 'КОНЕЦ',
      type: 'date',
    });
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

  it('marks a curated date source unavailable when its native type conflicts', () => {
    const settings = buildDefaultProjectsSettings();
    settings.startProperty = 'Budget';

    const fields = buildProjectFieldCatalog(settings, [{ name: 'Budget', type: 'number' }]);

    expect(fields.find(({ id }) => id === 'start')).toEqual({
      id: 'start',
      property: 'Budget',
      label: 'Start',
      type: null,
    });
  });

  it('enables absent curated dates after successful discovery', () => {
    const fields = buildProjectFieldCatalog(buildDefaultProjectsSettings(), []);

    expect(fields.find(({ id }) => id === 'start')?.type).toBe('date');
    expect(fields.find(({ id }) => id === 'end')?.type).toBe('date');
  });

  it('keeps curated dates unavailable when native discovery is unavailable', () => {
    const fields = buildProjectFieldCatalog(buildDefaultProjectsSettings(), null);

    expect(fields.find(({ id }) => id === 'start')?.type).toBeNull();
    expect(fields.find(({ id }) => id === 'end')?.type).toBeNull();
  });

  it.each([null, 'text', 'datetime'] as const)(
    'keeps an existing curated source with native type %s unavailable',
    (type) => {
      const fields = buildProjectFieldCatalog(buildDefaultProjectsSettings(), [
        { name: 'Start', type },
      ]);

      expect(fields.find(({ id }) => id === 'start')).toMatchObject({
        property: 'Start',
        type: null,
      });
    },
  );
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

    expect(result.columns[1]).toEqual({
      id: 'property:ActualKey',
      label: 'Friendly name',
      width: 280,
      visible: false,
    });
    expect(result.columns.map(({ id }) => id)).toEqual([
      'name',
      'property:ActualKey',
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
