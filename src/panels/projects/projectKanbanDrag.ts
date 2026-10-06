import { setTooltip } from 'obsidian';
import type { ProjectTableGroup } from '../../projects/projectTableModel';
import type {
  ProjectKanbanDropPlan,
  ProjectKanbanDropSource,
  ProjectKanbanDropTarget,
} from './projectKanbanDrop';
import { ProjectKanbanHoverViewport } from './projectKanbanHoverViewport';
import type { KanbanViewportRow } from './projectKanbanRows';

const PROJECT_KANBAN_DRAG_TYPE = 'application/x-abyss-project-kanban-card';

export interface ProjectKanbanDragAdapter {
  readonly hitTest: (
    clientX: number,
    clientY: number,
    source: ProjectKanbanDropSource,
  ) => { target: ProjectKanbanDropTarget; lineHost: HTMLElement } | undefined;
  readonly insertionLocation: (
    target: Element,
    plan: AllowedDropPlan,
  ) => { lineHost: HTMLElement; lineTop: number } | undefined;
  readonly pin: (card: HTMLElement) => () => void;
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
  readonly unpin: () => void;
}

interface ActivePreview {
  readonly elements: readonly HTMLElement[];
  readonly line?: HTMLElement;
}

type AllowedDropPlan = Extract<ProjectKanbanDropPlan, { allowed: true }>;

interface CachedPreviewPlan {
  readonly source: ProjectKanbanDropSource;
  readonly target: ProjectKanbanDropTarget;
  readonly revision: number;
  readonly plan: ProjectKanbanDropPlan;
}

function equalTargetValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => equalTargetValue(value, right[index]))
    );
  return Object.is(left, right);
}
function sameTargetGroup(
  left: ProjectKanbanDropTarget['group'],
  right: ProjectKanbanDropTarget['group'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.key === right.key &&
    left.sourcePath === right.sourcePath &&
    left.projected === right.projected &&
    equalTargetValue(left.value, right.value)
  );
}
function sameDropTarget(left: ProjectKanbanDropTarget, right: ProjectKanbanDropTarget): boolean {
  return (
    sameTargetGroup(left.status, right.status) &&
    sameTargetGroup(left.group, right.group) &&
    left.beforePath === right.beforePath
  );
}

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
  const zone = card.closest<HTMLElement>(
    '.abyss-project-kanban-column, .abyss-project-kanban-hover-preview',
  );
  if (zone === null) return undefined;
  const cards = Array.from(
    zone.querySelectorAll<HTMLElement>(
      '.abyss-project-kanban-card, .abyss-project-kanban-hover-card',
    ),
  );
  const groupKey = card.closest<HTMLElement>('[data-group-key]')?.dataset['groupKey'];
  const index = cards.indexOf(card);
  for (let next = index + 1; next < cards.length; next += 1) {
    if (cards[next]?.closest<HTMLElement>('[data-group-key]')?.dataset['groupKey'] !== groupKey)
      return undefined;
    const path = cards[next]?.dataset['projectPath'];
    if (path !== undefined && path !== sourcePath) return path;
  }
  return undefined;
}

function cardBeforePath(
  card: HTMLElement,
  clientY: number,
  sourcePath: string,
  sourceCard: HTMLElement,
): string | undefined {
  const path = card.dataset['projectPath'];
  if (card === sourceCard) return path;
  if (path === sourcePath) return nextVisibleCardPath(card, sourcePath);
  const rect = card.getBoundingClientRect();
  if (clientY < rect.top + rect.height / 2) return path;
  return nextVisibleCardPath(card, sourcePath);
}

function targetFromElement(
  element: Element,
  clientY: number,
  sourcePath: string,
  sourceCard: HTMLElement,
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
  const beforePath =
    card === null ? undefined : cardBeforePath(card, clientY, sourcePath, sourceCard);
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

/** Owns the native board drag lifecycle, visual forecast, hover overlay, and scrolling cleanup. */
export class ProjectKanbanDragController {
  private window_abyssPrivate: Window | null = null;
  private ownerDocument_abyssPrivate: Document | undefined;
  private nativeCleanup_abyssPrivate: (() => void) | undefined;
  private readonly migrationCleanup_abyssPrivate: () => void;
  private destroyed_abyssPrivate = false;
  private presentationRevision_abyssPrivate = 0;
  private previewPlanRevision_abyssPrivate = 0;
  private cachedPreviewPlan_abyssPrivate: CachedPreviewPlan | undefined;
  private provisionalCleanup_abyssPrivate: (() => void) | undefined;
  private provisional_abyssPrivate: ProvisionalGesture | undefined;
  private provisionalTabIndex_abyssPrivate: string | null | undefined;
  private active_abyssPrivate: ActiveDrag | undefined;
  private preview_abyssPrivate: ActivePreview | undefined;
  private hoverTimer_abyssPrivate: number | undefined;
  private hoverRevision_abyssPrivate = 0;
  private hoverColumn_abyssPrivate: HTMLElement | undefined;
  private overlay_abyssPrivate: HTMLElement | undefined;
  private frame_abyssPrivate: number | undefined;
  private point_abyssPrivate: { x: number; y: number } | undefined;
  private verticalScroller_abyssPrivate: HTMLElement | undefined;
  private suppressClickPath_abyssPrivate: string | undefined;
  private hoverViewport_abyssPrivate: ProjectKanbanHoverViewport | undefined;
  private readonly hoverGroups_abyssPrivate = new Map<string, ProjectTableGroup>();
  private readonly hoverCurrentGroups_abyssPrivate = new Map<string, ProjectTableGroup>();
  private readonly hoverTitles_abyssPrivate = new Map<string, { path: string; name: string }>();
  private hoverContent_abyssPrivate: HTMLElement | undefined;

  constructor(
    private readonly root_abyssPrivate: HTMLElement,
    private readonly scroll_abyssPrivate: HTMLElement,
    private readonly adapter_abyssPrivate: ProjectKanbanDragAdapter,
  ) {
    this.bindOwner_abyssPrivate();
    this.migrationCleanup_abyssPrivate = root_abyssPrivate.onWindowMigrated(
      this.bindOwner_abyssPrivate,
    );
    for (const event of ['pointerdown', 'dragstart', 'dragover', 'drop', 'keydown', 'focusin'])
      root_abyssPrivate.addEventListener(event, this.bindOwner_abyssPrivate, true);
    root_abyssPrivate.addEventListener('pointerdown', this.pointerDown_abyssPrivate, true);
    root_abyssPrivate.addEventListener('dragstart', this.dragStart_abyssPrivate);
    root_abyssPrivate.addEventListener('dragover', this.dragOver_abyssPrivate);
    root_abyssPrivate.addEventListener('dragleave', this.dragLeave_abyssPrivate);
    root_abyssPrivate.addEventListener('drop', this.drop_abyssPrivate);
    root_abyssPrivate.addEventListener('dragend', this.dragEnd_abyssPrivate);
    root_abyssPrivate.addEventListener('click', this.click_abyssPrivate, true);
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.migrationCleanup_abyssPrivate();
    this.nativeCleanup_abyssPrivate?.();
    for (const event of ['pointerdown', 'dragstart', 'dragover', 'drop', 'keydown', 'focusin'])
      this.root_abyssPrivate.removeEventListener(event, this.bindOwner_abyssPrivate, true);
    this.cleanup_abyssPrivate(false);
    this.root_abyssPrivate.removeEventListener('pointerdown', this.pointerDown_abyssPrivate, true);
    this.root_abyssPrivate.removeEventListener('dragstart', this.dragStart_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragover', this.dragOver_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragleave', this.dragLeave_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('drop', this.drop_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('dragend', this.dragEnd_abyssPrivate);
    this.root_abyssPrivate.removeEventListener('click', this.click_abyssPrivate, true);
  }

  private readonly bindOwner_abyssPrivate = (): void => {
    const doc = this.root_abyssPrivate.ownerDocument;
    if (this.destroyed_abyssPrivate || doc === this.ownerDocument_abyssPrivate) return;
    this.cleanup_abyssPrivate(false);
    this.nativeCleanup_abyssPrivate?.();
    this.ownerDocument_abyssPrivate = doc;
    const win = doc.defaultView;
    this.window_abyssPrivate = win;
    let live = true;
    const keydown = (event: KeyboardEvent): void => {
      if (live && this.root_abyssPrivate.ownerDocument === doc) this.keydown_abyssPrivate(event);
    };
    const dragover = (event: Event): void => {
      if (live && this.root_abyssPrivate.ownerDocument === doc)
        this.documentDragOver_abyssPrivate(event);
    };
    const blur = (): void => {
      if (live && this.root_abyssPrivate.ownerDocument === doc) this.windowBlur_abyssPrivate();
    };
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('dragover', dragover, true);
    win?.addEventListener('blur', blur);
    this.nativeCleanup_abyssPrivate = () => {
      live = false;
      doc.removeEventListener('keydown', keydown, true);
      doc.removeEventListener('dragover', dragover, true);
      win?.removeEventListener('blur', blur);
    };
  };

  cancel(): void {
    this.cleanup_abyssPrivate(false);
  }

  clearPreview(): void {
    this.clearVisuals_abyssPrivate();
  }

  /** Source/model publication invalidates semantics while retaining the active native gesture. */
  invalidatePreviewPlan(): void {
    this.previewPlanRevision_abyssPrivate++;
    this.cachedPreviewPlan_abyssPrivate = undefined;
    this.clearPreview_abyssPrivate();
    this.cancelOverlay_abyssPrivate();
  }

  private previewPlan_abyssPrivate(
    source: ProjectKanbanDropSource,
    target: ProjectKanbanDropTarget,
    fresh: boolean,
  ): ProjectKanbanDropPlan {
    const cached = this.cachedPreviewPlan_abyssPrivate;
    if (
      fresh ||
      cached?.source !== source ||
      cached.revision !== this.previewPlanRevision_abyssPrivate ||
      !sameDropTarget(cached.target, target)
    ) {
      const plan = this.adapter_abyssPrivate.preview(source, target);
      this.cachedPreviewPlan_abyssPrivate = {
        source,
        target,
        revision: this.previewPlanRevision_abyssPrivate,
        plan,
      };
      return plan;
    }
    return cached.plan;
  }

  private readonly pointerDown_abyssPrivate = (event: Event): void => {
    this.releaseProvisional_abyssPrivate();
    this.suppressClickPath_abyssPrivate = undefined;
    if (this.window_abyssPrivate === null) return;
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    const card = cardFromEvent(event);
    if (card === null || protectedTarget(event.target)) return;
    this.provisional_abyssPrivate = {
      card,
      origin: event.target,
      pointerId: pointer.pointerId,
      unpin: this.adapter_abyssPrivate.pin(card),
    };
    this.provisionalTabIndex_abyssPrivate = card.getAttribute('tabindex');
    card.removeAttribute('tabindex');
    card.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    card.addClass('is-drag-armed');
    const ownerDocument = card.ownerDocument;
    let live = true;
    const end = (event: Event): void => {
      if (live && this.root_abyssPrivate.ownerDocument === ownerDocument)
        this.provisionalPointerEnd_abyssPrivate(event);
    };
    ownerDocument.addEventListener('pointerup', end, true);
    ownerDocument.addEventListener('pointercancel', end, true);
    this.provisionalCleanup_abyssPrivate = () => {
      live = false;
      ownerDocument.removeEventListener('pointerup', end, true);
      ownerDocument.removeEventListener('pointercancel', end, true);
    };
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
      const unpin = this.adapter_abyssPrivate.pin(card);
      const end = this.adapter_abyssPrivate.begin();
      release = () => {
        unpin();
        end();
      };
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
    provisional?.unpin();
    const tabIndex = this.provisionalTabIndex_abyssPrivate;
    this.provisional_abyssPrivate = undefined;
    this.provisionalTabIndex_abyssPrivate = undefined;
    if (provisional !== undefined) {
      provisional.card.removeClass('is-drag-armed');
      if (tabIndex === null) provisional.card.removeAttribute('tabindex');
      else if (tabIndex !== undefined) provisional.card.setAttribute('tabindex', tabIndex);
    }
    this.provisionalCleanup_abyssPrivate?.();
    this.provisionalCleanup_abyssPrivate = undefined;
  }

  private readonly dragOver_abyssPrivate = (event: Event): void => {
    const active = this.active_abyssPrivate;
    if (active === undefined || !(event.target instanceof Element)) return;
    const mouse = event as MouseEvent;
    const hit = this.logicalHit_abyssPrivate(mouse.clientX, mouse.clientY, active.source);
    const target =
      hit?.target ??
      targetFromElement(event.target, mouse.clientY, active.source.projectPath, active.card);
    if (target === undefined) return;
    const plan = this.previewPlan_abyssPrivate(active.source, target, true);
    event.preventDefault();
    const transfer = asDataTransfer(event);
    if (transfer !== undefined) transfer.dropEffect = plan.allowed ? 'move' : 'none';
    const column = event.target.closest<HTMLElement>('.abyss-project-kanban-column');
    const visualTarget = this.visualTarget_abyssPrivate(event.target, column);
    this.showPlan_abyssPrivate(visualTarget, plan);
    this.point_abyssPrivate = { x: mouse.clientX, y: mouse.clientY };
    this.startAutoScroll_abyssPrivate(event.target);
    this.updateOverlay_abyssPrivate(column, event.target, plan);
  };

  private updateOverlay_abyssPrivate(
    column: HTMLElement | null,
    target: Element,
    plan: ProjectKanbanDropPlan,
  ): void {
    if (column?.matches('.is-collapsed, .is-compact-empty') === true) {
      this.scheduleOverlay_abyssPrivate(column, plan);
    } else if (this.overlay_abyssPrivate?.contains(target) !== true) {
      this.cancelOverlay_abyssPrivate();
    }
  }

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
    setTooltip(zone, plan.message);
    let line: HTMLElement | undefined;
    if (plan.allowed && plan.insertion.kind !== 'none') {
      const location =
        column?.classList.contains('abyss-project-kanban-hover-preview') === true
          ? this.hoverInsertionLocation_abyssPrivate(plan)
          : this.adapter_abyssPrivate.insertionLocation(target, plan);
      if (location !== undefined) {
        line = location.lineHost.createDiv({ cls: 'abyss-project-kanban-insertion-line' });
        line.setCssProps({
          '--abyss-project-kanban-insertion-top': `${Math.max(0, location.lineTop)}px`,
        });
      }
    }
    this.preview_abyssPrivate = { elements: [zone], ...(line === undefined ? {} : { line }) };
  }

  private clearPreview_abyssPrivate(): void {
    const preview = this.preview_abyssPrivate;
    this.preview_abyssPrivate = undefined;
    for (const element of preview?.elements ?? []) {
      element.removeClass('is-drop-target', 'is-drop-disabled');
      setTooltip(element, '');
      element.removeAttribute('aria-label');
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
    const owner = this.window_abyssPrivate;
    const revision = this.presentationRevision_abyssPrivate;
    const doc = this.root_abyssPrivate.ownerDocument;
    const hoverRevision = this.hoverRevision_abyssPrivate;
    const timer = owner?.setTimeout(() => {
      if (
        !this.ownsPresentation_abyssPrivate(doc, revision) ||
        hoverRevision !== this.hoverRevision_abyssPrivate ||
        timer !== this.hoverTimer_abyssPrivate
      )
        return;
      this.hoverTimer_abyssPrivate = undefined;
      if (this.active_abyssPrivate === undefined || !column.isConnected) return;
      try {
        if (plan.allowed) this.openOverlay_abyssPrivate(column, plan);
      } catch (error) {
        this.adapter_abyssPrivate.reportFailure(error);
      }
    }, 450);
    this.hoverTimer_abyssPrivate = timer;
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
    for (const group of columnGroups(column))
      this.hoverCurrentGroups_abyssPrivate.set(group.key, group);
    this.hoverContent_abyssPrivate = body;
    const rows: KanbanViewportRow[] = projected.groups.flatMap((group) => {
      this.hoverGroups_abyssPrivate.set(group.key, group);
      return [
        {
          kind: 'group' as const,
          key: `header:${group.key}`,
          groupKey: group.key,
          estimatedHeight: group.label.length > 0 ? 32 : 8,
          measurementRevision: group.label,
        },
        ...group.projects.map((project) => {
          const path = project.path;
          const key = `${group.key}\u0000${path}`;
          this.hoverTitles_abyssPrivate.set(key, { path, name: project.name });
          return {
            kind: 'card' as const,
            key,
            groupKey: group.key,
            projectPath: path,
            estimatedHeight: 42,
            measurementRevision: project.name,
          };
        }),
      ];
    });
    this.hoverViewport_abyssPrivate = new ProjectKanbanHoverViewport(
      body,
      rows,
      (host, row) => {
        const group = this.hoverGroups_abyssPrivate.get(row.groupKey);
        if (group === undefined) throw new Error('Project forecast group is no longer available');
        return this.renderOverlayGroup_abyssPrivate(host, group, row);
      },
      (error) => {
        this.adapter_abyssPrivate.reportFailure(error);
      },
    );
    this.overlay_abyssPrivate = overlay;
    this.positionOverlay_abyssPrivate(column, overlay);
    this.showPlan_abyssPrivate(overlay, plan);
  }

  private renderOverlayGroup_abyssPrivate(
    body: HTMLElement,
    group: ProjectTableGroup,
    row: KanbanViewportRow,
  ): HTMLElement {
    const groupElement = body.createDiv({ cls: 'abyss-project-kanban-hover-group' });
    groupElement.dataset['groupKey'] = group.key;
    const currentGroup = this.hoverCurrentGroups_abyssPrivate.get(group.key);
    if (currentGroup === undefined) groupElement.dataset['projected'] = 'true';
    const sourcePath = currentGroup?.sourcePath ?? group.sourcePath;
    if (sourcePath !== undefined) groupElement.dataset['sourcePath'] = sourcePath;
    Reflect.set(
      groupElement,
      '__abyssGroupValue',
      currentGroup === undefined ? group.value : currentGroup.value,
    );
    if (row.kind === 'group' && group.label.length > 0) {
      groupElement.createDiv({
        cls: 'abyss-project-kanban-hover-group-title',
        text: group.label,
      });
    }
    const project = this.hoverTitles_abyssPrivate.get(row.key);
    if (row.kind === 'card' && project !== undefined) {
      groupElement.createDiv({
        cls: 'abyss-project-kanban-hover-card',
        text: project.name,
        attr: { 'data-project-path': project.path },
      });
    }
    return groupElement;
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
      event.target !== null &&
      'nodeType' in event.target &&
      !this.root_abyssPrivate.contains(event.target as Node)
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
    const point = event as MouseEvent;
    const target =
      this.logicalHit_abyssPrivate(point.clientX, point.clientY, active.source)?.target ??
      targetFromElement(event.target, point.clientY, active.source.projectPath, active.card);
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

  private logicalHit_abyssPrivate(
    x: number,
    y: number,
    source: ProjectKanbanDropSource,
  ): { target: ProjectKanbanDropTarget; lineHost: HTMLElement } | undefined {
    return (
      this.hoverHit_abyssPrivate(x, y, source) ?? this.adapter_abyssPrivate.hitTest(x, y, source)
    );
  }

  private hoverHit_abyssPrivate(
    x: number,
    y: number,
    source: ProjectKanbanDropSource,
  ): { target: ProjectKanbanDropTarget; lineHost: HTMLElement } | undefined {
    const host = this.hoverContent_abyssPrivate;
    const overlay = this.overlay_abyssPrivate;
    if (host === undefined || overlay === undefined || !containsPoint(host, x, y)) return undefined;
    const insertion = this.hoverViewport_abyssPrivate?.hitTest(
      y - host.getBoundingClientRect().top + Math.max(0, host.scrollTop),
      source.projectPath,
    );
    if (insertion === undefined) return undefined;
    const group = this.hoverGroups_abyssPrivate.get(insertion.groupKey);
    const statusKey = overlay.dataset['statusKey'];
    if (group === undefined || statusKey === undefined) return undefined;
    return {
      target: {
        status: { key: statusKey, value: overlay.dataset['statusValue'] ?? null },
        group: this.hoverGroupTarget_abyssPrivate(group),
        ...(insertion.beforePath === undefined ? {} : { beforePath: insertion.beforePath }),
      },
      lineHost: host,
    };
  }
  private hoverInsertionLocation_abyssPrivate(
    plan: AllowedDropPlan,
  ): { lineHost: HTMLElement; lineTop: number } | undefined {
    const host = this.hoverContent_abyssPrivate;
    const top = this.hoverViewport_abyssPrivate?.insertionTop(
      plan.insertion,
      plan.proposedProject.path,
    );
    return host === undefined || top === undefined ? undefined : { lineHost: host, lineTop: top };
  }
  private hoverGroupTarget_abyssPrivate(
    group: ProjectTableGroup,
  ): NonNullable<ProjectKanbanDropTarget['group']> {
    return {
      key: group.key,
      value: group.value,
      projected: !this.hoverCurrentGroups_abyssPrivate.has(group.key),
      ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
    };
  }

  private ownsPresentation_abyssPrivate(doc: Document, revision: number): boolean {
    return (
      !this.destroyed_abyssPrivate &&
      this.root_abyssPrivate.ownerDocument === doc &&
      this.presentationRevision_abyssPrivate === revision
    );
  }

  private startAutoScroll_abyssPrivate(target: Element): void {
    this.verticalScroller_abyssPrivate =
      target.closest<HTMLElement>('.abyss-project-kanban-hover-body') ??
      expectBodyOrUndefined(target.closest<HTMLElement>('.abyss-project-kanban-column'));
    if (this.frame_abyssPrivate !== undefined) return;
    const revision = this.presentationRevision_abyssPrivate;
    const doc = this.root_abyssPrivate.ownerDocument;
    const tick = (): void => {
      if (!this.ownsPresentation_abyssPrivate(doc, revision)) return;
      this.frame_abyssPrivate = undefined;
      const point = this.point_abyssPrivate;
      if (point === undefined || this.active_abyssPrivate === undefined) return;
      if (!this.root_abyssPrivate.isConnected || this.root_abyssPrivate.hidden === true) {
        this.cleanup_abyssPrivate(false);
        return;
      }
      try {
        this.scrollAtEdge_abyssPrivate(this.scroll_abyssPrivate, point.x, true);
        const vertical = this.verticalScroller_abyssPrivate;
        if (vertical !== undefined) this.scrollAtEdge_abyssPrivate(vertical, point.y, false);
        this.retargetAfterScroll_abyssPrivate(point, this.active_abyssPrivate.source);
        this.frame_abyssPrivate = this.window_abyssPrivate?.requestAnimationFrame(tick);
      } catch (error) {
        this.cleanup_abyssPrivate(false);
        this.adapter_abyssPrivate.reportFailure(error);
      }
    };
    this.frame_abyssPrivate = this.window_abyssPrivate?.requestAnimationFrame(tick);
  }

  private retargetAfterScroll_abyssPrivate(
    point: { x: number; y: number },
    source: ProjectKanbanDropSource,
  ): void {
    const hit = this.logicalHit_abyssPrivate(point.x, point.y, source);
    if (hit === undefined) return;
    this.verticalScroller_abyssPrivate =
      hit.lineHost.closest<HTMLElement>(
        '.abyss-project-kanban-hover-body, .abyss-project-kanban-column-body',
      ) ?? undefined;
    const column = hit.lineHost.closest<HTMLElement>('.abyss-project-kanban-column');
    const plan = this.previewPlan_abyssPrivate(source, hit.target, false);
    this.showPlan_abyssPrivate(this.visualTarget_abyssPrivate(hit.lineHost, column), plan);
    this.updateOverlay_abyssPrivate(column, hit.lineHost, plan);
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
    if (delta === 0) return;
    if (horizontal) element.scrollLeft += delta;
    else element.scrollTop += delta;
  }

  private cancelOverlay_abyssPrivate(): void {
    this.hoverRevision_abyssPrivate += 1;
    if (this.hoverTimer_abyssPrivate !== undefined) {
      this.window_abyssPrivate?.clearTimeout(this.hoverTimer_abyssPrivate);
      this.hoverTimer_abyssPrivate = undefined;
    }
    this.hoverColumn_abyssPrivate = undefined;
    this.hoverViewport_abyssPrivate?.destroy();
    this.hoverViewport_abyssPrivate = undefined;
    this.hoverContent_abyssPrivate = undefined;
    this.hoverGroups_abyssPrivate.clear();
    this.hoverCurrentGroups_abyssPrivate.clear();
    this.hoverTitles_abyssPrivate.clear();
    this.overlay_abyssPrivate?.remove();
    this.overlay_abyssPrivate = undefined;
  }

  private clearVisuals_abyssPrivate(): void {
    this.presentationRevision_abyssPrivate += 1;
    this.cachedPreviewPlan_abyssPrivate = undefined;
    this.clearPreview_abyssPrivate();
    this.cancelOverlay_abyssPrivate();
    if (this.frame_abyssPrivate !== undefined) {
      this.window_abyssPrivate?.cancelAnimationFrame(this.frame_abyssPrivate);
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

function columnGroups(column: HTMLElement | undefined): readonly ProjectTableGroup[] {
  return column === undefined
    ? []
    : ((Reflect.get(column, '__abyssKanbanGroups') as readonly ProjectTableGroup[] | undefined) ??
        []);
}

function containsPoint(element: HTMLElement, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
