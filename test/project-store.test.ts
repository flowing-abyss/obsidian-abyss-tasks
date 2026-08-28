import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { computeTaskRollup, ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskIndexEvent, TaskSnapshot } from '../src/tasks';
import { queryApiForTasks, task, taskQueryApi, type TaskFixtureInput } from './helpers';

/** A minimal object that passes `instanceof TFile` (TFile isn't standalone-constructable). */
function tfile(path: string): { path: string; extension: string } {
  return Object.assign(Object.create(TFile.prototype) as object, { path, extension: 'md' }) as {
    path: string;
    extension: string;
  };
}

function t(over: TaskFixtureInput): TaskSnapshot {
  return task({ ...over, source: { filePath: 'x.md', ...over.source } });
}

describe('computeTaskRollup', () => {
  it('excludes cancelled from denominator', () => {
    const stats = computeTaskRollup([
      t({ status: 'open' }),
      t({ status: 'done' }),
      t({ status: 'cancelled' }),
    ]);
    expect(stats).toEqual({
      total: 2,
      done: 1,
      cancelled: 1,
      inProgress: 0,
      open: 1,
      progress: 0.5,
    });
  });

  it('uses null progress for no actionable tasks', () => {
    expect(computeTaskRollup([t({ status: 'cancelled' })])).toEqual({
      total: 0,
      done: 0,
      cancelled: 1,
      inProgress: 0,
      open: 0,
      progress: null,
    });
  });
});

interface FakeFile {
  path: string;
  tags: string[]; // '#'-prefixed inline tags
  fm: Record<string, unknown>;
}

interface MockApp {
  app: never;
  fire: (event: string) => void;
  fireChanged: (path: string) => void;
  setCache: (path: string, f: FakeFile) => void;
}

function makeApp(files: FakeFile[]): MockApp {
  const tfileByPath = new Map(files.map((f) => [f.path, tfile(f.path)]));
  const toCache = (f: FakeFile) => ({ frontmatter: f.fm, tags: f.tags.map((tag) => ({ tag })) });
  const cacheByPath = new Map(files.map((f) => [f.path, toCache(f)]));
  const changedHandlers: Array<(file: { path: string }) => void> = [];
  const handlers: Record<string, Array<() => void>> = {};
  const on = (event: string, cb: (...a: unknown[]) => void): { event: string } => {
    if (event === 'changed') changedHandlers.push(cb as (file: { path: string }) => void);
    else (handlers[event] ??= []).push(cb as () => void);
    return { event };
  };
  const app = {
    vault: {
      getMarkdownFiles: () => Array.from(tfileByPath.values()),
      getAbstractFileByPath: (p: string) => tfileByPath.get(p) ?? null,
      on,
      offref: vi.fn(),
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => cacheByPath.get(file.path),
      on,
      offref: vi.fn(),
    },
  } as never;
  const fire = (event: string): void => {
    for (const cb of handlers[event] ?? []) cb();
  };
  const fireChanged = (path: string): void => {
    for (const cb of changedHandlers) cb({ path });
  };
  const setCache = (path: string, f: FakeFile): void => {
    if (!tfileByPath.has(path)) tfileByPath.set(path, tfile(path));
    cacheByPath.set(path, toCache(f));
  };
  return { app, fire, fireChanged, setCache };
}

function storeWith(tasks: TaskSnapshot[]): never {
  return queryApiForTasks(() => tasks) as never;
}

describe('ProjectStore enumeration', () => {
  it.each([
    ['Projects/', ['Projects/A.md', 'Projects/B.md']],
    ['#project', ['Projects/A.md']],
    ['status=active', ['Projects/A.md']],
    ['(Projects/ OR Archive/) AND -#archived', ['Projects/A.md', 'Projects/B.md']],
    ['"Project Plans/" AND status="in progress"', ['Project Plans/C.md']],
  ])('keeps legacy saved membership query %s membership', (membershipQuery, expectedPaths) => {
    const { app } = makeApp([
      { path: 'Projects/A.md', tags: ['#project/client'], fm: { status: 'active' } },
      { path: 'Projects/B.md', tags: [], fm: { status: 'paused' } },
      { path: 'Archive/C.md', tags: ['#archived'], fm: { status: 'done' } },
      { path: 'Project Plans/C.md', tags: [], fm: { status: 'in progress' } },
    ]);
    const settings = {
      ...DEFAULT_SETTINGS,
      projects: { ...DEFAULT_SETTINGS.projects, membershipQuery },
    };
    const store = new ProjectStore(app, storeWith([]), settings);

    store.initialize();

    expect(store.list().map(({ path }) => path)).toEqual(expectedPaths);
    store.destroy();
  });

  it('keeps the last working project index and exposes a diagnostic for an incompatible query', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    const settings = {
      ...DEFAULT_SETTINGS,
      projects: { ...DEFAULT_SETTINGS.projects, membershipQuery: 'Projects/' },
    };
    const store = new ProjectStore(app, storeWith([]), settings);
    store.initialize();

    settings.projects.membershipQuery = 'Projects/ AND (';
    store.refresh();

    expect(store.list().map(({ path }) => path)).toEqual(['Projects/A.md']);
    expect(store.queryDiagnostics()).toEqual([
      { source: 'projects.membershipQuery', code: 'unclosed-parenthesis', offset: 14 },
    ]);
    store.destroy();
  });

  it('does not admit later metadata changes while the configured membership query is invalid', () => {
    vi.useFakeTimers();
    const mock = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    let indexListener: ((event: TaskIndexEvent) => void) | undefined;
    const store = queryApiForTasks(
      () => [] as TaskSnapshot[],
      (listener) => {
        indexListener = listener;
        return () => {};
      },
    ) as never;
    const settings = {
      ...DEFAULT_SETTINGS,
      projects: { ...DEFAULT_SETTINGS.projects, membershipQuery: 'Projects/' },
    };
    const projects = new ProjectStore(mock.app, store, settings);
    projects.initialize();
    settings.projects.membershipQuery = 'Projects/ AND (';
    projects.refresh();

    mock.setCache('Projects/B.md', { path: 'Projects/B.md', tags: [], fm: { status: 'active' } });
    mock.fireChanged('Projects/B.md');
    indexListener?.({ type: 'changed', files: ['Projects/B.md'] });
    vi.advanceTimersByTime(150);

    expect(projects.list().map(({ path }) => path)).toEqual(['Projects/A.md']);
    projects.destroy();
    vi.useRealTimers();
  });

  it('lists only notes matching the membership query and resolves status', () => {
    const { app } = makeApp([
      { path: 'Projects/A.md', tags: [], fm: { status: 'active' } },
      { path: 'Projects/B.md', tags: [], fm: { status: 'archive' } },
      { path: 'Notes/C.md', tags: [], fm: {} },
    ]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });
    ps.initialize();
    const list = ps.list();
    expect(list.map((p) => p.path).sort()).toEqual(['Projects/A.md', 'Projects/B.md']);
    const a = ps.get('Projects/A.md')!;
    expect(a.statusId).toBe(DEFAULT_SETTINGS.projects.statuses[0]!.id);
    const b = ps.get('Projects/B.md')!;
    expect(b.statusId).toBeNull();
    expect(b.rawStatus).toBe('archive');
    ps.destroy();
  });

  it('projects strict typed ranges while retaining invalid diagnostics', () => {
    const { app } = makeApp([
      {
        path: 'Projects/A.md',
        tags: [],
        fm: { status: 'active', start: '2026-08-26', end: '2026-08-25' },
      },
      {
        path: 'Projects/B.md',
        tags: [],
        fm: { status: 'active', start: '2026-08-26T14:30:00', end: '2026-09-01' },
      },
    ]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });

    ps.initialize();

    expect(ps.get('Projects/A.md')?.range).toMatchObject({
      start: { raw: '2026-08-26', precision: 'date' },
      end: { raw: '2026-08-25', precision: 'date' },
      issue: 'reversed',
    });
    expect(ps.get('Projects/B.md')?.range).toMatchObject({
      end: { raw: '2026-09-01' },
      issue: 'invalid-start',
    });
    expect(ps.get('Projects/B.md')?.frontmatter['start']).toBe('2026-08-26T14:30:00');
    ps.destroy();
  });

  it('projects supported Project metadata while retaining raw unsupported values', () => {
    const { app } = makeApp([
      {
        path: 'Projects/A.md',
        tags: [],
        fm: {
          status: 'active',
          priority: 'B',
          description: 'Ship safely',
          comments: ['2026-08-11: legacy'],
        },
      },
      {
        path: 'Projects/B.md',
        tags: [],
        fm: { status: 'active', priority: ['A'], description: { nested: true }, comments: 'keep' },
      },
    ]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });

    ps.initialize();

    expect(ps.get('Projects/A.md')).toMatchObject({
      priority: 'B',
      description: 'Ship safely',
      comments: [{ kind: 'timestamp', text: 'legacy', timestamp: { precision: 'day' } }],
      observed: {
        priority: 'B',
        description: 'Ship safely',
        comments: ['2026-08-11: legacy'],
      },
    });
    expect(ps.get('Projects/B.md')).toMatchObject({
      priority: null,
      description: null,
      comments: [],
      observed: { priority: ['A'], description: { nested: true }, comments: 'keep' },
      metadataDiagnostics: [
        { field: 'priority', issue: 'unsupported' },
        { field: 'description', issue: 'unsupported' },
        { field: 'comments', issue: 'unsupported' },
      ],
    });
    ps.destroy();
  });

  it.each(['A', 'B', 'C', 'D', 'E', 'F'])(
    'projects priority %s without normalization',
    (priority) => {
      const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: { priority } }]);
      const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });

      ps.initialize();

      expect(ps.get('Projects/A.md')).toMatchObject({ priority, observed: { priority } });
      ps.destroy();
    },
  );

  it('represents an absent Project priority as null without a diagnostic', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: {} }]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });

    ps.initialize();

    expect(ps.get('Projects/A.md')).toMatchObject({
      priority: null,
      observed: { priority: undefined },
      metadataDiagnostics: [],
    });
    ps.destroy();
  });

  it('computes stats from tasks in the note', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    const tasks = [
      t({ source: { filePath: 'Projects/A.md' }, status: 'open' }),
      t({ source: { filePath: 'Projects/A.md' }, status: 'done' }),
      t({ source: { filePath: 'Other.md' }, status: 'open' }),
    ];
    const ps = new ProjectStore(app, storeWith(tasks), { ...DEFAULT_SETTINGS });
    ps.initialize();
    expect(ps.get('Projects/A.md')!.stats).toEqual({
      total: 2,
      done: 1,
      cancelled: 0,
      inProgress: 0,
      open: 1,
      progress: 0.5,
    });
    ps.destroy();
  });

  it('computes project counts from persisted snapshots without requesting forecasts', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    const persisted = t({
      title: 'Daily project task',
      source: { filePath: 'Projects/A.md' },
      recurrence: 'every day',
      planning: { due: '2026-08-03' },
    });
    const source = {
      root: persisted,
      target: { type: 'task' as const, ref: persisted.ref },
      node: persisted,
    };
    const list = vi.fn(() => [persisted]);
    const forCalendarProjection = vi.fn(() => ({
      materialized: [source],
      recurringSources: [source],
    }));
    const queries = taskQueryApi({ list, forCalendarProjection });
    const ps = new ProjectStore(app, queries, { ...DEFAULT_SETTINGS });

    ps.initialize();

    expect(ps.get('Projects/A.md')?.stats).toEqual({
      total: 1,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      open: 1,
      progress: 0,
    });
    expect(list).toHaveBeenCalled();
    expect(forCalendarProjection).not.toHaveBeenCalled();
    ps.destroy();
  });

  it('activeForLeftPanel returns only onLeftPanel statuses', () => {
    const { app } = makeApp([
      { path: 'Projects/A.md', tags: [], fm: { status: 'active' } }, // onLeftPanel true
      { path: 'Projects/D.md', tags: [], fm: { status: 'done' } }, // onLeftPanel false
    ]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });
    ps.initialize();
    expect(ps.activeForLeftPanel().map((p) => p.path)).toEqual(['Projects/A.md']);
    ps.destroy();
  });

  it('notifies listeners on refresh', () => {
    const { app } = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });
    ps.initialize();
    const cb = vi.fn();
    ps.onUpdate(cb);
    ps.refresh();
    expect(cb).toHaveBeenCalledTimes(1);
    ps.destroy();
  });
});

describe('ProjectStore incremental update', () => {
  it('notifies only when selective typed project fields change', () => {
    vi.useFakeTimers();
    const mock = makeApp([
      {
        path: 'Projects/A.md',
        tags: [],
        fm: { status: 'active', start: '2026-08-26', unrelated: 'before' },
      },
    ]);
    let indexListener: ((event: TaskIndexEvent) => void) | undefined;
    const store = queryApiForTasks(
      () => [] as TaskSnapshot[],
      (listener) => {
        indexListener = listener;
        return () => {};
      },
    ) as never;
    const ps = new ProjectStore(mock.app, store, { ...DEFAULT_SETTINGS });
    ps.initialize();
    const cb = vi.fn();
    ps.onUpdate(cb);

    mock.setCache('Projects/A.md', {
      path: 'Projects/A.md',
      tags: [],
      fm: { status: 'active', start: '2026-08-26', unrelated: 'after' },
    });
    mock.fireChanged('Projects/A.md');
    indexListener?.({ type: 'changed', files: ['Projects/A.md'] });
    vi.advanceTimersByTime(150);
    expect(cb).not.toHaveBeenCalled();

    mock.setCache('Projects/A.md', {
      path: 'Projects/A.md',
      tags: [],
      fm: { status: 'active', start: '2026-08-27', unrelated: 'after' },
    });
    mock.fireChanged('Projects/A.md');
    indexListener?.({ type: 'changed', files: ['Projects/A.md'] });
    vi.advanceTimersByTime(150);
    expect(cb).toHaveBeenCalledOnce();

    ps.destroy();
    vi.useRealTimers();
  });

  it('re-evaluates only the changed note on a metadata change (debounced)', () => {
    vi.useFakeTimers();
    const mock = makeApp([
      { path: 'Projects/A.md', tags: [], fm: { status: 'active' } },
      { path: 'Notes/C.md', tags: [], fm: {} },
    ]);
    let tasks: TaskSnapshot[] = [t({ source: { filePath: 'Projects/A.md' }, status: 'open' })];
    let indexListener: ((event: TaskIndexEvent) => void) | undefined;
    const store = queryApiForTasks(
      () => tasks,
      (listener) => {
        indexListener = listener;
        return () => {};
      },
    ) as never;
    const ps = new ProjectStore(mock.app, store, { ...DEFAULT_SETTINGS });
    ps.initialize();
    expect(ps.get('Projects/A.md')!.stats.done).toBe(0);
    const cb = vi.fn();
    ps.onUpdate(cb);

    // A task in A is completed.
    tasks = [t({ source: { filePath: 'Projects/A.md' }, status: 'done' })];
    mock.fireChanged('Projects/A.md');
    indexListener?.({ type: 'changed', files: ['Projects/A.md'] });
    // Debounced: not applied yet.
    expect(ps.get('Projects/A.md')!.stats.done).toBe(0);
    vi.advanceTimersByTime(150);
    expect(ps.get('Projects/A.md')!.stats.done).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);

    ps.destroy();
    vi.useRealTimers();
  });

  it('a metadata change that newly matches the query adds the note incrementally', () => {
    vi.useFakeTimers();
    const mock = makeApp([{ path: 'Notes/C.md', tags: [], fm: {} }]);
    let indexListener: ((event: TaskIndexEvent) => void) | undefined;
    const store = queryApiForTasks(
      () => [] as TaskSnapshot[],
      (listener) => {
        indexListener = listener;
        return () => {};
      },
    ) as never;
    const settings = {
      ...DEFAULT_SETTINGS,
      projects: { ...DEFAULT_SETTINGS.projects, membershipQuery: '#project' },
    };
    const ps = new ProjectStore(mock.app, store, settings);
    ps.initialize();
    expect(ps.list()).toHaveLength(0);

    mock.setCache('Notes/C.md', { path: 'Notes/C.md', tags: ['#project'], fm: {} });
    mock.fireChanged('Notes/C.md');
    indexListener?.({ type: 'changed', files: ['Notes/C.md'] });
    vi.advanceTimersByTime(150);
    expect(ps.list().map((p) => p.path)).toEqual(['Notes/C.md']);

    ps.destroy();
    vi.useRealTimers();
  });
});
