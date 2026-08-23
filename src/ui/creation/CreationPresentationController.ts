import type {
  TaskCommandResult,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
} from '../../tasks';
import type { CreationResultDescription } from '../taskCommandResult';
import { renderedTaskElements } from '../taskPresentationIdentity';

const MAX_PENDING_PRESENTATIONS = 20;
const PRESENTATION_TIMEOUT_MS = 3_000;
const ANNOUNCEMENT_TIMEOUT_MS = 4_000;
const NORMAL_HIGHLIGHT_MS = 1_100;
const REDUCED_HIGHLIGHT_MS = 800;

interface PendingPresentation {
  readonly id: number;
  lookupRef: TaskRef;
  resolvedRef?: TaskRef;
  readonly expiresAt: number;
  highlightUntil?: number;
  highlightedElement?: HTMLElement;
  timeout: number;
}

function relevantPath(event: TaskIndexEvent, path: string): boolean {
  if (event.type === 'initialized') return true;
  if (event.type === 'changed') return event.files.includes(path);
  if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
  return event.path === path;
}

function canonicalRef(resolution: TaskResolution): TaskRef | undefined {
  if (resolution.type === 'exact') return resolution.task.ref;
  if (resolution.type === 'rebased') return resolution.current.ref;
  return undefined;
}

function intersects(left: DOMRect, right: DOMRect): boolean {
  return (
    left.bottom > right.top &&
    left.top < right.bottom &&
    left.right > right.left &&
    left.left < right.right
  );
}

function hasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function hiddenByStyle(root: HTMLElement, element: HTMLElement): boolean {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = ownerWindow.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) {
      return true;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return false;
}

function clips(value: string): boolean {
  return value === 'auto' || value === 'clip' || value === 'hidden' || value === 'scroll';
}

function visibleWithin(root: HTMLElement, element: HTMLElement): boolean {
  if (hiddenByStyle(root, element)) return false;
  const elementRect = element.getBoundingClientRect();
  if (!hasArea(elementRect)) return false;

  const ownerWindow = element.ownerDocument.defaultView;
  if (ownerWindow) {
    const viewport = {
      top: 0,
      left: 0,
      right: ownerWindow.innerWidth,
      bottom: ownerWindow.innerHeight,
    } as DOMRect;
    if (!intersects(elementRect, viewport)) return false;
  }

  let ancestor: HTMLElement | null = element.parentElement;
  while (ancestor) {
    const ancestorRect = ancestor.getBoundingClientRect();
    if (ancestor === root) {
      if (!hasArea(ancestorRect) || !intersects(elementRect, ancestorRect)) return false;
    } else if (ownerWindow) {
      const style = ownerWindow.getComputedStyle(ancestor);
      const overflowX = style.overflowX || style.overflow;
      const overflowY = style.overflowY || style.overflow;
      if (
        (clips(overflowX) &&
          (elementRect.right <= ancestorRect.left || elementRect.left >= ancestorRect.right)) ||
        (clips(overflowY) &&
          (elementRect.bottom <= ancestorRect.top || elementRect.top >= ancestorRect.bottom))
      ) {
        return false;
      }
    }
    if (ancestor === root) break;
    ancestor = ancestor.parentElement;
  }
  return true;
}

export class CreationPresentationController {
  private readonly pending: PendingPresentation[] = [];
  private readonly unsubscribe: () => void;
  private renderRoot: HTMLElement | undefined;
  private nextId = 0;
  private announcementGeneration = 0;
  private announcementTimeout = 0;
  private destroyed = false;

  constructor(
    private readonly options: {
      readonly host: HTMLElement;
      readonly queries: TaskQueryApi;
      readonly reducedMotion: () => boolean;
      readonly now: () => number;
    },
  ) {
    this.options.host.setAttribute('aria-atomic', 'true');
    this.options.host.setAttribute('aria-live', 'polite');
    this.options.host.setAttribute('role', 'status');
    this.unsubscribe = options.queries.subscribe((event) => {
      if (this.destroyed) return;
      this.removeExpired();
      for (const entry of [...this.pending]) {
        if (relevantPath(event, entry.lookupRef.filePath)) this.resolve(entry);
      }
      this.presentResolved();
    });
  }

  present(result: TaskCommandResult, description: CreationResultDescription): void {
    if (this.destroyed) return;
    this.announce(description);
    if (
      description.kind !== 'success' ||
      description.task === undefined ||
      result.type !== 'ok' ||
      result.outcome.type !== 'task'
    ) {
      return;
    }

    const entry: PendingPresentation = {
      id: ++this.nextId,
      lookupRef: result.outcome.task.ref,
      expiresAt: this.options.now() + PRESENTATION_TIMEOUT_MS,
      timeout: 0,
    };
    entry.timeout = this.setTimeout(() => this.expire(entry), PRESENTATION_TIMEOUT_MS);
    this.pending.push(entry);
    while (this.pending.length > MAX_PENDING_PRESENTATIONS) {
      const oldest = this.pending.shift();
      if (oldest) this.discard(oldest);
    }
    this.resolve(entry);
    this.presentResolved();
  }

  afterRender(root: HTMLElement): void {
    if (this.destroyed) return;
    this.renderRoot = root;
    this.removeExpired();
    for (const entry of [...this.pending]) this.resolve(entry);
    this.presentResolved();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    const entries = this.pending.splice(0);
    for (const entry of entries) this.clearTimeout(entry.timeout);
    this.clearTimeout(this.announcementTimeout);
    this.announcementTimeout = 0;
    ++this.announcementGeneration;
    for (const entry of entries) entry.highlightedElement?.classList.remove('is-just-created');
    this.renderRoot = undefined;
    this.options.host.textContent = '';
    this.options.host.removeAttribute('data-requires-recovery');
    delete this.options.host.dataset['resultKind'];
    this.options.host.setAttribute('aria-live', 'polite');
    this.options.host.setAttribute('role', 'status');
  }

  private announce(description: CreationResultDescription): void {
    const generation = ++this.announcementGeneration;
    this.clearTimeout(this.announcementTimeout);
    this.options.host.setAttribute('aria-live', description.ariaLive);
    this.options.host.toggleAttribute('data-requires-recovery', description.requiresRecovery);
    this.options.host.dataset['resultKind'] = description.kind;
    this.options.host.textContent = description.message;
    this.announcementTimeout = this.setTimeout(
      () => this.clearAnnouncement(generation),
      ANNOUNCEMENT_TIMEOUT_MS,
    );
  }

  private clearAnnouncement(generation: number): void {
    if (this.destroyed || generation !== this.announcementGeneration) return;
    this.announcementTimeout = 0;
    this.options.host.textContent = '';
    this.options.host.removeAttribute('data-requires-recovery');
    delete this.options.host.dataset['resultKind'];
    this.options.host.setAttribute('aria-live', 'polite');
  }

  private resolve(entry: PendingPresentation): void {
    if (!this.pending.includes(entry)) return;
    const ref = canonicalRef(this.options.queries.resolve(entry.lookupRef));
    if (ref === undefined) return;
    entry.lookupRef = ref;
    entry.resolvedRef = ref;
  }

  private presentResolved(): void {
    const root = this.renderRoot;
    if (!root) return;
    for (const entry of [...this.pending]) {
      if (entry.highlightedElement && !root.contains(entry.highlightedElement)) {
        this.releaseHighlight(entry);
      }
      if (entry.resolvedRef === undefined) continue;
      const matches = renderedTaskElements(root, entry.resolvedRef);
      if (matches.length === 0) continue;
      const target = matches.find((element) => visibleWithin(root, element)) ?? matches[0];
      if (!target) continue;
      if (entry.highlightUntil === undefined) this.startHighlight(entry);
      this.highlight(root, entry, target);
    }
  }

  private startHighlight(entry: PendingPresentation): void {
    this.clearTimeout(entry.timeout);
    const duration = this.options.reducedMotion() ? REDUCED_HIGHLIGHT_MS : NORMAL_HIGHLIGHT_MS;
    entry.highlightUntil = this.options.now() + duration;
    entry.timeout = this.setTimeout(() => this.expire(entry), duration);
  }

  private highlight(root: HTMLElement, entry: PendingPresentation, element: HTMLElement): void {
    const newlyBound = entry.highlightedElement !== element;
    if (newlyBound) {
      this.releaseHighlight(entry);
      entry.highlightedElement = element;
    }
    element.classList.add('is-just-created');
    if (newlyBound && !visibleWithin(root, element)) {
      element.scrollIntoView?.({
        behavior: this.options.reducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }

  private expire(entry: PendingPresentation): void {
    if (!this.pending.includes(entry)) return;
    const deadline = entry.highlightUntil ?? entry.expiresAt;
    const remaining = deadline - this.options.now();
    if (remaining > 0) {
      entry.timeout = this.setTimeout(() => this.expire(entry), remaining);
      return;
    }
    this.finish(entry);
  }

  private removeExpired(): void {
    for (const entry of [...this.pending]) {
      const deadline = entry.highlightUntil ?? entry.expiresAt;
      if (this.options.now() >= deadline) this.finish(entry);
    }
  }

  private finish(entry: PendingPresentation): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.clearTimeout(entry.timeout);
    this.releaseHighlight(entry);
  }

  private discard(entry: PendingPresentation): void {
    this.clearTimeout(entry.timeout);
    this.releaseHighlight(entry);
  }

  private releaseHighlight(entry: PendingPresentation): void {
    const element = entry.highlightedElement;
    entry.highlightedElement = undefined;
    if (
      element &&
      !this.pending.some(
        (candidate) => candidate !== entry && candidate.highlightedElement === element,
      )
    ) {
      element.classList.remove('is-just-created');
    }
  }

  private setTimeout(callback: () => void, delay: number): number {
    const ownerWindow = this.options.host.ownerDocument.defaultView;
    return (ownerWindow ?? window).setTimeout(callback, delay);
  }

  private clearTimeout(timeout: number): void {
    const ownerWindow = this.options.host.ownerDocument.defaultView;
    (ownerWindow ?? window).clearTimeout(timeout);
  }
}
