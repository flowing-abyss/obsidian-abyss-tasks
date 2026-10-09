import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskSearchState } from '../../src/tasks';
import type { TaskSearchBackend } from '../../src/tasks/application/TaskSearchBackend';
import { fallbackSearchWords } from '../../src/tasks/domain/searchMatchPolicy';
import { TaskSearchError } from '../../src/tasks/domain/taskSearchTypes';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from '../../src/tasks/infrastructure/search/TaskSearchService';
import { deferred, expectDefined } from '../helpers';
import {
  assertNoRevision,
  canonicalSearchForIndex,
  ControlledSearchScheduler,
  createCanonicalSearchHarness,
  createTaskSearchHarness,
  FakeSearchSource,
  nodeDocuments,
} from '../support/taskSearchHarness';
const signal = () => new AbortController().signal;
describe('owned incremental search service', () => {
  it('keeps final random page alive and isolates another cursor', async () => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(95)]);
    const a = new AbortController(),
      b = new AbortController();
    const first = await h.service.open({ kind: 'nodes', query: 'needle' }, a.signal);
    const second = await h.service.open({ kind: 'roots', query: 'needle' }, b.signal);
    await h.service.read(first, 90, 30, a.signal);
    await h.service.read(first, 60, 30, a.signal);
    expect(h.backends[0]?.searchCalls).toBe(2);
    b.abort();
    await expect(h.service.read(second, 0, 30, signal())).rejects.toMatchObject({
      code: 'aborted',
    });
    expect((await h.service.read(first, 0, 30, a.signal)).hits).toHaveLength(30);
    a.abort();
    h.service.dispose();
  });
  it('empty browse creates no engine', async () => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(95)]);
    const roots = await h.service.open({ kind: 'roots', query: '' }, signal());
    expect(roots.total).toBe(0);
    const nodes = await h.service.open({ kind: 'nodes', query: '' }, signal());
    expect(nodes.total).toBe(95);
    expect((await h.service.read(nodes, 90, 30, signal())).hits).toHaveLength(5);
    expect((await h.service.read(nodes, 60, 30, signal())).hits).toHaveLength(30);
    expect(h.backends).toHaveLength(0);
    h.service.dispose();
  });
  it('before/after ready and initialization failure', async () => {
    const h = createTaskSearchHarness();
    const waiting = h.service.open({ kind: 'roots', query: 'needle' }, signal());
    h.source.ready([nodeDocuments(2)]);
    expect((await waiting).total).toBe(2);
    h.source.fail(new Error('Source failed'));
    await expect(
      h.service.open({ kind: 'roots', query: 'needle' }, signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    h.service.dispose();
  });
  it('updates one file only and invalidates old cursors synchronously', async () => {
    const h = createTaskSearchHarness();
    const other = nodeDocuments(1).map((d) => ({
      ...d,
      id: 100,
      rootId: 100,
      order: { ...d.order, filePath: 'b.md' },
    }));
    h.source.ready([nodeDocuments(2), other]);
    const old = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
    h.source.iterations.length = 0;
    h.source.replace(
      'a.md',
      nodeDocuments(1).map((d) => ({ ...d, id: 200, rootId: 200 })),
    );
    await expect(h.service.read(old, 0, 30, signal())).rejects.toMatchObject({ code: 'stale' });
    expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(2);
    expect(h.source.iterations).toEqual(['a.md']);
    h.service.dispose();
  });
  it('abort old queued request before backend', async () => {
    const h = createTaskSearchHarness();
    const a = new AbortController();
    const waiting = h.service.open({ kind: 'roots', query: 'needle' }, a.signal);
    a.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    expect(h.backends).toHaveLength(0);
    h.service.dispose();
  });
  it('same service across panel close', async () => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(3)]);
    for (let i = 0; i < 5; i++) {
      const c = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
      h.service.release(c);
    }
    expect(h.backends).toHaveLength(1);
    expect(h.source.iterations).toEqual(['a.md']);
    h.service.dispose();
  });
  it('keeps canonical source-bearing revisions out of actual compact transport; no list/listNodes', async () => {
    const h = await createCanonicalSearchHarness(
      { 'a.md': `- [ ] needle\n  - > ${'x'.repeat(1_048_576)}` },
      DEFAULT_SETTINGS,
    );
    const root = expectDefined(h.index.list()[0]);
    expect(root.ref.revision.length).toBeGreaterThan(1_048_576);
    const list = vi.spyOn(h.index, 'list'),
      listNodes = vi.spyOn(h.index, 'listNodes');
    const source = h.index.searchSource();
    for (const file of source.files())
      assertNoRevision(structuredClone([...source.documents(file)]), root.ref.revision);
    const c = await h.search.open({ kind: 'roots', query: 'needle' }, signal());
    const page = await h.search.read(c, 0, 50, signal());
    assertNoRevision(structuredClone(page.hits), root.ref.revision);
    for await (const batch of h.index.organization({ expectedGeneration: c.generation }, signal()))
      assertNoRevision(JSON.parse(JSON.stringify(batch)), root.ref.revision);
    expect((await h.search.resolveHits(page.hits, signal()))[0]?.task.root.ref.revision).toBe(
      root.ref.revision,
    );
    expect(list).not.toHaveBeenCalled();
    expect(listNodes).not.toHaveBeenCalled();
    h.close();
  });
});

it('per-read abort does not consume a forward page owned by another signal', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(95)]);
  const cursor = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const readSignal = new AbortController();
  const reading = h.service.read(cursor, 0, 30, readSignal.signal);
  readSignal.abort();
  await expect(reading).rejects.toMatchObject({ code: 'aborted' });
  expect((await h.service.read(cursor, 0, 10, signal())).hits).toHaveLength(10);
  expect((await h.service.read(cursor, 10, 50, signal())).hits).toHaveLength(20);
  expect((await h.service.read(cursor, 30, 30, signal())).hits).toHaveLength(30);
  h.service.dispose();
});
it('semantic publish without text rebuild', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(2)]);
  const old = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  h.source.iterations.length = 0;
  h.source.emit({ type: 'semantics', generation: old.generation + 1, semanticsRevision: 1 });
  await expect(h.service.read(old, 0, 30, signal())).rejects.toMatchObject({ code: 'stale' });
  expect((await h.service.open({ kind: 'nodes', query: 'needle' }, signal())).total).toBe(2);
  expect(h.source.iterations).toEqual([]);
  h.service.dispose();
});
it('two batches max; giant one alone', async () => {
  const h = createTaskSearchHarness();
  const docs = nodeDocuments(400);
  docs[130] = { ...expectDefined(docs[130]), description: 'x'.repeat(300000) };
  h.source.ready([docs]);
  await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const adds = expectDefined(h.backends[0]).operations.filter((op) => op.type === 'add');
  expect(adds.every((op) => op.documents.length <= 128)).toBe(true);
  expect(
    adds.find((op) => op.documents.some((d) => d.description.length > 262144))?.documents,
  ).toHaveLength(1);
  expect(adds.flatMap((op) => op.documents).map((d) => d.id)).toEqual(docs.map((d) => d.id));
  h.service.dispose();
});
it('one crash recovery and repeated worker failure falls back; dirty replay retained', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(2)]);
  await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  expectDefined(h.backends[0]).crash();
  h.source.replace(
    'a.md',
    nodeDocuments(3).map((d) => ({ ...d, id: d.id + 10, rootId: d.rootId + 10 })),
  );
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  expect(h.backends).toHaveLength(2);
  expectDefined(h.backends[1]).crash();
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  expect(h.backends).toHaveLength(3);
  expectDefined(h.backends[2]).crash();
  await expect(h.service.open({ kind: 'roots', query: 'needle' }, signal())).rejects.toMatchObject({
    code: 'unavailable',
  });
  vi.spyOn(h.scheduler, 'now').mockReturnValue(100_000);
  await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  h.service.dispose();
});
it('fifth vector evicts least recent across main browse and worker and no requery', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(5)]);
  const first = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  for (let i = 0; i < 4; i++) await h.service.open({ kind: 'nodes', query: '' }, signal());
  await expect(h.service.read(first, 0, 1, signal())).rejects.toMatchObject({
    code: 'cursor-expired',
  });
  expect(h.backends[0]?.searchCalls).toBe(1);
  h.service.dispose();
});
it('canonical unrelated update preserves hydration while result cursors reject stale; reload rejects handles', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] needle', 'b.md': '- [ ] other' },
    DEFAULT_SETTINGS,
  );
  const cursor = await h.search.open({ kind: 'nodes', query: 'needle' }, signal());
  const hits = (await h.search.read(cursor, 0, 30, signal())).hits;
  h.index.installCommittedContent('b.md', '- [ ] replacement');
  expect((await h.search.resolveHits(hits, signal()))[0]?.task.node.title).toBe('needle');
  await expect(h.search.read(cursor, 0, 30, signal())).rejects.toMatchObject({ code: 'stale' });
  h.index.installCommittedContent('a.md', '');
  h.index.installCommittedContent('a.md', '- [ ] needle');
  await expect(h.search.resolveHits(hits, signal())).rejects.toMatchObject({ code: 'stale' });
  const fresh = await h.search.open({ kind: 'nodes', query: 'needle' }, signal());
  const freshHits = (await h.search.read(fresh, 0, 30, signal())).hits;
  expect((await h.search.resolveHits(freshHits, signal()))[0]?.task.node.title).toBe('needle');
  h.close();
  const reload = await createCanonicalSearchHarness({ 'a.md': '- [ ] needle' }, DEFAULT_SETTINGS);
  await expect(reload.search.resolveHits(freshHits, signal())).rejects.toMatchObject({
    code: 'stale',
  });
  reload.close();
});

it('bootstrap file edit rename delete exclusion dirty replay', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(260)]);
  h.scheduler.hold();
  const old = h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const resolved = expect(old).resolves.toMatchObject({ total: 3 });
  // Bootstrap has crossed the backend boundary before the accepted file is superseded.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  h.source.replace('a.md', []);
  h.source.replace(
    'renamed.md',
    nodeDocuments(3).map((d) => ({
      ...d,
      id: d.id + 1000,
      rootId: d.rootId + 1000,
      order: { ...d.order, filePath: 'renamed.md' },
    })),
  );
  await h.scheduler.flush();
  await resolved;
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  h.source.store.delete('renamed.md');
  h.source.emit({
    type: 'files',
    semanticsRevision: h.source.state.semanticsRevision,
    generation: h.source.state.generation + 1,
    files: [{ path: 'renamed.md', version: null }],
  });
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(0);
  h.service.dispose();
});
it('mid-query update cannot publish', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(2)]);
  await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const backend = expectDefined(h.backends[0]);
  const open = backend.open.bind(backend);
  let finish: (() => void) | undefined;
  vi.spyOn(backend, 'open').mockImplementation(async (...args) => {
    const c = await open(...args);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return c;
  });
  const old = h.service.open({ kind: 'roots', query: 'needle' }, signal());
  for (let i = 0; i < 20; i++) await Promise.resolve();
  h.source.replace('a.md', []);
  finish?.();
  await expect(old).rejects.toMatchObject({ code: 'stale' });
  h.service.dispose();
});

it('old service cursor cannot alias a new service cursor after reload', async () => {
  const old = createTaskSearchHarness();
  old.source.ready([nodeDocuments(2)]);
  const cursor = await old.service.open({ kind: 'nodes', query: 'needle' }, signal());
  old.service.dispose();
  const fresh = createTaskSearchHarness();
  fresh.source.ready([nodeDocuments(2)]);
  await fresh.service.open({ kind: 'nodes', query: 'needle' }, signal());
  await expect(fresh.service.read(cursor, 0, 1, signal())).rejects.toMatchObject({
    code: 'cursor-expired',
  });
  fresh.service.dispose();
});

it('later ordinary input starts a new failure episode with sanitized diagnostics', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(2)]);
  const options = (
    h.service as unknown as {
      options: { createBackend: () => Promise<unknown>; diagnose: (value: unknown) => void };
    }
  ).options;
  const factory = vi
    .spyOn(options, 'createBackend')
    .mockRejectedValue(new Error('private task and query text'));
  const diagnose = vi.spyOn(options, 'diagnose');
  const states: unknown[] = [];
  h.service.subscribe((state) => {
    states.push(state);
  });
  await expect(h.service.open({ kind: 'roots', query: 'private' }, signal())).rejects.toMatchObject(
    { code: 'unavailable' },
  );
  vi.spyOn(h.scheduler, 'now').mockReturnValue(100_000);
  await expect(h.service.open({ kind: 'roots', query: 'private' }, signal())).rejects.toMatchObject(
    { code: 'unavailable' },
  );
  expect(factory).toHaveBeenCalledTimes(4);
  expect(states).toContainEqual(expect.objectContaining({ phase: 'failed', episode: 2 }));
  expect(JSON.stringify(diagnose.mock.calls)).not.toContain('private');
  h.service.dispose();
});
it('rejects megabyte paste before creating a backend and preserves explicit file scope', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([
    nodeDocuments(2),
    nodeDocuments(1).map((d) => ({
      ...d,
      id: 10,
      rootId: 10,
      order: { ...d.order, filePath: 'b.md' },
    })),
  ]);
  await expect(
    h.service.open({ kind: 'roots', query: 'x'.repeat(1_048_576) }, signal()),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  expect(h.backends).toHaveLength(0);
  expect(
    (await h.service.open({ kind: 'nodes', query: '', filePath: 'b.md' }, signal())).total,
  ).toBe(1);
  expect(
    (await h.service.open({ kind: 'roots', query: 'needle', filePath: 'b.md' }, signal())).total,
  ).toBe(1);
  h.service.dispose();
});

it('accepted edits remain dirty in a failed episode until later ordinary input replays all files', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([
    nodeDocuments(2),
    nodeDocuments(1).map((d) => ({
      ...d,
      id: 10,
      rootId: 10,
      order: { ...d.order, filePath: 'b.md' },
    })),
  ]);
  for (let i = 0; i < 3; i++) {
    await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
    expectDefined(h.backends[i]).crash();
  }
  h.source.replace(
    'a.md',
    nodeDocuments(4).map((d) => ({ ...d, id: d.id + 100, rootId: d.rootId + 100 })),
  );
  await expect(h.service.open({ kind: 'roots', query: 'needle' }, signal())).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(h.backends).toHaveLength(3);
  vi.spyOn(h.scheduler, 'now').mockReturnValue(100_000);
  await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(5);
  h.service.dispose();
});

it('serializes delivery of concurrent forward reads and retains an aborted final page', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(35)]);
  const owner = new AbortController();
  const c = await h.service.open({ kind: 'roots', query: 'needle' }, owner.signal);
  const results = await Promise.allSettled([
    h.service.read(c, 0, 30, signal()),
    h.service.read(c, 0, 30, signal()),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'invalid-request' } });
  const read = new AbortController();
  const last = h.service.read(c, 30, 30, read.signal);
  read.abort();
  await expect(last).rejects.toMatchObject({ code: 'aborted' });
  const delivered = await h.service.read(c, 30, 30, signal());
  expect(delivered.hits).toHaveLength(5);
  expect(delivered.done).toBe(true);
  await expect(h.service.read(c, 35, 30, signal())).rejects.toMatchObject({
    code: 'cursor-expired',
  });
  expect(h.backends[0]?.searchCalls).toBe(1);
  owner.abort();
  h.service.dispose();
});

it('keeps the global LRU authoritative after a cancelled random read', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(10)]);
  const cursors = [];
  for (let i = 0; i < 4; i++)
    cursors.push(await h.service.open({ kind: 'nodes', query: 'needle' }, signal()));
  const oldest = expectDefined(cursors[0]),
    second = expectDefined(cursors[1]);
  const abort = new AbortController();
  const pending = h.service.read(oldest, 0, 1, abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  await expect(h.service.read(oldest, 0, 1, signal())).rejects.toMatchObject({
    code: 'cursor-expired',
  });
  expect((await h.service.read(second, 0, 1, signal())).hits).toHaveLength(1);
  h.service.dispose();
});

it('allocates concurrent backend opens within the global four-vector budget', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(10)]);
  const cursors = await Promise.all(
    Array.from({ length: 7 }, () => h.service.open({ kind: 'nodes', query: 'needle' }, signal())),
  );
  for (const c of cursors.slice(0, 3))
    await expect(h.service.read(c, 0, 1, signal())).rejects.toMatchObject({
      code: 'cursor-expired',
    });
  for (const c of cursors.slice(3))
    expect((await h.service.read(c, 0, 1, signal())).hits).toHaveLength(1);
  expect(h.backends[0]?.searchCalls).toBe(7);
  h.service.dispose();
});

function retainedVectors(h: ReturnType<typeof createTaskSearchHarness>): number {
  const browse = (h.service as unknown as { browse: Map<string, unknown> }).browse.size;
  return (
    browse +
    h.backends.reduce(
      (sum, backend) =>
        sum + (backend as unknown as { vectors: Map<string, unknown> }).vectors.size,
      0,
    )
  );
}

it.each(['evict', 'abort', 'recover', 'stale', 'dispose'] as const)(
  'reserves mixed allocation capacity and releases a held runtime allocation on %s',
  async (action) => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(10)]);
    for (let i = 0; i < 4; i++) await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
    const backend = expectDefined(h.backends[0]);
    const allocated = deferred<void>();
    const delivery = deferred<void>();
    const open = backend.open.bind(backend);
    vi.spyOn(backend, 'open').mockImplementationOnce(async (...args) => {
      const cursor = await open(...args);
      allocated.resolve();
      await delivery.promise;
      return cursor;
    });
    const owner = new AbortController();
    const pending = h.service.open({ kind: 'nodes', query: 'needle' }, owner.signal);
    const outcome = pending.catch((error: unknown) => error);
    await allocated.promise;
    expect(retainedVectors(h)).toBe(4);
    if (action === 'evict') {
      for (let i = 0; i < 4; i++) {
        await h.service.open({ kind: 'nodes', query: '' }, signal());
        expect(retainedVectors(h)).toBeLessThanOrEqual(4);
      }
    } else if (action === 'abort') owner.abort();
    else if (action === 'recover') backend.crash();
    else if (action === 'stale') h.source.replace('a.md', nodeDocuments(5));
    else h.service.dispose();
    // Release must address the real vector even before its transport reply arrives.
    const vectors = (backend as unknown as { vectors: Map<string, unknown> }).vectors;
    expect(vectors.size).toBe(action === 'abort' ? 3 : 0);
    delivery.resolve();
    expect(await outcome).toMatchObject({
      code: {
        evict: 'cursor-expired',
        abort: 'aborted',
        recover: 'unavailable',
        stale: 'stale',
        dispose: 'disposed',
      }[action],
    });
    if (action !== 'dispose') {
      const fresh = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
      expect((await h.service.read(fresh, 0, 1, signal())).hits).toHaveLength(1);
      expect(retainedVectors(h)).toBeLessThanOrEqual(4);
    }
    h.service.dispose();
    expect(retainedVectors(h)).toBe(0);
  },
);

it('reserves concurrent canonical browse construction and cancels evicted partial vectors', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(256)]);
  h.scheduler.hold();
  const outcomes = Array.from({ length: 7 }, () =>
    h.service.open({ kind: 'nodes', query: '' }, signal()).catch((error: unknown) => error),
  );
  // Drain admission microtasks until every constructor reaches its held yield.
  for (let i = 0; i < 200 && h.source.iterations.length < 7; i++) await Promise.resolve();
  expect(h.source.iterations).toHaveLength(7);
  await h.scheduler.flush();
  const results = await Promise.all(outcomes);
  for (const result of results.slice(0, 3))
    expect(result).toMatchObject({ code: 'cursor-expired' });
  for (const result of results.slice(3)) expect(result).toMatchObject({ total: 256 });
  expect(retainedVectors(h)).toBe(4);
  expect(h.backends).toHaveLength(0);
  h.service.dispose();
  expect(retainedVectors(h)).toBe(0);
});

it('rejects a backend admission whose owner recovered while release acknowledgment was pending', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(10)]);
  for (let i = 0; i < 4; i++) await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  const backend = expectDefined(h.backends[0]);
  const releasing = deferred<void>();
  const ack = deferred<void>();
  const release = backend.release.bind(backend);
  vi.spyOn(backend as TaskSearchBackend, 'release').mockImplementationOnce((cursor) => {
    release(cursor);
    releasing.resolve();
    return ack.promise;
  });
  const pending = h.service
    .open({ kind: 'nodes', query: 'needle' }, signal())
    .catch((error: unknown) => error);
  await releasing.promise;
  backend.crash();
  ack.resolve();
  expect(await pending).toMatchObject({ code: 'unavailable' });
  const fresh = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  expect((await h.service.read(fresh, 0, 1, signal())).hits).toHaveLength(1);
  expect(retainedVectors(h)).toBeLessThanOrEqual(4);
  h.service.dispose();
});

it('bounds persistent failure bursts and passive preparation without a deadline wake', async () => {
  const h = createTaskSearchHarness();
  const now = vi.spyOn(h.scheduler, 'now').mockReturnValue(0);
  const ensure = vi.spyOn(h.source, 'ensureReady');
  h.source.fail(new Error('source unavailable'));
  const request = { kind: 'roots' as const, query: 'needle' };
  for (let i = 0; i < 100; i++)
    await expect(h.service.open(request, signal())).rejects.toMatchObject({ code: 'unavailable' });
  expect(ensure).not.toHaveBeenCalled();
  now.mockReturnValue(4999);
  await expect(h.service.open(request, signal())).rejects.toMatchObject({ code: 'unavailable' });
  now.mockReturnValue(5000);
  await expect(h.service.prepare(signal())).rejects.toMatchObject({ code: 'unavailable' });
  expect(ensure).not.toHaveBeenCalled();
  const outcomes = await Promise.allSettled([
    h.service.open(request, signal()),
    h.service.open(request, signal()),
  ]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected')
      expect(outcome.reason as unknown).toMatchObject({ code: 'unavailable' });
  }
  expect(ensure).toHaveBeenCalledTimes(1);
  now.mockReturnValue(10000);
  h.source.emit({ type: 'semantics', generation: 1, semanticsRevision: 1 });
  await Promise.resolve();
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(h.backends).toHaveLength(0);
  h.service.dispose();
});

it('shares one later backend recovery and one aborted caller cannot stop it', async () => {
  const h = createTaskSearchHarness();
  const now = vi.spyOn(h.scheduler, 'now').mockReturnValue(0);
  h.source.ready([nodeDocuments(2)]);
  const request = { kind: 'roots' as const, query: 'needle' };
  for (let i = 0; i < 3; i++) {
    await h.service.open(request, signal());
    expectDefined(h.backends[i]).crash();
  }
  for (let i = 0; i < 100; i++)
    await expect(h.service.open(request, signal())).rejects.toMatchObject({ code: 'unavailable' });
  expect(h.backends).toHaveLength(3);
  now.mockReturnValue(5000);
  await Promise.resolve();
  expect(h.backends).toHaveLength(3);
  h.scheduler.hold();
  const cancelled = new AbortController();
  const first = h.service.open(request, cancelled.signal);
  const aborted = expect(first).rejects.toMatchObject({ code: 'aborted' });
  const second = h.service.open(request, signal()).catch((error: unknown) => error);
  cancelled.abort();
  await aborted;
  await h.scheduler.flush();
  expect(await second).toMatchObject({ total: 2 });
  expect(h.backends).toHaveLength(4);
  h.service.dispose();
});

it('shares preparation with early input and captures the generation after dirty replay', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(260)]);
  h.scheduler.hold();
  const owner = new AbortController();
  const first = h.service.prepare(owner.signal);
  const aborted = expect(first).rejects.toMatchObject({ code: 'aborted' });
  const second = h.service.prepare(signal());
  const query = h.service.open({ kind: 'roots', query: 'needle' }, signal());
  for (let i = 0; i < 20; i++) await Promise.resolve();
  h.source.replace('a.md', nodeDocuments(3));
  owner.abort();
  await aborted;
  await h.scheduler.flush();
  await second;
  expect(await query).toMatchObject({ total: 3, generation: h.source.state.generation });
  expect(h.backends).toHaveLength(1);
  expect(h.backends[0]?.searchCalls).toBe(1);
  h.service.dispose();
});

it('same-generation ready notifications preserve cursors and do not replay files', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(3)]);
  const cursor = await h.service.open({ kind: 'nodes', query: 'needle' }, signal());
  const operations = h.backends[0]?.operations.length;
  h.source.iterations.length = 0;
  h.source.emit({ type: 'state', state: h.source.state });
  await h.service.prepare(signal());
  expect((await h.service.read(cursor, 0, 3, signal())).hits).toHaveLength(3);
  expect(h.source.iterations).toEqual([]);
  expect(h.backends[0]?.operations).toHaveLength(operations ?? -1);
  h.service.dispose();
});

it('wanted preparation resumes once on genuine failed-source readiness', async () => {
  const h = createTaskSearchHarness();
  h.source.fail(new Error('private source text'));
  await expect(h.service.prepare(signal())).rejects.toMatchObject({ code: 'unavailable' });
  h.source.ready([nodeDocuments(3)]);
  await h.service.prepare(signal());
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  expect(h.backends).toHaveLength(1);
  h.service.dispose();
});

it('disposal before a queued source recovery prevents initialization from restarting', async () => {
  const h = createTaskSearchHarness();
  const now = vi.spyOn(h.scheduler, 'now').mockReturnValue(0);
  const ensure = vi.spyOn(h.source, 'ensureReady');
  h.source.fail(new Error('source unavailable'));
  now.mockReturnValue(5000);
  const pending = h.service.open({ kind: 'roots', query: 'needle' }, signal());
  h.service.dispose();
  await expect(pending).rejects.toMatchObject({ code: 'disposed' });
  expect(ensure).not.toHaveBeenCalled();
  expect(h.backends).toHaveLength(0);
});

it('invalid then valid input retains the healthy index', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(3)]);
  await h.service.prepare(signal());
  h.source.iterations.length = 0;
  await expect(
    h.service.open({ kind: 'roots', query: 'x'.repeat(2049) }, signal()),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  expect(h.backends).toHaveLength(1);
  expect(h.source.iterations).toEqual([]);
  h.service.dispose();
});

it('synchronous disposal from recovery publication cannot restart the failed source', async () => {
  const h = createTaskSearchHarness();
  const now = vi.spyOn(h.scheduler, 'now').mockReturnValue(0);
  const ensure = vi.spyOn(h.source, 'ensureReady');
  h.source.fail(new Error('source unavailable'));
  h.service.subscribe((state) => {
    if (state.phase === 'recovering') h.service.dispose();
  });
  now.mockReturnValue(5000);
  await expect(h.service.open({ kind: 'roots', query: 'needle' }, signal())).rejects.toMatchObject({
    code: 'disposed',
  });
  expect(ensure).not.toHaveBeenCalled();
});

it.each(['open', 'read'] as const)(
  'recovers live %s failures once, falls back, then respects input cooldown',
  async (operation) => {
    const h = createTaskSearchHarness();
    const states: string[] = [];
    h.service.subscribe((state) => states.push(state.phase));
    vi.spyOn(h.scheduler, 'now').mockReturnValue(100);
    h.source.ready([nodeDocuments(3)]);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cursor = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
        const backend = expectDefined(h.backends[attempt]);
        vi.spyOn(backend, operation).mockRejectedValue(new Error('private field/path/query'));
        const pending =
          operation === 'open'
            ? h.service.open({ kind: 'roots', query: 'needle' }, signal())
            : h.service.read(cursor, 0, 1, signal());
        await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        expect(
          (h.service as unknown as { pendingBatches: Map<string, unknown> }).pendingBatches.size,
        ).toBe(0);
        expect((backend as unknown as { vectors: Map<string, unknown> }).vectors.size).toBe(0);
      }
      expect(states[states.length - 1]).toBe('failed');
      expect(h.backends).toHaveLength(3);
      vi.spyOn(h.scheduler, 'now').mockReturnValue(5099);
      await expect(
        h.service.open({ kind: 'roots', query: 'needle' }, signal()),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(h.backends).toHaveLength(3);
      vi.spyOn(h.scheduler, 'now').mockReturnValue(5100);
      const cursors = await Promise.all([
        h.service.open({ kind: 'nodes', query: 'needle' }, signal()),
        h.service.open({ kind: 'nodes', query: 'needle' }, signal()),
      ]);
      expect(cursors.map((cursor) => cursor.total)).toEqual([3, 3]);
      expect(h.backends).toHaveLength(4);
    } finally {
      h.service.dispose();
    }
  },
);

it.each(['open', 'read'] as const)(
  'keeps expected %s rejection outcomes quiet and sanitized',
  async (operation) => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(3)]);
    try {
      for (const code of [
        'aborted',
        'stale',
        'invalid-request',
        'invalid-query',
        'cursor-expired',
      ] as const) {
        const cursor = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
        const backend = expectDefined(h.backends[0]);
        vi.spyOn(backend, operation).mockRejectedValueOnce(
          new TaskSearchError(code, 'private field/path/query'),
        );
        const pending =
          operation === 'open'
            ? h.service.open({ kind: 'roots', query: 'needle' }, signal())
            : h.service.read(cursor, 0, 1, signal());
        const error: unknown = await pending.catch((error: unknown) => error);
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain('private');
        expect(h.backends).toHaveLength(1);
        h.service.release(cursor);
      }
    } finally {
      h.service.dispose();
    }
  },
);

it.each(['aborted', 'stale', 'replaced', 'released'] as const)(
  'does not let a late read failure recover a %s request',
  async (stop) => {
    const h = createTaskSearchHarness();
    h.source.ready([nodeDocuments(3)]);
    const caller = new AbortController();
    const cursor = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
    const backend = expectDefined(h.backends[0]);
    const held = deferred<void>();
    vi.spyOn(backend, 'read').mockImplementationOnce(async () => {
      await held.promise;
      throw new Error('private obsolete backend');
    });
    const pending = h.service.read(cursor, 0, 1, caller.signal).catch((error: unknown) => error);
    if (stop === 'aborted') caller.abort();
    if (stop === 'stale') h.source.replace('a.md', nodeDocuments(4));
    if (stop === 'replaced') backend.crash();
    if (stop === 'released') h.service.release(cursor);
    await h.service.prepare(signal());
    held.resolve();
    expect(await pending).toMatchObject({
      code: {
        replaced: 'unavailable',
        released: 'cursor-expired',
        aborted: 'aborted',
        stale: 'stale',
      }[stop],
    });
    expect(h.backends).toHaveLength(stop === 'replaced' ? 2 : 1);
    const next = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
    expect((await h.service.read(next, 0, 10, signal())).hits).toHaveLength(
      stop === 'stale' ? 4 : 3,
    );
    h.service.dispose();
  },
);

it('recovers one shared failed forward page for a live waiter after the first waiter aborts', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(3)]);
  const cursor = await h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const held = deferred<void>();
  vi.spyOn(expectDefined(h.backends[0]), 'read').mockImplementationOnce(async () => {
    await held.promise;
    throw new Error('private read failure');
  });
  const cancelled = new AbortController();
  const old = h.service.read(cursor, 0, 1, cancelled.signal).catch((error: unknown) => error);
  cancelled.abort();
  expect(await old).toMatchObject({ code: 'aborted' });
  const live = h.service.read(cursor, 0, 1, signal()).catch((error: unknown) => error);
  held.resolve();
  expect(await live).toMatchObject({ code: 'unavailable' });
  await h.service.prepare(signal());
  expect(h.backends).toHaveLength(2);
  h.service.dispose();
});

it('treats a raw cancellation-shaped inline engine exception as a live operational failure', async () => {
  const source = new FakeSearchSource();
  source.ready([nodeDocuments(2)]);
  const engine = createMiniSearchTaskEngine(fallbackSearchWords);
  const states: unknown[] = [];
  const diagnostics: unknown[] = [];
  const service = new TaskSearchService({
    source,
    reads: {
      observedTags: () => [],
      async *organization() {},
      matchesSearchAddress: () => false,
      resolveSearchHits: async () => [],
    },
    segment: fallbackSearchWords,
    scheduler: new ControlledSearchScheduler(),
    createBackend: async (mode) => {
      if (mode === 'worker') throw new Error('Worker unavailable');
      return new TaskSearchRuntime(engine);
    },
    diagnose: (value) => {
      diagnostics.push(value);
    },
  });
  service.subscribe((state) => {
    states.push(state);
  });
  try {
    await service.prepare(signal());
    expect(states).toContainEqual({
      phase: 'ready',
      generation: 1,
      semanticsRevision: 0,
      compatibility: true,
    });
    vi.spyOn(engine, 'search').mockImplementation(() => {
      throw new DOMException('private engine content', 'AbortError');
    });
    const error: unknown = await service
      .open({ kind: 'roots', query: 'needle' }, signal())
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(states[states.length - 1]).toEqual({
      phase: 'failed',
      generation: 1,
      semanticsRevision: 0,
      episode: 1,
    });
    expect(String(error)).not.toContain('private');
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  } finally {
    service.dispose();
  }
});

it('carries the source semantics revision through subscription, recovery, failure and disposal without rebuilding on semantics', async () => {
  const h = await createCanonicalSearchHarness({ 'a.md': '- [ ] needle' }, DEFAULT_SETTINGS);
  const states: TaskSearchState[] = [];
  h.index.setStatusCatalog(h.statusCatalog);
  const unsubscribe = h.search.subscribe((state) => states.push(state));
  try {
    expect(states[states.length - 1]).toMatchObject({ phase: 'idle', semanticsRevision: 1 });
    const late = canonicalSearchForIndex(h.index);
    let lateState: TaskSearchState | undefined;
    const stopLate = late.subscribe((state) => {
      lateState = state;
    });
    expect(lateState).toMatchObject({ phase: 'idle', semanticsRevision: 1 });
    stopLate();
    late.dispose();
    await h.search.prepare(signal());
    const backend = expectDefined(h.backends[0]);
    const previousOperations = backend.operations.length;
    h.index.setStatusCatalog(h.statusCatalog);
    expect(states[states.length - 1]).toMatchObject({ phase: 'updating', semanticsRevision: 2 });
    await h.search.prepare(signal());
    expect(backend.operations.slice(previousOperations).map((op) => op.type)).toEqual(['publish']);
    h.index.installCommittedContent('other.md', '- [ ] Other');
    await h.search.prepare(signal());
    expect(states[states.length - 1]).toMatchObject({ phase: 'ready', semanticsRevision: 2 });
    for (let i = 0; i < 2; i++) {
      expectDefined(h.backends[h.backends.length - 1]).crash();
      expect(states[states.length - 1]).toMatchObject({
        phase: 'recovering',
        semanticsRevision: 2,
      });
      await h.search.prepare(signal());
    }
    expectDefined(h.backends[h.backends.length - 1]).crash();
    expect(states[states.length - 1]).toMatchObject({ phase: 'failed', semanticsRevision: 2 });
    h.index.setStatusCatalog(h.statusCatalog);
    expect(states[states.length - 1]).toMatchObject({ phase: 'failed', semanticsRevision: 3 });
    vi.spyOn(h.scheduler, 'now').mockReturnValue(performance.now() + 6000);
    await h.search.open({ kind: 'roots', query: 'needle' }, signal());
    expect(states[states.length - 1]).toMatchObject({ phase: 'ready', semanticsRevision: 3 });
    h.close();
    expect(states[states.length - 1]).toMatchObject({ phase: 'disposed', semanticsRevision: 3 });
    expect(states.every((state) => Number.isInteger(state.semanticsRevision))).toBe(true);
  } finally {
    unsubscribe();
    h.close();
  }
});
