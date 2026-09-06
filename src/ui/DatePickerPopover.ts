import { anchoredPlacement } from './anchoredPlacement';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export interface DatePickerPopoverOptions {
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly initialValue?: string;
  readonly onPick: (value: string) => void;
  readonly onClose?: () => void;
  readonly restoreFocus?: () => void;
  readonly interactionOwnership?: InteractionOwnershipPort;
}

const ownerCleanups = new WeakMap<HTMLElement, () => void>();

class DatePickerLifecycle {
  private readonly ownerDocument_abyssPrivate: Document;
  private readonly ownerWindow_abyssPrivate: NonNullable<Document['defaultView']> | null;
  private readonly timerWindow_abyssPrivate: Window;
  private readonly ownershipToken_abyssPrivate: { release(): void };
  private registrationTimer_abyssPrivate: number | undefined;
  private focusTimer_abyssPrivate: number | undefined;
  private blurTimer_abyssPrivate: number | undefined;
  private listening_abyssPrivate = false;
  private closed_abyssPrivate = false;

  constructor(
    private readonly options_abyssPrivate: DatePickerPopoverOptions,
    private readonly popover_abyssPrivate: HTMLElement,
    private readonly input_abyssPrivate: HTMLInputElement,
    private readonly position_abyssPrivate: () => void,
  ) {
    this.ownerDocument_abyssPrivate = options_abyssPrivate.owner.ownerDocument;
    this.ownerWindow_abyssPrivate = this.ownerDocument_abyssPrivate.defaultView;
    this.timerWindow_abyssPrivate = this.ownerWindow_abyssPrivate ?? activeWindow;
    this.ownershipToken_abyssPrivate = (
      options_abyssPrivate.interactionOwnership ?? noInteractionOwnership
    ).acquire({
      blocksShortcuts: true,
    });
  }

  mount(): () => void {
    ownerCleanups.set(this.options_abyssPrivate.owner, this.cleanup_abyssPrivate);
    this.ownerWindow_abyssPrivate?.addEventListener('resize', this.position_abyssPrivate);
    this.ownerDocument_abyssPrivate.addEventListener('scroll', this.position_abyssPrivate, true);
    this.input_abyssPrivate.addEventListener('change', this.onChange_abyssPrivate);
    this.input_abyssPrivate.addEventListener('blur', this.onBlur_abyssPrivate);
    this.registrationTimer_abyssPrivate = this.setTimer_abyssPrivate(
      this.beginListening_abyssPrivate,
      0,
    );
    this.focusTimer_abyssPrivate = this.setTimer_abyssPrivate(this.focusInput_abyssPrivate, 0);
    return this.cleanup_abyssPrivate;
  }

  private readonly onOutside_abyssPrivate = (event: MouseEvent): void => {
    const target = event.target;
    const isOwnerNode =
      target !== null &&
      (this.ownerWindow_abyssPrivate != null
        ? target instanceof this.ownerWindow_abyssPrivate.Node
        : typeof (target as { nodeType?: unknown }).nodeType === 'number');
    if (
      isOwnerNode &&
      (this.popover_abyssPrivate.contains(target as Node) ||
        this.options_abyssPrivate.anchor.contains(target as Node))
    ) {
      return;
    }
    this.cleanup_abyssPrivate();
  };

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cleanup_abyssPrivate();
  };

  private readonly onChange_abyssPrivate = (): void => {
    try {
      this.options_abyssPrivate.onPick(this.input_abyssPrivate.value);
    } finally {
      this.cleanup_abyssPrivate();
    }
  };

  private readonly onBlur_abyssPrivate = (): void => {
    if (this.closed_abyssPrivate) return;
    this.clearTimer_abyssPrivate(this.blurTimer_abyssPrivate);
    this.blurTimer_abyssPrivate = this.setTimer_abyssPrivate(() => {
      this.blurTimer_abyssPrivate = undefined;
      this.cleanup_abyssPrivate(false);
    }, 200);
  };

  private readonly beginListening_abyssPrivate = (): void => {
    this.registrationTimer_abyssPrivate = undefined;
    if (this.closed_abyssPrivate) return;
    this.ownerDocument_abyssPrivate.addEventListener(
      'mousedown',
      this.onOutside_abyssPrivate,
      true,
    );
    this.ownerDocument_abyssPrivate.addEventListener('keydown', this.onKeyDown_abyssPrivate, true);
    this.listening_abyssPrivate = true;
  };

  private readonly focusInput_abyssPrivate = (): void => {
    this.focusTimer_abyssPrivate = undefined;
    if (!this.closed_abyssPrivate) this.input_abyssPrivate.focus();
  };

  private readonly cleanup_abyssPrivate = (restoreFocus = true): void => {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.clearTimers_abyssPrivate();
    this.removeListeners_abyssPrivate();
    this.popover_abyssPrivate.remove();
    if (ownerCleanups.get(this.options_abyssPrivate.owner) === this.cleanup_abyssPrivate) {
      ownerCleanups.delete(this.options_abyssPrivate.owner);
    }
    this.ownershipToken_abyssPrivate.release();
    if (restoreFocus) this.restoreFocus_abyssPrivate();
    this.options_abyssPrivate.onClose?.();
  };

  private setTimer_abyssPrivate(callback: () => void, delay: number): number {
    return this.timerWindow_abyssPrivate.setTimeout(callback, delay);
  }

  private clearTimer_abyssPrivate(timer: number | undefined): void {
    if (timer !== undefined) this.timerWindow_abyssPrivate.clearTimeout(timer);
  }

  private clearTimers_abyssPrivate(): void {
    this.clearTimer_abyssPrivate(this.registrationTimer_abyssPrivate);
    this.clearTimer_abyssPrivate(this.focusTimer_abyssPrivate);
    this.clearTimer_abyssPrivate(this.blurTimer_abyssPrivate);
  }

  private removeListeners_abyssPrivate(): void {
    if (this.listening_abyssPrivate) {
      this.ownerDocument_abyssPrivate.removeEventListener(
        'mousedown',
        this.onOutside_abyssPrivate,
        true,
      );
      this.ownerDocument_abyssPrivate.removeEventListener(
        'keydown',
        this.onKeyDown_abyssPrivate,
        true,
      );
    }
    this.ownerWindow_abyssPrivate?.removeEventListener('resize', this.position_abyssPrivate);
    this.ownerDocument_abyssPrivate.removeEventListener('scroll', this.position_abyssPrivate, true);
  }

  private restoreFocus_abyssPrivate(): void {
    if (this.options_abyssPrivate.restoreFocus != null) this.options_abyssPrivate.restoreFocus();
    else if (this.options_abyssPrivate.anchor.isConnected)
      this.options_abyssPrivate.anchor.focus({ preventScroll: true });
  }
}

export function showDatePickerPopover(options: DatePickerPopoverOptions): () => void {
  ownerCleanups.get(options.owner)?.();

  const popover = options.owner.createDiv();
  popover.className =
    'abyss-popover abyss-date-popover abyss-date-picker-popover abyss-popover-anchored';

  const row = popover.createDiv();
  row.className = 'abyss-popover-input-row';
  const input = row.createEl('input');
  input.className = 'abyss-date-input';
  input.type = 'date';
  input.setAttribute('aria-label', 'Set date');
  input.value = options.initialValue ?? '';

  const position = (): void => {
    const boundary = options.boundary.getBoundingClientRect();
    const owner = options.owner.getBoundingClientRect();
    const floatingRect = popover.getBoundingClientRect();
    const placement = anchoredPlacement({
      anchor: options.anchor.getBoundingClientRect(),
      floating: {
        width: floatingRect.width !== 0 ? floatingRect.width : popover.offsetWidth,
        height: floatingRect.height !== 0 ? floatingRect.height : popover.offsetHeight,
      },
      boundary,
      gap: 4,
      edgeGap: 8,
      preferred: 'below-start',
    });
    popover.style.setProperty(
      '--abyss-pop-top',
      `${placement.top - owner.top - options.owner.clientTop + options.owner.scrollTop}px`,
    );
    popover.style.setProperty(
      '--abyss-pop-left',
      `${placement.left - owner.left - options.owner.clientLeft + options.owner.scrollLeft}px`,
    );
    popover.dataset['side'] = placement.side;
  };
  position();

  return new DatePickerLifecycle(options, popover, input, position).mount();
}
