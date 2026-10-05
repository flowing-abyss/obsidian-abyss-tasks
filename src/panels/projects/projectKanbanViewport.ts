import { Component } from 'obsidian';
import { RowViewport, type RowAnchor, type RowSegment } from '../virtualization/rowViewport';
import {
  kanbanInsertion,
  KanbanRowIndex,
  type KanbanInsertion,
  type KanbanViewportRow,
  type PlannedKanbanInsertion,
} from './projectKanbanRows';

export interface KanbanRowMount {
  readonly element: HTMLElement;
  update(row: KanbanViewportRow): void;
  destroy(): void;
}
export interface ProjectKanbanColumnViewportOptions {
  readonly host: HTMLElement;
  readonly scroll: HTMLElement;
  mount(host: HTMLElement, row: KanbanViewportRow, markdown: Component): KanbanRowMount;
  mountedChanged(): void;
  reportFailure(error: unknown): void;
}

/** Owns only one column's native window; model and interaction authority remain in the view. */
export class ProjectKanbanColumnViewport {
  readonly #options: ProjectKanbanColumnViewportOptions;
  readonly #viewport = new RowViewport();
  #rows: readonly KanbanViewportRow[] = [];
  #rowIndex = new KanbanRowIndex([]);
  readonly #mounts = new Map<string, { mount: KanbanRowMount; markdown: Component }>();
  readonly #pins = new Set<{ owner: ProjectKanbanColumnViewport; key: string }>();
  #spacers: HTMLElement[] = [];
  readonly #incoming = new Set<string>();
  readonly #positioned = new WeakSet<HTMLElement>();
  #window: Window | null = null;
  #observer: ResizeObserver | undefined;
  #frame: number | undefined;
  #generation = 0;
  #active = true;
  #retireIncoming = false;
  #destroyed = false;
  #failed = false;
  #layout = '';
  #layoutRevision = 0;
  #layoutDirty = true;
  #nativeCleanup: (() => void) | undefined;

  constructor(options: ProjectKanbanColumnViewportOptions) {
    this.#options = options;
  }

  update(rows: readonly KanbanViewportRow[], preserveAnchor: boolean): void {
    if (this.#destroyed) return;
    this.#failed = false;
    this.#bind();
    const top = Math.max(0, this.#options.scroll.scrollTop);
    const anchor = preserveAnchor ? this.#viewport.captureAnchor(top) : undefined;
    this.#rows = rows;
    this.#rowIndex = new KanbanRowIndex(rows);
    this.#replace();
    this.#checkLayout(top);
    const restored = this.#viewport.restoreAnchor(anchor, top);
    let target = this.#viewport.window(restored, this.#options.scroll.clientHeight, []).scrollTop;
    this.#render(target, true, anchor);
    if (this.#active) {
      const measured = this.#measure(target, anchor);
      target = measured.scrollTop;
      if (measured.changed) this.#render(target);
    }
    this.#retireIncoming = !this.#active && this.#incoming.size > 0;
    this.#incoming.clear();
    if (target !== top) this.#options.scroll.scrollTop = target;
  }

  #replace(): void {
    this.#viewport.replace(
      this.#rows.map((row) => ({
        ...row,
        measurementRevision: `${this.#layoutRevision}:${row.measurementRevision}`,
      })),
    );
  }
  #checkLayout(top: number): { top: number; anchor: RowAnchor | undefined } {
    if (!this.#active || this.#window === null) return { top, anchor: undefined };
    const { host, scroll } = this.#options;
    if (scroll.clientHeight <= 0 || host.clientWidth <= 0) {
      this.#layoutDirty = true;
      return { top, anchor: undefined };
    }
    const style = this.#window.getComputedStyle(host);
    const signature = JSON.stringify([
      host.clientWidth,
      style.fontFamily,
      style.fontSize,
      style.lineHeight,
      style.fontWeight,
      style.fontStyle,
      style.letterSpacing,
    ]);
    if (!this.#layoutDirty && this.#layout === signature) return { top, anchor: undefined };
    const anchor = this.#viewport.captureAnchor(Math.max(0, top));
    this.#layout = signature;
    this.#layoutDirty = false;
    this.#layoutRevision++;
    this.#replace();
    return {
      top: top + this.#viewport.restoreAnchor(anchor, Math.max(0, top)) - Math.max(0, top),
      anchor,
    };
  }

  reveal(key: string): HTMLElement | undefined {
    if (this.#destroyed || this.#viewport.rowBounds(key) === undefined) return undefined;
    this.#bind();
    const target = this.#viewport.reveal(
      key,
      Math.max(0, this.#options.scroll.scrollTop),
      this.#options.scroll.clientHeight,
    );
    this.#render(target);
    if (this.#options.scroll.scrollTop !== target) this.#options.scroll.scrollTop = target;
    return this.element(key);
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.mount.element;
  }
  insertion(contentY: number, sourcePath: string): KanbanInsertion | undefined {
    return kanbanInsertion(this.#rows, this.#viewport, contentY, sourcePath);
  }
  insertionTop(insertion: PlannedKanbanInsertion, proposedPath: string): number | undefined {
    return this.#rowIndex.insertionTop(this.#viewport, insertion, proposedPath);
  }
  pin(key: string): () => void {
    const token = { owner: this, key };
    this.#pins.add(token);
    this.#render(Math.max(0, this.#options.scroll.scrollTop));
    return () => {
      const owner = token.owner;
      if (!owner.#pins.delete(token) || owner.#destroyed) return;
      owner.#render(Math.max(0, owner.#options.scroll.scrollTop));
    };
  }
  /** Transfers only an existing same-project/group card, retaining its loaded Markdown owner. */
  transferTo(
    destination: ProjectKanbanColumnViewport,
    oldKey: string,
    newRow: KanbanViewportRow,
  ): boolean {
    const entry = this.#mounts.get(oldKey);
    const oldIndex = this.#viewport.rowBounds(oldKey)?.index;
    const oldRow = oldIndex === undefined ? undefined : this.#rows[oldIndex];
    if (entry === undefined || !destination.#acceptsTransfer(this, newRow.key)) return false;
    if (!sameCard(oldRow, newRow)) return false;
    this.#observer?.unobserve(entry.mount.element);
    this.#mounts.delete(oldKey);
    destination.#mounts.set(newRow.key, entry);
    destination.#incoming.add(newRow.key);
    destination.#observer?.observe(entry.mount.element);
    this.#transferPins(destination, oldKey, newRow.key);
    return true;
  }
  #acceptsTransfer(source: ProjectKanbanColumnViewport, key: string): boolean {
    return (
      !source.#destroyed &&
      !this.#destroyed &&
      source.#options.host.ownerDocument === this.#options.host.ownerDocument &&
      !this.#mounts.has(key)
    );
  }
  #transferPins(destination: ProjectKanbanColumnViewport, oldKey: string, newKey: string): void {
    for (const token of this.#pins)
      if (token.key === oldKey) {
        this.#pins.delete(token);
        token.owner = destination;
        token.key = newKey;
        destination.#pins.add(token);
      }
  }
  setActive(active: boolean): void {
    if (this.#destroyed) return;
    if (this.#active === active && !this.#retireIncoming) {
      if (active) this.#bind();
      return;
    }
    this.#retireIncoming = false;
    this.#active = active;
    if (active) this.#bind();
    else this.#unbind();
    this.#render(Math.max(0, this.#options.scroll.scrollTop));
    if (active) this.#schedule();
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
  #segments(top: number, pins: readonly string[]): readonly RowSegment[] {
    if (this.#active)
      return this.#viewport.window(top, this.#options.scroll.clientHeight, pins).segments;
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
  #render(top: number, update = false, anchor?: RowAnchor): void {
    if (this.#failed) return;
    try {
      this.#reconcile(top, update, anchor);
    } catch (error) {
      this.#report(error);
    }
  }
  #reconcile(top: number, update: boolean, anchor?: RowAnchor): void {
    if (this.#destroyed) return;
    const segments = this.#segments(top, this.#pinnedKeys(anchor));
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
  #rowElement(row: KanbanViewportRow, update: boolean): HTMLElement {
    const existing = this.#mounts.get(row.key);
    const entry = existing ?? this.#mount(row);
    if (existing !== undefined && update) entry.mount.update(row);
    return entry.mount.element;
  }
  #pinnedKeys(anchor?: RowAnchor): string[] {
    const pins = new Set([...this.#incoming, ...[...this.#pins].map((token) => token.key)]);
    if (!this.#active) return [...pins];
    if (anchor !== undefined) {
      const key = this.#viewport.rowAt(
        this.#viewport.restoreAnchor({ ...anchor, offset: 0 }, 0),
      )?.key;
      if (key !== undefined) pins.add(key);
    }
    const active = this.#options.host.ownerDocument.activeElement;
    for (const [key, { mount }] of this.#mounts) {
      if (ownsInteraction(mount.element, active)) pins.add(key);
    }
    return [...pins];
  }
  #spacer(index: number, height: number): HTMLElement {
    const spacer =
      this.#spacers[index] ??
      this.#options.host.createDiv({
        cls: 'abyss-project-kanban-viewport-spacer',
        attr: { 'aria-hidden': 'true' },
      });
    this.#spacers[index] = spacer;
    spacer.setCssProps({ '--abyss-project-kanban-spacer-height': `${height}px` });
    return spacer;
  }
  #mount(row: KanbanViewportRow): { mount: KanbanRowMount; markdown: Component } {
    const markdown = new Component();
    markdown.load();
    try {
      const staging = this.#options.host.cloneNode(false) as HTMLElement;
      const mount = this.#options.mount(staging, row, markdown);
      this.#options.host.append(mount.element);
      const entry = { mount, markdown };
      this.#mounts.set(row.key, entry);
      this.#observer?.observe(mount.element);
      return entry;
    } catch (error) {
      markdown.unload();
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
    if (!this.#active || this.#destroyed) return;
    const owner = this.#options.host.ownerDocument.defaultView;
    if (this.#window === owner) return;
    this.#unbind();
    this.#window = owner;
    this.#options.scroll.addEventListener('scroll', this.#schedule, { passive: true });
    const fonts =
      owner === null
        ? undefined
        : (Reflect.get(owner.document, 'fonts') as FontFaceSet | undefined);
    const generation = this.#generation;
    const schedule = (): void => {
      if (generation === this.#generation) this.#schedule();
    };
    const fontChanged = (): void => {
      if (generation !== this.#generation) return;
      this.#layoutDirty = true;
      schedule();
    };
    owner?.addEventListener('resize', schedule);
    fonts?.addEventListener('loadingdone', fontChanged);
    this.#nativeCleanup = () => {
      owner?.removeEventListener('resize', schedule);
      fonts?.removeEventListener('loadingdone', fontChanged);
    };
    const Observer = owner?.ResizeObserver;
    if (Observer !== undefined) {
      this.#observer = new Observer(schedule);
      this.#observer.observe(this.#options.scroll);
      for (const { mount } of this.#mounts.values()) this.#observer.observe(mount.element);
    }
  }
  #unbind(): void {
    this.#generation++;
    if (this.#frame !== undefined) this.#window?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#options.scroll.removeEventListener('scroll', this.#schedule);
    this.#nativeCleanup?.();
    this.#nativeCleanup = undefined;
    this.#layoutDirty = true;
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#window = null;
  }
  #measure(top: number, anchor?: RowAnchor): { scrollTop: number; changed: boolean } {
    const measured = this.#viewport.measure(
      [...this.#mounts].map(([key, { mount }]) => ({
        key,
        height: mount.element.getBoundingClientRect().height,
      })),
      Math.max(0, top),
      anchor,
    );
    return { ...measured, scrollTop: top + measured.scrollTop - Math.max(0, top) };
  }
  readonly #schedule = (): void => {
    if (this.#frame !== undefined || !this.#active || this.#destroyed || this.#failed) return;
    const generation = this.#generation;
    this.#frame = this.#window?.requestAnimationFrame(() => {
      if (generation !== this.#generation || this.#destroyed || !this.#active) return;
      this.#frame = undefined;
      if (this.#failed) return;
      if (!this.#options.host.isConnected) {
        this.setActive(false);
        return;
      }
      try {
        this.#bind();
        const nativeTop = this.#options.scroll.scrollTop;
        const { top, anchor } = this.#checkLayout(nativeTop);
        const { scrollTop: corrected } = this.#measure(top, anchor);
        this.#render(corrected);
        if (corrected !== nativeTop) this.#options.scroll.scrollTop = corrected;
      } catch (error) {
        this.#report(error);
      }
    });
  };
}

function sameCard(left: KanbanViewportRow | undefined, right: KanbanViewportRow): boolean {
  return (
    left?.kind === 'card' &&
    right.kind === 'card' &&
    left.projectPath === right.projectPath &&
    left.groupKey === right.groupKey
  );
}
function ownsInteraction(element: HTMLElement, active: Element | null): boolean {
  return (
    (active !== null && element.contains(active)) ||
    element.querySelector('.is-editor-anchor, .is-editing') !== null
  );
}
