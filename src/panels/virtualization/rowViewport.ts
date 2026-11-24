import { arrayRowSource, IndexedRowGeometry } from './indexedRowGeometry';

export interface RowViewportRow {
  readonly key: string;
  readonly estimatedHeight: number;
  readonly measurementRevision: string;
}

export type RowAnchorKeyRange =
  | { readonly kind: 'key'; readonly key: string }
  | {
      readonly kind: 'series';
      readonly series: string;
      readonly from: number;
      readonly to: number;
    };
export interface RowViewportSource {
  readonly length: number;
  rowAt(index: number): RowViewportRow | undefined;
  indexOf(key: string): number;
  estimatedOffset(index: number): number;
  anchorRanges(): readonly RowAnchorKeyRange[];
  survivingNeighbor(
    previousIndex: number,
    direction: 1 | -1,
    current: RowViewportSource,
  ): string | undefined;
}

export interface RowMeasurement {
  readonly key: string;
  readonly height: number;
}

export interface RowBounds {
  readonly key: string;
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
}

export interface RowAnchor {
  readonly key: string;
  readonly offset: number;
  readonly previousIndex: number;
  readonly previousOrder: RowViewportSource;
}

export type RowSegment = { readonly index: number } | { readonly height: number };

export interface RowWindow {
  readonly start: number;
  readonly end: number;
  readonly scrollTop: number;
  readonly segments: readonly RowSegment[];
}

export type InteractiveBuffer = 'interactive' | 'search' | 'timeline';
export type ScrollBuffer = 'initial' | 'scroll' | 'history' | 'timeline-seek' | InteractiveBuffer;

const TIMELINE_ROW_BUDGET = 76;

function interactiveMargins(
  buffer: InteractiveBuffer,
  height: number,
  visibleRows: number,
): { reserve: number; keepRows: number; refillRows: number } {
  if (buffer === 'timeline') {
    // A vertical fling can advance one screen between paints. Leave room for explicit pins.
    const extra = Math.max(0, Math.floor((TIMELINE_ROW_BUDGET - visibleRows) / 2));
    return { reserve: height, keepRows: extra, refillRows: extra };
  }
  return buffer === 'search'
    ? { reserve: 640, keepRows: 18, refillRows: 20 }
    : { reserve: Math.min(600, height * 0.65), keepRows: 7, refillRows: 12 };
}

interface BufferedRange {
  readonly buffer: ScrollBuffer;
  readonly start: number;
  readonly end: number;
  readonly height: number;
}

/** Pure row geometry. Native owners supply content-relative offsets and usable viewport heights. */
export class RowViewport {
  readonly #geometry = new IndexedRowGeometry();
  #range: BufferedRange | undefined;
  #seekTop: number | undefined;
  readonly #overscanPx: number;
  readonly #scrollReservePx: number;

  constructor(overscanPx = 170, scrollReservePx = 0) {
    this.#scrollReservePx = Number.isFinite(scrollReservePx) ? Math.max(0, scrollReservePx) : 0;
    this.#overscanPx = Number.isFinite(overscanPx) ? Math.max(0, overscanPx) : 170;
  }

  replace(rows: readonly RowViewportRow[]): void {
    this.replaceIndexed(arrayRowSource(rows));
  }

  replaceIndexed(source: RowViewportSource): void {
    this.#range = undefined;
    this.#seekTop = undefined;
    this.#geometry.replace(source);
  }

  get totalHeight(): number {
    return this.#geometry.offset(this.#geometry.source.length);
  }

  measure(
    measurements: readonly RowMeasurement[],
    scrollTop: number,
    retainedAnchor?: RowAnchor,
  ): { scrollTop: number; changed: boolean } {
    const boundary = this.#geometry.boundary(scrollTop);
    const anchor =
      this.#geometry.offset(boundary) === scrollTop ? boundary : Math.max(0, boundary - 1);
    const oldOffset =
      retainedAnchor === undefined
        ? this.#geometry.offset(anchor)
        : this.restoreAnchor(retainedAnchor, scrollTop);
    const changed = this.#geometry.measure(
      measurements,
      retainedAnchor?.key ?? this.#bounds(anchor)?.key,
    );
    if (!changed) return { scrollTop, changed };
    this.#invalidateMeasuredRange();
    const nextOffset =
      retainedAnchor === undefined
        ? this.#geometry.offset(anchor)
        : this.restoreAnchor(retainedAnchor, scrollTop);
    return { scrollTop: scrollTop + nextOffset - oldOffset, changed };
  }
  #invalidateMeasuredRange(): void {
    if (this.#range?.buffer !== 'history' && this.#seekTop === undefined) this.#range = undefined;
  }

  rowBounds(key: string): RowBounds | undefined {
    const index = this.#geometry.source.indexOf(key);
    return index < 0 ? undefined : this.#bounds(index);
  }

  rowAt(offset: number): RowBounds | undefined {
    const total = this.#geometry.offset(this.#geometry.source.length);
    if (!Number.isFinite(offset) || offset < 0 || offset >= total) return undefined;
    const boundary = this.#geometry.boundary(offset);
    const index = this.#geometry.offset(boundary) === offset ? boundary : boundary - 1;
    return this.#bounds(index);
  }

  #bounds(index: number): RowBounds | undefined {
    const row = this.#geometry.source.rowAt(index);
    if (row === undefined) return undefined;
    const top = this.#geometry.offset(index);
    return { key: row.key, index, top, bottom: this.#geometry.offset(index + 1) };
  }

  captureAnchor(top: number): RowAnchor | undefined {
    const row = this.rowAt(top);
    if (row === undefined) return undefined;
    return {
      key: row.key,
      offset: top - row.top,
      previousIndex: row.index,
      previousOrder: this.#geometry.source,
    };
  }

  restoreAnchor(anchor: RowAnchor | undefined, fallbackTop: number): number {
    if (anchor === undefined) return fallbackTop;
    const surviving = this.rowBounds(anchor.key);
    if (surviving !== undefined) return surviving.top + anchor.offset;
    const neighbor = this.#survivingNeighbor(anchor, 1) ?? this.#survivingNeighbor(anchor, -1);
    return neighbor === undefined ? 0 : neighbor.top + anchor.offset;
  }

  #survivingNeighbor(anchor: RowAnchor, step: 1 | -1): RowBounds | undefined {
    const key = anchor.previousOrder.survivingNeighbor(
      anchor.previousIndex,
      step,
      this.#geometry.source,
    );
    return key === undefined ? undefined : this.rowBounds(key);
  }

  reveal(key: string, requestedTop: number, viewportHeight: number): number {
    const row = this.rowBounds(key);
    if (row === undefined) return requestedTop;
    const height = viewportHeight > 0 ? viewportHeight : 340;
    if (row.bottom - row.top > height) {
      // A tall row cannot fit: retain an intersecting viewport, or reveal its nearest edge.
      if (row.bottom <= requestedTop) return row.bottom - height;
      if (row.top >= requestedTop + height) return row.top;
      return requestedTop;
    }
    if (row.top < requestedTop) return row.top;
    return Math.max(requestedTop, row.bottom - height);
  }

  window(
    requestedTop: number,
    viewportHeight: number,
    pinned: readonly string[],
    buffer: ScrollBuffer = 'scroll',
  ): RowWindow {
    const count = this.#geometry.source.length;
    const measuredHeight = viewportHeight > 0 ? viewportHeight : 0;
    const height = measuredHeight > 0 ? measuredHeight : 340;
    const total = this.#geometry.offset(count);
    const scrollTop = Math.max(0, Math.min(requestedTop, Math.max(0, total - measuredHeight)));
    if (buffer !== 'history' && this.#range?.buffer === 'history') this.#range = undefined;
    const { start, end } = this.#rangeFor(scrollTop, height, buffer);
    const indices = new Set<number>();
    for (let index = start; index < end; index++) indices.add(index);
    for (const key of pinned) {
      const index = this.#geometry.source.indexOf(key);
      if (index >= 0) indices.add(index);
    }
    this.#geometry.retain(
      [...indices].flatMap((index) => {
        const row = this.#geometry.source.rowAt(index);
        return row === undefined ? [] : [row.key];
      }),
    );
    return { start, end, scrollTop, segments: this.#segments(indices) };
  }

  /** Grow the last published wheel destination without measuring DOM or admitting more than four neighbors. */
  extendTimelineReserve(): 'stable' | 'partial' | 'full' {
    const previous = this.#range;
    if (previous === undefined || this.#seekTop === undefined) return 'stable';
    const target = this.#interactiveRange(this.#seekTop, previous.height, 'timeline');
    if (previous.start <= target.start && previous.end >= target.end) {
      this.#range = { ...previous, buffer: 'timeline' };
      return 'stable';
    }
    const start = Math.max(target.start, previous.start - 2);
    const end = Math.min(target.end, previous.end + 2);
    if (start === target.start && end === target.end) return 'full';
    this.#range = { ...target, start, end, buffer: 'timeline-seek' };
    return 'partial';
  }

  #rangeFor(scrollTop: number, height: number, buffer: ScrollBuffer): BufferedRange {
    if (buffer === 'timeline-seek') {
      this.#seekTop = scrollTop;
      return this.#seekRange(scrollTop, height);
    }
    this.#seekTop = undefined;
    return buffer === 'initial' || buffer === 'scroll' || buffer === 'history'
      ? this.#listRange(scrollTop, height, buffer)
      : this.#interactiveRange(scrollTop, height, buffer);
  }

  #seekRange(top: number, height: number): BufferedRange {
    const first = Math.max(0, this.#geometry.boundary(top) - 1);
    const last = this.#geometry.boundary(top + height);
    const previous = this.#range?.height === height ? this.#range : undefined;
    if (previous !== undefined && previous.start <= first && previous.end >= last) return previous;
    let start = Math.max(0, first - 2);
    let end = Math.min(this.#geometry.source.length, last + 2);
    if (previous !== undefined && previous.start < last && first < previous.end) {
      // Keep recent rows for a reversal without mounting extra cards on a cold seek.
      const { keepRows } = interactiveMargins('timeline', height, last - first);
      start = Math.min(start, Math.max(previous.start, first - keepRows));
      end = Math.max(end, Math.min(previous.end, last + keepRows));
    }
    this.#range = {
      start,
      end,
      height,
      buffer: 'timeline-seek',
    };
    return this.#range;
  }

  #listRange(scrollTop: number, height: number, buffer: ScrollBuffer): BufferedRange {
    const previous = this.#range?.height === height ? this.#range : undefined;
    const total = this.#geometry.offset(this.#geometry.source.length);
    const { reserve, refill } = this.#margins(height, buffer);
    const bufferedTop = Math.max(0, scrollTop - reserve);
    const bufferedBottom = Math.min(total, scrollTop + height + reserve);
    if (
      previous !== undefined &&
      this.#geometry.offset(previous.start) <= bufferedTop &&
      this.#geometry.offset(previous.end) >= bufferedBottom
    )
      return previous;
    // Refill before the scroll reserve is exposed. Extra overscan absorbs small movements.
    const start = Math.max(0, this.#geometry.boundary(bufferedTop - refill) - 1);
    const end = Math.min(
      this.#geometry.source.length,
      this.#geometry.boundary(bufferedBottom + refill),
    );
    const bounded = { start, end, height, buffer };
    this.#range =
      buffer === 'history' && previous !== undefined
        ? this.#keepVisited(bounded, previous, scrollTop, 256)
        : bounded;
    return this.#range;
  }

  // Each board column, timeline row or search candidate can own heavy content.
  // Bound only the extra rows. The entire viewport and its explicit pins always fit.
  #interactiveRange(top: number, height: number, buffer: InteractiveBuffer): BufferedRange {
    const previous = this.#range?.height === height ? this.#range : undefined;
    const first = Math.max(0, this.#geometry.boundary(top) - 1);
    const last = this.#geometry.boundary(top + height);
    const { reserve, keepRows, refillRows } = interactiveMargins(buffer, height, last - first);
    const start = Math.max(first - keepRows, this.#geometry.boundary(top - reserve) - 1, 0);
    const end = Math.min(last + keepRows, this.#geometry.boundary(top + height + reserve));
    if (previous?.buffer === buffer && previous.start <= start && previous.end >= end)
      return previous;
    const margin = reserve + Math.min(400, height * 0.48);
    const bounded = {
      start: Math.max(first - refillRows, this.#geometry.boundary(top - margin) - 1, 0),
      end: Math.min(last + refillRows, this.#geometry.boundary(top + height + margin)),
      height,
      buffer,
    };
    this.#range =
      buffer === 'timeline' && previous?.buffer === 'timeline'
        ? this.#keepVisited(bounded, previous, top, TIMELINE_ROW_BUDGET)
        : bounded;
    return this.#range;
  }

  #margins(height: number, buffer: ScrollBuffer): { reserve: number; refill: number } {
    if (buffer === 'initial' || this.#scrollReservePx === 0)
      return { reserve: this.#scrollReservePx, refill: this.#overscanPx };
    return {
      reserve: Math.max(this.#scrollReservePx, Math.min(1600, height * 1.25)),
      refill: Math.max(this.#overscanPx, Math.min(900, height * 0.75)),
    };
  }

  #keepVisited(
    next: BufferedRange,
    previous: BufferedRange,
    top: number,
    budget: number,
  ): BufferedRange {
    // A scrollbar jump starts a fresh window. During a continuous gesture retain
    // the rows already traversed, so reversing direction stays native.
    if (
      top < this.#geometry.offset(previous.start) ||
      top + next.height > this.#geometry.offset(previous.end) + 1
    )
      return next;
    const capacity = Math.max(budget, next.end - next.start);
    const start = Math.max(Math.min(next.start, previous.start), next.end - capacity);
    const end = Math.min(Math.max(next.end, previous.end), start + capacity);
    return { ...next, start, end };
  }

  #segments(indices: ReadonlySet<number>): RowSegment[] {
    const count = this.#geometry.source.length;
    const total = this.#geometry.offset(count);
    const segments: RowSegment[] = [];
    let cursor = 0;
    for (const index of [...indices].sort((left, right) => left - right)) {
      if (index > cursor) {
        segments.push({
          height: this.#geometry.offset(index) - this.#geometry.offset(cursor),
        });
      }
      segments.push({ index });
      cursor = index + 1;
    }
    if (cursor < count) segments.push({ height: total - this.#geometry.offset(cursor) });
    return segments;
  }
}
