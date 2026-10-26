import { anchoredPlacement } from '../../ui/anchoredPlacement';

interface ProjectCellEditorPositionOptions {
  readonly anchor: HTMLElement;
  readonly host: HTMLElement;
  readonly boundary: HTMLElement;
  readonly stickyHeader?: HTMLElement;
  readonly avoid?: HTMLElement;
  readonly positioningContainer?: HTMLElement;
  readonly preferredWidth?: number;
  readonly onMove?: () => void;
  readonly placement?: 'below';
  /** Retained menu rows can move the anchor without changing the anchor's own size. */
  readonly layoutElements?: readonly Element[];
}

function visibleBoundary(options: ProjectCellEditorPositionOptions): DOMRect {
  const borderBox = options.boundary.getBoundingClientRect();
  const left = borderBox.left + options.boundary.clientLeft;
  const boundaryTop = borderBox.top + options.boundary.clientTop;
  const right = left + options.boundary.clientWidth;
  const bottom = boundaryTop + options.boundary.clientHeight;
  const stickyBottom = options.stickyHeader?.getBoundingClientRect().bottom ?? boundaryTop;
  const top = Math.min(bottom, Math.max(boundaryTop, stickyBottom));
  return {
    left,
    right,
    top,
    bottom,
    width: options.boundary.clientWidth,
    height: Math.max(0, bottom - top),
  } as DOMRect;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function editorWidth(options: ProjectCellEditorPositionOptions, maximum: number): number {
  return Math.min(options.preferredWidth ?? options.anchor.getBoundingClientRect().width, maximum);
}

function verticalPosition(
  anchor: DOMRect,
  boundary: DOMRect,
  height: number,
  avoidTop: number | undefined,
): readonly [number, 'aligned' | 'above'] {
  const edgeGap = 8;
  const aligned = clamp(anchor.top, boundary.top + edgeGap, boundary.bottom - edgeGap - height);
  if (avoidTop === undefined || anchor.top + height <= boundary.bottom - edgeGap)
    return [aligned, 'aligned'];
  const above = avoidTop - height;
  return above >= boundary.top + edgeGap && above + height <= boundary.bottom - edgeGap
    ? [above, 'above']
    : [aligned, 'aligned'];
}

function positionEditor(options: ProjectCellEditorPositionOptions): string | undefined {
  const { anchor, host } = options;
  if (!anchor.isConnected || !host.isConnected) return undefined;
  const boundary = visibleBoundary(options);
  const anchorRect = anchor.getBoundingClientRect();
  const edgeGap = 8;
  const maxWidth = Math.max(0, boundary.width - edgeGap * 2);
  const width = editorWidth(options, maxWidth);
  const maxHeight = Math.max(0, boundary.height - edgeGap * 2);
  host.style.width = `${width}px`;
  host.style.maxHeight = `${maxHeight}px`;
  host.style.setProperty('--abyss-project-editor-content-max-height', `${maxHeight}px`);
  const measured = host.getBoundingClientRect().height;
  const measuredHeight = measured > 0 ? measured : host.offsetHeight;
  const height = Math.min(measuredHeight, maxHeight);
  const left = clamp(anchorRect.left, boundary.left + edgeGap, boundary.right - edgeGap - width);
  const [top, side] = editorVerticalPosition(options, anchorRect, boundary, { width, height });
  const positioningContainer = options.positioningContainer ?? anchor;
  const positioningRect = positioningContainer.getBoundingClientRect();
  host.style.left = `${left - positioningRect.left - positioningContainer.clientLeft + positioningContainer.scrollLeft}px`;
  host.style.top = `${top - positioningRect.top - positioningContainer.clientTop + positioningContainer.scrollTop}px`;
  host.dataset['side'] = side;
  const input = host.querySelector<HTMLElement>('.abyss-project-editor-input');
  const inputRect = input?.getBoundingClientRect();
  return `${left}:${top}:${width}:${height}:${inputRect?.left}:${inputRect?.top}:${inputRect?.width}`;
}

function editorVerticalPosition(
  options: ProjectCellEditorPositionOptions,
  anchor: DOMRect,
  boundary: DOMRect,
  floating: { readonly width: number; readonly height: number },
): readonly [number, string] {
  if (options.placement !== 'below')
    return verticalPosition(
      anchor,
      boundary,
      floating.height,
      options.avoid?.getBoundingClientRect().top,
    );
  const placed = anchoredPlacement({
    anchor,
    boundary,
    floating,
    gap: 4,
    edgeGap: 8,
    preferred: 'below-start',
  });
  return [placed.top, placed.side];
}

function observeEditorLayout(
  resizeObserver: ResizeObserver | undefined,
  options: ProjectCellEditorPositionOptions,
): void {
  for (const target of [
    options.host,
    options.anchor,
    options.boundary,
    options.stickyHeader,
    options.avoid,
    options.positioningContainer,
    ...(options.layoutElements ?? []),
  ]) {
    if (target !== undefined) resizeObserver?.observe(target);
  }
}

export function mountProjectCellEditorPosition(
  options: ProjectCellEditorPositionOptions,
): () => void {
  const ownerDocument = options.host.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let geometry: string | undefined;
  const position = (): void => {
    const next = positionEditor(options);
    if (geometry !== undefined && next !== undefined && geometry !== next) options.onMove?.();
    geometry = next;
  };
  position();
  ownerDocument.addEventListener('scroll', position, true);
  ownerWindow?.addEventListener('resize', position);
  const ResizeObserverClass = ownerWindow?.ResizeObserver;
  const resizeObserver =
    typeof ResizeObserverClass === 'function' ? new ResizeObserverClass(position) : undefined;
  observeEditorLayout(resizeObserver, options);
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
