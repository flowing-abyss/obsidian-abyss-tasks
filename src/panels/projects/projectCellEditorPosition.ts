import { anchoredPlacement } from '../../ui/anchoredPlacement';

interface ProjectCellEditorPositionOptions {
  readonly anchor: HTMLElement;
  readonly host: HTMLElement;
  readonly boundary: HTMLElement;
  readonly stickyHeader?: HTMLElement;
}

function visibleBoundary(options: ProjectCellEditorPositionOptions): DOMRect {
  const boundary = options.boundary.getBoundingClientRect();
  const stickyBottom = options.stickyHeader?.getBoundingClientRect().bottom ?? boundary.top;
  const top = Math.min(boundary.bottom, Math.max(boundary.top, stickyBottom));
  return {
    left: boundary.left,
    right: boundary.right,
    top,
    bottom: boundary.bottom,
    width: boundary.width,
    height: Math.max(0, boundary.bottom - top),
  } as DOMRect;
}

function measured(element: HTMLElement, dimension: 'width' | 'height'): number {
  const rect = element.getBoundingClientRect()[dimension];
  if (rect > 0) return rect;
  return dimension === 'width' ? element.offsetWidth : element.offsetHeight;
}

function positionEditor(options: ProjectCellEditorPositionOptions): void {
  const { anchor, host } = options;
  if (!anchor.isConnected || !host.isConnected) return;
  const boundary = visibleBoundary(options);
  const anchorRect = anchor.getBoundingClientRect();
  const edgeGap = 8;
  const maxWidth = Math.max(0, boundary.width - edgeGap * 2);
  const width = Math.min(Math.max(anchorRect.width - 8, 150), maxWidth);
  const maxHeight = Math.max(0, boundary.height - edgeGap * 2);
  host.style.width = `${width}px`;
  host.style.maxHeight = `${maxHeight}px`;
  const values = host.querySelector<HTMLElement>('.abyss-project-list-values');
  if (values !== null) {
    const chromeHeight = Math.max(0, measured(host, 'height') - measured(values, 'height'));
    host.style.setProperty(
      '--abyss-project-editor-values-max-height',
      `${Math.max(0, maxHeight - chromeHeight)}px`,
    );
  }
  const placement = anchoredPlacement({
    anchor: anchorRect,
    floating: { width, height: Math.min(measured(host, 'height'), maxHeight) },
    boundary,
    gap: 4,
    edgeGap,
    preferred: 'below-start',
  });
  host.style.left = `${placement.left - anchorRect.left - anchor.clientLeft + anchor.scrollLeft}px`;
  host.style.top = `${placement.top - anchorRect.top - anchor.clientTop + anchor.scrollTop}px`;
  host.dataset['side'] = placement.side;
}

export function mountProjectCellEditorPosition(
  options: ProjectCellEditorPositionOptions,
): () => void {
  const ownerDocument = options.host.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const position = (): void => {
    positionEditor(options);
  };
  position();
  ownerDocument.addEventListener('scroll', position, true);
  ownerWindow?.addEventListener('resize', position);
  const ResizeObserverClass = ownerWindow?.ResizeObserver;
  const resizeObserver =
    typeof ResizeObserverClass === 'function' ? new ResizeObserverClass(position) : undefined;
  for (const target of [options.host, options.anchor, options.boundary, options.stickyHeader]) {
    if (target !== undefined) resizeObserver?.observe(target);
  }
  const MutationObserverClass = ownerWindow?.MutationObserver;
  const mutationObserver =
    typeof MutationObserverClass === 'function' ? new MutationObserverClass(position) : undefined;
  mutationObserver?.observe(options.host, { childList: true, characterData: true, subtree: true });
  return () => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    ownerDocument.removeEventListener('scroll', position, true);
    ownerWindow?.removeEventListener('resize', position);
  };
}
