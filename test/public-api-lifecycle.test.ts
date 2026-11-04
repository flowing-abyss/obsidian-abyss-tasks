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
    'get',
    'list',
    'resolve',
    'statuses',
  ]);
  expect(client.info.capabilities).toEqual([
    'tasks.read',
    'tasks.resolve',
    'tasks.statuses',
    'events.invalidate',
  ]);
  expect(Object.isFrozen(client.info.limits)).toBe(true);
});
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
