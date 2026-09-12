import type { ProjectTableGroup } from '../../projects/projectTableModel';
import type {
  ProjectKanbanDropPlan,
  ProjectKanbanDropSource,
  ProjectKanbanDropTarget,
} from './projectKanbanDrop';

const PROJECT_KANBAN_DRAG_TYPE = 'application/x-abyss-project-kanban-card';

export interface ProjectKanbanDragAdapter {
  readonly begin: () => () => void;
  readonly capture: (card: HTMLElement) => ProjectKanbanDropSource;
  readonly preview: (
    source: ProjectKanbanDropSource,
    target: ProjectKanbanDropTarget,
  ) => ProjectKanbanDropPlan;
  readonly commit: (
    source: ProjectKanbanDropSource,
    target: ProjectKanbanDropTarget,
  ) => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

interface ActiveDrag {
  readonly card: HTMLElement;
  readonly source: ProjectKanbanDropSource;
  readonly image?: HTMLElement;
  readonly release: () => void;
}

interface ProvisionalGesture {
  readonly card: HTMLElement;
  readonly origin: EventTarget | null;
  readonly pointerId: number;
}

interface ActivePreview {
  readonly elements: readonly HTMLElement[];
  readonly line?: HTMLElement;
}

type AllowedDropPlan = Extract<ProjectKanbanDropPlan, { allowed: true }>;

function protectedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(
    'a, button, input, textarea, select, [contenteditable="true"], .abyss-project-cell-editor',
  );
  return control !== null && !control.classList.contains('abyss-project-table-name');
}

function asDataTransfer(event: Event): DataTransfer | undefined {
  return (Reflect.get(event, 'dataTransfer') as DataTransfer | null | undefined) ?? undefined;
}

function elementFromTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function cardFromEvent(event: Event): HTMLElement | null {
  return (
    elementFromTarget(event.target)?.closest<HTMLElement>('.abyss-project-kanban-card') ?? null
  );
}

function validDragStart(event: Event, gesture: ProvisionalGesture): boolean {
  return (
    event.target instanceof Node &&
    (event.target === gesture.card || gesture.card.contains(event.target)) &&
    !protectedTarget(gesture.origin)
  );
}

function validInternalTransfer(event: Event, source: ProjectKanbanDropSource): boolean {
  const transfer = asDataTransfer(event);
  if (transfer?.types.includes(PROJECT_KANBAN_DRAG_TYPE) !== true) return false;
  try {
    const payload = JSON.parse(transfer.getData(PROJECT_KANBAN_DRAG_TYPE)) as unknown;
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Reflect.get(payload, 'path') === source.projectPath
    );
  } catch {
    return false;
  }
}

function nextVisibleCardPath(card: HTMLElement, sourcePath: string): string | undefined {
  const zone =
    card.closest<HTMLElement>('.abyss-project-kanban-group, .abyss-project-kanban-hover-group') ??
    card.closest<HTMLElement>('.abyss-project-kanban-column, .abyss-project-kanban-hover-preview');
  if (zone === null) return undefined;
  const cards = Array.from(
    zone.querySelectorAll<HTMLElement>(
      '.abyss-project-kanban-card, .abyss-project-kanban-hover-card',
    ),
  );
  const index = cards.indexOf(card);
  for (let next = index + 1; next < cards.length; next += 1) {
    const path = cards[next]?.dataset['projectPath'];
    if (path !== undefined && path !== sourcePath) return path;
  }
  return undefined;
}

function targetFromElement(
  element: Element,
  clientY: number,
  sourcePath: string,
): ProjectKanbanDropTarget | undefined {
  const column = element.closest<HTMLElement>(
    '[data-status-key].abyss-project-kanban-column, [data-status-key].abyss-project-kanban-hover-preview',
  );
  if (column === null) return undefined;
  const statusKey = column.dataset['statusKey'];
  if (statusKey === undefined) return undefined;
  const group = element.closest<HTMLElement>(
    '[data-group-key].abyss-project-kanban-group, [data-group-key].abyss-project-kanban-hover-group',
  );
  const card = element.closest<HTMLElement>(
    '[data-project-path].abyss-project-kanban-card, [data-project-path].abyss-project-kanban-hover-card',
  );
  const groupTarget = targetGroup(group);
  let beforePath: string | undefined;
  if (card !== null) {
    const rect = card.getBoundingClientRect();
    beforePath =
      clientY < rect.top + rect.height / 2
        ? card.dataset['projectPath']
        : nextVisibleCardPath(card, sourcePath);
  }
  return {
    status: { key: statusKey, value: column.dataset['statusValue'] ?? null },
    ...(groupTarget === undefined ? {} : { group: groupTarget }),
    ...(beforePath === undefined ? {} : { beforePath }),
  };
}

function targetGroup(
  group: HTMLElement | null,
): NonNullable<ProjectKanbanDropTarget['group']> | undefined {
  const key = group?.dataset['groupKey'];
  if (group === null || key === undefined) return undefined;
  return {
    key,
    value: Reflect.get(group, '__abyssGroupValue'),
    ...(group.dataset['projected'] === 'true' ? { projected: true } : {}),
    ...(group.dataset['sourcePath'] === undefined
      ? {}
      : { sourcePath: group.dataset['sourcePath'] }),
  };
}

function insertionBeforeGroup(host: HTMLElement, plan: AllowedDropPlan): HTMLElement | null {
  const key = plan.insertion.kind === 'none' ? undefined : plan.insertion.beforeGroupKey;
  return key === undefined
    ? null
    : host.querySelector<HTMLElement>(`[data-group-key="${CSS.escape(key)}"]`);
}

function insertionLineTop(
  host: HTMLElement,
  card: HTMLElement | null,
  beforeGroup: HTMLElement | null,
  afterCard: boolean,
): number {
  const hostTop = host.getBoundingClientRect().top;
  const cardRect = card?.getBoundingClientRect();
  if (cardRect !== undefined) {
    return (afterCard ? cardRect.bottom : cardRect.top) - hostTop + host.scrollTop;
  }
  const groupRect = beforeGroup?.getBoundingClientRect();
  return groupRect === undefined ? host.scrollHeight : groupRect.top - hostTop + host.scrollTop;
}

/** Owns the native board drag lifecycle, visual forecast, hover overlay, and scrolling cleanup. */
export class ProjectKanbanDragController {
  private readonly window_abyssPrivate: Window;
  private provisional_abyssPrivate: ProvisionalGesture | undefined;
  private provisionalTabIndex_abyssPrivate: string | null | undefined;
  private active_abyssPrivate: ActiveDrag | undefined;
  private preview_abyssPrivate: ActivePreview | undefined;
  private hoverTimer_abyssPrivate: number | undefined;
  private hoverColumn_abyssPrivate: HTMLElement | undefined;
  private overlay_abyssPrivate: HTMLElement | undefined;
  private frame_abyssPrivate: number | undefined;
  private point_abyssPrivate: { x: number; y: number } | undefined;
  private verticalScroller_abyssPrivate: HTMLElement | undefined;
  private suppressClickPath_abyssPrivate: string | undefined;

  constructor(
    private readonly root_abyssPrivate: HTMLElement,
    private readonly scroll_abyssPrivate: HTMLElement,
    private readonly adapter_abyssPrivate: ProjectKanbanDragAdapter,
  ) {
    this.window_abyssPrivate = root_abyssPrivate.ownerDocument.defaultView ?? window;
    root_abyssPrivate.addEventListener('pointerdown', this.pointerDown_abyssPrivate, true);
    root_abyssPrivate.addEventListener('dragstart', this.dragStart_abyssPrivate);
    root_abyssPrivate.addEventListener('dragover', this.dragOver_abyssPrivate);
    root_abyssPrivate.addEventListener('dragleave', this.dragLeave_abyssPrivate);
    root_abyssPrivate.addEventListener('drop', this.drop_abyssPrivate);
    root_abyssPrivate.addEventListener('dragend', this.dragEnd_abyssPrivate);
    root_abyssPrivate.addEventListener('click', this.click_abyssPrivate, true);
    root_abyssPrivate.ownerDocument.addEventListener('keydown', this.keydown_abyssPrivate, true);
    root_abyssPrivate.ownerDocument.addEventListener(
      'dragover',
      this.documentDragOver_abyssPrivate,
      true,
    );
    this.window_abyssPrivate.addEventListener('blur', this.windowBlur_abyssPrivate);
  }

  destroy(): void {
    this.cleanup_abyssPrivate(false);
    this.root_abyssPrivate.removeEventListener('pointerdown', this.pointerDown_abyssPrivate, true);
    this.root_abyssPrivate.removeEventListener('dragstart', this.dragStart_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragover', this.dragOver_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragleave', this.dragLeave_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('drop', this.drop_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragend', this.dragEnd_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('click', this.click_abyssPrivate, true);
    this.root_abyssPrivate.ownerDocument.removeEventListener(
      'keydown',
      this.keydown_abyssPrivate,
      true,
    );
    this.root_abyssPrivate.ownerDocument.removeEventListener(
      'dragover',
      this.documentDragOver_abyssPrivate,
      true,
    );
    this.window_abyssPrivate.removeEventListener('blur', this.windowBlur_abyssPrivate);
  }

  clearPreview(): void {
    this.clearVisuals_abyssPrivate();
  }

  private readonly pointerDown_abyssPrivate = (event: Event): void => {
    this.releaseProvisional_abyssPrivate();
    this.suppressClickPath_abyssPrivate = undefined;
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    const card = cardFromEvent(event);
    if (card === null || protectedTarget(event.target)) return;
    this.provisional_abyssPrivate = {
      card,
      origin: event.target,
      pointerId: pointer.pointerId,
    };
    this.provisionalTabIndex_abyssPrivate = card.getAttribute('tabindex');
    card.removeAttribute('tabindex');
    card.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    card.addClass('is-drag-armed');
    const ownerDocument = card.ownerDocument;
    ownerDocument.addEventListener('pointerup', this.provisionalPointerEnd_abyssPrivate, true);
    ownerDocument.addEventListener('pointercancel', this.provisionalPointerEnd_abyssPrivate, true);
  };

  private readonly dragStart_abyssPrivate = (event: Event): void => {
    const gesture = this.provisional_abyssPrivate;
    if (gesture === undefined || !validDragStart(event, gesture)) {
      event.preventDefault();
      this.releaseProvisional_abyssPrivate();
      return;
    }
    const card = gesture.card;
    try {
      const transfer = asDataTransfer(event);
      if (transfer === undefined) {
        event.preventDefault();
        this.releaseProvisional_abyssPrivate();
        return;
      }
      this.active_abyssPrivate = this.createActiveDrag_abyssPrivate(card, transfer);
      this.releaseProvisional_abyssPrivate();
    } catch (error) {
      event.preventDefault();
      this.releaseProvisional_abyssPrivate();
      this.adapter_abyssPrivate.reportFailure(error);
    }
  };

  private createActiveDrag_abyssPrivate(card: HTMLElement, transfer: DataTransfer): ActiveDrag {
    let image: HTMLElement | undefined;
    let release: (() => void) | undefined;
    try {
      const source = this.adapter_abyssPrivate.capture(card);
      transfer.setData(PROJECT_KANBAN_DRAG_TYPE, JSON.stringify({ path: source.projectPath }));
      transfer.effectAllowed = 'move';
      image = card.cloneNode(true) as HTMLElement;
      image.className = 'abyss-project-kanban-card abyss-project-kanban-drag-image';
      this.root_abyssPrivate.ownerDocument.body.append(image);
      transfer.setDragImage(image, 18, 18);
      release = this.adapter_abyssPrivate.begin();
      card.addClass('is-dragging');
      return { card, source, image, release };
    } catch (error) {
      card.removeClass('is-dragging');
      image?.remove();
      release?.();
      throw error;
    }
  }

  private readonly provisionalPointerEnd_abyssPrivate = (event: Event): void => {
    if ((event as PointerEvent).pointerId !== this.provisional_abyssPrivate?.pointerId) return;
    this.releaseProvisional_abyssPrivate();
  };

  private readonly windowBlur_abyssPrivate = (): void => {
    this.cleanup_abyssPrivate(false);
  };

  private releaseProvisional_abyssPrivate(): void {
    const provisional = this.provisional_abyssPrivate;
    const tabIndex = this.provisionalTabIndex_abyssPrivate;
    this.provisional_abyssPrivate = undefined;
    this.provisionalTabIndex_abyssPrivate = undefined;
    if (provisional !== undefined) {
      provisional.card.removeClass('is-drag-armed');
      if (tabIndex === null) provisional.card.removeAttribute('tabindex');
      else if (tabIndex !== undefined) provisional.card.setAttribute('tabindex', tabIndex);
    }
    const ownerDocument = this.root_abyssPrivate.ownerDocument;
    ownerDocument.removeEventListener('pointerup', this.provisionalPointerEnd_abyssPrivate, true);
    ownerDocument.removeEventListener(
      'pointercancel',
      this.provisionalPointerEnd_abyssPrivate,
      true,
    );
  }

  private readonly dragOver_abyssPrivate = (event: Event): void => {
    const active = this.active_abyssPrivate;
    if (active === undefined || !(event.target instanceof Element)) return;
    const mouse = event as MouseEvent;
    const target = targetFromElement(event.target, mouse.clientY, active.source.projectPath);
    if (target === undefined) return;
    const plan = this.adapter_abyssPrivate.preview(active.source, target);
    event.preventDefault();
    const transfer = asDataTransfer(event);
    if (transfer !== undefined) transfer.dropEffect = plan.allowed ? 'move' : 'none';
    const column = event.target.closest<HTMLElement>('.abyss-project-kanban-column');
    const visualTarget = this.visualTarget_abyssPrivate(event.target, column);
    this.showPlan_abyssPrivate(visualTarget, plan);
    this.point_abyssPrivate = { x: mouse.clientX, y: mouse.clientY };
    this.startAutoScroll_abyssPrivate(event.target);
    if (column?.matches('.is-collapsed, .is-compact-empty') === true) {
      this.scheduleOverlay_abyssPrivate(column, plan);
    } else if (this.overlay_abyssPrivate?.contains(event.target) !== true) {
      this.cancelOverlay_abyssPrivate();
    }
  };

  private visualTarget_abyssPrivate(target: Element, column: HTMLElement | null): Element {
    if (
      column !== null &&
      this.overlay_abyssPrivate !== undefined &&
      this.hoverColumn_abyssPrivate === column
    ) {
      return this.overlay_abyssPrivate;
    }
    return target;
  }

  private insertionCard_abyssPrivate(zone: HTMLElement, plan: AllowedDropPlan): HTMLElement | null {
    let path: string | undefined;
    if (plan.insertion.kind === 'before') path = plan.insertion.beforePath;
    else if (plan.insertion.kind === 'after') path = plan.insertion.afterPath;
    else if (plan.insertion.kind === 'empty') path = plan.proposedProject.path;
    return path === undefined
      ? null
      : zone.querySelector<HTMLElement>(`[data-project-path="${CSS.escape(path)}"]`);
  }

  private insertionLine_abyssPrivate(
    zone: HTMLElement,
    group: HTMLElement | null,
    plan: AllowedDropPlan,
  ): HTMLElement {
    const projectedGroup = zone.querySelector<HTMLElement>(
      `[data-group-key="${CSS.escape(plan.insertion.groupKey)}"]`,
    );
    const actualGroup = group ?? projectedGroup;
    const card = this.insertionCard_abyssPrivate(actualGroup ?? zone, plan);
    const host =
      actualGroup?.querySelector<HTMLElement>('.abyss-project-kanban-group-body') ??
      actualGroup ??
      zone.querySelector<HTMLElement>('.abyss-project-kanban-column-body') ??
      zone;
    const line = host.createDiv({ cls: 'abyss-project-kanban-insertion-line' });
    this.placeInsertionLine_abyssPrivate(host, line, card, plan);
    return line;
  }

  private placeInsertionLine_abyssPrivate(
    host: HTMLElement,
    line: HTMLElement,
    card: HTMLElement | null,
    plan: AllowedDropPlan,
  ): void {
    const beforeGroup = insertionBeforeGroup(host, plan);
    const top = insertionLineTop(host, card, beforeGroup, plan.insertion.kind === 'after');
    line.setCssProps({ '--abyss-project-kanban-insertion-top': `${Math.max(0, top)}px` });
    if ((plan.insertion.kind === 'before' || plan.insertion.kind === 'empty') && card !== null) {
      card.before(line);
      return;
    }
    if (card !== null) {
      card.after(line);
      return;
    }
    if (plan.insertion.kind === 'none') return;
    beforeGroup?.before(line);
  }

  private showPlan_abyssPrivate(target: Element, plan: ProjectKanbanDropPlan): void {
    this.clearPreview_abyssPrivate();
    const group = target.closest<HTMLElement>(
      '.abyss-project-kanban-group, .abyss-project-kanban-hover-group',
    );
    const column = target.closest<HTMLElement>(
      '.abyss-project-kanban-column, .abyss-project-kanban-hover-preview',
    );
    const zone = group ?? column;
    if (zone === null) return;
    zone.addClass(plan.allowed ? 'is-drop-target' : 'is-drop-disabled');
    zone.setAttribute('title', plan.message);
    const line =
      plan.allowed && plan.insertion.kind !== 'none'
        ? this.insertionLine_abyssPrivate(zone, group, plan)
        : undefined;
    this.preview_abyssPrivate = { elements: [zone], ...(line === undefined ? {} : { line }) };
  }

  private clearPreview_abyssPrivate(): void {
    const preview = this.preview_abyssPrivate;
    this.preview_abyssPrivate = undefined;
    for (const element of preview?.elements ?? []) {
      element.removeClass('is-drop-target', 'is-drop-disabled');
      element.removeAttribute('title');
    }
    preview?.line?.remove();
  }

  private scheduleOverlay_abyssPrivate(column: HTMLElement, plan: ProjectKanbanDropPlan): void {
    if (
      this.hoverColumn_abyssPrivate === column &&
      (this.hoverTimer_abyssPrivate !== undefined || this.overlay_abyssPrivate !== undefined)
    )
      return;
    this.cancelOverlay_abyssPrivate();
    this.hoverColumn_abyssPrivate = column;
    this.hoverTimer_abyssPrivate = this.window_abyssPrivate.setTimeout(() => {
      this.hoverTimer_abyssPrivate = undefined;
      if (plan.allowed) this.openOverlay_abyssPrivate(column, plan);
    }, 450);
  }

  private openOverlay_abyssPrivate(column: HTMLElement, plan: AllowedDropPlan): void {
    const projected = plan.model.columns.find(
      ({ status }) => status.key === column.dataset['statusKey'],
    );
    if (projected === undefined) return;
    const overlay = this.root_abyssPrivate.createDiv({ cls: 'abyss-project-kanban-hover-preview' });
    overlay.dataset['statusKey'] = projected.status.key;
    overlay.dataset['statusValue'] = projected.status.statusId ?? '';
    overlay.style.left = `${column.offsetLeft + column.offsetWidth + 6}px`;
    overlay.style.top = `${column.offsetTop}px`;
    overlay.createDiv({ cls: 'abyss-project-kanban-hover-title', text: projected.status.label });
    const body = overlay.createDiv({ cls: 'abyss-project-kanban-hover-body' });
    for (const group of projected.groups) {
      this.renderOverlayGroup_abyssPrivate(column, body, group);
    }
    this.overlay_abyssPrivate = overlay;
    this.positionOverlay_abyssPrivate(column, overlay);
    this.showPlan_abyssPrivate(overlay, plan);
  }

  private renderOverlayGroup_abyssPrivate(
    column: HTMLElement,
    body: HTMLElement,
    group: ProjectTableGroup,
  ): void {
    const groupElement = body.createDiv({ cls: 'abyss-project-kanban-hover-group' });
    groupElement.dataset['groupKey'] = group.key;
    const currentGroup = column.querySelector<HTMLElement>(
      `[data-group-key="${CSS.escape(group.key)}"]`,
    );
    if (currentGroup === null) groupElement.dataset['projected'] = 'true';
    const sourcePath = currentGroup?.dataset['sourcePath'] ?? group.sourcePath;
    if (sourcePath !== undefined) groupElement.dataset['sourcePath'] = sourcePath;
    Reflect.set(
      groupElement,
      '__abyssGroupValue',
      currentGroup === null ? group.value : Reflect.get(currentGroup, '__abyssGroupValue'),
    );
    if (group.label.length > 0) {
      groupElement.createDiv({
        cls: 'abyss-project-kanban-hover-group-title',
        text: group.label,
      });
    }
    for (const project of group.projects) {
      groupElement.createDiv({
        cls: 'abyss-project-kanban-hover-card',
        text: project.name,
        attr: { 'data-project-path': project.path },
      });
    }
  }

  private positionOverlay_abyssPrivate(column: HTMLElement, overlay: HTMLElement): void {
    const rootRect = this.root_abyssPrivate.getBoundingClientRect();
    const viewport = this.scroll_abyssPrivate.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const availableWidth = Math.max(0, viewport.width);
    const overlayWidth = Math.min(272, availableWidth);
    const right = columnRect.right + 6;
    const left = columnRect.left - overlayWidth - 6;
    const preferred = right + overlayWidth <= viewport.right ? right : left;
    const maximum = Math.max(viewport.left, viewport.right - overlayWidth);
    const viewportLeft = Math.min(Math.max(preferred, viewport.left), maximum);
    const viewportTop = Math.min(Math.max(columnRect.top, viewport.top), viewport.bottom);
    overlay.style.left = `${viewportLeft - rootRect.left}px`;
    overlay.style.top = `${viewportTop - rootRect.top}px`;
    overlay.style.maxWidth = `${availableWidth}px`;
    overlay.style.maxHeight = `${Math.max(0, viewport.bottom - viewportTop)}px`;
  }

  private readonly dragLeave_abyssPrivate = (event: Event): void => {
    const related = (event as DragEvent).relatedTarget;
    if (related === null) return;
    if (related instanceof Node && this.root_abyssPrivate.contains(related)) return;
    this.clearVisuals_abyssPrivate();
  };

  private readonly documentDragOver_abyssPrivate = (event: Event): void => {
    if (
      this.active_abyssPrivate !== undefined &&
      event.target instanceof Node &&
      !this.root_abyssPrivate.contains(event.target)
    ) {
      this.clearVisuals_abyssPrivate();
    }
  };

  private readonly drop_abyssPrivate = (event: Event): void => {
    const active = this.active_abyssPrivate;
    if (active === undefined || !(event.target instanceof Element)) return;
    if (!validInternalTransfer(event, active.source)) {
      this.cleanup_abyssPrivate(false);
      this.adapter_abyssPrivate.reportFailure(new Error('Invalid project card drag'));
      return;
    }
    const target = targetFromElement(
      event.target,
      (event as MouseEvent).clientY,
      active.source.projectPath,
    );
    if (target === undefined) return;
    event.preventDefault();
    this.cleanup_abyssPrivate(true);
    void this.adapter_abyssPrivate.commit(active.source, target).catch((error: unknown) => {
      this.adapter_abyssPrivate.reportFailure(error);
    });
  };

  private readonly dragEnd_abyssPrivate = (): void => {
    this.cleanup_abyssPrivate(this.active_abyssPrivate !== undefined);
  };

  private readonly keydown_abyssPrivate = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Escape' ||
      (this.active_abyssPrivate === undefined && this.provisional_abyssPrivate === undefined)
    )
      return;
    event.preventDefault();
    this.cleanup_abyssPrivate(false);
  };

  private readonly click_abyssPrivate = (event: Event): void => {
    const path =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.abyss-project-kanban-card')?.dataset['projectPath']
        : undefined;
    if (path === undefined || path !== this.suppressClickPath_abyssPrivate) return;
    this.suppressClickPath_abyssPrivate = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private startAutoScroll_abyssPrivate(target: Element): void {
    this.verticalScroller_abyssPrivate =
      target.closest<HTMLElement>('.abyss-project-kanban-hover-body') ??
      expectBodyOrUndefined(target.closest<HTMLElement>('.abyss-project-kanban-column'));
    if (this.frame_abyssPrivate !== undefined) return;
    const tick = (): void => {
      this.frame_abyssPrivate = undefined;
      const point = this.point_abyssPrivate;
      if (point === undefined || this.active_abyssPrivate === undefined) return;
      this.scrollAtEdge_abyssPrivate(this.scroll_abyssPrivate, point.x, true);
      const vertical = this.verticalScroller_abyssPrivate;
      if (vertical !== undefined) this.scrollAtEdge_abyssPrivate(vertical, point.y, false);
      this.frame_abyssPrivate = this.window_abyssPrivate.requestAnimationFrame(tick);
    };
    this.frame_abyssPrivate = this.window_abyssPrivate.requestAnimationFrame(tick);
  }

  private scrollAtEdge_abyssPrivate(
    element: HTMLElement,
    coordinate: number,
    horizontal: boolean,
  ): void {
    const rect = element.getBoundingClientRect();
    const start = horizontal ? rect.left : rect.top;
    const end = horizontal ? rect.right : rect.bottom;
    let delta = 0;
    if (coordinate < start + 32) delta = -10;
    else if (coordinate > end - 32) delta = 10;
    if (horizontal) element.scrollLeft += delta;
    else element.scrollTop += delta;
  }

  private cancelOverlay_abyssPrivate(): void {
    if (this.hoverTimer_abyssPrivate !== undefined) {
      this.window_abyssPrivate.clearTimeout(this.hoverTimer_abyssPrivate);
      this.hoverTimer_abyssPrivate = undefined;
    }
    this.hoverColumn_abyssPrivate = undefined;
    this.overlay_abyssPrivate?.remove();
    this.overlay_abyssPrivate = undefined;
  }

  private clearVisuals_abyssPrivate(): void {
    this.clearPreview_abyssPrivate();
    this.cancelOverlay_abyssPrivate();
    if (this.frame_abyssPrivate !== undefined) {
      this.window_abyssPrivate.cancelAnimationFrame(this.frame_abyssPrivate);
      this.frame_abyssPrivate = undefined;
    }
    this.point_abyssPrivate = undefined;
    this.verticalScroller_abyssPrivate = undefined;
  }

  private cleanup_abyssPrivate(suppressClick: boolean): void {
    const active = this.active_abyssPrivate;
    this.active_abyssPrivate = undefined;
    if (suppressClick) this.suppressClickPath_abyssPrivate = active?.source.projectPath;
    active?.card.removeClass('is-dragging');
    active?.image?.remove();
    this.releaseProvisional_abyssPrivate();
    this.clearVisuals_abyssPrivate();
    active?.release();
  }
}

function expectBodyOrUndefined(column: HTMLElement | null): HTMLElement | undefined {
  return column?.querySelector<HTMLElement>('.abyss-project-kanban-column-body') ?? undefined;
}
