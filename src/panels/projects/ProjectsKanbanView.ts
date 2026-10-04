import { setIcon, type Component } from 'obsidian';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import {
  findProjectFieldById,
  type ProjectColumn,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import {
  buildProjectKanbanModel,
  type ProjectKanbanColumn,
  type ProjectKanbanModel,
  type ProjectKanbanModelInput,
} from '../../projects/projectKanbanModel';
import type { ProjectKanbanSettings } from '../../projects/projectKanbanSettings';
import { projectProgress, type ProjectTableGroup } from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import {
  projectKanbanCardFields,
  projectKanbanCardKey,
  projectKanbanDescription,
  projectKanbanOccurrenceId,
} from './projectKanbanCards';
import { ProjectKanbanDragController } from './projectKanbanDrag';
import {
  captureProjectKanbanDropSource,
  planProjectKanbanDrop,
  type ProjectKanbanDropPlan,
  type ProjectKanbanDropSource,
  type ProjectKanbanDropTarget,
} from './projectKanbanDrop';
import type { KanbanViewportRow } from './projectKanbanRows';
import { ProjectKanbanColumnViewport, type KanbanRowMount } from './projectKanbanViewport';
import {
  NO_PROJECT_OVERVIEW_CELLS,
  projectKanbanCells,
  type ProjectOverviewCells,
  type ProjectOverviewFieldResolver,
} from './projectOverviewCells';
import {
  scrollIntoUsableViewport,
  type ProjectOverviewEditorFrame,
  type ProjectOverviewRenderHooks,
  type ProjectsOverviewSurface,
} from './ProjectsOverviewSurface';
import type { ProjectTableSelectableCell } from './projectTableSelection';

let kanbanSurfaceAccessibilitySequence = 0;

interface ProjectKanbanCellIdentity {
  readonly occurrenceId: string;
  readonly projectPath: string;
  readonly groupKey: string;
  readonly columnId: string;
}

export interface ProjectKanbanCellContext {
  readonly element: HTMLElement;
  readonly identity: ProjectKanbanCellIdentity;
}

export interface ProjectKanbanOccurrenceContext<TCell extends ProjectKanbanCellContext> {
  readonly key: string;
  readonly element: HTMLElement;
  readonly cells: Map<string, TCell>;
  project: Project;
  occurrenceId: string;
  statusKey: string;
  groupKey: string;
}

export interface ProjectKanbanGroupContext<TCell extends ProjectKanbanCellContext> {
  readonly key: string;
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly header: HTMLButtonElement;
  readonly chevron: HTMLElement;
  readonly marker: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly cards: Map<string, ProjectKanbanOccurrenceContext<TCell>>;
  statusKey: string;
  groupKey: string;
  value: unknown;
}

interface ProjectKanbanColumnContext<TCell extends ProjectKanbanCellContext> {
  readonly key: string;
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly groups: Map<string, ProjectKanbanGroupContext<TCell>>;
  statusKey: string;
  value: unknown;
}

export interface ProjectsKanbanViewContext<TCell extends ProjectKanbanCellContext> {
  readonly copy: (event: ClipboardEvent) => void;
  readonly paste: (event: ClipboardEvent) => void;
  readonly windowRendered: () => void;
  readonly beginDrag: () => () => void;
  readonly settings: () => ProjectKanbanSettings;
  readonly modelInput: () => Omit<ProjectKanbanModelInput, 'projects' | 'settings' | 'search'>;
  /** The field each cell edits, which an owned clear may retype; `cells()` lists it. */
  readonly effectiveField: ProjectOverviewFieldResolver;
  readonly renderCell: (options: {
    readonly host: HTMLElement;
    readonly markdown: Component;
    readonly project: Project;
    readonly field: ProjectFieldCatalogItem;
    readonly column: ProjectColumn | undefined;
    readonly occurrenceId: string;
    readonly groupKey: string;
    readonly existing?: TCell;
  }) => TCell;
  readonly selectCell: (cell: TCell) => void;
  readonly requestViewChange: (mutation: () => void) => Promise<boolean>;
  readonly releaseCell: (cell: TCell) => void;
  readonly renderGroupContent: (
    marker: HTMLElement,
    label: HTMLElement,
    group: ProjectTableGroup,
    markdown: Component,
  ) => void;
  readonly applyChanges: (changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>;
  readonly projectSnapshot: (path: string) => Project | undefined;
  readonly projectsSnapshot: () => readonly Project[];
  readonly isLiveProjectPath: (path: string) => boolean;
  readonly statusProperty: () => string;
  readonly membershipQuery: () => string;
  readonly tagsReliable: (path: string, groupFieldId: string) => boolean;
  readonly rebaseGroupValue: (
    value: unknown,
    sourcePath: string,
    destinationPath: string,
  ) => unknown;
  readonly commitDrop: (
    build: () => {
      readonly changes: readonly ProjectCellChange[];
      readonly afterApplied?: () => void;
    },
  ) => Promise<ProjectEditResult>;
  readonly reportRenderFailure: (error: unknown) => void;
  readonly reportDropFailure: (error: unknown) => void;
  readonly createProject: (anchor: HTMLElement, statusId: string) => void;
}

interface RenderedCard<
  TCell extends ProjectKanbanCellContext,
> extends ProjectKanbanOccurrenceContext<TCell> {
  readonly markdown: Component;
  readonly title: HTMLElement;
  readonly description: HTMLElement;
  readonly descriptionContent: HTMLElement;
  readonly fields: HTMLElement;
  readonly progress: HTMLElement;
}

interface RenderedColumn<
  TCell extends ProjectKanbanCellContext,
> extends ProjectKanbanColumnContext<TCell> {
  readonly viewport: ProjectKanbanColumnViewport;
  readonly content: HTMLElement;
  readonly marker: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly create: HTMLButtonElement;
  readonly collapse: HTMLButtonElement;
}

interface PatchCardContext<TCell extends ProjectKanbanCellContext> {
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly settings: ProjectKanbanSettings;
  readonly retained: Set<string>;
  readonly visibleCells: TCell[];
}

interface DragFocusOwnership {
  readonly revision: number;
  readonly path: string;
  readonly fieldId?: string;
}

export class ProjectsKanbanView<
  TCell extends ProjectKanbanCellContext,
> implements ProjectsOverviewSurface<TCell> {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  private readonly columns_abyssPrivate = new Map<string, RenderedColumn<TCell>>();
  private readonly cards_abyssPrivate = new Map<string, RenderedCard<TCell>>();
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private projects_abyssPrivate: readonly Project[] = [];
  private search_abyssPrivate = '';
  private pendingViewport_abyssPrivate:
    { scrollLeft: number; columnTops: ReadonlyMap<string, number> } | undefined;
  private mounted_abyssPrivate = false;
  private selectedPath_abyssPrivate: string | undefined;
  private visibleCells_abyssPrivate: TCell[] = [];
  private cells_abyssPrivate: ProjectOverviewCells = NO_PROJECT_OVERVIEW_CELLS;
  private readonly drag_abyssPrivate: ProjectKanbanDragController;
  private readonly dragFocus_abyssPrivate = new WeakMap<
    ProjectKanbanDropSource,
    DragFocusOwnership
  >();
  private dragFocusRevision_abyssPrivate = 0;
  private updatingWindows_abyssPrivate = false;
  private readonly cellOrder_abyssPrivate = new Map<string, number>();
  private model_abyssPrivate: ProjectKanbanModel | undefined;
  private readonly rowModels_abyssPrivate = new Map<
    string,
    { column: RenderedColumn<TCell>; group: ProjectTableGroup; project?: Project }
  >();
  private readonly columnRows_abyssPrivate = new Map<string, readonly KanbanViewportRow[]>();

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsKanbanViewContext<TCell>,
  ) {
    this.root = host.createDiv({ cls: 'abyss-project-kanban', attr: { tabindex: '-1' } });
    const surfaceName = this.root.createSpan({
      cls: 'abyss-sr-only',
      text: 'Project Kanban board',
    });
    surfaceName.id = `abyss-project-kanban-surface-${String(++kanbanSurfaceAccessibilitySequence)}`;
    this.scroll = this.root.createDiv({
      cls: 'abyss-project-kanban-scroll',
      attr: { 'aria-labelledby': surfaceName.id, tabindex: '0' },
    });
    this.drag_abyssPrivate = new ProjectKanbanDragController(this.root, this.scroll, {
      hitTest: (x, y, source) => this.hitTest_abyssPrivate(x, y, source),
      pin: (element) => {
        const key = element.dataset['occurrenceId'];
        const status = element.closest<HTMLElement>('.abyss-project-kanban-column')?.dataset[
          'statusKey'
        ];
        const column = status === undefined ? undefined : this.columns_abyssPrivate.get(status);
        return key === undefined || column === undefined ? () => {} : column.viewport.pin(key);
      },
      begin: () => this.context_abyssPrivate.beginDrag(),
      capture: (card) => this.captureDragSource_abyssPrivate(card),
      preview: (source, target) => this.dropPlan_abyssPrivate(source, target),
      commit: (source, target) => this.commitDrop_abyssPrivate(source, target),
      reportFailure: (error) => {
        this.context_abyssPrivate.reportDropFailure(error);
      },
    });
    this.root.addEventListener('copy', this.context_abyssPrivate.copy);
    this.root.addEventListener('paste', this.context_abyssPrivate.paste);
    this.scroll.addEventListener('scroll', this.activateColumns_abyssPrivate, { passive: true });
    this.root.addEventListener('pointerdown', this.handleBoardInteraction_abyssPrivate, true);
    this.root.addEventListener('keydown', this.handleBoardInteraction_abyssPrivate, true);
    this.root.ownerDocument.addEventListener('focusin', this.handleDocumentFocusIn_abyssPrivate);
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.drag_abyssPrivate.cancel();
    this.root.hidden = true;
    for (const column of this.columns_abyssPrivate.values()) column.viewport.setActive(false);
  }

  render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void {
    this.mounted_abyssPrivate = true;
    this.projects_abyssPrivate = projects;
    this.search_abyssPrivate = search;
    hooks.publish(this.render_abyssPrivate());
    if (
      this.root.isConnected &&
      this.scroll.isConnected &&
      this.root.hidden === false &&
      this.pendingViewport_abyssPrivate !== undefined
    ) {
      const pending = this.pendingViewport_abyssPrivate;
      this.pendingViewport_abyssPrivate = undefined;
      this.scroll.scrollLeft = pending.scrollLeft;
      for (const [key, column] of this.columns_abyssPrivate) {
        const top = pending.columnTops.get(key);
        if (top !== undefined) column.body.scrollTop = top;
      }
    }
    hooks.settleSelection();
  }

  destroy(): void {
    this.pendingViewport_abyssPrivate = undefined;
    this.mounted_abyssPrivate = false;
    this.dragFocusRevision_abyssPrivate += 1;
    this.root.removeEventListener('pointerdown', this.handleBoardInteraction_abyssPrivate, true);
    this.root.removeEventListener('keydown', this.handleBoardInteraction_abyssPrivate, true);
    this.root.ownerDocument.removeEventListener('focusin', this.handleDocumentFocusIn_abyssPrivate);
    this.root.removeEventListener('copy', this.context_abyssPrivate.copy);
    this.root.removeEventListener('paste', this.context_abyssPrivate.paste);
    this.scroll.removeEventListener('scroll', this.activateColumns_abyssPrivate);
    for (const column of this.columns_abyssPrivate.values()) column.viewport.destroy();
    this.columns_abyssPrivate.clear();
    this.cards_abyssPrivate.clear();
    this.visibleCells_abyssPrivate = [];
    this.cells_abyssPrivate = NO_PROJECT_OVERVIEW_CELLS;
    this.drag_abyssPrivate.destroy();
    this.root.remove();
  }

  private captureDragSource_abyssPrivate(cardElement: HTMLElement): ProjectKanbanDropSource {
    const path = cardElement.dataset['projectPath'];
    const card = [...this.cards_abyssPrivate.values()].find(
      (candidate) => candidate.element === cardElement && candidate.project.path === path,
    );
    if (card === undefined) throw new Error('Project card is no longer available');
    const group = this.rowModels_abyssPrivate.get(card.occurrenceId)?.group;
    if (group === undefined) throw new Error('Project group is no longer available');
    const active = this.root.ownerDocument.activeElement;
    const focusedFieldId =
      active instanceof HTMLElement
        ? active.closest<HTMLElement>('[data-column-id]')?.dataset['columnId']
        : undefined;
    const source = captureProjectKanbanDropSource({
      project: card.project,
      fields: this.context_abyssPrivate.modelInput().fields,
      settings: this.context_abyssPrivate.settings(),
      statusProperty: this.context_abyssPrivate.statusProperty(),
      statusKey: card.statusKey,
      group: {
        key: group.key,
        value: group.value,
        ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
      },
    });
    const revision = (this.dragFocusRevision_abyssPrivate += 1);
    if (active instanceof HTMLElement && card.element.contains(active)) {
      this.dragFocus_abyssPrivate.set(source, {
        revision,
        path: card.project.path,
        ...(focusedFieldId === undefined ? {} : { fieldId: focusedFieldId }),
      });
    }
    return source;
  }

  private readonly handleDocumentFocusIn_abyssPrivate = (event: FocusEvent): void => {
    if (event.target instanceof Node && !this.root.contains(event.target)) {
      this.dragFocusRevision_abyssPrivate += 1;
    }
  };

  private readonly handleBoardInteraction_abyssPrivate = (): void => {
    this.dragFocusRevision_abyssPrivate += 1;
  };

  private dropPlan_abyssPrivate(
    source: ProjectKanbanDropSource,
    target: ProjectKanbanDropTarget,
  ): ProjectKanbanDropPlan {
    const project = this.context_abyssPrivate.projectSnapshot(source.projectPath);
    if (project === undefined) return { allowed: false, message: 'Project is no longer available' };
    return planProjectKanbanDrop({
      ...this.context_abyssPrivate.modelInput(),
      project,
      projects: this.context_abyssPrivate.projectsSnapshot(),
      settings: this.context_abyssPrivate.settings(),
      source,
      target,
      statusProperty: this.context_abyssPrivate.statusProperty(),
      membershipQuery: this.context_abyssPrivate.membershipQuery(),
      tagsReliable: this.context_abyssPrivate.tagsReliable(
        source.projectPath,
        this.context_abyssPrivate.settings().groupBy,
      ),
      search: this.search_abyssPrivate,
      rebase: this.context_abyssPrivate.rebaseGroupValue,
      isLiveProjectPath: this.context_abyssPrivate.isLiveProjectPath,
    });
  }

  private destinationCard_abyssPrivate(
    path: string,
    landing: { readonly statusKey: string; readonly groupKey: string } | undefined,
  ): ProjectKanbanOccurrenceContext<TCell> | undefined {
    const cards = [...this.cards_abyssPrivate.values()];
    if (landing !== undefined) {
      const exact = cards.find(
        (candidate) =>
          candidate.project.path === path &&
          candidate.statusKey === landing.statusKey &&
          candidate.groupKey === landing.groupKey,
      );
      if (exact !== undefined) return exact;
      const status = cards.find(
        (candidate) => candidate.project.path === path && candidate.statusKey === landing.statusKey,
      );
      if (status !== undefined) return status;
    }
    return cards.find((candidate) => candidate.project.path === path);
  }

  private async commitDrop_abyssPrivate(
    source: ProjectKanbanDropSource,
    target: ProjectKanbanDropTarget,
  ): Promise<void> {
    const focus = this.dragFocus_abyssPrivate.get(source);
    let landing: { readonly statusKey: string; readonly groupKey: string } | undefined;
    try {
      const result = await this.context_abyssPrivate.commitDrop(() => {
        const plan = this.dropPlan_abyssPrivate(source, target);
        if (!plan.allowed) throw new Error(plan.message);
        landing = { statusKey: target.status.key, groupKey: plan.insertion.groupKey };
        const manualOrder = plan.manualOrder;
        return {
          changes: plan.changes,
          ...(manualOrder === undefined
            ? {}
            : {
                afterApplied: () => {
                  this.context_abyssPrivate.settings().manualOrder[manualOrder.statusKey] = [
                    ...manualOrder.paths,
                  ];
                },
              }),
        };
      });
      const failure = result.failed[0];
      if (failure !== undefined) throw new Error(failure.message);
      if (!this.ownsDragFocus_abyssPrivate(source, focus)) return;
      await this.revealDropDestination_abyssPrivate(source, focus, landing);
      if (!this.ownsDragFocus_abyssPrivate(source, focus)) return;
      const card = this.destinationCard_abyssPrivate(source.projectPath, landing);
      const element =
        focus.fieldId === undefined ? card?.element : card?.cells.get(focus.fieldId)?.element;
      element?.focus({ preventScroll: true });
    } finally {
      this.dragFocus_abyssPrivate.delete(source);
    }
  }

  private async revealDropDestination_abyssPrivate(
    source: ProjectKanbanDropSource,
    focus: DragFocusOwnership,
    landing: { statusKey: string; groupKey: string } | undefined,
  ): Promise<void> {
    const destination = this.model_abyssPrivate?.columns.find(
      (column) =>
        (landing === undefined || column.status.key === landing.statusKey) &&
        column.groups.some((group) =>
          group.projects.some((project) => project.path === source.projectPath),
        ),
    );
    const group = destination?.groups.find(
      (group) =>
        (landing === undefined || group.key === landing.groupKey) &&
        group.projects.some((project) => project.path === source.projectPath),
    );
    if (destination !== undefined && group !== undefined) {
      await this.expandDropColumn_abyssPrivate(destination.status.key, source, focus);
      if (!this.ownsDragFocus_abyssPrivate(source, focus)) return;
      this.collapsedGroups_abyssPrivate.delete(`${destination.status.key}\u0000${group.key}`);
      this.render_abyssPrivate();
      const identity = this.cells_abyssPrivate.identities.find(
        (cell) =>
          cell.projectPath === source.projectPath &&
          cell.occurrenceId ===
            projectKanbanOccurrenceId(destination.status.key, group.key, source.projectPath),
      );
      if (identity !== undefined && this.ownsDragFocus_abyssPrivate(source, focus))
        this.revealCell(identity);
    }
  }

  private async expandDropColumn_abyssPrivate(
    statusKey: string,
    source: ProjectKanbanDropSource,
    focus: DragFocusOwnership,
  ): Promise<void> {
    const collapsed = this.context_abyssPrivate.settings().collapsedColumns;
    if (!collapsed.includes(statusKey)) return;
    await this.context_abyssPrivate.requestViewChange(() => {
      const index = collapsed.indexOf(statusKey);
      if (index >= 0 && this.ownsDragFocus_abyssPrivate(source, focus)) collapsed.splice(index, 1);
    });
  }

  private ownsDragFocus_abyssPrivate(
    source: ProjectKanbanDropSource,
    focus: DragFocusOwnership | undefined,
  ): focus is DragFocusOwnership {
    return (
      focus?.path === source.projectPath &&
      this.context_abyssPrivate.isLiveProjectPath(source.projectPath) &&
      this.context_abyssPrivate.projectSnapshot(source.projectPath) !== undefined &&
      focus.revision === this.dragFocusRevision_abyssPrivate &&
      this.mounted_abyssPrivate &&
      this.root.isConnected &&
      this.root.hidden === false
    );
  }

  syncSelectedProjectPath(path: string | undefined): void {
    this.selectedPath_abyssPrivate = path;
    this.syncSelectedCards_abyssPrivate();
  }

  cells(): ProjectOverviewCells {
    return this.cells_abyssPrivate;
  }

  renderedCells(): readonly TCell[] {
    return this.visibleCells_abyssPrivate;
  }

  revealCell(identity: ProjectTableSelectableCell): void {
    const model = this.rowModels_abyssPrivate.get(identity.occurrenceId);
    if (model === undefined) return;
    const rect = model.column.element.getBoundingClientRect();
    const board = this.scroll.getBoundingClientRect();
    if (rect.left < board.left) this.scroll.scrollLeft += rect.left - board.left;
    else if (rect.right > board.right) this.scroll.scrollLeft += rect.right - board.right;
    model.column.viewport.setActive(true);
    if (model.column.viewport.element(identity.occurrenceId) === undefined)
      model.column.viewport.reveal(identity.occurrenceId);
  }

  scrollCellIntoView(cell: TCell, purpose: 'cell' | 'created-project' = 'cell'): void {
    const body = cell.element.closest<HTMLElement>('.abyss-project-kanban-column-body');
    if (body === null) return;
    const header = this.columnHeader_abyssPrivate(cell.element);
    const card = this.occurrenceElement(cell);
    const cardBox = card.getBoundingClientRect();
    const boardBox = this.scroll.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const usableTop = Math.max(bodyBox.top, header?.getBoundingClientRect().bottom ?? bodyBox.top);
    const fits = cardBox.width <= boardBox.width && cardBox.height <= bodyBox.bottom - usableTop;
    const target = purpose === 'created-project' && fits ? card : cell.element;
    scrollIntoUsableViewport(target, {
      horizontal: this.scroll,
      vertical: body,
      ...(header === undefined ? {} : { header }),
    });
  }

  /** Keeps the current card alive while its picker may be focused outside this board. */
  pinEditorCell(element: HTMLElement): () => void {
    const cell = this.visibleCells_abyssPrivate.find((candidate) => candidate.element === element);
    const key = cell?.identity.occurrenceId;
    const column = key === undefined ? undefined : this.rowModels_abyssPrivate.get(key)?.column;
    if (key === undefined || column?.viewport.element(key)?.contains(element) !== true)
      return () => {};
    return column.viewport.pin(key);
  }

  editorFrame(cell: TCell | undefined): ProjectOverviewEditorFrame {
    const stickyHeader =
      cell === undefined ? undefined : this.columnHeader_abyssPrivate(cell.element);
    return { boundary: this.scroll, ...(stickyHeader === undefined ? {} : { stickyHeader }) };
  }

  occurrenceElement(cell: TCell): HTMLElement {
    return cell.element.closest<HTMLElement>('.abyss-project-kanban-card') ?? cell.element;
  }

  captureViewportBeforeHide(): void {
    if (
      this.root.isConnected &&
      this.scroll.isConnected &&
      this.root.hidden === false &&
      this.mounted_abyssPrivate
    ) {
      this.pendingViewport_abyssPrivate = {
        scrollLeft: this.scroll.scrollLeft,
        columnTops: new Map(
          Array.from(this.columns_abyssPrivate, ([key, column]) => [key, column.body.scrollTop]),
        ),
      };
    }
  }

  private columnHeader_abyssPrivate(element: HTMLElement): HTMLElement | undefined {
    return (
      element
        .closest<HTMLElement>('.abyss-project-kanban-column')
        ?.querySelector<HTMLElement>('.abyss-project-kanban-column-header') ?? undefined
    );
  }

  revealProject(path: string): void {
    const modelColumn = this.model_abyssPrivate?.columns.find((column) =>
      column.groups.some((group) => group.projects.some((project) => project.path === path)),
    );
    const group = modelColumn?.groups.find((candidate) =>
      candidate.projects.some((project) => project.path === path),
    );
    if (modelColumn === undefined || group === undefined) return;
    const card = { statusKey: modelColumn.status.key, groupKey: group.key };
    const settings = this.context_abyssPrivate.settings();
    const collapsedColumn = settings.collapsedColumns.indexOf(card.statusKey);
    if (collapsedColumn >= 0) {
      void this.context_abyssPrivate
        .requestViewChange(() => {
          const current = settings.collapsedColumns.indexOf(card.statusKey);
          if (current >= 0) settings.collapsedColumns.splice(current, 1);
        })
        .catch((error: unknown) => {
          console.error('[abyss-tasks] Could not reveal created project column', error);
        });
    }
    this.collapsedGroups_abyssPrivate.delete(`${card.statusKey}\u0000${card.groupKey}`);
    this.render_abyssPrivate();
    const identity = this.cells_abyssPrivate.identities.find((cell) => cell.projectPath === path);
    if (identity !== undefined) this.revealCell(identity);
  }

  /** Guarded metadata seam used by the native drag adapter. */
  applyChanges(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> {
    return this.context_abyssPrivate.applyChanges(changes);
  }

  projectSnapshot(path: string): Project | undefined {
    return this.context_abyssPrivate.projectSnapshot(path);
  }

  private render_abyssPrivate(): ProjectKanbanModel {
    const focused = this.focusedDescendant_abyssPrivate();
    const settings = this.context_abyssPrivate.settings();
    const model = buildProjectKanbanModel({
      ...this.context_abyssPrivate.modelInput(),
      projects: this.projects_abyssPrivate,
      settings,
      search: this.search_abyssPrivate,
    });
    this.model_abyssPrivate = model;
    this.cells_abyssPrivate = projectKanbanCells({
      model,
      settings,
      fields: this.context_abyssPrivate.modelInput().fields,
      collapsedGroups: this.collapsedGroups_abyssPrivate,
      effectiveField: this.context_abyssPrivate.effectiveField,
    });
    this.cellOrder_abyssPrivate.clear();
    this.cells_abyssPrivate.identities.forEach((identity, index) =>
      this.cellOrder_abyssPrivate.set(`${identity.occurrenceId}\u0000${identity.columnId}`, index),
    );
    this.reconcileWindows_abyssPrivate(model, focused);
    this.reconcileSelectedPath_abyssPrivate();
    this.syncSelectedCards_abyssPrivate();
    this.restoreFocusedDescendant_abyssPrivate(focused);
    return model;
  }

  private reconcileWindows_abyssPrivate(
    model: ProjectKanbanModel,
    focused: HTMLElement | undefined,
  ): void {
    this.updatingWindows_abyssPrivate = true;
    try {
      this.updateWindows_abyssPrivate(model, focused);
    } finally {
      this.updatingWindows_abyssPrivate = false;
    }
  }

  private updateWindows_abyssPrivate(
    model: ProjectKanbanModel,
    focused: HTMLElement | undefined,
  ): void {
    const desiredColumns: HTMLElement[] = [];
    const retainedColumns = new Set<string>();
    this.rowModels_abyssPrivate.clear();
    this.columnRows_abyssPrivate.clear();
    for (const modelColumn of model.columns) {
      retainedColumns.add(modelColumn.status.key);
      const column = this.reconcileColumn_abyssPrivate(modelColumn);
      desiredColumns.push(column.element);
      this.columnRows_abyssPrivate.set(
        column.key,
        this.projectRows_abyssPrivate(column, modelColumn),
      );
    }
    // Transfer same-project/group ownership before either column reconciles its new rows.
    for (const card of this.cards_abyssPrivate.values()) {
      const destination = [...this.rowModels_abyssPrivate].find(
        ([, value]) =>
          value.project?.path === card.project.path && value.group.key === card.groupKey,
      );
      if (destination === undefined || destination[1].column.key === card.statusKey) continue;
      const row = this.columnRows_abyssPrivate
        .get(destination[1].column.key)
        ?.find((candidate) => candidate.key === destination[0]);
      if (row !== undefined)
        this.columns_abyssPrivate
          .get(card.statusKey)
          ?.viewport.transferTo(destination[1].column.viewport, card.occurrenceId, row);
    }
    this.reconcileOrder_abyssPrivate(this.scroll, desiredColumns);
    for (const column of this.columns_abyssPrivate.values()) {
      column.viewport.update(this.columnRows_abyssPrivate.get(column.key) ?? [], true);
    }
    this.restoreFocusedDescendant_abyssPrivate(focused);
    this.activateColumns_abyssPrivate();
    this.removeMissingColumns_abyssPrivate(retainedColumns);
    this.mountedChanged_abyssPrivate();
  }

  private focusedDescendant_abyssPrivate(): HTMLElement | undefined {
    const active = this.root.ownerDocument.activeElement;
    return active instanceof HTMLElement && this.root.contains(active) ? active : undefined;
  }

  private restoreFocusedDescendant_abyssPrivate(focused: HTMLElement | undefined): void {
    if (focused === undefined) return;
    const active = this.root.ownerDocument.activeElement;
    if (this.focusMovedOutsideBoard_abyssPrivate(active)) return;
    if (this.focusedCardVisible_abyssPrivate(focused)) {
      if (active !== focused) focused.focus({ preventScroll: true });
      return;
    }
    this.focusFallback_abyssPrivate().focus({ preventScroll: true });
  }

  private focusMovedOutsideBoard_abyssPrivate(active: Element | null): boolean {
    return (
      active instanceof HTMLElement &&
      active !== this.root.ownerDocument.body &&
      !this.root.contains(active)
    );
  }

  private focusedCardVisible_abyssPrivate(focused: HTMLElement): boolean {
    const card = focused.closest<HTMLElement>('.abyss-project-kanban-card');
    return (
      focused.isConnected &&
      (card === null ||
        this.visibleCells_abyssPrivate.some(({ element }) => card.contains(element)))
    );
  }

  private focusFallback_abyssPrivate(): HTMLElement {
    const selected = this.selectedPath_abyssPrivate;
    return (
      this.visibleCells_abyssPrivate.find(({ identity }) => identity.projectPath === selected)
        ?.element ??
      this.visibleCells_abyssPrivate[0]?.element ??
      this.scroll
    );
  }

  private removeMissingColumns_abyssPrivate(retained: ReadonlySet<string>): void {
    for (const [key, column] of this.columns_abyssPrivate) {
      if (retained.has(key)) continue;
      column.viewport.destroy();
      column.element.remove();
      this.columns_abyssPrivate.delete(key);
    }
  }

  private reconcileSelectedPath_abyssPrivate(): void {
    const selected = this.selectedPath_abyssPrivate;
    if (selected === undefined) return;
    const survives = this.cells_abyssPrivate.identities.some(
      (identity) => identity.projectPath === selected,
    );
    if (!survives) this.selectedPath_abyssPrivate = undefined;
  }

  private reconcileColumn_abyssPrivate(model: ProjectKanbanColumn): RenderedColumn<TCell> {
    const key = model.status.key;
    let column = this.columns_abyssPrivate.get(key);
    if (column === undefined) {
      column = this.createColumn_abyssPrivate(model);
      this.columns_abyssPrivate.set(key, column);
    }
    Reflect.set(column.element, '__abyssKanbanGroups', model.groups);
    column.statusKey = key;
    column.value = model.status.statusId;
    column.element.dataset['statusKey'] = key;
    column.element.dataset['statusValue'] = model.status.statusId ?? '';
    column.label.setText(model.status.label);
    column.count.setText(String(model.uniqueVisibleCount));
    column.create.hidden = model.status.statusId === null;
    column.create.setAttribute('aria-label', `Create project in ${model.status.label}`);
    column.marker.style.removeProperty('background-color');
    if (model.status.color !== undefined) column.marker.style.backgroundColor = model.status.color;
    const collapsed = this.context_abyssPrivate.settings().collapsedColumns.includes(key);
    column.element.toggleClass('is-collapsed', collapsed);
    column.element.toggleClass(
      'is-compact-empty',
      model.uniqueVisibleCount === 0 &&
        this.context_abyssPrivate.settings().emptyColumns === 'compact',
    );
    column.collapse.setAttribute(
      'aria-label',
      `${collapsed ? 'Expand' : 'Collapse'} ${model.status.label}`,
    );
    column.collapse.empty();
    setIcon(column.collapse, collapsed ? 'chevron-right' : 'chevron-left');
    return column;
  }

  private createColumn_abyssPrivate(model: ProjectKanbanColumn): RenderedColumn<TCell> {
    const key = model.status.key;
    const element = this.scroll.createDiv({ cls: 'abyss-project-kanban-column' });
    const header = element.createDiv({ cls: 'abyss-project-kanban-column-header' });
    const marker = header.createSpan({ cls: 'abyss-status-dot' });
    const label = header.createSpan({ cls: 'abyss-project-kanban-column-label' });
    const count = header.createSpan({ cls: 'abyss-project-kanban-column-count' });
    const create = header.createEl('button', {
      cls: 'clickable-icon abyss-project-kanban-column-create',
      attr: { type: 'button' },
    });
    setIcon(create, 'plus');
    const collapse = header.createEl('button', {
      cls: 'clickable-icon abyss-project-kanban-column-toggle',
      attr: { type: 'button' },
    });
    const body = element.createDiv({ cls: 'abyss-project-kanban-column-body' });
    const content = body.createDiv({ cls: 'abyss-project-kanban-window' });
    const viewport = new ProjectKanbanColumnViewport({
      host: content,
      scroll: body,
      mount: (host, row, markdown) => this.mountRow_abyssPrivate(host, row, markdown),
      mountedChanged: () => {
        this.mountedChanged_abyssPrivate();
      },
      reportFailure: (error) => {
        this.context_abyssPrivate.reportRenderFailure(error);
      },
    });
    viewport.setActive(false);
    const column: RenderedColumn<TCell> = {
      key,
      element,
      header,
      marker,
      label,
      count,
      create,
      collapse,
      body,
      content,
      viewport,
      groups: new Map(),
      statusKey: key,
      value: model.status.statusId,
    };
    this.bindColumnActions_abyssPrivate(column);
    return column;
  }

  private bindColumnActions_abyssPrivate(column: RenderedColumn<TCell>): void {
    column.collapse.addEventListener('click', () => {
      this.toggleColumn_abyssPrivate(column);
    });
    column.create.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    column.create.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    column.create.addEventListener('click', (event) => {
      event.stopPropagation();
      const statusId = column.value;
      if (typeof statusId === 'string') {
        this.context_abyssPrivate.createProject(column.create, statusId);
      }
    });
  }

  private toggleColumn_abyssPrivate(column: RenderedColumn<TCell>): void {
    this.context_abyssPrivate
      .requestViewChange(() => {
        const collapsed = this.context_abyssPrivate.settings().collapsedColumns;
        const index = collapsed.indexOf(column.key);
        if (index < 0) collapsed.push(column.key);
        else collapsed.splice(index, 1);
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] Could not change project board view', error);
      });
  }

  private projectRows_abyssPrivate(
    column: RenderedColumn<TCell>,
    model: ProjectKanbanColumn,
  ): KanbanViewportRow[] {
    const rows: KanbanViewportRow[] = [];
    const settings = this.context_abyssPrivate.settings();
    const grouped = settings.groupBy !== 'none' && settings.groupBy !== 'status';
    for (const group of model.groups) {
      const groupKey = `${column.key}\u0000${group.key}`;
      if (grouped || group.projects.length === 0) {
        const key = `header:${groupKey}`;
        rows.push({
          kind: 'group',
          key,
          groupKey: group.key,
          estimatedHeight: grouped ? 37 : 8,
          measurementRevision: JSON.stringify([group.label, group.projects.length]),
        });
        this.rowModels_abyssPrivate.set(key, { column, group });
      }
      if (this.collapsedGroups_abyssPrivate.has(groupKey)) continue;
      this.appendCardRows_abyssPrivate(rows, column, group);
    }
    return rows;
  }

  private appendCardRows_abyssPrivate(
    rows: KanbanViewportRow[],
    column: RenderedColumn<TCell>,
    group: ProjectTableGroup,
  ): void {
    const settings = this.context_abyssPrivate.settings();
    const fields = this.context_abyssPrivate.modelInput().fields;
    for (const project of group.projects) {
      const key = projectKanbanOccurrenceId(column.key, group.key, project.path);
      rows.push({
        kind: 'card',
        key,
        groupKey: group.key,
        projectPath: project.path,
        estimatedHeight: 96 + projectKanbanCardFields(project, settings, fields).length * 28,
        measurementRevision: JSON.stringify([
          project,
          settings.fields,
          settings.descriptionLines,
          settings.progress,
          settings.showEmptyFields,
          settings.showEmptyProgress,
        ]),
      });
      this.rowModels_abyssPrivate.set(key, { column, group, project });
    }
  }

  private mountRow_abyssPrivate(
    host: HTMLElement,
    row: KanbanViewportRow,
    markdown: Component,
  ): KanbanRowMount {
    const initial = this.rowModels_abyssPrivate.get(row.key);
    if (initial === undefined) throw new Error('Project row is no longer available');
    const group = this.createGroup_abyssPrivate(initial.column, row.key, initial.group, host);
    group.element.addClass('abyss-project-kanban-window-row');
    const card =
      initial.project === undefined
        ? undefined
        : this.createCard_abyssPrivate(
            projectKanbanCardKey(row.groupKey, initial.project.path),
            group,
            initial.project,
            markdown,
          );
    const update = (next: KanbanViewportRow): void => {
      const current = this.rowModels_abyssPrivate.get(next.key);
      if (current === undefined) return;
      group.statusKey = current.column.key;
      group.groupKey = current.group.key;
      group.value = current.group.value;
      group.element.dataset['groupKey'] = current.group.key;
      if (current.group.sourcePath !== undefined)
        group.element.dataset['sourcePath'] = current.group.sourcePath;
      else delete group.element.dataset['sourcePath'];
      Reflect.set(group.element, '__abyssGroupValue', current.group.value);
      this.patchGroup_abyssPrivate(group, current.group, next.kind === 'group', markdown);
      if (card !== undefined && current.project !== undefined) {
        card.project = current.project;
        card.statusKey = current.column.key;
        card.groupKey = current.group.key;
        card.occurrenceId = next.key;
        card.element.dataset['projectPath'] = current.project.path;
        card.element.dataset['occurrenceId'] = next.key;
        this.patchCard_abyssPrivate(card, []);
      }
    };
    update(row);
    if (card !== undefined) this.cards_abyssPrivate.set(card.key, card);
    return {
      element: group.element,
      update,
      destroy: () => {
        if (card !== undefined) {
          card.cells.clear();
          this.cards_abyssPrivate.delete(card.key);
        }
        group.element.remove();
      },
    };
  }

  private mountedChanged_abyssPrivate(): void {
    const mounted: Array<{ cell: TCell; order: number }> = [];
    for (const card of this.cards_abyssPrivate.values())
      for (const cell of card.cells.values()) {
        const order = this.cellOrder_abyssPrivate.get(
          `${cell.identity.occurrenceId}\u0000${cell.identity.columnId}`,
        );
        if (order !== undefined) mounted.push({ cell, order });
      }
    mounted.sort((a, b) => a.order - b.order);
    this.visibleCells_abyssPrivate = mounted.map(({ cell }) => cell);
    this.syncSelectedCards_abyssPrivate();
    if (!this.updatingWindows_abyssPrivate) {
      this.context_abyssPrivate.windowRendered();
      this.activateColumns_abyssPrivate();
    }
  }

  private readonly activateColumns_abyssPrivate = (): void => {
    const columns = [...this.columns_abyssPrivate.values()];
    const rect = this.scroll.getBoundingClientRect();
    const fallback = Math.max(
      0,
      columns.findIndex((column) => !column.element.matches('.is-compact-empty, .is-collapsed')),
    );
    const visible = columns.flatMap((column, index) => {
      const box = column.element.getBoundingClientRect();
      if (rect.width === 0) return index === fallback ? [index] : [];
      return box.right > rect.left && box.left < rect.right ? [index] : [];
    });
    const firstVisible = visible[0] ?? 0;
    const lastVisible = visible[visible.length - 1] ?? 0;
    const first = lastVisible === columns.length - 1 ? Math.max(0, firstVisible - 1) : firstVisible;
    const last = Math.min(columns.length - 1, (visible[visible.length - 1] ?? 0) + 1);
    columns.forEach((column, index) => {
      column.viewport.setActive(
        this.root.hidden === false &&
          ((index >= first && index <= last) ||
            column.element.contains(this.root.ownerDocument.activeElement)) &&
          !column.element.matches('.is-collapsed, .is-compact-empty'),
      );
    });
  };

  private hitTest_abyssPrivate(
    x: number,
    y: number,
    source: ProjectKanbanDropSource,
  ): { target: ProjectKanbanDropTarget; lineHost: HTMLElement; lineTop: number } | undefined {
    const matches = [...this.columns_abyssPrivate.values()].filter((column) => {
      const rect = column.element.getBoundingClientRect();
      return (
        rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    });
    const column = matches.length === 1 ? matches[0] : undefined;
    if (column === undefined) return undefined;
    const target: ProjectKanbanDropTarget = {
      status: { key: column.statusKey, value: column.value },
    };
    if (column.element.matches('.is-collapsed, .is-compact-empty'))
      return { target, lineHost: column.content, lineTop: 0 };
    const contentTop = column.content.getBoundingClientRect().top;
    const insertion = column.viewport.insertion(y - contentTop, source.projectPath);
    const group = this.model_abyssPrivate?.columns
      .find((candidate) => candidate.status.key === column.key)
      ?.groups.find((candidate) => candidate.key === insertion?.groupKey);
    return {
      target: {
        ...target,
        ...kanbanGroupTarget(group),
        ...(insertion?.beforePath === undefined ? {} : { beforePath: insertion.beforePath }),
      },
      lineHost: column.content,
      lineTop: insertion?.top ?? 0,
    };
  }

  private createGroup_abyssPrivate(
    column: RenderedColumn<TCell>,
    key: string,
    model: ProjectTableGroup,
    host: HTMLElement,
  ): ProjectKanbanGroupContext<TCell> {
    const element = host.createDiv({ cls: 'abyss-project-kanban-group' });
    const header = element.createEl('button', {
      cls: 'abyss-project-kanban-group-header',
      attr: { type: 'button' },
    });
    const group: ProjectKanbanGroupContext<TCell> = {
      key,
      element,
      header,
      chevron: header.createSpan({ cls: 'abyss-project-kanban-group-chevron' }),
      marker: header.createSpan({ cls: 'abyss-status-dot' }),
      label: header.createSpan({ cls: 'abyss-projects-group-label' }),
      count: header.createSpan({ cls: 'abyss-projects-group-count' }),
      body: element.createDiv({ cls: 'abyss-project-kanban-group-body' }),
      cards: new Map(),
      statusKey: column.key,
      groupKey: model.key,
      value: model.value,
    };
    header.addEventListener('click', (event) => {
      this.toggleGroup_abyssPrivate(event, `${group.statusKey}\u0000${group.groupKey}`);
    });
    return group;
  }

  private toggleGroup_abyssPrivate(event: MouseEvent, key: string): void {
    if (event.target instanceof Element && event.target.closest('a') !== null) return;
    this.context_abyssPrivate
      .requestViewChange(() => {
        if (this.collapsedGroups_abyssPrivate.has(key))
          this.collapsedGroups_abyssPrivate.delete(key);
        else this.collapsedGroups_abyssPrivate.add(key);
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] Could not change project board view', error);
      });
  }

  private patchGroup_abyssPrivate(
    group: ProjectKanbanGroupContext<TCell>,
    model: ProjectTableGroup,
    grouped: boolean,
    markdown: Component,
  ): boolean {
    const collapsed = this.collapsedGroups_abyssPrivate.has(
      `${group.statusKey}\u0000${group.groupKey}`,
    );
    group.header.hidden = !grouped;
    group.header.setAttribute('aria-expanded', String(!collapsed));
    group.chevron.empty();
    setIcon(group.chevron, collapsed ? 'chevron-right' : 'chevron-down');
    if (grouped)
      this.context_abyssPrivate.renderGroupContent(group.marker, group.label, model, markdown);
    group.count.setText(String(model.projects.length));
    group.body.hidden = collapsed;
    return collapsed;
  }

  private createCard_abyssPrivate(
    key: string,
    group: ProjectKanbanGroupContext<TCell>,
    project: Project,
    markdown: Component,
  ): RenderedCard<TCell> {
    const element = group.body.createDiv({
      cls: 'abyss-project-kanban-card',
      attr: { tabindex: '0', draggable: 'true' },
    });
    const title = element.createDiv({ cls: 'abyss-project-kanban-title' });
    const description = element.createDiv({ cls: 'abyss-project-kanban-description' });
    const descriptionContent = description.createDiv({
      cls: 'abyss-project-kanban-description-content',
    });
    const card: RenderedCard<TCell> = {
      markdown,
      key,
      element,
      title,
      description,
      descriptionContent,
      fields: element.createDiv({ cls: 'abyss-project-kanban-fields' }),
      progress: element.createDiv({ cls: 'abyss-project-kanban-progress' }),
      cells: new Map(),
      project,
      occurrenceId: '',
      statusKey: group.statusKey,
      groupKey: group.groupKey,
    };
    element.addEventListener('click', (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          'a, button, input, textarea, select, .abyss-project-cell-editor, .abyss-project-kanban-cell',
        ) !== null
      )
        return;
      this.selectCard_abyssPrivate(card);
    });
    element.addEventListener('focus', () => {
      this.selectCard_abyssPrivate(card);
    });
    return card;
  }

  private selectCard_abyssPrivate(card: RenderedCard<TCell>): void {
    this.selectedPath_abyssPrivate = card.project.path;
    const cell = card.cells.get('name') ?? card.cells.values().next().value;
    if (cell !== undefined) this.context_abyssPrivate.selectCell(cell);
    this.syncSelectedCards_abyssPrivate();
  }

  private syncSelectedCards_abyssPrivate(): void {
    for (const card of this.cards_abyssPrivate.values()) {
      card.element.toggleClass('is-selected', card.project.path === this.selectedPath_abyssPrivate);
    }
  }

  private patchCard_abyssPrivate(card: RenderedCard<TCell>, visibleCells: TCell[]): void {
    const settings = this.context_abyssPrivate.settings();
    const fields = this.context_abyssPrivate.modelInput().fields;
    const retained = new Set<string>();
    const context = { fields, settings, retained, visibleCells };
    this.patchTitle_abyssPrivate(card, context);
    this.patchDescription_abyssPrivate(card, context);
    this.patchMetadataFields_abyssPrivate(card, context);
    this.patchProgress_abyssPrivate(card, context);
    this.removeUnusedCells_abyssPrivate(card, retained);
  }

  private patchTitle_abyssPrivate(
    card: RenderedCard<TCell>,
    context: PatchCardContext<TCell>,
  ): void {
    const titleField = findProjectFieldById(context.fields, 'name');
    if (titleField === undefined) return;
    context.retained.add('name');
    context.visibleCells.push(
      this.reconcileCell_abyssPrivate(card, card.title, titleField, undefined),
    );
  }

  private patchDescription_abyssPrivate(
    card: RenderedCard<TCell>,
    context: PatchCardContext<TCell>,
  ): void {
    const { settings } = context;
    const descriptionField = findProjectFieldById(context.fields, 'description');
    const description = projectKanbanDescription(card.project, descriptionField);
    card.description.hidden = settings.descriptionLines === 0 || description.length === 0;
    card.description.toggleClass('is-full', settings.descriptionLines === 'full');
    if (settings.descriptionLines === 'full') {
      card.description.style.removeProperty('--abyss-project-description-lines');
    } else {
      card.description.style.setProperty(
        '--abyss-project-description-lines',
        String(settings.descriptionLines),
      );
    }
    if (!card.description.hidden && descriptionField !== undefined) {
      context.retained.add('description');
      const cell = this.reconcileCell_abyssPrivate(
        card,
        card.descriptionContent,
        descriptionField,
        undefined,
      );
      context.visibleCells.push(cell);
    }
  }

  private patchMetadataFields_abyssPrivate(
    card: RenderedCard<TCell>,
    context: PatchCardContext<TCell>,
  ): void {
    const { settings } = context;
    const desiredFields: HTMLElement[] = [];
    for (const item of projectKanbanCardFields(card.project, settings, context.fields)) {
      context.retained.add(item.field.id);
      const row =
        card.cells.get(item.field.id)?.element.parentElement ??
        card.fields.createDiv({ cls: 'abyss-project-kanban-field' });
      row.className = 'abyss-project-kanban-field';
      let label = row.querySelector<HTMLElement>('.abyss-project-kanban-field-label');
      label ??= row.createSpan({ cls: 'abyss-project-kanban-field-label' });
      label.setText(item.label);
      let value = row.querySelector<HTMLElement>('.abyss-project-kanban-field-value');
      value ??= row.createDiv({ cls: 'abyss-project-kanban-field-value' });
      try {
        const cell = this.reconcileCell_abyssPrivate(card, value, item.field, item.column);
        context.visibleCells.push(cell);
        desiredFields.push(row);
      } catch (error) {
        if (!card.cells.has(item.field.id)) row.remove();
        throw error;
      }
    }
    this.reconcileOrder_abyssPrivate(card.fields, desiredFields);
  }

  private patchProgress_abyssPrivate(
    card: RenderedCard<TCell>,
    context: PatchCardContext<TCell>,
  ): void {
    const { settings } = context;
    const progressField = findProjectFieldById(context.fields, 'progress');
    const progress = projectProgress(card.project.stats);
    const showProgress =
      settings.progress !== 'hidden' && (progress.percent !== null || settings.showEmptyProgress);
    card.progress.hidden = !showProgress;
    card.progress.toggleClass('is-bar-only', settings.progress === 'bar');
    if (showProgress && progressField !== undefined) {
      context.retained.add('progress');
      const cell = this.reconcileCell_abyssPrivate(card, card.progress, progressField, undefined);
      context.visibleCells.push(cell);
    }
  }

  private removeUnusedCells_abyssPrivate(
    card: RenderedCard<TCell>,
    retained: ReadonlySet<string>,
  ): void {
    for (const [fieldId, cell] of card.cells) {
      if (retained.has(fieldId)) continue;
      if (cell.element === card.descriptionContent || cell.element === card.progress) continue;
      this.context_abyssPrivate.releaseCell(cell);
      const row = cell.element.closest('.abyss-project-kanban-field');
      if (row !== null) row.remove();
      else cell.element.empty();
      card.cells.delete(fieldId);
    }
  }

  private reconcileCell_abyssPrivate(
    card: RenderedCard<TCell>,
    host: HTMLElement,
    field: ProjectFieldCatalogItem,
    column: ProjectColumn | undefined,
  ): TCell {
    const existing = card.cells.get(field.id);
    const cell = this.context_abyssPrivate.renderCell({
      host,
      markdown: card.markdown,
      project: card.project,
      field,
      column,
      occurrenceId: card.occurrenceId,
      groupKey: card.groupKey,
      ...(existing === undefined ? {} : { existing }),
    });
    card.cells.set(field.id, cell);
    return cell;
  }

  private reconcileOrder_abyssPrivate(host: HTMLElement, desired: readonly HTMLElement[]): void {
    let cursor = host.firstChild;
    for (const element of desired) {
      if (element === cursor) cursor = cursor.nextSibling;
      else host.insertBefore(element, cursor);
    }
  }
}

function kanbanGroupTarget(
  group: ProjectTableGroup | undefined,
): Pick<ProjectKanbanDropTarget, 'group'> {
  if (group === undefined) return {};
  return {
    group: {
      key: group.key,
      value: group.value,
      ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
    },
  };
}
