import { Component } from 'obsidian';
import type { ProjectFieldCatalogItem, ProjectTableSettings } from '../../projects/projectFields';
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
  readonly marker: HTMLElement;
  readonly host: HTMLElement;
  readonly component: Component;
}

/** The header's commands; the surface adds the columns, the sort, the date display, and resize. */
type ProjectTableColumnActions = Omit<
  ProjectTableColumnOptions,
  'columns' | 'sort' | 'dateDisplay' | 'onResizePreview'
>;

/** Row drag and group drop, which the controller keeps; the surface binds them to its rows. */
interface ProjectTableRowDrag {
  bindRow(row: RenderedProjectRow): () => void;
  bindGroupDropTarget(row: HTMLTableRowElement, groupKey: () => string): () => void;
  /** The occurrence of the row being dragged, which stays mounted until the drag ends. */
  draggedOccurrence(): string | undefined;
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
  readonly finishEditorBefore: (action: () => void) => void;
  /** Renders the overview again. */
  readonly render: () => void;
  /** Runs after each window pass, so the rows it mounted show the selection. */
  readonly windowRendered: () => void;
}

/**
 * The Table view of the projects overview: its scroll, header, and bounded window of group and
 * project rows, the logical cells of every expanded row, and the viewport that keeps them.
 */
export class ProjectsTableSurface {
  readonly scroll: HTMLElement;
  readonly #context: ProjectsTableSurfaceContext;
  readonly #host: HTMLElement;
  #columnCleanup: (() => void) | undefined;
  readonly #collapsedGroups = new Set<string>();
  readonly #viewport = new ProjectTableViewport();
  #spacers = new Map<string, HTMLTableRowElement>();
  #rowsDirty = false;
  #model: ProjectTableModel | undefined;
  #rows: readonly ProjectTableRow[] = [];
  #cells: ProjectOverviewCells = NO_PROJECT_OVERVIEW_CELLS;
  #projects: readonly Project[] = [];
  #renderedCells: RenderedCellContext[] = [];
  readonly #renderedGroups = new Map<string, RenderedGroupContext>();
  readonly #renderedProjectRows = new Map<string, RenderedProjectRow>();
  readonly #renderedGroupRows = new Map<string, RenderedGroupRow>();
  #table: HTMLTableElement | undefined;
  #body: HTMLTableSectionElement | undefined;
  #headerSignature = '';
  #columnResizePreview = false;
  #visibleColumns: readonly VisibleProjectColumn[] = [];
  readonly #resizeObserver: ResizeObserver | undefined;

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
    const resizeObserver =
      this.scroll.ownerDocument.defaultView === null
        ? undefined
        : Reflect.get(this.scroll.ownerDocument.defaultView, 'ResizeObserver');
    if (typeof resizeObserver === 'function') {
      const ResizeObserverClass = resizeObserver as ResizeObserverConstructor;
      this.#resizeObserver = new ResizeObserverClass(() => {
        this.#handleResize();
      });
      this.#resizeObserver.observe(this.scroll);
    }
  }

  show(): void {
    this.scroll.hidden = false;
  }

  hide(): void {
    this.scroll.hidden = true;
  }

  /**
   * Publishes the toolbar and count before measuring, since the toolbar height sets the window's
   * scroll height, then settles the selection before restoring scroll and focus.
   */
  render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void {
    this.#projects = projects;
    const scrollLeft = this.scroll.scrollLeft;
    const focusedIdentity = this.#focusedCellIdentity();
    const availableWidth = this.scroll.clientWidth;

    const columns = this.#context.columns();
    const model = buildProjectTableModel({ ...this.#context.modelInput(), projects, search });
    hooks.publish(model);

    const table = this.#table ?? this.#createTable();
    this.#reconcileHeader(table, columns);
    this.#applyWidth(availableWidth);
    this.#renderBody(table, model, columns);
    this.#updateResponsiveNamePinning(availableWidth);
    this.#finishReconciliation(hooks, this.scroll.scrollTop, scrollLeft, focusedIdentity);
  }

  cells(): ProjectOverviewCells {
    return this.#cells;
  }

  renderedCells(): readonly RenderedCellContext[] {
    return this.#renderedCells;
  }

  /** Scrolls an offscreen row into the window, which mounts it. */
  revealCell(identity: ProjectTableSelectableCell): void {
    this.scroll.scrollTop = this.#viewport.reveal(
      identity.occurrenceId,
      this.scroll.scrollTop,
      this.#viewportHeight(),
    );
    this.#renderWindow();
  }

  /** Scrolls a mounted cell below the sticky header and right of a pinned Name column. */
  scrollCellIntoView(cell: HTMLElement): void {
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

  /** An editor stays inside the scroll and below the table header. */
  editorFrame(): ProjectOverviewEditorFrame {
    const stickyHeader = this.#table?.tHead ?? undefined;
    return { boundary: this.scroll, ...(stickyHeader === undefined ? {} : { stickyHeader }) };
  }

  destroy(): void {
    this.#renderedCells = [];
    this.#renderedGroups.clear();
    this.#destroyViewport();
    this.#columnCleanup?.();
    this.#columnCleanup = undefined;
    this.#resizeObserver?.disconnect();
  }

  /** Opens a collapsed group and reports whether it was collapsed. */
  expandGroup(key: string): boolean {
    return this.#collapsedGroups.delete(key);
  }

  /** A rendered group, which the row drag reads while it lives in the controller. */
  group(key: string): RenderedGroupContext | undefined {
    return this.#renderedGroups.get(key);
  }

  /** A mounted group header row, which the drop preview marks. */
  groupRow(key: string): RenderedGroupRow | undefined {
    return this.#renderedGroupRows.get(key);
  }

  isGroupCollapsed(key: string): boolean {
    return this.#collapsedGroups.has(key);
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

  #handleResize(): void {
    if (!this.#context.isActive()) return;
    this.#renderWindow();
    // A column drag owns the live widths until it commits or cancels. Reapplying the saved
    // widths here would revert its preview every time the observed table changes size.
    if (this.#columnResizePreview) return;
    this.#applyWidth();
    this.#updateResponsiveNamePinning();
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
      collapsedGroups: this.#collapsedGroups,
      effectiveField: this.#context.effectiveField,
    });
    this.#rows = rows;
    this.#cells = cells;
    this.#viewport.replace(
      rows.map(({ key, project }) => ({ key, height: project === undefined ? 32 : 34 })),
    );
    this.#renderWindow();
  }

  #viewportHeight(): number {
    const height = this.scroll.clientHeight;
    const header = this.#table?.tHead?.getBoundingClientRect().height ?? 0;
    const headerHeight = Number.isFinite(header) ? header : 0;
    return height > 0 ? Math.max(1, height - headerHeight) : 0;
  }

  readonly #renderWindow = (): void => {
    const body = this.#body;
    const model = this.#model;
    if (!this.#context.isActive() || body === undefined || model === undefined) return;
    const pinned = this.#pinnedRows();
    let top = this.scroll.scrollTop;
    // One measured correction pass fills newly exposed rows without scheduling a work queue.
    for (let pass = 0; pass < 2; pass++) {
      const window = this.#viewport.window(top, this.#viewportHeight(), pinned);
      this.scroll.scrollTop = window.scrollTop;
      const mounted = this.#reconcileWindow(body, model, window.segments);
      this.scroll.scrollTop = window.scrollTop;
      const correction = this.#viewport.measure(
        mounted.map(({ key, element }) => ({
          key,
          height: element.getBoundingClientRect().height,
        })),
        window.scrollTop,
      );
      if (!correction.changed) break;
      top = correction.scrollTop;
    }
    this.#rowsDirty = false;
    this.#context.windowRendered();
  };

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
    if (model.groups.length === 0) {
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
    const dragged = this.#context.rowDrag.draggedOccurrence();
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
    const { key, label, value, sourcePath, count, columnCount, statuses, presentation } = options;
    const rendered = this.#renderedGroupRows.get(key) ?? this.#createGroupRow(options);
    rendered.context = { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) };
    writeOptionalAttribute(rendered.element, 'data-group-key', key);
    const colSpan = Math.max(1, columnCount);
    if (rendered.cell.colSpan !== colSpan) rendered.cell.colSpan = colSpan;
    writeOptionalAttribute(rendered.button, 'data-group-key', key);
    const collapsed = this.#collapsedGroups.has(key);
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
      { marker: rendered.statusDot, host: rendered.label, component: rendered.markdown },
      options,
      color,
    );
  }

  #bindGroupRow(rendered: RenderedGroupRow): void {
    const { element: row, cell } = rendered;
    cell.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      const key = rendered.context.key;
      this.#context.finishEditorBefore(() => {
        if (this.#collapsedGroups.has(key)) this.#collapsedGroups.delete(key);
        else this.#collapsedGroups.add(key);
        this.#context.render();
      });
    });
    this.#context.rowDrag.bindGroupDropTarget(row, () => rendered.context.key);
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
    const renderedRow =
      this.#renderedProjectRows.get(occurrenceId) ??
      this.#createProjectRow(options.body, project, group.key, occurrenceId);
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
    rendered.dragCleanup = this.#context.rowDrag.bindRow(rendered);
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
}
