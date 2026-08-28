import { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaskCalendarPlugin from '../src/main';
import { DEFAULT_SETTINGS, buildDefaultProjectsSettings } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { PANEL_VIEW_TYPE } from '../src/views/PanelView';
import { useRealMoment } from './helpers';

useRealMoment();

const MANIFEST = {
  id: 'task-calendar',
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
  app: { workspace: WorkspaceLike };
  taskIndex: {
    initialize: () => Promise<void>;
    destroy: () => void;
    constructor: { name: string };
  };
  dependencyPolicy: object;
  settings: CalendarSettings;
  data__: unknown;
  commands: Map<string, { id: string; name: string }>;
  views__: Map<string, (...args: unknown[]) => unknown>;
  markdownCodeBlockProcessors__: Map<string, (...args: unknown[]) => unknown>;
  settingTabs__: unknown[];
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  onload: () => Promise<void>;
  onunload: () => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  openPanel: () => Promise<void>;
  previewWorkNoteCompatibility: () => Promise<unknown>;
  acceptWorkNoteCompatibility: (token: string) => Promise<unknown>;
  workNoteIndex: {
    acceptSuggestedCompatibility: (token: string, acceptedAt: string) => Promise<unknown>;
    refresh: () => void;
  };
  workNoteCommands: { statuses: () => readonly { id: string; label: string }[] };
  readOnlyCompatibilityDiagnostic: () => {
    readonly buildCommit: string;
    readonly prohibitedWorkNoteMutationCommandIds: readonly string[];
  };
}

function makePlugin(data: Record<string, unknown> | null = null): PluginLike {
  const app = new App();
  const workspace = app.workspace as unknown as WorkspaceLike;
  // Keep layout NOT ready so onLayoutReady queues callbacks (lets onload finish before initialize fires)
  workspace.layoutReady = false;

  const plugin = new TaskCalendarPlugin(app, MANIFEST) as unknown as PluginLike;
  // loadData() returns this.data__; seed it so loadSettings merges persisted values.
  plugin.data__ = data ?? {};
  return plugin;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).renderCalendar;
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
});

describe('TaskCalendarPlugin saveSettings', () => {
  it('calls saveData with current settings', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    const spy = vi.spyOn(plugin, 'saveData');
    await plugin.saveSettings();
    expect(spy).toHaveBeenCalledWith(plugin.settings);
  });

  it('initializes the Work Notes status filter from the accepted mapping ids', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.projects.view.workNotes = {
      ...plugin.settings.projects.view.workNotes,
      statusIds: ['legacy-active', 'legacy-done'],
    };
    const acceptedPreset = {
      ...plugin.settings.projects.workNoteCompatibility,
      enabled: true,
      rawStatusByStatusId: {
        'project-active-id': 'Active',
        'project-done-id': 'Done',
        'unmatched-review': 'Review',
      },
    };
    plugin.workNoteIndex = {
      acceptSuggestedCompatibility: vi.fn().mockResolvedValue({
        type: 'ok',
        preset: acceptedPreset,
        preview: {},
      }),
      refresh: vi.fn(),
    };

    await plugin.acceptWorkNoteCompatibility('preview-token');

    expect(plugin.settings.projects.view.workNotes.statusIds).toEqual([
      'project-active-id',
      'project-done-id',
      'unmatched-review',
    ]);
    expect(plugin.settings.projects.workNoteCompatibility).toBe(acceptedPreset);
  });
});

describe('TaskCalendarPlugin Work Note compatibility wiring', () => {
  it('passes the configured Project statuses through the real preview and acceptance path', async () => {
    const projects = buildDefaultProjectsSettings();
    projects.statuses = [
      {
        id: 'canonical-completed-id',
        label: 'Complete',
        onLeftPanel: false,
        behavior: 'completed',
        match: { kind: 'property', property: 'Status', value: 'Done' },
      },
    ];
    projects.defaultStatusId = 'canonical-completed-id';
    const plugin = makePlugin({ projects });
    const app = plugin.app as unknown as App;
    const workNote = Object.assign(Object.create(TFile.prototype) as object, {
      path: 'Work Notes/Ship.md',
      extension: 'md',
    }) as TFile;
    const project = Object.assign(Object.create(TFile.prototype) as object, {
      path: 'Projects/A.md',
      extension: 'md',
    }) as TFile;
    vi.spyOn(app.vault, 'getMarkdownFiles').mockReturnValue([workNote]);
    vi.spyOn(app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
      path === project.path ? project : path === workNote.path ? workNote : null,
    );
    vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) =>
      file.path === workNote.path
        ? ({
            tags: [{ tag: '#work-note/task', position: undefined }],
            frontmatter: { Project: '[[Projects/A]]', Status: 'dOnE' },
          } as never)
        : null,
    );
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation(
      (linkpath, sourcePath) =>
        linkpath === 'Projects/A' && sourcePath === workNote.path ? project : null,
    );

    await plugin.onload();
    try {
      const preview = (await plugin.previewWorkNoteCompatibility()) as {
        acceptanceToken?: string;
      };
      const accepted = (await plugin.acceptWorkNoteCompatibility(preview.acceptanceToken!)) as {
        type: string;
        preset?: { rawStatusByStatusId: Readonly<Record<string, string>> };
      };

      expect(accepted.type).toBe('ok');
      expect(accepted.preset?.rawStatusByStatusId).toEqual({
        'canonical-completed-id': 'dOnE',
      });
      expect(plugin.workNoteCommands.statuses()).toEqual([
        { id: 'canonical-completed-id', label: 'Complete' },
      ]);
    } finally {
      plugin.onunload();
    }
  });
});

describe('TaskCalendarPlugin onload', () => {
  it('constructs the shared TaskIndex', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    expect(plugin.taskIndex).toBeDefined();
    expect(plugin.taskIndex.constructor.name).toBe('TaskIndex');
  });

  it('shares one dependency policy between Task commands and Project workspace reads', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const internals = plugin as unknown as {
      dependencyPolicy: object;
      tasks: { dependencyPolicy: object };
      projectWorkspace: { dependencies: object };
    };

    expect(internals.dependencyPolicy).toBeDefined();
    expect(internals.tasks.dependencyPolicy).toBe(internals.dependencyPolicy);
    expect(internals.projectWorkspace.dependencies).toBe(internals.dependencyPolicy);
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
    const cmd = plugin.commands.get('open-panel');
    expect(cmd).toBeDefined();
    expect(cmd?.id).toBe('open-panel');
    expect(cmd?.name).toBe('Open view');
  });

  it('keeps the production Work Note preview reachable through a read-only command', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const preview = {
      preset: { enabled: false, accepted: false },
      notes: { scanned: 0, eligible: 0, excluded: 0 },
      kinds: { ordinary: 0, milestone: 0, ambiguous: 0, missing: 0 },
      statuses: { mapped: 0, unknown: 0, missing: 0, nonScalar: 0 },
      links: {
        brokenProject: 0,
        ambiguousProject: 0,
        brokenRelation: 0,
        ambiguousRelation: 0,
        invalidProjectEntry: 0,
        invalidRelationEntry: 0,
      },
      cardinality: { missingProject: 0, multipleProjects: 0, multipleMilestones: 0 },
      duplicateBasenames: { project: 0, relation: 0 },
      diagnostics: {},
      capabilities: { update: false, create: false },
    };
    const spy = vi.spyOn(plugin, 'previewWorkNoteCompatibility').mockResolvedValue(preview);
    const command = plugin.commands.get('preview-work-note-compatibility');

    expect(command?.name).toBe('Preview work note compatibility');
    await (command as unknown as { callback: () => Promise<void> }).callback();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('publishes build provenance and the canonical prohibited Work Note mutation routes', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const diagnostic = plugin.readOnlyCompatibilityDiagnostic();

    expect(diagnostic).toEqual({
      buildCommit: 'development',
      prohibitedWorkNoteMutationCommandIds: [
        'task-calendar:create-work-note',
        'task-calendar:set-work-note-status',
        'task-calendar:set-work-note-date',
        'task-calendar:set-work-note-relation',
        'task-calendar:update-work-note',
        'task-calendar:accept-work-note-audit',
        'task-calendar:enable-work-note-compatibility',
      ],
    });
    for (const id of diagnostic.prohibitedWorkNoteMutationCommandIds) {
      expect(plugin.commands.has(id.replace(/^task-calendar:/u, ''))).toBe(false);
    }
  });

  it('settles the read-only preview command when metadata inspection fails', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    vi.spyOn(plugin, 'previewWorkNoteCompatibility').mockRejectedValue(new Error('metadata'));
    const command = plugin.commands.get('preview-work-note-compatibility');

    const result = (command as unknown as { callback: () => unknown }).callback();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
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
    const cmd = plugin.commands.get('open-panel');
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
    expect((window as unknown as Record<string, unknown>).renderCalendar).toBeTypeOf('function');
  });
});

describe('TaskCalendarPlugin renderCalendar shim', () => {
  it('warns and returns when dv has no container', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (
      window as unknown as { renderCalendar: (dv: unknown, params: unknown) => void }
    ).renderCalendar({}, {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no Dataview container'));
    warnSpy.mockRestore();
  });

  it('mounts CalendarRenderer into the container when dv.container is present', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const container = activeDocument.createElement('div');
    (
      window as unknown as {
        renderCalendar: (dv: { container?: HTMLElement }, params: unknown) => void;
      }
    ).renderCalendar({ container }, {});
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
    expect((window as unknown as Record<string, unknown>).renderCalendar).toBeDefined();
    plugin.onunload();
    expect((window as unknown as Record<string, unknown>).renderCalendar).toBeUndefined();
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
