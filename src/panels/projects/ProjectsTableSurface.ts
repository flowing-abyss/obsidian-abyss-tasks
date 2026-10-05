import { Component } from 'obsidian';
import type { ProjectFieldCatalogItem, ProjectTableSettings } from '../../projects/projectFields';
import {
  projectGroupCollapseKey,
  setProjectGroupCollapsed,
} from '../../projects/projectGroupCollapse';
import type { ProjectValuePresentation } from '../../projects/projectPropertyDefinitions';
import {
  buildProjectTableModel,
  type ProjectTableGroup,
  type ProjectTableModel,
  type ProjectTableModelInput,
} from '../../projects/projectTableModel';
import { effectiveProjectTableDateDisplay } from '../../projects/projectTableSettings';
import type { Project } from '../../projects/types';
import {
  writeClass,
  writeIcon,
  writeOptionalAttribute,
  writeText,
} from '../../ui/guardedDomWrites';
import type { ProjectGroupDropForecast } from './projectGroupDropPreview';
import {
  NO_PROJECT_OVERVIEW_CELLS,
  projectTableCells,
  projectTableOccurrenceId,
  type ProjectOverviewCells,
  type ProjectOverviewFieldResolver,
  type ProjectTableRow,
} from './projectOverviewCells';
import {
  cellContaining,
  nearestViewportDelta,
  type ProjectOverviewEditorFrame,
  type ProjectOverviewRenderHooks,
  type ProjectsOverviewSurface,
  type RenderedCellContext,
} from './ProjectsOverviewSurface';
import {
  projectTableColumnWidth,
  renderProjectTableColumns,
  type ProjectTableColumnOptions,
  type VisibleProjectColumn,
} from './projectTableColumns';
import type { ProjectTableDragGroup } from './projectTableDrag';
import type { ProjectTableSelectableCell } from './projectTableSelection';
import { ProjectTableViewport } from './projectTableViewport';

export const PROJECT_TABLE_ROW_DRAG_TYPE = 'application/x-abyss-project-table-row';

export interface ProjectRowDragPayload {
  readonly version: 1;
  readonly projectPath: string;
  readonly occurrenceId: string;
  readonly sourceGroupKey: string;
}

interface GroupDropPreview {
  readonly payload: ProjectRowDragPayload | undefined;
  readonly targetGroupKey: string;
  readonly revision: number;
  readonly allowed: boolean;
  readonly message: string;
  readonly rows: readonly HTMLTableRowElement[];
  readonly forecast?: ProjectGroupDropForecast;
  readonly line?: HTMLTableRowElement;
}

/** Marks the last row of each run of drop target rows, which draws the run's bottom edge. */
function markDropRunEnds(rows: readonly RenderedProjectRow[], state: string): void {
  for (const { element } of rows) {
    element.toggleClass('is-drop-end', element.nextElementSibling?.hasClass(state) !== true);
  }
}

type ResizeObserverConstructor = new (callback: ResizeObserverCallback) => ResizeObserver;

interface FocusedCellIdentity {
  readonly occurrenceId: string | undefined;
  readonly columnId: string | undefined;
}

export interface RenderedGroupContext extends ProjectTableDragGroup {
  label: string;
}

export interface RenderedProjectRow {
  readonly markdown: Component;
  readonly element: HTMLTableRowElement;
  readonly cells: Map<string, RenderedCellContext>;
  dragCleanup?: () => void;
  project: Project;
  groupKey: string;
  occurrenceId: string;
}

export interface RenderedGroupRow {
  readonly markdown: Component;
  readonly element: HTMLTableRowElement;
  readonly cell: HTMLTableCellElement;
  readonly button: HTMLButtonElement;
  readonly chevron: HTMLElement;
  readonly statusDot: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly dropHint: HTMLElement;
  context: RenderedGroupContext;
  contentSignature: string;
}

function visibleRowCells(
  row: RenderedProjectRow,
  columns: readonly VisibleProjectColumn[],
): RenderedCellContext[] {
  const cells: RenderedCellContext[] = [];
  for (const { column } of columns) {
    const cell = row.cells.get(column.id);
    if (cell !== undefined) cells.push(cell);
  }
  return cells;
}

interface RenderGroupOptions {
  readonly body: HTMLTableSectionElement;
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly columnCount: number;
  readonly statuses: ProjectTableModel['availableStatusGroups'];
  readonly value: unknown;
  readonly sourcePath?: string;
  readonly presentation?: ProjectValuePresentation;
}

interface RenderProjectRowOptions {
  readonly body: HTMLTableSectionElement;
  readonly project: Project;
  readonly columns: readonly VisibleProjectColumn[];
  readonly group: ProjectTableModel['groups'][number];
  readonly grouped: boolean;
}

interface ReconciledBodyRows {
  readonly desired: HTMLTableRowElement[];
  readonly retainedProjects: Set<string>;
  readonly retainedGroups: Set<string>;
  readonly cells: RenderedCellContext[];
}

export interface ReconcileProjectCellOptions {
  readonly row: RenderedProjectRow;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly columnId: string;
  readonly occurrenceId: string;
  readonly groupKey: string;
  readonly grouped: boolean;
}

/** Where a group header's status dot and label render, and the component its links load in. */
interface GroupContentTarget {
  readonly onFailure: () => void;
  readonly marker: HTMLElement;
  readonly host: HTMLElement;
  readonly component: Component;
}

/** The header's commands; the surface adds the columns, the sort, the date display, and resize. */
type ProjectTableColumnActions = Omit<
  ProjectTableColumnOptions,
  'columns' | 'sort' | 'dateDisplay' | 'onResizePreview'
>;

/** Validation and submission stay with the overview controller. */
interface ProjectTableRowDrag {
  hasActiveEditor(): boolean;
  beginProjectDrag(): () => void;
  previewGroupDrop(
    payload: ProjectRowDragPayload | undefined,
    targetGroupKey: string,
    currentTargetPaths: readonly string[],
    targetCollapsed: boolean,
  ): {
    readonly allowed: boolean;
    readonly message: string;
    readonly forecast?: ProjectGroupDropForecast;
  };
  commitGroupDrop(
    dataTransfer: DataTransfer,
    active: ProjectRowDragPayload | undefined,
    targetGroupKey: string,
  ): void;
}

/** What the Table surface reads from the overview controller. */
export interface ProjectsTableSurfaceContext {
  /** The overview root: the scroll mounts in it, and it carries `is-name-unpinned`. */
  readonly root: HTMLElement;
  /** The parent of each row's Markdown component. */
  readonly markdown: Component;
  /** Whether the overview is mounted and shows the Table; scroll and resize work only then. */
  readonly isActive: () => boolean;
  /** Whether the saved `groupBy` groups, which gives the Table header rows and collapse. */
  readonly grouped: () => boolean;
  /** The saved Table settings, which the header reads its sort and date display from. */
  readonly tableSettings: () => ProjectTableSettings;
  /** The visible columns; the controller also prepares their presets and relative dates. */
  readonly columns: () => readonly VisibleProjectColumn[];
  /** The model input apart from the projects and search that a render passes in. */
  readonly modelInput: () => Omit<ProjectTableModelInput, 'projects' | 'search'>;
  readonly effectiveField: ProjectOverviewFieldResolver;
  /** Creates or patches one cell of a row with the controller's cell renderer. */
  readonly reconcileCell: (options: ReconcileProjectCellOptions) => RenderedCellContext;
  readonly releaseCell: (cell: RenderedCellContext) => void;
  readonly renderGroupContent: (
    target: GroupContentTarget,
    group: Pick<ProjectTableGroup, 'key' | 'label' | 'value' | 'sourcePath' | 'presentation'>,
    color: string | undefined,
  ) => void;
  readonly columnActions: ProjectTableColumnActions;
  readonly copy: (event: ClipboardEvent) => void;
  readonly paste: (event: ClipboardEvent) => void;
  readonly rowDrag: ProjectTableRowDrag;
  /** Runs an action once the open editor has finished, as a group toggle does. */
  readonly changeViewState: (mutation: () => void) => void;
  /** Renders the overview again. */
  readonly render: () => void;
  /** Runs after each window pass, so the rows it mounted show the selection. */
  readonly windowRendered: () => void;
  readonly reportRenderFailure: (error: unknown) => void;
}

/**
 * The Table view of the projects overview: its scroll, header, and bounded window of group and
 * project rows, the logical cells of every expanded row, and the viewport that keeps them.
 */
export class ProjectsTableSurface implements ProjectsOverviewSurface<RenderedCellContext> {
  readonly scroll: HTMLElement;
  #activeRowDrag: ProjectRowDragPayload | undefined;
  #groupDropPreview: GroupDropPreview | undefined;
  #groupDropRevision = 0;
  readonly #context: ProjectsTableSurfaceContext;
  readonly #host: HTMLElement;
  #columnCleanup: (() => void) | undefined;
  readonly #viewport = new ProjectTableViewport();
  #spacers = new Map<string, HTMLTableRowElement>();
  #rowsDirty = false;
  #model: ProjectTableModel | undefined;
  #rows: readonly ProjectTableRow[] = [];
  #pendingViewport: { scrollTop: number; scrollLeft: number } | undefined;
  #cells: ProjectOverviewCells = NO_PROJECT_OVERVIEW_CELLS;
  #projects: readonly Project[] = [];
  #search = '';
  #renderedCells: RenderedCellContext[] = [];
  readonly #renderedGroups = new Map<string, RenderedGroupContext>();
  readonly #renderedProjectRows = new Map<string, RenderedProjectRow>();
  readonly #renderedGroupRows = new Map<string, RenderedGroupRow>();
  #table: HTMLTableElement | undefined;
  #body: HTMLTableSectionElement | undefined;
  #headerSignature = '';
  #columnResizePreview = false;
  #visibleColumns: readonly VisibleProjectColumn[] = [];
  #resizeObserver: ResizeObserver | undefined;
  #owner: Window | null = null;
  #nativeCleanup: (() => void) | undefined;
  #frame: number | undefined;
  #generation = 0;
  #layout = '';
  #layoutRevision = 0;
  #layoutDirty = true;
  #failed = false;
  #destroyed = false;

  constructor(context: ProjectsTableSurfaceContext) {
    this.#context = context;
    this.scroll = context.root.createDiv({
      cls: 'abyss-project-table-scroll',
      attr: { tabindex: '-1' },
    });
    this.scroll.addEventListener('scroll', this.#renderWindow);
    this.#host = this.scroll.createDiv({
      cls: 'abyss-project-table-host',
    });
  }

  show(): void {
    this.scroll.hidden = false;
  }

  hide(): void {
    this.scroll.hidden = true;
    this.#unbind();
  }

  /**
   * Publishes the toolbar and count before measuring, since the toolbar height sets the window's
   * scroll height, then settles the selection before restoring scroll and focus.
   */
  render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void {
    this.#failed = false;
    this.#guard(() => {
      this.#render(projects, search, hooks);
    });
  }

  #render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void {
    this.#bind();
    this.#projects = projects;
    this.#search = search;
    const availableWidth = this.scroll.clientWidth;
    const canRender = this.#canRender(availableWidth);
    const pending = canRender ? this.#pendingViewport : undefined;
    const scrollLeft = pending?.scrollLeft ?? this.scroll.scrollLeft;
    const focusedIdentity = this.#focusedCellIdentity();

    const columns = this.#context.columns();
    const model = buildProjectTableModel({ ...this.#context.modelInput(), projects, search });
    hooks.publish(model);

    const table = this.#table ?? this.#createTable();
    this.#reconcileHeader(table, columns);
    this.#applyWidth(availableWidth);
    this.#renderBody(table, model, columns, availableWidth);
    this.#updateResponsiveNamePinning(availableWidth);
    if (canRender)
      this.#finishReconciliation(hooks, this.scroll.scrollTop, scrollLeft, focusedIdentity);
    else hooks.settleSelection();
  }

  cells(): ProjectOverviewCells {
    return this.#cells;
  }

  renderedCells(): readonly RenderedCellContext[] {
    return this.#renderedCells;
  }

  /** Scrolls an offscreen row into the window, which mounts it. */
  revealCell(identity: ProjectTableSelectableCell): void {
    this.#guard(() => {
      this.#revealCell(identity);
    });
  }

  #revealCell(identity: ProjectTableSelectableCell): void {
    this.#bind();
    this.#renderVisible(this.scroll.scrollTop);
    const top = this.#viewport.reveal(
      identity.occurrenceId,
      this.scroll.scrollTop,
      this.#viewportHeight(),
    );
    this.#renderVisible(top);
  }

  /** Scrolls a mounted cell below the sticky header and right of a pinned Name column. */
  scrollCellIntoView({ element: cell }: RenderedCellContext): void {
    const viewport = this.scroll.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    const header = this.#host.querySelector<HTMLElement>('.abyss-project-table-header-cell');
    const pinnedName = this.#context.root.classList.contains('is-name-unpinned')
      ? null
      : this.#host.querySelector<HTMLElement>('.abyss-project-table-name-cell');
    const usableTop = Math.max(
      viewport.top,
      header?.getBoundingClientRect().bottom ?? viewport.top,
    );
    const usableLeft =
      pinnedName === null || cell.classList.contains('abyss-project-table-name-cell')
        ? viewport.left
        : Math.max(viewport.left, pinnedName.getBoundingClientRect().right);
    const horizontal = nearestViewportDelta(target.left, target.right, usableLeft, viewport.right);
    const vertical = nearestViewportDelta(target.top, target.bottom, usableTop, viewport.bottom);
    this.scroll.scrollLeft = Math.max(0, this.scroll.scrollLeft + horizontal);
    this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop + vertical);
  }

  /** An editor stays inside the scroll and below the table header, whatever its cell. */
  editorFrame(): ProjectOverviewEditorFrame {
    const stickyHeader = this.#table?.tHead ?? undefined;
    return { boundary: this.scroll, ...(stickyHeader === undefined ? {} : { stickyHeader }) };
  }

  /** Opens the project's group if it is collapsed, and then renders the overview again. */
  revealProject(path: string): void {
    const model = buildProjectTableModel({
      ...this.#context.modelInput(),
      projects: this.#projects,
      search: this.#search,
    });
    const group = model.groups.find(({ projects }) =>
      projects.some((project) => project.path === path),
    );
    if (group !== undefined && this.isGroupCollapsed(group.key)) {
      this.#context.changeViewState(() => {
        this.#setGroupCollapsed(group.key, false);
      });
    }
  }

  occurrenceElement(cell: RenderedCellContext): HTMLElement {
    return cell.element.closest<HTMLElement>('.abyss-project-table-row') ?? cell.element;
  }

  syncSelectedProjectPath(): void {
    // The Table shows its selection on the cells; no row carries a selected mark.
  }

  captureViewportBeforeHide(): void {
    if (this.scroll.isConnected && this.#context.isActive() && this.scroll.hidden === false) {
      this.#pendingViewport = {
        scrollTop: this.scroll.scrollTop,
        scrollLeft: this.scroll.scrollLeft,
      };
      this.#unbind();
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#unbind();
    this.#pendingViewport = undefined;
    this.#clearGroupDropStates();
    this.#activeRowDrag = undefined;
    this.#renderedCells = [];
    this.#renderedGroups.clear();
    this.#destroyViewport();
    this.#columnCleanup?.();
    this.#columnCleanup = undefined;
  }

  /** A rendered group, which controller validation reads during a row drag. */
  group(key: string): RenderedGroupContext | undefined {
    return this.#renderedGroups.get(key);
  }

  /** A mounted group header row, which the drop preview marks. */
  groupRow(key: string): RenderedGroupRow | undefined {
    return this.#renderedGroupRows.get(key);
  }

  isGroupCollapsed(key: string): boolean {
    const field = this.#context.modelInput().settings.groupBy;
    return (
      this.#context
        .tableSettings()
        .collapsedGroups?.includes(projectGroupCollapseKey(field, key)) ?? false
    );
  }

  #setGroupCollapsed(key: string, collapsed: boolean): void {
    const settings = this.#context.tableSettings();
    settings.collapsedGroups = setProjectGroupCollapsed(
      settings.collapsedGroups,
      projectGroupCollapseKey(this.#context.modelInput().settings.groupBy, key),
      collapsed,
    );
  }

  /** Reconciles the window again, as a finished row drag does. */
  renderWindow(): void {
    this.#renderWindow();
  }

  /** The mounted project rows of a group in body order, which the drop preview marks. */
  displayedGroupRows(groupKey: string): RenderedProjectRow[] {
    const rows: RenderedProjectRow[] = [];
    for (const element of this.#body?.rows ?? []) {
      const occurrenceId = element.dataset['occurrenceId'];
      if (occurrenceId === undefined) continue;
      const row = this.#renderedProjectRows.get(occurrenceId);
      if (row?.groupKey === groupKey) rows.push(row);
    }
    return rows;
  }

  #guard(action: () => void): void {
    if (this.#destroyed || this.#failed) return;
    try {
      action();
    } catch (error) {
      this.#failed = true;
      this.#renderedCells = this.#renderedCells.filter((cell) => cell.element.isConnected);
      this.#context.reportRenderFailure(error);
    }
  }

  #bind(): void {
    if (
      this.#destroyed ||
      !this.scroll.isConnected ||
      this.scroll.hidden === true ||
      !this.#context.isActive()
    )
      return;
    const owner = this.scroll.ownerDocument.defaultView;
    if (owner === this.#owner) return;
    this.#unbind();
    this.#owner = owner;
    if (owner === null) return;
    const fonts = Reflect.get(owner.document, 'fonts') as FontFaceSet | undefined;
    const generation = this.#generation;
    const schedule = (): void => {
      if (generation !== this.#generation || this.#destroyed || this.#frame !== undefined) return;
      this.#frame = owner.requestAnimationFrame(() => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#frame = undefined;
        this.#guard(() => {
          this.#handleResize();
        });
      });
    };
    const fontChanged = (): void => {
      if (generation !== this.#generation) return;
      this.#layoutDirty = true;
      schedule();
    };
    owner.addEventListener('resize', schedule);
    fonts?.addEventListener('loadingdone', fontChanged);
    this.#nativeCleanup = () => {
      owner.removeEventListener('resize', schedule);
      fonts?.removeEventListener('loadingdone', fontChanged);
    };
    const Observer = Reflect.get(owner, 'ResizeObserver') as ResizeObserverConstructor | undefined;
    if (Observer !== undefined) {
      this.#resizeObserver = new Observer(schedule);
      this.#resizeObserver.observe(this.scroll);
      if (this.#table !== undefined) this.#resizeObserver.observe(this.#table);
    }
  }

  #unbind(): void {
    this.#generation++;
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#nativeCleanup?.();
    this.#nativeCleanup = undefined;
    this.#owner = null;
    this.#layoutDirty = true;
  }

  #handleResize(): void {
    if (!this.#context.isActive() || this.scroll.hidden === true || !this.scroll.isConnected)
      return;
    const availableWidth = this.scroll.clientWidth;
    // Width reset after a cancelled preview also applies while layout is suspended.
    if (!this.#columnResizePreview) this.#applyWidth(availableWidth);
    if (this.scroll.clientHeight <= 0 || availableWidth <= 0) {
      this.#layoutDirty = true;
      return;
    }
    this.#bind();
    this.#renderVisible(this.scroll.scrollTop, availableWidth);
    this.#updateResponsiveNamePinning(availableWidth);
  }

  #checkLayout(top: number, availableWidth: number): number {
    const table = this.#table;
    if (
      table === undefined ||
      this.#owner === null ||
      availableWidth <= 0 ||
      this.scroll.clientHeight <= 0
    )
      return top;
    const style = this.#owner.getComputedStyle(table);
    const signature = JSON.stringify([
      availableWidth,
      [...table.querySelectorAll<HTMLElement>('col')].map((col) => col.style.width),
      style.fontFamily,
      style.fontSize,
      style.lineHeight,
      style.fontWeight,
      style.fontStyle,
      style.letterSpacing,
    ]);
    if (!this.#layoutDirty && signature === this.#layout) return top;
    const anchor = this.#viewport.captureAnchor(Math.max(0, top));
    this.#layout = signature;
    this.#layoutDirty = false;
    this.#layoutRevision++;
    this.#replaceGeometry();
    return top + this.#viewport.restoreAnchor(anchor, Math.max(0, top)) - Math.max(0, top);
  }

  #replaceGeometry(): void {
    this.#viewport.replace(
      this.#rows.map(({ key, project }) => ({ key, height: project === undefined ? 32 : 34 })),
      String(this.#layoutRevision),
    );
  }

  #destroyViewport(): void {
    this.scroll.removeEventListener('scroll', this.#renderWindow);
    this.#removeMissingRows(new Set(), new Set());
    this.#model = undefined;
    this.#rows = [];
    this.#cells = NO_PROJECT_OVERVIEW_CELLS;
    this.#viewport.replace([]);
    this.#spacers.clear();
    this.#renderedProjectRows.clear();
    this.#renderedGroupRows.clear();
  }

  #finishReconciliation(
    hooks: ProjectOverviewRenderHooks,
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    hooks.settleSelection();
    this.#restorePosition(scrollTop, scrollLeft, focusedIdentity);
  }

  #createTable(): HTMLTableElement {
    const table = this.#host.createEl('table', {
      cls: 'abyss-project-table',
    });
    this.#table = table;
    this.#resizeObserver?.observe(table);
    table.addEventListener('copy', (event) => {
      this.#context.copy(event);
    });
    table.addEventListener('paste', (event) => {
      this.#context.paste(event);
    });
    return table;
  }

  #reconcileHeader(table: HTMLTableElement, columns: readonly VisibleProjectColumn[]): void {
    const tableSettings = this.#context.tableSettings();
    const signature = JSON.stringify({
      columns: columns.map(({ column, field }) => ({
        id: column.id,
        label: column.label ?? field.label,
        width: projectTableColumnWidth(column, field),
        type: field.type,
        alignment: column.alignment ?? 'left',
      })),
      sort: tableSettings.sortBy,
    });
    this.#visibleColumns = columns;
    if (signature === this.#headerSignature) return;
    this.#headerSignature = signature;
    this.#columnCleanup?.();
    table.querySelector(':scope > colgroup')?.remove();
    table.querySelector(':scope > thead')?.remove();
    this.#columnCleanup = renderProjectTableColumns(table, {
      ...this.#context.columnActions,
      columns,
      sort: tableSettings.sortBy,
      dateDisplay: (column) => effectiveProjectTableDateDisplay(tableSettings, column),
      onResizePreview: (active) => {
        this.#columnResizePreview = active;
      },
    });
    const colgroup = table.querySelector(':scope > colgroup');
    if (colgroup !== null) table.insertBefore(colgroup, table.firstChild);
    const head = table.querySelector(':scope > thead');
    if (head !== null && this.#body !== undefined) {
      table.insertBefore(head, this.#body);
    }
  }

  #renderBody(
    table: HTMLTableElement,
    model: ProjectTableModel,
    columns: readonly VisibleProjectColumn[],
    availableWidth: number,
  ): void {
    const body = this.#body ?? table.createEl('tbody');
    this.#body = body;
    this.#rowsDirty = true;
    this.#model = model;
    this.#renderedGroups.clear();
    for (const group of model.groups) this.#renderedGroups.set(group.key, group);
    const { rows, cells } = projectTableCells({
      model,
      grouped: this.#context.grouped(),
      columns,
      collapsedGroups: new Set(
        model.groups.filter(({ key }) => this.isGroupCollapsed(key)).map(({ key }) => key),
      ),
      effectiveField: this.#context.effectiveField,
    });
    this.#rows = rows;
    this.#cells = cells;
    this.#replaceGeometry();
    const top = this.#canRender(availableWidth)
      ? this.#viewport.window(this.scroll.scrollTop, this.#viewportHeight(), []).scrollTop
      : this.scroll.scrollTop;
    this.#renderVisible(top, availableWidth);
  }

  #viewportHeight(): number {
    const height = this.scroll.clientHeight;
    const header = this.#table?.tHead?.getBoundingClientRect().height ?? 0;
    const headerHeight = Number.isFinite(header) ? header : 0;
    return height > 0 ? Math.max(1, height - headerHeight) : 0;
  }

  readonly #renderWindow = (): void => {
    this.#guard(() => {
      this.#renderVisible(this.scroll.scrollTop);
    });
  };

  #canRender(availableWidth: number): boolean {
    return (
      this.scroll.isConnected &&
      this.scroll.hidden === false &&
      this.#context.isActive() &&
      availableWidth > 0 &&
      this.scroll.clientHeight > 0
    );
  }

  #resumeViewport(requestedTop: number): number {
    const pending = this.#pendingViewport;
    if (pending === undefined) return requestedTop;
    this.scroll.scrollLeft = pending.scrollLeft;
    this.#pendingViewport = undefined;
    return pending.scrollTop;
  }

  #renderVisible(requestedTop: number, availableWidth = this.scroll.clientWidth): void {
    const body = this.#body;
    const model = this.#model;
    if (!this.#canRender(availableWidth) || body === undefined || model === undefined) {
      if (!this.scroll.isConnected) this.#unbind();
      return;
    }
    this.#bind();
    const pinned = this.#pinnedRows();
    let top = this.#checkLayout(this.#resumeViewport(requestedTop), availableWidth);
    let extentChanged = false;
    // Extent is reconciled before a real correction; ordinary native scroll is never normalized.
    for (let pass = 0; pass < 2; pass++) {
      const window = this.#viewport.window(top, this.#viewportHeight(), pinned);
      const mounted = this.#reconcileWindow(body, model, window.segments);
      const correction = this.#viewport.measure(
        mounted.map(({ key, element }) => ({
          key,
          height: element.getBoundingClientRect().height,
        })),
        Math.max(0, top),
      );
      extentChanged = correction.changed;
      if (!correction.changed) break;
      top += correction.scrollTop - Math.max(0, top);
    }
    if (extentChanged)
      this.#reconcileWindow(
        body,
        model,
        this.#viewport.window(top, this.#viewportHeight(), pinned).segments,
      );
    if (top !== this.scroll.scrollTop) this.scroll.scrollTop = top;
    this.#rowsDirty = false;
    this.#context.windowRendered();
  }

  #reconcileWindow(
    body: HTMLTableSectionElement,
    model: ProjectTableModel,
    segments: ReturnType<ProjectTableViewport['window']>['segments'],
  ): Array<{ key: string; element: HTMLTableRowElement }> {
    const rows: ReconciledBodyRows = {
      desired: [],
      retainedProjects: new Set(),
      retainedGroups: new Set(),
      cells: [],
    };
    const mounted: Array<{ key: string; element: HTMLTableRowElement }> = [];
    const spacers = new Map<string, HTMLTableRowElement>();
    for (const [index, segment] of segments.entries()) {
      if ('height' in segment) {
        const key = this.#spacerKey(segments[index + 1]);
        const spacer = this.#reconcileSpacer(body, key, segment.height);
        spacers.set(key, spacer);
        rows.desired.push(spacer);
        continue;
      }
      const item = this.#rows[segment.index];
      if (item === undefined) continue;
      const element = this.#mountRow(body, item, model, rows);
      mounted.push({ key: item.key, element });
    }
    if (model.uniqueVisibleCount === 0) {
      const row = body.createEl('tr');
      row.createEl('td', {
        cls: 'abyss-projects-empty',
        text: this.#projects.length === 0 ? 'No projects yet' : 'No matching projects',
        attr: { colspan: String(Math.max(1, this.#visibleColumns.length)) },
      });
      rows.desired.push(row);
    }
    this.#removeMissingRows(rows.retainedProjects, rows.retainedGroups);
    this.#reconcileRowOrder(body, rows.desired);
    this.#spacers = spacers;
    this.#renderedCells = rows.cells;

    return mounted;
  }

  #spacerKey(
    next: ReturnType<ProjectTableViewport['window']>['segments'][number] | undefined,
  ): string {
    // A gap stays immediately before the same logical row; the empty key is the trailing gap.
    return next !== undefined && 'index' in next ? (this.#rows[next.index]?.key ?? '') : '';
  }

  #reconcileSpacer(
    body: HTMLTableSectionElement,
    key: string,
    height: number,
  ): HTMLTableRowElement {
    const row =
      this.#spacers.get(key) ??
      body.createEl('tr', {
        cls: 'abyss-project-table-spacer',
        attr: { 'aria-hidden': 'true' },
      });
    const cell = row.cells[0] ?? row.createEl('td');
    const columnCount = Math.max(1, this.#visibleColumns.length);
    if (cell.colSpan !== columnCount) cell.colSpan = columnCount;
    const heightStyle = `${height}px`;
    if (cell.style.height !== heightStyle) cell.style.height = heightStyle;
    return row;
  }

  #pinnedRows(): string[] {
    const pinned: string[] = [];
    const dragged = this.#activeRowDrag?.occurrenceId;
    if (dragged !== undefined) pinned.push(dragged);
    for (const [key, row] of this.#renderedProjectRows) {
      if (row.element.querySelector('.is-editor-anchor, .is-editing') !== null) pinned.push(key);
    }
    return pinned;
  }

  #mountRow(
    body: HTMLTableSectionElement,
    item: ProjectTableRow,
    model: ProjectTableModel,
    rows: ReconciledBodyRows,
  ): HTMLTableRowElement {
    const { project, group } = item;
    const columns = this.#visibleColumns;
    let element: HTMLTableRowElement;
    if (project === undefined) {
      rows.retainedGroups.add(group.key);
      const existing = this.#renderedGroupRows.get(group.key);
      element =
        existing !== undefined && !this.#rowsDirty
          ? existing.element
          : this.#reconcileGroupRow({
              body,
              ...group,
              count: group.projects.length,
              columnCount: columns.length,
              statuses: model.availableStatusGroups,
            });
    } else {
      const existing = this.#renderedProjectRows.get(item.key);
      const row =
        existing !== undefined && !this.#rowsDirty
          ? existing
          : this.#reconcileProjectRow({
              body,
              project,
              columns,
              group,
              grouped: this.#context.grouped(),
            });
      rows.retainedProjects.add(item.key);
      element = row.element;
      rows.cells.push(...visibleRowCells(row, columns));
    }
    rows.desired.push(element);
    return element;
  }

  #restorePosition(
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    this.scroll.scrollTop = scrollTop;
    this.scroll.scrollLeft = scrollLeft;
    if (focusedIdentity?.occurrenceId === undefined || focusedIdentity.columnId === undefined)
      return;
    const restored = this.#findOccurrenceCell(
      focusedIdentity.occurrenceId,
      focusedIdentity.columnId,
    );
    if (restored === null) this.scroll.focus({ preventScroll: true });
    else restored.focus({ preventScroll: true });
  }

  #reconcileGroupRow(options: RenderGroupOptions): HTMLTableRowElement {
    const { key } = options;
    const existing = this.#renderedGroupRows.get(key);
    const rendered = existing ?? this.#createGroupRow(options);
    try {
      return this.#patchGroupRow(rendered, options);
    } catch (error) {
      rendered.contentSignature = '';
      if (existing === undefined) {
        this.#context.markdown.removeChild(rendered.markdown);
        rendered.element.remove();
        this.#renderedGroupRows.delete(key);
      }
      throw error;
    }
  }

  #patchGroupRow(rendered: RenderedGroupRow, options: RenderGroupOptions): HTMLTableRowElement {
    const { key, label, value, sourcePath, count, columnCount, statuses, presentation } = options;
    rendered.context = { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) };
    writeOptionalAttribute(rendered.element, 'data-group-key', key);
    const colSpan = Math.max(1, columnCount);
    if (rendered.cell.colSpan !== colSpan) rendered.cell.colSpan = colSpan;
    writeOptionalAttribute(rendered.button, 'data-group-key', key);
    const collapsed = this.isGroupCollapsed(key);
    writeClass(rendered.element, 'is-collapsed', collapsed);
    writeOptionalAttribute(rendered.button, 'aria-expanded', String(!collapsed));
    const chevronIcon = collapsed ? 'chevron-right' : 'chevron-down';
    writeIcon(rendered.chevron, chevronIcon);
    const status = statuses.find((candidate) => candidate.key === key);
    const color = status?.color ?? presentation?.color;
    const signature = JSON.stringify([label, value, sourcePath, color, presentation?.display]);
    if (signature !== rendered.contentSignature)
      this.#patchGroupContent(rendered, options, color, signature);
    writeText(rendered.count, String(count));
    return rendered.element;
  }

  #createGroupRow(options: RenderGroupOptions): RenderedGroupRow {
    const { body, key, label, value, sourcePath } = options;
    const row = body.createEl('tr', { cls: 'abyss-project-table-group-row' });
    const cell = row.createEl('td');
    const button = cell.createEl('button', {
      cls: 'abyss-project-table-group-toggle',
      attr: { type: 'button', 'data-group-key': key },
    });
    const rendered: RenderedGroupRow = {
      markdown: this.#context.markdown.addChild(new Component()),
      element: row,
      cell,
      button,
      chevron: button.createSpan({ cls: 'abyss-project-table-group-chevron' }),
      statusDot: button.createSpan({ cls: 'abyss-status-dot' }),
      label: button.createSpan({ cls: 'abyss-projects-group-label' }),
      count: button.createSpan({ cls: 'abyss-projects-group-count' }),
      dropHint: button.createSpan({ cls: 'abyss-project-table-drop-hint' }),
      context: { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) },
      contentSignature: '',
    };
    this.#renderedGroupRows.set(key, rendered);
    this.#bindGroupRow(rendered);
    return rendered;
  }

  #patchGroupContent(
    rendered: RenderedGroupRow,
    options: RenderGroupOptions,
    color: string | undefined,
    signature: string,
  ): void {
    rendered.contentSignature = signature;
    this.#context.renderGroupContent(
      {
        marker: rendered.statusDot,
        host: rendered.label,
        component: rendered.markdown,
        onFailure: () => {
          rendered.contentSignature = '';
        },
      },
      options,
      color,
    );
  }

  #bindGroupRow(rendered: RenderedGroupRow): void {
    const { element: row, cell } = rendered;
    cell.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      const key = rendered.context.key;
      this.#context.changeViewState(() => {
        this.#setGroupCollapsed(key, !this.isGroupCollapsed(key));
      });
    });
    this.#bindGroupDropTarget(row, () => rendered.context.key);
  }

  #removeMissingRows(
    retainedProjects: ReadonlySet<string>,
    retainedGroups: ReadonlySet<string>,
  ): void {
    for (const [key, rendered] of this.#renderedProjectRows) {
      if (retainedProjects.has(key)) continue;
      rendered.dragCleanup?.();
      this.#context.markdown.removeChild(rendered.markdown);
      rendered.element.remove();
      this.#renderedProjectRows.delete(key);
    }
    for (const [key, rendered] of this.#renderedGroupRows) {
      if (retainedGroups.has(key)) continue;
      this.#context.markdown.removeChild(rendered.markdown);
      rendered.element.remove();
      this.#renderedGroupRows.delete(key);
    }
  }

  #reconcileRowOrder(body: HTMLTableSectionElement, desired: readonly HTMLTableRowElement[]): void {
    // Remove obsolete gaps before ordering so retained rows never move around stale cursors.
    // Moving a focused/editor/drag row, even within this body, triggers native blur/drag teardown.
    const retained = new Set<Node>(desired);
    for (const child of Array.from(body.childNodes)) {
      if (!retained.has(child)) child.remove();
    }
    let cursor = body.firstChild;
    for (const row of desired) {
      if (row === cursor) cursor = cursor.nextSibling;
      else body.insertBefore(row, cursor);
    }
  }

  #applyWidth(availableWidth = this.scroll.clientWidth): void {
    const table = this.#table;
    if (table === undefined) return;
    const widths = this.#visibleColumns.map(({ column, field }) =>
      projectTableColumnWidth(column, field),
    );
    const configuredWidth = widths.reduce((total, width) => total + width, 0);
    const spare = Math.max(0, availableWidth - configuredWidth);
    const cols = new Map(
      Array.from(table.querySelectorAll<HTMLElement>('col[data-column-id]'), (col) => [
        col.dataset['columnId'],
        col,
      ]),
    );
    for (const [index, { column }] of this.#visibleColumns.entries()) {
      const col = cols.get(column.id);
      const width = `${(widths[index] ?? 150) + (column.id === 'name' ? spare : 0)}px`;
      if (col !== undefined && col.style.width !== width) col.style.width = width;
    }
    const renderedWidth = configuredWidth + spare;
    const width = `${renderedWidth}px`;
    if (table.style.width !== width) table.style.width = width;
    if (table.style.minWidth !== width) table.style.minWidth = width;
  }

  #focusedCellIdentity(): FocusedCellIdentity | undefined {
    const active = this.#host.ownerDocument.activeElement;
    const focusedCell = cellContaining(this.#renderedCells, active);
    if (focusedCell === undefined) return undefined;
    return {
      occurrenceId: focusedCell.identity.occurrenceId,
      columnId: focusedCell.identity.columnId,
    };
  }

  #updateResponsiveNamePinning(available = this.scroll.clientWidth): void {
    const nameColumn = this.#host.querySelector<HTMLElement>('col[data-column-id="name"]');
    const width = nameColumn === null ? 0 : Number.parseFloat(nameColumn.style.width);
    const shouldUnpin = available > 0 && Number.isFinite(width) && available - width < 160;
    this.#context.root.toggleClass('is-name-unpinned', shouldUnpin);
  }

  #reconcileProjectRow(options: RenderProjectRowOptions): RenderedProjectRow {
    const { project, group, grouped } = options;
    const occurrenceId = projectTableOccurrenceId(group.key, project.path);
    const existing = this.#renderedProjectRows.get(occurrenceId);
    const renderedRow =
      existing ?? this.#createProjectRow(options.body, project, group.key, occurrenceId);
    try {
      renderedRow.project = project;
      renderedRow.groupKey = group.key;
      renderedRow.occurrenceId = occurrenceId;
      const row = renderedRow.element;
      writeOptionalAttribute(row, 'data-project-path', project.path);
      writeOptionalAttribute(row, 'data-occurrence-id', occurrenceId);
      writeOptionalAttribute(row, 'data-group-key', group.key);
      if (row.draggable !== grouped) row.draggable = grouped;
      this.#reconcileProjectCells(renderedRow, options, occurrenceId);
      return renderedRow;
    } catch (error) {
      if (existing === undefined) {
        renderedRow.dragCleanup?.();
        this.#context.markdown.removeChild(renderedRow.markdown);
        renderedRow.element.remove();
        this.#renderedProjectRows.delete(occurrenceId);
      }
      throw error;
    }
  }

  #createProjectRow(
    body: HTMLTableSectionElement,
    project: Project,
    groupKey: string,
    occurrenceId: string,
  ): RenderedProjectRow {
    const rendered: RenderedProjectRow = {
      markdown: this.#context.markdown.addChild(new Component()),
      element: body.createEl('tr', { cls: 'abyss-project-table-row' }),
      cells: new Map(),
      project,
      groupKey,
      occurrenceId,
    };
    this.#renderedProjectRows.set(occurrenceId, rendered);
    rendered.dragCleanup = this.#bindProjectRowDrag(rendered);
    return rendered;
  }

  #reconcileProjectCells(
    row: RenderedProjectRow,
    options: RenderProjectRowOptions,
    occurrenceId: string,
  ): void {
    const { project, columns, group, grouped } = options;
    const desiredCells: HTMLElement[] = [];
    const retainedColumns = new Set<string>();
    for (const { column, field: rawField } of columns) {
      retainedColumns.add(column.id);
      const rendered = this.#context.reconcileCell({
        row,
        project,
        field: rawField,
        columnId: column.id,
        occurrenceId,
        groupKey: group.key,
        grouped,
      });
      desiredCells.push(rendered.element);
    }
    for (const [columnId, cell] of row.cells) {
      if (retainedColumns.has(columnId)) continue;
      this.#context.releaseCell(cell);
      cell.element.remove();
      row.cells.delete(columnId);
    }
    let cursor = row.element.firstChild;
    for (const cell of desiredCells) {
      if (cell === cursor) cursor = cursor.nextSibling;
      else row.element.insertBefore(cell, cursor);
    }
  }

  #findOccurrenceCell(occurrenceId: string, columnId: string): HTMLElement | null {
    return (
      this.#renderedCells.find(
        ({ identity }) => identity.occurrenceId === occurrenceId && identity.columnId === columnId,
      )?.element ?? null
    );
  }
  invalidateDragPreview(): void {
    this.#clearGroupDropStates();
    this.#groupDropRevision++;
  }

  #bindProjectRowDrag(rendered: RenderedProjectRow): () => void {
    const row = rendered.element;
    let suppressClick = false;
    let clickTimer: number | undefined;
    const ownerWindow = row.ownerDocument.defaultView;
    let releaseDrag: (() => void) | undefined;
    let gestureTarget: EventTarget | null = null;
    let gestureCleanup: (() => void) | undefined;
    const clearGesture = (): void => {
      gestureCleanup?.();
      gestureCleanup = undefined;
      gestureTarget = null;
    };
    const rememberGesture = (event: PointerEvent): void => {
      clearGesture();
      gestureTarget = event.target;
      const ownerDocument = row.ownerDocument;
      const finishGesture = (): void => {
        clearGesture();
      };
      gestureCleanup = () => {
        ownerDocument.removeEventListener('pointerup', finishGesture, true);
        ownerDocument.removeEventListener('pointercancel', finishGesture, true);
      };
      ownerDocument.addEventListener('pointerup', finishGesture, true);
      ownerDocument.addEventListener('pointercancel', finishGesture, true);
    };
    const startDrag = (event: DragEvent): void => {
      const origin = gestureTarget ?? event.target;
      clearGesture();
      releaseDrag = this.#startProjectRowDrag(rendered, event, origin);
      if (releaseDrag === undefined) return;
      suppressClick = true;
    };
    const finishDrag = (): void => {
      clearGesture();
      row.removeClass('is-dragging');
      this.#activeRowDrag = undefined;
      this.#clearGroupDropStates();
      releaseDrag?.();
      releaseDrag = undefined;
      ownerWindow?.clearTimeout(clickTimer);
      clickTimer = ownerWindow?.setTimeout(() => {
        suppressClick = false;
        clickTimer = undefined;
      }, 0);
      this.renderWindow();
    };
    const suppressDraggedClick = (event: MouseEvent): void => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const dropCleanup = this.#bindGroupDropTarget(row, () => rendered.groupKey);
    row.addEventListener('pointerdown', rememberGesture, true);
    row.addEventListener('dragstart', startDrag);
    row.addEventListener('dragend', finishDrag);
    row.addEventListener('click', suppressDraggedClick, true);
    return () => {
      ownerWindow?.clearTimeout(clickTimer);
      clearGesture();
      row.removeClass('is-dragging');
      dropCleanup();
      row.removeEventListener('pointerdown', rememberGesture, true);
      row.removeEventListener('dragstart', startDrag);
      row.removeEventListener('dragend', finishDrag);
      row.removeEventListener('click', suppressDraggedClick, true);
      releaseDrag?.();
      releaseDrag = undefined;
    };
  }

  #startProjectRowDrag(
    rendered: RenderedProjectRow,
    event: DragEvent,
    origin: EventTarget | null,
  ): (() => void) | undefined {
    const row = rendered.element;
    if (!row.draggable || this.#isProtectedRowDragTarget(origin, row)) {
      event.preventDefault();
      return;
    }
    const dataTransfer = event.dataTransfer;
    if (dataTransfer === null) return;
    const payload: ProjectRowDragPayload = {
      version: 1,
      projectPath: rendered.project.path,
      occurrenceId: rendered.occurrenceId,
      sourceGroupKey: rendered.groupKey,
    };
    dataTransfer.setData(PROJECT_TABLE_ROW_DRAG_TYPE, JSON.stringify(payload));
    dataTransfer.effectAllowed = 'move';
    const release = this.#context.rowDrag.beginProjectDrag();
    this.#activeRowDrag = payload;
    row.addClass('is-dragging');
    return release;
  }

  #isProtectedRowDragTarget(target: EventTarget | null, row: HTMLTableRowElement): boolean {
    const ownerWindow = row.ownerDocument.defaultView;
    if (
      this.#context.rowDrag.hasActiveEditor() ||
      ownerWindow === null ||
      !(target instanceof ownerWindow.Element)
    )
      return true;
    const action = target.closest(
      'a, input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor, button',
    );
    if (action === null || !row.contains(action)) return false;
    return !action.classList.contains('abyss-project-table-name');
  }

  #bindGroupDropTarget(row: HTMLTableRowElement, groupKey: () => string): () => void {
    const previewDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      const preview = this.#showGroupDropPreview(groupKey());
      event.dataTransfer.dropEffect = preview.allowed ? 'move' : 'none';
    };
    const leaveDropTarget = (event: DragEvent): void => {
      const related = event.relatedTarget;
      const ownerWindow = row.ownerDocument.defaultView;
      if (
        ownerWindow === null ||
        !(related instanceof ownerWindow.Element) ||
        related.closest<HTMLElement>('[data-group-key]')?.dataset['groupKey'] !== groupKey()
      ) {
        this.#clearGroupDropStates();
      }
    };
    const drop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      this.#clearGroupDropStates();
      const active = this.#activeRowDrag;
      this.#activeRowDrag = undefined;
      this.#context.rowDrag.commitGroupDrop(event.dataTransfer, active, groupKey());
    };
    row.addEventListener('dragenter', previewDrop);
    row.addEventListener('dragover', previewDrop);
    row.addEventListener('dragleave', leaveDropTarget);
    row.addEventListener('drop', drop);
    return () => {
      this.#clearGroupDropStates();
      row.removeEventListener('dragenter', previewDrop);
      row.removeEventListener('dragover', previewDrop);
      row.removeEventListener('dragleave', leaveDropTarget);
      row.removeEventListener('drop', drop);
    };
  }

  #showGroupDropPreview(targetGroupKey: string): GroupDropPreview {
    const payload = this.#activeRowDrag;
    const current = this.#cachedGroupDropPreview(payload, targetGroupKey);
    if (current !== undefined) return current;
    this.#clearGroupDropStates();
    const targetRows = this.displayedGroupRows(targetGroupKey);
    const groupRow = this.groupRow(targetGroupKey);
    const result = this.#context.rowDrag.previewGroupDrop(
      payload,
      targetGroupKey,
      targetRows.map(({ project }) => project.path),
      this.isGroupCollapsed(targetGroupKey),
    );
    const rows = [groupRow?.element, ...targetRows.map(({ element }) => element)].filter(
      (row) => row !== undefined,
    );
    const state = result.allowed ? 'is-drop-target' : 'is-drop-disabled';
    for (const row of rows) {
      row.addClass(state);
      row.setAttribute('title', result.message);
    }
    markDropRunEnds(targetRows, state);
    groupRow?.dropHint.setText(result.message);
    const line = this.#groupDropLine(result.forecast, targetRows, groupRow);
    line?.addClass(result.forecast?.kind === 'before' ? 'is-drop-before' : 'is-drop-after');
    const preview: GroupDropPreview = {
      payload,
      targetGroupKey,
      revision: this.#groupDropRevision,
      ...result,
      rows,
      ...(line === undefined ? {} : { line }),
    };
    this.#groupDropPreview = preview;
    return preview;
  }

  #cachedGroupDropPreview(
    payload: ProjectRowDragPayload | undefined,
    targetGroupKey: string,
  ): GroupDropPreview | undefined {
    const current = this.#groupDropPreview;
    if (current === undefined) return undefined;
    return current.payload === payload &&
      current.targetGroupKey === targetGroupKey &&
      current.revision === this.#groupDropRevision
      ? current
      : undefined;
  }

  #groupDropLine(
    forecast: ProjectGroupDropForecast | undefined,
    targetRows: readonly RenderedProjectRow[],
    groupRow: RenderedGroupRow | undefined,
  ): HTMLTableRowElement | undefined {
    if (forecast === undefined) return undefined;
    if (forecast.kind === 'before') {
      const before = targetRows.find(({ project }) => project.path === forecast.projectPath);
      return before?.element;
    }
    if (forecast.kind !== 'append') return undefined;
    return targetRows[targetRows.length - 1]?.element ?? groupRow?.element;
  }

  #clearGroupDropStates(): void {
    const preview = this.#groupDropPreview;
    if (preview === undefined) return;
    this.#groupDropPreview = undefined;
    for (const row of preview.rows) {
      row.removeClass('is-drop-target', 'is-drop-disabled', 'is-drop-end');
      row.removeAttribute('title');
    }
    preview.line?.removeClass('is-drop-before', 'is-drop-after');
    this.groupRow(preview.targetGroupKey)?.dropHint.empty();
  }
}
