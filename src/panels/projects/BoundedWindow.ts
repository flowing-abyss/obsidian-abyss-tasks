export interface BoundedWindowViewport {
  readonly first: number;
  readonly visible: number;
}

export interface BoundedWindowInput extends BoundedWindowViewport {
  readonly count: number;
  readonly overscan: number;
}

export interface BoundedWindowRange {
  /** Inclusive logical index. */
  readonly start: number;
  /** Exclusive logical index. */
  readonly end: number;
}

export interface BoundedWindowRenderOptions<Key extends string> extends BoundedWindowViewport {
  readonly itemExtent: number;
  readonly restoreFocus?: boolean;
  readonly render: (container: HTMLElement, key: Key, logicalIndex: number) => HTMLElement;
}

export interface BoundedWindowRenderResult extends BoundedWindowRange {
  readonly first: number;
}

function natural(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Returns the exact logical viewport plus a fixed overscan on both sides. */
export function computeBoundedWindow(input: BoundedWindowInput): BoundedWindowRange {
  const count = natural(input.count);
  const first = Math.min(natural(input.first), count);
  const visible = natural(input.visible);
  const overscan = natural(input.overscan);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
  };
}

/**
 * Logical focus companion for virtualized Project surfaces. It deliberately owns
 * stable keys rather than mounted nodes, so keyboard order survives window churn.
 */
export class BoundedWindow<Key extends string> {
  private keys: readonly Key[];
  private focused: Key | null = null;

  constructor(
    keys: readonly Key[],
    private readonly overscan: number,
  ) {
    this.keys = [...keys];
  }

  setKeys(keys: readonly Key[]): void {
    this.keys = [...keys];
    if (this.focused !== null && !this.keys.includes(this.focused)) this.focused = null;
  }

  focus(key: Key): boolean {
    if (!this.keys.includes(key)) return false;
    this.focused = key;
    return true;
  }

  focusedKey(): Key | null {
    return this.focused;
  }

  move(delta: number, accepts: (key: Key) => boolean = () => true): Key | null {
    if (this.keys.length === 0) {
      this.focused = null;
      return null;
    }
    const step = Math.trunc(delta);
    let current = this.focused === null ? -1 : this.keys.indexOf(this.focused);
    if (this.focused === null && step < 0) current = this.keys.length;
    const direction = step < 0 ? -1 : 1;
    let index = Math.max(0, Math.min(this.keys.length - 1, current + step));
    while (!accepts(this.keys[index]!) && index > 0 && index < this.keys.length - 1) {
      index += direction;
    }
    const candidate = this.keys[index];
    if (candidate !== undefined && accepts(candidate)) this.focused = candidate;
    return this.focused;
  }

  bounds(viewport: BoundedWindowViewport): BoundedWindowRange {
    return computeBoundedWindow({
      count: this.keys.length,
      first: viewport.first,
      visible: viewport.visible,
      overscan: this.overscan,
    });
  }

  /** Mounts only the bounded slice, maintaining scroll extent with inert spacers. */
  render(
    container: HTMLElement,
    options: BoundedWindowRenderOptions<Key>,
  ): BoundedWindowRenderResult {
    const first =
      options.restoreFocus === true ? this.viewportForFocus(options) : natural(options.first);
    const range = this.bounds({ first, visible: options.visible });
    container.empty();
    this.appendSpacer(container, range.start * natural(options.itemExtent), 'start');
    for (let index = range.start; index < range.end; index += 1) {
      const key = this.keys[index];
      if (key === undefined) continue;
      const element = options.render(container, key, index);
      element.dataset['boundedKey'] = key;
    }
    this.appendSpacer(
      container,
      (this.keys.length - range.end) * natural(options.itemExtent),
      'end',
    );
    if (options.restoreFocus === true) this.restoreFocus(container);
    return { ...range, first };
  }

  /** Returns the first logical row needed to make the focused key visible. */
  viewportForFocus(viewport: BoundedWindowViewport): number {
    const visible = natural(viewport.visible);
    const maxFirst = Math.max(0, this.keys.length - visible);
    const first = Math.min(natural(viewport.first), maxFirst);
    if (this.focused === null || visible === 0) return first;
    const index = this.keys.indexOf(this.focused);
    if (index < 0) return first;
    if (index < first) return index;
    if (index >= first + visible) return Math.min(maxFirst, index - visible + 1);
    return first;
  }

  /** Restores DOM focus after a virtual window remounts the retained stable key. */
  restoreFocus(container: ParentNode): boolean {
    if (this.focused === null) return false;
    const element = Array.from(container.querySelectorAll<HTMLElement>('[data-bounded-key]')).find(
      (candidate) => candidate.dataset['boundedKey'] === String(this.focused),
    );
    if (!element) return false;
    element.scrollIntoView?.({ block: 'nearest' });
    element.focus({ preventScroll: true });
    return true;
  }

  private appendSpacer(container: HTMLElement, extent: number, edge: 'start' | 'end'): void {
    if (extent <= 0) return;
    const spacer = container.ownerDocument.createElement('div');
    spacer.className = 'abyss-bounded-window-spacer';
    spacer.dataset['boundedWindowEdge'] = edge;
    spacer.style.blockSize = `${String(extent)}px`;
    spacer.setAttribute('aria-hidden', 'true');
    container.appendChild(spacer);
  }
}
