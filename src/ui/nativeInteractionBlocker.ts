const NATIVE_INTERACTION_SELECTOR = '.menu, .modal-container, .suggestion-container';

function hasPositiveArea(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function hasPositiveClientRect(element: HTMLElement): boolean {
  const rects = element.getClientRects();
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (rect != null && hasPositiveArea(rect)) return true;
  }
  return false;
}

function intersectsViewport(rect: DOMRect, ownerWindow: Window): boolean {
  const width = ownerWindow.innerWidth;
  const height = ownerWindow.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
}

function elementIsHidden(element: HTMLElement): boolean {
  return element.hidden || element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
}

function styleIsHidden(style: CSSStyleDeclaration | undefined): boolean {
  return (
    style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
  );
}

function surfaceHierarchyIsVisible(surface: HTMLElement, ownerWindow: Window | null): boolean {
  let current: HTMLElement | null = surface;
  while (current != null) {
    if (elementIsHidden(current) || styleIsHidden(ownerWindow?.getComputedStyle(current)))
      return false;
    current = current.parentElement;
  }
  return true;
}

function isPresentedNativeSurface(surface: HTMLElement, ownerWindow: Window | null): boolean {
  if (!surface.isConnected || !surfaceHierarchyIsVisible(surface, ownerWindow)) return false;

  const bounds = surface.getBoundingClientRect();
  if (!hasPositiveArea(bounds) || !hasPositiveClientRect(surface)) return false;
  return ownerWindow === null || intersectsViewport(bounds, ownerWindow);
}

/** Keeps Obsidian-owned surface selectors out of the generic shortcut router. */
export function nativeInteractionBlocksPanelShortcuts(ownerDocument: Document): boolean {
  const ownerWindow = ownerDocument.defaultView;
  return [...ownerDocument.querySelectorAll<HTMLElement>(NATIVE_INTERACTION_SELECTOR)].some(
    (surface) => isPresentedNativeSurface(surface, ownerWindow),
  );
}
