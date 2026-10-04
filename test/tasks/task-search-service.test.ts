import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskSearchBackend } from '../../src/tasks/application/TaskSearchBackend';
import { deferred, expectDefined } from '../helpers';
import {
  assertNoRevision,
  createCanonicalSearchHarness,
  createTaskSearchHarness,
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
    expect((await h.search.resolvePage(page.hits, signal()))[0]?.task.root.ref.revision).toBe(
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
  h.source.emit({ type: 'semantics', generation: old.generation + 1 });
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
  await h.service.retry();
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
  expect((await h.search.resolvePage(hits, signal()))[0]?.task.node.title).toBe('needle');
  await expect(h.search.read(cursor, 0, 30, signal())).rejects.toMatchObject({ code: 'stale' });
  h.index.installCommittedContent('a.md', '');
  h.index.installCommittedContent('a.md', '- [ ] needle');
  await expect(h.search.resolvePage(hits, signal())).rejects.toMatchObject({ code: 'stale' });
  const fresh = await h.search.open({ kind: 'nodes', query: 'needle' }, signal());
  const freshHits = (await h.search.read(fresh, 0, 30, signal())).hits;
  expect((await h.search.resolvePage(freshHits, signal()))[0]?.task.node.title).toBe('needle');
  h.close();
  const reload = await createCanonicalSearchHarness({ 'a.md': '- [ ] needle' }, DEFAULT_SETTINGS);
  await expect(reload.search.resolvePage(freshHits, signal())).rejects.toMatchObject({
    code: 'stale',
  });
  reload.close();
});

it('bootstrap file edit rename delete exclusion dirty replay', async () => {
  const h = createTaskSearchHarness();
  h.source.ready([nodeDocuments(260)]);
  h.scheduler.hold();
  const old = h.service.open({ kind: 'roots', query: 'needle' }, signal());
  const rejected = expect(old).rejects.toMatchObject({ code: 'stale' });
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
  await rejected;
  expect((await h.service.open({ kind: 'roots', query: 'needle' }, signal())).total).toBe(3);
  h.source.store.delete('renamed.md');
  h.source.emit({
    type: 'files',
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

it('failed explicit retry starts a new failure episode with sanitized diagnostics', async () => {
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
  await expect(h.service.retry()).rejects.toMatchObject({ code: 'unavailable' });
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

it('accepted edits remain dirty in a failed episode until explicit retry replays all files', async () => {
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
  await h.service.retry();
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

it('settles failed-source Retry in a new episode until canonical readiness and another Retry', async () => {
  const h = createTaskSearchHarness();
  const options = (h.service as unknown as { options: { diagnose: (value: unknown) => void } })
    .options;
  const diagnose = vi.spyOn(options, 'diagnose');
  const states: unknown[] = [];
  h.service.subscribe((state) => {
    states.push(state);
  });
  h.source.fail(new Error('private source and query text'));
  expect(states[states.length - 1]).toEqual({ phase: 'failed', generation: 0, episode: 1 });
  for (const episode of [2, 3]) {
    await expect(h.service.retry()).rejects.toMatchObject({ code: 'unavailable', episode });
    expect(states[states.length - 1]).toEqual({ phase: 'failed', generation: 0, episode });
  }
  expect(h.source.state.type).toBe('failed');
  expect(h.source.iterations).toEqual([]);
  expect(h.backends).toHaveLength(0);
  expect(diagnose.mock.calls).toHaveLength(3);
  for (const [diagnostic] of diagnose.mock.calls)
    expect(diagnostic).toMatchObject({
      phase: 'source',
      backend: 'worker',
      generation: 0,
      pathCount: 0,
      error: { code: 'unavailable' },
    });
  expect(JSON.stringify(diagnose.mock.calls)).not.toContain('private');
  h.source.ready([nodeDocuments(3)]);
  expect(states[states.length - 1]).toEqual({ phase: 'failed', generation: 1, episode: 3 });
  expect(h.backends).toHaveLength(0);
  await h.service.retry();
  expect(states[states.length - 1]).toMatchObject({ phase: 'ready', generation: 1 });
  expect((await h.service.open({ kind: 'nodes', query: 'needle' }, signal())).total).toBe(3);
  expect(h.source.iterations).toEqual(['a.md']);
  h.service.dispose();
  await expect(h.service.retry()).rejects.toMatchObject({ code: 'disposed' });
  expect(states[states.length - 1]).toEqual({ phase: 'disposed', generation: 1 });
  expect(diagnose.mock.calls).toHaveLength(3);
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
