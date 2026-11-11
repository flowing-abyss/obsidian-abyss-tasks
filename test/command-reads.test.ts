import { expect, it, vi } from 'vitest';
import type { ApiEventV1, ApiResultV1 } from '../api';
import { commandRead } from '../src/ai/commandReads';
import { publicApiHarness } from './support/publicApiHarness';
const incomplete: ApiResultV1<number> = {
  ok: false,
  error: { code: 'INCOMPLETE_READ', category: 'unavailable', message: 'Still updating' },
};
it('recovers a publication between failure and wait without missing the wakeup', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] A' });
  try {
    const base = h.client();
    let listener: ((event: ApiEventV1) => void) | undefined;
    let reads = 0;
    let unsubscribed = false;
    const api = {
      ...base,
      subscribe: (next: (event: ApiEventV1) => void) => {
        listener = next;
        return {
          ok: true as const,
          value: () => {
            unsubscribed = true;
          },
        };
      },
    };
    const value = await commandRead(
      api,
      async () => {
        reads++;
        if (reads === 1) {
          listener?.({
            providerEpoch: 'e',
            revision: 2,
            generation: 1,
            scopeRevision: 1,
            semanticsRevision: 1,
            type: 'changed',
          } as ApiEventV1);
          return incomplete;
        }
        return { ok: true, value: 7 };
      },
      new AbortController().signal,
      { deadline: Date.now() + 5000, now: () => Date.now() },
    );
    expect(value).toBe(7);
    expect(reads).toBe(2);
    expect(unsubscribed).toBe(true);
  } finally {
    h.dispose();
  }
});
it('exhausts bounded coverage waits and unsubscribes on cancellation', async () => {
  vi.useFakeTimers();
  const h = await publicApiHarness({ 'a.md': '- [ ] A' });
  try {
    const controller = new AbortController();
    let reads = 0;
    const pending = commandRead(
      h.client(),
      async () => {
        reads++;
        return incomplete;
      },
      controller.signal,
      { deadline: Date.now() + 5000, now: () => Date.now() },
    );
    const checked = expect(pending).rejects.toThrow('stopped');
    await Promise.resolve();
    controller.abort();
    await checked;
    expect(reads).toBe(1);
  } finally {
    h.dispose();
    vi.useRealTimers();
  }
});
it('stops after three incomplete readonly attempts even when publications keep arriving', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] A' });
  try {
    let listener: ((event: ApiEventV1) => void) | undefined,
      attempts = 0;
    const api = {
      ...h.client(),
      subscribe: (next: (event: ApiEventV1) => void) => {
        listener = next;
        return {
          ok: true as const,
          value: () => {
            listener = undefined;
          },
        };
      },
    };
    await expect(
      commandRead(
        api,
        async () => {
          attempts++;
          listener?.({
            type: 'changed',
            providerEpoch: 'e',
            revision: attempts,
            generation: attempts,
            scopeRevision: 0,
            semanticsRevision: 0,
          } as ApiEventV1);
          return incomplete;
        },
        new AbortController().signal,
        { deadline: Date.now() + 5000, now: () => Date.now() },
      ),
    ).rejects.toThrow('Still updating');
    expect(attempts).toBe(3);
    expect(listener).toBeUndefined();
  } finally {
    h.dispose();
  }
});
it('bounds a pending readonly acquisition to five seconds', async () => {
  vi.useFakeTimers();
  const h = await publicApiHarness({ 'a.md': '- [ ] A' });
  try {
    const pending = commandRead(
      h.client(),
      () => new Promise<ApiResultV1<number>>(() => {}),
      new AbortController().signal,
      { deadline: Date.now() + 60000, now: () => Date.now() },
    );
    const check = expect(pending).rejects.toThrow('still updating');
    await vi.advanceTimersByTimeAsync(5000);
    await check;
  } finally {
    h.dispose();
    vi.useRealTimers();
  }
});
