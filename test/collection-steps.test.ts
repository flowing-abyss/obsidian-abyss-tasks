import { expect, it, vi } from 'vitest';
import { drainCollectionSteps, stableSortSteps } from '../src/collectionSteps';

it.each([[], [1], [1, 2, 3], [5, 4, 3, 2, 1], [3, 1, 4, 1, 5, 9, 2]])(
  'stably sorts %j one comparison/write advancement at a time',
  (...values: number[]) => {
    const input = values.map((key, id) => ({ key, id }));
    const expected = [...input].sort((a, b) => a.key - b.key);
    const compare = vi.fn((a: (typeof input)[number], b: (typeof input)[number]) => a.key - b.key);
    const steps = stableSortSteps([...input], compare);
    let previous = 0;
    let next = steps.next();
    while (next.done !== true) {
      expect(compare.mock.calls.length - previous).toBeLessThanOrEqual(1);
      previous = compare.mock.calls.length;
      next = steps.next();
    }
    expect(next.value).toEqual(expected);
  },
);
it('returns an ordered owned vector directly and treats NaN and negative zero as equal', () => {
  const input = [{ id: 2 }, { id: 1 }, { id: 0 }];
  expect(drainCollectionSteps(stableSortSteps(input, () => NaN))).toBe(input);
  expect(drainCollectionSteps(stableSortSteps(input, () => -0))).toBe(input);
});
it('closes suspended sorting and rejects unexplained undefined completion', () => {
  const steps = stableSortSteps([4, 3, 2, 1], (a, b) => a - b);
  steps.next();
  expect(steps.return(undefined)).toEqual({ done: true, value: undefined });
  expect(steps.next().done).toBe(true);
  expect(() => {
    drainCollectionSteps(
      (function* () {
        yield 'cheap' as const;
      })(),
    );
  }).toThrow();
});
it('orders multilingual strings with the supplied complete locale comparator', () => {
  const input = ['é', 'e\u0301', '中文', 'عربي', 'A', 'a', 'é'];
  expect(drainCollectionSteps(stableSortSteps([...input], (a, b) => a.localeCompare(b)))).toEqual(
    [...input].sort((a, b) => a.localeCompare(b)),
  );
});
