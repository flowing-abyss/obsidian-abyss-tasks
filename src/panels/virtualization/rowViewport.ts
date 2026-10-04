export interface RowViewportRow {
  readonly key: string;
  readonly estimatedHeight: number;
  readonly measurementRevision: string;
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
  readonly previousKeys: readonly string[];
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

function rowBoundary(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? Infinity) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Pure row geometry. Native owners supply content-relative offsets and usable viewport heights. */
export class RowViewport {
  #rows: readonly RowViewportRow[] = [];
  #keys: readonly string[] = Object.freeze([]);
  #indices = new Map<string, number>();
  readonly #heights = new Map<string, { height: number; revision: string }>();
  #offsets: number[] = [0];
  #range: BufferedRange | undefined;
  readonly #overscanPx: number;

  constructor(overscanPx = 170) {
    this.#overscanPx = Number.isFinite(overscanPx) ? Math.max(0, overscanPx) : 170;
  }

  replace(rows: readonly RowViewportRow[]): void {
    this.#range = undefined;
    this.#rows = rows.map((row) => ({
      ...row,
      estimatedHeight:
        Number.isFinite(row.estimatedHeight) && row.estimatedHeight > 0 ? row.estimatedHeight : 1,
    }));
    // Anchors share one immutable order snapshot until the next replacement.
    this.#keys = Object.freeze(rows.map(({ key }) => key));
    this.#indices = new Map(rows.map(({ key }, index) => [key, index]));
    for (const [key, measurement] of this.#heights) {
      const index = this.#indices.get(key);
      if (index === undefined || this.#rows[index]?.measurementRevision !== measurement.revision)
        this.#heights.delete(key);
    }
    this.#rebuildOffsets();
  }

  #rebuildOffsets(): void {
    let total = 0;
    this.#offsets = [0];
    for (const row of this.#rows) {
      total += this.#heights.get(row.key)?.height ?? row.estimatedHeight;
      this.#offsets.push(total);
    }
  }

  measure(
    measurements: readonly RowMeasurement[],
    scrollTop: number,
  ): { scrollTop: number; changed: boolean } {
    const boundary = rowBoundary(this.#offsets, scrollTop);
    const anchor = this.#offsets[boundary] === scrollTop ? boundary : Math.max(0, boundary - 1);
    const oldOffset = this.#offsets[anchor] ?? 0;
    let changed = false;
    for (const measurement of measurements) {
      if (this.#measureRow(measurement)) changed = true;
    }
    if (!changed) return { scrollTop, changed };
    this.#range = undefined;
    this.#rebuildOffsets();
    return { scrollTop: scrollTop + (this.#offsets[anchor] ?? 0) - oldOffset, changed };
  }

  #measureRow({ key, height }: RowMeasurement): boolean {
    const index = this.#indices.get(key);
    if (index === undefined || !Number.isFinite(height) || height <= 0) return false;
    const row = this.#rows[index];
    if (row === undefined) return false;
    const previous = this.#heights.get(key)?.height ?? row.estimatedHeight;
    if (Math.abs(previous - height) < 0.5) return false;
    this.#heights.set(key, { height, revision: row.measurementRevision });
    return true;
  }

  rowBounds(key: string): RowBounds | undefined {
    const index = this.#indices.get(key);
    return index === undefined ? undefined : this.#bounds(index);
  }

  rowAt(offset: number): RowBounds | undefined {
    const total = this.#offsets[this.#rows.length] ?? 0;
    if (!Number.isFinite(offset) || offset < 0 || offset >= total) return undefined;
    const boundary = rowBoundary(this.#offsets, offset);
    const index = this.#offsets[boundary] === offset ? boundary : boundary - 1;
    return this.#bounds(index);
  }

  #bounds(index: number): RowBounds | undefined {
    const row = this.#rows[index];
    if (row === undefined) return undefined;
    const top = this.#offsets[index] ?? 0;
    return { key: row.key, index, top, bottom: this.#offsets[index + 1] ?? top };
  }

  captureAnchor(top: number): RowAnchor | undefined {
    const row = this.rowAt(top);
    if (row === undefined) return undefined;
    return {
      key: row.key,
      offset: top - row.top,
      previousIndex: row.index,
      previousKeys: this.#keys,
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
    for (
      let index = anchor.previousIndex + step;
      index >= 0 && index < anchor.previousKeys.length;
      index += step
    ) {
      const key = anchor.previousKeys[index];
      const row = key === undefined ? undefined : this.rowBounds(key);
      if (row !== undefined) return row;
    }
    return undefined;
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
    const count = this.#rows.length;
    const measuredHeight = viewportHeight > 0 ? viewportHeight : 0;
    const height = measuredHeight > 0 ? measuredHeight : 340;
    const total = this.#offsets[count] ?? 0;
    const scrollTop = Math.max(0, Math.min(requestedTop, Math.max(0, total - measuredHeight)));
    const { start, end } = this.#rangeFor(scrollTop, height);
    const indices = new Set<number>();
    for (let index = start; index < end; index++) indices.add(index);
    for (const key of pinned) {
      const index = this.#indices.get(key);
      if (index !== undefined) indices.add(index);
    }
    return { start, end, scrollTop, segments: this.#segments(indices) };
  }

  #rangeFor(scrollTop: number, height: number): BufferedRange {
    const previous = this.#range;
    const total = this.#offsets[this.#rows.length] ?? 0;
    const visibleBottom = Math.min(total, scrollTop + height);
    if (
      previous?.height === height &&
      (this.#offsets[previous.start] ?? Infinity) <= scrollTop &&
      (this.#offsets[previous.end] ?? 0) >= visibleBottom
    )
      return previous;
    // Consume the existing overscan before refilling it. Small scroll steps do not change DOM.
    const start = Math.max(0, rowBoundary(this.#offsets, scrollTop - this.#overscanPx) - 1);
    const end = Math.min(
      this.#rows.length,
      rowBoundary(this.#offsets, scrollTop + height + this.#overscanPx),
    );
    this.#range = { start, end, height };
    return this.#range;
  }

  #segments(indices: ReadonlySet<number>): RowSegment[] {
    const count = this.#rows.length;
    const total = this.#offsets[count] ?? 0;
    const segments: RowSegment[] = [];
    let cursor = 0;
    for (const index of [...indices].sort((left, right) => left - right)) {
      if (index > cursor) {
        segments.push({ height: (this.#offsets[index] ?? 0) - (this.#offsets[cursor] ?? 0) });
      }
      segments.push({ index });
      cursor = index + 1;
    }
    if (cursor < count) segments.push({ height: total - (this.#offsets[cursor] ?? 0) });
    return segments;
  }
}
