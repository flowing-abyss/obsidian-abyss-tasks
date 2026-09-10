import { App, Notice } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaskCalendarPlugin from '../src/main';
import { DEFAULT_SETTINGS, buildDefaultProjectsSettings } from '../src/settings/defaults';
import {
  SAVED_VIEW_STATE_SCHEMA_VERSION,
  STATIC_SAVED_VIEW_STATE_MARKER,
} from '../src/settings/persistence';
import { latestSettingsSaveRevision } from '../src/settings/settingsSaveRevision';
import type { CalendarSettings } from '../src/settings/types';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import { flushMicrotasks, useRealMoment } from './helpers';

useRealMoment();

const MANIFEST = {
  id: 'abyss-tasks',
  name: 'Abyss Tasks',
  version: '1.0.0',
} as ConstructorParameters<typeof TaskCalendarPlugin>[1];

interface WorkspaceLike {
  layoutReady: boolean;
  setLayoutReady__: () => void;
  getLeavesOfType: (type: string) => unknown[];
  getLeaf: (mode: unknown) => { setViewState: (state: unknown) => Promise<void> };
  revealLeaf: (leaf: unknown) => Promise<void> | void;
}

interface PluginLike {
  app: {
    workspace: WorkspaceLike;
    metadataCache: { trigger: (event: string, ...args: unknown[]) => void };
  };
  taskIndex: {
    initialize: () => Promise<void>;
    destroy: () => void;
    constructor: { name: string };
  };
  settings: CalendarSettings;
  data__: unknown;
  stateFiles__: Map<string, string>;
  commands__: Map<string, { id: string; name: string }>;
  views__: Map<string, (...args: unknown[]) => unknown>;
  markdownCodeBlockProcessors__: Map<string, (...args: unknown[]) => unknown>;
  settingTabs__: unknown[];
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  onload: () => Promise<void>;
  onunload: () => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  saveViewState: () => Promise<void>;
  refreshProjectTableSettings: () => void;
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
  };
  Object.assign(app.vault, { adapter, configDir: '.test-config' });

  const plugin = new TaskCalendarPlugin(app, MANIFEST) as unknown as PluginLike;
  // loadData() returns this.data__; seed it so loadSettings merges persisted values.
  plugin.data__ = data ?? {};
  plugin.stateFiles__ = stateFiles;
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
    expect(plugin.settings.addToToday).toBe(DEFAULT_SETTINGS.addToToday);
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

  it('migrates shortcuts before the shallow defaults merge', async () => {
    const plugin = makePlugin({
      shortcuts: { openQuickCapture: '', openTasks: 42, unknownAction: 'Q' },
    });

    await plugin.loadSettings();

    expect(plugin.settings.shortcuts).toEqual({
      ...DEFAULT_SETTINGS.shortcuts,
      openQuickCapture: '',
      openTasks: 'L',
    });
    expect(plugin.settings.shortcuts).not.toHaveProperty('unknownAction');
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
    expect(saved[STATIC_SAVED_VIEW_STATE_MARKER]).toBe(1);
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
    expect(log).toHaveBeenCalledWith(
      '[abyss-tasks] Could not save captured project property types',
      { cause: error },
    );
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
  });

  it('uses one layout and one resolved opportunity only for definitions still missing', async () => {
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
    let names: string[] = [];
    Object.defineProperty(plugin.app, 'metadataTypeManager', {
      configurable: true,
      value: {
        getAllProperties: () =>
          Object.fromEntries(names.map((name) => [name.toLocaleLowerCase(), { name }])),
        getTypeInfo: (name: string) => ({
          expected: { type: name === 'First' ? 'text' : 'number' },
        }),
        getAssignedWidget: () => null,
        on: () => ({ id: 'property-capture' }),
        offref: () => {},
      },
    });

    await plugin.onload();
    names = ['First'];
    plugin.app.workspace.setLayoutReady__();
    await flushMicrotasks();
    expect(plugin.settings.projects.propertyDefinitions).toEqual({
      'property:First': { type: 'text' },
    });

    names = ['First', 'Second'];
    plugin.app.metadataCache.trigger('resolved');
    await flushMicrotasks();
    expect(plugin.settings.projects.propertyDefinitions).toEqual({
      'property:First': { type: 'text' },
      'property:Second': { type: 'number' },
    });
  });

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

  it('registers the task-calendar code-block processor', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.markdownCodeBlockProcessors__.get('task-calendar')).toBeTypeOf('function');
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

  it('installs window.renderCalendar shim', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect((window as unknown as Record<string, unknown>)['renderCalendar']).toBeTypeOf('function');
  });
});

describe('TaskCalendarPlugin renderCalendar shim', () => {
  it('warns and returns when dv has no container', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (window as unknown as { renderCalendar: (dv: unknown, params: unknown) => void })[
      'renderCalendar'
    ]({}, {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no Dataview container'));
    warnSpy.mockRestore();
  });

  it('mounts CalendarRenderer into the container when dv.container is present', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const container = createFragment().createDiv();
    (
      window as unknown as {
        renderCalendar: (dv: { container?: HTMLElement }, params: unknown) => void;
      }
    )['renderCalendar']({ container }, {});
    // CalendarRenderer adds the configured style class to the root element (the container itself)
    expect(container.classList.contains('style1')).toBe(true);
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

  it('deletes window.renderCalendar', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect((window as unknown as Record<string, unknown>)['renderCalendar']).toBeDefined();
    plugin.onunload();
    expect((window as unknown as Record<string, unknown>)['renderCalendar']).toBeUndefined();
  });
});

describe('TaskCalendarPlugin openPanel', () => {
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
