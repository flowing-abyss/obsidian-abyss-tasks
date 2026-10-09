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

interface BufferedRange {
  readonly start: number;
  readonly end: number;
  readonly height: number;
}

/** Pure row geometry. Native owners supply content-relative offsets and usable viewport heights. */
export class RowViewport {
  readonly #geometry = new IndexedRowGeometry();
  #range: BufferedRange | undefined;
  readonly #overscanPx: number;

  constructor(overscanPx = 170) {
    this.#overscanPx = Number.isFinite(overscanPx) ? Math.max(0, overscanPx) : 170;
  }

  replace(rows: readonly RowViewportRow[]): void {
    this.replaceIndexed(arrayRowSource(rows));
  }

  replaceIndexed(source: RowViewportSource): void {
    this.#range = undefined;
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
    this.#range = undefined;
    const nextOffset =
      retainedAnchor === undefined
        ? this.#geometry.offset(anchor)
        : this.restoreAnchor(retainedAnchor, scrollTop);
    return { scrollTop: scrollTop + nextOffset - oldOffset, changed };
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

  window(requestedTop: number, viewportHeight: number, pinned: readonly string[]): RowWindow {
    const count = this.#geometry.source.length;
    const measuredHeight = viewportHeight > 0 ? viewportHeight : 0;
    const height = measuredHeight > 0 ? measuredHeight : 340;
    const total = this.#geometry.offset(count);
    const scrollTop = Math.max(0, Math.min(requestedTop, Math.max(0, total - measuredHeight)));
    const { start, end } = this.#rangeFor(scrollTop, height);
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

  #rangeFor(scrollTop: number, height: number): BufferedRange {
    const previous = this.#range;
    const total = this.#geometry.offset(this.#geometry.source.length);
    const visibleBottom = Math.min(total, scrollTop + height);
    if (
      previous?.height === height &&
      this.#geometry.offset(previous.start) <= scrollTop &&
      this.#geometry.offset(previous.end) >= visibleBottom
    )
      return previous;
    // Consume the existing overscan before refilling it. Small scroll steps do not change DOM.
    const start = Math.max(0, this.#geometry.boundary(scrollTop - this.#overscanPx) - 1);
    const end = Math.min(
      this.#geometry.source.length,
      this.#geometry.boundary(scrollTop + height + this.#overscanPx),
    );
    this.#range = { start, end, height };
    return this.#range;
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
