import type { TaskSnapshot } from '../../tasks';

export const PIXELS_PER_HOUR = 48;

export interface TimedBlockInput {
  task: TaskSnapshot;
  startMinutes: number;
  durationMinutes: number;
}

export interface PositionedBlock extends TimedBlockInput {
  column: number;
  columns: number;
}

export function minutesToPixels(minutes: number): number {
  return (minutes / 60) * PIXELS_PER_HOUR;
}

export function pixelsToMinutes(pixels: number): number {
  return (pixels / PIXELS_PER_HOUR) * 60;
}

export function timeStringToMinutes(time: string): number {
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function snapMinutes(rawMinutes: number, stepMinutes: number): number {
  const result = Math.round(rawMinutes / stepMinutes) * stepMinutes;
  return result === 0 ? 0 : result;
}

// Task 36: minimum rendered height for a `.tc-tg-block`/`.tc-tg-block-continuation`, mirroring
// styles.css's own `min-height` rule there (kept in sync by cross-referencing comments on both
// sides, not read from the DOM — see the comment on `capMinHeightsPx` below for why this can't
// just be measured). The value is derived, not guessed: `.tc-tg-block` sets `padding: 2px 6px`
// (2px top + 2px bottom) and `font-size: 0.8em`; its tallest row is `.tc-tg-block-head`, whose
// checkbox (`.tc-status-marker`) is sized at `1.6em` of that same 0.8em block font-size — so the
// minimum height that keeps the checkbox+title row fully legible is 2*2px of padding plus that
// 1.6em marker height. Obsidian's own base font-size is 16px, so this resolves to a concrete
// pixel figure for the JS-side collision-avoidance pass below; the CSS rule itself uses `calc()`
// with real `em`s, so it stays correct even if the user's actual root font-size differs — this
// constant is only a (deliberately close, not exact) approximation for that JS pass.
const ASSUMED_ROOT_FONT_PX = 16;
const BLOCK_FONT_PX = ASSUMED_ROOT_FONT_PX * 0.8;
export const MIN_BLOCK_HEIGHT_PX = BLOCK_FONT_PX * 1.6 + 2 * 2;

// Small breathing-room margin subtracted from the available gap before it's offered to a short
// block as its clamped min-height, so two back-to-back blocks that are forced to share a tight
// gap still show a hairline gap between them instead of touching pixel-for-pixel.
const MIN_BLOCK_GAP_MARGIN_PX = 2;

/**
 * Task 36: `.tc-tg-block`'s CSS `min-height` (see styles.css) guarantees a short-duration block
 * never renders too short to show its checkbox+title row legibly — but that min-height can only
 * ever GROW a block past the height its actual duration would give it (`minutesToPixels`
 * never shrinks to make room). Two blocks in the same column are only ever placed there by
 * `packOverlaps` because they don't overlap in time (the column-reuse rule requires the previous
 * occupant to have already ended) — but "don't overlap in time" doesn't mean "have enough real
 * estate for both to hit the CSS min-height without visually touching/crossing." A block whose
 * min-height-inflated box would cross into the next same-column block's own top needs its
 * min-height clamped back down to whatever room is actually available.
 *
 * Returns, for each block (keyed by object identity — safe since `packOverlaps` already
 * allocates a fresh object per input), the maximum height in pixels it may occupy before
 * reaching the next block sharing its column (or `Infinity` if it's the last/only occupant of
 * that column, in which case the CSS min-height is free to apply in full).
 */
export function capMinHeightsPx(positioned: PositionedBlock[]): Map<PositionedBlock, number> {
  const byColumn = new Map<number, PositionedBlock[]>();
  for (const b of positioned) {
    const arr = byColumn.get(b.column);
    if (arr) arr.push(b);
    else byColumn.set(b.column, [b]);
  }

  const caps = new Map<PositionedBlock, number>();
  for (const columnBlocks of byColumn.values()) {
    // `positioned` (and therefore each per-column subsequence) is already in ascending
    // startMinutes order, since packOverlaps builds it by iterating its own time-sorted array.
    for (let i = 0; i < columnBlocks.length; i++) {
      const cur = columnBlocks[i]!;
      const next = columnBlocks[i + 1];
      const gapPx = next
        ? minutesToPixels(next.startMinutes - cur.startMinutes) - MIN_BLOCK_GAP_MARGIN_PX
        : Infinity;
      caps.set(cur, gapPx);
    }
  }
  return caps;
}

/**
 * Task 37: `capMinHeightsPx`'s continuation-segment counterpart. `.tc-tg-block-continuation`
 * (the retained `renderTimedSpanContinuation` compatibility shape) got the same
 * CSS min-height treatment `.tc-tg-block` did (Task 36) — but continuation segments never go
 * through `packOverlaps`: they're always rendered full-width, one per task, with no column
 * packing at all. So the same growth-crossing-into-a-neighbor problem `capMinHeightsPx` solves for
 * anchor blocks can happen here too, just without a `column` to key off of.
 *
 * Rather than inventing column packing for these compatibility continuations (they're always
 * full-width), this treats every continuation segment for a day as occupying one shared "column"
 * with each other AND with that day's already-positioned anchor blocks (passed as `others`, e.g.
 * `renderTimedBlocksForDay`'s `positioned` array for the same day), so a continuation's
 * min-height can clamp against an anchor supplied by a legacy caller too.
 *
 * Only continuation segments are ever capped (returned in the map) — an anchor block's own cap
 * against OTHER anchor blocks is still `capMinHeightsPx`'s unchanged job; this function only ever
 * uses `others` as read-only context for what a continuation might grow into.
 */
export function capContinuationMinHeightsPx(
  continuations: TimedBlockInput[],
  others: TimedBlockInput[] = [],
): Map<TimedBlockInput, number> {
  interface Item {
    startMinutes: number;
    input: TimedBlockInput;
    isContinuation: boolean;
  }
  const items: Item[] = [
    ...continuations.map((input) => ({
      startMinutes: input.startMinutes,
      input,
      isContinuation: true,
    })),
    ...others.map((input) => ({ startMinutes: input.startMinutes, input, isContinuation: false })),
  ].sort((a, b) => a.startMinutes - b.startMinutes);

  const caps = new Map<TimedBlockInput, number>();
  for (let i = 0; i < items.length; i++) {
    const cur = items[i]!;
    if (!cur.isContinuation) continue;
    const next = items[i + 1];
    const gapPx = next
      ? minutesToPixels(next.startMinutes - cur.startMinutes) - MIN_BLOCK_GAP_MARGIN_PX
      : Infinity;
    caps.set(cur.input, gapPx);
  }
  return caps;
}

/**
 * Google-Calendar-style column packing for overlapping time-grid events: sort
 * by start time, assign each block the lowest-numbered column whose previous
 * occupant has already ended, then set `columns` to the max column index + 1
 * within each maximal overlapping cluster.
 */
export function packOverlaps(blocks: TimedBlockInput[]): PositionedBlock[] {
  const sorted = [...blocks].sort((a, b) => a.startMinutes - b.startMinutes);
  const positioned: PositionedBlock[] = [];
  let columnEnds: number[] = [];
  let cluster: PositionedBlock[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = (): void => {
    if (!cluster.length) return;
    const columnsUsed = Math.max(...cluster.map((b) => b.column)) + 1;
    for (const b of cluster) b.columns = columnsUsed;
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const block of sorted) {
    const end = block.startMinutes + block.durationMinutes;
    if (block.startMinutes >= clusterEnd) closeCluster();

    let col = columnEnds.findIndex((colEnd) => colEnd <= block.startMinutes);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[col] = end;
    }

    const positionedBlock: PositionedBlock = { ...block, column: col, columns: 0 };
    cluster.push(positionedBlock);
    positioned.push(positionedBlock);
    clusterEnd = Math.max(clusterEnd, end);
  }
  closeCluster();

  return positioned;
}
