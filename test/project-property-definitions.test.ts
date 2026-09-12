import { describe, expect, it, vi } from 'vitest';
import { initializeProjectPropertyDefinitions } from '../src/projects/initializeProjectPropertyDefinitions';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import {
  captureMissingProjectPropertyDefinitions,
  hasMalformedProjectPropertyDefinitionPresentation,
  projectPresetPresentation,
  projectPropertyTypeChoices,
  resolveConfiguredProjectField,
  setProjectPropertyDefinitionType,
} from '../src/projects/projectPropertyDefinitions';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import { migrateSettings } from '../src/settings/migration';

function catalog(properties: ReturnType<ProjectPropertyCatalog['list']>): ProjectPropertyCatalog {
  return {
    list: () => properties,
    inspect: () => ({ kind: 'unavailable' }),
    values: () => [],
    onChange: () => () => {},
  };
}

function assignedCatalog(property: string, type: 'text' | 'number'): ProjectPropertyCatalog {
  return {
    list: () => [],
    inspect: (candidate) =>
      candidate === property
        ? {
            kind: 'available',
            property: undefined,
            assignment: { kind: 'assigned', nativeType: type, type },
          }
        : { kind: 'available', property: undefined, assignment: { kind: 'none' } },
    values: () => [],
    onChange: () => () => {},
  };
}

describe('project property definitions', () => {
  it('shares editable type choices while keeping the tags source fixed', () => {
    expect(projectPropertyTypeChoices('Priority')).toEqual([
      'text',
      'list',
      'number',
      'checkbox',
      'date',
      'datetime',
    ]);
    expect(projectPropertyTypeChoices('TAGS')).toEqual(['tags']);
  });

  it('changes one uniquely matched definition while preserving spelling and preset data', () => {
    const projects = buildDefaultProjectsSettings();
    projects.propertyDefinitions['property:Priority'] = {
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: 'high', displayName: 'High' }],
    };

    expect(setProjectPropertyDefinitionType(projects, 'property:priority', 'number')).toBe(true);
    expect(projects.propertyDefinitions).toEqual({
      'property:Priority': {
        type: 'number',
        presetsEnabled: true,
        presets: [{ value: 'high', displayName: 'High' }],
      },
    });
  });

  it('refuses ambiguous case-colliding definitions and fixed tags', () => {
    const projects = buildDefaultProjectsSettings();
    projects.propertyDefinitions = {
      'property:Priority': { type: 'text' },
      'property:PRIORITY': { type: 'number' },
      'property:Tags': { type: 'tags' },
    };

    expect(setProjectPropertyDefinitionType(projects, 'property:priority', 'date')).toBe(false);
    expect(setProjectPropertyDefinitionType(projects, 'property:Tags', 'text')).toBe(false);
  });
  it('resolves curated fields from configured sources without consulting native types', () => {
    const projects = buildDefaultProjectsSettings();
    projects.startProperty = 'Begins';

    expect(resolveConfiguredProjectField(projects, 'start')).toEqual({
      id: 'start',
      property: 'Begins',
      label: 'Start',
      type: 'date',
    });
  });

  it('uses a case-insensitive definition while preserving the requested field spelling', () => {
    const projects = buildDefaultProjectsSettings();
    projects.propertyDefinitions = { 'property:Effort': { type: 'text' } };

    expect(resolveConfiguredProjectField(projects, 'property:EFFORT')).toEqual({
      id: 'property:EFFORT',
      property: 'EFFORT',
      label: 'EFFORT',
      type: 'text',
    });
  });

  it('keeps ambiguous and invalid configured definitions unavailable', () => {
    const projects = buildDefaultProjectsSettings();
    projects.propertyDefinitions = {
      'property:Effort': { type: 'text' },
      'PROPERTY:effort': { type: 'number' },
      'property:Phase': { type: 'tags' },
    };

    expect(resolveConfiguredProjectField(projects, 'property:effort')).toMatchObject({
      property: 'effort',
      type: null,
    });
    expect(resolveConfiguredProjectField(projects, 'property:Phase')).toMatchObject({
      property: 'Phase',
      type: null,
    });
  });

  it('does not resolve custom definitions that reuse curated physical sources', () => {
    const projects = buildDefaultProjectsSettings();
    projects.propertyDefinitions = {
      'property:STATUS': { type: 'text' },
      'property:START': { type: 'date' },
    };

    expect(resolveConfiguredProjectField(projects, 'property:STATUS')).toMatchObject({
      type: null,
    });
    expect(resolveConfiguredProjectField(projects, 'property:START')).toMatchObject({ type: null });
  });

  it('retains a custom definition while its source is curated and restores it after rebinding', () => {
    const projects = buildDefaultProjectsSettings();
    projects.startProperty = 'Effort';
    projects.propertyDefinitions = {
      'property:Effort': {
        type: 'text',
        presetsEnabled: true,
        presets: [{ value: 'high', displayName: 'High effort' }],
      },
    };
    const raw = { projects: structuredClone(projects) };

    const migration = migrateSettings(raw);
    const loaded = raw.projects;
    expect(migration.notices).not.toContain(
      'Some project property definitions could not be loaded. Repair or remove the conflicting definitions in Projects settings; their original values were preserved.',
    );
    expect(resolveConfiguredProjectField(loaded, 'property:Effort')?.type).toBeNull();
    loaded.startProperty = 'start';
    expect(resolveConfiguredProjectField(loaded, 'property:Effort')).toMatchObject({
      type: 'text',
    });
    expect(loaded.propertyDefinitions['property:Effort']?.presets).toEqual([
      { value: 'high', displayName: 'High effort' },
    ]);
  });

  it('preserves a saved false legacy flag and unknown preset payload through migration', () => {
    const definition = {
      type: 'text',
      presetsEnabled: false,
      presets: [
        {
          value: 'high',
          displayName: 'High effort',
          futurePresetOption: { exact: ['nested', 7] },
        },
      ],
      futureDefinitionOption: { exact: ['keep', { nested: true }] },
    };
    const raw = {
      projects: { propertyDefinitions: { 'property:Effort': structuredClone(definition) } },
    };

    const migration = migrateSettings(raw);

    expect(raw.projects.propertyDefinitions['property:Effort']).toEqual(definition);
    expect(migration.notices).toEqual([]);
  });

  it('loads dot status and custom presentations without rewriting their order', () => {
    const statuses = [
      { id: 'planned', name: 'planned', display: 'dot', onLeftPanel: true },
      { id: 'active', name: 'active', display: 'text', onLeftPanel: false },
    ];
    const presets = [
      { value: 'medium', display: 'dot' },
      { value: 'high', display: 'badge' },
    ];
    const raw = {
      projects: {
        statuses: structuredClone(statuses),
        propertyDefinitions: {
          'property:Priority': { type: 'text', presets: structuredClone(presets) },
        },
      },
    };

    const migration = migrateSettings(raw);

    expect(raw.projects.statuses).toEqual(statuses);
    expect(raw.projects.propertyDefinitions['property:Priority'].presets).toEqual(presets);
    expect(migration.notices).toEqual([]);
  });

  it('ignores the obsolete flag when checking presentation data for repair', () => {
    expect(
      hasMalformedProjectPropertyDefinitionPresentation({
        type: 'text',
        presetsEnabled: 'obsolete',
        presets: [{ value: 'high', displayName: 'High' }],
      }),
    ).toBe(false);
    expect(
      hasMalformedProjectPropertyDefinitionPresentation({
        type: 'text',
        presetsEnabled: 'obsolete',
        presets: [{ value: 'high', displayName: 7 }],
      }),
    ).toBe(true);
  });

  it('returns presentation only for an exact raw preset value', () => {
    const presets = [
      { value: '1', displayName: 'String one', color: '#123456', display: 'badge' as const },
      { value: 1, displayName: 'Number one', display: 'text' as const },
    ];

    expect(projectPresetPresentation(presets, 1)).toEqual({
      displayName: 'Number one',
      display: 'text',
    });
    expect(projectPresetPresentation(presets, true)).toBeUndefined();
  });
});

describe('captureMissingProjectPropertyDefinitions', () => {
  it('captures custom fields referenced only by initialized Kanban settings', () => {
    const projects = buildDefaultProjectsSettings();
    projects.kanban = {
      fields: [{ id: 'property:Effort', visible: true }],
      showEmptyFields: false,
      descriptionLines: 1,
      progress: 'full',
      showEmptyProgress: false,
      emptyColumns: 'compact',
      groupBy: 'property:Owner',
      sortBy: { field: 'property:Rank', dir: 'asc' },
      hiddenStatuses: [],
      collapsedColumns: [],
      manualOrder: {},
    };

    expect(
      captureMissingProjectPropertyDefinitions(
        projects,
        catalog([
          { name: 'Effort', type: 'number' },
          { name: 'Owner', type: 'list' },
          { name: 'Rank', type: 'date' },
        ]),
      ),
    ).toEqual({
      'property:Effort': { type: 'number' },
      'property:Owner': { type: 'list' },
      'property:Rank': { type: 'date' },
    });
  });

  it('captures custom columns plus hidden grouping and sorting fields once', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });
    projects.table.groupBy = 'property:Hidden group';
    projects.table.sortBy = { field: 'property:Hidden sort', dir: 'asc' };
    projects.propertyDefinitions = { 'property:Effort': { type: 'text' } };

    expect(
      captureMissingProjectPropertyDefinitions(
        projects,
        catalog([
          { name: 'Effort', type: 'number' },
          { name: 'Hidden group', type: 'list' },
          { name: 'Hidden sort', type: 'date' },
        ]),
      ),
    ).toEqual({
      'property:Hidden group': { type: 'list' },
      'property:Hidden sort': { type: 'date' },
    });
  });

  it('does not guess when discovery is unavailable, unsupported, or ambiguous', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push(
      { id: 'property:Unknown', visible: true },
      { id: 'property:Duplicate', visible: true },
    );

    expect(captureMissingProjectPropertyDefinitions(projects, catalog(null))).toEqual({});
    expect(
      captureMissingProjectPropertyDefinitions(
        projects,
        catalog([
          { name: 'Unknown', type: null },
          { name: 'Duplicate', type: 'text' },
          { name: 'duplicate', type: 'number' },
        ]),
      ),
    ).toEqual({});
  });

  it('captures an explicit supported native assignment even when the property has no values', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });

    expect(
      captureMissingProjectPropertyDefinitions(projects, assignedCatalog('Effort', 'number')),
    ).toEqual({ 'property:Effort': { type: 'number' } });
  });

  it('does not recapture an existing malformed definition', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });
    projects.propertyDefinitions = {
      'property:Effort': { type: 'bogus' },
    } as never;

    expect(
      captureMissingProjectPropertyDefinitions(
        projects,
        catalog([{ name: 'Effort', type: 'number' }]),
      ),
    ).toEqual({});
  });

  it('does not recapture over malformed root recovery evidence', () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });
    Object.assign(projects, {
      propertyDefinitions: {},
      propertyDefinitionMigration: {
        issue: 'invalid-property-definitions',
        propertyDefinitions: ['exact malformed root'],
        invalidKeys: [],
        ambiguousKeys: [],
      },
    });

    expect(
      captureMissingProjectPropertyDefinitions(
        projects,
        catalog([{ name: 'Effort', type: 'number' }]),
      ),
    ).toEqual({});
  });

  it('merges captured types before awaiting persistence and never replaces later edits', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });
    let release: (() => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const pending = initializeProjectPropertyDefinitions({
      projects,
      catalog: catalog([{ name: 'Effort', type: 'text' }]),
      save,
    });
    expect(projects.propertyDefinitions).toEqual({ 'property:Effort': { type: 'text' } });
    projects.propertyDefinitions['property:Effort'] = { type: 'number' };
    release?.();
    await pending;

    expect(projects.propertyDefinitions).toEqual({ 'property:Effort': { type: 'number' } });
    expect(save).toHaveBeenCalledOnce();
  });

  it('retains the synchronously captured draft when persistence rejects', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.table.columns.push({ id: 'property:Effort', visible: true });

    await expect(
      initializeProjectPropertyDefinitions({
        projects,
        catalog: catalog([{ name: 'Effort', type: 'text' }]),
        save: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    ).rejects.toThrow('disk full');

    expect(projects.propertyDefinitions).toEqual({ 'property:Effort': { type: 'text' } });
  });
});
