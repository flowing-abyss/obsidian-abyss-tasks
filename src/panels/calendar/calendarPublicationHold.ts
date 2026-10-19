import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';

/** Retains a mounted calendar's targets until native activation and submitted commands settle. */
export class CalendarPublicationHold {
  private readonly ownerWindow: Window | null;
  private readonly pointers = new Set<number>();
  private pending = 0;
  private leases = 0;
  private dragging: DragEvent | undefined;
  private dirty = false;
  private disposed = false;
  private releaseTimer: number | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly publish: () => void,
  ) {
    this.ownerWindow = root.ownerDocument.defaultView;
    root.addEventListener('pointerdown', this.onPointerDown, true);
    root.addEventListener('lostpointercapture', this.onPointerEnd, true);
    root.addEventListener('dragstart', this.onDragStart, true);
    this.ownerWindow?.addEventListener('pointerup', this.onPointerEnd, true);
    this.ownerWindow?.addEventListener('pointercancel', this.onPointerEnd, true);
    this.ownerWindow?.addEventListener('dragend', this.onCancel, true);
    this.ownerWindow?.addEventListener('drop', this.onCancel, true);
    this.ownerWindow?.addEventListener('blur', this.onCancel);
    this.ownerWindow?.addEventListener('keydown', this.onKeyDown, true);
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
      if (!this.disposed) {
        this.flush();
      }
    }
  }

  private flush(): void {
    if (
      this.disposed ||
      this.pending > 0 ||
      this.leases > 0 ||
      this.pointers.size > 0 ||
      this.dragging !== undefined ||
      this.releaseTimer !== undefined
    )
      return;
    if (this.dirty) {
      this.dirty = false;
      this.publish();
    }
    this.root.inert = false;
  }

  private scheduleRelease(): void {
    if (this.disposed || this.releaseTimer !== undefined) return;
    // Native click/contextmenu follows pointerup. Microtasks run too early to replace its target.
    this.releaseTimer = this.ownerWindow?.setTimeout(() => {
      this.releaseTimer = undefined;
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
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.pointers.delete(event.pointerId)) this.scheduleRelease();
  };

  private readonly onDragStart = (event: DragEvent): void => {
    this.dragging = event;
    // Descendant handlers can decline the start; inspect it after native dispatch finishes.
    this.scheduleRelease();
  };

  private readonly onCancel = (): void => {
    this.pointers.clear();
    this.dragging = undefined;
    this.scheduleRelease();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.onCancel();
  };

  dispose(): void {
    this.disposed = true;
    this.root.inert = false;
    if (this.releaseTimer !== undefined) this.ownerWindow?.clearTimeout(this.releaseTimer);
    this.root.removeEventListener('pointerdown', this.onPointerDown, true);
    this.root.removeEventListener('lostpointercapture', this.onPointerEnd, true);
    this.root.removeEventListener('dragstart', this.onDragStart, true);
    this.ownerWindow?.removeEventListener('pointerup', this.onPointerEnd, true);
    this.ownerWindow?.removeEventListener('pointercancel', this.onPointerEnd, true);
    this.ownerWindow?.removeEventListener('dragend', this.onCancel, true);
    this.ownerWindow?.removeEventListener('drop', this.onCancel, true);
    this.ownerWindow?.removeEventListener('blur', this.onCancel);
    this.ownerWindow?.removeEventListener('keydown', this.onKeyDown, true);
  }
}
