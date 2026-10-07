import type { RowViewportSource } from '../../src/panels/virtualization/rowViewport';

/**
 * Exercise twenty complete outward/return cycles of the same mounted surface. This workload
 * retains real DOM, Component and native resource behavior, so its callers name the measured
 * lifecycle-audit limit rather than the ordinary interaction-test limit.
 */
export async function runVirtualSurfaceAuditCycles(
  cycle: (index: number) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < 20; index++) await cycle(index);
}

/** Pure numeric series fixture; construction and survivor intersection never enumerate rows. */
export function numericRowSource(
  from: number,
  to: number,
): RowViewportSource & { reads(): number } {
  let reads = 0;
  const indexOf = (key: string): number => {
    if (!/^number:\d+$/u.test(key)) return -1;
    const n = Number(key.slice(7));
    return n >= from && n <= to ? n - from : -1;
  };
  return {
    length: Math.max(0, to - from + 1),
    reads: () => reads,
    rowAt(index) {
      reads++;
      return index >= 0 && index <= to - from
        ? { key: `number:${from + index}`, estimatedHeight: 40, measurementRevision: 'number' }
        : undefined;
    },
    indexOf,
    estimatedOffset: (index) => index * 40,
    anchorRanges: () => [{ kind: 'series', series: 'number', from, to }],
    survivingNeighbor(previousIndex, direction, current) {
      const candidates: number[] = [];
      for (const range of current.anchorRanges()) {
        if (range.kind === 'key') {
          const index = indexOf(range.key);
          if (index >= 0 && (index - previousIndex) * direction > 0) candidates.push(index);
        } else if (range.series === 'number') {
          const low = Math.max(from, range.from);
          const high = Math.min(to, range.to);
          const n =
            direction === 1
              ? Math.max(low, from + previousIndex + 1)
              : Math.min(high, from + previousIndex - 1);
          if (n >= low && n <= high) candidates.push(n - from);
        }
      }
      return numericSurvivor(candidates, from, direction);
    },
  };
}

function numericSurvivor(
  candidates: readonly number[],
  from: number,
  direction: 1 | -1,
): string | undefined {
  if (candidates.length === 0) return undefined;
  return `number:${from + (direction === 1 ? Math.min(...candidates) : Math.max(...candidates))}`;
}
