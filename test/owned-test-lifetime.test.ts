import { expect, it, vi, type TestContext } from 'vitest';
import { deferred } from './helpers';
import { ownedWait, ownTestCleanup } from './support/ownedTestLifetime';

it('cancels a blocked row before teardown and consumes late host settlement without resuming it', async (context) => {
  const lifetime = new AbortController();
  const held = deferred<void>();
  let rejectLate!: (error: unknown) => void;
  const lateFailure = new Promise<void>((_resolve, reject) => {
    rejectLate = reject;
  });
  const cleanupFinished = deferred<void>();
  const events: string[] = [];
  let finish: Parameters<TestContext['onTestFinished']>[0] | undefined;
  const dispose = ownTestCleanup(
    {
      signal: lifetime.signal,
      onTestFinished: (hook) => {
        finish = hook;
      },
    },
    () => {
      events.push('stop timers');
      return cleanupFinished.promise;
    },
  );
  const resumed = vi.fn();
  const body = ownedWait(held.promise, lifetime.signal).then(resumed);
  const late = ownedWait(lateFailure, lifetime.signal);
  const bodyRejected = expect(body).rejects.toThrow('cancel row');
  const lateRejected = expect(late).rejects.toThrow('cancel row');
  try {
    lifetime.abort(new Error('cancel row'));
    events.push('restore mocks');
    expect(events).toEqual(['stop timers', 'restore mocks']);
    await bodyRejected;
    await lateRejected;
    held.resolve();
    rejectLate(new Error('late host rejection'));
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();
    cleanupFinished.resolve();
    await finish?.(context);
    await dispose();
    expect(events).toEqual(['stop timers', 'restore mocks']);
  } finally {
    lifetime.abort(new Error('cancel row'));
    held.resolve();
    rejectLate(new Error('late host rejection'));
    cleanupFinished.resolve();
    await Promise.all([bodyRejected, lateRejected]);
    await finish?.(context);
    await dispose();
  }
});
