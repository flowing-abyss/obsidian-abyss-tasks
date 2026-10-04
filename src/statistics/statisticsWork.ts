import type { StatisticsWork } from './types';
export class StatisticsCancelled extends Error {}
/** Count inner operations too; neither native large sorts nor graph traversal hide inside a unit. */
export class WorkBudget {
  private count = 0;
  constructor(private readonly work: StatisticsWork) {}
  check(): void {
    if (this.work.isCancelled()) throw new StatisticsCancelled();
  }
  async step(): Promise<void> {
    this.check();
    if (++this.count >= 1000) {
      this.count = 0;
      await this.work.yieldControl();
      this.check();
    }
  }
}
async function merge<T>(
  values: readonly T[],
  window: { start: number; width: number },
  compare: (a: T, b: T) => number,
  budget: WorkBudget,
): Promise<T[]> {
  const result: T[] = [];
  let a = window.start,
    b = Math.min(a + window.width, values.length);
  const aEnd = b,
    bEnd = Math.min(b + window.width, values.length);
  while (a < aEnd || b < bEnd) {
    const left = b >= bEnd || (a < aEnd && compare(required(values[a]), required(values[b])) <= 0);
    result.push(left ? required(values[a++]) : required(values[b++]));
    await budget.step();
  }
  return result;
}
export async function sorted<T>(
  input: Iterable<T>,
  compare: (a: T, b: T) => number,
  budget: WorkBudget,
): Promise<T[]> {
  let values: T[] = [];
  for (const value of input) {
    values.push(value);
    await budget.step();
  }
  for (let start = 0; start < values.length; start += 500) {
    const run = values.slice(start, start + 500).sort(compare);
    for (let i = 0; i < run.length; i++) {
      values[start + i] = required(run[i]);
      await budget.step();
    }
  }
  for (let width = 500; width < values.length; width *= 2) {
    const next: T[] = [];
    for (let start = 0; start < values.length; start += width * 2) {
      for (const value of await merge(values, { start, width }, compare, budget)) {
        next.push(value);
        await budget.step();
      }
    }
    values = next;
  }
  return values;
}
export function rankedNumber(a: number, b: number, tie: () => number): number {
  const difference = a - b;
  return difference === 0 ? tie() : difference;
}
/** A missing slot is an internal invariant failure, never silently a fabricated zero or record. */
export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Statistics invariant: missing value');
  return value;
}
