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

export interface MeasuredWindowRange extends BoundedWindowRange {
  readonly firstVisible: number;
  readonly startSpacer: number;
  readonly endSpacer: number;
  readonly totalExtent: number;
}

export type LogicalCollectionMove =
  | { readonly type: 'home'; readonly extendSelection: boolean }
  | { readonly type: 'end'; readonly extendSelection: boolean }
  | {
      readonly type: 'page';
      readonly pages: number;
      readonly pageSize: number;
      readonly extendSelection: boolean;
    }
  | { readonly type: 'step'; readonly delta: number; readonly extendSelection: boolean };

function natural(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Variable-height window model. Measurements are keyed by stable identity; estimates preserve the
 * complete virtual extent before any row has mounted, so a deep restored scroll position cannot be
 * clamped against an empty collection.
 */
export class MeasuredWindow<Key extends string> {
  private readonly extents = new Map<Key, number>();
  private keys: readonly Key[];
  private readonly estimateExtent: number;
  private readonly overscan: number;

  constructor(
    keys: readonly Key[],
    options: { readonly estimateExtent: number; readonly overscan: number },
  ) {
    this.keys = [...keys];
    this.estimateExtent = positive(options.estimateExtent, 1);
    this.overscan = natural(options.overscan);
  }

  setKeys(keys: readonly Key[]): void {
    this.keys = [...keys];
    const retained = new Set(keys);
    for (const key of this.extents.keys()) if (!retained.has(key)) this.extents.delete(key);
  }

  measure(key: Key, extent: number): boolean {
    if (!this.keys.includes(key)) return false;
    const measured = positive(extent, this.estimateExtent);
    if (this.extents.get(key) === measured) return false;
    this.extents.set(key, measured);
    return true;
  }

  hasMeasurement(key: Key): boolean {
    return this.extents.has(key);
  }

  extentOf(key: Key): number {
    return this.extents.get(key) ?? this.estimateExtent;
  }

  totalExtent(): number {
    return this.keys.reduce((sum, key) => sum + this.extentOf(key), 0);
  }

  offsetOf(index: number): number {
    const end = Math.min(natural(index), this.keys.length);
    let offset = 0;
    for (let cursor = 0; cursor < end; cursor += 1) offset += this.extentOf(this.keys[cursor]!);
    return offset;
  }

  range(viewport: {
    readonly scrollTop: number;
    readonly viewportExtent: number;
  }): MeasuredWindowRange {
    const totalExtent = this.totalExtent();
    const top = Math.min(Math.max(0, viewport.scrollTop), totalExtent);
    const bottom = Math.min(totalExtent, top + Math.max(0, viewport.viewportExtent));
    let firstVisible = 0;
    let cursorOffset = 0;
    while (
      firstVisible < this.keys.length &&
      cursorOffset + this.extentOf(this.keys[firstVisible]!) <= top
    ) {
      cursorOffset += this.extentOf(this.keys[firstVisible]!);
      firstVisible += 1;
    }
    let visibleEnd = firstVisible;
    let visibleOffset = cursorOffset;
    while (visibleEnd < this.keys.length && visibleOffset < bottom) {
      visibleOffset += this.extentOf(this.keys[visibleEnd]!);
      visibleEnd += 1;
    }
    const start = Math.max(0, firstVisible - this.overscan);
    const end = Math.min(this.keys.length, visibleEnd + this.overscan);
    const startSpacer = this.offsetOf(start);
    const endOffset = this.offsetOf(end);
    return {
      start,
      end,
      firstVisible,
      startSpacer,
      endSpacer: Math.max(0, totalExtent - endOffset),
      totalExtent,
    };
  }

  seed(input: {
    readonly firstKey: Key | null;
    readonly firstIndex: number;
    readonly viewportExtent: number;
  }): {
    readonly scrollTop: number;
    readonly totalExtent: number;
    readonly range: MeasuredWindowRange;
  } {
    const keyed = input.firstKey === null ? -1 : this.keys.indexOf(input.firstKey);
    const index = Math.min(this.keys.length, keyed >= 0 ? keyed : natural(input.firstIndex));
    const scrollTop = this.offsetOf(index);
    const range = this.range({ scrollTop, viewportExtent: input.viewportExtent });
    return { scrollTop, totalExtent: range.totalExtent, range };
  }
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
  private mounted:
    | {
        readonly container: HTMLElement;
        readonly start: number;
        readonly end: number;
        readonly itemExtent: number;
        readonly keys: readonly Key[];
      }
    | undefined;

  constructor(
    keys: readonly Key[],
    private readonly overscan: number,
  ) {
    this.keys = [...keys];
  }

  setKeys(keys: readonly Key[]): void {
    this.keys = [...keys];
    this.mounted = undefined;
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
    const itemExtent = natural(options.itemExtent);
    const rangeKeys = this.keys.slice(range.start, range.end);
    const sameRange =
      this.mounted?.container === container &&
      this.mounted.start === range.start &&
      this.mounted.end === range.end &&
      this.mounted.itemExtent === itemExtent &&
      this.mounted.keys.length === rangeKeys.length &&
      this.mounted.keys.every((key, index) => key === rangeKeys[index]);
    if (sameRange) {
      if (options.restoreFocus === true) this.restoreFocus(container);
      return { ...range, first };
    }

    const activeElement = container.ownerDocument.activeElement;
    const activeOwner =
      activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>('[data-bounded-key]')
        : null;
    const activeKey =
      activeOwner !== null && container.contains(activeOwner)
        ? (activeOwner.dataset['boundedKey'] as Key | undefined)
        : undefined;
    const replaceFocusedRow = activeKey !== undefined && activeKey === this.focused;
    const focusedWillRemain = this.focused !== null && rangeKeys.includes(this.focused);
    if (replaceFocusedRow && !focusedWillRemain) {
      container.dataset['boundedFocusKey'] = String(this.focused);
      container.focus({ preventScroll: true });
    }

    container.empty();
    this.appendSpacer(container, range.start * itemExtent, 'start');
    for (let index = range.start; index < range.end; index += 1) {
      const key = this.keys[index];
      if (key === undefined) continue;
      const element = options.render(container, key, index);
      element.dataset['boundedKey'] = key;
    }
    this.appendSpacer(container, (this.keys.length - range.end) * itemExtent, 'end');
    this.mounted = {
      container,
      ...range,
      itemExtent,
      keys: rangeKeys,
    };
    if (options.restoreFocus === true) {
      this.restoreFocus(container);
    } else if (replaceFocusedRow && focusedWillRemain) {
      this.restoreFocus(container, false);
    }
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
  restoreFocus(container: HTMLElement, scroll = true): boolean {
    if (this.focused === null) return false;
    const element = Array.from(container.querySelectorAll<HTMLElement>('[data-bounded-key]')).find(
      (candidate) => candidate.dataset['boundedKey'] === String(this.focused),
    );
    if (!element) return false;
    const focusTarget =
      (element.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ? element
        : element.querySelector<HTMLElement>(
            '[data-project-identity-control], [data-work-note-identity-control], [data-board-item-focus]',
          )) ?? element;
    delete container.dataset['boundedFocusKey'];
    if (scroll) focusTarget.scrollIntoView?.({ block: 'nearest' });
    focusTarget.focus({ preventScroll: true });
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
