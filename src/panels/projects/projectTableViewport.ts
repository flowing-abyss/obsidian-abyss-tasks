interface TableViewportRow {
  readonly key: string;
  readonly height: number;
}

type TableViewportSegment = { readonly index: number } | { readonly height: number };

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

/** Geometry for the existing project table body; keys identify grouped occurrences and headers. */
export class ProjectTableViewport {
  #rows: readonly TableViewportRow[] = [];
  #indices = new Map<string, number>();
  readonly #heights = new Map<string, number>();
  #offsets: number[] = [0];

  replace(rows: readonly TableViewportRow[]): void {
    this.#rows = rows;
    this.#indices = new Map(rows.map(({ key }, index) => [key, index]));
    for (const key of this.#heights.keys()) {
      if (!this.#indices.has(key)) this.#heights.delete(key);
    }
    this.#rebuildOffsets();
  }

  #rebuildOffsets(): void {
    let total = 0;
    this.#offsets = [0];
    for (const row of this.#rows) {
      total += this.#heights.get(row.key) ?? row.height;
      this.#offsets.push(total);
    }
  }

  measure(
    measurements: readonly TableViewportRow[],
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
    this.#rebuildOffsets();
    return { scrollTop: scrollTop + (this.#offsets[anchor] ?? 0) - oldOffset, changed };
  }

  #measureRow({ key, height }: TableViewportRow): boolean {
    const index = this.#indices.get(key);
    if (index === undefined || !Number.isFinite(height) || height <= 0) return false;
    const previous = this.#heights.get(key) ?? this.#rows[index]?.height;
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return false;
    this.#heights.set(key, height);
    return true;
  }

  reveal(key: string, requestedTop: number, viewportHeight: number): number {
    const index = this.#indices.get(key);
    if (index === undefined) return requestedTop;
    const top = this.#offsets[index] ?? 0;
    const bottom = this.#offsets[index + 1] ?? top;
    if (top < requestedTop) return top;
    return Math.max(requestedTop, bottom - (viewportHeight > 0 ? viewportHeight : 340));
  }

  window(
    requestedTop: number,
    viewportHeight: number,
    pinned: readonly string[],
  ): {
    readonly start: number;
    readonly end: number;
    readonly scrollTop: number;
    readonly segments: readonly TableViewportSegment[];
  } {
    const count = this.#rows.length;
    const measuredHeight = viewportHeight > 0 ? viewportHeight : 0;
    const height = measuredHeight > 0 ? measuredHeight : 340;
    const total = this.#offsets[count] ?? 0;
    const scrollTop = Math.max(0, Math.min(requestedTop, Math.max(0, total - measuredHeight)));
    const start = Math.max(0, rowBoundary(this.#offsets, scrollTop - 170) - 1);
    const end = Math.min(count, rowBoundary(this.#offsets, scrollTop + height + 170));
    const indices = new Set<number>();
    for (let index = start; index < end; index++) indices.add(index);
    for (const key of pinned) {
      const index = this.#indices.get(key);
      if (index !== undefined) indices.add(index);
    }
    return { start, end, scrollTop, segments: this.#segments(indices) };
  }

  #segments(indices: ReadonlySet<number>): TableViewportSegment[] {
    const count = this.#rows.length;
    const total = this.#offsets[count] ?? 0;
    const segments: TableViewportSegment[] = [];
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
