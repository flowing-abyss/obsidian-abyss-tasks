import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';

/** Retains a mounted calendar's targets until native activation and submitted commands settle. */
export class CalendarPublicationHold {
  private readonly ownerWindow_abyssPrivate: Window | null;
  private readonly pointers_abyssPrivate = new Set<number>();
  private pending_abyssPrivate = 0;
  private leases_abyssPrivate = 0;
  private dragging_abyssPrivate: DragEvent | undefined;
  private dirty_abyssPrivate = false;
  private disposed_abyssPrivate = false;
  private releaseTimer_abyssPrivate: number | undefined;
  private readonly settlements_abyssPrivate = new Set<() => void>();
  private timedPress_abyssPrivate: PointerEvent | undefined;
  private suppressClick_abyssPrivate = false;
  private readonly removeListeners_abyssPrivate: () => void;

  constructor(
    private readonly root_abyssPrivate: HTMLElement,
    private readonly publish_abyssPrivate: () => void,
  ) {
    this.ownerWindow_abyssPrivate = this.root_abyssPrivate.ownerDocument.defaultView;
    const owner = this.ownerWindow_abyssPrivate;
    const listeners: ReadonlyArray<readonly [EventTarget | null, string, EventListener, boolean?]> =
      [
        [this.root_abyssPrivate, 'pointerdown', this.onPointerDown_abyssPrivate as EventListener],
        [
          this.root_abyssPrivate,
          'lostpointercapture',
          this.onPointerEnd_abyssPrivate as EventListener,
        ],
        [this.root_abyssPrivate, 'dragstart', this.onDragStart_abyssPrivate as EventListener],
        [this.root_abyssPrivate, 'click', this.onClick_abyssPrivate as EventListener],
        [owner, 'scroll', this.onScroll_abyssPrivate],
        [owner, 'pointerup', this.onPointerEnd_abyssPrivate as EventListener],
        [owner, 'pointercancel', this.onPointerEnd_abyssPrivate as EventListener],
        [owner, 'dragend', this.onCancel_abyssPrivate],
        [owner, 'drop', this.onCancel_abyssPrivate],
        [owner, 'blur', this.onCancel_abyssPrivate, false],
        [owner, 'keydown', this.onKeyDown_abyssPrivate as EventListener],
      ];
    for (const [target, type, listener, capture = true] of listeners)
      target?.addEventListener(type, listener, capture);
    this.removeListeners_abyssPrivate = () => {
      for (const [target, type, listener, capture = true] of listeners)
        target?.removeEventListener(type, listener, capture);
    };
  }

  request(): void {
    this.dirty_abyssPrivate = true;
    this.flush_abyssPrivate();
  }

  /** Keyboard writes keep the focused target live until their receipt authorizes replacement. */
  holdKeyboardPublication(): () => void {
    this.leases_abyssPrivate++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases_abyssPrivate--;
      this.flush_abyssPrivate();
    };
  }

  ownership(parent: InteractionOwnershipPort): InteractionOwnershipPort {
    return {
      acquire: (options) => {
        const lease = parent.acquire(options);
        this.leases_abyssPrivate++;
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            this.leases_abyssPrivate--;
            this.scheduleRelease_abyssPrivate();
          },
        };
      },
    };
  }

  run(action: () => Promise<void>): Promise<void> {
    if (this.disposed_abyssPrivate) return Promise.resolve();
    this.pending_abyssPrivate++;
    this.root_abyssPrivate.inert = true;
    const completion = this.perform_abyssPrivate(action);
    // This is the event/action boundary. Callers receive settlement for preview cleanup;
    // the original rejection is reported once here, including for legacy void callbacks.
    runAsyncAction(completion);
    return completion.then(
      () => undefined,
      () => undefined,
    );
  }

  private async perform_abyssPrivate(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } finally {
      this.pending_abyssPrivate--;
      const publication = new Promise<void>((resolve) => {
        this.settlements_abyssPrivate.add(resolve);
      });
      if (this.disposed_abyssPrivate) this.settle_abyssPrivate();
      else this.flush_abyssPrivate();
      await publication;
    }
  }

  private flush_abyssPrivate(): void {
    if (
      this.disposed_abyssPrivate ||
      this.pending_abyssPrivate > 0 ||
      this.leases_abyssPrivate > 0 ||
      this.pointers_abyssPrivate.size > 0 ||
      this.dragging_abyssPrivate !== undefined ||
      this.releaseTimer_abyssPrivate !== undefined
    )
      return;
    // Replacement and focus restoration run synchronously; the new target must be focusable.
    this.root_abyssPrivate.inert = false;
    try {
      if (this.dirty_abyssPrivate) {
        this.dirty_abyssPrivate = false;
        this.publish_abyssPrivate();
      }
    } finally {
      this.root_abyssPrivate.inert = false;
      this.settle_abyssPrivate();
    }
  }

  private settle_abyssPrivate(): void {
    for (const resolve of this.settlements_abyssPrivate) resolve();
    this.settlements_abyssPrivate.clear();
  }

  private scheduleRelease_abyssPrivate(): void {
    if (this.disposed_abyssPrivate || this.releaseTimer_abyssPrivate !== undefined) return;
    // Native click/contextmenu follows pointerup. Microtasks run too early to replace its target.
    this.releaseTimer_abyssPrivate = this.ownerWindow_abyssPrivate?.setTimeout(() => {
      this.releaseTimer_abyssPrivate = undefined;
      if (this.dragging_abyssPrivate?.defaultPrevented === true)
        this.dragging_abyssPrivate = undefined;
      this.flush_abyssPrivate();
    }, 0);
  }

  private readonly onPointerDown_abyssPrivate = (event: PointerEvent): void => {
    if (this.root_abyssPrivate.inert) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    this.pointers_abyssPrivate.add(event.pointerId);
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
      this.pointers_abyssPrivate.has(press.pointerId) &&
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

  private readonly onPointerEnd_abyssPrivate = (event: PointerEvent): void => {
    if (!this.pointers_abyssPrivate.delete(event.pointerId)) return;
    if (event.type !== 'pointerup' && this.timedPress_abyssPrivate?.pointerId === event.pointerId)
      this.suppressClick_abyssPrivate = true;
    this.scheduleRelease_abyssPrivate();
  };

  private readonly onDragStart_abyssPrivate = (event: DragEvent): void => {
    this.dragging_abyssPrivate = event;
    // Descendant handlers can decline the start; inspect it after native dispatch finishes.
    this.scheduleRelease_abyssPrivate();
  };

  private readonly onCancel_abyssPrivate = (): void => {
    if (
      this.timedPress_abyssPrivate !== undefined &&
      this.pointers_abyssPrivate.has(this.timedPress_abyssPrivate.pointerId)
    )
      this.suppressClick_abyssPrivate = true;
    this.pointers_abyssPrivate.clear();
    this.dragging_abyssPrivate = undefined;
    this.scheduleRelease_abyssPrivate();
  };

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.onCancel_abyssPrivate();
  };

  dispose(): void {
    this.disposed_abyssPrivate = true;
    this.timedPress_abyssPrivate = undefined;
    this.settle_abyssPrivate();
    this.root_abyssPrivate.inert = false;
    if (this.releaseTimer_abyssPrivate !== undefined)
      this.ownerWindow_abyssPrivate?.clearTimeout(this.releaseTimer_abyssPrivate);
    this.removeListeners_abyssPrivate();
  }
}
