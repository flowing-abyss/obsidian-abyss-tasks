import { expect, it, vi } from 'vitest';
import type { CollectionSteps } from '../src/collectionSteps';
import {
  runTaskOrganization,
  TaskOrganizationFailure,
} from '../src/panels/task-list/runTaskOrganization';
function execution() {
  return {
    signal: new AbortController().signal,
    scheduler: { now: () => 0, yield: vi.fn(async () => {}) },
    assertCurrent: vi.fn(),
    phase: 'organization' as const,
    budget: { targetMs: 4, maxSteps: 3, clockCheckEvery: 2 },
  };
}
it('initially hands off, keeps one nested budget, and checks every atom immediately', async () => {
  const e = execution();
  let advanced = 0;
  function* child(): CollectionSteps<number> {
    for (let i = 0; i < 7; i++) {
      advanced++;
      yield 'cheap';
    }
    return 42;
  }
  function* parent(): CollectionSteps<number> {
    return yield* child();
  }
  const run = runTaskOrganization(parent(), e);
  expect(advanced).toBe(0);
  expect(await run).toBe(42);
  expect(e.scheduler.yield).toHaveBeenCalledTimes(3);
  expect(e.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(16);
});
it.each(['clock', 'guard', 'step', 'yield'] as const)(
  'closes the iterator after %s failure without retaining an active continuation',
  async (phase) => {
    const e = execution();
    let closed = false;
    function* steps(): CollectionSteps<number> {
      try {
        yield 'atom';
        if (phase === 'step') throw new Error('SECRET step');
        return 1;
      } finally {
        closed = true;
      }
    }
    const iterator = steps();
    // Ensure this failure also closes an already-suspended owned generator.
    iterator.next();
    if (phase === 'clock')
      e.scheduler.now = () => {
        throw new Error('SECRET clock');
      };
    if (phase === 'guard')
      e.assertCurrent.mockImplementation(() => {
        throw new Error('SECRET guard');
      });
    if (phase === 'yield') e.scheduler.yield.mockRejectedValue(new Error('SECRET yield'));
    await expect(runTaskOrganization(iterator, e)).rejects.toBeInstanceOf(TaskOrganizationFailure);
    expect(closed).toBe(true);
  },
);
it('stops immediately after a reentrant abort and preserves primary failure through throwing cleanup', async () => {
  const e = execution(),
    controller = new AbortController();
  e.signal = controller.signal;
  let later = false;
  function* steps(): CollectionSteps<number> {
    try {
      controller.abort();
      yield 'atom';
      later = true;
      return 1;
    } finally {
      cleanupFailure();
    }
  }
  await expect(runTaskOrganization(steps(), e)).rejects.toThrow();
  expect(later).toBe(false);
});

function cleanupFailure(): never {
  throw new Error('SECRET cleanup');
}
