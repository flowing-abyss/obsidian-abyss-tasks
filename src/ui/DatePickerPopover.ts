import { anchoredPlacement } from './anchoredPlacement';
import { isImeOwnedEvent } from './ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { focusOpeningDateInput } from './nativeDateInput';
import {
  bindSegmentedInputCommit,
  isUsableDateInputValue,
  type SegmentedCommitReason,
  type SegmentedInputCommitHandle,
} from './segmentedInputCommit';

export interface DatePickerPopoverOptions {
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly initialValue?: string;
  /** `returnFocus` is false for a pick made by leaving the picker, which keeps focus where it went. */
  readonly onPick: (value: string, pick: { readonly returnFocus: boolean }) => void;
  readonly onClose?: () => void;
  readonly onInvalidDraft?: () => void;
  readonly restoreFocus?: () => void;
  readonly interactionOwnership?: InteractionOwnershipPort;
}

export interface DatePickerPopoverHandle {
  (restoreFocus?: boolean): void;
  readonly element: HTMLElement;
  flush(): 'ready' | 'blocked';
}

const ownerCleanups = new WeakMap<HTMLElement, () => void>();

class DatePickerLifecycle {
  private readonly ownerDocument_abyssPrivate: Document;
  private readonly ownerWindow_abyssPrivate: NonNullable<Document['defaultView']> | null;
  private readonly timerWindow_abyssPrivate: Window;
  private readonly ownershipToken_abyssPrivate: { release(): void };
  private readonly draft_abyssPrivate: SegmentedInputCommitHandle;
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
    this.draft_abyssPrivate = bindSegmentedInputCommit({
      input: input_abyssPrivate,
      boundary: popover_abyssPrivate,
      commit: (reason) => {
        this.commitDraft_abyssPrivate(reason);
      },
    });
  }

  mount(): DatePickerPopoverHandle {
    ownerCleanups.set(this.options_abyssPrivate.owner, this.cleanup_abyssPrivate);
    this.ownerWindow_abyssPrivate?.addEventListener('resize', this.position_abyssPrivate);
    this.ownerDocument_abyssPrivate.addEventListener('scroll', this.position_abyssPrivate, true);
    this.input_abyssPrivate.addEventListener('blur', this.onBlur_abyssPrivate);
    this.registrationTimer_abyssPrivate = this.setTimer_abyssPrivate(
      this.beginListening_abyssPrivate,
      0,
    );
    this.focusTimer_abyssPrivate = this.setTimer_abyssPrivate(this.focusInput_abyssPrivate, 0);
    return Object.assign(this.cleanup_abyssPrivate, {
      element: this.popover_abyssPrivate,
      flush: () => this.flush_abyssPrivate(),
    });
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
    if (this.options_abyssPrivate.onInvalidDraft !== undefined) {
      this.flush_abyssPrivate();
      return;
    }
    this.draft_abyssPrivate.flush();
    this.cleanup_abyssPrivate();
  };

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (isImeOwnedEvent(event)) return;
    if (
      event.key === 'Enter' &&
      this.options_abyssPrivate.onInvalidDraft !== undefined &&
      event.target === this.input_abyssPrivate
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.commitDraft_abyssPrivate('enter');
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cleanup_abyssPrivate();
  };

  private commitDraft_abyssPrivate(reason: SegmentedCommitReason): void {
    if (this.closed_abyssPrivate || !this.validDraft_abyssPrivate()) return;
    const value = this.input_abyssPrivate.value;
    // Enter and a native change close as a change always has; leaving the picker keeps focus where
    // the user sent it.
    const returnFocus = reason === 'change' || reason === 'enter';
    try {
      this.options_abyssPrivate.onPick(value, { returnFocus });
    } finally {
      this.cleanup_abyssPrivate(returnFocus);
    }
  }

  private validDraft_abyssPrivate(): boolean {
    const { validity, value } = this.input_abyssPrivate;
    if (!validity.badInput && (value === '' || isUsableDateInputValue(value))) return true;
    this.options_abyssPrivate.onInvalidDraft?.();
    return false;
  }

  private flush_abyssPrivate(): 'ready' | 'blocked' {
    if (this.closed_abyssPrivate) return 'ready';
    if (!this.validDraft_abyssPrivate()) return 'blocked';
    if (this.input_abyssPrivate.value !== (this.options_abyssPrivate.initialValue ?? ''))
      this.commitDraft_abyssPrivate('flush');
    else this.cleanup_abyssPrivate(false);
    return 'ready';
  }

  private readonly onBlur_abyssPrivate = (): void => {
    if (this.closed_abyssPrivate) return;
    this.clearTimer_abyssPrivate(this.blurTimer_abyssPrivate);
    this.blurTimer_abyssPrivate = this.setTimer_abyssPrivate(() => {
      this.blurTimer_abyssPrivate = undefined;
      if (this.options_abyssPrivate.onInvalidDraft !== undefined) this.flush_abyssPrivate();
      else this.cleanup_abyssPrivate(false);
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
    if (!this.closed_abyssPrivate) focusOpeningDateInput(this.input_abyssPrivate);
  };

  private readonly cleanup_abyssPrivate = (restoreFocus = true): void => {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.draft_abyssPrivate.cancel();
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

export function showDatePickerPopover(options: DatePickerPopoverOptions): DatePickerPopoverHandle {
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
