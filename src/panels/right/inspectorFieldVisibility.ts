import { Platform } from 'obsidian';
import { isRealmHTMLElement } from '../../ui/domRealm';
import { textFieldAnchor, textFieldViewport } from '../../ui/textFieldAnchor';

const EDITORS = [
  '.abyss-right-title-edit',
  '.abyss-right-desc-edit',
  '.abyss-subtask-new-input',
  '.abyss-comment-input',
  '.abyss-comment-edit-input',
].join(',');

/** Follow the host's available space, without moving its page or taking over editing. */
export function mountInspectorFieldVisibility(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!Platform.isMobile || win === null) return () => {};
  const containers = inspectorScrollContainers(root);
  let disposed = false;
  let frame: number | undefined;
  const reveal = (): void => {
    frame = undefined;
    if (disposed || root.ownerDocument !== doc || !root.isConnected) return;
    const field = doc.activeElement;
    if (!isEditor(field) || !root.contains(field)) return;
    const viewport = textFieldViewport(field, containers);
    const style = win.getComputedStyle(root);
    const gaps = { top: pixels(style.scrollPaddingTop), bottom: pixels(style.scrollPaddingBottom) };
    for (const container of containers) {
      if (scrolls(win.getComputedStyle(container).overflowY))
        revealInContainer(container, field, viewport, gaps);
    }
  };
  const schedule = (): void => {
    if (!disposed && frame === undefined && root.contains(doc.activeElement))
      frame = win.requestAnimationFrame(reveal);
  };
  const cleanup: Array<() => void> = [];
  const listen = (target: EventTarget, event: string): void => {
    target.addEventListener(event, schedule);
    cleanup.push(() => {
      target.removeEventListener(event, schedule);
    });
  };
  listen(root, 'focusin');
  listen(root, 'input');
  listen(doc, 'selectionchange');
  listen(win, 'resize');
  listen(win, 'keyboardWillShow');
  listen(win, 'keyboardDidShow');
  const viewport = win.visualViewport;
  if (viewport != null) {
    listen(viewport, 'resize');
    listen(viewport, 'scroll');
  }
  const observer =
    typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : undefined;
  containers.forEach((container) => {
    observer?.observe(container);
  });
  schedule();
  return () => {
    disposed = true;
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    observer?.disconnect();
    cleanup.forEach((dispose) => {
      dispose();
    });
  };
}

function revealInContainer(
  container: HTMLElement,
  field: HTMLInputElement | HTMLTextAreaElement,
  viewport: DOMRect,
  gaps: { readonly top: number; readonly bottom: number },
): void {
  const maximum = container.scrollHeight - container.clientHeight;
  if (maximum <= 0) return;
  const bounds = container.getBoundingClientRect();
  const top = Math.max(bounds.top + container.clientTop, viewport.top) + gaps.top;
  const bottom =
    Math.min(bounds.top + container.clientTop + container.clientHeight, viewport.bottom) -
    gaps.bottom;
  if (bottom <= top) return;
  const fieldBounds = field.getBoundingClientRect();
  if (fieldBounds.height <= 0 || fieldBounds.width <= 0) return;
  // A long editor cannot fit in the remaining space. Keep its active line visible instead.
  const caret = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
  const target =
    fieldBounds.height <= bottom - top
      ? fieldBounds
      : textFieldAnchor(field, caret ?? field.value.length);
  const delta = target.bottom > bottom ? target.bottom - bottom : Math.min(0, target.top - top);
  if (Math.abs(delta) >= 1)
    container.scrollTop = Math.max(0, Math.min(maximum, container.scrollTop + delta));
}

export function inspectorScrollContainers(root: HTMLElement): HTMLElement[] {
  const containers = [root];
  const modal = root.closest('.abyss-modal');
  if (modal !== null) {
    for (let parent = root.parentElement; parent !== null; parent = parent.parentElement) {
      containers.push(parent);
      if (parent === modal) break;
    }
  }
  return containers;
}

function isEditor(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    isRealmHTMLElement(element) &&
    element.matches(EDITORS) &&
    (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')
  );
}

function scrolls(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll';
}

function pixels(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
