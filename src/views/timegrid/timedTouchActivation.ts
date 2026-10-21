const HOLD_DELAY_MS = 450;
const HOLD_SLOP_PX = 8;

/** Arbitrates native scrolling and a held touch before handing off to the timed session. */
export class TimedTouchActivation {
  private cancelPending_abyssPrivate: (() => void) | undefined;
  private dragging_abyssPrivate = false;
  private consumed_abyssPrivate = false;
  private touchPress_abyssPrivate = false;

  constructor(
    private readonly source_abyssPrivate: HTMLElement,
    private readonly ownerWindow_abyssPrivate: Window,
  ) {
    source_abyssPrivate.addEventListener('pointerdown', this.onPress_abyssPrivate, true);
    source_abyssPrivate.addEventListener('contextmenu', this.onContextMenu_abyssPrivate, true);
    source_abyssPrivate.addEventListener('click', this.onClick_abyssPrivate, true);
    // Pointer cancellation cannot stop native panning, and changing touch-action after the
    // hold is too late. Only a claimed hold cancels touchmove; early swipes remain native.
    source_abyssPrivate.addEventListener('touchmove', this.onTouchMove_abyssPrivate, {
      passive: false,
    });
    source_abyssPrivate.addEventListener('touchend', this.onTouchEnd_abyssPrivate);
  }

  arm(event: PointerEvent, activate: () => void, ended: () => void): () => void {
    this.cancelPending_abyssPrivate?.();
    this.touchPress_abyssPrivate = true;
    const owner = this.ownerWindow_abyssPrivate;
    const move = (pointer: PointerEvent): void => {
      if (
        pointer.pointerId === event.pointerId &&
        Math.hypot(pointer.clientX - event.clientX, pointer.clientY - event.clientY) > HOLD_SLOP_PX
      )
        dispose();
    };
    const end = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== event.pointerId) return;
      if (pointer.type === 'pointerup') clear();
      else dispose();
    };
    const press = (pointer: PointerEvent): void => {
      if (pointer.pointerType === 'touch') dispose();
    };
    const scroll = (scrollEvent: Event): void => {
      const target = scrollEvent.target as Partial<Pick<Node, 'contains'>> | null;
      if (target?.contains?.(this.source_abyssPrivate) === true) dispose();
    };
    const key = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') dispose();
    };
    let disposed = false;
    const clear = (): void => {
      if (disposed) return;
      disposed = true;
      owner.clearTimeout(timer);
      owner.removeEventListener('pointermove', move);
      owner.removeEventListener('pointerup', end);
      owner.removeEventListener('pointercancel', end);
      owner.removeEventListener('lostpointercapture', end);
      owner.removeEventListener('pointerdown', press, true);
      owner.removeEventListener('scroll', scroll, true);
      owner.removeEventListener('blur', dispose);
      owner.removeEventListener('keydown', key, true);
      this.cancelPending_abyssPrivate = undefined;
      ended();
    };
    const dispose = (): void => {
      if (disposed) return;
      this.consumed_abyssPrivate = true;
      clear();
    };
    const timer = owner.setTimeout(() => {
      clear();
      if (!this.source_abyssPrivate.isConnected) return;
      this.consumed_abyssPrivate = true;
      this.dragging_abyssPrivate = true;
      activate();
    }, HOLD_DELAY_MS);
    this.cancelPending_abyssPrivate = dispose;
    owner.addEventListener('pointermove', move);
    owner.addEventListener('pointerup', end);
    owner.addEventListener('pointercancel', end);
    owner.addEventListener('lostpointercapture', end);
    owner.addEventListener('pointerdown', press, true);
    owner.addEventListener('scroll', scroll, true);
    owner.addEventListener('blur', dispose);
    owner.addEventListener('keydown', key, true);
    return dispose;
  }

  finish(): void {
    this.dragging_abyssPrivate = false;
  }

  private readonly onPress_abyssPrivate = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    this.consumed_abyssPrivate = false;
    this.touchPress_abyssPrivate = false;
  };

  private readonly onTouchMove_abyssPrivate = (event: TouchEvent): void => {
    if (this.dragging_abyssPrivate) event.preventDefault();
  };

  private readonly onTouchEnd_abyssPrivate = (event: TouchEvent): void => {
    if (this.consumed_abyssPrivate && event.cancelable) event.preventDefault();
  };

  private readonly onContextMenu_abyssPrivate = (event: MouseEvent): void => {
    const touch = 'pointerType' in event && event.pointerType === 'touch';
    if (
      this.touchPress_abyssPrivate &&
      (touch || this.cancelPending_abyssPrivate !== undefined || this.dragging_abyssPrivate)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private readonly onClick_abyssPrivate = (event: MouseEvent): void => {
    if (this.consumed_abyssPrivate && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
}
