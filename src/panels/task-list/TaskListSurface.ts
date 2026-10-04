import { RowViewport, type RowAnchor, type RowSegment } from '../virtualization/rowViewport';
import { NO_TASK_LIST_ROWS, type TaskListRow, type TaskListRows } from './taskListRows';
import type { MountedTaskListRows } from './taskListRowView';

export interface TaskRowMount {
  readonly element: HTMLElement;
  update(row: TaskListRow): void;
  destroy(): void;
}
export interface TaskListPresentation {
  readonly revision: string;
  readonly preserveAnchor: boolean;
  estimate(row: TaskListRow): number;
  measurementRevision(row: TaskListRow): string;
}
export interface TaskListSurfaceOptions {
  readonly host: HTMLElement;
  readonly scroll: HTMLElement;
  mount(host: HTMLElement, row: TaskListRow): TaskRowMount;
  mountedChanged(): void;
  reportFailure(error: unknown): void;
}

/** Native lifetime and keyed mounts over the shared, pure row geometry. */
export class TaskListSurface implements MountedTaskListRows {
  readonly #options: TaskListSurfaceOptions;
  readonly #viewport = new RowViewport();
  readonly #mounts = new Map<string, TaskRowMount>();
  readonly #pins = new Map<string, Set<object>>();
  #rows: TaskListRows = NO_TASK_LIST_ROWS;
  #presentation: TaskListPresentation | undefined;
  #owner: Window | null = null;
  #observer: ResizeObserver | undefined;
  #frame: number | undefined;
  #suspended = false;
  #destroyed = false;
  #failed = false;
  #layoutRevision = 0;
  #width = -1;
  #font = '';
  #focusedKey: string | undefined;
  #ordered: string[] = [];
  #pendingScroll: { anchor: RowAnchor | undefined; top: number } | undefined;

  constructor(options: TaskListSurfaceOptions) {
    this.#options = options;
    options.host.addClass('abyss-task-list-surface');
  }

  get rows(): TaskListRows {
    return this.#rows;
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.element;
  }
  *cards(): Iterable<readonly [key: string, card: HTMLElement]> {
    for (const key of this.#ordered) {
      const element = this.element(key);
      if (element !== undefined && this.#rows.task(key) !== undefined) yield [key, element];
    }
  }

  update(rows: TaskListRows, presentation: TaskListPresentation): void {
    if (this.#destroyed) return;
    this.#failed = false;
    this.#guard(() => {
      const top = this.#top();
      const anchor = presentation.preserveAnchor
        ? this.#viewport.captureAnchor(Math.max(0, top))
        : undefined;
      this.#rows = rows;
      this.#presentation = presentation;
      this.#replace();
      for (const key of this.#pins.keys())
        if (this.#viewport.rowBounds(key) === undefined) this.#pins.delete(key);
      for (const [key, mount] of this.#mounts)
        if (this.#viewport.rowBounds(key) === undefined) this.#evict(key, mount);
      if (!this.#active()) {
        this.#pendingScroll = { anchor, top };
        this.#unbind();
        return;
      }
      this.#pendingScroll = undefined;
      this.#bind();
      this.#checkLayout();
      const restored = this.#viewport.restoreAnchor(anchor, top);
      const clamped = this.#viewport.window(restored, this.#height(), []).scrollTop;
      // Projection changes may shrink the scroll range. Ordinary scroll frames never clamp it.
      this.#writeTop(restored < 0 ? restored : clamped);
      this.#reconcile(true);
    });
  }

  reveal(key: string): HTMLElement | undefined {
    if (!this.#active() || this.#viewport.rowBounds(key) === undefined) return undefined;
    this.#guard(() => {
      this.#bind();
      this.#checkLayout();
      this.#writeTop(this.#viewport.reveal(key, this.#top(), this.#height()));
      this.#reconcile(false);
    });
    return this.element(key);
  }

  pin(key: string): () => void {
    const token = {};
    if (!this.#destroyed && this.#viewport.rowBounds(key) !== undefined) {
      const owners = this.#pins.get(key) ?? new Set<object>();
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
    this.#unbind();
  }
  resume(): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    this.#failed = false;
    this.#guard(() => {
      if (!this.#active()) return;
      this.#bind();
      this.#checkLayout();
      if (this.#pendingScroll !== undefined) {
        const { anchor, top } = this.#pendingScroll;
        this.#pendingScroll = undefined;
        this.#writeTop(this.#viewport.restoreAnchor(anchor, top));
      }
      this.#reconcile(false);
    });
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unbind();
    for (const [key, mount] of this.#mounts) this.#evict(key, mount);
    this.#pins.clear();
    this.#ordered = [];
    this.#rows = NO_TASK_LIST_ROWS;
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
    if (this.#options.host === this.#options.scroll) return 0;
    const { host, scroll } = this.#options;
    return (
      host.getBoundingClientRect().top -
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
  #checkLayout(): void {
    const host = this.#options.host;
    const style = this.#owner?.getComputedStyle(host);
    const font = `${style?.fontFamily}:${style?.fontSize}:${style?.lineHeight}`;
    if (host.clientWidth === this.#width && font === this.#font) return;
    const top = this.#top();
    const anchor = this.#viewport.captureAnchor(Math.max(0, top));
    this.#width = host.clientWidth;
    this.#font = font;
    this.#layoutRevision++;
    this.#replace();
    this.#writeTop(top + this.#viewport.restoreAnchor(anchor, Math.max(0, top)) - Math.max(0, top));
  }
  readonly #schedule = (): void => {
    if (this.#frame !== undefined || this.#failed) return;
    this.#guard(() => {
      if (!this.#active()) {
        this.#unbind();
        return;
      }
      this.#bind();
      this.#frame = this.#owner?.requestAnimationFrame(() => {
        this.#frame = undefined;
        this.#guard(() => {
          if (!this.#active()) {
            this.#unbind();
            return;
          }
          this.#bind();
          this.#checkLayout();
          this.#reconcile(false);
        });
      });
    });
  };
  #bind(): void {
    const owner = this.#options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return;
    this.#unbind();
    // Components and native event registrations belong to the document that mounted them.
    for (const [key, mount] of this.#mounts) this.#evict(key, mount);
    this.#owner = owner;
    if (owner === null) return;
    this.#width = -1;
    this.#observer = new owner.ResizeObserver(this.#schedule);
    this.#observer.observe(this.#options.host);
    if (this.#options.scroll !== this.#options.host) this.#observer.observe(this.#options.scroll);
    this.#options.scroll.addEventListener('scroll', this.#schedule, { passive: true });
    this.#options.host.addEventListener('focusin', this.#schedule);
    this.#options.host.addEventListener('focusout', this.#schedule);
    owner.addEventListener('resize', this.#schedule);
    this.#options.host.ownerDocument.fonts.addEventListener('loadingdone', this.#fontChanged);
  }
  readonly #fontChanged = (): void => {
    this.#font = '';
    this.#schedule();
  };
  #unbind(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#options.scroll.removeEventListener('scroll', this.#schedule);
    this.#options.host.removeEventListener('focusin', this.#schedule);
    this.#options.host.removeEventListener('focusout', this.#schedule);
    this.#owner?.removeEventListener('resize', this.#schedule);
    this.#owner?.document.fonts.removeEventListener('loadingdone', this.#fontChanged);
    this.#owner = null;
  }
  #evict(key: string, mount: TaskRowMount): void {
    this.#observer?.unobserve(mount.element);
    this.#mounts.delete(key);
    mount.destroy();
  }
  #reconcile(update: boolean): void {
    this.#focusedKey = undefined;
    const focused = this.#options.host.ownerDocument.activeElement;
    for (const [key, mount] of this.#mounts)
      if (focused !== null && mount.element.contains(focused)) {
        this.#focusedKey = key;
        break;
      }
    this.#renderWindow(update);
    const nativeTop = this.#top();
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
      Math.max(0, nativeTop),
    );
    if (measured.changed) {
      this.#writeTop(nativeTop + measured.scrollTop - Math.max(0, nativeTop));
      // One correction rebuild per pass. ResizeObserver schedules fresh changed sizes.
      this.#renderWindow(false);
    }
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
  #renderWindow(update: boolean): void {
    const pinned = [...this.#pins.keys()];
    if (this.#focusedKey !== undefined) pinned.push(this.#focusedKey);
    const window = this.#viewport.window(this.#top(), this.#height(), pinned);
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
    this.#order(desired);
    this.#ordered = [...keys];
    this.#options.mountedChanged();
  }
  #segmentKey(segment: RowSegment): string | undefined {
    return 'index' in segment ? this.#rows.rows[segment.index]?.key : undefined;
  }
  #evictOutside(keys: ReadonlySet<string>): void {
    for (const [key, mount] of this.#mounts) if (!keys.has(key)) this.#evict(key, mount);
  }
  #order(desired: readonly HTMLElement[]): void {
    let previous: HTMLElement | undefined;
    for (const element of desired) {
      const before = previous === undefined ? this.#options.host.firstChild : previous.nextSibling;
      if (before !== element) this.#options.host.insertBefore(element, before);
      previous = element;
    }
  }
  #guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
      this.#failed = true;
      this.#options.reportFailure(error);
    }
  }
}
