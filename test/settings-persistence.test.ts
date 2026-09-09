import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  SAVED_VIEW_STATE_SCHEMA_VERSION,
  STATIC_SAVED_VIEW_STATE_MARKER,
  SettingsPersistenceCoordinator,
  type SettingsPersistencePort,
} from '../src/settings/persistence';

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
      sortBy: { field: 42, dir: 'sideways' },
    });
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
