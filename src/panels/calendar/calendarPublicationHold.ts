import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';

/** Retains a mounted calendar's targets until native activation and submitted commands settle. */
export class CalendarPublicationHold {
  private readonly ownerWindow_abyssPrivate: Window | null;
  private readonly pointers = new Set<number>();
  private pending = 0;
  private leases = 0;
  private dragging: DragEvent | undefined;
  private dirty = false;
  private disposed = false;
  private releaseTimer_abyssPrivate: number | undefined;
  private readonly settlements_abyssPrivate = new Set<() => void>();
  private timedPress_abyssPrivate: PointerEvent | undefined;
  private suppressClick_abyssPrivate = false;
  private readonly removeListeners_abyssPrivate: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly publish: () => void,
  ) {
    this.ownerWindow_abyssPrivate = root.ownerDocument.defaultView;
    const owner = this.ownerWindow_abyssPrivate;
    const listeners: ReadonlyArray<readonly [EventTarget | null, string, EventListener, boolean?]> =
      [
        [root, 'pointerdown', this.onPointerDown as EventListener],
        [root, 'lostpointercapture', this.onPointerEnd as EventListener],
        [root, 'dragstart', this.onDragStart as EventListener],
        [root, 'click', this.onClick_abyssPrivate as EventListener],
        [owner, 'scroll', this.onScroll_abyssPrivate],
        [owner, 'pointerup', this.onPointerEnd as EventListener],
        [owner, 'pointercancel', this.onPointerEnd as EventListener],
        [owner, 'dragend', this.onCancel],
        [owner, 'drop', this.onCancel],
        [owner, 'blur', this.onCancel, false],
        [owner, 'keydown', this.onKeyDown as EventListener],
      ];
    for (const [target, type, listener, capture = true] of listeners)
      target?.addEventListener(type, listener, capture);
    this.removeListeners_abyssPrivate = () => {
      for (const [target, type, listener, capture = true] of listeners)
        target?.removeEventListener(type, listener, capture);
    };
  }

  request(): void {
    this.dirty = true;
    this.flush();
  }

  ownership(parent: InteractionOwnershipPort): InteractionOwnershipPort {
    return {
      acquire: (options) => {
        const lease = parent.acquire(options);
        this.leases++;
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            this.leases--;
            this.scheduleRelease();
          },
        };
      },
    };
  }

  run(action: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending++;
    this.root.inert = true;
    const completion = this.perform(action);
    // This is the event/action boundary. Callers receive settlement for preview cleanup;
    // the original rejection is reported once here, including for legacy void callbacks.
    runAsyncAction(completion);
    return completion.then(
      () => undefined,
      () => undefined,
    );
  }

  private async perform(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } finally {
      this.pending--;
      const publication = new Promise<void>((resolve) => {
        this.settlements_abyssPrivate.add(resolve);
      });
      if (this.disposed) this.settle_abyssPrivate();
      else this.flush();
      await publication;
    }
  }

  private flush(): void {
    if (
      this.disposed ||
      this.pending > 0 ||
      this.leases > 0 ||
      this.pointers.size > 0 ||
      this.dragging !== undefined ||
      this.releaseTimer_abyssPrivate !== undefined
    )
      return;
    try {
      if (this.dirty) {
        this.dirty = false;
        this.publish();
      }
    } finally {
      this.root.inert = false;
      this.settle_abyssPrivate();
    }
  }

  private settle_abyssPrivate(): void {
    for (const resolve of this.settlements_abyssPrivate) resolve();
    this.settlements_abyssPrivate.clear();
  }

  private scheduleRelease(): void {
    if (this.disposed || this.releaseTimer_abyssPrivate !== undefined) return;
    // Native click/contextmenu follows pointerup. Microtasks run too early to replace its target.
    this.releaseTimer_abyssPrivate = this.ownerWindow_abyssPrivate?.setTimeout(() => {
      this.releaseTimer_abyssPrivate = undefined;
      if (this.dragging?.defaultPrevented === true) this.dragging = undefined;
      this.flush();
    }, 0);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.root.inert) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    this.pointers.add(event.pointerId);
    const target = event.target as Element | null;
    const timed =
      event.button === 0 &&
      event.pointerType !== 'touch' &&
      target?.closest('.abyss-tg-block, .abyss-tg-block-continuation') != null &&
      target.closest('.abyss-status-marker, a') === null;
    if (timed || this.timedPress_abyssPrivate?.pointerId === event.pointerId) {
      this.timedPress_abyssPrivate = timed ? event : undefined;
      this.suppressClick_abyssPrivate = false;
    }
  };

  private readonly onScroll_abyssPrivate = (event: Event): void => {
    const press = this.timedPress_abyssPrivate;
    const target = event.target as Partial<Pick<Node, 'contains'>> | null;
    if (
      press !== undefined &&
      this.pointers.has(press.pointerId) &&
      target?.contains?.(press.target as Node) === true
    )
      this.suppressClick_abyssPrivate = true;
  };

  private readonly onClick_abyssPrivate = (event: MouseEvent): void => {
    const press = this.timedPress_abyssPrivate;
    if (
      press === undefined ||
      event.detail === 0 ||
      ('pointerId' in event && event.pointerId !== press.pointerId) ||
      (!this.suppressClick_abyssPrivate &&
        Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) <= 4)
    )
      return;
    // A cancelled drag can click the empty grid after capture is lost. Keep ownership
    // across query patches; only this click or a fresh press starts another action.
    this.timedPress_abyssPrivate = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (event.type !== 'pointerup' && this.timedPress_abyssPrivate?.pointerId === event.pointerId)
      this.suppressClick_abyssPrivate = true;
    this.scheduleRelease();
  };

  private readonly onDragStart = (event: DragEvent): void => {
    this.dragging = event;
    // Descendant handlers can decline the start; inspect it after native dispatch finishes.
    this.scheduleRelease();
  };

  private readonly onCancel = (): void => {
    if (
      this.timedPress_abyssPrivate !== undefined &&
      this.pointers.has(this.timedPress_abyssPrivate.pointerId)
    )
      this.suppressClick_abyssPrivate = true;
    this.pointers.clear();
    this.dragging = undefined;
    this.scheduleRelease();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.onCancel();
  };

  dispose(): void {
    this.disposed = true;
    this.timedPress_abyssPrivate = undefined;
    this.settle_abyssPrivate();
    this.root.inert = false;
    if (this.releaseTimer_abyssPrivate !== undefined)
      this.ownerWindow_abyssPrivate?.clearTimeout(this.releaseTimer_abyssPrivate);
    this.removeListeners_abyssPrivate();
  }
}
