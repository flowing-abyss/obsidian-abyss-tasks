interface ProjectCellEditorPositionOptions {
  readonly anchor: HTMLElement;
  readonly host: HTMLElement;
  readonly boundary: HTMLElement;
  readonly stickyHeader?: HTMLElement;
  readonly onMove?: () => void;
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

function positionEditor(options: ProjectCellEditorPositionOptions): string | undefined {
  const { anchor, host } = options;
  if (!anchor.isConnected || !host.isConnected) return undefined;
  const boundary = visibleBoundary(options);
  const anchorRect = anchor.getBoundingClientRect();
  const edgeGap = 8;
  const maxWidth = Math.max(0, boundary.width - edgeGap * 2);
  const width = Math.min(anchorRect.width, maxWidth);
  const maxHeight = Math.max(0, boundary.height - edgeGap * 2);
  host.style.width = `${width}px`;
  host.style.maxHeight = `${maxHeight}px`;
  host.style.setProperty('--abyss-project-editor-content-max-height', `${maxHeight}px`);
  const measured = host.getBoundingClientRect().height;
  const measuredHeight = measured > 0 ? measured : host.offsetHeight;
  const height = Math.min(measuredHeight, maxHeight);
  const left = clamp(anchorRect.left, boundary.left + edgeGap, boundary.right - edgeGap - width);
  const top = clamp(anchorRect.top, boundary.top + edgeGap, boundary.bottom - edgeGap - height);
  host.style.left = `${left - anchorRect.left - anchor.clientLeft + anchor.scrollLeft}px`;
  host.style.top = `${top - anchorRect.top - anchor.clientTop + anchor.scrollTop}px`;
  host.dataset['side'] = 'aligned';
  const input = host.querySelector<HTMLElement>('.abyss-project-editor-input');
  const inputRect = input?.getBoundingClientRect();
  return `${left}:${top}:${width}:${height}:${inputRect?.left}:${inputRect?.top}:${inputRect?.width}`;
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
