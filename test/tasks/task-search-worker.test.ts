import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type {
  TaskSearchMessage,
  TaskSearchReply,
} from '../../src/tasks/application/TaskSearchBackend';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { TaskSearchError } from '../../src/tasks/domain/taskSearchTypes';
import {
  BrowserTaskSearchBackend,
  createBrowserSearchScheduler,
} from '../../src/tasks/infrastructure/search/BrowserTaskSearchBackend';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { TaskSearchService } from '../../src/tasks/infrastructure/search/TaskSearchService';
import { decodeTaskSearchRequest } from '../../src/tasks/infrastructure/search/taskSearch.worker';
import { expectDefined } from '../helpers';
import {
  assertNoRevision,
  ControlledSearchScheduler,
  createCanonicalSearchHarness,
  nodeDocuments,
} from '../support/taskSearchHarness';

class ControlledWorker {
  static readonly instances: ControlledWorker[] = [];
  static readonly settings = { autoReady: true };
  readonly outgoing: unknown[] = [];
  readonly incoming: unknown[] = [];
  readonly runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  onmessage: ((event: { data: TaskSearchReply }) => void) | undefined;
  onerror: ((event: { preventDefault(): void }) => void) | undefined;
  onmessageerror: (() => void) | undefined;
  terminated = false;
  private queue = Promise.resolve();
  constructor(readonly url: string) {
    ControlledWorker.instances.push(this);
  }
  reply(reply: TaskSearchReply): void {
    this.incoming.push(structuredClone(reply));
    this.onmessage?.({ data: structuredClone(reply) });
  }
  postMessage(value: TaskSearchMessage): void {
    const message = structuredClone(value);
    this.outgoing.push(message);
    this.queue = this.queue.then(async () => {
      if (message.type === 'init') {
        if (ControlledWorker.settings.autoReady)
          this.reply({ type: 'ready', epoch: message.epoch });
        return;
      }
      let result: Extract<TaskSearchReply, { type: 'success' }>['value'];
      try {
        switch (message.type) {
          case 'mutate':
            await this.runtime.mutate(message.operation);
            break;
          case 'open':
            result = await this.runtime.open(message.request, message.generation);
            break;
          case 'read':
            result = await this.runtime.read(message.cursor, message.offset, message.limit);
            break;
          case 'release':
            this.runtime.release(message.cursor);
            break;
        }
        this.reply({ type: 'success', epoch: message.epoch, id: message.id, value: result });
      } catch (error) {
        this.reply({
          type: 'failure',
          epoch: message.epoch,
          id: message.id,
          code: error instanceof TaskSearchError ? error.code : 'unavailable',
          message: 'Search operation failed',
        });
      }
    });
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
  expect((await service.resolvePage(page.hits, signal))[0]?.task.root.ref.revision).toBe(
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
