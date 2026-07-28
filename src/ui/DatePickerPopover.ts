export interface DatePickerPopoverOptions {
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly initialValue?: string;
  readonly onPick: (value: string) => void;
  readonly onClose?: () => void;
}

const ownerCleanups = new WeakMap<HTMLElement, () => void>();

export function showDatePickerPopover(options: DatePickerPopoverOptions): () => void {
  ownerCleanups.get(options.owner)?.();

  const ownerDocument = options.owner.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const popover = ownerDocument.createElement('div');
  popover.className = 'tc-popover tc-date-popover tc-date-picker-popover tc-popover-anchored';
  popover.style.setProperty(
    '--tc-pop-top',
    `${options.anchor.offsetTop + options.anchor.offsetHeight}px`,
  );
  popover.style.setProperty('--tc-pop-left', `${options.anchor.offsetLeft}px`);

  const row = ownerDocument.createElement('div');
  row.className = 'tc-popover-input-row';
  const input = ownerDocument.createElement('input');
  input.className = 'tc-date-input';
  input.type = 'date';
  input.value = options.initialValue ?? '';
  row.append(input);
  popover.append(row);
  options.owner.append(popover);

  let closed = false;
  let registrationTimer: number | undefined;
  let focusTimer: number | undefined;
  let blurTimer: number | undefined;
  let listening = false;

  const onOutside = (event: MouseEvent): void => {
    const target = event.target;
    if (
      target instanceof ownerWindow.Node &&
      (popover.contains(target) || options.anchor.contains(target))
    ) {
      return;
    }
    cleanup();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') cleanup();
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (registrationTimer !== undefined) ownerWindow.clearTimeout(registrationTimer);
    if (focusTimer !== undefined) ownerWindow.clearTimeout(focusTimer);
    if (blurTimer !== undefined) ownerWindow.clearTimeout(blurTimer);
    if (listening) {
      ownerDocument.removeEventListener('mousedown', onOutside, true);
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
    }
    popover.remove();
    if (ownerCleanups.get(options.owner) === cleanup) ownerCleanups.delete(options.owner);
    options.onClose?.();
  };
  ownerCleanups.set(options.owner, cleanup);

  input.addEventListener('change', () => {
    try {
      options.onPick(input.value);
    } finally {
      cleanup();
    }
  });
  input.addEventListener('blur', () => {
    blurTimer = ownerWindow.setTimeout(cleanup, 200);
  });

  registrationTimer = ownerWindow.setTimeout(() => {
    registrationTimer = undefined;
    if (closed) return;
    ownerDocument.addEventListener('mousedown', onOutside, true);
    ownerDocument.addEventListener('keydown', onKeyDown, true);
    listening = true;
  }, 0);
  focusTimer = ownerWindow.setTimeout(() => {
    focusTimer = undefined;
    if (!closed) input.focus();
  }, 0);

  return cleanup;
}
