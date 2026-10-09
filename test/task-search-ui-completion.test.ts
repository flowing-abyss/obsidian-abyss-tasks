import { afterEach, expect, it, vi } from 'vitest';
import { flushMicrotasks } from './helpers';
import { searchUiCompleted } from './support/taskSearchUiHarness';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function receiptFixture() {
  const root = document.body.createDiv();
  const input = root.createEl('input', { cls: 'abyss-search-global' });
  input.value = 'needle';
  root.dataset['searchRequest'] = '1';
  root.dataset['searchPhase'] = 'pending';
  root.dataset['searchGeneration'] = '7';
  const lifetime = new AbortController();
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
  const timer = vi.spyOn(window, 'setTimeout');
  return { root, input, lifetime, disconnect, remove, timer };
}

it('keeps a runner-owned receipt pending past the old cutoff and adopts only current completion', async () => {
  vi.useFakeTimers();
  const f = receiptFixture();
  let settled = false;
  const waiting = searchUiCompleted(f.root, () => 7, {
    signal: f.lifetime.signal,
    phase: 'initial-search',
  });
  const observed = waiting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(3001);
  expect(settled).toBe(false);
  expect(f.timer).not.toHaveBeenCalled();
  f.root.dataset['searchRequest'] = '2';
  await Promise.resolve();
  f.root.dataset['searchPhase'] = 'complete';
  f.root.dataset['searchGeneration'] = '6';
  const generationFlushed = flushMicrotasks(0);
  await vi.advanceTimersByTimeAsync(0);
  await generationFlushed;
  expect(settled).toBe(false);
  f.input.value = 'other';
  f.root.dataset['searchGeneration'] = '7';
  const queryFlushed = flushMicrotasks(0);
  await vi.advanceTimersByTimeAsync(0);
  await queryFlushed;
  expect(settled).toBe(false);
  f.input.value = 'needle';
  f.root.dataset['searchPhase'] = 'complete';
  await waiting;
  await observed;
  expect(f.disconnect).toHaveBeenCalledTimes(1);
  expect(f.remove).toHaveBeenCalledTimes(1);
});

it.each(['success', 'error', 'abort'] as const)(
  'releases receipt observation exactly once on %s',
  async (ending) => {
    const f = receiptFixture();
    const waiting = searchUiCompleted(f.root, () => 7, {
      signal: f.lifetime.signal,
      phase: 'destination-reveal',
    });
    const result = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (ending === 'success') f.root.dataset['searchPhase'] = 'complete';
    if (ending === 'error') {
      f.root.createDiv({ cls: 'abyss-search-status', text: 'Explicit failure' });
      f.root.dataset['searchPhase'] = 'error';
    }
    if (ending === 'abort') f.lifetime.abort();
    const error = await result;
    if (ending === 'success') expect(error).toBeUndefined();
    else {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        ending === 'error' ? 'Explicit failure' : 'destination-reveal',
      );
      if (ending === 'abort') {
        expect(String(error)).toContain('expectedQuery');
        expect(String(error)).toContain('actualRequest');
        expect(String(error)).toContain('actualGeneration');
      }
    }
    f.lifetime.abort();
    f.root.dataset['searchPhase'] = 'complete';
    await Promise.resolve();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.timer).not.toHaveBeenCalled();
  },
);

it('rejects pre-aborted receipts before observer acquisition', async () => {
  const f = receiptFixture();
  f.lifetime.abort();
  const observe = vi.spyOn(MutationObserver.prototype, 'observe');
  const waiting = searchUiCompleted(f.root, () => 7, {
    signal: f.lifetime.signal,
    phase: 'initial-search',
  });
  // Publishing terminal state cannot turn cancellation into success.
  f.root.dataset['searchPhase'] = 'complete';
  await expect(waiting).rejects.toThrow('initial-search');
  expect(observe).not.toHaveBeenCalled();
  expect(f.timer).not.toHaveBeenCalled();
});

it('accepts an existing terminal receipt and releases its observer immediately', async () => {
  const f = receiptFixture();
  f.root.dataset['searchPhase'] = 'complete';
  await searchUiCompleted(f.root, () => 7, { signal: f.lifetime.signal, phase: 'initial-search' });
  expect(f.disconnect).toHaveBeenCalledTimes(1);
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.timer).not.toHaveBeenCalled();
});

it.each(['observe', 'generation'] as const)(
  'cleans up when receipt %s checking throws',
  async (stage) => {
    const f = receiptFixture();
    const failure = new Error('Receipt acquisition failed');
    if (stage === 'observe')
      vi.spyOn(MutationObserver.prototype, 'observe').mockImplementationOnce(() => {
        throw failure;
      });
    f.root.dataset['searchPhase'] = 'complete';
    await expect(
      searchUiCompleted(
        f.root,
        () => {
          if (stage === 'generation') throw failure;
          return 7;
        },
        { signal: f.lifetime.signal, phase: 'initial-search' },
      ),
    ).rejects.toBe(failure);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.timer).not.toHaveBeenCalled();
  },
);

it('retains the compatibility cutoff without a runner lifetime', async () => {
  vi.useFakeTimers();
  const f = receiptFixture();
  const result = searchUiCompleted(f.root).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3001);
  expect(String(await result)).toContain('Search render did not settle');
  expect(f.disconnect).toHaveBeenCalledTimes(1);
});

it('preserves scalar currentness diagnostics before owner cancellation erases a mismatched receipt', async () => {
  const f = receiptFixture();
  const waiting = searchUiCompleted(f.root, () => 7, {
    signal: f.lifetime.signal,
    phase: 'initial-search',
  });
  const result = waiting.catch((error: unknown) => error);
  f.input.value = 'changed';
  f.root.dataset['searchRequest'] = '9';
  f.root.dataset['searchGeneration'] = '6';
  f.lifetime.abort();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(JSON.parse(message.slice(message.indexOf('{')))).toEqual({
    phase: 'initial-search',
    expectedQuery: 'needle',
    actualQuery: 'changed',
    expectedRequest: '1',
    actualRequest: '9',
    expectedPhase: 'complete',
    actualPhase: 'pending',
    expectedGeneration: 7,
    actualGeneration: '6',
  });
});
