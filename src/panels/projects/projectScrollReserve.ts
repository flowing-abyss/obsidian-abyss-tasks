import type { RowSegment } from '../virtualization/rowViewport';

import { onVerticalScrollIntent } from '../virtualization/verticalScrollIntent';

/** Prepare the active surface on a vertical gesture or meaningful native displacement. */
export class ProjectScrollReserve {
  #initialTop: number | undefined = 0;

  reset(top: number): void {
    this.#initialTop = top;
  }

  listen(scroll: HTMLElement, schedule: () => void): () => void {
    return onVerticalScrollIntent(scroll, () => {
      if (this.#initialTop === undefined) return;
      this.#initialTop = undefined;
      schedule();
    });
  }

  onScroll(scroll: HTMLElement): void {
    if (
      this.#initialTop !== undefined &&
      scroll.clientHeight > 0 &&
      Math.abs(scroll.scrollTop - this.#initialTop) >= Math.min(144, scroll.clientHeight / 2)
    )
      this.#initialTop = undefined;
  }

  get mode(): 'scroll' | 'interactive' {
    return this.#initialTop === undefined ? 'interactive' : 'scroll';
  }
}

/** Compare every sparse pin and spacer as well as the continuous mounted range. */
export function sameProjectWindow(
  previous: readonly RowSegment[] | undefined,
  next: readonly RowSegment[],
): boolean {
  return (
    previous?.length === next.length &&
    next.every((segment, index) => {
      const old = previous[index];
      if (old === undefined) return false;
      return 'index' in segment
        ? 'index' in old && old.index === segment.index
        : 'height' in old && old.height === segment.height;
    })
  );
}
