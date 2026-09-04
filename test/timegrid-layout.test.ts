import { describe, expect, it } from 'vitest';
import {
  capMinHeightsPx,
  MIN_BLOCK_HEIGHT_PX,
  minutesToPixels,
  minutesToTimeString,
  packOverlaps,
  PIXELS_PER_HOUR,
  pixelsToMinutes,
  snapMinutes,
  timeStringToMinutes,
  type TimedBlockInput,
} from '../src/views/timegrid/layout';
import { expectDefined, task } from './helpers';

// Shared by packOverlaps/capMinHeightsPx below — both just need a
// TimedBlockInput with a distinguishable task (line doubles as a cheap unique id for assertions).
const timedBlockInput = (
  start: number,
  duration: number,
  filePath = `task-${start}.md`,
): TimedBlockInput => ({
  task: task({ source: { filePath, line: start } }),
  startMinutes: start,
  durationMinutes: duration,
});

describe('time/pixel conversions', () => {
  it('minutesToPixels scales by PIXELS_PER_HOUR', () => {
    expect(minutesToPixels(60)).toBe(PIXELS_PER_HOUR);
    expect(minutesToPixels(30)).toBe(PIXELS_PER_HOUR / 2);
  });
  it('pixelsToMinutes is the inverse of minutesToPixels', () => {
    expect(pixelsToMinutes(PIXELS_PER_HOUR)).toBe(60);
    expect(pixelsToMinutes(48)).toBe(60);
    expect(pixelsToMinutes(minutesToPixels(90))).toBe(90);
    expect(minutesToPixels(pixelsToMinutes(120))).toBe(120);
  });
  it('timeStringToMinutes/minutesToTimeString round-trip', () => {
    expect(timeStringToMinutes('15:00')).toBe(900);
    expect(minutesToTimeString(900)).toBe('15:00');
    expect(timeStringToMinutes('09:05')).toBe(545);
    expect(minutesToTimeString(545)).toBe('09:05');
  });
  it('snapMinutes rounds to the nearest step', () => {
    expect(snapMinutes(7, 15)).toBe(0);
    expect(snapMinutes(8, 15)).toBe(15);
    expect(snapMinutes(-4, 15)).toBe(0);
  });
});

describe('packOverlaps', () => {
  it('non-overlapping blocks each get column 0 of 1', () => {
    const result = packOverlaps([timedBlockInput(9 * 60, 60), timedBlockInput(11 * 60, 60)]);
    expect(result.every((b) => b.column === 0 && b.columns === 1)).toBe(true);
  });

  it('two overlapping blocks get columns 0 and 1, columns=2', () => {
    const result = packOverlaps([timedBlockInput(9 * 60, 60), timedBlockInput(9 * 60 + 30, 60)]);
    expect(result.map((b) => b.column).sort((left, right) => left - right)).toEqual([0, 1]);
    expect(result.every((b) => b.columns === 2)).toBe(true);
  });

  it('three overlapping blocks get 3 distinct columns', () => {
    const result = packOverlaps([
      timedBlockInput(9 * 60, 90),
      timedBlockInput(9 * 60, 90),
      timedBlockInput(9 * 60, 90),
    ]);
    expect(new Set(result.map((b) => b.column)).size).toBe(3);
    expect(result.every((b) => b.columns === 3)).toBe(true);
  });

  it('assigns simultaneous blocks stable identity lanes independent of projection order', () => {
    const a = timedBlockInput(9 * 60, 90, 'A.md');
    const b = timedBlockInput(9 * 60, 90, 'B.md');
    const columnsByPath = (inputs: readonly TimedBlockInput[]) =>
      Object.fromEntries(
        packOverlaps(inputs).map(({ task: positionedTask, column }) => [
          positionedTask.source.filePath,
          column,
        ]),
      );

    expect(columnsByPath([b, a])).toEqual({ 'A.md': 0, 'B.md': 1 });
    expect(columnsByPath([a, b])).toEqual({ 'A.md': 0, 'B.md': 1 });
  });

  it('a block ending exactly when another starts does not count as overlapping', () => {
    const result = packOverlaps([timedBlockInput(9 * 60, 60), timedBlockInput(10 * 60, 60)]);
    expect(result.every((b) => b.column === 0 && b.columns === 1)).toBe(true);
  });

  it('reuses a freed column once its occupant has ended', () => {
    // A: 9-10, B: 9-10 (overlap, cols 0/1), C: 10-11 (A freed col 0 -> C takes col 0)
    const result = packOverlaps([
      timedBlockInput(9 * 60, 60),
      timedBlockInput(9 * 60, 60),
      timedBlockInput(10 * 60, 60),
    ]);
    const c = expectDefined(result[2]);
    expect(c.column).toBe(0);
  });

  it('empty input returns empty output', () => {
    expect(packOverlaps([])).toEqual([]);
  });
});

// Task 36: a min-height CSS rule on `.abyss-tg-block` guarantees a short-duration block's
// checkbox+title row stays legible, but that rule can only grow a block past its
// duration-derived height — so a short block scheduled immediately before another block in the
// same column could visually grow into it. `capMinHeightsPx` computes, per block, the maximum
// height it may safely occupy before crossing into whatever's next in its own column.
describe('capMinHeightsPx', () => {
  it('two back-to-back 10-minute blocks in the same column: the earlier one is capped to the real gap between them, well under MIN_BLOCK_HEIGHT_PX', () => {
    const positioned = packOverlaps([
      timedBlockInput(9 * 60, 10),
      timedBlockInput(9 * 60 + 10, 10),
    ]);
    expect(positioned.every((b) => b.column === 0)).toBe(true); // sanity: truly sequential, same column
    const caps = capMinHeightsPx(positioned);
    const [first, second] = positioned;
    const firstCap = expectDefined(caps.get(expectDefined(first)));
    // The gap between the two blocks' start times is exactly 10 minutes (8px) — far less than
    // MIN_BLOCK_HEIGHT_PX (~24.5px), so the CSS min-height would otherwise grow the first block
    // past the second one's top: this cap is what prevents that visual overlap.
    expect(firstCap).toBeLessThan(MIN_BLOCK_HEIGHT_PX);
    expect(firstCap).toBeCloseTo(minutesToPixels(10) - 2, 5);
    // The last (only remaining) occupant of its column has nothing after it to crowd into.
    expect(caps.get(expectDefined(second))).toBe(Infinity);
  });

  it('a lone block in its column (no next occupant) is uncapped (Infinity), so the full CSS min-height is free to apply', () => {
    const positioned = packOverlaps([timedBlockInput(9 * 60, 60)]);
    const caps = capMinHeightsPx(positioned);
    expect(caps.get(expectDefined(positioned[0]))).toBe(Infinity);
  });

  it('a generous gap between two same-column blocks yields a cap comfortably above MIN_BLOCK_HEIGHT_PX (no clamping needed)', () => {
    const positioned = packOverlaps([timedBlockInput(9 * 60, 10), timedBlockInput(11 * 60, 10)]);
    const caps = capMinHeightsPx(positioned);
    expect(expectDefined(caps.get(expectDefined(positioned[0])))).toBeGreaterThan(
      MIN_BLOCK_HEIGHT_PX,
    );
  });

  it('two simultaneous (overlapping) blocks land in different columns, each uncapped by the other — min-height growth is a vertical concern, not a horizontal one', () => {
    const positioned = packOverlaps([timedBlockInput(9 * 60, 10), timedBlockInput(9 * 60, 10)]);
    expect(new Set(positioned.map((b) => b.column)).size).toBe(2);
    const caps = capMinHeightsPx(positioned);
    expect(caps.get(expectDefined(positioned[0]))).toBe(Infinity);
    expect(caps.get(expectDefined(positioned[1]))).toBe(Infinity);
  });
});
