import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { computeStats, ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskIndexEvent, TaskSnapshot } from '../src/tasks';
import {
  createAppWithFiles,
  expectDefined,
  queryApiForTasks,
  task,
  taskQueryApi,
  type TaskFixtureInput,
} from './helpers';

/** A minimal object that passes `instanceof TFile` (TFile isn't standalone-constructable). */
function tfile(path: string): { path: string; extension: string } {
  return Object.assign(Object.create(TFile.prototype) as object, { path, extension: 'md' });
}

function t(over: TaskFixtureInput): TaskSnapshot {
  return task({ ...over, source: { filePath: 'x.md', ...over.source } });
}

describe('computeStats', () => {
  it('counts task statuses', () => {
    const stats = computeStats(
      [
        t({ status: 'open' }),
        t({ status: 'done' }),
        t({ status: 'done' }),
        t({ status: 'cancelled' }),
        t({ status: 'in-progress' }),
      ],
      { closedMs: 90_000, openStartsMs: [] },
    );
    expect(stats).toEqual({
      total: 5,
      done: 2,
      cancelled: 1,
      inProgress: 1,
      tracked: { closedMs: 90_000, openStartsMs: [] },
    });
  });

  it('handles an empty list', () => {
    expect(computeStats([], { closedMs: 0, openStartsMs: [] })).toEqual({
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
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
    if (event === 'changed') changedHandlers.push(cb);
    else {
      const eventHandlers = handlers[event] ?? [];
      eventHandlers.push(cb);
      handlers[event] = eventHandlers;
    }
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
      { path: 'Projects/A.md', tags: [], fm: { status: 'inbox' } },
      { path: 'Projects/B.md', tags: [], fm: { status: 'archive' } },
      { path: 'Notes/C.md', tags: [], fm: {} },
    ]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });
    ps.initialize();
    const list = ps.list();
    expect(list.map((p) => p.path).sort((left, right) => left.localeCompare(right))).toEqual([
      'Projects/A.md',
      'Projects/B.md',
    ]);
    const a = expectDefined(ps.get('Projects/A.md'));
    expect(a.statusId).toBe(expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id);
    const b = expectDefined(ps.get('Projects/B.md'));
    expect(b.statusId).toBeNull();
    expect(b.rawStatus).toBe('archive');
    ps.destroy();
  });

  it('Y1j names a project note with an upper-case .MD as Obsidian does', () => {
    // Obsidian keeps a file's extension in lower case, as the fixture's files have it, so the
    // store sees `Plan.MD` as a note.
    const { app } = makeApp([{ path: 'Projects/Plan.MD', tags: [], fm: {} }]);
    const ps = new ProjectStore(app, storeWith([]), { ...DEFAULT_SETTINGS });
    ps.initialize();
    expect(ps.get('Projects/Plan.MD')?.name).toBe('Plan');
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
    expect(expectDefined(ps.get('Projects/A.md')).stats).toEqual({
      total: 2,
      done: 1,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
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
      tracked: { closedMs: 0, openStartsMs: [] },
    });
    expect(list).toHaveBeenCalled();
    expect(forCalendarProjection).not.toHaveBeenCalled();
    ps.destroy();
  });

  it('activeForLeftPanel returns only onLeftPanel statuses', () => {
    const { app } = makeApp([
      { path: 'Projects/A.md', tags: [], fm: { status: 'wip' } }, // onLeftPanel true
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

  it('notifies presentation settings changes without rescanning vault files or tasks', () => {
    const mock = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
    const list = vi.fn(() => [] as TaskSnapshot[]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    const ps = new ProjectStore(mock.app, queryApiForTasks(list), settings);
    ps.initialize();
    const getMarkdownFiles = vi.spyOn(
      (mock.app as { vault: { getMarkdownFiles: () => unknown[] } }).vault,
      'getMarkdownFiles',
    );
    list.mockClear();
    getMarkdownFiles.mockClear();
    const cb = vi.fn();
    ps.onUpdate(cb);

    expectDefined(settings.projects.statuses[0]).displayName = 'In progress';
    expect(ps.refreshSettings()).toBe('presentation');

    expect(getMarkdownFiles).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    ps.destroy();
  });

  it.each(['membership', 'status source', 'status identity'] as const)(
    'rescans projects when %s settings used by entries change',
    (change) => {
      const mock = makeApp([{ path: 'Projects/A.md', tags: [], fm: { status: 'active' } }]);
      const list = vi.fn(() => [] as TaskSnapshot[]);
      const fileTotal = vi.fn(() => ({ closedMs: 0, openStartsMs: [] }));
      const settings = structuredClone(DEFAULT_SETTINGS);
      const ps = new ProjectStore(mock.app, { ...queryApiForTasks(list), fileTotal }, settings);
      ps.initialize();
      const getMarkdownFiles = vi.spyOn(
        (mock.app as { vault: { getMarkdownFiles: () => unknown[] } }).vault,
        'getMarkdownFiles',
      );
      list.mockClear();
      getMarkdownFiles.mockClear();
      fileTotal.mockClear();

      if (change === 'membership') settings.projects.membershipQuery = '#project';
      else if (change === 'status source') settings.projects.statusProperty = 'phase';
      else expectDefined(settings.projects.statuses[0]).name = 'running';
      ps.refreshSettings();

      expect(getMarkdownFiles).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledOnce();
      // The tracked total is one indexed lookup per surviving project, never a walk over entries.
      expect(fileTotal).toHaveBeenCalledTimes(change === 'membership' ? 0 : 1);
      ps.destroy();
    },
  );
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
    expect(expectDefined(ps.get('Projects/A.md')).stats.done).toBe(0);
    const cb = vi.fn();
    ps.onUpdate(cb);

    // A task in A is completed.
    tasks = [t({ source: { filePath: 'Projects/A.md' }, status: 'done' })];
    mock.fireChanged('Projects/A.md');
    indexListener?.({ type: 'changed', files: ['Projects/A.md'] });
    // Debounced: not applied yet.
    expect(expectDefined(ps.get('Projects/A.md')).stats.done).toBe(0);
    vi.advanceTimersByTime(150);
    expect(expectDefined(ps.get('Projects/A.md')).stats.done).toBe(1);
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

it('publishes renamed project statistics only after accepted index work settles', async () => {
  const app = await createAppWithFiles({ 'Projects/Before.md': '- [ ] Existing\n' });
  let snapshots = [t({ source: { filePath: 'Projects/Before.md' } })];
  let accept: ((event: TaskIndexEvent) => void) | undefined;
  const queries = taskQueryApi({
    list: (query) =>
      snapshots.filter(
        (snapshot) => query?.filePath === undefined || snapshot.ref.filePath === query.filePath,
      ),
    subscribe: (listener) => {
      accept = listener;
      return () => {};
    },
  });
  const store = new ProjectStore(app, queries, structuredClone(DEFAULT_SETTINGS));
  store.initialize();
  const published = vi.fn(() => store.list());
  store.onUpdate(published);
  vi.useFakeTimers();
  try {
    const file = expectDefined(app.vault.getFileByPath('Projects/Before.md'));
    await app.vault.rename(file, 'Projects/After.md');
    expect(store.get('Projects/Before.md')).toBeUndefined();
    expect(store.get('Projects/After.md')).toMatchObject({
      path: 'Projects/After.md',
      name: 'After',
      stats: { total: 1, done: 0 },
    });
    expect(published).not.toHaveBeenCalled();
    snapshots = [
      t({ source: { filePath: 'Projects/After.md' }, status: 'done' }),
      t({ source: { filePath: 'Projects/After.md', line: 1 } }),
    ];
    expectDefined(accept)({
      type: 'renamed',
      oldPath: 'Projects/Before.md',
      newPath: 'Projects/After.md',
    });
    const settled = vi.fn();
    const barrier = store.whenSettled().then(settled);
    await vi.advanceTimersByTimeAsync(149);
    expect(settled).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect(store.get('Projects/After.md')?.stats.total).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await barrier;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.results[0]?.value).toMatchObject([
      { path: 'Projects/After.md', name: 'After', stats: { total: 2, done: 1 } },
    ]);
    expect(store.get('Projects/Before.md')).toBeUndefined();
  } finally {
    store.destroy();
    vi.useRealTimers();
  }
});
