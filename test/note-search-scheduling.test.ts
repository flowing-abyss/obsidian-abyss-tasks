import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserTaskScheduler } from '../src/browserTaskScheduler';
import { deferred, expectDefined } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
const files = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`${i}.md`, 'needle']));
it('uses the injected scheduler at the existing eight-source boundaries with exact full coverage', async () => {
  const pause = vi.fn(async (_signal: AbortSignal) => {});
  const h = await publicApiHarness(files, { noteYield: pause });
  owners.push(h);
  const result = await expectDefined(h.client().notes).search({ query: 'needle', fields: 'body' });
  expect(result).toMatchObject({ ok: true, value: { complete: true, coverage: 'complete' } });
  if (!result.ok) throw new Error(result.error.code);
  expect(
    result.value.items.map((item) => item.note.path).sort((a, b) => a.localeCompare(b)),
  ).toEqual(Object.keys(files).sort((a, b) => a.localeCompare(b)));
  expect(pause).toHaveBeenCalledTimes(2);
  expect(pause.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
});

it.each(['abort', 'client', 'provider', 'source', 'semantics', 'schedule'] as const)(
  'rejects %s while a note-search yield is pending without publishing a cursor or result',
  async (change) => {
    const entered = deferred<void>(),
      release = deferred<Error | undefined>();
    const pause = vi.fn((signal: AbortSignal) => {
      const abort = () => {
        release.resolve(new Error('Private scheduler abort'));
      };
      signal.addEventListener('abort', abort, { once: true });
      entered.resolve();
      return release.promise
        .then((failure) => {
          if (failure !== undefined) throw failure;
        })
        .finally(() => {
          signal.removeEventListener('abort', abort);
        });
    });
    const h = await publicApiHarness(files, { noteYield: pause });
    owners.push(h);
    const client = h.client();
    const controller = new AbortController();
    const result = expectDefined(client.notes).search(
      { query: 'needle', fields: 'body' },
      { signal: controller.signal },
    );
    await entered.promise;
    if (change === 'abort') controller.abort();
    if (change === 'client') client.dispose();
    if (change === 'provider') h.provider.dispose();
    if (change === 'source') await h.external('0.md', 'changed');
    if (change === 'semantics') h.index.updateIntegrationSemantics('changed');
    if (change === 'schedule') release.resolve(new Error('Private schedule failure'));
    else release.resolve(undefined);
    const expected = {
      abort: 'ABORTED',
      client: 'DISPOSED',
      provider: 'DISPOSED',
      source: 'STALE_CURSOR',
      semantics: 'STALE_CURSOR',
      schedule: 'INTERNAL_ERROR',
    }[change];
    const observed = await result;
    expect(observed).toMatchObject({ ok: false, error: { code: expected } });
    expect(JSON.stringify(observed)).not.toContain('Private');
    expect(pause).toHaveBeenCalledOnce();
    if (['abort', 'client', 'provider'].includes(change))
      expect(pause.mock.calls[0]?.[0].aborted).toBe(true);
  },
);

it('searches through the captured owner channel without falling back to hidden-window timers', async () => {
  let deliver: (() => void) | undefined;
  const close = vi.fn();
  const timer = vi.fn(() => {
    throw new Error('Hidden timer must not be used');
  });
  const owner = {
    performance: { now: () => 0 },
    setTimeout: timer,
    clearTimeout: vi.fn(),
    MessageChannel: class {
      port1 = {
        close,
        set onmessage(callback: (() => void) | null) {
          if (callback !== null) deliver = callback;
        },
      };
      port2 = {
        close,
        postMessage: () => {
          expectDefined(deliver)();
        },
      };
    },
  } as unknown as Window;
  const scheduler = createBrowserTaskScheduler(owner);
  const h = await publicApiHarness(files, { noteYield: (signal) => scheduler.yield(signal) });
  owners.push(h);
  expect(
    await expectDefined(h.client().notes).search({ query: 'needle', fields: 'body' }),
  ).toMatchObject({ ok: true, value: { complete: true } });
  expect(timer).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(4);
});
