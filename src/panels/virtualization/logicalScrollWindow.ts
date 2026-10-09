export type NativeTaskScrollIntent = 'local' | 'absolute' | 'owned';
export interface LogicalScrollPlacement {
  readonly nativeTop: number;
  readonly logicalTop: number;
  readonly origin: number;
  readonly extent: number;
  readonly writeId: number;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** Monotone full-domain mapping with pixel-for-pixel endpoint aprons. */
function map(top: number, from: number, to: number, apron: number): number {
  if (from === 0 || to === 0) return 0;
  const value = clamp(top, from);
  if (from === to || value <= apron) return value;
  if (value >= from - apron) return to - (from - value);
  return apron + ((value - apron) * (to - 2 * apron)) / (from - 2 * apron);
}

/** Browser coordinates are acknowledged separately from precise logical positions. */
export class LogicalScrollWindow {
  readonly #maxExtent: number;
  #logicalTop = 0;
  #nativeTop = 0;
  #writeSequence = 0;

  constructor(maxExtent = 1_000_000) {
    this.#maxExtent = maxExtent;
  }

  place(logicalTop: number, totalHeight: number, viewportHeight: number): LogicalScrollPlacement {
    const extent = Math.min(this.#maxExtent, totalHeight);
    const L = Math.max(0, totalHeight - viewportHeight);
    const N = Math.max(0, extent - viewportHeight);
    this.#logicalTop = N === 0 ? 0 : clamp(logicalTop, L);
    const nativeTop = map(this.#logicalTop, L, N, N / 4);
    return {
      logicalTop: this.#logicalTop,
      nativeTop,
      origin: this.#logicalTop - nativeTop,
      extent,
      writeId: ++this.#writeSequence,
    };
  }

  read(
    nativeTop: number,
    totalHeight: number,
    viewportHeight: number,
    intent: NativeTaskScrollIntent,
  ): LogicalScrollPlacement {
    const L = Math.max(0, totalHeight - viewportHeight);
    const N = Math.max(0, Math.min(this.#maxExtent, totalHeight) - viewportHeight);
    const localTop = this.#logicalTop + (intent === 'local' ? nativeTop - this.#nativeTop : 0);
    const top = intent === 'absolute' ? map(nativeTop, N, L, N / 4) : localTop;
    // Each unowned read accepts this native baseline even when several events precede a frame.
    if (intent !== 'owned') this.#nativeTop = nativeTop;
    return this.place(top, totalHeight, viewportHeight);
  }

  acknowledge(writeId: number, actualNativeTop: number): void {
    if (writeId === this.#writeSequence) this.#nativeTop = actualNativeTop;
  }
}
