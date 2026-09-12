import { describe, expect, it, vi } from 'vitest';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  SAVED_VIEW_STATE_SCHEMA_VERSION,
  STATIC_SAVED_VIEW_STATE_MARKER,
  SettingsPersistenceCoordinator,
  type SettingsPersistencePort,
} from '../src/settings/persistence';
import priorSerializerFixture from './fixtures/settings-persistence/cc84b5d-property-definitions-roundtrip.json';
import { expectDefined } from './helpers';

const STATE_PATH = '.test-config/plugins/abyss-tasks/state.json';

function legacySettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign(
    structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>,
    overrides,
  );
}

interface MemoryPort extends SettingsPersistencePort {
  staticData: unknown;
  stateText: string | undefined;
  writes: string[];
}

function memoryPort(staticData: unknown, state: unknown): MemoryPort {
  const port: MemoryPort = {
    staticData: structuredClone(staticData),
    stateText: state === undefined ? undefined : JSON.stringify(state),
    writes: [],
    loadStatic: vi.fn(async () => structuredClone(port.staticData)),
    saveStatic: vi.fn(async (data: unknown) => {
      port.writes.push('data.json');
      port.staticData = structuredClone(data);
    }),
    state: {
      path: STATE_PATH,
      exists: vi.fn(async () => port.stateText !== undefined),
      read: vi.fn(async () => {
        if (port.stateText === undefined) throw new Error('missing state');
        return port.stateText;
      }),
      write: vi.fn(async (_path: string, data: string) => {
        port.writes.push(STATE_PATH);
        port.stateText = data;
      }),
    },
  };
  return port;
}

function markedStatic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data = legacySettings(overrides);
  delete data['listViewStates'];
  delete data['sectionCollapse'];
  const projects = data['projects'] as Record<string, unknown>;
  delete projects['table'];
  data[STATIC_SAVED_VIEW_STATE_MARKER] = SAVED_VIEW_STATE_SCHEMA_VERSION;
  return data;
}

function stateEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION,
    views: {
      listViewStates: {},
      sectionCollapse: { pinned: false, projects: false, tags: false },
      projects: { table: structuredClone(DEFAULT_SETTINGS.projects.table) },
      ...overrides,
    },
  };
}

describe('SettingsPersistenceCoordinator migration', () => {
  it('loads a legacy version-1 envelope without initializing Kanban preferences', async () => {
    const port = memoryPort(markedStatic(), stateEnvelope());
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    await coordinator.saveViewState(loaded.settings);

    expect(loaded.settings.projects.kanban).toBeUndefined();
    expect(loaded.settings.projects.overviewView).toBeUndefined();
    const saved = JSON.parse(port.stateText ?? '') as {
      schemaVersion: number;
      views: { projects: Record<string, unknown> };
    };
    expect(saved.schemaVersion).toBe(1);
    expect(saved.views.projects).not.toHaveProperty('kanban');
    expect(saved.views.projects).not.toHaveProperty('overviewView');
  });

  it('roundtrips initialized Kanban preferences and unknown nested keys', async () => {
    const kanban = buildDefaultProjectKanbanSettings(DEFAULT_SETTINGS.projects.table);
    kanban.fields = [{ id: 'start', visible: true }];
    const state = stateEnvelope({
      projects: {
        table: structuredClone(DEFAULT_SETTINGS.projects.table),
        overviewView: 'kanban',
        kanban: {
          ...kanban,
          futureBoardOption: { retained: true },
          fields: [{ ...kanban.fields[0], futureFieldOption: 'keep' }],
          sortBy: { ...kanban.sortBy, futureSortOption: 7 },
        },
      },
    });
    const port = memoryPort(markedStatic(), state);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    expect(loaded.settings.projects.overviewView).toBe('kanban');
    expect(loaded.settings.projects.kanban).toEqual(kanban);
    if (loaded.settings.projects.kanban === undefined) throw new Error('Expected Kanban state.');
    loaded.settings.projects.kanban.descriptionLines = 'full';
    await coordinator.saveViewState(loaded.settings);

    const saved = JSON.parse(port.stateText ?? '') as {
      views: {
        projects: {
          overviewView: string;
          kanban: Record<string, unknown> & {
            fields: Array<Record<string, unknown>>;
            sortBy: Record<string, unknown>;
          };
        };
      };
    };
    expect(saved.views.projects.overviewView).toBe('kanban');
    expect(saved.views.projects.kanban).toMatchObject({
      descriptionLines: 'full',
      futureBoardOption: { retained: true },
    });
    expect(saved.views.projects.kanban.fields[0]).toEqual({
      id: 'start',
      visible: true,
      futureFieldOption: 'keep',
    });
    expect(saved.views.projects.kanban.sortBy).toEqual({
      field: 'start',
      dir: 'asc',
      futureSortOption: 7,
    });

    const reloaded = await new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS);
    expect(reloaded.settings.projects.kanban?.descriptionLines).toBe('full');
  });

  it('moves legacy static Kanban preferences into version-1 view state', async () => {
    const raw = legacySettings();
    const projects = raw['projects'] as Record<string, unknown>;
    projects['overviewView'] = 'kanban';
    projects['kanban'] = buildDefaultProjectKanbanSettings(DEFAULT_SETTINGS.projects.table);
    const port = memoryPort(raw, undefined);

    const loaded = await new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS);

    expect(loaded.settings.projects.overviewView).toBe('kanban');
    expect(loaded.settings.projects.kanban).toEqual(
      buildDefaultProjectKanbanSettings(DEFAULT_SETTINGS.projects.table),
    );
    expect((port.staticData as { projects: Record<string, unknown> }).projects).not.toHaveProperty(
      'kanban',
    );
    const saved = JSON.parse(port.stateText ?? '') as {
      schemaVersion: number;
      views: { projects: Record<string, unknown> };
    };
    expect(saved.schemaVersion).toBe(1);
    expect(saved.views.projects).toMatchObject({ overviewView: 'kanban', kanban: {} });
  });

  it('retains malformed Kanban payloads in recovery while using safe runtime values', async () => {
    const malformedKanban = {
      fields: [null, { id: 'start', visible: 'yes', future: 'keep' }],
      showEmptyFields: 'sometimes',
      descriptionLines: 7,
      progress: 'circle',
      showEmptyProgress: null,
      emptyColumns: 'hidden',
      groupBy: 42,
      sortBy: { field: 42, dir: 'sideways' },
      hiddenStatuses: ['id:done', 9],
      collapsedColumns: 'planned',
      manualOrder: { 'id:planned': 'not paths' },
    };
    const state = stateEnvelope({
      projects: {
        table: structuredClone(DEFAULT_SETTINGS.projects.table),
        overviewView: 'cards',
        kanban: malformedKanban,
      },
    });
    const port = memoryPort(markedStatic(), state);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    await coordinator.saveViewState(loaded.settings);

    expect(loaded.notices).toContain(
      'Saved view preferences contained invalid values. Safe defaults were used and the original values were retained for recovery.',
    );
    expect(loaded.settings.projects.overviewView).toBeUndefined();
    expect(loaded.settings.projects.kanban).toEqual({
      ...buildDefaultProjectKanbanSettings(DEFAULT_SETTINGS.projects.table),
      fields: [{ id: 'start', visible: true }],
      hiddenStatuses: ['id:done'],
    });
    const saved = JSON.parse(port.stateText ?? '') as {
      recovery: {
        malformedViews: {
          projectKanban: unknown;
          projectOverviewView: unknown;
        };
      };
    };
    expect(saved.recovery.malformedViews.projectKanban).toEqual(malformedKanban);
    expect(saved.recovery.malformedViews.projectOverviewView).toBe('cards');
  });

  it('loads column alignment and removes its saved key when reset to left', async () => {
    const state = stateEnvelope();
    const views = state['views'] as Record<string, unknown>;
    const projects = views['projects'] as Record<string, unknown>;
    const table = projects['table'] as Record<string, unknown>;
    const columns = table['columns'] as Array<Record<string, unknown>>;
    const status = expectDefined(columns.find(({ id }) => id === 'status'));
    status['alignment'] = 'center';
    status['futureColumnOption'] = 'keep';
    const port = memoryPort(markedStatic(), state);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    const loadedStatus = expectDefined(
      loaded.settings.projects.table.columns.find(({ id }) => id === 'status'),
    );
    expect(loadedStatus.alignment).toBe('center');
    delete loadedStatus.alignment;
    await coordinator.saveViewState(loaded.settings);

    const saved = JSON.parse(port.stateText ?? '') as {
      views: { projects: { table: { columns: Array<Record<string, unknown>> } } };
    };
    expect(
      expectDefined(saved.views.projects.table.columns.find(({ id }) => id === 'status')),
    ).toEqual({ id: 'status', visible: true, futureColumnOption: 'keep' });
  });

  it('roundtrips the old relative date display and preserves a missing Pretty default', async () => {
    const state = stateEnvelope();
    const views = state['views'] as Record<string, unknown>;
    const projects = views['projects'] as Record<string, unknown>;
    const table = projects['table'] as Record<string, unknown>;
    const columns = table['columns'] as Array<Record<string, unknown>>;
    const start = expectDefined(columns.find(({ id }) => id === 'start'));
    start['dateDisplay'] = 'relative';
    start['futureColumnOption'] = 'keep';
    const port = memoryPort(markedStatic(), state);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    const loadedStart = expectDefined(
      loaded.settings.projects.table.columns.find(({ id }) => id === 'start'),
    );
    expect(loadedStart.dateDisplay).toBe('relative');
    delete loadedStart.dateDisplay;
    await coordinator.saveViewState(loaded.settings);

    const saved = JSON.parse(port.stateText ?? '') as {
      views: { projects: { table: { columns: Array<Record<string, unknown>> } } };
    };
    expect(
      expectDefined(saved.views.projects.table.columns.find(({ id }) => id === 'start')),
    ).toEqual({ id: 'start', visible: true, futureColumnOption: 'keep' });
  });

  it('roundtrips explicit Pretty and Raw modes for table columns and Kanban fields', async () => {
    const table = structuredClone(DEFAULT_SETTINGS.projects.table) as unknown as Record<
      string,
      unknown
    >;
    const columns = table['columns'] as Array<Record<string, unknown>>;
    expectDefined(columns.find(({ id }) => id === 'start'))['dateDisplay'] = 'pretty';
    expectDefined(columns.find(({ id }) => id === 'end'))['dateDisplay'] = 'raw';
    const kanban = buildDefaultProjectKanbanSettings(DEFAULT_SETTINGS.projects.table);
    const state = stateEnvelope({
      projects: {
        table,
        kanban: {
          ...kanban,
          fields: [
            { id: 'start', visible: true, dateDisplay: 'raw' },
            { id: 'end', visible: true, dateDisplay: 'pretty' },
          ],
        },
      },
    });
    const port = memoryPort(markedStatic(), state);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);

    expect(loaded.settings.projects.table.columns.find(({ id }) => id === 'start')).toMatchObject({
      dateDisplay: 'pretty',
    });
    expect(loaded.settings.projects.table.columns.find(({ id }) => id === 'end')).toMatchObject({
      dateDisplay: 'raw',
    });
    expect(loaded.settings.projects.kanban?.fields).toEqual([
      { id: 'start', visible: true, dateDisplay: 'raw' },
      { id: 'end', visible: true, dateDisplay: 'pretty' },
    ]);
    await coordinator.saveViewState(loaded.settings);

    const saved = JSON.parse(port.stateText ?? '') as {
      views: {
        projects: {
          table: { columns: Array<Record<string, unknown>> };
          kanban: { fields: Array<Record<string, unknown>> };
        };
      };
    };
    expect(saved.views.projects.table.columns.find(({ id }) => id === 'start')).toMatchObject({
      dateDisplay: 'pretty',
    });
    expect(saved.views.projects.table.columns.find(({ id }) => id === 'end')).toMatchObject({
      dateDisplay: 'raw',
    });
    expect(saved.views.projects.kanban.fields).toEqual([
      { id: 'start', visible: true, dateDisplay: 'raw' },
      { id: 'end', visible: true, dateDisplay: 'pretty' },
    ]);
  });

  it('loads extensions roundtripped by the cc84b5d serializer without losing raw values', async () => {
    expect(priorSerializerFixture.provenance.serializerCommit).toBe(
      'cc84b5d879d6085c505e12313ed5b073f43a5eb2',
    );
    const port = memoryPort(
      priorSerializerFixture.staticData,
      JSON.parse(priorSerializerFixture.stateText) as unknown,
    );
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    const loadedProjects = loaded.settings.projects as unknown as Record<string, unknown>;
    expect(loadedProjects['propertyDefinitions']).toEqual({
      'property:Effort': {
        type: 'text',
        presetsEnabled: true,
        presets: [
          {
            value: 'raw/value',
            displayName: 'Shown value',
            display: 'badge',
            color: '#123456',
            futurePresetOption: { exact: ['nested', 7] },
          },
        ],
        futureDefinitionOption: { exact: ['keep', { nested: true }] },
      },
    });
    expect(loadedProjects['statuses']).toEqual([
      {
        id: 'status-active-raw-01',
        name: 'in progress / raw',
        color: '#654321',
        onLeftPanel: true,
        displayName: 'In progress',
        display: 'text',
        futureStatusOption: { exact: ['keep', 9] },
      },
    ]);

    loaded.settings.taskPrefix = '#current-roundtrip';
    await coordinator.saveSettings(loaded.settings);

    const savedProjects = (port.staticData as Record<string, unknown>)['projects'] as Record<
      string,
      unknown
    >;
    expect(savedProjects['propertyDefinitions']).toEqual(loadedProjects['propertyDefinitions']);
    expect(savedProjects['statuses']).toEqual(loadedProjects['statuses']);
  });

  it('loads and saves dot presentations without changing status or preset order', async () => {
    const staticData = markedStatic();
    const projects = staticData['projects'] as Record<string, unknown>;
    const statuses = [
      { id: 'planned', name: 'planned', display: 'dot', onLeftPanel: true },
      { id: 'active', name: 'active', display: 'badge', onLeftPanel: false },
    ];
    const definitions = {
      'property:Priority': {
        type: 'text',
        presets: [
          { value: 'medium', display: 'dot' },
          { value: 'high', display: 'text' },
        ],
      },
    };
    projects['statuses'] = structuredClone(statuses);
    projects['defaultStatusId'] = 'planned';
    projects['propertyDefinitions'] = structuredClone(definitions);
    const port = memoryPort(staticData, stateEnvelope());
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);

    expect(loaded.notices).toEqual([]);
    expect(loaded.settings.projects.statuses).toEqual(statuses);
    expect(loaded.settings.projects.propertyDefinitions).toEqual(definitions);
    await coordinator.saveSettings(loaded.settings);
    const savedProjects = (port.staticData as Record<string, unknown>)['projects'] as Record<
      string,
      unknown
    >;
    expect(savedProjects['statuses']).toEqual(statuses);
    expect(savedProjects['propertyDefinitions']).toEqual(definitions);
  });

  it('partitions populated legacy view state, verifies it, then removes it from static data', async () => {
    const originalRawData = legacySettings({
      taskPrefix: '#custom',
      listViewStates: {
        today: {
          groupBy: 'priority',
          sortBy: { field: 'title', dir: 'desc' },
          filters: [],
          show: 'completed',
          pluginExtra: { retained: true },
        },
      },
      sectionCollapse: { pinned: true, projects: false, tags: true },
      unknownStatic: { retained: true },
    });
    const projects = originalRawData['projects'] as Record<string, unknown>;
    projects['staticExtra'] = 'keep';
    projects['statusMigration'] = { issue: 'retained-evidence' };
    const table = projects['table'] as Record<string, unknown>;
    table['futureTableOption'] = 7;
    const columns = table['columns'] as Array<Record<string, unknown>>;
    const firstColumn = columns[0];
    if (firstColumn === undefined) throw new Error('Expected the default Name column.');
    firstColumn['label'] = 'Project title';
    firstColumn['width'] = 222;
    firstColumn['futureColumnOption'] = 'keep';
    const endColumn = columns.find((column) => column['id'] === 'end');
    if (endColumn === undefined) throw new Error('Expected the default End column.');
    table['columns'] = [
      firstColumn,
      endColumn,
      ...columns.slice(1).filter((column) => column !== endColumn),
    ];
    const port = memoryPort(originalRawData, undefined);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);

    expect(loaded.settings.taskPrefix).toBe('#custom');
    expect(loaded.settings.listViewStates?.['today']?.statusGroups).toEqual(['done', 'cancelled']);
    expect(loaded.settings.sectionCollapse).toEqual({ pinned: true, projects: false, tags: true });
    expect(loaded.settings.projects.table.columns.slice(0, 2)).toMatchObject([
      { id: 'name', label: 'Project title', width: 222 },
      { id: 'end' },
    ]);
    expect(port.writes).toEqual([STATE_PATH, 'data.json']);
    const stateRead = port.state.read;
    expect(stateRead).toHaveBeenCalledWith(STATE_PATH);
    const savedState = JSON.parse(port.stateText ?? '') as Record<string, unknown>;
    expect(savedState['recovery']).toEqual({ preSplitData: originalRawData });
    expect(savedState).toMatchObject({
      schemaVersion: 1,
      views: {
        listViewStates: { today: { pluginExtra: { retained: true } } },
        projects: {
          table: {
            futureTableOption: 7,
          },
        },
      },
    });
    const savedColumns = (
      ((savedState['views'] as Record<string, unknown>)['projects'] as Record<string, unknown>)[
        'table'
      ] as Record<string, unknown>
    )['columns'] as Array<Record<string, unknown>>;
    expect(savedColumns[0]).toMatchObject({ id: 'name', futureColumnOption: 'keep' });
    const staticData = port.staticData as Record<string, unknown>;
    expect(staticData['listViewStates']).toBeUndefined();
    expect(staticData['sectionCollapse']).toBeUndefined();
    expect((staticData['projects'] as Record<string, unknown>)['table']).toBeUndefined();
    expect(staticData['unknownStatic']).toEqual({ retained: true });
    expect((staticData['projects'] as Record<string, unknown>)['staticExtra']).toBe('keep');
    expect((staticData['projects'] as Record<string, unknown>)['statusMigration']).toEqual({
      issue: 'retained-evidence',
    });
    expect(staticData[STATIC_SAVED_VIEW_STATE_MARKER]).toBe(1);
  });

  it('uses recognized state instead of stale legacy fields and retries static cleanup', async () => {
    const raw = legacySettings({
      listViewStates: {
        today: {
          groupBy: 'tag',
          sortBy: { field: 'tag', dir: 'asc' },
          filters: [],
        },
      },
      sectionCollapse: { pinned: true, projects: true, tags: true },
    });
    const port = memoryPort(
      raw,
      stateEnvelope({
        listViewStates: {
          today: {
            groupBy: 'status',
            sortBy: { field: 'status', dir: 'desc' },
            filters: [],
          },
        },
        sectionCollapse: { pinned: false, projects: false, tags: false },
      }),
    );

    const loaded = await new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS);

    expect(loaded.settings.listViewStates?.['today']?.groupBy).toBe('status');
    expect(loaded.settings.sectionCollapse).toEqual({
      pinned: false,
      projects: false,
      tags: false,
    });
    expect(port.writes).toEqual(['data.json']);
  });

  it('uses fresh view defaults when state is missing after the static marker', async () => {
    const staleLegacy = markedStatic({
      listViewStates: {
        today: {
          groupBy: 'tag',
          sortBy: { field: 'tag', dir: 'asc' },
          filters: [],
        },
      },
      sectionCollapse: { pinned: true, projects: true, tags: true },
    });
    const port = memoryPort(staleLegacy, undefined);

    const loaded = await new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS);

    expect(loaded.settings.listViewStates).toBeUndefined();
    expect(loaded.settings.sectionCollapse).toEqual(DEFAULT_SETTINGS.sectionCollapse);
    expect(loaded.settings.projects.table).toEqual(DEFAULT_SETTINGS.projects.table);
    expect(port.writes).toEqual([]);
  });

  it.each([
    ['corrupt', '{bad json'],
    ['future', JSON.stringify({ schemaVersion: 99, views: {} })],
  ])('preserves %s state bytes and suspends state writes', async (_label, stateText) => {
    const port = memoryPort(markedStatic(), undefined);
    port.stateText = stateText;
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    loaded.settings.sectionCollapse.tags = true;

    expect(loaded.issues).toHaveLength(1);
    await expect(coordinator.saveViewState(loaded.settings)).rejects.toThrow(/suspended/u);
    loaded.settings.taskPrefix = '#static-still-writable';
    await expect(coordinator.saveSettings(loaded.settings)).resolves.toBeUndefined();
    expect(port.stateText).toBe(stateText);
    expect((port.staticData as Record<string, unknown>)['taskPrefix']).toBe(
      '#static-still-writable',
    );
    expect(port.writes).toEqual(['data.json']);
  });

  it('treats an adapter read failure as unreadable state rather than absence', async () => {
    const port = memoryPort(markedStatic(), stateEnvelope());
    port.state.read = vi.fn().mockRejectedValue(new Error('permission denied'));
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);

    expect(loaded.issues[0]?.message).toMatch(/read saved view state/u);
    await expect(coordinator.saveViewState(loaded.settings)).rejects.toThrow(/suspended/u);
    expect(port.writes).toEqual([]);
  });

  it.each(['corrupt', 'future', 'read'] as const)(
    'preserves unmarked legacy views when %s state is unavailable during a later static save',
    async (failure) => {
      const legacy = legacySettings({
        taskPrefix: '#before',
        listViewStates: {
          today: {
            groupBy: 'tag',
            sortBy: { field: 'title', dir: 'desc' },
            filters: [],
            futureListOption: 'retain',
          },
        },
        sectionCollapse: { pinned: true, projects: false, tags: true },
      });
      const legacyProjects = legacy['projects'] as Record<string, unknown>;
      const legacyTable = legacyProjects['table'] as Record<string, unknown>;
      legacyTable['futureTableOption'] = { retain: true };
      const original = structuredClone(legacy);
      const port = memoryPort(legacy, stateEnvelope());
      if (failure === 'corrupt') port.stateText = '{bad json';
      if (failure === 'future') {
        port.stateText = JSON.stringify({ schemaVersion: 99, views: {} });
      }
      if (failure === 'read') {
        port.state.read = vi.fn().mockRejectedValue(new Error('permission denied'));
      }
      const originalStateText = port.stateText;
      const coordinator = new SettingsPersistenceCoordinator(port);

      const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
      loaded.settings.taskPrefix = '#after';
      await coordinator.saveSettings(loaded.settings);

      const saved = port.staticData as Record<string, unknown>;
      expect(saved['taskPrefix']).toBe('#after');
      expect(saved['listViewStates']).toEqual(original['listViewStates']);
      expect(saved['sectionCollapse']).toEqual(original['sectionCollapse']);
      expect((saved['projects'] as Record<string, unknown>)['table']).toEqual(
        (original['projects'] as Record<string, unknown>)['table'],
      );
      expect(saved).not.toHaveProperty(STATIC_SAVED_VIEW_STATE_MARKER);
      expect(port.stateText).toBe(originalStateText);
      expect(port.writes).toEqual(['data.json']);
    },
  );

  it('does not overwrite unreadable static settings with defaults', async () => {
    const port = memoryPort(undefined, undefined);
    port.loadStatic = vi.fn().mockRejectedValue(new Error('invalid data.json'));

    await expect(
      new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS),
    ).rejects.toThrow(/read static plugin settings/u);

    const saveStatic = port.saveStatic;
    const stateWrite = port.state.write;
    expect(saveStatic).not.toHaveBeenCalled();
    expect(stateWrite).not.toHaveBeenCalled();
  });

  it.each(['write', 'verify'] as const)(
    'leaves legacy static data untouched when the initial state %s fails',
    async (failure) => {
      const originalRawData = legacySettings({
        listViewStates: {
          inbox: {
            groupBy: 'none',
            sortBy: { field: 'date', dir: 'asc' },
            filters: [],
          },
        },
      });
      const port = memoryPort(originalRawData, undefined);
      if (failure === 'write') {
        port.state.write = vi.fn().mockRejectedValue(new Error('disk full'));
      } else {
        port.state.read = vi.fn(async () => '{"different":true}');
      }

      await expect(
        new SettingsPersistenceCoordinator(port).loadSettings(DEFAULT_SETTINGS),
      ).rejects.toThrow(failure === 'write' ? /disk full/u : /verify/u);

      expect(port.staticData).toEqual(originalRawData);
      const saveStatic = port.saveStatic;
      expect(saveStatic).not.toHaveBeenCalled();
    },
  );

  it('keeps malformed nested entries in recovery while loading safe defaults', async () => {
    const malformedState = stateEnvelope({
      listViewStates: {
        today: 'broken',
        upcoming: {
          groupBy: 42,
          sortBy: { field: 'when', dir: 'sideways' },
          filters: 'broken filters',
        },
      },
      sectionCollapse: 'broken collapse',
      projects: {
        table: {
          ...structuredClone(DEFAULT_SETTINGS.projects.table),
          showDescription: 'sometimes',
          sortBy: { field: 42, dir: 'sideways' },
          columns: [null, { id: 'name', visible: 'yes', width: -5, future: 'keep' }],
        },
      },
    });
    const port = memoryPort(markedStatic(), malformedState);
    const coordinator = new SettingsPersistenceCoordinator(port);

    const loaded = await coordinator.loadSettings(DEFAULT_SETTINGS);
    await coordinator.saveViewState(loaded.settings);

    expect(loaded.notices).toContain(
      'Saved view preferences contained invalid values. Safe defaults were used and the original values were retained for recovery.',
    );
    expect(loaded.settings.listViewStates).toEqual({});
    expect(loaded.settings.projects.table.columns[0]?.id).toBe('name');
    expect(loaded.settings.projects.table.showDescription).toBe(true);
    const saved = JSON.parse(port.stateText ?? '') as {
      recovery: unknown;
      views: { projects: { table: { columns: unknown[] } } };
    };
    expect(saved).toMatchObject({
      recovery: {
        malformedViews: {
          listViewStates: {
            today: 'broken',
            upcoming: {
              groupBy: 42,
              sortBy: { field: 'when', dir: 'sideways' },
              filters: 'broken filters',
            },
          },
          sectionCollapse: 'broken collapse',
          projectTableColumns: [null, { id: 'name', visible: 'yes', width: -5, future: 'keep' }],
        },
      },
    });
    const recovery = saved.recovery as {
      malformedViews: { projectTable: Record<string, unknown> };
    };
    expect(recovery.malformedViews.projectTable).toMatchObject({
      showDescription: 'sometimes',
      sortBy: { field: 42, dir: 'sideways' },
    });
    expect(
      (
        JSON.parse(port.stateText ?? '') as {
          views: { projects: { table: { showDescription: unknown } } };
        }
      ).views.projects.table.showDescription,
    ).toBe(true);
    expect(saved.views.projects.table.columns).not.toContain(null);
    expect(saved.views.projects.table.columns[0]).toMatchObject({ id: 'name', future: 'keep' });
  });
});

describe('SettingsPersistenceCoordinator write queue', () => {
  it('captures detached state snapshots and writes concurrent revisions in order', async () => {
    const port = memoryPort(markedStatic(), stateEnvelope());
    const coordinator = new SettingsPersistenceCoordinator(port);
    const { settings } = await coordinator.loadSettings(DEFAULT_SETTINGS);
    const written: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    Object.assign(port.state, {
      write: vi.fn(async (_path: string, data: string) => {
        written.push(data);
        if (written.length === 1) await firstGate;
        port.stateText = data;
      }),
    });

    settings.projects.table.groupBy = 'start';
    const first = coordinator.saveViewState(settings);
    settings.projects.table.groupBy = 'end';
    const second = coordinator.saveViewState(settings);
    await Promise.resolve();

    expect(written).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(
      written.map(
        (text) =>
          (JSON.parse(text) as { views: { projects: { table: { groupBy: string } } } }).views
            .projects.table.groupBy,
      ),
    ).toEqual(['start', 'end']);
  });

  it('deduplicates unchanged documents and lets a later write run after rejection', async () => {
    const port = memoryPort(markedStatic(), stateEnvelope());
    const coordinator = new SettingsPersistenceCoordinator(port);
    const { settings } = await coordinator.loadSettings(DEFAULT_SETTINGS);

    await coordinator.saveViewState(settings);
    const initialStateWrite = port.state.write;
    expect(initialStateWrite).not.toHaveBeenCalled();

    port.state.write = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async (_path: string, data: string) => {
        port.stateText = data;
      });
    settings.sectionCollapse.tags = true;
    await expect(coordinator.saveViewState(settings)).rejects.toThrow('transient');
    settings.sectionCollapse.projects = true;
    await expect(coordinator.saveViewState(settings)).resolves.toBeUndefined();
    const retryingStateWrite = port.state.write;
    expect(retryingStateWrite).toHaveBeenCalledTimes(2);
  });

  it('keeps static bytes unchanged for state-only saves and omits view fields from static saves', async () => {
    const port = memoryPort(markedStatic({ taskPrefix: '#before' }), stateEnvelope());
    const coordinator = new SettingsPersistenceCoordinator(port);
    const { settings } = await coordinator.loadSettings(DEFAULT_SETTINGS);
    const staticBeforeViewChange = structuredClone(port.staticData);

    settings.projects.table.hiddenStatuses.push('done');
    await coordinator.saveViewState(settings);
    const staticAfterViewChange = structuredClone(port.staticData);

    expect(staticAfterViewChange).toEqual(staticBeforeViewChange);
    const saveStatic = port.saveStatic;
    expect(saveStatic).not.toHaveBeenCalled();

    settings.taskPrefix = '#after';
    await coordinator.saveSettings(settings);
    const savedStatic = port.staticData as Record<string, unknown>;
    expect(savedStatic['taskPrefix']).toBe('#after');
    expect(savedStatic['listViewStates']).toBeUndefined();
    expect(savedStatic['sectionCollapse']).toBeUndefined();
    expect((savedStatic['projects'] as Record<string, unknown>)['table']).toBeUndefined();
  });
});
