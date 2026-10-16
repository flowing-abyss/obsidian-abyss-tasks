import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskSearchMutation } from '../../src/tasks/application/TaskSearchBackend';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { deferred, expectDefined } from '../helpers';
import {
  assertNoRevision,
  createCanonicalSearchHarness,
  nodeDocuments,
} from '../support/taskSearchHarness';

async function ready() {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  await runtime.mutate({ type: 'begin', path: 'a.md' });
  await runtime.mutate({ type: 'add', documents: nodeDocuments(95) });
  await runtime.mutate({ type: 'commit', path: 'a.md' });
  await runtime.mutate({ type: 'publish', generation: 1 });
  return runtime;
}
const request = (kind: 'roots' | 'nodes') => ({
  kind,
  query: prepareSearchQuery('needle', fallbackSearchWords),
  includeSourcePath: false,
});
describe('owned search runtime', () => {
  it('keeps final random page alive and isolates another cursor', async () => {
    const r = await ready();
    const a = await r.open(request('nodes'), 1);
    const b = await r.open(request('roots'), 1);
    expect((await r.read(a, 90, 30)).hits).toHaveLength(5);
    expect((await r.read(a, 60, 30)).hits).toHaveLength(30);
    r.release(b);
    expect((await r.read(a, 0, 30)).hits).toHaveLength(30);
    r.dispose();
  });
  it('forward last batch releases', async () => {
    const r = await ready();
    const a = await r.open(request('roots'), 1);
    await expect(r.read(a, 1, 30)).rejects.toMatchObject({ code: 'invalid-request' });
    expect((await r.read(a, 0, 200)).done).toBe(true);
    await expect(r.read(a, 0, 30)).rejects.toMatchObject({ code: 'cursor-expired' });
    r.dispose();
  });
  it('fifth vector evicts least recent and no requery', async () => {
    const r = await ready();
    const cursors = await Promise.all(Array.from({ length: 4 }, () => r.open(request('nodes'), 1)));
    const first = expectDefined(cursors[0]);
    const second = expectDefined(cursors[1]);
    await r.read(first, 0, 1);
    await r.open(request('nodes'), 1);
    await expect(r.read(second, 0, 1)).rejects.toMatchObject({ code: 'cursor-expired' });
    expect((await r.read(first, 0, 1)).hits).toHaveLength(1);
    await r.mutate({ type: 'publish', generation: 2 });
    await expect(r.read(first, 0, 1)).rejects.toMatchObject({ code: 'stale' });
    r.dispose();
  });
});

it('twenty churn cycles and vacuum parity', async () => {
  const r = await ready();
  for (let cycle = 0; cycle < 20; cycle++) {
    const docs = nodeDocuments(cycle + 1).map((d) => ({
      ...d,
      id: d.id + (cycle + 1) * 100,
      rootId: d.rootId + (cycle + 1) * 100,
    }));
    await r.mutate({ type: 'begin', path: 'a.md' });
    await expect(r.open(request('nodes'), cycle + 1)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await r.mutate({ type: 'add', documents: docs });
    await r.mutate({ type: 'commit', path: 'a.md' });
    await r.mutate({ type: 'publish', generation: cycle + 2 });
    const c = await r.open(request('nodes'), cycle + 2);
    expect((await r.read(c, 0, 200)).hits.map((hit) => hit.id)).toEqual(docs.map((d) => d.id));
    r.release(c);
  }
  r.dispose();
});

it('publishes accepted replacements without waiting for maintenance vacuum', async ({
  onTestFinished,
}) => {
  const engine = createMiniSearchTaskEngine(fallbackSearchWords);
  const r = new TaskSearchRuntime(engine);
  const original = engine.vacuum.bind(engine);
  const entered = deferred<void>(),
    finish = deferred<void>();
  let maintenance = Promise.resolve();
  let vacuumCompleted = false;
  const cleanup = async (): Promise<void> => {
    finish.resolve();
    try {
      await maintenance;
    } finally {
      r.dispose();
    }
  };
  onTestFinished(cleanup);
  try {
    await r.mutate({ type: 'begin', path: 'a.md' });
    await r.mutate({ type: 'add', documents: nodeDocuments(1) });
    await r.mutate({ type: 'commit', path: 'a.md' });
    await r.mutate({ type: 'publish', generation: 1 });
    const initial = await r.open(request('roots'), 1);
    expect((await r.read(initial, 0, 200)).hits.map((hit) => hit.id)).toEqual([1]);
    engine.vacuum = () => {
      entered.resolve();
      maintenance = (async () => {
        await finish.promise;
        await original();
        vacuumCompleted = true;
      })();
      return maintenance;
    };
    const replacements = nodeDocuments(2).map((doc) => ({
      ...doc,
      id: doc.id + 100,
      rootId: doc.rootId + 100,
    }));
    await r.mutate({ type: 'begin', path: 'a.md' });
    await r.mutate({ type: 'add', documents: replacements });
    await r.mutate({ type: 'commit', path: 'a.md' });
    const publishing = r.mutate({ type: 'publish', generation: 2 });
    await entered.promise;
    await publishing;
    for (const kind of ['roots', 'nodes'] as const) {
      const cursor = await r.open(request(kind), 2);
      expect((await r.read(cursor, 0, 200)).hits.map((hit) => hit.id)).toEqual([101, 102]);
      r.release(cursor);
    }
    expect(vacuumCompleted).toBe(false);
  } finally {
    await cleanup();
  }
});

it('actual compact runtime vectors exclude canonical source-bearing revisions', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': `- [ ] needle\n  - > ${'x'.repeat(1_048_576)}` },
    DEFAULT_SETTINGS,
  );
  const root = expectDefined(h.index.list()[0]);
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  for (const file of h.index.searchSource().files()) {
    await runtime.mutate({ type: 'begin', path: file.path });
    await runtime.mutate({ type: 'add', documents: [...h.index.searchSource().documents(file)] });
    await runtime.mutate({ type: 'commit', path: file.path });
  }
  await runtime.mutate({ type: 'publish', generation: 1 });
  await runtime.open({ ...request('nodes'), kind: 'nodes', matchScope: 'subtree' }, 1);
  const vectors = (runtime as unknown as { vectors: Map<string, unknown> }).vectors;
  expect(vectors.size).toBe(1);
  assertNoRevision(structuredClone([...vectors.values()]), root.ref.revision);
  runtime.dispose();
  h.close();
});

it('releases a service allocation by its reserved ID before open delivery', async () => {
  const runtime = await ready();
  const pending = runtime.open(request('nodes'), 1, 'reserved');
  runtime.release({ id: 'reserved', generation: 1, total: 0, kind: 'nodes', access: 'random' });
  const cursor = await pending;
  await expect(runtime.read(cursor, 0, 1)).rejects.toMatchObject({ code: 'cursor-expired' });
  expect((runtime as unknown as { vectors: Map<string, unknown> }).vectors.size).toBe(0);
  runtime.dispose();
});

it.each([
  { kind: 'nodes', matchScope: 'invalid' },
  { kind: 'roots', matchScope: 'subtree' },
  { kind: 'roots', matchScope: 'node' },
])('rejects invalid runtime scope %j', async (invalid) => {
  const r = await ready();
  try {
    await expect(
      r.open({ ...request('nodes'), ...invalid } as unknown as Parameters<typeof r.open>[0], 1),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  } finally {
    r.dispose();
  }
});

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
async function install(runtime: TaskSearchRuntime, id: number, title = 'needle') {
  await runtime.mutate({ type: 'begin', path: 'a.md' });
  await runtime.mutate({
    type: 'add',
    documents: nodeDocuments(1).map((doc) => ({ ...doc, id, rootId: id, title })),
  });
  await runtime.mutate({ type: 'commit', path: 'a.md' });
  await runtime.mutate({ type: 'publish', generation: id });
}

it('keeps the radix iterator and published cursors valid until incremental vacuum finishes', async ({
  onTestFinished,
}) => {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  const failures: unknown[] = [];
  runtime.subscribeFailure((cause) => failures.push(cause));
  onTestFinished(async () => {
    try {
      await vi.runAllTimersAsync();
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });
  vi.useFakeTimers();
  const title = ['scope', ...Array.from({ length: 1000 }, (_, i) => `z${i}`)].join(' ');
  await install(runtime, 1, title);
  await install(runtime, 2, title);
  // Hold MiniSearch's actual first default incremental batch timer, without replacing vacuum.
  expect(vi.getTimerCount()).toBe(1);
  const scope = { ...request('nodes'), query: prepareSearchQuery('scope', fallbackSearchWords) };
  const old = await runtime.open(scope, 2);
  let settled = false;
  const mutation = runtime.mutate({ type: 'begin', path: 'b.md' }).then(async () => {
    await runtime.mutate({
      type: 'add',
      documents: nodeDocuments(1).map((doc) => ({
        ...doc,
        id: 3,
        rootId: 3,
        title: 'sandbox',
        order: { ...doc.order, filePath: 'b.md' },
      })),
    });
    await runtime.mutate({ type: 'commit', path: 'b.md' });
    settled = true;
  });
  const outcome = mutation.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(settled).toBe(false);
  const retained = await runtime.read(old, 0, 10).then(
    (batch) => batch.hits.map((hit) => hit.id),
    (error: unknown) => error,
  );
  expect.soft(retained).toEqual([2]);
  const fresh = await runtime.open(scope, 2).then(
    (cursor) => cursor.total,
    (error: unknown) => error,
  );
  expect.soft(fresh).toBe(1);
  await vi.runAllTimersAsync();
  expect(await outcome).toBeUndefined();
  await runtime.mutate({ type: 'publish', generation: 3 });
  for (const [query, expected] of [
    ['scope', [2]],
    ['sandbox', [3]],
  ] as const) {
    const cursor = await runtime.open(
      { ...scope, query: prepareSearchQuery(query, fallbackSearchWords) },
      3,
    );
    expect((await runtime.read(cursor, 0, 10)).hits.map((hit) => hit.id)).toEqual(expected);
  }
  await expect(runtime.read(old, 0, 10)).rejects.toMatchObject({ code: 'stale' });
  expect(failures).toEqual([]);
});

async function heldMaintenance() {
  const engine = createMiniSearchTaskEngine(fallbackSearchWords);
  const runtime = new TaskSearchRuntime(engine);
  const finish = deferred<Error | undefined>();
  onTestFinished(() => {
    runtime.dispose();
    finish.resolve(undefined);
  });
  await install(runtime, 1);
  vi.spyOn(engine, 'vacuum').mockReturnValue(
    finish.promise.then((error) => {
      if (error !== undefined) throw error;
    }),
  );
  await install(runtime, 2);
  return { engine, runtime, finish };
}

it.each(['begin', 'add', 'commit', 'remove'] as const)(
  'keeps %s and publication untouched while maintenance is pending',
  async (type) => {
    const h = await heldMaintenance();
    const cursor = await h.runtime.open(request('nodes'), 2);
    const documents = nodeDocuments(1).map((doc) => ({ ...doc, id: 3, rootId: 3 }));
    const operation: TaskSearchMutation =
      type === 'add' ? { type, documents } : { type, path: 'a.md' };
    let completed = false;
    const pending = h.runtime.mutate(operation).then(() => {
      completed = true;
    });
    const outcome = pending.catch((error: unknown) => error);
    await flushMicrotasks();
    expect(completed).toBe(false);
    expect((await h.runtime.read(cursor, 0, 10)).hits.map((hit) => hit.id)).toEqual([2]);
    expect(h.engine.search(request('nodes')).map((hit) => hit.id)).toEqual([2]);
    h.finish.resolve(undefined);
    expect(await outcome).toBeUndefined();
    if (type === 'begin') await h.runtime.mutate({ type: 'commit', path: 'a.md' });
    await h.runtime.mutate({ type: 'publish', generation: 3 });
    const next = await h.runtime.open(request('nodes'), 3);
    const expected = { begin: [], add: [2, 3], commit: [2], remove: [] }[type];
    expect((await h.runtime.read(next, 0, 10)).hits.map((hit) => hit.id)).toEqual(expected);
    await expect(h.runtime.read(cursor, 0, 10)).rejects.toMatchObject({ code: 'stale' });
  },
);

it.each(['resolve', 'reject'] as const)(
  'disposal rejects a waiting mutation before late maintenance %s',
  async (settlement) => {
    const h = await heldMaintenance();
    const failures: unknown[] = [];
    h.runtime.subscribeFailure((cause) => failures.push(cause));
    const begin = vi.spyOn(h.engine, 'replaceBegin');
    let outcome: unknown = 'pending';
    const pending = h.runtime.mutate({ type: 'begin', path: 'b.md' }).then(
      () => {
        outcome = 'completed';
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    h.runtime.dispose();
    await flushMicrotasks();
    expect(outcome).toMatchObject({ code: 'disposed' });
    expect(begin).not.toHaveBeenCalled();
    if (settlement === 'resolve') h.finish.resolve(undefined);
    else h.finish.resolve(new Error('private late maintenance failure'));
    await flushMicrotasks();
    await pending;
    expect(begin).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  },
);

it('makes maintenance failure terminal and rejects waiting and subsequent operations safely', async () => {
  const h = await heldMaintenance();
  const failures: unknown[] = [];
  h.runtime.subscribeFailure((cause) => failures.push(cause));
  const cursor = await h.runtime.open(request('nodes'), 2);
  const begin = vi.spyOn(h.engine, 'replaceBegin');
  const pending = h.runtime
    .mutate({ type: 'begin', path: 'b.md' })
    .catch((error: unknown) => error);
  h.finish.resolve(new Error('private maintenance content'));
  const error: unknown = await pending;
  expect(error).toMatchObject({ code: 'unavailable' });
  expect(String(error)).not.toContain('private');
  expect(begin).not.toHaveBeenCalled();
  expect(failures).toHaveLength(1);
  for (const operation of [
    { type: 'begin', path: 'a.md' },
    { type: 'add', documents: nodeDocuments(1) },
    { type: 'commit', path: 'a.md' },
    { type: 'remove', path: 'a.md' },
    { type: 'publish', generation: 3 },
  ] as const)
    await expect(h.runtime.mutate(operation)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(h.runtime.open(request('nodes'), 2)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(h.runtime.read(cursor, 0, 10)).rejects.toMatchObject({ code: 'unavailable' });
  expect(failures).toHaveLength(1);
});
