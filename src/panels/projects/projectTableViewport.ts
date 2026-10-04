import { RowViewport, type RowWindow } from '../virtualization/rowViewport';

interface TableViewportRow {
  readonly key: string;
  readonly height: number;
}

/** Compatibility boundary for the existing Table estimates and geometry signatures. */
export class ProjectTableViewport {
  readonly #viewport = new RowViewport();

  replace(rows: readonly TableViewportRow[]): void {
    this.#viewport.replace(
      rows.map((row) => ({
        key: row.key,
        estimatedHeight: row.height,
        measurementRevision: 'table',
      })),
    );
  }

  measure(
    measurements: readonly TableViewportRow[],
    scrollTop: number,
  ): { scrollTop: number; changed: boolean } {
    return this.#viewport.measure(measurements, scrollTop);
  }

  reveal(key: string, requestedTop: number, viewportHeight: number): number {
    return this.#viewport.reveal(key, requestedTop, viewportHeight);
  }

  window(requestedTop: number, viewportHeight: number, pinned: readonly string[]): RowWindow {
    return this.#viewport.window(requestedTop, viewportHeight, pinned);
  }
}
