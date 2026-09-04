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
  private readonly ownerDocument: Document;
  private readonly ownerWindow: NonNullable<Document['defaultView']> | null;
  private readonly timerWindow: Window;
  private readonly ownershipToken: { release(): void };
  private registrationTimer: number | undefined;
  private focusTimer: number | undefined;
  private blurTimer: number | undefined;
  private listening = false;
  private closed = false;

  constructor(
    private readonly options: DatePickerPopoverOptions,
    private readonly popover: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly position: () => void,
  ) {
    this.ownerDocument = options.owner.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView;
    this.timerWindow = this.ownerWindow ?? activeWindow;
    this.ownershipToken = (options.interactionOwnership ?? noInteractionOwnership).acquire({
      blocksShortcuts: true,
    });
  }

  mount(): () => void {
    ownerCleanups.set(this.options.owner, this.cleanup);
    this.ownerWindow?.addEventListener('resize', this.position);
    this.ownerDocument.addEventListener('scroll', this.position, true);
    this.input.addEventListener('change', this.onChange);
    this.input.addEventListener('blur', this.onBlur);
    this.registrationTimer = this.setTimer(this.beginListening, 0);
    this.focusTimer = this.setTimer(this.focusInput, 0);
    return this.cleanup;
  }

  private readonly onOutside = (event: MouseEvent): void => {
    const target = event.target;
    const isOwnerNode =
      target !== null &&
      (this.ownerWindow != null
        ? target instanceof this.ownerWindow.Node
        : typeof (target as { nodeType?: unknown }).nodeType === 'number');
    if (
      isOwnerNode &&
      (this.popover.contains(target as Node) || this.options.anchor.contains(target as Node))
    ) {
      return;
    }
    this.cleanup();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cleanup();
  };

  private readonly onChange = (): void => {
    try {
      this.options.onPick(this.input.value);
    } finally {
      this.cleanup();
    }
  };

  private readonly onBlur = (): void => {
    if (this.closed) return;
    this.clearTimer(this.blurTimer);
    this.blurTimer = this.setTimer(() => {
      this.blurTimer = undefined;
      this.cleanup(false);
    }, 200);
  };

  private readonly beginListening = (): void => {
    this.registrationTimer = undefined;
    if (this.closed) return;
    this.ownerDocument.addEventListener('mousedown', this.onOutside, true);
    this.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
    this.listening = true;
  };

  private readonly focusInput = (): void => {
    this.focusTimer = undefined;
    if (!this.closed) this.input.focus();
  };

  private readonly cleanup = (restoreFocus = true): void => {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.removeListeners();
    this.popover.remove();
    if (ownerCleanups.get(this.options.owner) === this.cleanup) {
      ownerCleanups.delete(this.options.owner);
    }
    this.ownershipToken.release();
    if (restoreFocus) this.restoreFocus();
    this.options.onClose?.();
  };

  private setTimer(callback: () => void, delay: number): number {
    return this.timerWindow.setTimeout(callback, delay);
  }

  private clearTimer(timer: number | undefined): void {
    if (timer !== undefined) this.timerWindow.clearTimeout(timer);
  }

  private clearTimers(): void {
    this.clearTimer(this.registrationTimer);
    this.clearTimer(this.focusTimer);
    this.clearTimer(this.blurTimer);
  }

  private removeListeners(): void {
    if (this.listening) {
      this.ownerDocument.removeEventListener('mousedown', this.onOutside, true);
      this.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
    }
    this.ownerWindow?.removeEventListener('resize', this.position);
    this.ownerDocument.removeEventListener('scroll', this.position, true);
  }

  private restoreFocus(): void {
    if (this.options.restoreFocus != null) this.options.restoreFocus();
    else if (this.options.anchor.isConnected) this.options.anchor.focus({ preventScroll: true });
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
