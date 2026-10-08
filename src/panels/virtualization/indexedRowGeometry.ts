import type { RowMeasurement, RowViewportRow, RowViewportSource } from './rowViewport';

/** Finite sources retain their own per-row estimates and immutable prior order. */
export function arrayRowSource(input: readonly RowViewportRow[]): RowViewportSource {
  const rows = input.map((row) => ({
    ...row,
    estimatedHeight:
      Number.isFinite(row.estimatedHeight) && row.estimatedHeight > 0 ? row.estimatedHeight : 1,
  }));
  const indices = new Map(rows.map((row, index) => [row.key, index]));
  const offsets = [0];
  for (const row of rows) offsets.push((offsets[offsets.length - 1] ?? 0) + row.estimatedHeight);
  return Object.freeze({
    length: rows.length,
    rowAt: (index: number) => rows[index],
    indexOf: (key: string) => indices.get(key) ?? -1,
    estimatedOffset: (index: number) => offsets[index] ?? 0,
    anchorRanges: () => rows.map(({ key }) => ({ kind: 'key' as const, key })),
    survivingNeighbor(previousIndex: number, direction: 1 | -1, current: RowViewportSource) {
      for (let i = previousIndex + direction; i >= 0 && i < rows.length; i += direction) {
        const key = rows[i]?.key;
        if (key !== undefined && current.indexOf(key) >= 0) return key;
      }
      return undefined;
    },
  });
}

interface Measurement {
  readonly height: number;
  readonly revision: string;
}

/** Sparse measured corrections; no vector is sized by the source's logical length. */
export class IndexedRowGeometry {
  source: RowViewportSource = arrayRowSource([]);
  readonly #measurements = new Map<string, Measurement>();
  #indices: number[] = [];
  #prefix: number[] = [0];
  #retained = new Set<string>();

  replace(source: RowViewportSource): void {
    this.source = source;
    for (const [key, measured] of this.#measurements) {
      const row = source.rowAt(source.indexOf(key));
      if (row?.measurementRevision !== measured.revision) this.#measurements.delete(key);
    }
    this.#rebuild();
  }

  retain(keys: Iterable<string>): void {
    this.#retained = new Set(keys);
  }

  offset(index: number): number {
    let low = 0;
    let high = this.#indices.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.#indices[middle] ?? Infinity) < index) low = middle + 1;
      else high = middle;
    }
    return this.source.estimatedOffset(index) + (this.#prefix[low] ?? 0);
  }

  boundary(value: number): number {
    let low = 0;
    let high = this.source.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.offset(middle) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  measure(measurements: readonly RowMeasurement[], anchorKey?: string): boolean {
    let changed = false;
    for (const measurement of measurements) {
      if (this.#measureRow(measurement)) changed = true;
    }
    for (const key of this.#measurements.keys()) {
      if (this.#measurements.size <= 2048) break;
      if (key !== anchorKey && !this.#retained.has(key)) {
        this.#measurements.delete(key);
        changed = true;
      }
    }
    if (changed) this.#rebuild();
    return changed;
  }

  #measureRow({ key, height }: RowMeasurement): boolean {
    const row = this.source.rowAt(this.source.indexOf(key));
    if (row === undefined || !Number.isFinite(height) || height <= 0) return false;
    const previous = this.#measurements.get(key);
    if (Math.abs((previous?.height ?? row.estimatedHeight) - height) < 0.5) return false;
    this.#measurements.delete(key);
    this.#measurements.set(key, { height, revision: row.measurementRevision });
    return true;
  }

  #rebuild(): void {
    const corrections = [...this.#measurements]
      .map(([key, measurement]) => {
        const index = this.source.indexOf(key);
        return {
          index,
          correction: measurement.height - (this.source.rowAt(index)?.estimatedHeight ?? 0),
        };
      })
      .sort((a, b) => a.index - b.index);
    this.#indices = corrections.map(({ index }) => index);
    this.#prefix = [0];
    for (const { correction } of corrections)
      this.#prefix.push((this.#prefix[this.#prefix.length - 1] ?? 0) + correction);
  }
}
