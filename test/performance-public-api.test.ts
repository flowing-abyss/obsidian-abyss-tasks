import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TasksApiV1 } from '../api';
import { createFixture } from '../tooling/performance/fixture.mts';
import { apiScenarios } from '../tooling/performance/native-api';
import type { Measure } from '../tooling/performance/native-scenarios';
import type { Host, NativeOptions } from '../tooling/performance/native-types';
import { expectDefined } from './helpers';
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
  const client: TasksApiV1 = {
    ...real,
    tasks: { ...real.tasks },
    dispose: vi.fn(real.dispose),
    subscribe: (listener) => {
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
  let timed = false;
  const sequencing: string[] = [];
  const execute = vi.fn(async (input: Parameters<typeof h.service.execute>[0]) => {
    expect(timed).toBe(false);
    sequencing.push('create');
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
  const getApi = vi.fn(() => ({ ok: true as const, value: client }));
  const host = {
    plugins: { plugins: { 'abyss-tasks': { getApi, tasks: { execute } } } },
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
    return real.tasks.list(...args);
  });
  return { h, real, client, host, options, measure, facts, sequencing, off, execute, getApi, list };
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
  it('times all pages, mutation, replay and final hydration with untimed creation and cleanup', async () => {
    const s = await setup();
    const writes = vi.spyOn(s.h.app.vault, 'process');
    const complete = vi.spyOn(s.client.tasks, 'complete');
    const get = vi.spyOn(s.client.tasks, 'get');
    await apiScenarios(s.host, s.options, s.measure);
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
