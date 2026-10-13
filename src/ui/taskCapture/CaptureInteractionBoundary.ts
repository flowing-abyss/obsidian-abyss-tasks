type Settlement = { readonly flush?: () => 'ready' | 'blocked'; readonly cancel?: () => void };
type ExitEvidence =
  | {
      readonly type: 'pointer';
      readonly target: EventTarget | null;
      readonly path: readonly EventTarget[];
    }
  | { readonly type: 'focus'; readonly relatedTarget: EventTarget | null };
interface BoundaryCallbacks {
  readonly flushInput: () => 'ready' | 'blocked';
  readonly submit: () => void;
  readonly isLive: () => boolean;
}

/** One document-owned departure path, including registered native menu and picker roots. */
export class CaptureInteractionBoundary {
  private readonly document: Document;
  private readonly window: Window;
  private readonly surfaces = new Map<HTMLElement, Settlement>();
  private timer: number | undefined;
  private pendingExit = false;
  private composing = false;
  private settling = false;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: BoundaryCallbacks,
  ) {
    this.document = host.ownerDocument;
    this.window = host.win;
    this.document.addEventListener('pointerdown', this.onPointer, true);
    this.document.addEventListener('focusout', this.onFocusOut, true);
    this.document.addEventListener('focusin', this.onFocusIn, true);
  }

  owns(target: EventTarget | null, path: readonly EventTarget[] = []): boolean {
    const contains = (surface: HTMLElement): boolean =>
      path.includes(surface) ||
      (target !== null && 'nodeType' in target && surface.contains(target as Node));
    return contains(this.host) || [...this.surfaces.keys()].some(contains);
  }

  register(surface: HTMLElement, settle: Settlement = {}): () => void {
    if (this.destroyed) {
      settle.cancel?.();
      return () => {};
    }
    this.surfaces.set(surface, settle);
    return () => {
      this.surfaces.delete(surface);
    };
  }

  requestExit(evidence: ExitEvidence): void {
    if (this.destroyed || this.settling || !this.callbacks.isLive()) return;
    const target = evidence.type === 'pointer' ? evidence.target : evidence.relatedTarget;
    if (target === null || this.owns(target, evidence.type === 'pointer' ? evidence.path : []))
      return;
    this.pendingExit = true;
    this.schedule();
  }

  beginComposition(): void {
    this.composing = true;
  }
  endComposition(): void {
    this.composing = false;
    this.schedule();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExit();
    this.document.removeEventListener('pointerdown', this.onPointer, true);
    this.document.removeEventListener('focusout', this.onFocusOut, true);
    this.document.removeEventListener('focusin', this.onFocusIn, true);
    for (const settle of [...this.surfaces.values()]) settle.cancel?.();
    this.surfaces.clear();
  }

  private readonly onPointer = (event: Event): void => {
    if (this.owns(event.target, event.composedPath())) this.cancelExit();
    else this.requestExit({ type: 'pointer', target: event.target, path: event.composedPath() });
  };
  private readonly onFocusOut = (event: FocusEvent): void => {
    if (this.owns(event.target, event.composedPath()))
      this.requestExit({ type: 'focus', relatedTarget: event.relatedTarget });
  };
  private readonly onFocusIn = (event: FocusEvent): void => {
    if (this.owns(event.target, event.composedPath())) this.cancelExit();
    else this.requestExit({ type: 'focus', relatedTarget: event.target });
  };
  private cancelExit(): void {
    this.pendingExit = false;
    if (this.timer !== undefined) this.window.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    if (!this.pendingExit || this.composing || this.timer !== undefined || this.destroyed) return;
    this.timer = this.window.setTimeout(() => {
      this.timer = undefined;
      if (!this.pendingExit || this.composing || this.destroyed || !this.callbacks.isLive()) return;
      this.pendingExit = false;
      this.settling = true;
      try {
        for (const child of [...this.surfaces.values()]) if (child.flush?.() === 'blocked') return;
        if (this.callbacks.flushInput() === 'ready') this.callbacks.submit();
      } finally {
        this.settling = false;
      }
    }, 0);
  }
}
