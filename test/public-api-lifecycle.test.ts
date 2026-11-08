import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import type { TaskIntegrationReadState } from '../src/tasks/infrastructure/TaskIntegrationReadState';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup(initialize = true) {
  const h = await publicApiHarness({ 'a.md': '- [ ] task\n' }, { initialize });
  harnesses.push(h);
  return h;
}
function ok<T>(r: ApiResultV1<T>): T {
  if (!r.ok) {
    throw new Error(r.error.code);
  }
  return r.value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Missing fixture value');
  }
  return value;
}

it('waits for startup, supports already ready, and releases disposed waiters', async () => {
  const h = await setup(false);
  const client = h.client();
  expect(await client.tasks.list()).toMatchObject({ error: { code: 'NOT_READY' } });
  const ready = client.ready();
  await h.index.initialize();
  expect(ok(await ready).lifecycle).toBe('ready');
  expect(ok(await client.ready()).providerEpoch).toBe(client.info.providerEpoch);
  client.dispose();
  expect(await client.ready()).toMatchObject({ error: { code: 'DISPOSED' } });
});
it('settles startup failure and permits a fresh wait after recovery', async () => {
  const h = await setup(false);
  const client = h.client();
  const ready = client.ready();
  vi.spyOn(h.app.vault, 'getMarkdownFiles').mockImplementationOnce(() => {
    throw new Error('startup');
  });
  await expect(h.index.initialize()).rejects.toThrow('startup');
  expect(await ready).toMatchObject({ error: { code: 'INITIALIZATION_FAILED' } });
  expect(await client.tasks.statuses()).toMatchObject({ error: { code: 'INITIALIZATION_FAILED' } });
  await h.index.initialize();
  expect((await client.ready()).ok).toBe(true);
});
it('honors abort before and during waiting and cleans signal listeners', async () => {
  const h = await setup(false);
  const client = h.client();
  const signal = new AbortController();
  const remove = vi.spyOn(signal.signal, 'removeEventListener');
  const ready = client.ready({ signal: signal.signal });
  signal.abort();
  expect(await ready).toMatchObject({ error: { code: 'ABORTED' } });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(await client.ready({ signal: signal.signal })).toMatchObject({
    error: { code: 'ABORTED' },
  });
});
it.each(['client', 'provider'] as const)(
  'releases pending readiness on %s disposal without final callbacks',
  async (owner) => {
    const h = await setup(false);
    const client = h.client();
    const callback = vi.fn();
    ok(client.subscribe(callback));
    const ready = client.ready();
    (owner === 'client' ? client : h.provider).dispose();
    expect(await ready).toMatchObject({ error: { code: 'DISPOSED' } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await client.tasks.list()).toMatchObject({ error: { code: 'DISPOSED' } });
  },
);
it('registers immediately and safely handles self disposal and unsubscribe', async () => {
  const h = await setup();
  const client = h.client();
  const callback = vi.fn(() => {
    client.dispose();
  });
  const unsubscribe = ok(client.subscribe(callback));
  unsubscribe();
  unsubscribe();
  await h.external('a.md', '- [ ] edit\n');
  expect(callback).toHaveBeenCalledTimes(1);
});
it.each(['unsubscribe', 'dispose'] as const)(
  'checks listener liveness after another callback does %s',
  async (action) => {
    const h = await setup();
    const a = h.client('a');
    const b = h.client('b');
    let remove = () => {};
    let armed = false;
    ok(
      a.subscribe(() => {
        if (armed) {
          if (action === 'dispose') b.dispose();
          else remove();
        }
      }),
    );
    const callback = vi.fn();
    remove = ok(b.subscribe(callback));
    armed = true;
    await h.external('a.md', '- [ ] edit\n');
    expect(callback).toHaveBeenCalledTimes(1);
  },
);
it('isolates callback exceptions and logs only sanitized metadata', async () => {
  const h = await setup();
  const diagnostic = vi.fn();
  const { TaskApiProvider } = await import('../src/integrations/TaskApiProvider');
  const provider = new TaskApiProvider({
    mutations: h.service,
    reads: h.reads,
    epoch: 'diagnostic',
    pluginVersion: '2.3.2',
    now: () => 0,
    diagnostic,
  });
  try {
    const client = ok(provider.getApi(1, { consumerId: 'test' }));
    expect(
      client.subscribe(() => {
        throw new Error('secret source');
      }).ok,
    ).toBe(true);
    const callback = vi.fn();
    ok(client.subscribe(callback));
    await h.external('a.md', '- [ ] edit\n');
    expect(callback.mock.calls.length).toBeGreaterThan(1);
    expect(diagnostic).toHaveBeenCalled();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret|a\.md/);
  } finally {
    provider.dispose();
  }
});
it('enforces live client and listener capacities and reuses released slots', async () => {
  const h = await setup();
  const clients = Array.from({ length: 128 }, () => h.client());
  expect(h.provider.getApi(1, { consumerId: 'test' })).toMatchObject({
    error: { code: 'RESOURCE_LIMIT' },
  });
  required(clients[0]).dispose();
  const client = h.client();
  const removes = Array.from({ length: 32 }, () => ok(client.subscribe(() => {})));
  expect(client.subscribe(() => {})).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
  required(removes[0])();
  expect(client.subscribe(() => {}).ok).toBe(true);
});
it('validates runtime inputs and exposes only implemented capabilities', async () => {
  const h = await setup();
  const client = h.client();
  expect(h.provider.getApi(2, { consumerId: 'test' })).toMatchObject({
    error: { code: 'UNSUPPORTED_API_VERSION' },
  });
  for (const options of [
    null,
    {},
    { consumerId: 'x', unknown: true },
    {
      get consumerId() {
        throw new Error('secret');
      },
    },
  ]) {
    expect(h.provider.getApi(1, options as { consumerId: string })).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    });
  }
  expect(client.subscribe(null as never)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  expect(await client.ready(null as never)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  expect(await client.tasks.get('')).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  expect(Object.keys(client.tasks).sort((a, b) => a.localeCompare(b))).toEqual([
    'apply',
    'complete',
    'create',
    'get',
    'list',
    'prepare',
    'resolve',
    'search',
    'setStatus',
    'statuses',
    'tags',
    'toggleCompletion',
    'tree',
  ]);
  expect(client.info.capabilities).toEqual([
    'tasks.read',
    'notes.search',
    'notes.read',
    'notes.prepare',
    'notes.create',
    'notes.apply',
    'notes.create.collision',
    'notes.apply.section',
    'notes.prepare.refine',
    'tasks.tags',
    'tasks.search',
    'tasks.tree',
    'tasks.prepare',
    'tasks.apply',
    'tasks.create',
    'tasks.prepare.reorder',
    'tasks.prepare.hierarchy',
    'tasks.resolve',
    'tasks.statuses',
    'tasks.complete',
    'tasks.setStatus',
    'tasks.toggleCompletion',
    'events.invalidate',
    'requests.epochDeduplication',
  ]);
  expect(Object.isFrozen(client.info.limits)).toBe(true);
});
it.each([false, true])(
  'does not advertise unavailable hierarchy preparation with content ports=%s',
  async (content) => {
    const h = await setup();
    const { TaskApiProvider } = await import('../src/integrations/TaskApiProvider');
    const provider = new TaskApiProvider({
      mutations: h.service,
      reads: h.reads,
      epoch: 'without-hierarchy',
      pluginVersion: '2.3.2',
      now: () => 0,
      diagnostic: () => {},
      ...(content ? { content: { edits: h.service, creates: h.service, statuses: () => [] } } : {}),
    });
    try {
      const client = ok(provider.getApi(1, { consumerId: 'test' }));
      expect(client.info.capabilities.includes('tasks.prepare.reorder')).toBe(content);
      expect(client.info.capabilities).not.toContain('tasks.prepare.hierarchy');
      if (content) {
        const source = required(ok(await client.tasks.list()).items[0]);
        expect(
          await required(client.tasks.prepare)({
            kind: 'hierarchy',
            operation: {
              type: 'promote',
              source: source.target,
              expectedSourceRevision: source.revision,
            },
          }),
        ).toMatchObject({ error: { code: 'UNSUPPORTED_OPERATION' } });
      } else expect(client.tasks.prepare).toBeUndefined();
      const file = required(h.app.vault.getFiles().find((entry) => entry.path === 'a.md'));
      expect(await h.app.vault.read(file)).toBe('- [ ] task\n');
    } finally {
      provider.dispose();
    }
  },
);
it('never revives old clients in a new provider epoch', async () => {
  const old = await setup();
  const client = old.client();
  old.dispose();
  const fresh = await setup();
  expect(fresh.client().info.providerEpoch).not.toBe(client.info.providerEpoch);
  expect(await client.tasks.list()).toMatchObject({ error: { code: 'DISPOSED' } });
});
it('rechecks a settled readiness wait after synchronous callback disposal', async () => {
  const h = await setup(false);
  const client = h.client();
  ok(
    client.subscribe((event) => {
      if (event.lifecycle === 'ready') client.dispose();
    }),
  );
  const wait = client.ready();
  await h.index.initialize();
  expect(await wait).toMatchObject({ error: { code: 'DISPOSED' } });
});

it('terminates pending work on safe-integer exhaustion without exposing source state', async () => {
  const h = await setup(false);
  const client = h.client();
  const wait = client.ready();
  const state = Object.getOwnPropertyDescriptor(h.index, 'integrationReadState_abyssPrivate')
    ?.value as TaskIntegrationReadState;
  Object.defineProperty(state, 'observation_abyssPrivate', {
    value: { ...state.capture(), revision: Number.MAX_SAFE_INTEGER },
    writable: true,
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await h.index.initialize();
    expect(await wait).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(await client.tasks.list()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(h.provider.getApi(1, { consumerId: 'new' })).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  } finally {
    errors.mockRestore();
  }
});

it('orders invalidations when a callback synchronously installs accepted content', async () => {
  const h = await setup();
  let inwardEvents = 0;
  h.reads.subscribe(() => {
    inwardEvents++;
  });
  const client = h.client();
  let registeredAt = 0;
  let immediateCount = 0;
  const lateChangedAt: number[] = [];
  let armed = false;
  const lateRevisions: number[] = [];
  ok(
    client.subscribe(() => {
      if (!armed) return;
      armed = false;
      h.index.installCommittedContent('a.md', '- [ ] task\n');
      registeredAt = inwardEvents;
      ok(
        client.subscribe((event) => {
          if (event.type === 'changed') lateChangedAt.push(inwardEvents);
          lateRevisions.push(event.revision);
        }),
      );
      immediateCount = lateRevisions.length;
    }),
  );
  const revisions: number[] = [];
  ok(
    client.subscribe((event) => {
      revisions.push(event.revision);
    }),
  );
  armed = true;
  h.index.updateIntegrationSemantics('nested-accepted-content');
  expect(immediateCount).toBe(1);
  expect(lateChangedAt.every((count) => count > registeredAt)).toBe(true);
  expect(revisions.length).toBeGreaterThan(2);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  expect(lateRevisions).toEqual([...lateRevisions].sort((a, b) => a - b));
  expect(lateRevisions.every((revision) => revision >= required(lateRevisions[0]))).toBe(true);
});

it('preserves lifecycle transitions across nested acceptance without delivering old queued states to late subscribers', async () => {
  const h = await setup(false);
  const client = h.client();
  const state = Object.getOwnPropertyDescriptor(h.index, 'integrationReadState_abyssPrivate')
    ?.value as TaskIntegrationReadState;
  let armed = true;
  const lateEvents: Array<{ revision: number; lifecycle: string }> = [];
  let immediateCount = 0;
  ok(
    client.subscribe((event) => {
      if (!armed || event.lifecycle !== 'ready') return;
      armed = false;
      state.setLifecycle('failed');
      h.index.installCommittedContent('a.md', '- [ ] task\n');
      ok(
        client.subscribe((current) => {
          lateEvents.push(current);
        }),
      );
      immediateCount = lateEvents.length;
    }),
  );
  const events: Array<{ revision: number; lifecycle: string }> = [];
  ok(
    client.subscribe((event) => {
      events.push(event);
    }),
  );
  await h.index.initialize();
  const transitions = () =>
    events
      .filter((event, index) => event.lifecycle !== events[index - 1]?.lifecycle)
      .map((event) => event.lifecycle);
  expect(immediateCount).toBe(1);
  expect(transitions()).toEqual(['initializing', 'ready', 'failed']);
  expect(events.map((event) => event.revision)).toEqual(
    events.map((event) => event.revision).sort((a, b) => a - b),
  );
  expect(lateEvents.every((event) => event.lifecycle === 'failed')).toBe(true);
  expect(lateEvents.map((event) => event.revision)).toEqual(
    lateEvents.map((event) => event.revision).sort((a, b) => a - b),
  );
  state.setLifecycle('initializing');
  state.setLifecycle('ready');
  expect(transitions()).toEqual(['initializing', 'ready', 'failed', 'initializing', 'ready']);
});
