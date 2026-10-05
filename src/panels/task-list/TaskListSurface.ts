import type { TaskSnapshot } from '../../tasks';
import { RowViewport, type RowAnchor, type RowSegment } from '../virtualization/rowViewport';
import { indexedRows, type TaskListRow, type TaskListRows } from './taskListRows';
import type { MountedTaskListRows } from './taskListRowView';

export interface TaskRowMount<T = TaskSnapshot> {
  readonly element: HTMLElement;
  update(row: TaskListRow<T>): void;
  destroy(): void;
}
export interface TaskListPresentation<T = TaskSnapshot> {
  readonly revision: string;
  readonly preserveAnchor: boolean;
  estimate(row: TaskListRow<T>): number;
  measurementRevision(row: TaskListRow<T>): string;
}
export interface TaskListSurfaceOptions<T = TaskSnapshot> {
  readonly host: HTMLElement;
  readonly scroll: HTMLElement;
  mount(host: HTMLElement, row: TaskListRow<T>): TaskRowMount<T>;
  mountedChanged(): void;
  reportFailure(error: unknown): void;
}

interface TaskListScroll {
  readonly revealKey?: string;
  readonly top: number;
  readonly anchor: RowAnchor | undefined;
}

/** Native lifetime and keyed mounts over the shared, pure row geometry. */
export class TaskListSurface<T = TaskSnapshot> implements MountedTaskListRows<T> {
  readonly #options: TaskListSurfaceOptions<T>;
  readonly #viewport = new RowViewport();
  readonly #mounts = new Map<string, TaskRowMount<T>>();
  readonly #pins = new Map<string, Set<{ onInvalidated?: () => void }>>();
  #rows: TaskListRows<T> = indexedRows<T>([]);
  #presentation: TaskListPresentation<T> | undefined;
  #owner: Window | null = null;
  #observer: ResizeObserver | undefined;
  #nativeGeneration = 0;
  #nativeCleanup: (() => void) | undefined;
  #binding = false;
  #frame: number | undefined;
  #suspended = false;
  #destroyed = false;
  #failed = false;
  #revision = 0;
  #invalidating = false;
  #layoutRevision = 0;
  #width = -1;
  #font = '';
  #focusedKey: string | undefined;
  #ordered: string[] = [];
  #pendingScroll: TaskListScroll | undefined;

  constructor(options: TaskListSurfaceOptions<T>) {
    this.#options = options;
    options.host.addClass('abyss-task-list-surface');
    this.#listen(true);
  }

  get rows(): TaskListRows<T> {
    return this.#rows;
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.element;
  }
  *cards(): Iterable<readonly [key: string, card: HTMLElement]> {
    for (const key of this.#ordered) {
      const element = this.element(key);
      if (element !== undefined && this.#rows.indexOf(key) >= 0) yield [key, element];
    }
  }

  mountedKeys(): readonly string[] {
    return [...this.#ordered];
  }
  refreshMeasurements(): void {
    this.#schedule();
  }

  update(
    rows: TaskListRows<T>,
    presentation: TaskListPresentation<T>,
    failure: 'report' | 'throw' = 'report',
  ): void {
    if (this.#destroyed) return;
    this.#failed = false;
    const revision = ++this.#revision;
    this.#guard(() => {
      const top = this.#top();
      const anchor = presentation.preserveAnchor
        ? this.#viewport.captureAnchor(Math.max(0, top))
        : undefined;
      this.#rows = rows;
      this.#presentation = presentation;
      this.#replace();
      this.#invalidatePins(
        [...this.#pins.keys()].filter((key) => this.#viewport.rowBounds(key) === undefined),
      );
      if (revision !== this.#revision || this.#destroyed) return;
      for (const [key, mount] of this.#mounts)
        if (this.#viewport.rowBounds(key) === undefined) this.#evict(key, mount);
      if (!this.#active()) {
        this.#pendingScroll = { anchor, top };
        this.#unbind();
        return;
      }
      this.#pendingScroll = undefined;
      if (!this.#bind()) return;
      this.#checkLayout();
      const restored = this.#restoreTop(anchor, top);
      const clamped = this.#viewport.window(restored, this.#height(), []).scrollTop;
      // Projection changes may shrink the scroll range. Ordinary scroll frames never clamp it.
      this.#reconcile(true, { top: restored < 0 ? restored : clamped, anchor });
    }, failure);
  }

  reveal(key: string): HTMLElement | undefined {
    if (!this.#active() || this.#viewport.rowBounds(key) === undefined) return undefined;
    this.#guard(() => {
      if (!this.#bind()) return;
      const top = this.#checkLayout()?.top ?? this.#top();
      this.#reconcile(false, {
        top: this.#viewport.reveal(key, top, this.#height()),
        anchor: undefined,
        revealKey: key,
      });
    });
    return this.element(key);
  }

  pin(key: string, onInvalidated?: () => void): () => void {
    const token = onInvalidated === undefined ? {} : { onInvalidated };
    if (!this.#destroyed && !this.#invalidating && this.#viewport.rowBounds(key) !== undefined) {
      const owners = this.#pins.get(key) ?? new Set<{ onInvalidated?: () => void }>();
      owners.add(token);
      this.#pins.set(key, owners);
      this.#schedule();
    }
    return () => {
      const owners = this.#pins.get(key);
      if (owners?.delete(token) !== true) return;
      if (owners.size === 0) this.#pins.delete(key);
      this.#schedule();
    };
  }

  suspend(): void {
    this.#suspended = true;
    this.#listen(false);
    this.#unbind();
  }
  resume(): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    this.#listen(true);
    this.#failed = false;
    this.#guard(() => {
      if (!this.#active()) return;
      if (!this.#bind()) return;
      let target = this.#checkLayout();
      if (this.#pendingScroll !== undefined) {
        const { anchor, top } = this.#pendingScroll;
        this.#pendingScroll = undefined;
        target = { top: this.#restoreTop(anchor, top), anchor };
      }
      this.#reconcile(false, target);
    });
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listen(false);
    this.#unbind();
    this.#guard(() => {
      this.#invalidatePins([...this.#pins.keys()]);
    });
    for (const [key, mount] of this.#mounts) this.#evict(key, mount);
    this.#ordered = [];
    this.#rows = indexedRows<T>([]);
    this.#options.host.empty();
    this.#options.host.removeClass('abyss-task-list-surface');
  }

  #active(): boolean {
    return (
      !this.#destroyed &&
      !this.#suspended &&
      this.#options.host.isConnected &&
      this.#height() > 0 &&
      this.#options.host.clientWidth > 0
    );
  }
  #height(): number {
    return this.#options.scroll.clientHeight;
  }
  #origin(): number {
    const { host, scroll } = this.#options;
    const padding = this.#margin(host.ownerDocument.defaultView?.getComputedStyle(host).paddingTop);
    if (host === scroll) return padding;
    return (
      host.getBoundingClientRect().top +
      host.clientTop +
      padding -
      scroll.getBoundingClientRect().top -
      scroll.clientTop +
      scroll.scrollTop
    );
  }
  #top(): number {
    return this.#options.scroll.scrollTop - this.#origin();
  }
  #writeTop(top: number): void {
    const next = top + this.#origin();
    if (Number.isFinite(next) && Math.abs(next - this.#options.scroll.scrollTop) > 0.01)
      this.#options.scroll.scrollTop = next;
  }
  #replace(): void {
    const presentation = this.#presentation;
    if (presentation === undefined) return;
    this.#viewport.replace(
      this.#rows.rows.map((row) => ({
        key: row.key,
        estimatedHeight: presentation.estimate(row),
        measurementRevision: `${this.#layoutRevision}:${presentation.revision}:${presentation.measurementRevision(row)}`,
      })),
    );
  }
  #restoreTop(anchor: RowAnchor | undefined, top: number): number {
    return top + this.#viewport.restoreAnchor(anchor, Math.max(0, top)) - Math.max(0, top);
  }
  #checkLayout(): TaskListScroll | undefined {
    const host = this.#options.host;
    const style = this.#owner?.getComputedStyle(host);
    const font = `${style?.fontFamily}:${style?.fontSize}:${style?.lineHeight}:${style?.fontWeight}:${style?.fontStyle}:${style?.letterSpacing}`;
    if (host.clientWidth === this.#width && font === this.#font) return;
    const top = this.#top();
    const anchor = this.#viewport.captureAnchor(Math.max(0, top));
    this.#width = host.clientWidth;
    this.#font = font;
    this.#layoutRevision++;
    this.#replace();
    return { top: this.#restoreTop(anchor, top), anchor };
  }
  readonly #schedule = (): void => {
    if (this.#destroyed || this.#suspended || this.#failed || this.#binding) return;
    this.#guard(() => {
      // A previous window's pending frame cannot coalesce work for an adopted host.
      if (!this.#bind()) return;
      if (!this.#active()) {
        this.#cancelFrame();
        return;
      }
      if (this.#frame !== undefined) return;
      const generation = this.#nativeGeneration;
      const owner = this.#owner;
      const frame: number | undefined = owner?.requestAnimationFrame(() => {
        if (generation !== this.#nativeGeneration || frame !== this.#frame) return;
        this.#frame = undefined;
        if (owner.document !== this.#options.host.ownerDocument) {
          this.#schedule();
          return;
        }
        this.#guard(() => {
          if (!this.#active()) return;
          this.#reconcile(false, this.#checkLayout());
        });
      });
      this.#frame = frame;
    });
  };
  #bind(): boolean {
    const binding = this.#binding;
    this.#binding = true;
    try {
      return this.#bindOwner();
    } finally {
      this.#binding = binding;
    }
  }
  #bindOwner(): boolean {
    const owner = this.#options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return true;
    const revision = this.#revision;
    this.#unbind();
    // Components and native event registrations belong to the document that mounted them.
    this.#invalidatePins([...this.#pins.keys()]);
    if (this.#destroyed || revision !== this.#revision) return false;
    for (const [key, mount] of this.#mounts) this.#evict(key, mount);
    this.#owner = owner;
    if (owner === null) return true;
    this.#width = -1;
    const generation = this.#nativeGeneration;
    const schedule = (): void => {
      if (generation === this.#nativeGeneration) this.#schedule();
    };
    const fontChanged = (): void => {
      if (generation !== this.#nativeGeneration) return;
      this.#font = '';
      schedule();
    };
    this.#observer = new owner.ResizeObserver(schedule);
    this.#observer.observe(this.#options.host);
    if (this.#options.scroll !== this.#options.host) this.#observer.observe(this.#options.scroll);
    owner.addEventListener('resize', schedule);
    const fonts = owner.document.fonts;
    fonts.addEventListener('loadingdone', fontChanged);
    this.#nativeCleanup = () => {
      owner.removeEventListener('resize', schedule);
      fonts.removeEventListener('loadingdone', fontChanged);
    };
    return true;
  }
  #listen(listen: boolean): void {
    const { host, scroll } = this.#options;
    for (const [element, event] of [
      [scroll, 'scroll'],
      [host, 'focusin'],
      [host, 'focusout'],
    ] as const) {
      if (listen) element.addEventListener(event, this.#schedule, { passive: true });
      else element.removeEventListener(event, this.#schedule);
    }
  }
  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }
  #unbind(): void {
    this.#nativeGeneration++;
    this.#cancelFrame();
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#nativeCleanup?.();
    this.#nativeCleanup = undefined;
    this.#owner = null;
  }
  #evict(key: string, mount: TaskRowMount<T>): void {
    this.#observer?.unobserve(mount.element);
    this.#mounts.delete(key);
    mount.destroy();
  }
  #readFocus(): void {
    this.#focusedKey = undefined;
    const focused = this.#options.host.ownerDocument.activeElement;
    for (const [key, mount] of this.#mounts)
      if (focused !== null && mount.element.contains(focused)) {
        this.#focusedKey = key;
        break;
      }
  }
  #reconcile(update: boolean, target?: TaskListScroll): void {
    this.#readFocus();
    const revision = this.#revision;
    this.#resolvePinOrder();
    if (revision !== this.#revision || this.#destroyed) return;
    this.#readFocus();
    const nativeTop = target?.top ?? this.#top();
    const anchor = target?.anchor;
    const revealKey = target?.revealKey;
    this.#renderWindow(update, nativeTop, revealKey ?? this.#anchorKey(anchor));
    this.#measureWindow(nativeTop, target);
  }
  #measureWindow(top: number, target: TaskListScroll | undefined): void {
    const revealKey = target?.revealKey;
    const measuredTop = this.#measure(top, target?.anchor);
    let corrected = measuredTop ?? target?.top;
    if (measuredTop !== undefined) {
      // Reveal owns its requested key, even when the destination grows beyond its estimate.
      corrected =
        revealKey === undefined
          ? measuredTop
          : this.#viewport.reveal(revealKey, measuredTop, this.#height());
      // Establish the new extent before a native setter can clamp the correction.
      this.#renderWindow(false, corrected, revealKey);
    }
    if (corrected !== undefined) this.#writeTop(corrected);
  }
  #anchorKey(anchor: RowAnchor | undefined): string | undefined {
    // A tall row's old offset can place its replacement estimate outside overscan.
    return anchor === undefined
      ? undefined
      : this.#viewport.rowAt(this.#viewport.restoreAnchor({ ...anchor, offset: 0 }, 0))?.key;
  }
  #measure(top: number, anchor: RowAnchor | undefined): number | undefined {
    const measured = this.#viewport.measure(
      [...this.#mounts].map(([key, mount]) => {
        const style = this.#owner?.getComputedStyle(mount.element);
        return {
          key,
          height:
            mount.element.getBoundingClientRect().height +
            this.#margin(style?.marginTop) +
            this.#margin(style?.marginBottom),
        };
      }),
      Math.max(0, top),
      anchor,
    );
    if (!measured.changed) return;
    return top + measured.scrollTop - Math.max(0, top);
  }
  #margin(value: string | undefined): number {
    const size = Number.parseFloat(value ?? '');
    return Number.isFinite(size) ? size : 0;
  }
  #segment(segment: RowSegment, update: boolean, spacer?: HTMLElement): HTMLElement | undefined {
    if ('height' in segment) {
      const element = spacer ?? this.#options.host.createDiv();
      element.addClass('abyss-virtual-row-spacer');
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
      element.setCssProps({ '--abyss-virtual-row-height': `${segment.height}px` });
      return element;
    }
    const row = this.#rows.rows[segment.index];
    if (row === undefined) return undefined;
    let mount = this.#mounts.get(row.key);
    if (mount === undefined) {
      mount = this.#options.mount(this.#options.host, row);
      this.#mounts.set(row.key, mount);
      this.#observer?.observe(mount.element, { box: 'border-box' });
    } else if (update) mount.update(row);
    return mount.element;
  }
  #renderWindow(update: boolean, top: number, anchorKey?: string): void {
    const pinned = [...this.#pins.keys()];
    if (anchorKey !== undefined) pinned.push(anchorKey);
    if (this.#focusedKey !== undefined) pinned.push(this.#focusedKey);
    const window = this.#viewport.window(top, this.#height(), pinned);
    const established = new Set(this.#mounts.keys());
    const desired: HTMLElement[] = [];
    const keys = new Set<string>();
    const oldSpacers = Array.from(
      this.#options.host.querySelectorAll<HTMLElement>(':scope > .abyss-virtual-row-spacer'),
    );
    let spacerIndex = 0;
    for (const segment of window.segments) {
      const spacer = 'height' in segment ? oldSpacers[spacerIndex++] : undefined;
      const element = this.#segment(segment, update, spacer);
      if (element !== undefined) desired.push(element);
      const key = this.#segmentKey(segment);
      if (key !== undefined) keys.add(key);
    }
    this.#evictOutside(keys);
    for (const spacer of oldSpacers.slice(spacerIndex)) spacer.remove();
    this.#order(desired, established);
    this.#ordered = [...keys];
    this.#options.mountedChanged();
  }
  #segmentKey(segment: RowSegment): string | undefined {
    return 'index' in segment ? this.#rows.rows[segment.index]?.key : undefined;
  }
  #evictOutside(keys: ReadonlySet<string>): void {
    for (const [key, mount] of this.#mounts) if (!keys.has(key)) this.#evict(key, mount);
  }
  #invalidatePins(keys: readonly string[]): void {
    const callbacks: Array<() => void> = [];
    for (const key of keys) {
      const owners = this.#pins.get(key);
      this.#pins.delete(key);
      for (const owner of owners ?? [])
        if (owner.onInvalidated !== undefined) callbacks.push(owner.onInvalidated);
    }
    const errors: unknown[] = [];
    const invalidating = this.#invalidating;
    this.#invalidating = true;
    try {
      for (const callback of callbacks) {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.#invalidating = invalidating;
    }
    if (errors.length > 0) throw errors[0];
  }
  #resolvePinOrder(): void {
    if (this.#pins.size === 0) return;
    const revision = this.#revision;
    let conflicting = this.#conflictingPins();
    while (conflicting.length > 0) {
      this.#invalidatePins(conflicting);
      if (this.#destroyed || revision !== this.#revision) return;
      this.#readFocus();
      conflicting = this.#conflictingPins();
    }
  }
  #conflictingPins(): string[] {
    const protectedKeys = new Set(this.#pins.keys());
    if (this.#focusedKey !== undefined) protectedKeys.add(this.#focusedKey);
    const positions = new Map(
      [...protectedKeys].map((key) => [key, this.#viewport.rowBounds(key)?.index ?? -1]),
    );
    const current = this.#orderedProtectedKeys(protectedKeys);
    const conflicting = new Set<string>();
    for (const [index, a] of current.entries()) {
      const reversed = current
        .slice(index + 1)
        .filter((b) => (positions.get(a) ?? -1) > (positions.get(b) ?? -1));
      for (const b of reversed) {
        if (a !== this.#focusedKey) conflicting.add(a);
        if (b !== this.#focusedKey) conflicting.add(b);
      }
    }
    return [...conflicting];
  }
  #orderedProtectedKeys(keys: ReadonlySet<string>): string[] {
    const elements = new Map([...this.#mounts].map(([key, mount]) => [mount.element, key]));
    return Array.from(this.#options.host.children).flatMap((element) => {
      const key = elements.get(element as HTMLElement);
      return key !== undefined && keys.has(key) ? [key] : [];
    });
  }
  #order(desired: readonly HTMLElement[], established: ReadonlySet<string>): void {
    const protectedElements = new Set<HTMLElement>();
    const focused = this.#options.host.ownerDocument.activeElement;
    for (const [key, mount] of this.#mounts)
      if (mount.element.contains(focused) || (established.has(key) && this.#pins.has(key)))
        protectedElements.add(mount.element);
    // New mounts must first enter logical order. Only established pins own their position;
    // actual focus is protected regardless of when its row mounted.
    // Move ordinary neighbors around owners; never detach an interaction-owned subtree.
    let next: HTMLElement | null = null;
    for (const element of [...desired].reverse()) {
      if (
        !protectedElements.has(element) &&
        (element.parentElement !== this.#options.host || element.nextSibling !== next)
      )
        this.#options.host.insertBefore(element, next);
      next = element;
    }
  }
  #guard(action: () => void, failure: 'report' | 'throw' = 'report'): void {
    try {
      action();
    } catch (error) {
      if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
      this.#failed = true;
      if (failure === 'throw') throw error;
      this.#options.reportFailure(error);
    }
  }
}
