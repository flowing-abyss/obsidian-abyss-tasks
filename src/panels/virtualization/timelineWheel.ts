import { isRealmHTMLElement } from '../../ui/domRealm';
import { isLargeScrollStep } from './verticalScrollIntent';

function ownsWheelAxis(overflow: string, overscroll: string, canMove: () => boolean): boolean {
  if (!['auto', 'scroll', 'hidden'].includes(overflow)) return false;
  if (overscroll === 'contain' || overscroll === 'none') return true;
  return overflow !== 'hidden' && canMove();
}

function consumesWheel(node: HTMLElement, event: WheelEvent): boolean {
  if (node.matches('select, input[type="number"], input[type="range"]')) return true;
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  if (style === undefined) return false;
  if (
    ownsWheelAxis(style.overflowY, style.overscrollBehaviorY, () =>
      event.deltaY < 0
        ? node.scrollTop > 0
        : node.scrollTop < node.scrollHeight - node.clientHeight,
    )
  )
    return true;
  return (
    event.deltaX !== 0 &&
    ownsWheelAxis(style.overflowX, style.overscrollBehaviorX, () => {
      const extent = node.scrollWidth - node.clientWidth;
      const position = style.direction === 'rtl' ? extent + node.scrollLeft : node.scrollLeft;
      return event.deltaX < 0 ? position > 0 : position < extent;
    })
  );
}

function hasNestedScroller(event: WheelEvent, scroll: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === scroll) break;
    if (isRealmHTMLElement(node) && consumesWheel(node, event)) return true;
  }
  return false;
}

function isVerticalWheel(event: WheelEvent): boolean {
  return (
    event.cancelable &&
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    Math.abs(event.deltaY) > Math.abs(event.deltaX)
  );
}

function wheelUnit(scroll: HTMLElement, event: WheelEvent): number {
  const mode = event.deltaMode;
  if (mode === 0) return 1;
  if (event.deltaX !== 0) return NaN;
  if (mode === 2) return scroll.clientHeight;
  const style = scroll.ownerDocument.defaultView?.getComputedStyle(scroll);
  return Number.parseFloat(style?.lineHeight ?? '');
}

/** Keep fast wheel steps on the same frame as the canonical Timeline cards. */
export function bindTimelineWheel(
  scroll: HTMLElement,
  canPublish: () => boolean,
  moved: () => void,
): () => void {
  const wheel = (event: WheelEvent): void => {
    if (!isVerticalWheel(event)) return;
    const unit = wheelUnit(scroll, event);
    const dy = event.deltaY * unit;
    if (!Number.isFinite(dy) || !isLargeScrollStep(dy, scroll.clientHeight)) return;
    const top = scroll.scrollTop;
    const next = Math.max(0, Math.min(top + dy, scroll.scrollHeight - scroll.clientHeight));
    if (top === next || !canPublish() || hasNestedScroller(event, scroll)) return;
    event.preventDefault();
    scroll.scrollTop = next;
    if (event.deltaX !== 0) scroll.scrollLeft += event.deltaX * unit;
    moved();
  };
  scroll.addEventListener('wheel', wheel, { passive: false });
  return () => {
    scroll.removeEventListener('wheel', wheel);
  };
}
