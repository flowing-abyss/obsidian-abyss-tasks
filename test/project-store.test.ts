import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { computeStats, ProjectStore } from '../src/projects/ProjectStore';
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

describe('computeStats', () => {
  it('counts task statuses', () => {
    const stats = computeStats([
      t({ status: 'open' }),
      t({ status: 'done' }),
      t({ status: 'done' }),
      t({ status: 'cancelled' }),
      t({ status: 'in-progress' }),
    ]);
    expect(stats).toEqual({ total: 5, done: 2, cancelled: 1, inProgress: 1 });
  });

  it('handles an empty list', () => {
    expect(computeStats([])).toEqual({ total: 0, done: 0, cancelled: 0, inProgress: 0 });
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
