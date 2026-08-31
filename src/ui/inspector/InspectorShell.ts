export interface InspectorShellOptions {
  readonly label: string;
  readonly narrow: boolean;
  readonly returnFocus?: HTMLElement | null | (() => HTMLElement | null);
  readonly render: (content: HTMLElement) => void;
  /** The owner decides whether a close request preserves/recovery-surfaces a dirty draft. */
  readonly onRequestClose?: () => void;
  /** Narrow inspectors deliberately stay open while an editor contains an unsaved draft. */
  readonly isDirty?: () => boolean;
}

export interface InspectorShellHandle {
  readonly element: HTMLElement;
  close(restoreFocus?: boolean): void;
}

/** Options for a shell applied to a pane the caller owns and re-renders. */
export type PersistentInspectorShellOptions = Omit<InspectorShellOptions, 'render'>;

/** Applies the one inspector host contract to mounted and persistent pane hosts alike. */
function applyInspectorShellContract(element: HTMLElement, label: string, narrow: boolean): void {
  element.addClass('abyss-inspector-shell');
  element.dataset['inspectorShell'] = 'entity';
  element.dataset['inspectorLayout'] = narrow ? 'drawer' : 'panel';
  element.setAttribute('role', narrow ? 'dialog' : 'region');
  element.setAttribute('aria-label', label);
  if (narrow) element.setAttribute('aria-modal', 'true');
  else element.removeAttribute('aria-modal');
}

function focusableControls(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('*')).filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.matches(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
  );
}

function inspectorReturnTarget(options: PersistentInspectorShellOptions): HTMLElement | null {
  return typeof options.returnFocus === 'function'
    ? options.returnFocus()
    : (options.returnFocus ?? null);
}

function restoreInspectorFocus(options: PersistentInspectorShellOptions): void {
  const target = inspectorReturnTarget(options);
  if (target?.isConnected) target.focus({ preventScroll: true });
}

function handleShellKeydown(
  event: KeyboardEvent,
  element: HTMLElement,
  narrow: boolean,
  requestClose: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    requestClose();
    return;
  }
  if (!narrow || event.key !== 'Tab') return;
  const controls = focusableControls(element);
  if (controls.length === 0) return;
  const activeIndex = controls.indexOf(element.ownerDocument.activeElement as HTMLElement);
  const backwards = event.shiftKey && activeIndex <= 0;
  const forwards = !event.shiftKey && activeIndex === controls.length - 1;
  if (!backwards && !forwards) return;
  event.preventDefault();
  controls[backwards ? controls.length - 1 : 0]?.focus({ preventScroll: true });
}

function isOutsideShell(
  event: PointerEvent,
  element: HTMLElement,
  returnTarget: HTMLElement | null,
): boolean {
  const target = event.target;
  return Boolean(
    target &&
    !element.contains(target as Node) &&
    !(target instanceof Node && returnTarget?.contains(target)),
  );
}

function handleShellOutsidePointer(
  event: PointerEvent,
  element: HTMLElement,
  options: PersistentInspectorShellOptions,
  requestClose: () => void,
): void {
  if (!isOutsideShell(event, element, inspectorReturnTarget(options))) return;
  event.preventDefault();
  event.stopPropagation();
  requestClose();
}

/**
 * Shared semantic host for Project and Work Note inspectors. Desktop is a normal region;
 * narrow mode alone becomes a dialog and owns a small focus trap.
 */
export function mountInspectorShell(
  host: HTMLElement,
  options: InspectorShellOptions,
): InspectorShellHandle {
  const element = host.ownerDocument.createElement('section');
  applyInspectorShellContract(element, options.label, options.narrow);
  const closeNotice = options.narrow
    ? element.createDiv({
        cls: 'abyss-inspector-shell-close-notice',
        attr: { role: 'status', 'aria-live': 'polite' },
      })
    : undefined;
  const closeButton = options.narrow
    ? element.createEl('button', {
        cls: 'abyss-inspector-shell-close',
        text: '×',
        attr: { type: 'button', 'aria-label': `Close ${options.label}`, title: 'Close' },
      })
    : undefined;
  const content = element.createDiv({ cls: 'abyss-inspector-shell-content' });
  options.render(content);
  host.append(element);

  const cleanup = (): void => {
    element.removeEventListener('keydown', onKeyDown);
    if (options.narrow) {
      element.ownerDocument.removeEventListener('pointerdown', onOutsidePointer, true);
    }
  };

  const requestClose = (): void => {
    if (options.isDirty?.()) {
      closeNotice?.setText('Draft kept. Finish or revert the edited field before closing.');
      return;
    }
    cleanup();
    options.onRequestClose?.();
    element.remove();
    restoreInspectorFocus(options);
  };

  const close = (shouldRestoreFocus = true): void => {
    cleanup();
    element.remove();
    if (shouldRestoreFocus) restoreInspectorFocus(options);
  };
  const onKeyDown = (event: KeyboardEvent): void =>
    handleShellKeydown(event, element, options.narrow, requestClose);
  const onOutsidePointer = (event: PointerEvent): void =>
    handleShellOutsidePointer(event, element, options, requestClose);
  element.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', requestClose);
  if (options.narrow) {
    element.ownerDocument.addEventListener('pointerdown', onOutsidePointer, true);
    const initialFocus = focusableControls(content)[0] ?? closeButton ?? content;
    queueMicrotask(() => {
      if (initialFocus.isConnected) initialFocus.focus({ preventScroll: true });
    });
  }
  return { element, close };
}

/**
 * Gives a persistent right-pane host the exact same narrow-dialog contract as
 * mounted inspectors. The owner remains responsible for clearing the pane.
 */
export function bindInspectorShell(
  element: HTMLElement,
  options: PersistentInspectorShellOptions,
): () => void {
  applyInspectorShellContract(element, options.label, options.narrow);
  const closeNotice = options.narrow
    ? element.createDiv({
        cls: 'abyss-inspector-shell-close-notice',
        attr: { role: 'status', 'aria-live': 'polite' },
      })
    : undefined;
  const closeButton = options.narrow
    ? element.createEl('button', {
        cls: 'abyss-inspector-shell-close',
        text: '×',
        attr: { type: 'button', 'aria-label': `Close ${options.label}`, title: 'Close' },
      })
    : undefined;
  if (closeButton) element.prepend(closeButton);
  if (closeNotice) element.prepend(closeNotice);

  const requestClose = (): void => {
    if (options.isDirty?.()) {
      closeNotice?.setText('Draft kept. Finish or revert the edited field before closing.');
      return;
    }
    options.onRequestClose?.();
    restoreInspectorFocus(options);
  };
  const onKeyDown = (event: KeyboardEvent): void =>
    handleShellKeydown(event, element, options.narrow, requestClose);
  const onOutsidePointer = (event: PointerEvent): void =>
    handleShellOutsidePointer(event, element, options, requestClose);
  element.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', requestClose);
  if (options.narrow) {
    element.ownerDocument.addEventListener('pointerdown', onOutsidePointer, true);
    const initialFocus =
      focusableControls(element).find(
        (control) => !control.classList.contains('abyss-inspector-shell-close'),
      ) ??
      closeButton ??
      element;
    queueMicrotask(() => {
      if (initialFocus.isConnected) initialFocus.focus({ preventScroll: true });
    });
  }
  return () => {
    element.removeEventListener('keydown', onKeyDown);
    closeButton?.removeEventListener('click', requestClose);
    if (options.narrow) {
      element.ownerDocument.removeEventListener('pointerdown', onOutsidePointer, true);
    }
    closeNotice?.remove();
    closeButton?.remove();
  };
}
