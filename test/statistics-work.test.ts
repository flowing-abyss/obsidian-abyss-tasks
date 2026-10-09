// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sorted, StatisticsCancelled, WorkBudget } from '../src/statistics/statisticsWork';

describe('cooperative statistics sorting', () => {
  it('avoids a microtask for each item while retaining owner yields', async () => {
    let running = true;
    let turns = 0;
    let yields = 0;
    const tick = () => {
      if (!running) return;
      turns++;
      queueMicrotask(tick);
    };
    const budget = new WorkBudget({
      isCancelled: () => false,
      yieldControl: async () => {
        yields++;
      },
    });
    queueMicrotask(tick);
    try {
      expect(
        await sorted(
          Array.from({ length: 2000 }, (_, i) => 1999 - i),
          (a, b) => a - b,
          budget,
        ),
      ).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    } finally {
      running = false;
    }
    expect(yields).toBeGreaterThan(0);
    expect(turns).toBeLessThan(200);
  });

  it('preserves equal-key source order across runs and an uneven tail', async () => {
    const input = Object.freeze(
      Array.from({ length: 1501 }, (_, id) => Object.freeze({ key: id % 3, id })),
    );
    const result = await sorted(
      input.values(),
      (a, b) => a.key - b.key,
      new WorkBudget({ isCancelled: () => false, yieldControl: async () => {} }),
    );
    expect(result.map((value) => value.id)).toEqual([
      ...Array.from({ length: 501 }, (_, i) => 3 * i),
      ...Array.from({ length: 500 }, (_, i) => 3 * i + 1),
      ...Array.from({ length: 500 }, (_, i) => 3 * i + 2),
    ]);
    expect(input.map((value) => value.id)).toEqual(Array.from({ length: 1501 }, (_, i) => i));
  });

  it('returns control to the owner at each operation budget boundary', async () => {
    let operation = 0;
    const pauses: number[] = [];
    const budget = new WorkBudget({
      isCancelled: () => false,
      yieldControl: async () => {
        pauses.push(operation);
      },
    });
    for (operation = 1; operation <= 2500; operation++) await budget.step();
    expect(pauses).toEqual([1000, 2000]);
  });

  it('cancels before sorting without asking the owner to yield', async () => {
    let yields = 0;
    await expect(
      sorted(
        [2, 1],
        (a, b) => a - b,
        new WorkBudget({
          isCancelled: () => true,
          yieldControl: async () => {
            yields++;
          },
        }),
      ),
    ).rejects.toBeInstanceOf(StatisticsCancelled);
    expect(yields).toBe(0);
  });

  it('checks cancellation after a pending yield before reading another item', async () => {
    let cancelled = false;
    let reads = 0;
    let release = () => {};
    let reachedPause = () => {};
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    function* input() {
      for (let i = 0; i < 1001; i++) {
        reads++;
        yield i;
      }
    }
    const result = sorted(
      input(),
      (a, b) => a - b,
      new WorkBudget({
        isCancelled: () => cancelled,
        yieldControl: () => {
          reachedPause();
          return resume;
        },
      }),
    );
    await paused;
    expect(reads).toBe(1000);
    cancelled = true;
    release();
    await expect(result).rejects.toBeInstanceOf(StatisticsCancelled);
    expect(reads).toBe(1000);
  });

  it('cancels during a cross-run comparison without publishing a partial result', async () => {
    let cancelled = false;
    let crossRunComparisons = 0;
    await expect(
      sorted(
        Array.from({ length: 1001 }, (_, i) => i),
        (a, b) => {
          if (Math.floor(a / 500) !== Math.floor(b / 500)) {
            crossRunComparisons++;
            cancelled = true;
          }
          return a - b;
        },
        new WorkBudget({ isCancelled: () => cancelled, yieldControl: async () => {} }),
      ),
    ).rejects.toBeInstanceOf(StatisticsCancelled);
    expect(crossRunComparisons).toBe(1);
  });

  it('propagates a failed owner yield', async () => {
    const failure = new Error('Owner scheduler unavailable');
    await expect(
      sorted(
        Array.from({ length: 1001 }, (_, i) => i),
        (a, b) => a - b,
        new WorkBudget({
          isCancelled: () => false,
          yieldControl: async () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
  });
});
