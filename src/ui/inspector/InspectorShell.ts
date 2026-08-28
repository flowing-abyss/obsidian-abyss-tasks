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

function focusableControls(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('*')).filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.matches(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
  );
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
  element.className = 'abyss-inspector-shell';
  element.dataset['inspectorLayout'] = options.narrow ? 'drawer' : 'panel';
  element.setAttribute('role', options.narrow ? 'dialog' : 'region');
  element.setAttribute('aria-label', options.label);
  if (options.narrow) element.setAttribute('aria-modal', 'true');
  const closeNotice = element.createDiv({
    cls: 'abyss-inspector-shell-close-notice',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  const closeButton = element.createEl('button', {
    cls: 'abyss-inspector-shell-close',
    text: 'Close',
    attr: { type: 'button', 'aria-label': `Close ${options.label}` },
  });
  const content = element.createDiv({ cls: 'abyss-inspector-shell-content' });
  options.render(content);
  host.append(element);

  const returnTarget = (): HTMLElement | null =>
    typeof options.returnFocus === 'function'
      ? options.returnFocus()
      : (options.returnFocus ?? null);

  const cleanup = (): void => {
    element.removeEventListener('keydown', onKeyDown);
    if (options.narrow) {
      element.ownerDocument.removeEventListener('pointerdown', onOutsidePointer, true);
    }
  };

  const restoreFocus = (): void => {
    const target = returnTarget();
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  const requestClose = (): void => {
    if (options.isDirty?.()) {
      closeNotice.setText('Draft kept. Finish or revert the edited field before closing.');
      return;
    }
    cleanup();
    options.onRequestClose?.();
    element.remove();
    restoreFocus();
  };

  const close = (shouldRestoreFocus = true): void => {
    cleanup();
    element.remove();
    if (shouldRestoreFocus) restoreFocus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (!options.narrow || event.key !== 'Tab') return;
    const controls = focusableControls(element);
    if (controls.length === 0) return;
    const activeIndex = controls.indexOf(element.ownerDocument.activeElement as HTMLElement);
    const backwards = event.shiftKey && activeIndex <= 0;
    const forwards = !event.shiftKey && activeIndex === controls.length - 1;
    if (!backwards && !forwards) return;
    event.preventDefault();
    controls[backwards ? controls.length - 1 : 0]?.focus({ preventScroll: true });
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (!target || element.contains(target as Node)) return;
    const origin = returnTarget();
    if (target instanceof Node && origin?.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  };
  element.addEventListener('keydown', onKeyDown);
  closeButton.addEventListener('click', requestClose);
  if (options.narrow) {
    element.ownerDocument.addEventListener('pointerdown', onOutsidePointer, true);
    const initialFocus = focusableControls(content)[0] ?? closeButton;
    queueMicrotask(() => {
      if (initialFocus.isConnected) initialFocus.focus({ preventScroll: true });
    });
  }
  return { element, close };
}
