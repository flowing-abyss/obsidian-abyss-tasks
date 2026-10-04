import { Component } from 'obsidian';
import { RowViewport, type RowSegment } from '../virtualization/rowViewport';
import type { TimelineViewportRow } from './projectTimelineRowModel';

export interface TimelineRowMount {
  readonly element: HTMLElement;
  update(row: TimelineViewportRow): void;
  destroy(): void;
}
export interface ProjectTimelineRowsOptions {
  readonly host: HTMLElement;
  readonly scroll: HTMLElement;
  mount(host: HTMLElement, row: TimelineViewportRow, markdown: Component): TimelineRowMount;
  beforeWindow(): void;
  mountedChanged(): void;
  reportFailure(error: unknown): void;
}

/** Owns vertical geometry and mounted row lifetimes; the view owns calendar and source authority. */
export class ProjectTimelineRows {
  readonly #options: ProjectTimelineRowsOptions;
  readonly #viewport = new RowViewport();
  #rows: readonly TimelineViewportRow[] = [];
  readonly #mounts = new Map<string, { mount: TimelineRowMount; markdown: Component }>();
  readonly #pins = new Set<{ key: string }>();
  #spacers: HTMLElement[] = [];
  readonly #positioned = new WeakSet<HTMLElement>();
  #window: Window | null = null;
  #observer: ResizeObserver | undefined;
  #frame: number | undefined;
  #generation = 0;
  #active = true;
  #destroyed = false;
  #failed = false;

  constructor(options: ProjectTimelineRowsOptions) {
    this.#options = options;
  }

  update(rows: readonly TimelineViewportRow[], preserveAnchor: boolean): void {
    try {
      this.#update(rows, preserveAnchor);
    } catch (error) {
      this.#report(error);
    }
  }
  #update(rows: readonly TimelineViewportRow[], preserveAnchor: boolean): void {
    if (this.#destroyed) return;
    this.#bind();
    const top = Math.max(0, this.#options.scroll.scrollTop);
    const anchor = preserveAnchor ? this.#viewport.captureAnchor(top) : undefined;
    const previousHeight = this.#totalHeight();
    this.#rows = rows;
    this.#viewport.replace(rows);
    const restored = this.#viewport.restoreAnchor(anchor, top);
    const totalHeight = this.#totalHeight();
    const target =
      totalHeight < previousHeight
        ? this.#viewport.window(restored, this.#height(), []).scrollTop
        : restored;
    this.#render(target, true);
    if (target !== top) this.#options.scroll.scrollTop = target;
  }

  reveal(key: string): HTMLElement | undefined {
    if (
      this.#destroyed ||
      !this.#active ||
      !this.#options.host.isConnected ||
      this.#height() <= 0 ||
      this.#viewport.rowBounds(key) === undefined
    )
      return undefined;
    this.flush();
    this.#bind();
    const target = this.#viewport.reveal(
      key,
      Math.max(0, this.#options.scroll.scrollTop),
      this.#height(),
    );
    this.#render(target);
    if (this.#options.scroll.scrollTop !== target) this.#options.scroll.scrollTop = target;
    return this.element(key);
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.mount.element;
  }
  pin(key: string): () => void {
    const token = { key };
    this.#pins.add(token);
    this.#render(Math.max(0, this.#options.scroll.scrollTop));
    return () => {
      if (!this.#pins.delete(token) || this.#destroyed) return;
      this.#render(Math.max(0, this.#options.scroll.scrollTop));
    };
  }
  setActive(active: boolean): void {
    if (this.#destroyed) return;
    if (this.#active === active) {
      if (active) this.#bind();
      return;
    }
    this.#active = active;
    if (active) this.#bind();
    else this.#unbind();
    this.#render(Math.max(0, this.#options.scroll.scrollTop));
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unbind();
    for (const key of this.#mounts.keys()) this.#evict(key);
    for (const spacer of this.#spacers) spacer.remove();
    this.#spacers = [];
    this.#pins.clear();
  }
  #evict(key: string): void {
    const entry = this.#mounts.get(key);
    if (entry === undefined) return;
    this.#mounts.delete(key);
    this.#observer?.unobserve(entry.mount.element);
    try {
      entry.mount.destroy();
    } finally {
      entry.markdown.unload();
    }
  }
  #totalHeight(): number {
    const last = this.#rows[this.#rows.length - 1];
    return last === undefined ? 0 : (this.#viewport.rowBounds(last.key)?.bottom ?? 0);
  }
  #height(): number {
    const axis = this.#options.scroll.querySelector<HTMLElement>(
      ':scope > .abyss-project-timeline-axis',
    );
    return Math.max(
      0,
      this.#options.scroll.clientHeight - (axis?.getBoundingClientRect().height ?? 0),
    );
  }
  #segments(top: number, pins: readonly string[]): readonly RowSegment[] {
    if (this.#active && this.#options.host.isConnected && this.#height() > 0)
      return this.#viewport.window(top, this.#height(), pins).segments;
    const bounds = pins
      .flatMap((key) => {
        const row = this.#viewport.rowBounds(key);
        return row === undefined ? [] : [row];
      })
      .sort((a, b) => a.index - b.index);
    const segments: RowSegment[] = [];
    let offset = 0;
    for (const row of bounds) {
      if (row.top > offset) segments.push({ height: row.top - offset });
      segments.push({ index: row.index });
      offset = row.bottom;
    }
    const last = this.#rows[this.#rows.length - 1];
    const total = last === undefined ? 0 : (this.#viewport.rowBounds(last.key)?.bottom ?? 0);
    if (total > offset) segments.push({ height: total - offset });
    return segments;
  }
  #report(error: unknown): void {
    if (this.#destroyed || this.#failed) return;
    this.#failed = true;
    this.#options.reportFailure(error);
  }
  #render(top: number, update = false): void {
    try {
      this.#reconcile(top, update);
    } catch (error) {
      this.#report(error);
    }
  }
  #reconcile(top: number, update: boolean): void {
    if (this.#destroyed) return;
    const segments = this.#segments(top, this.#pinnedKeys());
    const desired: HTMLElement[] = [];
    const retained = new Set<string>();
    let spacerCount = 0;
    let mounted = false;
    for (const segment of segments) {
      if ('height' in segment) {
        desired.push(this.#spacer(spacerCount++, segment.height));
        continue;
      }
      const row = this.#rows[segment.index];
      if (row === undefined) continue;
      retained.add(row.key);
      if (!this.#mounts.has(row.key)) mounted = true;
      desired.push(this.#rowElement(row, update));
    }
    this.#evictOutside(retained, spacerCount);
    this.#order(desired);
    this.#options.mountedChanged();
    if (this.#active && (mounted || update)) this.#schedule();
  }
  #evictOutside(retained: ReadonlySet<string>, spacerCount: number): void {
    for (const key of this.#mounts.keys()) if (!retained.has(key)) this.#evict(key);
    for (const spacer of this.#spacers.splice(spacerCount)) spacer.remove();
  }
  #rowElement(row: TimelineViewportRow, update: boolean): HTMLElement {
    const existing = this.#mounts.get(row.key);
    const entry = existing ?? this.#mount(row);
    if (existing !== undefined && update) entry.mount.update(row);
    return entry.mount.element;
  }
  #pinnedKeys(): string[] {
    const pins = new Set([...this.#pins].map((token) => token.key));
    if (!this.#active) return [...pins];
    const active = this.#options.host.ownerDocument.activeElement;
    for (const [key, { mount }] of this.#mounts) {
      if (active !== null && mount.element.contains(active)) pins.add(key);
    }
    return [...pins];
  }
  #spacer(index: number, height: number): HTMLElement {
    const spacer =
      this.#spacers[index] ??
      this.#options.host.createDiv({
        cls: 'abyss-project-timeline-viewport-spacer',
        attr: { 'aria-hidden': 'true' },
      });
    this.#spacers[index] = spacer;
    spacer.setCssProps({ '--abyss-project-timeline-spacer-height': `${height}px` });
    return spacer;
  }
  #mount(row: TimelineViewportRow): { mount: TimelineRowMount; markdown: Component } {
    const markdown = new Component();
    markdown.load();
    let mount: TimelineRowMount | undefined;
    try {
      const staging = this.#options.host.cloneNode(false) as HTMLElement;
      mount = this.#options.mount(staging, row, markdown);
      this.#observer?.observe(mount.element);
      this.#options.host.append(mount.element);
      const entry = { mount, markdown };
      this.#mounts.set(row.key, entry);
      return entry;
    } catch (error) {
      try {
        mount?.destroy();
      } finally {
        markdown.unload();
      }
      throw error;
    }
  }
  #order(desired: readonly HTMLElement[]): void {
    const protectedElements = new Set(
      this.#pinnedKeys().flatMap((key) => {
        const element = this.element(key);
        return element === undefined ? [] : [element];
      }),
    );
    // Arrange neighbors around a focused subtree; moving that subtree itself can blur native focus.
    let next: ChildNode | null = null;
    for (let index = desired.length - 1; index >= 0; index--) {
      const element = desired[index];
      if (element === undefined) continue;
      const focused =
        protectedElements.has(element) &&
        this.#positioned.has(element) &&
        element.parentElement === this.#options.host;
      if (
        !focused &&
        (element.parentElement !== this.#options.host || element.nextSibling !== next)
      )
        this.#options.host.insertBefore(element, next);
      next = element;
      this.#positioned.add(element);
    }
  }
  #bind(): void {
    try {
      this.#bindWindow();
    } catch (error) {
      this.#report(error);
    }
  }
  #bindWindow(): void {
    if (!this.#active || this.#destroyed || !this.#options.host.isConnected) return;
    const owner = this.#options.host.ownerDocument.defaultView;
    if (this.#window === owner) return;
    this.#unbind();
    this.#window = owner;
    this.#options.scroll.addEventListener('scroll', this.#schedule, { passive: true });
    owner?.addEventListener('resize', this.#schedule);
    const Observer = owner?.ResizeObserver;
    if (Observer !== undefined) {
      this.#observer = new Observer(this.#schedule);
      this.#observer.observe(this.#options.scroll);
      for (const { mount } of this.#mounts.values()) this.#observer.observe(mount.element);
    }
  }
  #unbind(): void {
    this.#generation++;
    if (this.#frame !== undefined) this.#window?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#options.scroll.removeEventListener('scroll', this.#schedule);
    this.#window?.removeEventListener('resize', this.#schedule);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#window = null;
  }
  flush(): void {
    if (this.#destroyed || !this.#active) return;
    if (this.#frame !== undefined) this.#window?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    try {
      this.#options.beforeWindow();
      if (!this.#options.host.isConnected) {
        this.setActive(false);
        return;
      }
      this.#bind();
      if (this.#height() <= 0) {
        this.#render(0);
        return;
      }
      const top = Math.max(0, this.#options.scroll.scrollTop);
      const measured = this.#viewport.measure(
        [...this.#mounts].map(([key, { mount }]) => ({
          key,
          height: mount.element.getBoundingClientRect().height,
        })),
        top,
      );
      this.#render(measured.scrollTop);
      if (measured.changed && measured.scrollTop !== top)
        this.#options.scroll.scrollTop = measured.scrollTop;
    } catch (error) {
      this.#report(error);
    }
  }
  readonly #schedule = (): void => {
    if (!this.#active || this.#destroyed) return;
    if (!this.#options.host.isConnected || this.#height() <= 0) {
      this.flush();
      return;
    }
    if (this.#frame !== undefined) return;
    const generation = this.#generation;
    this.#frame = this.#window?.requestAnimationFrame(() => {
      if (generation !== this.#generation || this.#destroyed || !this.#active) return;
      this.#frame = undefined;
      this.flush();
    });
  };
}
