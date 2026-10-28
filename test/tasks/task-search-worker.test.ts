import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type {
  TaskSearchBackend,
  TaskSearchMessage,
  TaskSearchReply,
} from '../../src/tasks/application/TaskSearchBackend';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import {
  BrowserTaskSearchBackend,
  createBrowserSearchScheduler,
} from '../../src/tasks/infrastructure/search/BrowserTaskSearchBackend';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from '../../src/tasks/infrastructure/search/TaskSearchService';
import {
  createTaskSearchWorkerHandler,
  decodeTaskSearchRequest,
} from '../../src/tasks/infrastructure/search/TaskSearchWorkerHandler';
import { deferred, expectDefined } from '../helpers';
import {
  assertNoRevision,
  ControlledSearchScheduler,
  createCanonicalSearchHarness,
  FakeSearchSource,
  nodeDocuments,
} from '../support/taskSearchHarness';

class ControlledWorker {
  static readonly instances: ControlledWorker[] = [];
  static readonly settings = { autoReady: true };
  readonly outgoing: unknown[] = [];
  readonly incoming: unknown[] = [];
  readonly engine = createMiniSearchTaskEngine(fallbackSearchWords);
  readonly runtime = new TaskSearchRuntime(this.engine);
  private readonly receive: ReturnType<typeof createTaskSearchWorkerHandler>;
  private readonly processing: Array<Promise<void>> = [];
  private readonly heldOpenIds = new Set<number>();
  onmessage: ((event: { data: TaskSearchReply }) => void) | undefined;
  onerror: ((event: { preventDefault(): void }) => void) | undefined;
  onmessageerror: (() => void) | undefined;
  terminated = false;
  holdOpens = false;
  holdReleases = false;
  readonly releasing = deferred<void>();
  readonly releaseGate = deferred<void>();
  readonly held: TaskSearchReply[] = [];
  readonly allocated = deferred<void>();
  async flush(): Promise<void> {
    await Promise.all(this.processing);
  }
  constructor(readonly url: string) {
    ControlledWorker.instances.push(this);
    const backend: TaskSearchBackend = {
      mutate: (operation) => this.runtime.mutate(operation),
      open: (request, generation, allocationId) =>
        this.runtime.open(request, generation, allocationId),
      read: (cursor, offset, limit) => this.runtime.read(cursor, offset, limit),
      release: async (cursor) => {
        if (this.holdReleases) {
          this.releasing.resolve();
          await this.releaseGate.promise;
        }
        this.runtime.release(cursor);
      },
      subscribeFailure: (listener) => this.runtime.subscribeFailure(listener),
      dispose: () => {
        this.runtime.dispose();
      },
    };
    this.receive = createTaskSearchWorkerHandler(backend, (reply) => {
      if (this.terminated) return;
      if (
        (reply.type === 'ready' && !ControlledWorker.settings.autoReady) ||
        (reply.type === 'success' && this.heldOpenIds.delete(reply.id))
      ) {
        this.held.push(structuredClone(reply));
        if (reply.type === 'success') this.allocated.resolve();
      } else this.reply(reply);
    });
  }
  reply(reply: TaskSearchReply): void {
    if (this.terminated) return;
    this.incoming.push(structuredClone(reply));
    this.onmessage?.({ data: structuredClone(reply) });
  }
  postMessage(value: TaskSearchMessage): void {
    if (this.terminated) return;
    const message = structuredClone(value);
    this.outgoing.push(message);
    if (message.type === 'open' && this.holdOpens) this.heldOpenIds.add(message.id);
    this.processing.push(this.receive(message));
  }
  terminate(): void {
    this.terminated = true;
    this.runtime.dispose();
  }
}
const revoked: string[] = [];
beforeEach(() => {
  ControlledWorker.instances.length = 0;
  ControlledWorker.settings.autoReady = true;
  revoked.length = 0;
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL(): string {
        return `blob:fixture-${ControlledWorker.instances.length}`;
      }
      static override revokeObjectURL(url: string): void {
        revoked.push(url);
      }
    },
  );
});
afterEach(() => {
  for (const worker of ControlledWorker.instances) worker.terminate();
  vi.useRealTimers();
});
it('keeps read behind a mutation and continues after operation rejection', async ({
  onTestFinished,
}) => {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  const replies: TaskSearchReply[] = [];
  const receive = createTaskSearchWorkerHandler(runtime, (reply) => replies.push(reply));
  const gate = deferred<Error | undefined>();
  onTestFinished(() => {
    gate.resolve(undefined);
    runtime.dispose();
  });
  const mutate = vi.spyOn(runtime, 'mutate').mockImplementationOnce(() =>
    gate.promise.then((error) => {
      if (error !== undefined) throw error;
    }),
  );
  const read = vi.spyOn(runtime, 'read');
  await receive({ epoch: 4, id: 0, type: 'init' });
  const first = receive({
    epoch: 4,
    id: 1,
    type: 'mutate',
    operation: { type: 'publish', generation: 1 },
  });
  const second = receive({
    epoch: 4,
    id: 2,
    type: 'read',
    offset: 0,
    limit: 1,
    cursor: { id: 'absent', generation: 1, total: 1, kind: 'nodes', access: 'random' },
  });
  await Promise.resolve();
  expect(mutate).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  gate.resolve(new Error('private note contents'));
  await first;
  await second;
  expect(read).toHaveBeenCalledOnce();
  expect(replies).toContainEqual({
    epoch: 4,
    id: 1,
    type: 'failure',
    code: 'unavailable',
    message: 'Search operation failed',
  });
  expect(replies).toContainEqual({
    epoch: 4,
    id: 2,
    type: 'failure',
    code: 'stale',
    message: 'Search operation failed',
  });
  expect(JSON.stringify(replies)).not.toContain('private note contents');
  await receive({ epoch: 4, id: 3, type: 'mutate', operation: { type: 'publish', generation: 2 } });
  expect(replies).toContainEqual({ epoch: 4, id: 3, type: 'success', value: undefined });
});

it('ignores malformed, pre-init, wrong-epoch and duplicate-init requests', async ({
  onTestFinished,
}) => {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  onTestFinished(() => {
    runtime.dispose();
  });
  const replies: TaskSearchReply[] = [];
  const receive = createTaskSearchWorkerHandler(runtime, (reply) => replies.push(reply));
  const mutate = vi.spyOn(runtime, 'mutate');
  const open = vi.spyOn(runtime, 'open');
  const read = vi.spyOn(runtime, 'read');
  const release = vi.spyOn(runtime, 'release');
  await receive({ epoch: 4, id: 1, type: 'open', request: 'bad' });
  await receive({ epoch: 4, id: 2, type: 'mutate', operation: { type: 'publish', generation: 1 } });
  await receive({ epoch: 4, id: 0, type: 'init' });
  await receive({ epoch: 5, id: 3, type: 'mutate', operation: { type: 'publish', generation: 2 } });
  await receive({ epoch: 5, id: 0, type: 'init' });
  await receive({ epoch: 5, id: 4, type: 'mutate', operation: { type: 'publish', generation: 3 } });
  expect(mutate).not.toHaveBeenCalled();
  await receive({ epoch: 4, id: 5, type: 'mutate', operation: { type: 'publish', generation: 4 } });
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: 'publish', generation: 4 });
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(replies).toEqual([
    { epoch: 4, type: 'ready' },
    { epoch: 4, id: 5, type: 'success', value: undefined },
  ]);
});

it('rejects malformed protocol requests before runtime', () => {
  expect(
    decodeTaskSearchRequest({ epoch: 1, id: 1, type: 'open', request: 'bad' }),
  ).toBeUndefined();
  expect(
    decodeTaskSearchRequest({
      epoch: 1,
      id: 1,
      type: 'mutate',
      operation: { type: 'publish', generation: 1 },
    }),
  ).toEqual({ epoch: 1, id: 1, type: 'mutate', operation: { type: 'publish', generation: 1 } });
});
it('does not coerce malformed fuzzy edit counts in protocol tokens', () => {
  for (const edits of ['1', null, false, {}, 3])
    expect(
      decodeTaskSearchRequest({
        epoch: 1,
        id: 1,
        type: 'open',
        generation: 1,
        request: {
          kind: 'roots',
          includeSourcePath: false,
          query: {
            original: 'needle',
            tokens: [{ term: 'needle', edits, prefix: false, swaps: [] }],
          },
        },
      }),
    ).toBeUndefined();
});
it('accepts only primitive strings at every protocol string field', () => {
  const open = {
    epoch: 1,
    id: 1,
    type: 'open',
    generation: 1,
    allocationId: 'reserved',
    request: {
      kind: 'nodes',
      includeSourcePath: false,
      filePath: 'a.md',
      preferFilePath: 'a.md',
      query: {
        original: 'needle',
        tokens: [{ term: 'needle', edits: 1, prefix: false, swaps: ['other'] }],
      },
    },
  };
  const add = {
    epoch: 1,
    id: 1,
    type: 'mutate',
    operation: { type: 'add', documents: nodeDocuments(1) },
  };
  const fields: Array<{ message: unknown; path: Array<string | number>; optional?: boolean }> = [
    { message: open, path: ['allocationId'], optional: true },
    { message: open, path: ['request', 'filePath'], optional: true },
    { message: open, path: ['request', 'preferFilePath'], optional: true },
    { message: open, path: ['request', 'query', 'original'] },
    { message: open, path: ['request', 'query', 'tokens', 0, 'term'] },
    { message: open, path: ['request', 'query', 'tokens', 0, 'swaps', 0] },
    { message: add, path: ['operation', 'documents', 0, 'order', 'filePath'] },
    ...['title', 'description', 'comments', 'tags', 'metadata', 'links', 'sourcePath'].map(
      (field) => ({
        message: add,
        path: ['operation', 'documents', 0, field],
      }),
    ),
    {
      message: { epoch: 1, id: 1, type: 'mutate', operation: { type: 'begin', path: 'a.md' } },
      path: ['operation', 'path'],
    },
    {
      message: {
        epoch: 1,
        id: 1,
        type: 'release',
        cursor: { id: 'vector', generation: 1, total: 0, kind: 'nodes', access: 'random' },
      },
      path: ['cursor', 'id'],
    },
  ];
  const values: Array<{ value: unknown; required: boolean; optional: boolean }> = [
    { value: '', required: true, optional: true },
    { value: 'text', required: true, optional: true },
    { value: undefined, required: false, optional: true },
    { value: null, required: false, optional: false },
    { value: 1, required: false, optional: false },
    { value: false, required: false, optional: false },
    { value: Object('text'), required: false, optional: false },
    { value: {}, required: false, optional: false },
    { value: [], required: false, optional: false },
  ];
  for (const field of fields) {
    for (const entry of values) {
      const message = structuredClone(field.message) as Record<string | number, unknown>;
      let parent = message;
      for (const key of field.path.slice(0, -1))
        parent = parent[key] as Record<string | number, unknown>;
      parent[expectDefined(field.path[field.path.length - 1])] = entry.value;
      expect(decodeTaskSearchRequest(message) !== undefined, field.path.join('.')).toBe(
        field.optional === true ? entry.optional : entry.required,
      );
    }
  }
});

it('URL revoked on failure and unload; idle error notifies service', async () => {
  const backend = await BrowserTaskSearchBackend.create('source');
  const failure = vi.fn();
  backend.subscribeFailure(failure);
  const worker = expectDefined(ControlledWorker.instances[0]);
  worker.onerror?.({ preventDefault() {} });
  expect(failure).toHaveBeenCalledOnce();
  expect(worker.terminated).toBe(true);
  expect(revoked).toEqual([worker.url]);
  backend.dispose();
  expect(revoked).toHaveLength(1);
  const second = await BrowserTaskSearchBackend.create('source');
  second.dispose();
  expect(revoked).toHaveLength(2);
});
it('startup times out at 5000ms and revokes failed URL', async () => {
  vi.useFakeTimers();
  ControlledWorker.settings.autoReady = false;
  const starting = BrowserTaskSearchBackend.create('source');
  const rejected = expect(starting).rejects.toMatchObject({ code: 'unavailable' });
  await vi.advanceTimersByTimeAsync(4999);
  expect(revoked).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(revoked).toHaveLength(1);
  expect(ControlledWorker.instances[0]?.terminated).toBe(true);
});
it('late old-epoch reply ignored', async () => {
  ControlledWorker.settings.autoReady = false;
  const starting = BrowserTaskSearchBackend.create('source');
  const worker = expectDefined(ControlledWorker.instances[0]);
  const init = worker.outgoing[0] as TaskSearchMessage;
  let ready = false;
  void starting.then(
    () => {
      ready = true;
    },
    () => {},
  );
  worker.reply({ type: 'ready', epoch: init.epoch - 1 });
  await Promise.resolve();
  expect(ready).toBe(false);
  worker.reply({ type: 'ready', epoch: init.epoch });
  const backend = await starting;
  backend.dispose();
});
it('actual browser backend messages keep canonical source-bearing revisions out', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': `- [ ] needle\n  - > ${'x'.repeat(1_048_576)}` },
    DEFAULT_SETTINGS,
  );
  const root = expectDefined(h.index.list()[0]);
  h.search.dispose();
  const service = new TaskSearchService({
    source: h.index.searchSource(),
    reads: h.index,
    segment: fallbackSearchWords,
    scheduler: new ControlledSearchScheduler(),
    createBackend: () => BrowserTaskSearchBackend.create('source'),
    diagnose: () => {},
  });
  const signal = new AbortController().signal;
  const cursor = await service.open({ kind: 'roots', query: 'needle' }, signal);
  const page = await service.read(cursor, 0, 50, signal);
  const worker = expectDefined(ControlledWorker.instances[0]);
  assertNoRevision(worker.outgoing, root.ref.revision);
  assertNoRevision(worker.incoming, root.ref.revision);
  assertNoRevision(page.hits, root.ref.revision);
  expect((await service.resolveHits(page.hits, signal))[0]?.task.root.ref.revision).toBe(
    root.ref.revision,
  );
  service.dispose();
  h.close();
});
it('messageerror rejects pending requests and terminates before replacement', async () => {
  const backend = await BrowserTaskSearchBackend.create('source');
  const mutation = backend.mutate({ type: 'add', documents: nodeDocuments(2) });
  expectDefined(ControlledWorker.instances[0]).onmessageerror?.();
  await expect(mutation).rejects.toMatchObject({ code: 'unavailable' });
  expect(ControlledWorker.instances[0]?.terminated).toBe(true);
});
it('roundtrips structured-cloned numeric hits', async () => {
  const backend = await BrowserTaskSearchBackend.create('source');
  await backend.mutate({ type: 'begin', path: 'a.md' });
  await backend.mutate({ type: 'add', documents: nodeDocuments(2) });
  await backend.mutate({ type: 'commit', path: 'a.md' });
  await backend.mutate({ type: 'publish', generation: 1 });
  const cursor = await backend.open(
    {
      kind: 'roots',
      query: prepareSearchQuery('needle', fallbackSearchWords),
      includeSourcePath: false,
    },
    1,
  );
  const page = await backend.read(cursor, 0, 30);
  expect(page.hits.map((hit) => hit.id)).toEqual([1, 2]);
  backend.dispose();
});

it('cooperative browser yield closes both owned message ports on cancellation', async () => {
  let closed = 0;
  vi.stubGlobal(
    'MessageChannel',
    class {
      readonly port1 = {
        onmessage: null,
        close() {
          closed++;
        },
      };
      readonly port2 = {
        postMessage() {},
        close() {
          closed++;
        },
      };
    },
  );
  const controller = new AbortController();
  const yielding = createBrowserSearchScheduler().yield(controller.signal);
  controller.abort();
  await expect(yielding).rejects.toMatchObject({ code: 'aborted' });
  expect(closed).toBe(2);
});

it('bounds actual browser runtime plus canonical browse vectors while open delivery is held', async () => {
  const source = new FakeSearchSource();
  source.ready([nodeDocuments(10)]);
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
    createBackend: () => BrowserTaskSearchBackend.create('source'),
    diagnose: () => {},
  });
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++) await service.open({ kind: 'nodes', query: 'needle' }, signal);
  const worker = expectDefined(ControlledWorker.instances[0]);
  worker.holdOpens = true;
  const pending = service
    .open({ kind: 'nodes', query: 'needle' }, signal)
    .catch((error: unknown) => error);
  await worker.allocated.promise;
  for (let i = 0; i < 4; i++) {
    await service.open({ kind: 'nodes', query: '' }, signal);
    await worker.flush();
    const runtimeCount = (worker.runtime as unknown as { vectors: Map<string, unknown> }).vectors
      .size;
    const browseCount = (service as unknown as { browse: Map<string, unknown> }).browse.size;
    expect(runtimeCount + browseCount).toBeLessThanOrEqual(4);
  }
  expect(await pending).toMatchObject({ code: 'cursor-expired' });
  expect((worker.runtime as unknown as { vectors: Map<string, unknown> }).vectors.size).toBe(0);
  for (const reply of worker.held) worker.reply(reply);
  await worker.flush();
  service.dispose();
});

it.each(['service', 'source', 'source-failure'] as const)(
  'cancels actual browser startup resources immediately on %s lifecycle stop',
  async (stop) => {
    vi.useFakeTimers();
    ControlledWorker.settings.autoReady = false;
    const source = new FakeSearchSource();
    source.ready([nodeDocuments(2)]);
    const started = deferred<void>();
    const modes: string[] = [];
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
      createBackend: (mode, signal) => {
        modes.push(mode);
        const result = BrowserTaskSearchBackend.create('source', signal);
        started.resolve();
        return result;
      },
      diagnose: () => {},
    });
    const pending = service.open({ kind: 'nodes', query: 'needle' }, new AbortController().signal);
    const outcome = pending.catch((error: unknown) => error);
    await started.promise;
    const worker = expectDefined(ControlledWorker.instances[0]);
    const init = worker.outgoing[0] as TaskSearchMessage;
    expect(vi.getTimerCount()).toBe(1);
    if (stop === 'service') service.dispose();
    else if (stop === 'source') source.dispose();
    else source.fail(new Error('private source text'));
    expect(worker.terminated).toBe(true);
    expect(revoked).toEqual([worker.url]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await outcome).toMatchObject({
      code: stop === 'source-failure' ? 'unavailable' : 'disposed',
    });
    worker.reply({ type: 'ready', epoch: init.epoch });
    await worker.flush();
    expect(modes).toEqual(['worker']);
    expect(revoked).toHaveLength(1);
    service.dispose();
  },
);

it('panel query cancellation leaves shared browser startup and bootstrap alive', async () => {
  ControlledWorker.settings.autoReady = false;
  const source = new FakeSearchSource();
  source.ready([nodeDocuments(2)]);
  const started = deferred<void>();
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
    createBackend: (_mode, signal) => {
      const result = BrowserTaskSearchBackend.create('source', signal);
      started.resolve();
      return result;
    },
    diagnose: () => {},
  });
  const panel = new AbortController();
  const pending = service.open({ kind: 'nodes', query: 'needle' }, panel.signal);
  const outcome = pending.catch((error: unknown) => error);
  await started.promise;
  const worker = expectDefined(ControlledWorker.instances[0]);
  panel.abort();
  expect(await outcome).toMatchObject({ code: 'aborted' });
  expect(worker.terminated).toBe(false);
  expect(revoked).toHaveLength(0);
  const init = worker.outgoing[0] as TaskSearchMessage;
  worker.reply({ type: 'ready', epoch: init.epoch });
  const cursor = await service.open(
    { kind: 'nodes', query: 'needle' },
    new AbortController().signal,
  );
  expect(cursor.total).toBe(2);
  expect(ControlledWorker.instances).toHaveLength(1);
  expect(source.iterations).toEqual(['a.md']);
  service.dispose();
  expect(worker.terminated).toBe(true);
  expect(revoked).toEqual([worker.url]);
});

it('does not reuse worker capacity for browse until actual release is acknowledged', async () => {
  const source = new FakeSearchSource();
  source.ready([nodeDocuments(10)]);
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
    createBackend: () => BrowserTaskSearchBackend.create('source'),
    diagnose: () => {},
  });
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++) await service.open({ kind: 'nodes', query: 'needle' }, signal);
  const worker = expectDefined(ControlledWorker.instances[0]);
  worker.holdReleases = true;
  const browse = service.open({ kind: 'nodes', query: '' }, signal);
  await worker.releasing.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const runtimeCount = (worker.runtime as unknown as { vectors: Map<string, unknown> }).vectors
    .size;
  const browseCount = (service as unknown as { browse: Map<string, unknown> }).browse.size;
  expect(runtimeCount).toBe(4);
  expect(runtimeCount + browseCount).toBe(4);
  worker.releaseGate.resolve();
  expect((await browse).total).toBe(10);
  service.dispose();
});

it('cancellable startup cleans constructor failure and allocates nothing for an already stopped run', async () => {
  vi.useFakeTimers();
  const stopped = new AbortController();
  stopped.abort();
  await expect(BrowserTaskSearchBackend.create('source', stopped.signal)).rejects.toMatchObject({
    code: 'aborted',
  });
  expect(ControlledWorker.instances).toHaveLength(0);
  expect(revoked).toHaveLength(0);
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('private startup detail');
      }
    },
  );
  const active = new AbortController();
  await expect(BrowserTaskSearchBackend.create('source', active.signal)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(revoked).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  active.abort();
  expect(revoked).toHaveLength(1);
});

it('ready followed by lifecycle cancellation cannot return a disposed startup as success', async () => {
  ControlledWorker.settings.autoReady = false;
  const run = new AbortController();
  const starting = BrowserTaskSearchBackend.create('source', run.signal);
  const worker = expectDefined(ControlledWorker.instances[0]);
  const init = worker.outgoing[0] as TaskSearchMessage;
  worker.reply({ type: 'ready', epoch: init.epoch });
  run.abort();
  await expect(starting).rejects.toMatchObject({ code: 'aborted' });
  expect(worker.terminated).toBe(true);
  expect(revoked).toEqual([worker.url]);
});

it.each(['open', 'read'] as const)(
  'recovers a request-specific Worker %s failure without a crash notification',
  async (operation) => {
    const source = new FakeSearchSource();
    source.ready([nodeDocuments(3)]);
    const diagnostics: unknown[] = [];
    const crashes = vi.fn();
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
      createBackend: async () => {
        const backend = await BrowserTaskSearchBackend.create('source');
        backend.subscribeFailure(crashes);
        return backend;
      },
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });
    const signal = new AbortController().signal;
    try {
      const cursor = await service.open({ kind: 'roots', query: 'needle' }, signal);
      const worker = expectDefined(ControlledWorker.instances[0]);
      vi.spyOn(worker.runtime, operation).mockRejectedValue(new Error('private authored content'));
      await expect(
        operation === 'open'
          ? service.open({ kind: 'roots', query: 'needle' }, signal)
          : service.read(cursor, 0, 1, signal),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(crashes).not.toHaveBeenCalled();
      expect(worker.terminated).toBe(true);
      expect(
        worker.incoming.some(
          (reply) =>
            (reply as TaskSearchReply).type === 'failure' && (reply as { id: number }).id > 0,
        ),
      ).toBe(true);
      const next = await service.open({ kind: 'roots', query: 'needle' }, signal);
      expect((await service.read(next, 0, 10, signal)).hits).toHaveLength(3);
      expect(ControlledWorker.instances).toHaveLength(2);
      expect(diagnostics).toHaveLength(1);
      expect(JSON.stringify(diagnostics)).not.toContain('private');
    } finally {
      service.dispose();
    }
  },
);

it.each([
  ['nodes', undefined, true],
  ['nodes', 'node', true],
  ['nodes', 'subtree', true],
  ['nodes', 'invalid', false],
  ['nodes', null, false],
  ['roots', 'node', false],
  ['roots', 'subtree', false],
] as const)('validates worker scope %s/%s', (kind, matchScope, accepted) => {
  const message = {
    epoch: 1,
    id: 1,
    type: 'open',
    generation: 1,
    request: {
      kind,
      matchScope,
      query: prepareSearchQuery('needle', fallbackSearchWords),
      includeSourcePath: false,
    },
  };
  expect(decodeTaskSearchRequest(message) !== undefined).toBe(accepted);
});
it('round-trips subtree scope and numeric results with inline parity', async () => {
  const backend = await BrowserTaskSearchBackend.create('source');
  const inline = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  try {
    const docs = nodeDocuments(3).map((doc, index) => ({
      ...doc,
      rootId: 1,
      title: ['Parent', 'Alpha', 'Beta'][index] ?? '',
      comments: index === 2 ? 'commentneedle' : '',
      order: { filePath: 'a.md', line: 0, childLines: [1, 2].slice(0, index) },
    }));
    for (const target of [backend, inline]) {
      await target.mutate({ type: 'begin', path: 'a.md' });
      await target.mutate({ type: 'add', documents: docs });
      await target.mutate({ type: 'commit', path: 'a.md' });
      await target.mutate({ type: 'publish', generation: 1 });
    }
    const request = {
      kind: 'nodes',
      matchScope: 'subtree',
      query: prepareSearchQuery('commentneedle', fallbackSearchWords),
      includeSourcePath: false,
    } as const;
    const remote = await backend.open(request, 1);
    const local = await inline.open(request, 1);
    const hits = (await backend.read(remote, 0, 32)).hits;
    expect(hits.map((hit) => hit.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(hits).toEqual((await inline.read(local, 0, 32)).hits);
    expect(remote).toMatchObject({ kind: 'nodes', access: 'random' });
    expect(
      ControlledWorker.instances[0]?.outgoing.some(
        (message) => decodeTaskSearchRequest(message)?.type === 'open',
      ),
    ).toBe(true);
  } finally {
    backend.dispose();
    inline.dispose();
  }
});

it('keeps reads behind a waiting Worker mutation in FIFO order', async ({ onTestFinished }) => {
  const backend = await BrowserTaskSearchBackend.create('source');
  const worker = expectDefined(ControlledWorker.instances[0]);
  const finish = deferred<Error | undefined>();
  onTestFinished(() => {
    backend.dispose();
    finish.resolve(undefined);
  });
  for (const generation of [1, 2]) {
    if (generation === 2)
      vi.spyOn(worker.engine, 'vacuum').mockReturnValue(
        finish.promise.then((error) => {
          if (error !== undefined) throw error;
        }),
      );
    await backend.mutate({ type: 'begin', path: 'a.md' });
    await backend.mutate({ type: 'add', documents: nodeDocuments(1) });
    await backend.mutate({ type: 'commit', path: 'a.md' });
    await backend.mutate({ type: 'publish', generation });
  }
  const cursor = await backend.open(
    {
      kind: 'nodes',
      query: prepareSearchQuery('needle', fallbackSearchWords),
      includeSourcePath: false,
    },
    2,
  );
  let mutated = false;
  let readOutcome: unknown = 'pending';
  const mutation = backend
    .mutate({ type: 'remove', path: 'a.md' })
    .then(() => {
      mutated = true;
    })
    .catch((error: unknown) => error);
  const reading = backend.read(cursor, 0, 10).then(
    (batch) => {
      readOutcome = batch;
    },
    (error: unknown) => {
      readOutcome = error;
    },
  );
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(mutated).toBe(false);
  expect(readOutcome).toBe('pending');
  finish.resolve(undefined);
  expect(await mutation).toBeUndefined();
  await reading;
  expect(readOutcome).toMatchObject({ code: 'stale' });
  await backend.mutate({ type: 'publish', generation: 3 });
  const empty = await backend.open(
    {
      kind: 'nodes',
      query: prepareSearchQuery('needle', fallbackSearchWords),
      includeSourcePath: false,
    },
    3,
  );
  expect((await backend.read(empty, 0, 10)).hits).toEqual([]);
});

it('recovers a genuine maintenance failure through Worker id zero with one sanitized diagnostic', async ({
  onTestFinished,
}) => {
  const source = new FakeSearchSource();
  source.ready([nodeDocuments(1)]);
  const diagnostics: unknown[] = [];
  const finish = deferred<Error | undefined>();
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
    createBackend: async () => BrowserTaskSearchBackend.create('source'),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  onTestFinished(() => {
    service.dispose();
    finish.resolve(undefined);
  });
  const signal = new AbortController().signal;
  const old = await service.open({ kind: 'nodes', query: 'needle' }, signal);
  const worker = expectDefined(ControlledWorker.instances[0]);
  vi.spyOn(worker.engine, 'vacuum').mockReturnValue(
    finish.promise.then((error) => {
      if (error !== undefined) throw error;
    }),
  );
  source.replace('a.md', nodeDocuments(2));
  await service.prepare(signal);
  finish.resolve(new Error('private authored content'));
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  const next = await service.open({ kind: 'nodes', query: 'needle' }, signal);
  expect((await service.read(next, 0, 10, signal)).hits.map((hit) => hit.address.rootId)).toEqual([
    1, 2,
  ]);
  await expect(service.read(old, 0, 10, signal)).rejects.toMatchObject({ code: 'stale' });
  expect(worker.terminated).toBe(true);
  expect(ControlledWorker.instances).toHaveLength(2);
  expect(
    worker.incoming.filter(
      (reply) =>
        (reply as TaskSearchReply).type === 'failure' && (reply as { id: number }).id === 0,
    ),
  ).toEqual([
    {
      epoch: (worker.outgoing[0] as TaskSearchMessage).epoch,
      id: 0,
      type: 'failure',
      code: 'unavailable',
      message: 'Search maintenance failed',
    },
  ]);
  expect(JSON.stringify(worker.incoming)).not.toContain('private authored content');
  expect(diagnostics).toHaveLength(1);
  expect(JSON.stringify(diagnostics)).not.toContain('private');
});
