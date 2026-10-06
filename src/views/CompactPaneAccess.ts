import type { AppStateData } from '../app/AppState';
import { isImeOwnedEvent } from '../ui/ime';
import { nativeInteractionBlocksPanelShortcuts } from '../ui/nativeInteractionBlocker';
import type { QuickCaptureCoordinator } from '../ui/taskCapture/QuickCaptureCoordinator';

export type CompactPane = 'left' | 'right';
export type CompactPaneOpenReason = 'automatic' | 'button';

export interface PendingCompactPane {
  readonly pane: CompactPane;
  readonly moveFocus: boolean;
  readonly reason?: CompactPaneOpenReason;
}

export interface CompactPaneAccessElements {
  readonly layout: HTMLElement;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly leftButton: HTMLButtonElement;
  readonly rightButton: HTMLButtonElement;
}

interface CompactPaneAccessOptions {
  readonly mode: () => AppStateData['mode'];
  readonly hasSelectedTask: () => boolean;
  readonly captureState: () => Pick<QuickCaptureCoordinator, 'phase' | 'isSubmitting'> | undefined;
  readonly allowsPaneInteraction: () => boolean;
}

let panelViewInstanceSequence = 0;
const COMPACT_RIGHT_MAX_REM = 58;
const COMPACT_LEFT_MAX_REM = 38;

function configureCompactPaneElements(elements: CompactPaneAccessElements): void {
  const instanceId = ++panelViewInstanceSequence;
  elements.left.id = `abyss-task-lists-${String(instanceId)}`;
  elements.right.id = `abyss-task-details-${String(instanceId)}`;
  elements.left.tabIndex = -1;
  elements.right.tabIndex = -1;
  elements.left.setAttribute('role', 'region');
  const listsName = elements.layout.createSpan({
    cls: 'abyss-sr-only',
    text: 'Task lists',
    attr: { id: `${elements.left.id}-label` },
  });
  elements.left.setAttribute('aria-labelledby', listsName.id);
  elements.right.setAttribute('role', 'region');
  const detailsName = elements.layout.createSpan({
    cls: 'abyss-sr-only',
    text: 'Task details',
    attr: { id: `${elements.right.id}-label` },
  });
  elements.right.setAttribute('aria-labelledby', detailsName.id);
  elements.leftButton.setAttribute('aria-controls', elements.left.id);
  elements.rightButton.setAttribute('aria-controls', elements.right.id);
}

type ResizeObserverConstructor = new (callback: ResizeObserverCallback) => ResizeObserver;

function isResizeObserverConstructor(value: unknown): value is ResizeObserverConstructor {
  return typeof value === 'function';
}

export class CompactPaneAccess {
  #compactPaneElements: CompactPaneAccessElements | undefined;
  #compactPaneCleanup: (() => void) | undefined;
  #compactPaneRefresh: (() => void) | undefined;
  #compactHeaderResizeObserver: ResizeObserver | undefined = undefined;
  #compactPaneOpen: CompactPane | null = null;
  #compactPaneOpenReason: CompactPaneOpenReason | undefined;
  #compactLeftCollapsed = false;
  #compactRightCollapsed = false;
  #pendingCompactPane: PendingCompactPane | undefined = undefined;

  readonly #options: CompactPaneAccessOptions;

  constructor(options: CompactPaneAccessOptions) {
    this.#options = options;
  }

  attachHeader(header: HTMLElement, controls: HTMLElement): void {
    const compact = this.#compactPaneElements;
    if (compact === undefined) return;
    controls.prepend(compact.leftButton);
    controls.append(compact.rightButton);
    this.#syncButtonAvailability();
    this.#observeCompactHeader(header);
  }

  refreshWidth(): void {
    this.#compactPaneRefresh?.();
  }

  modeChanged(mode: AppStateData['mode']): void {
    if (mode !== 'tasks') {
      this.cancelPending();
      this.close(false);
    } else if (this.#compactRightCollapsed && this.#options.hasSelectedTask()) {
      this.open('right', false);
    }
  }

  selectionChanged(hasSelection: boolean): void {
    if (hasSelection) this.open('right', false);
    if (!hasSelection && this.#compactPaneOpen === 'right') this.close(false);
  }

  cancelPending(): void {
    this.#pendingCompactPane = undefined;
  }

  takePending(): PendingCompactPane | undefined {
    const pending = this.#pendingCompactPane;
    this.#pendingCompactPane = undefined;
    return pending;
  }

  reset(): void {
    this.#compactPaneCleanup?.();
    this.#compactPaneCleanup = undefined;
    this.#compactHeaderResizeObserver?.disconnect();
    this.#compactHeaderResizeObserver = undefined;
    this.#compactPaneRefresh = undefined;
    this.close(false);
    this.#compactPaneElements?.leftButton.removeClass('is-compact-available');
    this.#compactPaneElements?.rightButton.removeClass('is-compact-available');
    this.#compactPaneElements = undefined;
    this.#compactLeftCollapsed = false;
    this.#compactRightCollapsed = false;
    this.#pendingCompactPane = undefined;
  }

  mount(elements: CompactPaneAccessElements): void {
    configureCompactPaneElements(elements);
    this.#compactPaneElements = elements;
    const { layout, leftButton, rightButton } = elements;
    const toggleLeft = (): void => {
      this.#toggleCompactPane('left');
    };
    const toggleRight = (): void => {
      this.#toggleCompactPane('right');
    };
    const ownerDocument = elements.layout.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const updateCompactWidth = (width?: number): void => {
      const measuredWidth = width ?? layout.getBoundingClientRect().width;
      this.#updateCompactPaneAvailability(
        measuredWidth > 0 && Number.isFinite(measuredWidth) ? measuredWidth : Infinity,
        ownerWindow,
      );
    };
    const onWindowResize = (): void => {
      updateCompactWidth();
    };
    this.#compactPaneRefresh = onWindowResize;
    const onKeyDown = (event: KeyboardEvent): void => {
      this.#handleCompactEscape(event, ownerDocument);
    };
    const onPointerDown = (event: PointerEvent): void => {
      this.#handleCompactOutsidePointer(event);
    };
    leftButton.addEventListener('click', toggleLeft);
    rightButton.addEventListener('click', toggleRight);
    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    ownerWindow?.addEventListener('resize', onWindowResize);
    const resizeObserver = this.#createCompactResizeObserver(
      layout,
      ownerWindow,
      updateCompactWidth,
    );
    resizeObserver?.observe(layout);
    updateCompactWidth();
    this.#compactPaneCleanup = () => {
      leftButton.removeEventListener('click', toggleLeft);
      rightButton.removeEventListener('click', toggleRight);
      ownerDocument.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
      ownerWindow?.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      if (this.#compactPaneRefresh === onWindowResize) this.#compactPaneRefresh = undefined;
    };
  }

  #observeCompactHeader(header: HTMLElement): void {
    this.#compactHeaderResizeObserver?.disconnect();
    const ownerWindow = header.ownerDocument.defaultView;
    const update = (): void => {
      const height = header.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) {
        this.#compactPaneElements?.layout.style.setProperty(
          '--abyss-compact-overlay-top',
          `${String(height)}px`,
        );
      }
    };
    const candidate: unknown =
      ownerWindow == null ? undefined : Reflect.get(ownerWindow, 'ResizeObserver');
    if (isResizeObserverConstructor(candidate)) {
      this.#compactHeaderResizeObserver = new candidate(update);
      this.#compactHeaderResizeObserver.observe(header);
    }
    update();
  }

  #createCompactResizeObserver(
    layout: HTMLElement,
    ownerWindow: Window | null,
    updateWidth: (width?: number) => void,
  ): ResizeObserver | null {
    const candidate: unknown =
      ownerWindow == null ? undefined : Reflect.get(ownerWindow, 'ResizeObserver');
    if (!isResizeObserverConstructor(candidate)) return null;
    return new candidate((entries) => {
      const entry = entries.find((candidate) => candidate.target === layout);
      updateWidth(entry?.contentRect.width);
    });
  }

  #handleCompactEscape(event: KeyboardEvent, ownerDocument: Document): void {
    const pane = this.#compactPaneOpen;
    if (
      event.key !== 'Escape' ||
      isImeOwnedEvent(event) ||
      event.defaultPrevented ||
      pane === null ||
      !this.#isCompactPaneCollapsed(pane) ||
      !this.#options.allowsPaneInteraction() ||
      nativeInteractionBlocksPanelShortcuts(ownerDocument)
    ) {
      return;
    }
    event.preventDefault();
    this.close(true);
  }

  #handleCompactOutsidePointer(event: PointerEvent): void {
    const elements = this.#compactPaneElements;
    const pane = this.#compactPaneOpen;
    if (
      elements == null ||
      pane === null ||
      !this.#isCompactPaneCollapsed(pane) ||
      !this.#options.allowsPaneInteraction()
    ) {
      return;
    }
    const path = event.composedPath();
    if (this.#preservesExplicitDetails(path, elements.layout)) return;
    const activePane = pane === 'left' ? elements.left : elements.right;
    if (
      path.includes(activePane) ||
      path.includes(elements.leftButton) ||
      path.includes(elements.rightButton)
    ) {
      return;
    }
    this.close(false);
  }

  #preservesExplicitDetails(path: EventTarget[], layout: HTMLElement): boolean {
    return (
      this.#compactPaneOpen === 'right' &&
      this.#compactPaneOpenReason === 'button' &&
      !path.includes(layout)
    );
  }

  #toggleCompactPane(pane: CompactPane): void {
    if (this.#compactPaneOpen === pane) {
      this.close(true);
      return;
    }
    this.open(pane, true, 'button');
  }

  open(pane: CompactPane, moveFocus: boolean, reason: CompactPaneOpenReason = 'automatic'): void {
    const elements = this.#compactPaneElements;
    if (
      elements == null ||
      !this.#isCompactPaneCollapsed(pane) ||
      this.#options.mode() !== 'tasks'
    ) {
      return;
    }
    const quickCapture = this.#options.captureState();
    if (quickCapture != null && quickCapture.phase !== 'closed') {
      if (quickCapture.isSubmitting) this.#pendingCompactPane = { pane, moveFocus, reason };
      return;
    }
    this.#showCompactPane(elements, pane, moveFocus, reason);
  }

  #showCompactPane(
    elements: CompactPaneAccessElements,
    pane: CompactPane,
    moveFocus: boolean,
    reason: CompactPaneOpenReason,
  ): void {
    const activePane = pane === 'left' ? elements.left : elements.right;
    const inactivePane = pane === 'left' ? elements.right : elements.left;
    activePane.addClass('is-compact-open');
    inactivePane.removeClass('is-compact-open');
    this.#setCompactPaneButtonState(elements.leftButton, 'task lists', pane === 'left');
    this.#setCompactPaneButtonState(elements.rightButton, 'task details', pane === 'right');
    if (this.#compactPaneOpen !== pane || reason === 'button') this.#compactPaneOpenReason = reason;
    this.#compactPaneOpen = pane;
    if (moveFocus) activePane.focus({ preventScroll: true });
  }

  schedule(pending: PendingCompactPane): void {
    void Promise.resolve().then(
      () => {
        this.open(pending.pane, pending.moveFocus, pending.reason);
      },
      () => undefined,
    );
  }

  close(restoreFocus: boolean): void {
    const elements = this.#compactPaneElements;
    const pane = this.#compactPaneOpen;
    this.#compactPaneOpen = null;
    this.#compactPaneOpenReason = undefined;
    if (elements == null) return;
    elements.left.removeClass('is-compact-open');
    elements.right.removeClass('is-compact-open');
    this.#setCompactPaneButtonState(elements.leftButton, 'task lists', false);
    this.#setCompactPaneButtonState(elements.rightButton, 'task details', false);
    if (restoreFocus && pane !== null) {
      const button = pane === 'left' ? elements.leftButton : elements.rightButton;
      if (button.isConnected) button.focus({ preventScroll: true });
    }
  }

  #setCompactPaneButtonState(button: HTMLButtonElement, label: string, expanded: boolean): void {
    const action = expanded ? 'Hide' : 'Show';
    const description = `${action} ${label}`;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.setAttribute('aria-label', description);
  }

  #updateCompactPaneAvailability(width: number, ownerWindow: Window | null): void {
    const rem = this.#rootFontSize(ownerWindow);
    const wasRightCollapsed = this.#compactRightCollapsed;
    this.#compactRightCollapsed = width <= COMPACT_RIGHT_MAX_REM * rem;
    this.#compactLeftCollapsed = width <= COMPACT_LEFT_MAX_REM * rem;
    this.#syncButtonAvailability();
    this.#discardExpandedPendingPane();
    this.#closeExpandedCompactPane();
    this.#openNewlyCollapsedTaskDetails(wasRightCollapsed);
  }

  #syncButtonAvailability(): void {
    this.#compactPaneElements?.leftButton.toggleClass(
      'is-compact-available',
      this.#compactLeftCollapsed,
    );
    this.#compactPaneElements?.rightButton.toggleClass(
      'is-compact-available',
      this.#compactRightCollapsed,
    );
  }

  #rootFontSize(ownerWindow: Window | null): number {
    const documentElement = this.#compactPaneElements?.layout.ownerDocument.documentElement;
    const value = Number.parseFloat(
      documentElement === undefined
        ? ''
        : (ownerWindow?.getComputedStyle(documentElement).fontSize ?? ''),
    );
    return Number.isFinite(value) && value > 0 ? value : 16;
  }

  #discardExpandedPendingPane(): void {
    const pending = this.#pendingCompactPane;
    if (pending != null && !this.#isCompactPaneCollapsed(pending.pane)) {
      this.#pendingCompactPane = undefined;
    }
  }

  #closeExpandedCompactPane(): void {
    const pane = this.#compactPaneOpen;
    if (pane !== null && !this.#isCompactPaneCollapsed(pane)) this.close(false);
  }

  #openNewlyCollapsedTaskDetails(wasRightCollapsed: boolean): void {
    if (
      !wasRightCollapsed &&
      this.#compactRightCollapsed &&
      this.#options.mode() === 'tasks' &&
      this.#options.hasSelectedTask()
    ) {
      this.open('right', false);
    }
  }

  #isCompactPaneCollapsed(pane: CompactPane): boolean {
    return pane === 'left' ? this.#compactLeftCollapsed : this.#compactRightCollapsed;
  }
}
