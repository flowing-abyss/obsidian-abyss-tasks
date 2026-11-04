import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TasksApiV1 } from '../api';
import { createFixture } from '../tooling/performance/fixture.mts';
import { apiScenarios } from '../tooling/performance/native-api';
import type { Measure } from '../tooling/performance/native-scenarios';
import type { Host, NativeOptions } from '../tooling/performance/native-types';
import { expectDefined, flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
const folder = '__abyss_profile_fixture_v1__';
const path = `${folder}/inbox.md`;
const now = Date.UTC(2026, 7, 1, 12);
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.dispose();
});
async function setup(nodes = 101, files?: Record<string, string>) {
  const tasks = Array.from({ length: nodes }, (_, i) => `- [ ] Task ${i}`).join('\n');
  const h = await publicApiHarness(
    files ?? {
      [path]: `${tasks}\n`,
    },
    { index: { excludeSource: (source) => source.filePath.endsWith('/archive.md') } },
  );
  harnesses.push(h);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const real = h.client('abyss-performance-api');
  const off = vi.fn();
  let timed = false;
  const phases: string[] = [];
  const client: TasksApiV1 = {
    ...real,
    ready: (...args) => {
      expect(timed).toBe(false);
      phases.push('ready');
      return real.ready(...args);
    },
    tasks: {
      ...real.tasks,
      resolve: (...args) => {
        expect(timed).toBe(false);
        phases.push('resolve');
        return real.tasks.resolve(...args);
      },
      complete: (...args) => {
        expect(timed).toBe(true);
        phases.push('complete');
        return real.tasks.complete(...args);
      },
      get: (...args) => {
        expect(timed).toBe(true);
        phases.push('get');
        return real.tasks.get(...args);
      },
    },
    dispose: vi.fn(real.dispose),
    subscribe: (listener) => {
      expect(timed).toBe(false);
      phases.push('subscribe');
      const result = real.subscribe(listener);
      if (!result.ok) return result;
      return {
        ok: true,
        value: () => {
          off();
          result.value();
        },
      };
    },
  };
  const sequencing: string[] = [];
  const execute = vi.fn(async (input: Parameters<typeof h.service.execute>[0]) => {
    expect(timed).toBe(false);
    sequencing.push('create');
    phases.push('create');
    // Supply the host's configured default through the real service's explicit destination port.
    if (input.type !== 'create') throw new Error('Unexpected profile command');
    expect(input).toEqual({
      type: 'create',
      markdownBody: 'Profile API status sandbox',
      destination: { type: 'configured-default' },
    });
    return h.service.execute({
      ...input,
      destination: {
        type: 'explicit',
        destination: { filePath: path, insertion: { type: 'append' } },
      },
    });
  });
  const getApi = vi.fn(() => {
    expect(timed).toBe(false);
    phases.push('discover');
    return { ok: true as const, value: client };
  });
  const host = {
    vault: h.app.vault,
    metadataCache: h.app.metadataCache,
    plugins: { plugins: { 'abyss-tasks': { getApi, tasks: { execute }, queries: h.index } } },
  } as unknown as Host;
  const options: NativeOptions = {
    vault: 'dev-vault-tasks',
    fixtureFolder: folder,
    anchor: '2026-08-01',
    fixtureKind: 'standard',
    expectedRoots: nodes,
    expectedNodes: nodes,
    startup: false,
    api: true,
    viewport: '1024x768',
  };
  const facts: Record<string, Awaited<ReturnType<Parameters<Measure>[1]>>> = {};
  const measure: Measure = async (id, action, prepare) => {
    sequencing.push(`${id}:prepare`);
    await prepare?.();
    sequencing.push(`${id}:action`);
    timed = true;
    try {
      facts[id] = await action();
    } finally {
      timed = false;
    }
  };
  const list = vi.spyOn(client.tasks, 'list');
  list.mockImplementation(async (...args) => {
    expect(timed).toBe(true);
    phases.push('list');
    return real.tasks.list(...args);
  });
  return {
    h,
    real,
    client,
    host,
    options,
    measure,
    facts,
    sequencing,
    phases,
    off,
    execute,
    getApi,
    list,
  };
}

type Scenario = Awaited<ReturnType<typeof setup>>;
function holdCreationMetadata(s: Scenario) {
  const file = expectDefined(s.h.app.vault.getFileByPath(path));
  const trigger = s.h.app.metadataCache.trigger.bind(s.h.app.metadataCache);
  const held: Array<() => void> = [];
  const capture = vi
    .spyOn(s.h.app.metadataCache, 'trigger')
    .mockImplementation((event: string, ...args: unknown[]) => {
      if (event === 'changed' && args[0] === file) {
        held.push(() => {
          trigger(event, ...args);
        });
        return;
      }
      trigger(event, ...args);
    });
  let created = (): void => {};
  const creation = new Promise<void>((resolve) => {
    created = resolve;
  });
  const execute = expectDefined(s.execute.getMockImplementation());
  s.execute.mockImplementation(async (input) => {
    const result = await execute(input);
    created();
    return result;
  });
  const release = (): void => {
    capture.mockRestore();
    for (const emit of held.splice(0)) emit();
  };
  return { file, trigger, held, creation, release };
}
function preparationOwners(s: Scenario) {
  const metadata = vi.spyOn(s.h.app.metadataCache, 'offref');
  const ordinary = s.h.index.subscribe.bind(s.h.index);
  const reconciled = s.h.index.subscribeReconciled.bind(s.h.index);
  const off: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  vi.spyOn(s.h.index, 'subscribe').mockImplementation((listener) => {
    const close = vi.fn(ordinary(listener));
    off.push(close);
    return close;
  });
  vi.spyOn(s.h.index, 'subscribeReconciled').mockImplementation((listener) => {
    const close = vi.fn(reconciled(listener));
    off.push(close);
    return close;
  });
  return {
    assertClosed: () => {
      expect(metadata).toHaveBeenCalledOnce();
      expect(off).toHaveLength(2);
      for (const close of off) expect(close).toHaveBeenCalledOnce();
    },
  };
}

type Page = Extract<Awaited<ReturnType<TasksApiV1['tasks']['list']>>, { ok: true }>['value'];
function corruptPage(failure: string, pages: number, page: Page) {
  if (failure === 'duplicate')
    return {
      ok: true as const,
      value: { ...page, items: [expectDefined(page.items[0]), ...page.items] },
    };
  if (failure === 'order')
    return { ok: true as const, value: { ...page, items: [...page.items].reverse() } };
  if (failure === 'generation' && pages === 2)
    return { ok: true as const, value: { ...page, generation: page.generation + 1 } };
  if (failure === 'count')
    return { ok: true as const, value: { ...page, items: page.items.slice(1) } };
  if (failure === 'source')
    return {
      ok: true as const,
      value: {
        ...page,
        items: page.items.map((task) => ({ ...task, rawSource: 'not permitted' })),
      },
    };
  return { ok: true as const, value: page };
}

describe('canonical public API performance spans', () => {
  it.each(['held', 'wrong-content', 'other-file'] as const)(
    'waits for matching creation metadata before timing completion (%s)',
    async (kind) => {
      const s = await setup(1, { [path]: '- [ ] Task 0\n', [`${folder}/other.md`]: '' });
      const gate = holdCreationMetadata(s);
      const owners = preparationOwners(s);
      const complete = vi.spyOn(s.client.tasks, 'complete');
      const resolve = vi.spyOn(s.client.tasks, 'resolve');
      const work = apiScenarios(s.host, s.options, s.measure).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await gate.creation;
        await flushMicrotasks();
        expect(gate.held.length).toBeGreaterThan(0);
        if (kind === 'wrong-content') gate.trigger('changed', gate.file, '- [ ] Task 0\n', {});
        if (kind === 'other-file')
          gate.trigger(
            'changed',
            expectDefined(s.h.app.vault.getFileByPath(`${folder}/other.md`)),
            '',
            {},
          );
        await flushMicrotasks();
        expect(complete).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(s.sequencing).not.toContain('api.status:action');
        gate.release();
        expect(await work).toBeUndefined();
        expect(complete).toHaveBeenCalledTimes(2);
        expect(resolve).toHaveBeenCalledOnce();
        expect(s.facts['api.status']).toEqual({ writes: 1, requests: 2, replays: 1, hydrated: 1 });
        owners.assertClosed();
      } finally {
        gate.release();
        await work;
        await flushMicrotasks();
      }
    },
  );

  it('requires deferred canonical acceptance after the metadata observer with the index registered first', async () => {
    const s = await setup(1);
    const gate = holdCreationMetadata(s);
    const ordinary = s.h.index.subscribe.bind(s.h.index);
    const reconciled = s.h.index.subscribeReconciled.bind(s.h.index);
    const queued: Array<() => void> = [];
    let reconciledQueued = false;
    vi.spyOn(s.h.index, 'subscribe').mockImplementation((listener) =>
      ordinary((event) => {
        queued.push(() => {
          listener(event);
        });
      }),
    );
    vi.spyOn(s.h.index, 'subscribeReconciled').mockImplementation((listener) =>
      reconciled((files) => {
        reconciledQueued = true;
        queued.push(() => {
          listener(files);
        });
      }),
    );
    const work = apiScenarios(s.host, s.options, s.measure).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await gate.creation;
      await flushMicrotasks();
      for (const notify of queued.splice(0)) notify(); // early canonical creation publication has no echo stamp
      gate.release();
      await flushMicrotasks();
      expect(s.sequencing).not.toContain('api.status:action');
      expect(queued.length).toBeGreaterThan(0);
      expect(reconciledQueued).toBe(true);
      for (const notify of queued.splice(0)) notify();
      expect(await work).toBeUndefined();
    } finally {
      gate.release();
      for (const notify of queued.splice(0)) notify();
      await work;
    }
  });

  it('retains matching metadata and deferred acceptance delivered before creation returns', async () => {
    const s = await setup(1);
    const order: string[] = [];
    const meta = s.h.app.metadataCache.on('changed', (file) => {
      if (file.path === path) order.push('metadata');
    });
    const off = s.h.index.subscribeReconciled((files) => {
      if (files.includes(path)) order.push('canonical');
    });
    const changed = s.h.index.subscribe((event) => {
      if (event.type === 'changed' && event.files.includes(path)) order.push('canonical');
    });
    const execute = expectDefined(s.execute.getMockImplementation());
    s.execute.mockImplementation(async (input) => {
      const result = await execute(input);
      await flushMicrotasks();
      order.push('create-return');
      return result;
    });
    try {
      await apiScenarios(s.host, s.options, s.measure);
      expect(order.indexOf('metadata')).toBeLessThan(order.indexOf('create-return'));
      const beforeReturn = order.slice(0, order.indexOf('create-return'));
      expect(beforeReturn.indexOf('metadata')).toBeGreaterThanOrEqual(0);
      expect(beforeReturn.lastIndexOf('canonical')).toBeGreaterThan(
        beforeReturn.indexOf('metadata'),
      );
    } finally {
      s.h.app.metadataCache.offref(meta);
      off();
      changed();
    }
  });

  it('waits for exact cached bytes without changing the settled file or timing completion', async () => {
    const s = await setup(1);
    const gate = holdCreationMetadata(s);
    const owners = preparationOwners(s);
    const cached = s.h.app.vault.cachedRead.bind(s.h.app.vault);
    let stale = true;
    vi.spyOn(s.h.app.vault, 'cachedRead').mockImplementation((file) =>
      stale && file === gate.file ? Promise.resolve('old cache') : cached(file),
    );
    const work = apiScenarios(s.host, s.options, s.measure).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await gate.creation;
      gate.release();
      await flushMicrotasks();
      expect(s.phases).not.toContain('resolve');
      expect(s.phases).not.toContain('complete');
      stale = false;
      expect(await work).toBeUndefined();
      owners.assertClosed();
    } finally {
      stale = false;
      gate.release();
      await work;
    }
  });

  it('times out missing metadata without resolving or submitting completion and releases observers', async () => {
    const s = await setup(1);
    const gate = holdCreationMetadata(s);
    const owners = preparationOwners(s);
    vi.useFakeTimers();
    const work = apiScenarios(s.host, s.options, s.measure).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await gate.creation;
      await vi.advanceTimersByTimeAsync(30010);
      expect(String(await work)).toContain('Readiness timed out: API status sandbox');
      expect(s.phases).not.toContain('resolve');
      expect(s.phases).not.toContain('complete');
      owners.assertClosed();
      expect(s.off).toHaveBeenCalledOnce();
      expect(s.client.dispose).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await work;
      vi.useRealTimers();
    }
  });

  it('releases preparation observers when the outer measurement cancels pending preparation', async () => {
    const s = await setup(1);
    const gate = holdCreationMetadata(s);
    const owners = preparationOwners(s);
    let pending: Promise<unknown> = Promise.resolve();
    const measure: Measure = async (id, action, prepare) => {
      if (id !== 'api.status') {
        await s.measure(id, action, prepare);
        return;
      }
      pending = expectDefined(prepare)().catch((error: unknown) => error);
      await gate.creation;
      throw new Error('Profile preparation cancelled');
    };
    try {
      await expect(apiScenarios(s.host, s.options, measure)).rejects.toThrow(
        'Profile preparation cancelled',
      );
      owners.assertClosed();
      expect(String(await pending)).toContain('preparation cancelled');
      expect(s.phases).not.toContain('complete');
    } finally {
      gate.release();
      await pending;
    }
  });

  it('releases metadata and the first query observer if later observer registration fails', async () => {
    const s = await setup(1);
    const metadata = vi.spyOn(s.h.app.metadataCache, 'offref');
    const subscribe = s.h.index.subscribe.bind(s.h.index);
    const off = vi.fn<() => void>();
    vi.spyOn(s.h.index, 'subscribe').mockImplementation((listener) => {
      const release = subscribe(listener);
      off.mockImplementation(release);
      return off;
    });
    vi.spyOn(s.h.index, 'subscribeReconciled').mockImplementation(() => {
      throw new Error('observer unavailable');
    });
    await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow(
      'observer unavailable',
    );
    expect(metadata).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.client.dispose).toHaveBeenCalledOnce();
  });

  it.each(['create', 'resolve', 'read', 'identity', 'root', 'block'] as const)(
    'fails %s preparation proof and cleans observers',
    async (failure) => {
      const s = await setup(1);
      const owners = preparationOwners(s);
      if (failure === 'create') s.execute.mockResolvedValue({ type: 'invalid', issues: [] });
      if (failure === 'resolve')
        vi.spyOn(s.client.tasks, 'resolve').mockResolvedValue({
          ok: false,
          error: { category: 'unavailable', code: 'INCOMPLETE_READ', message: 'injected' },
        });
      const execute = expectDefined(s.execute.getMockImplementation());
      s.execute.mockImplementation(async (input) => {
        const result = await execute(input);
        if (failure === 'read')
          vi.spyOn(s.h.app.vault, 'read').mockRejectedValue(new Error('source read failed'));
        if (failure === 'block')
          vi.spyOn(s.h.app.vault, 'read').mockResolvedValue('replaced source');
        if (failure === 'identity') vi.spyOn(s.h.app.vault, 'getFileByPath').mockReturnValue(null);
        if (failure === 'root' && result.type === 'ok' && result.outcome.type === 'task')
          vi.spyOn(s.h.index, 'resolve').mockReturnValue({
            type: 'not-found',
            ref: result.outcome.task.ref,
          });
        return result;
      });
      await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow();
      owners.assertClosed();
      expect(s.phases).not.toContain('complete');
      expect(s.client.dispose).toHaveBeenCalledOnce();
    },
  );

  it('times all pages, mutation, replay and final hydration with untimed creation and cleanup', async () => {
    const s = await setup();
    const writes = vi.spyOn(s.h.app.vault, 'process');
    const complete = vi.spyOn(s.client.tasks, 'complete');
    const get = vi.spyOn(s.client.tasks, 'get');
    await apiScenarios(s.host, s.options, s.measure);
    expect(s.phases).toEqual([
      'discover',
      'ready',
      'subscribe',
      'list',
      'list',
      'create',
      'resolve',
      'complete',
      'complete',
      'get',
    ]);
    expect(s.facts).toEqual({
      'api.scan': { nodes: 101, pages: 2, pageSize: 100 },
      'api.status': { writes: 1, requests: 2, replays: 1, hydrated: 1 },
    });
    expect(s.list.mock.calls).toMatchObject([[{ folder, limit: 100 }], [{ folder, limit: 100 }]]);
    expect(s.list.mock.calls[1]?.[0]?.cursor).toEqual(expect.any(String));
    expect(s.sequencing).toEqual([
      'api.scan:prepare',
      'api.scan:action',
      'api.status:prepare',
      'create',
      'api.status:action',
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]).toEqual(complete.mock.calls[1]);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      expiresAt: now + 300_000,
    });
    expect(complete.mock.calls[0]?.[0].requestId).toEqual(expect.any(String));
    expect(get).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledTimes(2); // one untimed create plus one status write
    expect(s.getApi).toHaveBeenCalledWith(1, { consumerId: 'abyss-performance-api' });
    expect(s.off).toHaveBeenCalledOnce();
    expect(s.client.dispose).toHaveBeenCalledOnce();
  });
  it.each(['standard', 'wide-tree'] as const)(
    'completes the canonical %s scan population',
    async (kind) => {
      const fixture = createFixture('2026-08-01', kind);
      const s = await setup(fixture.nodes, fixture.files);
      await apiScenarios(
        s.host,
        { ...s.options, fixtureKind: kind, expectedRoots: fixture.roots },
        s.measure,
      );
      expect(s.facts['api.scan']).toEqual({
        nodes: kind === 'standard' ? 6000 : 6999,
        pages: kind === 'standard' ? 60 : 70,
        pageSize: 100,
      });
      expect(s.client.dispose).toHaveBeenCalledOnce();
    },
  );
  it('rejects an invalidation after the final page was read', async () => {
    const s = await setup(1);
    s.list.mockImplementation(async (...args) => {
      const page = await s.real.tasks.list(...args);
      await s.h.external(path, '- [ ] Changed after read\n');
      return page;
    });
    await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow(
      'Incomplete or invalidated',
    );
    expect(s.facts).toEqual({});
    expect(s.off).toHaveBeenCalledOnce();
    expect(s.client.dispose).toHaveBeenCalledOnce();
  });
  it('rejects an old plugin rather than skipping API work', async () => {
    const s = await setup();
    const host = { plugins: { plugins: { 'abyss-tasks': {} } } } as unknown as Host;
    await expect(apiScenarios(host, s.options, s.measure)).rejects.toThrow(
      /unsupported.*profile/iu,
    );
    expect(s.facts).toEqual({});
  });
  it.each([
    'health',
    'duplicate',
    'order',
    'stale',
    'generation',
    'count',
    'source',
    'resource',
  ] as const)('rejects %s scans without a completed sample', async (failure) => {
    const s = await setup();
    let pages = 0;
    s.list.mockImplementation(async (...args) => {
      pages += 1;
      if (failure === 'stale' && pages === 2)
        return {
          ok: false,
          error: { code: 'STALE_CURSOR', category: 'conflict', message: 'injected' },
        };
      if (failure === 'resource')
        return {
          ok: false,
          error: { code: 'RESOURCE_LIMIT', category: 'resource', message: 'injected' },
        };
      const result = await s.real.tasks.list(...args);
      if (!result.ok) return result;
      if (failure === 'health' && pages === 1) {
        const file = s.h.app.vault.getFileByPath(path);
        if (file === null) throw new Error('Missing source');
        vi.spyOn(s.h.app.vault, 'read').mockRejectedValue(new Error('unavailable'));
        s.h.app.metadataCache.trigger('changed', file, 'unknown', {});
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      return corruptPage(failure, pages, result.value);
    });
    await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow();
    expect(s.facts).toEqual({});
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.off).toHaveBeenCalledOnce();
    expect(s.client.dispose).toHaveBeenCalledOnce();
    expect(pages).toBeLessThanOrEqual(2);
  });
  it.each(['unknown', 'warning', 'get', 'replay', 'missing'] as const)(
    'rejects %s status proof without reporting that span',
    async (failure) => {
      const s = await setup(1);
      let requests = 0;
      vi.spyOn(s.client.tasks, 'complete').mockImplementation(async (...args) => {
        requests += 1;
        const result = await s.real.tasks.complete(...args);
        if (!result.ok) return result;
        if (failure === 'unknown')
          return { ...result, receipt: { ...result.receipt, effects: 'unknown' } };
        if (failure === 'warning')
          return {
            ...result,
            receipt: { ...result.receipt, warnings: [{ code: 'TRACKING', message: 'injected' }] },
          };
        if (failure === 'replay' && requests === 2)
          return {
            ...result,
            receipt: { ...result.receipt, acceptedAt: result.receipt.acceptedAt + 1 },
          };
        if (failure === 'missing')
          return {
            ok: false,
            effects: 'unknown',
            recovery: 'reconcile',
            error: { category: 'io', code: 'NO_RECEIPT', message: 'injected' },
          };
        return result;
      });
      if (failure === 'get')
        vi.spyOn(s.client.tasks, 'get').mockResolvedValue({
          ok: false,
          error: { category: 'unavailable', code: 'SOURCE_UNAVAILABLE', message: 'injected' },
        });
      await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow();
      expect(Object.keys(s.facts)).toEqual(['api.scan']);
      expect(s.off).toHaveBeenCalledOnce();
      expect(s.client.dispose).toHaveBeenCalledOnce();
    },
  );
  it('disposes the client when readiness fails', async () => {
    const s = await setup();
    vi.spyOn(s.client, 'ready').mockResolvedValue({
      ok: false,
      error: { category: 'lifecycle', code: 'DISPOSED', message: 'injected' },
    });
    await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow('DISPOSED');
    expect(s.client.dispose).toHaveBeenCalledOnce();
  });
  it('disposes the client when listener capacity is exhausted', async () => {
    const s = await setup();
    vi.spyOn(s.client, 'subscribe').mockReturnValue({
      ok: false,
      error: { category: 'resource', code: 'RESOURCE_LIMIT', message: 'injected' },
    });
    await expect(apiScenarios(s.host, s.options, s.measure)).rejects.toThrow('RESOURCE_LIMIT');
    expect(s.facts).toEqual({});
    expect(s.client.dispose).toHaveBeenCalledOnce();
  });
});
