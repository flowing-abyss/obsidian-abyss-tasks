import { anchoredPlacement, type AnchoredPlacementInput } from './anchoredPlacement';

export interface AnchoredPopoverOptions {
  /** The positioned surface the popover is placed in, as the date picker uses. */
  readonly owner: HTMLElement;
  readonly anchor: HTMLElement;
  readonly boundary: HTMLElement;
  readonly preferred: AnchoredPlacementInput['preferred'];
  /** Classes beyond the shared `abyss-popover abyss-popover-anchored` pair. */
  readonly cls: string;
  readonly attr?: Record<string, string>;
  /** Called once, after the element has left the document. */
  readonly onClose: (restoreFocus: boolean) => void;
}

export interface AnchoredPopover {
  readonly element: HTMLElement;
  /** Re-measures the room inside the boundary and places the surface again. Idempotent. */
  reposition(): void;
  /** Idempotent. Without an argument, focus returns only if it was inside the popover. */
  close(restoreFocus?: boolean): void;
}

interface PopoverState {
  readonly options: AnchoredPopoverOptions;
  readonly element: HTMLElement;
  closed: boolean;
  release: () => void;
}

const GAP = 4;
const EDGE_GAP = 8;

function setLength(element: HTMLElement, property: string, value: number): void {
  element.style.setProperty(`--abyss-pop-${property}`, `${Math.max(0, value)}px`);
}

/**
 * The room the surface has inside the boundary, which is what gives its list its own scroll.
 *
 * A surface that opens out of the side of its anchor has the whole height to use and only the
 * width past the anchor; one that opens under or over its anchor has the whole width and whichever
 * of the two bands around the anchor is taller.
 */
function fitToBoundary(state: PopoverState, boundary: DOMRect, anchor: DOMRect): void {
  const { element } = state;
  if (state.options.preferred === 'right-end') {
    setLength(element, 'width', boundary.right - anchor.right - GAP - EDGE_GAP);
    setLength(element, 'height', boundary.height - 2 * EDGE_GAP);
    return;
  }
  setLength(element, 'width', boundary.width - 2 * EDGE_GAP);
  setLength(
    element,
    'height',
    Math.min(
      boundary.height - 2 * EDGE_GAP,
      Math.max(
        anchor.top - boundary.top - EDGE_GAP - GAP,
        boundary.bottom - EDGE_GAP - anchor.bottom - GAP,
      ),
    ),
  );
}

function place(state: PopoverState): void {
  const { element } = state;
  if (state.closed || !element.isConnected) return;
  const boundary = state.options.boundary.getBoundingClientRect();
  const anchor = state.options.anchor.getBoundingClientRect();
  fitToBoundary(state, boundary, anchor);
  const floating = element.getBoundingClientRect();
  const placement = anchoredPlacement({
    anchor,
    boundary,
    floating: {
      width: floating.width !== 0 ? floating.width : element.offsetWidth,
      height: floating.height !== 0 ? floating.height : element.offsetHeight,
    },
    gap: GAP,
    edgeGap: EDGE_GAP,
    preferred: state.options.preferred,
  });
  // The placement is in viewport space, so it is read back into the padding box of whichever
  // ancestor actually positions the popover.
  const block = (element.offsetParent as HTMLElement | null) ?? state.options.boundary;
  const rect = block.getBoundingClientRect();
  setLength(element, 'top', placement.top - rect.top - block.clientTop + block.scrollTop);
  setLength(element, 'left', placement.left - rect.left - block.clientLeft + block.scrollLeft);
  element.dataset['side'] = placement.side;
}

function close(state: PopoverState, restoreFocus?: boolean): void {
  if (state.closed) return;
  const { element } = state;
  const focused = restoreFocus ?? element.contains(element.ownerDocument.activeElement);
  state.closed = true;
  state.release();
  element.remove();
  state.options.onClose(focused);
}

function listen(state: PopoverState): () => void {
  const { element } = state;
  const ownerDocument = element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const reposition = (): void => {
    place(state);
  };
  const outside = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof Node) ||
      element.contains(target) ||
      state.options.anchor.contains(target)
    )
      return;
    close(state, false);
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(state, true);
  };
  ownerDocument.addEventListener('pointerdown', outside, true);
  ownerDocument.addEventListener('focusin', outside, true);
  ownerDocument.addEventListener('keydown', keydown, true);
  ownerDocument.addEventListener('scroll', reposition, true);
  ownerWindow?.addEventListener('resize', reposition);
  return () => {
    ownerDocument.removeEventListener('pointerdown', outside, true);
    ownerDocument.removeEventListener('focusin', outside, true);
    ownerDocument.removeEventListener('keydown', keydown, true);
    ownerDocument.removeEventListener('scroll', reposition, true);
    ownerWindow?.removeEventListener('resize', reposition);
  };
}

/**
 * The shell every anchored list popover shares: the element, where it sits, and when it goes away.
 *
 * It owns the placement against the boundary, the `--abyss-pop-*` lengths the stylesheet reads, and
 * the four ways a popover is dismissed. What goes inside it, and what a rebuild has to preserve, is
 * the caller's business.
 */
export function openAnchoredPopover(options: AnchoredPopoverOptions): AnchoredPopover {
  const state: PopoverState = {
    options,
    element: options.owner.createDiv({
      cls: `abyss-popover abyss-popover-anchored ${options.cls}`,
      // Focusable but out of the tab order, so the surface itself can hold the keyboard while its
      // own controls stay the only Tab stops inside it.
      attr: { tabindex: '-1', ...options.attr },
    }),
    closed: false,
    release: () => {},
  };
  state.release = listen(state);
  // The keyboard follows the surface it opened, so the next Tab reaches the list rather than
  // whatever sits after the anchor, which the outside-focus guard would read as a dismissal.
  state.element.focus({ preventScroll: true });
  return {
    element: state.element,
    reposition: () => {
      place(state);
    },
    close: (restoreFocus?: boolean) => {
      close(state, restoreFocus);
    },
  };
}
