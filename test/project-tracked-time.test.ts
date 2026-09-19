import { TFile, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { renderProjectTableCell } from '../src/panels/projects/projectTableCells';
import { coerceProjectClipboardValue } from '../src/panels/projects/projectTableClipboard';
import { planProjectGroupDrop } from '../src/panels/projects/projectTableDrag';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectStore } from '../src/projects/ProjectStore';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { projectCellSourceValue } from '../src/projects/projectEdits';
import {
  buildProjectFieldCatalog,
  projectFieldValue,
  type ProjectField,
} from '../src/projects/projectFields';
import { buildDefaultProjectTableSettings } from '../src/projects/projectTableSettings';
import type { Project, ProjectStats } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import type { TaskIndexEvent, TaskSnapshot, TimeEntrySnapshot } from '../src/tasks';
import {
  createAppWithFiles,
  expectDefined,
  freshContainer,
  queryApiForTasks,
  task,
} from './helpers';

const HOUR = 3_600_000;
const START_MS = Date.UTC(2026, 8, 18, 9, 0);
const NOW_MS = Date.UTC(2026, 8, 18, 12, 0);

const NO_TRACKED: ProjectStats['tracked'] = { closedMs: 0, openStartsMs: [] };

const trackedField: ProjectField = { id: 'tracked', label: 'Time', type: 'tracked' };

function closedEntry(relativeLine: number, hours: number): TimeEntrySnapshot {
  return {
    relativeLine,
    originalMarkdown: '  - session',
    state: 'closed',
    startMs: START_MS,
    endMs: START_MS + hours * HOUR,
  };
}

function runningEntry(relativeLine: number): TimeEntrySnapshot {
  return {
    relativeLine,
    originalMarkdown: '  - session',
    state: 'running',
    startMs: START_MS,
  };
}

function tracked(filePath: string, timeEntries: readonly TimeEntrySnapshot[]): TaskSnapshot {
  return task({ source: { filePath }, timeEntries: [...timeEntries] });
}

interface FakeFile {
  path: string;
  fm: Record<string, unknown>;
}

function tfile(path: string): TFile {
  const candidate: unknown = Object.assign(Object.create(TFile.prototype) as object, {
    path,
    extension: 'md',
  });
  if (!(candidate instanceof TFile)) throw new Error('Expected a test file');
  return candidate;
}

function makeApp(files: FakeFile[]): { app: never; fireChanged: (path: string) => void } {
  const tfileByPath = new Map(files.map((file) => [file.path, tfile(file.path)]));
  const cacheByPath = new Map(files.map((file) => [file.path, { frontmatter: file.fm, tags: [] }]));
  const changedHandlers: Array<(file: { path: string }) => void> = [];
  const on = (event: string, cb: (...args: unknown[]) => void): { event: string } => {
    if (event === 'changed') changedHandlers.push(cb);
    return { event };
  };
  const app = {
    vault: {
      getMarkdownFiles: () => Array.from(tfileByPath.values()),
      getAbstractFileByPath: (path: string) => tfileByPath.get(path) ?? null,
      on,
      offref: vi.fn(),
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => cacheByPath.get(file.path),
      on,
      offref: vi.fn(),
    },
  } as never;
  return {
    app,
    fireChanged: (path: string) => {
      for (const cb of changedHandlers) cb({ path });
    },
  };
}

function cellOptions(
  field: ProjectField,
  nowMs: number,
): Parameters<typeof renderProjectTableCell>[2] {
  return {
    field,
    statuses: DEFAULT_SETTINGS.projects.statuses,
    app: {} as never,
    component: {} as never,
    beforeOpenLink: async () => true,
    openProject: () => {},
    onRemoveListValue: () => {},
    onToggleCheckbox: () => {},
    trackedNowMs: nowMs,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id,
    rawStatus: null,
    stats: { total: 4, done: 1, cancelled: 0, inProgress: 0, tracked: NO_TRACKED },
    ...overrides,
  };
}

function settingsClone(): CalendarSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
}

function unavailableCatalog(): ProjectPropertyCatalog {
  return {
    list: () => [],
    inspect: () => ({ kind: 'unavailable' }),
    values: () => [],
    onChange: () => () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('project tracked totals', () => {
  it('reads the note total, counting closed entries and the elapsed part of a running one', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', fm: { status: 'active' } }]);
    const tasks = [
      tracked('Projects/A.md', [closedEntry(1, 2), runningEntry(2)]),
      tracked('Other.md', [closedEntry(1, 5)]),
    ];
    const store = new ProjectStore(
      app,
      queryApiForTasks(() => tasks),
      settingsClone(),
    );

    store.initialize();

    expect(expectDefined(store.get('Projects/A.md')).stats.tracked).toEqual({
      closedMs: 2 * HOUR,
      openStartsMs: [START_MS],
    });
    store.destroy();
  });

  it('reports no tracked time for a project note without entries', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', fm: { status: 'active' } }]);
    const store = new ProjectStore(
      app,
      queryApiForTasks(() => [] as TaskSnapshot[]),
      settingsClone(),
    );

    store.initialize();

    expect(expectDefined(store.get('Projects/A.md')).stats.tracked).toEqual(NO_TRACKED);
    store.destroy();
  });

  it('updates tracked time for the changed note and retains every other project entry', () => {
    vi.useFakeTimers();
    const { app, fireChanged } = makeApp([
      { path: 'Projects/A.md', fm: { status: 'active' } },
      { path: 'Projects/B.md', fm: { status: 'active' } },
    ]);
    let tasks: TaskSnapshot[] = [tracked('Projects/A.md', [closedEntry(1, 1)])];
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    const queries = queryApiForTasks(
      () => tasks,
      (next) => {
        listener = next;
        return () => {};
      },
    );
    const store = new ProjectStore(app, queries, settingsClone());
    store.initialize();
    const beforeB = expectDefined(store.get('Projects/B.md'));

    tasks = [tracked('Projects/A.md', [closedEntry(1, 1), closedEntry(2, 2)])];
    fireChanged('Projects/A.md');
    listener?.({ type: 'changed', files: ['Projects/A.md'] });
    vi.advanceTimersByTime(150);

    expect(expectDefined(store.get('Projects/A.md')).stats.tracked).toEqual({
      closedMs: 3 * HOUR,
      openStartsMs: [],
    });
    expect(store.get('Projects/B.md')).toBe(beforeB);
    store.destroy();
  });
});

describe('tracked project field', () => {
  it('follows Progress in the shared catalog as a derived Time field', () => {
    const catalog = buildProjectFieldCatalog(settingsClone().projects, []);
    const ids = catalog.map(({ id }) => id);

    expect(ids).toEqual(['name', 'status', 'progress', 'tracked', 'start', 'end', 'description']);
    expect(catalog[ids.indexOf('tracked')]).toEqual({
      id: 'tracked',
      label: 'Time',
      type: 'tracked',
    });
  });

  it('ships as a hidden table column so the default table is unchanged', () => {
    const columns = buildDefaultProjectTableSettings().columns;

    expect(columns.find(({ id }) => id === 'tracked')).toEqual({ id: 'tracked', visible: false });
    expect(columns.filter(({ visible }) => visible).map(({ id }) => id)).toEqual([
      'name',
      'status',
      'progress',
      'start',
      'end',
    ]);
  });

  it('exposes the note total as its field value and optimistic source value', () => {
    const stats: ProjectStats = {
      total: 1,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: HOUR, openStartsMs: [] },
    };
    const entry = project({ stats });

    expect(projectFieldValue(entry, trackedField)).toEqual(stats.tracked);
    expect(projectCellSourceValue(entry, trackedField, settingsClone().projects)).toEqual(
      stats.tracked,
    );
  });
});

describe('tracked project field is read-only', () => {
  it('refuses a guarded edit the same way Progress does', async () => {
    const app: App = await createAppWithFiles({ 'A.md': '# A\n' });
    const manager = new ProjectManager(
      app,
      settingsClone(),
      {} as never,
      {} as never,
      unavailableCatalog(),
    );
    const progressField: ProjectField = { id: 'progress', label: 'Progress', type: 'progress' };

    for (const field of [progressField, trackedField]) {
      await expect(
        manager.applyEdits([{ path: 'A.md', field, value: 'x', expectedValue: undefined }]),
      ).rejects.toBeInstanceOf(ProjectEditValidationError);
      await expect(
        manager.applyEdits([{ path: 'A.md', field, value: 'x', expectedValue: undefined }]),
      ).rejects.toThrow(/no longer matches its configured project field/u);
    }
  });

  it('rejects a clipboard paste into the Time column by its own label', () => {
    expect(() =>
      coerceProjectClipboardValue(
        { sourcePath: 'Projects/B.md', value: '1h', fieldType: 'text' },
        'tracked',
        [],
      ),
    ).toThrow('Time is read-only');
  });

  it('refuses to change Time by moving a group', () => {
    expect(() =>
      planProjectGroupDrop({
        field: trackedField,
        currentValue: undefined,
        source: { key: 'value:1h', value: '1h' },
        target: { key: 'value:2h', value: '2h' },
        statuses: [],
      }),
    ).toThrow('Time cannot be changed by moving a group');
  });
});

describe('tracked time presentation', () => {
  it('renders the compact total in a table cell and stays blank without tracked time', () => {
    const withTime = freshContainer();
    renderProjectTableCell(
      withTime,
      project({
        stats: {
          total: 1,
          done: 0,
          cancelled: 0,
          inProgress: 0,
          tracked: { closedMs: 2 * HOUR, openStartsMs: [START_MS] },
        },
      }),
      cellOptions(trackedField, NOW_MS),
    );
    const empty = freshContainer();
    renderProjectTableCell(empty, project(), cellOptions(trackedField, NOW_MS));

    expect(withTime.textContent).toBe('5h');
    expect(empty.textContent).toBe('');
  });

  it('shows a dashboard Time stat only once a project has tracked time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const context = {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(),
    };
    const withTime = freshContainer();
    renderProjectDashboard(
      withTime,
      project({
        stats: {
          total: 1,
          done: 0,
          cancelled: 0,
          inProgress: 0,
          tracked: { closedMs: 2 * HOUR + 5 * 60_000, openStartsMs: [] },
        },
      }),
      context,
    );
    const empty = freshContainer();
    renderProjectDashboard(empty, project(), context);

    expect(withTime.querySelector('.abyss-project-time-label')?.textContent).toBe('Time');
    expect(withTime.querySelector('.abyss-project-time-value')?.textContent).toBe('2h 5m');
    expect(empty.querySelector('.abyss-project-time')).toBeNull();
  });
});
