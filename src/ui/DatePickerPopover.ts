import { anchoredPlacement } from './anchoredPlacement';

export interface DatePickerPopoverOptions {
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly initialValue?: string;
  readonly onPick: (value: string) => void;
  readonly onClose?: () => void;
  readonly restoreFocus?: () => void;
}

const ownerCleanups = new WeakMap<HTMLElement, () => void>();

export function showDatePickerPopover(options: DatePickerPopoverOptions): () => void {
  ownerCleanups.get(options.owner)?.();

  const ownerDocument = options.owner.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const popover = ownerDocument.createElement('div');
  popover.className = 'tc-popover tc-date-popover tc-date-picker-popover tc-popover-anchored';

  const row = ownerDocument.createElement('div');
  row.className = 'tc-popover-input-row';
  const input = ownerDocument.createElement('input');
  input.className = 'tc-date-input';
  input.type = 'date';
  input.setAttribute('aria-label', 'Set date');
  input.value = options.initialValue ?? '';
  row.append(input);
  popover.append(row);
  options.owner.append(popover);

  const position = (): void => {
    const boundary = options.boundary.getBoundingClientRect();
    const owner = options.owner.getBoundingClientRect();
    const floatingRect = popover.getBoundingClientRect();
    const placement = anchoredPlacement({
      anchor: options.anchor.getBoundingClientRect(),
      floating: {
        width: floatingRect.width || popover.offsetWidth,
        height: floatingRect.height || popover.offsetHeight,
      },
      boundary,
      gap: 4,
      edgeGap: 8,
      preferred: 'below-start',
    });
    popover.style.setProperty(
      '--tc-pop-top',
      `${placement.top - owner.top - options.owner.clientTop + options.owner.scrollTop}px`,
    );
    popover.style.setProperty(
      '--tc-pop-left',
      `${placement.left - owner.left - options.owner.clientLeft + options.owner.scrollLeft}px`,
    );
    popover.dataset['side'] = placement.side;
  };
  position();

  let closed = false;
  let registrationTimer: number | undefined;
  let focusTimer: number | undefined;
  let blurTimer: number | undefined;
  let listening = false;
  const timerWindow = ownerWindow ?? activeWindow;
  const setOwnerTimeout = (callback: () => void, delay: number): number =>
    timerWindow.setTimeout(callback, delay);
  const clearOwnerTimeout = (timer: number): void => {
    timerWindow.clearTimeout(timer);
  };

  const onOutside = (event: MouseEvent): void => {
    const target = event.target;
    const isOwnerNode =
      target !== null &&
      (ownerWindow
        ? target instanceof ownerWindow.Node
        : typeof (target as { nodeType?: unknown }).nodeType === 'number');
    if (
      isOwnerNode &&
      (popover.contains(target as Node) || options.anchor.contains(target as Node))
    ) {
      return;
    }
    cleanup();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  };
  const cleanup = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    if (registrationTimer !== undefined) clearOwnerTimeout(registrationTimer);
    if (focusTimer !== undefined) clearOwnerTimeout(focusTimer);
    if (blurTimer !== undefined) clearOwnerTimeout(blurTimer);
    if (listening) {
      ownerDocument.removeEventListener('mousedown', onOutside, true);
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
    }
    ownerWindow?.removeEventListener('resize', position);
    ownerDocument.removeEventListener('scroll', position, true);
    popover.remove();
    if (ownerCleanups.get(options.owner) === cleanup) ownerCleanups.delete(options.owner);
    if (restoreFocus) {
      if (options.restoreFocus) options.restoreFocus();
      else if (options.anchor.isConnected) options.anchor.focus({ preventScroll: true });
    }
    options.onClose?.();
  };
  ownerCleanups.set(options.owner, cleanup);
  ownerWindow?.addEventListener('resize', position);
  ownerDocument.addEventListener('scroll', position, true);

  input.addEventListener('change', () => {
    try {
      options.onPick(input.value);
    } finally {
      cleanup();
    }
  });
  input.addEventListener('blur', () => {
    if (closed) return;
    if (blurTimer !== undefined) clearOwnerTimeout(blurTimer);
    blurTimer = setOwnerTimeout(() => {
      blurTimer = undefined;
      cleanup(false);
    }, 200);
  });

  registrationTimer = setOwnerTimeout(() => {
    registrationTimer = undefined;
    if (closed) return;
    ownerDocument.addEventListener('mousedown', onOutside, true);
    ownerDocument.addEventListener('keydown', onKeyDown, true);
    listening = true;
  }, 0);
  focusTimer = setOwnerTimeout(() => {
    focusTimer = undefined;
    if (!closed) input.focus();
  }, 0);

  return cleanup;
}
