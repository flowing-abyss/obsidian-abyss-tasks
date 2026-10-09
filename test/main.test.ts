import { App, Notice } from 'obsidian';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AppState } from '../src/app/AppState';
import TaskCalendarPlugin from '../src/main';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { DEFAULT_SETTINGS, buildDefaultProjectsSettings } from '../src/settings/defaults';
import {
  SAVED_VIEW_STATE_SCHEMA_VERSION,
  STATIC_SAVED_VIEW_STATE_MARKER,
  ViewStateWritesSuspendedError,
} from '../src/settings/persistence';
import { latestSettingsSaveRevision } from '../src/settings/settingsSaveRevision';
import type { TaskStorageSettings } from '../src/settings/taskStorageSettings';
import type { CalendarSettings } from '../src/settings/types';
import { taskNodeAddress, type TrackedEntry } from '../src/tasks';
import * as browserSearch from '../src/tasks/infrastructure/search/BrowserTaskSearchBackend';
import type { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import type { PanelNavigator } from '../src/views/panelNavigation';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import {
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  objectMatching,
  useRealMoment,
} from './helpers';

useRealMoment();

const MANIFEST = {
  id: 'abyss-tasks',
  name: 'Abyss Tasks',
  version: '1.0.0',
} as ConstructorParameters<typeof TaskCalendarPlugin>[1];

const STATE_PATH = '.test-config/plugins/abyss-tasks/state.json';

interface StateAdapterLike {
  readonly exists: Mock<(path: string) => Promise<boolean>>;
  readonly read: Mock<(path: string) => Promise<string>>;
  readonly write: Mock<(path: string, value: string) => Promise<void>>;
  readonly trashSystem: Mock<(path: string) => Promise<boolean>>;
  readonly rename: Mock<(from: string, to: string) => Promise<void>>;
}

function spyOnNotices() {
  return vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
    'constructor__',
  );
}

function noticeMessages(notices: ReturnType<typeof spyOnNotices>): unknown[] {
  return notices.mock.calls.map(([message]) => message);
}

interface WorkspaceLike {
  layoutReady: boolean;
  setLayoutReady__: () => void;
  getLeavesOfType: (type: string) => unknown[];
  getLeaf: (mode: unknown) => { setViewState: (state: unknown) => Promise<void> };
  revealLeaf: (leaf: unknown) => Promise<void> | void;
}

interface PluginLike {
  readonly search: TaskCalendarPlugin['search'];
  app: {
    workspace: WorkspaceLike;
    metadataCache: { trigger: (event: string, ...args: unknown[]) => void };
    vault: App['vault'];
    fileManager: App['fileManager'];
  };
  taskIndex: {
    initialize: () => Promise<void>;
    destroy: () => void;
    constructor: { name: string };
  };
  settings: CalendarSettings;
  data__: unknown;
  stateFiles__: Map<string, string>;
  stateAdapter__: StateAdapterLike;
  commands__: Map<string, { id: string; name: string }>;
  views__: Map<string, (...args: unknown[]) => unknown>;
  markdownCodeBlockProcessors__: Map<string, (...args: unknown[]) => unknown>;
  settingTabs__: unknown[];
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  onload: () => Promise<void>;
  registerView: (type: string, factory: unknown) => void;
  onunload: () => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  saveTaskStorageSettings: (draft: TaskStorageSettings) => Promise<void>;
  saveViewState: () => Promise<void>;
  saveViewStateWithNotice: () => Promise<void>;
  refreshProjectTableSettings: () => void;
  refreshProjectSettings: () => void;
  openPanel: () => Promise<void>;
}

function makePlugin(data: Record<string, unknown> | null = null): PluginLike {
  const app = new App();
  const workspace = app.workspace as unknown as WorkspaceLike;
  // Keep layout NOT ready so onLayoutReady queues callbacks (lets onload finish before initialize fires)
  workspace.layoutReady = false;
  const stateFiles = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => stateFiles.has(path)),
    read: vi.fn(async (path: string) => {
      const value = stateFiles.get(path);
      if (value === undefined) throw new Error(`Missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      stateFiles.set(path, value);
    }),
    trashSystem: vi.fn(async (path: string) => stateFiles.delete(path)),
    rename: vi.fn(async (from: string, to: string) => {
      const value = stateFiles.get(from);
      if (value === undefined) throw new Error(`Missing ${from}`);
      stateFiles.delete(from);
      stateFiles.set(to, value);
    }),
  };
  Object.assign(app.vault, { adapter, configDir: '.test-config' });

  const plugin = new TaskCalendarPlugin(app, MANIFEST) as unknown as PluginLike;
  // loadData() returns this.data__; seed it so loadSettings merges persisted values.
  plugin.data__ = data ?? {};
  plugin.stateFiles__ = stateFiles;
  plugin.stateAdapter__ = adapter;
  return plugin;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['renderCalendar'];
});

describe('TaskCalendarPlugin loadSettings', () => {
  it('merges DEFAULT_SETTINGS with persisted data (persisted overrides)', async () => {
    const plugin = makePlugin({ taskPrefix: '#custom' });
    await plugin.loadSettings();
    expect(plugin.settings.taskPrefix).toBe('#custom');
    expect(plugin.settings.taskFilePath).toBe(DEFAULT_SETTINGS.taskFilePath);
  });

  it('loadData returns empty object -> settings equal DEFAULT_SETTINGS', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    // With deterministic status ids, no reset needed
    const expectedDefaults: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      projects: buildDefaultProjectsSettings(),
    };
    expect(plugin.settings).toEqual(expectedDefaults);
  });

  it('loadSettings calls loadData exactly once', async () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'loadData');
    await plugin.loadSettings();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('loadSettings migrates old inboxMode/inboxTag to inbox object', async () => {
    const plugin = makePlugin({ inboxMode: 'tag', inboxTag: '#my/inbox' });
    await plugin.loadSettings();
    expect(plugin.settings.inbox.mode).toBe('tag');
    expect(plugin.settings.inbox.tag).toBe('#my/inbox');
    expect(plugin.settings).not.toHaveProperty('inboxMode');
    expect(plugin.settings).not.toHaveProperty('inboxTag');
  });

  it('migrates shortcuts before the shallow defaults merge and preserves extensions', async () => {
    const plugin = makePlugin({
      shortcuts: { openQuickCapture: '', openTasks: 42, unknownAction: 'Q' },
    });

    await plugin.loadSettings();

    expect(plugin.settings.shortcuts).toEqual({
      ...DEFAULT_SETTINGS.shortcuts,
      openQuickCapture: '',
      openTasks: 'L',
      unknownAction: 'Q',
    });
  });

  it('stores state beside the plugin using the configured vault directory fallback', async () => {
    const plugin = makePlugin();

    await plugin.loadSettings();

    expect(plugin.stateFiles__.has('.test-config/plugins/abyss-tasks/state.json')).toBe(true);
  });
});

describe('TaskCalendarPlugin saveSettings', () => {
  it('writes static settings without saved view fields', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const spy = vi.spyOn(plugin, 'saveData');
    plugin.settings.taskPrefix = '#changed';
    await plugin.saveSettings();
    expect(spy).toHaveBeenCalledOnce();
    const saved = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(saved['taskPrefix']).toBe(plugin.settings.taskPrefix);
    expect(saved['listViewStates']).toBeUndefined();
    expect(saved['sectionCollapse']).toBeUndefined();
    expect((saved['projects'] as Record<string, unknown>)['table']).toBeUndefined();
    expect(saved[STATIC_SAVED_VIEW_STATE_MARKER]).toBe(2);
  });

  it('saves one validated storage draft and rebuilds source exclusion after durability', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const refresh = vi.spyOn(
      plugin.taskIndex as unknown as {
        refreshSourceExclusion(predicate: unknown): Promise<void>;
      },
      'refreshSourceExclusion',
    );

    await plugin.saveTaskStorageSettings({
      taskArchivePath: 'archive/{{YYYY}}.md',
      taskIgnoreQuery: '#private',
    });

    expect(plugin.settings.taskArchivePath).toBe('archive/{{YYYY}}.md');
    expect(plugin.settings.taskIgnoreQuery).toBe('(#private) OR ("tasks/archive.md")');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('restores the prior storage settings and predicate when persistence rejects', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const refresh = vi.spyOn(
      plugin.taskIndex as unknown as {
        refreshSourceExclusion(predicate: unknown): Promise<void>;
      },
      'refreshSourceExclusion',
    );
    vi.spyOn(plugin, 'saveSettings').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      plugin.saveTaskStorageSettings({
        taskArchivePath: 'archive/new.md',
        taskIgnoreQuery: '#private',
      }),
    ).rejects.toThrow('disk full');

    expect(plugin.settings.taskArchivePath).toBe(DEFAULT_SETTINGS.taskArchivePath);
    expect(plugin.settings.taskIgnoreQuery).toBe(DEFAULT_SETTINGS.taskIgnoreQuery);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes project stores and table settings in open panel views after persistence', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const refreshProjectSettings = vi.fn();
    const view = Object.create(PanelView.prototype) as PanelView;
    view.refreshProjectSettings = refreshProjectSettings;
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }]);

    await plugin.saveSettings();

    expect(plugin.app.workspace.getLeavesOfType).toHaveBeenCalledWith(PANEL_VIEW_TYPE);
    expect(refreshProjectSettings).toHaveBeenCalledOnce();
  });

  it('leaves open panels to the caller when a static save fails', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const refreshProjectSettings = vi.fn();
    const view = Object.create(PanelView.prototype) as PanelView;
    view.refreshProjectSettings = refreshProjectSettings;
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }]);
    const error = new Error('disk full');
    vi.spyOn(plugin, 'saveData').mockRejectedValue(error);
    plugin.settings.taskPrefix = '#changed';

    await expect(plugin.saveSettings()).rejects.toBe(error);

    expect(refreshProjectSettings).not.toHaveBeenCalled();
  });

  it('saves view state without advancing static revision or refreshing every project panel', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const staticBefore = structuredClone(plugin.data__);
    const revisionBefore = latestSettingsSaveRevision(plugin.settings);
    const refreshProjectSettings = vi.fn();
    const view = Object.create(PanelView.prototype) as PanelView;
    view.refreshProjectSettings = refreshProjectSettings;
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }]);

    plugin.settings.sectionCollapse.tags = true;
    await plugin.saveViewState();

    expect(plugin.data__).toEqual(staticBefore);
    expect(latestSettingsSaveRevision(plugin.settings)).toBe(revisionBefore);
    expect(plugin.app.workspace.getLeavesOfType).not.toHaveBeenCalled();
    expect(refreshProjectSettings).not.toHaveBeenCalled();
  });

  it('keeps the plain view-state save silent and presents a failed panel write once', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const error = new Error('disk full');
    plugin.stateAdapter__.write.mockRejectedValue(error);
    const notices = spyOnNotices();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    plugin.settings.sectionCollapse.tags = true;

    await expect(plugin.saveViewState()).rejects.toBe(error);
    expect(notices).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    await expect(plugin.saveViewStateWithNotice()).rejects.toBe(error);
    expect(noticeMessages(notices)).toEqual([
      'Could not save view preferences. Your current session is unchanged.',
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] saved view state write failed',
      error,
    );
  });

  it('keeps the panel route silent after a suspended load and refuses plain writes by type', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = spyOnNotices();
    const plugin = makePlugin({
      [STATIC_SAVED_VIEW_STATE_MARKER]: SAVED_VIEW_STATE_SCHEMA_VERSION,
    });
    plugin.stateFiles__.set(STATE_PATH, JSON.stringify({ schemaVersion: 99, views: {} }));
    await plugin.loadSettings();
    expect(noticeMessages(notices)).toEqual([
      'Saved view state could not be loaded. View preferences are using temporary defaults; view preference writes are suspended to preserve the existing file.',
    ]);
    notices.mockClear();
    plugin.settings.sectionCollapse.tags = true;

    await expect(plugin.saveViewStateWithNotice()).resolves.toBeUndefined();
    expect(notices).not.toHaveBeenCalled();
    await expect(plugin.saveViewState()).rejects.toBeInstanceOf(ViewStateWritesSuspendedError);
    // Only the suspended load logs; neither write route adds a line.
    const unsupported = 'Saved view state uses unsupported future schema 99.';
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] saved view state is unavailable', {
      message: unsupported,
      cause: objectMatching<Error>({ name: 'Error', message: unsupported }),
    });
  });

  it('refreshes only mounted project-table projections when settings request it', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const refreshProjectTableSettings = vi.fn();
    const refreshProjectSettings = vi.fn();
    const view = Object.create(PanelView.prototype) as PanelView;
    view.refreshProjectTableSettings = refreshProjectTableSettings;
    view.refreshProjectSettings = refreshProjectSettings;
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }]);

    plugin.refreshProjectTableSettings();

    expect(plugin.app.workspace.getLeavesOfType).toHaveBeenCalledWith(PANEL_VIEW_TYPE);
    expect(refreshProjectTableSettings).toHaveBeenCalledOnce();
    expect(refreshProjectSettings).not.toHaveBeenCalled();
  });

  it('refreshes project settings in every open panel on request', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const refreshProjectTableSettings = vi.fn();
    const refreshProjectSettings = vi.fn();
    const view = Object.create(PanelView.prototype) as PanelView;
    view.refreshProjectTableSettings = refreshProjectTableSettings;
    view.refreshProjectSettings = refreshProjectSettings;
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }]);

    plugin.refreshProjectSettings();

    expect(plugin.app.workspace.getLeavesOfType).toHaveBeenCalledWith(PANEL_VIEW_TYPE);
    expect(refreshProjectSettings).toHaveBeenCalledOnce();
    expect(refreshProjectTableSettings).not.toHaveBeenCalled();
  });
});

describe('TaskCalendarPlugin onload', () => {
  it('captures configured custom column types before registering the panel', async () => {
    const projects = buildDefaultProjectsSettings();
    const table = structuredClone(projects.table);
    table.columns.push({ id: 'property:Effort', visible: true });
    delete (projects as unknown as Record<string, unknown>)['table'];
    const plugin = makePlugin({
      projects,
      [STATIC_SAVED_VIEW_STATE_MARKER]: SAVED_VIEW_STATE_SCHEMA_VERSION,
    });
    plugin.stateFiles__.set(
      '.test-config/plugins/abyss-tasks/state.json',
      JSON.stringify({
        schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION,
        views: {
          sectionCollapse: DEFAULT_SETTINGS.sectionCollapse,
          projects: { table },
        },
      }),
    );
    Object.defineProperty(plugin.app, 'metadataTypeManager', {
      configurable: true,
      value: {
        getAllProperties: () => ({ effort: { name: 'Effort' } }),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        getAssignedWidget: () => null,
        on: () => ({ id: 'property-capture' }),
        offref: () => {},
      },
    });
    const save = vi.spyOn(plugin, 'saveData').mockImplementation(async (data: unknown) => {
      const savedProjects = (data as { projects: Record<string, unknown> }).projects;
      if ('propertyDefinitions' in savedProjects) {
        expect(plugin.views__.has(PANEL_VIEW_TYPE)).toBe(false);
      }
      plugin.data__ = data;
    });

    await plugin.onload();

    expect(plugin.settings.projects.propertyDefinitions).toEqual({
      'property:Effort': { type: 'text' },
    });
    expect(save).toHaveBeenCalledOnce();
    expect(plugin.views__.has(PANEL_VIEW_TYPE)).toBe(true);
  });

  it('keeps a failed capture draft and retries the then-current settings', async () => {
    const projects = buildDefaultProjectsSettings();
    const table = structuredClone(projects.table);
    table.columns.push({ id: 'property:Effort', visible: true });
    delete (projects as unknown as Record<string, unknown>)['table'];
    const plugin = makePlugin({
      projects,
      [STATIC_SAVED_VIEW_STATE_MARKER]: SAVED_VIEW_STATE_SCHEMA_VERSION,
    });
    plugin.stateFiles__.set(
      '.test-config/plugins/abyss-tasks/state.json',
      JSON.stringify({
        schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION,
        views: {
          sectionCollapse: DEFAULT_SETTINGS.sectionCollapse,
          projects: { table },
        },
      }),
    );
    Object.defineProperty(plugin.app, 'metadataTypeManager', {
      configurable: true,
      value: {
        getAllProperties: () => ({ effort: { name: 'Effort' } }),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        getAssignedWidget: () => null,
        on: () => ({ id: 'property-capture' }),
        offref: () => {},
      },
    });
    const error = new Error('disk full');
    const save = vi
      .spyOn(plugin, 'saveData')
      .mockRejectedValueOnce(error)
      .mockImplementation(async (data: unknown) => {
        plugin.data__ = data;
      });
    let noticeContent: unknown;
    const notice = vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
      'constructor__',
    );
    notice.mockImplementation((message: unknown) => {
      noticeContent = message;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();

    expect(plugin.settings.projects.propertyDefinitions).toEqual({
      'property:Effort': { type: 'text' },
    });
    expect(notice).toHaveBeenCalledOnce();
    plugin.settings.projects.propertyDefinitions['property:Effort'] = { type: 'number' };
    const retry = (noticeContent as DocumentFragment).querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Retry');
    retry?.click();
    await flushMicrotasks();

    const saved = plugin.data__ as { projects: { propertyDefinitions: unknown } };
    expect(saved.projects.propertyDefinitions).toEqual({
      'property:Effort': { type: 'number' },
    });
    expect(save).toHaveBeenCalledTimes(2);
    // The successful retry adds no second log.
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not save captured project property types',
      { cause: error },
    );
  });

  it.each(['startup', 'layout', 'resolved'] as const)(
    'finalizes capture at available %s discovery and ignores later callbacks',
    async (phase) => {
      const projects = buildDefaultProjectsSettings();
      const table = structuredClone(projects.table);
      table.columns.push(
        { id: 'property:First', visible: false },
        { id: 'property:Second', visible: false },
      );
      delete (projects as unknown as Record<string, unknown>)['table'];
      const plugin = makePlugin({
        projects,
        [STATIC_SAVED_VIEW_STATE_MARKER]: SAVED_VIEW_STATE_SCHEMA_VERSION,
      });
      plugin.stateFiles__.set(
        '.test-config/plugins/abyss-tasks/state.json',
        JSON.stringify({
          schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION,
          views: {
            sectionCollapse: DEFAULT_SETTINGS.sectionCollapse,
            projects: { table },
          },
        }),
      );
      let names: string[] | null = phase === 'startup' ? [] : null;
      Object.defineProperty(plugin.app, 'metadataTypeManager', {
        configurable: true,
        value: {
          getAllProperties: () =>
            names === null
              ? null
              : Object.fromEntries(names.map((name) => [name.toLocaleLowerCase(), { name }])),
          getTypeInfo: (name: string) => ({
            expected: { type: name === 'First' ? 'text' : 'number' },
          }),
          getAssignedWidget: () => null,
          on: () => ({ id: 'property-capture' }),
          offref: () => {},
        },
      });

      await plugin.onload();
      expect(plugin.settings.projects.propertyDefinitionsVersion).toBe(
        phase === 'startup' ? 1 : undefined,
      );
      names = phase === 'resolved' ? null : ['First'];
      plugin.app.workspace.setLayoutReady__();
      await flushMicrotasks();
      expect(plugin.settings.projects.propertyDefinitions).toEqual(
        phase === 'layout' ? { 'property:First': { type: 'text' } } : {},
      );

      names = ['First', 'Second'];
      plugin.app.metadataCache.trigger('resolved');
      await flushMicrotasks();
      const captured = {
        startup: {},
        layout: { 'property:First': { type: 'text' } },
        resolved: { 'property:First': { type: 'text' }, 'property:Second': { type: 'number' } },
      }[phase];
      expect(plugin.settings.projects.propertyDefinitions).toEqual(captured);
      expect(plugin.settings.projects.propertyDefinitionsVersion).toBe(1);
      delete plugin.settings.projects.propertyDefinitions['property:First'];
      plugin.app.metadataCache.trigger('resolved');
      await flushMicrotasks();
      expect(plugin.settings.projects.propertyDefinitions['property:First']).toBeUndefined();
      expect(plugin.settings.projects.propertyDefinitionsVersion).toBe(1);
    },
  );

  it('constructs the shared TaskIndex', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.taskIndex).toBeDefined();
    expect(plugin.taskIndex.constructor.name).toBe('TaskIndex');
  });

  it('registers the panel view with PANEL_VIEW_TYPE', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.views__.get(PANEL_VIEW_TYPE)).toBeTypeOf('function');
  });

  it('does not register an embedded calendar processor', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.markdownCodeBlockProcessors__.size).toBe(0);
  });

  it('adds the open-panel command', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const cmd = plugin.commands__.get('open-panel');
    expect(cmd).toBeDefined();
    expect(cmd?.id).toBe('open-panel');
    expect(cmd?.name).toBe('Open view');
  });

  it('adds exactly one settings tab', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.settingTabs__).toHaveLength(1);
  });

  it('open-panel command callback invokes openPanel', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const spy = vi.spyOn(plugin, 'openPanel').mockResolvedValue(undefined);
    const cmd = plugin.commands__.get('open-panel');
    expect(cmd).toBeDefined();
    (cmd as unknown as { callback: () => void }).callback();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('invokes taskIndex.initialize via onLayoutReady', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const spy = vi.spyOn(plugin.taskIndex, 'initialize').mockResolvedValue(undefined);
    plugin.app.workspace.setLayoutReady__();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not install window.renderCalendar shim', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect((window as unknown as Record<string, unknown>)['renderCalendar']).toBeUndefined();
  });

  it('follows a note rename during the property capture before any panel exists', async () => {
    const projects = buildDefaultProjectsSettings();
    const table = structuredClone(projects.table);
    table.columns.push({ id: 'property:Effort', visible: true });
    delete (projects as unknown as Record<string, unknown>)['table'];
    const plugin = makePlugin({
      projects,
      [STATIC_SAVED_VIEW_STATE_MARKER]: SAVED_VIEW_STATE_SCHEMA_VERSION,
    });
    plugin.stateFiles__.set(
      STATE_PATH,
      JSON.stringify({
        schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION,
        views: {
          sectionCollapse: DEFAULT_SETTINGS.sectionCollapse,
          projects: {
            table,
            kanban: {
              ...buildDefaultProjectKanbanSettings(table),
              manualOrder: { 'raw:active': ['Projects/A.md'] },
            },
          },
        },
      }),
    );
    Object.defineProperty(plugin.app, 'metadataTypeManager', {
      configurable: true,
      value: {
        getAllProperties: () => ({ effort: { name: 'Effort' } }),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        getAssignedWidget: () => null,
        on: () => ({ id: 'property-capture' }),
        offref: () => {},
      },
    });
    const note = await plugin.app.vault.create('Projects/A.md', '---\nstatus: active\n---\n');
    const on = vi.spyOn(
      plugin.app.vault as unknown as {
        on(name: string, callback: (...args: unknown[]) => unknown): unknown;
      },
      'on',
    );
    const registerView = vi.spyOn(plugin, 'registerView');
    vi.spyOn(plugin, 'saveData').mockImplementation(async (data: unknown) => {
      plugin.data__ = data;
      await plugin.app.vault.rename(note, 'Projects/B.md');
    });

    try {
      await plugin.onload();

      expect(plugin.settings.projects.kanban?.manualOrder).toEqual({
        'raw:active': ['Projects/B.md'],
      });
      const listenerOrder = on.mock.calls
        .map(([name], index) => ({ name, order: on.mock.invocationCallOrder[index] ?? 0 }))
        .filter(({ name }) => name === 'delete' || name === 'rename')
        .map(({ order }) => order);
      expect(listenerOrder).toHaveLength(2);
      expect(Math.max(...listenerOrder)).toBeLessThan(
        expectDefined(registerView.mock.invocationCallOrder[0]),
      );
    } finally {
      plugin.onunload();
    }
  });

  it('writes a pending note change once through a view-state save', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const note = await plugin.app.vault.create('Projects/A.md', '');
    const kanban = {
      ...buildDefaultProjectKanbanSettings(plugin.settings.projects.table),
      manualOrder: { 'raw:active': ['Projects/A.md'] },
    };
    plugin.settings.projects.kanban = kanban;
    vi.useFakeTimers();
    try {
      const save = vi.spyOn(plugin, 'saveViewState');
      const stateWrites = (): number =>
        plugin.stateAdapter__.write.mock.calls.filter(([path]) => path === STATE_PATH).length;
      const writesBefore = stateWrites();

      await plugin.app.fileManager.trashFile(note);
      expect(kanban.manualOrder).toEqual({});
      await plugin.saveViewState();
      expect(stateWrites()).toBe(writesBefore + 1);
      await vi.advanceTimersByTimeAsync(150);

      expect(save).toHaveBeenCalledOnce();
      expect(stateWrites()).toBe(writesBefore + 1);
    } finally {
      vi.useRealTimers();
      plugin.onunload();
    }
  });

  it('starts a pending note change write at unload and leaves no timer behind', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const note = await plugin.app.vault.create('Projects/A.md', '');
    plugin.settings.projects.kanban = {
      ...buildDefaultProjectKanbanSettings(plugin.settings.projects.table),
      manualOrder: { 'raw:active': ['Projects/A.md'] },
    };
    vi.useFakeTimers();
    try {
      const save = vi.spyOn(plugin, 'saveViewState');
      await plugin.app.fileManager.trashFile(note);

      plugin.onunload();
      expect(save).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(150);
      expect(save).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TaskCalendarPlugin toggle-time-tracking command', () => {
  const DAY_MS = 86_400_000;
  const REF = { filePath: 'tasks.md', line: 0, revision: 'r1' } as const;

  function trackedEntry(overrides: Partial<TrackedEntry> = {}): TrackedEntry {
    return {
      filePath: REF.filePath,
      root: REF,
      target: { type: 'task', ref: REF },
      address: taskNodeAddress({ type: 'task', ref: REF }),
      rootAddress: taskNodeAddress({ type: 'task', ref: REF }),
      title: 'Alpha',
      status: 'open',
      entry: {
        state: 'closed',
        startMs: 1000,
        endMs: 2000,
        relativeLine: 1,
        originalMarkdown: '  - session',
      },
      ...overrides,
    };
  }

  async function trackingPlugin(tracking: {
    readonly active?: readonly TrackedEntry[];
    readonly recent?: readonly TrackedEntry[];
  }) {
    const plugin = makePlugin();
    await plugin.onload();
    const windows: Array<readonly [number, number]> = [];
    const execute = vi.fn(async () => ({ type: 'ok', outcome: { type: 'stopped' } }) as never);
    const typed = plugin as unknown as {
      queries: Record<string, unknown>;
      tasks: { execute: unknown; queries: unknown };
    };
    typed.queries = {
      ...typed.queries,
      activeEntries: () => tracking.active ?? [],
      entriesOverlapping: (fromMs: number, toMs: number) => {
        windows.push([fromMs, toMs]);
        return tracking.recent ?? [];
      },
    };
    typed.tasks = { ...typed.tasks, queries: typed.queries, execute };
    const notices: unknown[] = [];
    vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
      'constructor__',
    ).mockImplementation((message: unknown) => {
      notices.push(message);
    });
    const command = plugin.commands__.get('toggle-time-tracking');
    return {
      plugin,
      execute,
      notices,
      windows,
      command,
      run: async () => {
        await (command as unknown as { callback: () => Promise<void> }).callback();
        await flushMicrotasks();
      },
    };
  }

  it('is registered with its palette name', async () => {
    const harness = await trackingPlugin({});
    expect(harness.command?.id).toBe('toggle-time-tracking');
    expect(harness.command?.name).toBe('Pause or resume time tracking');
  });

  it('pauses whatever is running', async () => {
    const harness = await trackingPlugin({ active: [trackedEntry()] });

    await harness.run();

    expect(harness.execute).toHaveBeenCalledWith({ type: 'stop-tracking' });
    expect(harness.notices).toEqual([]);
  });

  it('resumes the most recent task of the last seven days', async () => {
    const harness = await trackingPlugin({ recent: [trackedEntry()] });

    await harness.run();

    expect(harness.execute).toHaveBeenCalledWith({
      type: 'start-tracking',
      parent: { type: 'task', ref: REF },
    });
    // The same window the rail widget groups, so the two never disagree about what is recent: seven
    // whole local days, both ends on a local midnight rather than on the instant of the keystroke.
    const [window] = harness.windows;
    expect(window).toBeDefined();
    const [fromMs, toMs] = window as [number, number];
    expect(toMs - fromMs).toBe(7 * DAY_MS);
    for (const edge of [fromMs, toMs]) {
      const local = new Date(edge);
      expect([
        local.getHours(),
        local.getMinutes(),
        local.getSeconds(),
        local.getMilliseconds(),
      ]).toEqual([0, 0, 0, 0]);
    }
    expect(harness.notices).toEqual([]);
  });

  it('refuses to resume a finished task', async () => {
    const harness = await trackingPlugin({ recent: [trackedEntry({ status: 'done' })] });

    await harness.run();

    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.notices).toEqual(['There is no recent task to resume']);
  });

  it('says so when nothing was tracked recently', async () => {
    const harness = await trackingPlugin({});

    await harness.run();

    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.notices).toEqual(['There is no recent task to resume']);
  });
});

describe('TaskCalendarPlugin onunload', () => {
  it('calls taskIndex.destroy exactly once', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const spy = vi.spyOn(plugin.taskIndex, 'destroy');
    plugin.onunload();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('TaskCalendarPlugin openPanel', () => {
  it('opens and reuses the registered panel, closes its surface on replacement, and detaches the leaf', async () => {
    const app = await createAppWithFiles({});
    // Obsidian installs the plugin directory before loading its entry point.
    await app.vault.adapter.mkdir(`${app.vault.configDir}/plugins/${MANIFEST.id}`);
    const errors = vi.spyOn(console, 'error');
    const warnings = vi.spyOn(console, 'warn');
    const plugin = new TaskCalendarPlugin(app, MANIFEST);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(null);
    const registerCommand = vi.spyOn(plugin, 'addCommand');
    await plugin.onload();
    const command = expectDefined(
      registerCommand.mock.calls.find(([entry]) => entry.id === 'open-panel')?.[0],
    );
    const openPanel = expectDefined(command.callback);
    try {
      await openPanel();
      const leaf = expectDefined(app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0]);
      const view = leaf.view;
      expect(view).toBeInstanceOf(PanelView);
      expect(
        view.containerEl.querySelector('.abyss-panel-view')?.childElementCount,
      ).toBeGreaterThan(0);
      await openPanel();
      expect(app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)).toEqual([leaf]);
      await leaf.setViewState({ type: 'empty' });
      expect(view.containerEl.querySelector('.abyss-panel-view')?.childElementCount).toBe(0);
      leaf.detach();
      await flushMicrotasks();
      expect(app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)).toEqual([]);
      expect(app.workspace.getLeavesOfType('empty')).not.toContain(leaf);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      plugin.onunload();
    }
  });

  it('reveals existing leaf without creating a new one', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const fakeLeaf = {};
    const workspace = plugin.app.workspace;
    workspace.getLeavesOfType = vi.fn(() => [fakeLeaf]);
    const revealSpy = vi.fn();
    workspace.revealLeaf = revealSpy;
    const getLeafSpy = vi.fn();
    workspace.getLeaf = getLeafSpy;
    await plugin.openPanel();
    expect(revealSpy).toHaveBeenCalledWith(fakeLeaf);
    expect(getLeafSpy).not.toHaveBeenCalled();
  });

  it('creates a new tab leaf and applies view state when none exists', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const setViewState = vi.fn().mockResolvedValue(undefined);
    const fakeLeaf = { setViewState };
    const workspace = plugin.app.workspace;
    workspace.getLeavesOfType = vi.fn(() => []);
    workspace.getLeaf = vi.fn(() => fakeLeaf);
    const revealSpy = vi.fn();
    workspace.revealLeaf = revealSpy;
    await plugin.openPanel();
    expect(workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(setViewState).toHaveBeenCalledWith({ type: PANEL_VIEW_TYPE, active: true });
    expect(revealSpy).toHaveBeenCalledWith(fakeLeaf);
  });
});

const LIFECYCLE_NOTES = {
  'projects/A.md': '---\nstatus: wip\n---\n- [ ] Alpha\n',
  'projects/B.md': '---\nstatus: wip\n---\n- [ ] Beta\n',
  'projects/C.md': '---\nstatus: wip\n---\n',
  'projects/D.md': '---\nstatus: todo\n---\n- [ ] Delta\n',
};
const TODO = `id:${expectDefined(DEFAULT_SETTINGS.projects.statuses[1]).id}`;
const WIP = `id:${expectDefined(DEFAULT_SETTINGS.projects.statuses[2]).id}`;
/** Past ProjectStore's 150 ms flush and the note-path owner's 150 ms trailing save. */
const PAST_TRAILING_WORK_MS = 300;
/** A step well short of both debounces that lets reads, index deliveries, and saves settle. */
const SETTLE_STEP_MS = 10;

/** The plugin's own owner, index, and panel over the lifecycle notes, with the panel open. */
async function pluginWithOpenPanel() {
  const app = await createAppWithFiles(LIFECYCLE_NOTES);
  // Obsidian installs the plugin directory before loading its entry point.
  await app.vault.adapter.mkdir(`${app.vault.configDir}/plugins/${MANIFEST.id}`);
  const plugin = new TaskCalendarPlugin(app, MANIFEST);
  vi.spyOn(plugin, 'loadData').mockResolvedValue(null);
  const registerCommand = vi.spyOn(plugin, 'addCommand');
  await plugin.onload();
  (app.workspace as unknown as WorkspaceLike).setLayoutReady__();
  await flushMicrotasks();
  const command = expectDefined(
    registerCommand.mock.calls.find(([entry]) => entry.id === 'open-panel')?.[0],
  );
  const openPanel = expectDefined(command.callback);
  await openPanel();
  const leaf = expectDefined(app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0]);
  const view = leaf.view;
  if (!(view instanceof PanelView)) throw new Error('The panel did not open');
  const internals = view as unknown as {
    state_abyssPrivate: AppState;
    panelNavigation_abyssPrivate: PanelNavigator;
  };
  return {
    app,
    plugin,
    leaf,
    state: internals.state_abyssPrivate,
    navigation: internals.panelNavigation_abyssPrivate,
    statePath: `${app.vault.configDir}/plugins/${MANIFEST.id}/state.json`,
    note: (path: string) => expectDefined(app.vault.getFileByPath(path)),
  };
}

/** The same harness with the Projects overview in Kanban mode and every note ranked. */
async function kanbanOverview() {
  const harness = await pluginWithOpenPanel();
  harness.plugin.settings.projects.overviewView = 'kanban';
  harness.navigation.openProjects();
  await flushMicrotasks();
  expect(harness.plugin.settings.projects.kanban?.manualOrder).toEqual({
    [WIP]: ['projects/A.md', 'projects/B.md', 'projects/C.md'],
    [TODO]: ['projects/D.md'],
  });
  return harness;
}

/** The cards of one Kanban status column, in screen order. */
function kanbanCards(panel: HTMLElement, statusKey: string): HTMLElement[] {
  const column = panel.querySelector(
    `.abyss-project-kanban-column[data-status-key="${statusKey}"]`,
  );
  return Array.from(column?.querySelectorAll<HTMLElement>('.abyss-project-kanban-card') ?? []);
}

describe('TaskCalendarPlugin note path lifecycle', () => {
  it('writes once and raises one Notice when the selected project leaves its status empty', async () => {
    const { app, plugin, leaf, navigation, state, statePath, note } = await kanbanOverview();
    vi.useFakeTimers();
    const failure = new Error('disk full');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      navigation.openList({ type: 'project', path: 'projects/D.md' });
      navigation.openProjects();
      await vi.advanceTimersByTimeAsync(SETTLE_STEP_MS);
      const adapter = app.vault.adapter;
      const write = adapter.write.bind(adapter);
      const writes = vi.spyOn(adapter, 'write').mockImplementation(async (path, data, options) => {
        if (path === statePath) throw failure;
        await write(path, data, options);
      });
      const notices = spyOnNotices();

      await app.fileManager.trashFile(note('projects/D.md'));
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);

      expect(writes.mock.calls.filter(([path]) => path === statePath)).toHaveLength(1);
      expect(noticeMessages(notices)).toEqual([
        'Could not save view preferences. Your current session is unchanged.',
      ]);
      expect(state.get('selectedList')).toBe('today');
      expect(state.get('mode')).toBe('projects');
      expect(plugin.settings.listViewStates).not.toHaveProperty(['project:projects/D.md']);
      expect(plugin.settings.projects.kanban?.manualOrder).toEqual({
        [WIP]: ['projects/A.md', 'projects/B.md', 'projects/C.md'],
      });
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
    // Main's panel route logs the write it presents, and the navigator logs the rejection.
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, '[abyss-tasks] saved view state write failed', failure);
    expect(log).toHaveBeenNthCalledWith(
      2,
      '[abyss-tasks] failed to persist list view settings',
      failure,
    );
  });

  it('keeps the list on screen under a renamed selected project and drops the old key', async () => {
    const { app, plugin, leaf, navigation, state, note } = await pluginWithOpenPanel();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      navigation.openList({ type: 'project', path: 'projects/A.md' });
      const onScreen = { ...state.get('centerListViewState'), groupBy: 'priority' as const };
      state.set('centerListViewState', onScreen);

      await app.vault.rename(note('projects/A.md'), 'projects/A2.md');

      expect(state.get('selectedList')).toEqual({ type: 'project', path: 'projects/A2.md' });
      expect(plugin.settings.listViewStates?.['project:projects/A2.md']).toBe(onScreen);
      expect(plugin.settings.listViewStates).not.toHaveProperty(['project:projects/A.md']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it('forgets a deleted ranked note with tasks and saves the state without it', async () => {
    const { app, plugin, leaf, statePath, note } = await kanbanOverview();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      await app.fileManager.trashFile(note('projects/A.md'));
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);

      const expected = { [WIP]: ['projects/B.md', 'projects/C.md'], [TODO]: ['projects/D.md'] };
      expect(plugin.settings.projects.kanban?.manualOrder).toEqual(expected);
      const saved = JSON.parse(await app.vault.adapter.read(statePath)) as {
        views: { projects: { kanban: { manualOrder: unknown } } };
      };
      expect(saved.views.projects.kanban.manualOrder).toEqual(expected);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it('keeps a renamed ranked note with tasks at its rank', async () => {
    const { app, plugin, leaf, note } = await kanbanOverview();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      const renamed = note('projects/B.md');
      await app.vault.rename(renamed, 'projects/B2.md');
      // The mock metadata cache does not follow a rename; a same-content write re-indexes it.
      await app.vault.modify(renamed, LIFECYCLE_NOTES['projects/B.md']);
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);

      expect(plugin.settings.projects.kanban?.manualOrder).toEqual({
        [WIP]: ['projects/A.md', 'projects/B2.md', 'projects/C.md'],
        [TODO]: ['projects/D.md'],
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it("keeps a renamed ranked card in its column slot before and after the store's flush", async () => {
    const { app, plugin, leaf, note } = await kanbanOverview();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      // Ranks order the cards only while the board is in manual order.
      expectDefined(plugin.settings.projects.kanban).sortBy = { field: 'none', dir: 'asc' };
      plugin.refreshProjectTableSettings();
      const renamed = note('projects/B.md');
      const wipPaths = (): Array<string | undefined> =>
        kanbanCards(leaf.view.containerEl, WIP).map((card) => card.dataset['projectPath']);

      await app.vault.rename(renamed, 'projects/B2.md');
      // Well short of the store's flush: the index has read the note and published `renamed`.
      await vi.advanceTimersByTimeAsync(SETTLE_STEP_MS);

      expect(wipPaths()).toEqual(['projects/A.md', 'projects/B2.md', 'projects/C.md']);
      const card = kanbanCards(leaf.view.containerEl, WIP).find(
        (candidate) => candidate.dataset['projectPath'] === 'projects/B2.md',
      );
      expect(card?.querySelector('.abyss-project-kanban-title')?.textContent).toBe('B2');

      // The mock metadata cache does not follow a rename; a same-content write re-indexes it.
      await app.vault.modify(renamed, LIFECYCLE_NOTES['projects/B.md']);
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);
      expect(wipPaths()).toEqual(['projects/A.md', 'projects/B2.md', 'projects/C.md']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it("shows a renamed project on its open dashboard before the store's flush", async () => {
    const { app, plugin, leaf, state, note } = await kanbanOverview();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      state.set('projectsPanel', { view: 'dashboard', path: 'projects/B.md' });

      await app.vault.rename(note('projects/B.md'), 'projects/B2.md');

      expect(state.get('projectsPanel')).toEqual({ view: 'dashboard', path: 'projects/B2.md' });
      const panel = leaf.view.containerEl;
      expect(panel.querySelector('.abyss-projects-empty')).toBeNull();
      expect(panel.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('B2');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it('forgets a deleted note without tasks while its dashboard is open', async () => {
    const { app, plugin, leaf, state, note } = await kanbanOverview();
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error');
    try {
      state.set('projectsPanel', { view: 'dashboard', path: 'projects/C.md' });

      await app.fileManager.trashFile(note('projects/C.md'));

      expect(state.get('projectsPanel')).toEqual({ view: 'table' });
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);
      expect(plugin.settings.projects.kanban?.manualOrder).toEqual({
        [WIP]: ['projects/A.md', 'projects/B.md'],
        [TODO]: ['projects/D.md'],
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });

  it('leaves no bucket for the only ranked project of a status and no overview save', async () => {
    const { app, plugin, leaf, statePath, note } = await kanbanOverview();
    vi.useFakeTimers();
    const panelRoute = vi.spyOn(
      plugin as unknown as { saveViewStateWithNotice: () => Promise<void> },
      'saveViewStateWithNotice',
    );
    const writes = vi.spyOn(app.vault.adapter, 'write');
    const errors = vi.spyOn(console, 'error');
    try {
      await app.fileManager.trashFile(note('projects/D.md'));
      await vi.advanceTimersByTimeAsync(PAST_TRAILING_WORK_MS);

      expect(plugin.settings.projects.kanban?.manualOrder).toEqual({
        [WIP]: ['projects/A.md', 'projects/B.md', 'projects/C.md'],
      });
      expect(panelRoute).not.toHaveBeenCalled();
      expect(writes.mock.calls.filter(([path]) => path === statePath)).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await leaf.setViewState({ type: 'empty' });
      leaf.detach();
      plugin.onunload();
    }
  });
});

it('composes the browser task scheduler into bounded canonical organization reads', async () => {
  const yieldTask = vi.fn(async (_signal: AbortSignal) => {});
  const scheduler = vi.spyOn(browserSearch, 'createBrowserSearchScheduler').mockReturnValue({
    now: () => 0,
    yield: yieldTask,
    delay: async () => {},
  });
  const plugin = makePlugin();
  try {
    await plugin.onload();
    const index = plugin.taskIndex as TaskIndex;
    await index.initialize();
    index.installCommittedContent(
      'organization.md',
      Array.from({ length: 201 }, (_, i) => `- [ ] item ${i}`).join('\n'),
    );
    const source = index.searchSource().subscribe(() => {});
    const sizes: number[] = [];
    const signal = new AbortController().signal;
    for await (const batch of index.organization(
      { expectedGeneration: source.state.generation },
      signal,
    ))
      sizes.push(batch.items.length);
    expect(sizes).toEqual([200, 1]);
    expect(yieldTask).toHaveBeenCalledExactlyOnceWith(signal);
    source.unsubscribe();
  } finally {
    plugin.onunload();
    scheduler.mockRestore();
  }
});

it('unload cancels startup through the real composed browser backend', async () => {
  const constructed = deferred<void>();
  let terminated = false;
  const revoked: string[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        constructed.resolve();
      }
      postMessage(): void {}
      terminate(): void {
        terminated = true;
      }
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL(): string {
        return 'blob:composed-startup';
      }
      static override revokeObjectURL(url: string): void {
        revoked.push(url);
      }
    },
  );
  const plugin = makePlugin();
  try {
    await plugin.onload();
    const index = plugin.taskIndex as TaskIndex;
    await index.initialize();
    const outcome = plugin.search
      .open({ kind: 'nodes', query: 'needle' }, new AbortController().signal)
      .catch((error: unknown) => error);
    await constructed.promise;
    plugin.onunload();
    expect(terminated).toBe(true);
    expect(revoked).toEqual(['blob:composed-startup']);
    expect(await outcome).toMatchObject({ code: 'disposed' });
  } finally {
    plugin.onunload();
    vi.unstubAllGlobals();
  }
});

it('plugin load and canonical workspace bootstrap alone leave search backend cold', async () => {
  const factory = vi.spyOn(browserSearch.BrowserTaskSearchBackend, 'create');
  const constructed: unknown[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        constructed.push(this);
      }
    },
  );
  const plugin = makePlugin();
  try {
    await plugin.onload();
    plugin.app.workspace.setLayoutReady__();
    await plugin.taskIndex.initialize();
    await flushMicrotasks();
    expect(constructed).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    plugin.onunload();
    vi.unstubAllGlobals();
  }
});
