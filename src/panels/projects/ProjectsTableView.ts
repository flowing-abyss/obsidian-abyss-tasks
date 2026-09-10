import { Component, Menu, Notice, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { parseLinks } from '../../markdown/links';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectEditHistory } from '../../projects/projectEditHistory';
import {
  projectCellSourceValue,
  projectFieldWithOwnedClear,
  type AppliedProjectCellChange,
  type OwnedInferredPropertyClear,
  type ProjectCellChange,
  type ProjectEditResult,
} from '../../projects/projectEdits';
import {
  buildProjectFieldCatalog,
  findFrontmatterProperty,
  findProjectFieldById,
  isAvailableProjectField,
  projectFieldValue,
  type ProjectField,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import type { ProjectSourceObservation } from '../../projects/ProjectStore';
import {
  buildProjectTableModel,
  projectProgressDisplayValue,
  projectTableGroupLinkIdentity,
  type ProjectTableModel,
} from '../../projects/projectTableModel';
import { buildDefaultProjectTableSettings } from '../../projects/projectTableSettings';
import { resolveStatus } from '../../projects/status';
import type { Project } from '../../projects/types';
import {
  enforceProjectTableColumnInvariants,
  setProjectColumnLabel,
  setProjectColumnWidth,
} from '../../settings/projectTableSettings';
import type { CalendarSettings } from '../../settings/types';
import { renderTaskText } from '../../ui/renderTaskText';
import {
  mountProjectCellEditor,
  type ProjectCellEditorHandle,
  type ProjectCellEditorNavigation,
} from './ProjectCellEditor';
import { mountProjectCellEditorPosition } from './projectCellEditorPosition';
import { ProjectsTableToolbar } from './ProjectsTableToolbar';
import { renderProjectTableCell } from './projectTableCells';
import {
  PROJECT_TABLE_CLIPBOARD_TYPE,
  clipboardPayloadFromText,
  coerceProjectClipboardValue,
  decodeProjectTableClipboard,
  deduplicateProjectCellAssignments,
  encodeProjectTableClipboard,
  formatProjectTableTsv,
  parseProjectTableTsv,
  rebaseProjectClipboardLinks,
  resolveProjectPasteRectangle,
  type ProjectClipboardCell,
  type ProjectLinkRebaser,
} from './projectTableClipboard';
import {
  projectTableColumnWidth,
  renderProjectTableColumns,
  type ProjectTableColumnResize,
  type VisibleProjectColumn,
} from './projectTableColumns';
import { planProjectGroupDrop, type ProjectTableDragGroup } from './projectTableDrag';
import {
  ProjectTableSelection,
  type ProjectTableSelectableCell,
  type ProjectTableSelectionDirection,
} from './projectTableSelection';

const PROJECT_TABLE_ROW_DRAG_TYPE = 'application/x-abyss-project-table-row';

export interface ProjectsTableViewContext {
  readonly app: App;
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly saveViewState: () => Promise<void>;
  readonly applyEdits: (changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>;
  readonly history: ProjectEditHistory;
  readonly createProject: (name: string) => Promise<void>;
  readonly openProject: (path: string) => void;
  readonly revalidateSourceObservation: (observation: ProjectSourceObservation) => Promise<boolean>;
}

interface ActiveEditor {
  readonly projectPath: string;
  readonly columnId: string;
  readonly handle: ProjectCellEditorHandle;
  readonly positionCleanup: () => void;
}

interface FocusedCellIdentity {
  readonly occurrenceId: string | undefined;
  readonly columnId: string | undefined;
}

interface TableSelectionBounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly focus: { readonly row: number; readonly column: number };
}

interface ProjectRowDragPayload {
  readonly version: 1;
  readonly projectPath: string;
  readonly occurrenceId: string;
  readonly sourceGroupKey: string;
}

type ResizeObserverConstructor = new (callback: ResizeObserverCallback) => ResizeObserver;

interface RenderedCellContext {
  identity: ProjectTableSelectableCell;
  project: Project;
  field: ProjectFieldCatalogItem;
  ownedClear: OwnedInferredPropertyClear | undefined;
  readonly element: HTMLElement;
  contentSignature: string;
}

interface RenderedGroupContext extends ProjectTableDragGroup {
  label: string;
}

interface RenderedProjectRow {
  readonly element: HTMLTableRowElement;
  readonly cells: Map<string, RenderedCellContext>;
  dragCleanup?: () => void;
  project: Project;
  groupKey: string;
  occurrenceId: string;
}

interface RenderedGroupRow {
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

interface ProjectCellEditRequest {
  readonly project: Project;
  readonly field: ProjectField;
  readonly value: unknown;
  readonly expectedValue: unknown;
  readonly expectedExists: boolean;
  readonly sourceProperty: string;
  readonly sourceKey: string | undefined;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
}

interface ProjectCellEditorState {
  expectedValue: unknown;
  expectedExists: boolean;
  sourceProperty: string;
  sourceKey: string | undefined;
  ownedClear: OwnedInferredPropertyClear | undefined;
}

interface EditCellOptions {
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
  readonly anchor?: HTMLElement;
}

interface EditorCloseDestination {
  readonly cell: ProjectTableSelectableCell | undefined;
  readonly preservesExternalFocus: boolean;
}

interface ProjectReceiptProjection {
  readonly receipt: AppliedProjectCellChange;
  readonly sourceRevisionAtMutationStart: number;
  readonly ordinal: number;
}

interface RemoveListValueRequest extends ProjectCellEditRequest {
  readonly value: unknown[];
  readonly expectedValue: unknown[];
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

interface ReconcileModelGroupOptions {
  readonly body: HTMLTableSectionElement;
  readonly group: ProjectTableModel['groups'][number];
  readonly model: ProjectTableModel;
  readonly columns: readonly VisibleProjectColumn[];
  readonly grouped: boolean;
  readonly rows: ReconciledBodyRows;
}

interface ReconcileProjectCellOptions {
  readonly row: RenderedProjectRow;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly columnId: string;
  readonly occurrenceId: string;
  readonly groupKey: string;
  readonly grouped: boolean;
}

function editableField(field: ProjectFieldCatalogItem): field is ProjectField {
  return isAvailableProjectField(field) && field.type !== 'name' && field.type !== 'progress';
}

function visibleColumns(
  settings: CalendarSettings,
  fields: readonly ProjectFieldCatalogItem[],
): VisibleProjectColumn[] {
  return settings.projects.table.columns.flatMap((column) => {
    if (!column.visible) return [];
    const field = findProjectFieldById(fields, column.id);
    return field === undefined ? [] : [{ column, field }];
  });
}

function copyProjectedValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyProjectedValue) : value;
}

function equalProjectedValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalProjectedValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function clipboardScalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return '';
}

function selectionDirectionForKey(key: string): ProjectTableSelectionDirection | undefined {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  return undefined;
}

function sameRowDragPayload(left: ProjectRowDragPayload, right: ProjectRowDragPayload): boolean {
  return (
    left.projectPath === right.projectPath &&
    left.occurrenceId === right.occurrenceId &&
    left.sourceGroupKey === right.sourceGroupKey
  );
}

function nearestViewportDelta(
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
): number {
  if (start < viewportStart) return start - viewportStart;
  if (end > viewportEnd) return end - viewportEnd;
  return 0;
}

function observationMatchesReceipt(
  observation: ProjectSourceObservation,
  receipt: AppliedProjectCellChange,
): boolean {
  const source =
    observation.project === undefined
      ? undefined
      : findFrontmatterProperty(observation.project.frontmatter, receipt.sourceProperty);
  return (
    (source !== undefined) === receipt.appliedExists &&
    (!receipt.appliedExists || equalProjectedValue(source?.value, receipt.value))
  );
}

function projectionKey(receipt: AppliedProjectCellChange): string {
  return `${receipt.path}\u0000${receipt.field.id}`;
}

function projectCellEditorState(
  project: Project,
  field: ProjectField,
  settings: CalendarSettings,
  ownedClear: OwnedInferredPropertyClear | undefined,
): ProjectCellEditorState {
  const sourceProperty =
    field.type === 'status' ? settings.projects.statusProperty : field.property;
  if (sourceProperty === undefined) throw new Error(`Field ${field.id} has no metadata source`);
  const source = findFrontmatterProperty(project.frontmatter, sourceProperty);
  return {
    expectedValue: source?.value,
    expectedExists: source !== undefined,
    sourceProperty,
    sourceKey: source?.key ?? ownedClear?.sourceKey,
    ownedClear,
  };
}

export class ProjectsTableView {
  private projects_abyssPrivate: readonly Project[] = [];
  private fields_abyssPrivate: readonly ProjectFieldCatalogItem[] = [];
  private readonly root_abyssPrivate: HTMLElement;
  private readonly scroll_abyssPrivate: HTMLElement;
  private readonly tableHost_abyssPrivate: HTMLElement;
  private readonly feedback_abyssPrivate: HTMLElement;
  private readonly count_abyssPrivate: HTMLElement;
  private readonly toolbar_abyssPrivate: ProjectsTableToolbar;
  private readonly markdown_abyssPrivate = new Component();
  private readonly ownerWindow_abyssPrivate: Window | undefined;
  private activeEditor_abyssPrivate: ActiveEditor | undefined;
  private activeRowDrag_abyssPrivate: ProjectRowDragPayload | undefined;
  private columnCleanup_abyssPrivate: (() => void) | undefined;
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private readonly selection_abyssPrivate = new ProjectTableSelection();
  private renderedCells_abyssPrivate: RenderedCellContext[] = [];
  private readonly renderedGroups_abyssPrivate = new Map<string, RenderedGroupContext>();
  private readonly renderedProjectRows_abyssPrivate = new Map<string, RenderedProjectRow>();
  private readonly renderedGroupRows_abyssPrivate = new Map<string, RenderedGroupRow>();
  private table_abyssPrivate: HTMLTableElement | undefined;
  private body_abyssPrivate: HTMLTableSectionElement | undefined;
  private headerSignature_abyssPrivate = '';
  private visibleColumns_abyssPrivate: readonly VisibleProjectColumn[] = [];
  private search_abyssPrivate = '';
  private mounted_abyssPrivate = false;
  private mutationTail_abyssPrivate: Promise<void> = Promise.resolve();
  private mutationActive_abyssPrivate = false;
  private renderPending_abyssPrivate = false;
  private readonly sourceObservations_abyssPrivate = new Map<string, ProjectSourceObservation>();
  private readonly receiptProjections_abyssPrivate = new Map<string, ProjectReceiptProjection>();
  private activeMutationSourceRevisions_abyssPrivate: ReadonlyMap<string, number> | undefined;
  private nextReceiptOrdinal_abyssPrivate = 0;
  private pendingAction_abyssPrivate:
    { readonly run: () => void; readonly replace?: () => void } | undefined;
  private finishingEditor_abyssPrivate: Promise<void> | undefined;
  private readonly resizeObserver_abyssPrivate: ResizeObserver | undefined;

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsTableViewContext,
  ) {
    this.root_abyssPrivate = host.createDiv({ cls: 'abyss-projects-table' });
    this.toolbar_abyssPrivate = new ProjectsTableToolbar({
      host: this.root_abyssPrivate,
      settings: context_abyssPrivate.settings.projects.table,
      fields: () => this.fields_abyssPrivate,
      onSearch: (query) => {
        this.finishEditorBeforeAction(() => {
          this.search_abyssPrivate = query;
          this.renderTable_abyssPrivate();
        });
      },
      onStatusToggle: (key) => {
        this.finishEditorBeforeAction(() => {
          this.toggleStatus_abyssPrivate(key);
        });
      },
      onGroupBy: (field) => {
        this.finishEditorBeforeAction(() => {
          this.context_abyssPrivate.settings.projects.table.groupBy = field;
          this.persistAndRender_abyssPrivate();
        });
      },
      onSortBy: (field) => {
        this.finishEditorBeforeAction(() => {
          this.sortByColumn_abyssPrivate(field);
        });
      },
      onReset: () => {
        this.finishEditorBeforeAction(() => {
          this.resetViewState_abyssPrivate();
        });
      },
    });
    this.feedback_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-project-table-feedback',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });
    this.scroll_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-project-table-scroll',
      attr: { tabindex: '-1' },
    });
    this.root_abyssPrivate.addEventListener('keydown', (event) => {
      this.handleTableKeydown_abyssPrivate(event);
    });
    this.ownerWindow_abyssPrivate = this.root_abyssPrivate.ownerDocument.defaultView ?? undefined;
    this.listenForOwnerWindowF2_abyssPrivate();
    this.tableHost_abyssPrivate = this.scroll_abyssPrivate.createDiv({
      cls: 'abyss-project-table-host',
    });
    const resizeObserver =
      this.scroll_abyssPrivate.ownerDocument.defaultView === null
        ? undefined
        : Reflect.get(this.scroll_abyssPrivate.ownerDocument.defaultView, 'ResizeObserver');
    if (typeof resizeObserver === 'function') {
      const ResizeObserverClass = resizeObserver as ResizeObserverConstructor;
      this.resizeObserver_abyssPrivate = new ResizeObserverClass(() => {
        this.handleTableResize_abyssPrivate();
      });
      this.resizeObserver_abyssPrivate.observe(this.scroll_abyssPrivate);
    }
    const footer = this.root_abyssPrivate.createDiv({ cls: 'abyss-project-table-footer' });
    const create = footer.createEl('button', {
      cls: 'abyss-projects-new',
      text: 'New project',
      attr: { type: 'button' },
    });
    create.addEventListener('click', () => {
      this.finishEditorBeforeAction(() => {
        this.showNewProjectInput_abyssPrivate();
      });
    });
    this.count_abyssPrivate = footer.createSpan({ cls: 'abyss-project-table-count' });
  }

  private resetViewState_abyssPrivate(): void {
    const defaults = buildDefaultProjectTableSettings();
    const table = this.context_abyssPrivate.settings.projects.table;
    table.groupBy = defaults.groupBy;
    table.sortBy = defaults.sortBy;
    table.hiddenStatuses = defaults.hiddenStatuses;
    table.showDescription = defaults.showDescription;
    this.persistAndRender_abyssPrivate();
  }

  private handleTableResize_abyssPrivate(): void {
    this.applyTableWidth_abyssPrivate();
    this.updateResponsiveNamePinning_abyssPrivate();
  }

  mount(projects: readonly Project[]): void {
    this.mounted_abyssPrivate = true;
    this.markdown_abyssPrivate.load();
    this.projects_abyssPrivate = projects;
    this.refreshFields();
  }

  update(projects: readonly Project[]): void {
    this.projects_abyssPrivate = projects;
    this.renderTable_abyssPrivate();
  }

  refreshFields(): void {
    this.fields_abyssPrivate = buildProjectFieldCatalog(
      this.context_abyssPrivate.settings.projects,
      this.context_abyssPrivate.catalog.list(),
    );
    this.renderTable_abyssPrivate();
  }

  destroy(): void {
    this.mounted_abyssPrivate = false;
    this.pendingAction_abyssPrivate?.replace?.();
    this.pendingAction_abyssPrivate = undefined;
    this.activeEditor_abyssPrivate?.positionCleanup();
    this.activeEditor_abyssPrivate?.handle.destroy();
    this.activeEditor_abyssPrivate = undefined;
    this.activeRowDrag_abyssPrivate = undefined;
    this.selection_abyssPrivate.clear();
    this.renderedCells_abyssPrivate = [];
    this.renderedGroups_abyssPrivate.clear();
    for (const row of this.renderedProjectRows_abyssPrivate.values()) row.dragCleanup?.();
    this.renderedProjectRows_abyssPrivate.clear();
    this.renderedGroupRows_abyssPrivate.clear();
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.toolbar_abyssPrivate.destroy();
    this.resizeObserver_abyssPrivate?.disconnect();
    this.ownerWindow_abyssPrivate?.removeEventListener(
      'keydown',
      this.handleOwnerWindowKeydown_abyssPrivate,
      true,
    );
    this.markdown_abyssPrivate.unload();
    this.root_abyssPrivate.remove();
  }

  /**
   * Serializes every table-session metadata mutation. Task 4 Undo/Redo uses this same queue.
   */
  runTableSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.mutationActive_abyssPrivate = true;
      this.activeMutationSourceRevisions_abyssPrivate = new Map(
        Array.from(this.sourceObservations_abyssPrivate, ([path, observation]) => [
          path,
          observation.revision,
        ]),
      );
      try {
        return await mutation();
      } finally {
        this.activeMutationSourceRevisions_abyssPrivate = undefined;
        this.mutationActive_abyssPrivate = false;
        if (this.renderPending_abyssPrivate) this.renderTable_abyssPrivate();
      }
    };
    const result = this.mutationTail_abyssPrivate.then(run, run);
    this.mutationTail_abyssPrivate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reconciles receipt projections only from ProjectStore's verified per-path source stream. */
  observeProjectSource(observation: ProjectSourceObservation): void {
    const current = this.sourceObservations_abyssPrivate.get(observation.path);
    if (current !== undefined && current.revision >= observation.revision) return;
    this.sourceObservations_abyssPrivate.set(observation.path, observation);
    let changed = false;
    for (const [key, projection] of this.receiptProjections_abyssPrivate) {
      if (
        projection.receipt.path === observation.path &&
        observation.revision > projection.sourceRevisionAtMutationStart
      ) {
        this.receiptProjections_abyssPrivate.delete(key);
        changed = true;
      }
    }
    if (changed) this.renderTable_abyssPrivate();
  }

  /** Keeps only the newest deliberate action while an editor is saving or blocked. */
  finishEditorBeforeAction(action: () => void): void {
    this.pendingAction_abyssPrivate?.replace?.();
    this.pendingAction_abyssPrivate = { run: action };
    this.finishActiveEditor_abyssPrivate();
  }

  /** Resolves only when the current pending navigation may proceed. */
  requestFinishActiveEditor(): Promise<boolean> {
    if (this.activeEditor_abyssPrivate === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.pendingAction_abyssPrivate?.replace?.();
      this.pendingAction_abyssPrivate = {
        run: () => {
          resolve(true);
        },
        replace: () => {
          resolve(false);
        },
      };
      this.finishActiveEditor_abyssPrivate();
    });
  }

  private finishActiveEditor_abyssPrivate(): void {
    if (this.finishingEditor_abyssPrivate !== undefined) return;
    const editor = this.activeEditor_abyssPrivate;
    if (editor === undefined) {
      this.runPendingAction_abyssPrivate();
      return;
    }
    const finishing = editor.handle.commit().then(() => undefined);
    this.finishingEditor_abyssPrivate = finishing;
    const settle = (): void => {
      if (this.finishingEditor_abyssPrivate === finishing) {
        this.finishingEditor_abyssPrivate = undefined;
      }
      if (this.activeEditor_abyssPrivate === undefined) this.runPendingAction_abyssPrivate();
    };
    finishing.then(settle, settle);
  }

  private runPendingAction_abyssPrivate(): void {
    const pending = this.pendingAction_abyssPrivate;
    this.pendingAction_abyssPrivate = undefined;
    pending?.run();
  }

  private persistAndRender_abyssPrivate(): void {
    this.renderTable_abyssPrivate();
    this.persistSettings_abyssPrivate();
  }

  private persistSettings_abyssPrivate(): void {
    this.feedback_abyssPrivate.empty();
    void this.context_abyssPrivate.saveViewState().catch((error: unknown) => {
      if (!this.mounted_abyssPrivate) return;
      const message = error instanceof Error ? error.message : String(error);
      this.feedback_abyssPrivate.setText(`Could not save project table settings: ${message}`);
      console.error('[abyss-tasks] Could not save project table settings', error);
    });
  }

  private toggleStatus_abyssPrivate(key: string): void {
    const hidden = this.context_abyssPrivate.settings.projects.table.hiddenStatuses;
    const index = hidden.indexOf(key);
    if (index >= 0) hidden.splice(index, 1);
    else hidden.push(key);
    this.persistAndRender_abyssPrivate();
  }

  private showNewProjectInput_abyssPrivate(): void {
    const existing = this.scroll_abyssPrivate.querySelector<HTMLInputElement>(
      '.abyss-projects-new-input',
    );
    if (existing !== null) {
      existing.focus();
      return;
    }
    const input = this.scroll_abyssPrivate.createEl('input', {
      cls: 'abyss-projects-new-input',
      attr: { type: 'text', placeholder: 'Project name…', 'aria-label': 'Project name' },
    });
    this.scroll_abyssPrivate.insertBefore(input, this.tableHost_abyssPrivate);
    let finished = false;
    const finish = (create: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      input.remove();
      if (!create || name.length === 0) return;
      void this.context_abyssPrivate.createProject(name).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(`Could not create project: ${message}`);
        console.error('[abyss-tasks] Could not create project', error);
        new Notice(`Could not create project: ${message}`);
      });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.focus();
  }

  private renderTable_abyssPrivate(): void {
    if (!this.mounted_abyssPrivate) return;
    if (this.mutationActive_abyssPrivate || this.activeEditor_abyssPrivate !== undefined) {
      this.renderPending_abyssPrivate = true;
      return;
    }
    this.renderPending_abyssPrivate = false;
    const scrollTop = this.scroll_abyssPrivate.scrollTop;
    const scrollLeft = this.scroll_abyssPrivate.scrollLeft;
    const focusedIdentity = this.focusedCellIdentity_abyssPrivate();

    const tableSettings = this.context_abyssPrivate.settings.projects.table;
    enforceProjectTableColumnInvariants(tableSettings);
    const columns = visibleColumns(this.context_abyssPrivate.settings, this.fields_abyssPrivate);
    const model = buildProjectTableModel({
      projects: this.projectedProjects_abyssPrivate(),
      fields: this.fields_abyssPrivate,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      settings: tableSettings,
      search: this.search_abyssPrivate,
      resolveLink: (target, sourcePath) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
    });
    this.toolbar_abyssPrivate.update(model.availableStatusGroups);
    this.count_abyssPrivate.setText(
      `${model.uniqueVisibleCount} ${model.uniqueVisibleCount === 1 ? 'project' : 'projects'}`,
    );

    const table = this.table_abyssPrivate ?? this.createTable_abyssPrivate();
    this.reconcileTableHeader_abyssPrivate(table, columns);
    this.renderTableBody_abyssPrivate(table, model, columns);
    this.applyTableWidth_abyssPrivate();
    this.updateResponsiveNamePinning_abyssPrivate();
    this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    this.syncSelection_abyssPrivate();
    this.restoreTablePosition_abyssPrivate(scrollTop, scrollLeft, focusedIdentity);
  }

  private createTable_abyssPrivate(): HTMLTableElement {
    const table = this.tableHost_abyssPrivate.createEl('table', {
      cls: 'abyss-project-table',
    });
    this.table_abyssPrivate = table;
    table.addEventListener('copy', (event) => {
      this.handleCopy_abyssPrivate(event);
    });
    table.addEventListener('paste', (event) => {
      this.handlePaste_abyssPrivate(event);
    });
    return table;
  }

  private reconcileTableHeader_abyssPrivate(
    table: HTMLTableElement,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const tableSettings = this.context_abyssPrivate.settings.projects.table;
    const signature = JSON.stringify({
      columns: columns.map(({ column, field }) => ({
        id: column.id,
        label: column.label ?? field.label,
        width: projectTableColumnWidth(column, field),
        type: field.type,
      })),
      sort: tableSettings.sortBy,
    });
    this.visibleColumns_abyssPrivate = columns;
    if (signature === this.headerSignature_abyssPrivate) return;
    this.headerSignature_abyssPrivate = signature;
    this.columnCleanup_abyssPrivate?.();
    table.querySelector(':scope > colgroup')?.remove();
    table.querySelector(':scope > thead')?.remove();
    this.columnCleanup_abyssPrivate = renderProjectTableColumns(table, {
      columns,
      sort: tableSettings.sortBy,
      onSort: (field) => {
        this.finishEditorBeforeAction(() => {
          this.sortByColumn_abyssPrivate(field);
        });
      },
      onRename: (columnId, label) => {
        this.finishEditorBeforeAction(() => {
          this.renameColumn_abyssPrivate(columnId, label);
        });
      },
      onMove: (columnId, targetColumnId, placement) => {
        this.finishEditorBeforeAction(() => {
          this.moveColumn_abyssPrivate(columnId, targetColumnId, placement);
        });
      },
      onResize: (resize) => {
        this.finishEditorBeforeAction(() => {
          this.resizeColumns_abyssPrivate(resize);
        });
      },
    });
    const colgroup = table.querySelector(':scope > colgroup');
    if (colgroup !== null) table.insertBefore(colgroup, table.firstChild);
    const head = table.querySelector(':scope > thead');
    if (head !== null && this.body_abyssPrivate !== undefined) {
      table.insertBefore(head, this.body_abyssPrivate);
    }
  }

  private renderTableBody_abyssPrivate(
    table: HTMLTableElement,
    model: ProjectTableModel,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const body = this.body_abyssPrivate ?? table.createEl('tbody');
    this.body_abyssPrivate = body;
    this.renderedGroups_abyssPrivate.clear();
    const rows =
      model.groups.length === 0
        ? this.emptyBodyRows_abyssPrivate(body, columns.length)
        : this.reconcileModelRows_abyssPrivate(body, model, columns);
    this.removeMissingRows_abyssPrivate(rows.retainedProjects, rows.retainedGroups);
    this.reconcileRowOrder_abyssPrivate(body, rows.desired);
    this.renderedCells_abyssPrivate = rows.cells;
  }

  private emptyBodyRows_abyssPrivate(
    body: HTMLTableSectionElement,
    columnCount: number,
  ): ReconciledBodyRows {
    const row = body.createEl('tr');
    row.createEl('td', {
      cls: 'abyss-projects-empty',
      text: this.projects_abyssPrivate.length === 0 ? 'No projects yet' : 'No matching projects',
      attr: { colspan: String(Math.max(1, columnCount)) },
    });
    return {
      desired: [row],
      retainedProjects: new Set(),
      retainedGroups: new Set(),
      cells: [],
    };
  }

  private reconcileModelRows_abyssPrivate(
    body: HTMLTableSectionElement,
    model: ProjectTableModel,
    columns: readonly VisibleProjectColumn[],
  ): ReconciledBodyRows {
    const rows: ReconciledBodyRows = {
      desired: [],
      retainedProjects: new Set(),
      retainedGroups: new Set(),
      cells: [],
    };
    const grouped = this.context_abyssPrivate.settings.projects.table.groupBy !== 'none';
    for (const group of model.groups) {
      this.reconcileModelGroup_abyssPrivate({ body, group, model, columns, grouped, rows });
    }
    return rows;
  }

  private reconcileModelGroup_abyssPrivate(options: ReconcileModelGroupOptions): void {
    const { body, group, model, columns, grouped, rows } = options;
    this.renderedGroups_abyssPrivate.set(group.key, {
      key: group.key,
      label: group.label,
      value: group.value,
      ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
    });
    if (grouped) {
      rows.retainedGroups.add(group.key);
      rows.desired.push(
        this.reconcileGroupRow_abyssPrivate({
          body,
          key: group.key,
          label: group.label,
          value: group.value,
          ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
          count: group.projects.length,
          columnCount: columns.length,
          statuses: model.availableStatusGroups,
        }),
      );
    }
    if (grouped && this.collapsedGroups_abyssPrivate.has(group.key)) return;
    for (const project of group.projects) {
      const row = this.reconcileProjectRow_abyssPrivate({
        body,
        project,
        columns,
        group,
        grouped,
      });
      rows.retainedProjects.add(row.occurrenceId);
      rows.desired.push(row.element);
      rows.cells.push(...visibleRowCells(row, columns));
    }
  }

  private restoreTablePosition_abyssPrivate(
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    this.scroll_abyssPrivate.scrollTop = scrollTop;
    this.scroll_abyssPrivate.scrollLeft = scrollLeft;
    if (focusedIdentity?.occurrenceId === undefined || focusedIdentity.columnId === undefined)
      return;
    const restored = this.findOccurrenceCell_abyssPrivate(
      focusedIdentity.occurrenceId,
      focusedIdentity.columnId,
    );
    if (restored === null) this.scroll_abyssPrivate.focus({ preventScroll: true });
    else restored.focus({ preventScroll: true });
  }

  private reconcileGroupRow_abyssPrivate(options: RenderGroupOptions): HTMLTableRowElement {
    const { key, label, value, sourcePath, count, columnCount, statuses } = options;
    const rendered =
      this.renderedGroupRows_abyssPrivate.get(key) ?? this.createGroupRow_abyssPrivate(options);
    rendered.context = { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) };
    rendered.element.dataset['groupKey'] = key;
    rendered.cell.colSpan = Math.max(1, columnCount);
    rendered.button.dataset['groupKey'] = key;
    const collapsed = this.collapsedGroups_abyssPrivate.has(key);
    rendered.button.setAttribute('aria-expanded', String(!collapsed));
    rendered.chevron.setText(collapsed ? '›' : '⌄');
    const status = statuses.find((candidate) => candidate.key === key);
    const signature = JSON.stringify([label, value, sourcePath, status?.color]);
    if (signature !== rendered.contentSignature)
      this.patchGroupContent_abyssPrivate(rendered, options, status?.color, signature);
    rendered.count.setText(String(count));
    return rendered.element;
  }

  private createGroupRow_abyssPrivate(options: RenderGroupOptions): RenderedGroupRow {
    const { body, key, label, value, sourcePath } = options;
    const row = body.createEl('tr', { cls: 'abyss-project-table-group-row' });
    const cell = row.createEl('td');
    const button = cell.createEl('button', {
      cls: 'abyss-project-table-group-toggle',
      attr: { type: 'button', 'data-group-key': key },
    });
    const rendered: RenderedGroupRow = {
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
    this.renderedGroupRows_abyssPrivate.set(key, rendered);
    this.bindGroupRow_abyssPrivate(rendered);
    return rendered;
  }

  private patchGroupContent_abyssPrivate(
    rendered: RenderedGroupRow,
    options: RenderGroupOptions,
    color: string | undefined,
    signature: string,
  ): void {
    rendered.contentSignature = signature;
    rendered.statusDot.hidden = color === undefined;
    rendered.statusDot.style.background = color ?? '';
    rendered.label.empty();
    const { value, sourcePath, label } = options;
    if (typeof value !== 'string' || sourcePath === undefined || parseLinks(value).length === 0) {
      rendered.label.setText(label);
      return;
    }
    renderTaskText(rendered.label, value, {
      app: this.context_abyssPrivate.app,
      sourcePath,
      component: this.markdown_abyssPrivate,
      beforeOpenLink: () => this.requestFinishActiveEditor(),
    });
  }

  private bindGroupRow_abyssPrivate(rendered: RenderedGroupRow): void {
    const { element: row, cell, dropHint } = rendered;
    cell.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      const key = rendered.context.key;
      this.finishEditorBeforeAction(() => {
        if (this.collapsedGroups_abyssPrivate.has(key))
          this.collapsedGroups_abyssPrivate.delete(key);
        else this.collapsedGroups_abyssPrivate.add(key);
        this.renderTable_abyssPrivate();
      });
    });
    this.bindGroupDropTarget_abyssPrivate(row, () => rendered.context.key, dropHint);
  }

  private bindGroupDropTarget_abyssPrivate(
    row: HTMLTableRowElement,
    groupKey: () => string,
    dropHint?: HTMLElement,
  ): () => void {
    const clearDropState = (): void => {
      row.removeClass('is-drop-target', 'is-drop-disabled');
      dropHint?.empty();
      row.removeAttribute('title');
    };
    const previewDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      clearDropState();
      const preview = this.previewGroupDrop_abyssPrivate(groupKey());
      if (preview.allowed) {
        row.addClass('is-drop-target');
        event.dataTransfer.dropEffect = 'move';
      } else {
        row.addClass('is-drop-disabled');
        event.dataTransfer.dropEffect = 'none';
      }
      dropHint?.setText(preview.message);
      row.setAttribute('title', preview.message);
    };
    const leaveDropTarget = (event: DragEvent): void => {
      if (!row.contains(event.relatedTarget as Node | null)) clearDropState();
    };
    const drop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      clearDropState();
      this.dropProjectIntoGroup_abyssPrivate(event.dataTransfer, groupKey());
    };
    row.addEventListener('dragenter', previewDrop);
    row.addEventListener('dragover', previewDrop);
    row.addEventListener('dragleave', leaveDropTarget);
    row.addEventListener('drop', drop);
    return () => {
      clearDropState();
      row.removeEventListener('dragenter', previewDrop);
      row.removeEventListener('dragover', previewDrop);
      row.removeEventListener('dragleave', leaveDropTarget);
      row.removeEventListener('drop', drop);
    };
  }

  private removeMissingRows_abyssPrivate(
    retainedProjects: ReadonlySet<string>,
    retainedGroups: ReadonlySet<string>,
  ): void {
    for (const [key, rendered] of this.renderedProjectRows_abyssPrivate) {
      if (retainedProjects.has(key)) continue;
      rendered.dragCleanup?.();
      rendered.element.remove();
      this.renderedProjectRows_abyssPrivate.delete(key);
    }
    for (const [key, rendered] of this.renderedGroupRows_abyssPrivate) {
      if (retainedGroups.has(key)) continue;
      rendered.element.remove();
      this.renderedGroupRows_abyssPrivate.delete(key);
    }
  }

  private reconcileRowOrder_abyssPrivate(
    body: HTMLTableSectionElement,
    desired: readonly HTMLTableRowElement[],
  ): void {
    let cursor = body.firstChild;
    for (const row of desired) {
      if (row === cursor) cursor = cursor.nextSibling;
      else body.insertBefore(row, cursor);
    }
    while (cursor !== null) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  private applyTableWidth_abyssPrivate(): void {
    const table = this.table_abyssPrivate;
    if (table === undefined) return;
    const widths = this.visibleColumns_abyssPrivate.map(({ column, field }) =>
      projectTableColumnWidth(column, field),
    );
    const configuredWidth = widths.reduce((total, width) => total + width, 0);
    const spare = Math.max(0, this.scroll_abyssPrivate.clientWidth - configuredWidth);
    for (const [index, { column }] of this.visibleColumns_abyssPrivate.entries()) {
      const col = Array.from(table.querySelectorAll<HTMLElement>('col[data-column-id]')).find(
        (candidate) => candidate.dataset['columnId'] === column.id,
      );
      if (col !== undefined) {
        col.style.width = `${(widths[index] ?? 150) + (column.id === 'name' ? spare : 0)}px`;
      }
    }
    const renderedWidth = configuredWidth + spare;
    table.style.width = `${renderedWidth}px`;
    table.style.minWidth = `${renderedWidth}px`;
  }

  private focusedCellIdentity_abyssPrivate(): FocusedCellIdentity | undefined {
    const active = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    const focusedCell = active?.closest<HTMLElement>('.abyss-project-table-cell');
    if (focusedCell === undefined || focusedCell === null) return undefined;
    return {
      occurrenceId: focusedCell.closest<HTMLElement>('.abyss-project-table-row')?.dataset[
        'occurrenceId'
      ],
      columnId: focusedCell.dataset['columnId'],
    };
  }

  private sortByColumn_abyssPrivate(field: string): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    table.sortBy = {
      field,
      dir: table.sortBy.field === field && table.sortBy.dir === 'asc' ? 'desc' : 'asc',
    };
    this.persistAndRender_abyssPrivate();
  }

  private renameColumn_abyssPrivate(columnId: string, label: string): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (setProjectColumnLabel(table, columnId, label)) this.persistAndRender_abyssPrivate();
  }

  private moveColumn_abyssPrivate(
    columnId: string,
    targetColumnId: string,
    placement: 'before' | 'after',
  ): void {
    const columns = this.context_abyssPrivate.settings.projects.table.columns;
    const from = columns.findIndex(({ id }) => id === columnId);
    const to = columns.findIndex(({ id }) => id === targetColumnId);
    if (from <= 0 || to <= 0 || from === to) return;
    const moved = columns.splice(from, 1)[0];
    if (moved === undefined) return;
    const target = columns.findIndex(({ id }) => id === targetColumnId);
    columns.splice(placement === 'after' ? target + 1 : target, 0, moved);
    this.persistAndRender_abyssPrivate();
  }

  private resizeColumns_abyssPrivate(resize: ProjectTableColumnResize): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    let changed = false;
    for (const { columnId, width } of resize.visibleWidths) {
      changed =
        setProjectColumnWidth(
          table,
          columnId,
          columnId === resize.columnId ? resize.width : width,
        ) || changed;
    }
    if (changed) this.persistAndRender_abyssPrivate();
  }

  private updateResponsiveNamePinning_abyssPrivate(): void {
    const available = this.scroll_abyssPrivate.clientWidth;
    const nameColumn = this.tableHost_abyssPrivate.querySelector<HTMLElement>(
      'col[data-column-id="name"]',
    );
    const width = nameColumn === null ? 0 : Number.parseFloat(nameColumn.style.width);
    const shouldUnpin = available > 0 && Number.isFinite(width) && available - width < 160;
    this.root_abyssPrivate.toggleClass('is-name-unpinned', shouldUnpin);
  }

  private reconcileProjectRow_abyssPrivate(options: RenderProjectRowOptions): RenderedProjectRow {
    const { project, group, grouped } = options;
    const occurrenceId = `${encodeURIComponent(group.key)}:${encodeURIComponent(project.path)}`;
    const renderedRow =
      this.renderedProjectRows_abyssPrivate.get(occurrenceId) ??
      this.createProjectRow_abyssPrivate(options.body, project, group.key, occurrenceId);
    renderedRow.project = project;
    renderedRow.groupKey = group.key;
    renderedRow.occurrenceId = occurrenceId;
    const row = renderedRow.element;
    row.dataset['projectPath'] = project.path;
    row.dataset['occurrenceId'] = occurrenceId;
    row.dataset['groupKey'] = group.key;
    row.draggable = grouped;
    this.reconcileProjectCells_abyssPrivate(renderedRow, options, occurrenceId);
    return renderedRow;
  }

  private createProjectRow_abyssPrivate(
    body: HTMLTableSectionElement,
    project: Project,
    groupKey: string,
    occurrenceId: string,
  ): RenderedProjectRow {
    const rendered: RenderedProjectRow = {
      element: body.createEl('tr', { cls: 'abyss-project-table-row' }),
      cells: new Map(),
      project,
      groupKey,
      occurrenceId,
    };
    this.renderedProjectRows_abyssPrivate.set(occurrenceId, rendered);
    rendered.dragCleanup = this.bindProjectRowDrag_abyssPrivate(rendered);
    return rendered;
  }

  private reconcileProjectCells_abyssPrivate(
    row: RenderedProjectRow,
    options: RenderProjectRowOptions,
    occurrenceId: string,
  ): void {
    const { project, columns, group, grouped } = options;
    const desiredCells: HTMLElement[] = [];
    const retainedColumns = new Set<string>();
    for (const { column, field: rawField } of columns) {
      retainedColumns.add(column.id);
      const rendered = this.reconcileProjectCell_abyssPrivate({
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

  private reconcileProjectCell_abyssPrivate(
    options: ReconcileProjectCellOptions,
  ): RenderedCellContext {
    const { row, project, field: rawField, columnId, occurrenceId, groupKey, grouped } = options;
    const { field, ownedClear } = this.effectiveField_abyssPrivate(project, rawField);
    let rendered = row.cells.get(columnId);
    if (rendered === undefined) {
      rendered = {
        identity: { occurrenceId, projectPath: project.path, groupKey, columnId },
        project,
        field,
        ownedClear,
        element: row.element.createEl('td'),
        contentSignature: '',
      };
      row.cells.set(columnId, rendered);
      this.decorateProjectCell_abyssPrivate(rendered);
    }
    rendered.identity = { occurrenceId, projectPath: project.path, groupKey, columnId };
    rendered.project = project;
    rendered.field = field;
    rendered.ownedClear = ownedClear;
    this.patchProjectCell_abyssPrivate(rendered, grouped);
    return rendered;
  }

  private patchProjectCell_abyssPrivate(rendered: RenderedCellContext, grouped: boolean): void {
    const { element: cell, field } = rendered;
    const invalidRange = this.patchProjectCellAttributes_abyssPrivate(rendered);
    const contentSignature = this.projectCellContentSignature_abyssPrivate(
      rendered,
      grouped,
      invalidRange,
    );
    if (contentSignature === rendered.contentSignature) return;
    rendered.contentSignature = contentSignature;
    cell.empty();
    const content =
      field.type === 'name' ? cell.createDiv({ cls: 'abyss-project-table-name-content' }) : cell;
    this.renderProjectCellContent_abyssPrivate(content, rendered);
    if (invalidRange) {
      cell.createSpan({
        cls: 'abyss-project-table-range-warning',
        text: '!',
        attr: { 'aria-label': 'Invalid date range' },
      });
    }
  }

  private patchProjectCellAttributes_abyssPrivate(rendered: RenderedCellContext): boolean {
    const { element: cell, project, field } = rendered;
    cell.className = `abyss-project-table-cell${field.type === 'name' ? ' abyss-project-table-name-cell' : ''}`;
    cell.tabIndex = 0;
    cell.dataset['columnId'] = rendered.identity.columnId;
    cell.setAttribute('aria-label', `${field.label} for ${project.name}`);
    if (field.type === 'name') {
      cell.setAttribute('aria-description', 'Use the context menu to add or edit the description');
      cell.setAttribute('aria-keyshortcuts', 'Shift+F10');
    }
    const invalidRange =
      (field.id === 'start' || field.id === 'end') &&
      this.projectHasInvalidRange_abyssPrivate(project);
    cell.toggleClass('is-invalid-range', invalidRange);
    if (invalidRange) {
      cell.setAttribute('aria-invalid', 'true');
      cell.setAttribute('title', 'Project start is after its end date');
    } else {
      cell.removeAttribute('aria-invalid');
      cell.removeAttribute('title');
    }
    if (editableField(field)) cell.addClass('is-editable');
    return invalidRange;
  }

  private projectCellContentSignature_abyssPrivate(
    rendered: RenderedCellContext,
    grouped: boolean,
    invalidRange: boolean,
  ): string {
    const { project, field } = rendered;
    const descriptionField =
      field.type === 'name'
        ? findProjectFieldById(this.fields_abyssPrivate, 'description')
        : undefined;
    return JSON.stringify({
      field,
      value: projectFieldValue(project, field),
      name: project.name,
      path: project.path,
      statusId: project.statusId,
      rawStatus: project.rawStatus,
      stats: field.type === 'progress' ? project.stats : undefined,
      statuses:
        field.type === 'status' ? this.context_abyssPrivate.settings.projects.statuses : undefined,
      invalidRange,
      ownedClear: rendered.ownedClear,
      grouped,
      description:
        descriptionField === undefined
          ? undefined
          : {
              field: descriptionField,
              value: projectFieldValue(project, descriptionField),
              show: this.context_abyssPrivate.settings.projects.table.showDescription,
            },
    });
  }

  private renderProjectCellContent_abyssPrivate(
    content: HTMLElement,
    rendered: RenderedCellContext,
  ): void {
    const descriptionField = findProjectFieldById(this.fields_abyssPrivate, 'description');
    const effectiveDescription =
      descriptionField === undefined
        ? undefined
        : this.effectiveField_abyssPrivate(rendered.project, descriptionField);
    renderProjectTableCell(content, rendered.project, {
      field: rendered.field,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      app: this.context_abyssPrivate.app,
      component: this.markdown_abyssPrivate,
      beforeOpenLink: () => this.requestFinishActiveEditor(),
      openProject: (path) => {
        this.finishEditorBeforeAction(() => {
          this.context_abyssPrivate.openProject(path);
        });
      },
      onRemoveListValue: (valueIndex) => {
        this.requestRemoveListValue_abyssPrivate(
          rendered.project,
          rendered.field,
          rendered.ownedClear,
          valueIndex,
        );
      },
      onToggleCheckbox: (value, input) => {
        this.requestToggleCheckbox_abyssPrivate(rendered, value, input);
      },
      ...(rendered.field.type !== 'name' || effectiveDescription === undefined
        ? {}
        : {
            description: {
              field: effectiveDescription.field,
              show: this.context_abyssPrivate.settings.projects.table.showDescription,
              onEdit: (anchor: HTMLElement) => {
                this.editDescription_abyssPrivate(
                  rendered,
                  effectiveDescription.field,
                  effectiveDescription.ownedClear,
                  anchor,
                );
              },
            },
          }),
    });
  }

  private editDescription_abyssPrivate(
    rendered: RenderedCellContext,
    field: ProjectFieldCatalogItem,
    ownedClear: OwnedInferredPropertyClear | undefined,
    preferredAnchor?: HTMLElement,
  ): void {
    this.finishEditorBeforeAction(() => {
      if (!editableField(field)) return;
      const anchor =
        preferredAnchor?.isConnected === true
          ? preferredAnchor
          : (rendered.element.querySelector<HTMLElement>('.abyss-project-description') ??
            rendered.element
              .querySelector<HTMLElement>('.abyss-project-table-name-content')
              ?.createDiv({
                cls: 'abyss-project-description abyss-project-description-editor-anchor',
              }));
      if (anchor === undefined) return;
      this.selectCell_abyssPrivate(rendered, false);
      this.editCell_abyssPrivate(rendered.element, rendered.project, field, { ownedClear, anchor });
    });
  }

  private showDescriptionMenu_abyssPrivate(
    rendered: RenderedCellContext,
    event: MouseEvent | KeyboardEvent,
  ): boolean {
    const description = findProjectFieldById(this.fields_abyssPrivate, 'description');
    if (rendered.field.type !== 'name' || description === undefined) return false;
    const effective = this.effectiveField_abyssPrivate(rendered.project, description);
    if (!editableField(effective.field)) return false;
    const value = projectFieldValue(rendered.project, effective.field);
    const hasDescription = typeof value === 'string' && value.length > 0;
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(hasDescription ? 'Edit description' : 'Add description')
        .setIcon('pencil')
        .onClick(() => {
          this.editDescription_abyssPrivate(rendered, effective.field, effective.ownedClear);
        });
    });
    if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    else {
      const bounds = rendered.element.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left + 8, y: bounds.bottom }, rendered.element.ownerDocument);
    }
    return true;
  }

  private requestToggleCheckbox_abyssPrivate(
    rendered: RenderedCellContext,
    value: boolean,
    input: HTMLInputElement,
  ): void {
    const { project, field, ownedClear } = rendered;
    const current = projectFieldValue(project, field);
    const restore = (): void => {
      input.checked = current === true;
      input.indeterminate = false;
      input.dataset['indeterminate'] = String(current !== true && current !== false);
    };
    if (this.activeEditor_abyssPrivate !== undefined) restore();
    this.finishEditorBeforeAction(() => {
      if (!editableField(field) || field.type !== 'checkbox') {
        restore();
        return;
      }
      const state = projectCellEditorState(
        project,
        field,
        this.context_abyssPrivate.settings,
        ownedClear,
      );
      void this.applyCellEdit_abyssPrivate({
        project,
        field,
        value,
        expectedValue: state.expectedValue,
        expectedExists: state.expectedExists,
        sourceProperty: state.sourceProperty,
        sourceKey: state.sourceKey,
        ownedClear: state.ownedClear,
      }).catch((error: unknown) => {
        restore();
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(`Could not update ${field.label}: ${message}`);
        if (isProjectEditValidationError(error)) return;
        console.error('[abyss-tasks] Could not update project checkbox property', {
          property: field.property,
          cause: error,
        });
        new Notice(`Could not update ${field.label}: ${message}`);
      });
    });
  }

  private decorateProjectCell_abyssPrivate(rendered: RenderedCellContext): void {
    const cell = rendered.element;
    cell.addEventListener('click', (event) => {
      if (!this.isCellActionTarget_abyssPrivate(event.target, cell)) {
        this.selectCell_abyssPrivate(rendered, event.shiftKey);
      }
    });
    cell.addEventListener('focus', () => {
      if (this.selection_abyssPrivate.focus === undefined)
        this.selectCell_abyssPrivate(rendered, false);
    });
    cell.addEventListener('dblclick', (event) => {
      if (
        !editableField(rendered.field) ||
        this.isCellActionTarget_abyssPrivate(event.target, cell)
      )
        return;
      event.preventDefault();
      this.selectCell_abyssPrivate(rendered, false);
      this.editCell_abyssPrivate(cell, rendered.project, rendered.field, {
        ownedClear: rendered.ownedClear,
      });
    });
    cell.addEventListener('contextmenu', (event) => {
      const field = rendered.field;
      if (
        event.target instanceof Element &&
        event.target.closest('.abyss-project-cell-editor') !== null
      )
        return;
      if (field.type === 'name') {
        if (!this.showDescriptionMenu_abyssPrivate(rendered, event)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!editableField(field)) return;
      event.preventDefault();
      event.stopPropagation();
      const active = this.activeEditor_abyssPrivate;
      if (active?.projectPath === rendered.project.path && active.columnId === rendered.field.id)
        return;
      this.finishEditorBeforeAction(() => {
        this.selectCell_abyssPrivate(rendered, false);
        this.editCell_abyssPrivate(cell, rendered.project, field, {
          ownedClear: rendered.ownedClear,
        });
      });
    });
  }

  private selectableCells_abyssPrivate(): ProjectTableSelectableCell[] {
    return this.renderedCells_abyssPrivate.map(({ identity }) => identity);
  }

  private renderedCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
  ): RenderedCellContext | undefined {
    return this.renderedCells_abyssPrivate.find(
      ({ identity: candidate }) =>
        candidate.occurrenceId === identity.occurrenceId &&
        candidate.columnId === identity.columnId,
    );
  }

  private selectedCells_abyssPrivate(): RenderedCellContext[] {
    return this.selection_abyssPrivate
      .selected(this.selectableCells_abyssPrivate())
      .flatMap((identity) => {
        const cell = this.renderedCell_abyssPrivate(identity);
        return cell === undefined ? [] : [cell];
      });
  }

  private selectCell_abyssPrivate(cell: RenderedCellContext, extend: boolean): void {
    this.selection_abyssPrivate.select(cell.identity, this.selectableCells_abyssPrivate(), extend);
    this.syncSelection_abyssPrivate();
    cell.element.focus({ preventScroll: true });
  }

  private focusSelectionCell_abyssPrivate(identity: ProjectTableSelectableCell): void {
    this.syncSelection_abyssPrivate();
    const rendered = this.renderedCell_abyssPrivate(identity);
    if (rendered === undefined) return;
    rendered.element.focus({ preventScroll: true });
    this.revealSelectionCell_abyssPrivate(rendered.element);
  }

  private syncSelection_abyssPrivate(): void {
    const selected = new Set(
      this.selection_abyssPrivate
        .selected(this.selectableCells_abyssPrivate())
        .map(({ occurrenceId, columnId }) => `${occurrenceId}\u0000${columnId}`),
    );
    const focus = this.selection_abyssPrivate.focus;
    for (const cell of this.renderedCells_abyssPrivate) {
      const key = `${cell.identity.occurrenceId}\u0000${cell.identity.columnId}`;
      cell.element.toggleClass('is-selected', selected.has(key));
      cell.element.toggleClass(
        'is-selection-focus',
        focus?.occurrenceId === cell.identity.occurrenceId &&
          focus.columnId === cell.identity.columnId,
      );
      cell.element.setAttribute('aria-selected', String(selected.has(key)));
    }
  }

  private isCellActionTarget_abyssPrivate(target: EventTarget | null, cell: HTMLElement): boolean {
    if (!(target instanceof Element) || target === cell) return false;
    return (
      target.closest(
        'a, button, input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor',
      ) !== null
    );
  }

  private isTextEditingTarget_abyssPrivate(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return (
      target.closest(
        'input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor',
      ) !== null
    );
  }

  private readonly handleOwnerWindowKeydown_abyssPrivate = (event: KeyboardEvent): void => {
    if (!this.isOwnerWindowF2_abyssPrivate(event)) return;
    const cell = this.keydownCell_abyssPrivate(event.target);
    if (cell === undefined || !editableField(cell.field)) return;
    const selected = this.selection_abyssPrivate.focus;
    if (
      selected !== undefined &&
      (selected.occurrenceId !== cell.identity.occurrenceId ||
        selected.columnId !== cell.identity.columnId)
    )
      return;
    this.handleTableKeydown_abyssPrivate(event);
    if (event.defaultPrevented) event.stopPropagation();
  };

  private listenForOwnerWindowF2_abyssPrivate(): void {
    this.ownerWindow_abyssPrivate?.addEventListener(
      'keydown',
      this.handleOwnerWindowKeydown_abyssPrivate,
      true,
    );
  }

  private isOwnerWindowF2_abyssPrivate(event: KeyboardEvent): boolean {
    return (
      this.mounted_abyssPrivate &&
      this.isUnmodifiedF2_abyssPrivate(event) &&
      !event.isComposing &&
      !this.isTextEditingTarget_abyssPrivate(event.target)
    );
  }

  private isUnmodifiedF2_abyssPrivate(event: KeyboardEvent): boolean {
    return (
      event.key === 'F2' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    );
  }

  private handleTableKeydown_abyssPrivate(event: KeyboardEvent): void {
    if (event.isComposing || this.isTextEditingTarget_abyssPrivate(event.target)) return;
    if (this.handleHistoryShortcut_abyssPrivate(event)) return;
    const modifier = event.metaKey || event.ctrlKey;
    const cell = this.keydownCell_abyssPrivate(event.target);
    if (cell === undefined) return;
    this.ensureSelectionFocus_abyssPrivate(cell);
    if (this.handleSelectionModifier_abyssPrivate(event, modifier)) return;
    if (this.handleSelectionMovement_abyssPrivate(event)) return;
    this.handleSelectionAction_abyssPrivate(event, cell);
  }

  private keydownCell_abyssPrivate(target: EventTarget | null): RenderedCellContext | undefined {
    const element =
      target instanceof Element ? target.closest<HTMLElement>('.abyss-project-table-cell') : null;
    if (element === null) return undefined;
    return this.renderedCells_abyssPrivate.find(({ element: candidate }) => candidate === element);
  }

  private ensureSelectionFocus_abyssPrivate(cell: RenderedCellContext): void {
    if (this.selection_abyssPrivate.focus === undefined) {
      this.selection_abyssPrivate.select(cell.identity, this.selectableCells_abyssPrivate(), false);
    }
  }

  private handleHistoryShortcut_abyssPrivate(event: KeyboardEvent): boolean {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      this.finishEditorBeforeAction(() => {
        this.runHistory_abyssPrivate(event.shiftKey ? 'redo' : 'undo');
      });
      return true;
    }
    return false;
  }

  private handleSelectionModifier_abyssPrivate(event: KeyboardEvent, modifier: boolean): boolean {
    if (modifier && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault();
      this.selection_abyssPrivate.selectCurrentGroup(this.selectableCells_abyssPrivate());
      this.syncSelection_abyssPrivate();
      return true;
    }
    return false;
  }

  private handleSelectionMovement_abyssPrivate(event: KeyboardEvent): boolean {
    const direction = selectionDirectionForKey(event.key);
    let next: ProjectTableSelectableCell | undefined;
    if (direction !== undefined) {
      event.preventDefault();
      next = this.selection_abyssPrivate.move(
        direction,
        this.selectableCells_abyssPrivate(),
        event.shiftKey,
      );
    } else if (event.key === 'Tab') {
      event.preventDefault();
      next = this.selection_abyssPrivate.tab(this.selectableCells_abyssPrivate(), event.shiftKey);
    } else {
      return false;
    }
    if (next === undefined) this.syncSelection_abyssPrivate();
    else this.focusSelectionCell_abyssPrivate(next);
    return true;
  }

  private revealSelectionCell_abyssPrivate(cell: HTMLElement): void {
    const viewport = this.scroll_abyssPrivate.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    const header = this.tableHost_abyssPrivate.querySelector<HTMLElement>(
      '.abyss-project-table-header-cell',
    );
    const pinnedName = this.root_abyssPrivate.classList.contains('is-name-unpinned')
      ? null
      : this.tableHost_abyssPrivate.querySelector<HTMLElement>('.abyss-project-table-name-cell');
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
    this.scroll_abyssPrivate.scrollLeft = Math.max(
      0,
      this.scroll_abyssPrivate.scrollLeft + horizontal,
    );
    this.scroll_abyssPrivate.scrollTop = Math.max(0, this.scroll_abyssPrivate.scrollTop + vertical);
  }

  private handleSelectionAction_abyssPrivate(
    event: KeyboardEvent,
    cell: RenderedCellContext,
  ): void {
    if (this.handleDescriptionMenuKey_abyssPrivate(event, cell)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.selection_abyssPrivate.clear();
      this.syncSelection_abyssPrivate();
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      this.finishEditorBeforeAction(() => {
        this.clearSelection_abyssPrivate();
      });
      return;
    }
    if (event.key !== 'Enter' && !this.isUnmodifiedF2_abyssPrivate(event)) return;
    event.preventDefault();
    const focused = this.selection_abyssPrivate.focus;
    const editorCell = focused === undefined ? cell : this.renderedCell_abyssPrivate(focused);
    if (editorCell !== undefined && editableField(editorCell.field)) {
      this.editCell_abyssPrivate(editorCell.element, editorCell.project, editorCell.field, {
        ownedClear: editorCell.ownedClear,
      });
    }
  }

  private handleDescriptionMenuKey_abyssPrivate(
    event: KeyboardEvent,
    cell: RenderedCellContext,
  ): boolean {
    const requestsMenu = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (!requestsMenu || !this.showDescriptionMenu_abyssPrivate(cell, event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  private rowIds_abyssPrivate(): string[] {
    return [
      ...new Set(this.renderedCells_abyssPrivate.map(({ identity }) => identity.occurrenceId)),
    ];
  }

  private columnIds_abyssPrivate(): string[] {
    return [...new Set(this.renderedCells_abyssPrivate.map(({ identity }) => identity.columnId))];
  }

  private cellAt_abyssPrivate(row: number, column: number): RenderedCellContext | undefined {
    const occurrenceId = this.rowIds_abyssPrivate()[row];
    const columnId = this.columnIds_abyssPrivate()[column];
    if (occurrenceId === undefined || columnId === undefined) return undefined;
    return this.renderedCells_abyssPrivate.find(
      ({ identity }) => identity.occurrenceId === occurrenceId && identity.columnId === columnId,
    );
  }

  private selectionBounds_abyssPrivate(): TableSelectionBounds | undefined {
    const anchor = this.selection_abyssPrivate.anchor;
    const focus = this.selection_abyssPrivate.focus;
    if (anchor === undefined || focus === undefined) return undefined;
    const rowIds = this.rowIds_abyssPrivate();
    const columnIds = this.columnIds_abyssPrivate();
    const anchorRow = rowIds.indexOf(anchor.occurrenceId);
    const focusRow = rowIds.indexOf(focus.occurrenceId);
    const anchorColumn = columnIds.indexOf(anchor.columnId);
    const focusColumn = columnIds.indexOf(focus.columnId);
    if (anchorRow < 0 || focusRow < 0 || anchorColumn < 0 || focusColumn < 0) return undefined;
    return {
      top: Math.min(anchorRow, focusRow),
      left: Math.min(anchorColumn, focusColumn),
      bottom: Math.max(anchorRow, focusRow),
      right: Math.max(anchorColumn, focusColumn),
      focus: { row: focusRow, column: focusColumn },
    };
  }

  private clipboardValue_abyssPrivate(cell: RenderedCellContext): unknown {
    if (cell.field.type === 'name') return cell.project.name;
    if (cell.field.type === 'progress') return projectProgressDisplayValue(cell.project.stats);
    const property =
      cell.field.id === 'status'
        ? this.context_abyssPrivate.settings.projects.statusProperty
        : cell.field.property;
    return property === undefined
      ? undefined
      : findFrontmatterProperty(cell.project.frontmatter, property)?.value;
  }

  private clipboardText_abyssPrivate(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value))
      return value.map((entry) => this.clipboardText_abyssPrivate(entry)).join('\n');
    return clipboardScalarText(value);
  }

  private selectedClipboardRows_abyssPrivate():
    | {
        readonly internal: ProjectClipboardCell[][];
        readonly external: string[][];
      }
    | undefined {
    const bounds = this.selectionBounds_abyssPrivate();
    if (bounds === undefined) return undefined;
    const internal: ProjectClipboardCell[][] = [];
    const external: string[][] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const internalRow: ProjectClipboardCell[] = [];
      const externalRow: string[] = [];
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        const cell = this.cellAt_abyssPrivate(row, column);
        if (cell === undefined) return undefined;
        const value = this.clipboardValue_abyssPrivate(cell);
        internalRow.push({
          value: copyProjectedValue(value),
          sourcePath: cell.project.path,
          fieldType: cell.field.type,
        });
        externalRow.push(this.clipboardText_abyssPrivate(value));
      }
      internal.push(internalRow);
      external.push(externalRow);
    }
    return { internal, external };
  }

  private handleCopy_abyssPrivate(event: ClipboardEvent): void {
    if (this.isTextEditingTarget_abyssPrivate(event.target)) return;
    const rows = this.selectedClipboardRows_abyssPrivate();
    if (rows === undefined || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData(
      PROJECT_TABLE_CLIPBOARD_TYPE,
      encodeProjectTableClipboard(rows.internal),
    );
    event.clipboardData.setData('text/plain', formatProjectTableTsv(rows.external));
  }

  private handlePaste_abyssPrivate(event: ClipboardEvent): void {
    if (this.isTextEditingTarget_abyssPrivate(event.target) || event.clipboardData === null) return;
    const bounds = this.selectionBounds_abyssPrivate();
    if (bounds === undefined) return;
    event.preventDefault();
    try {
      const internal = decodeProjectTableClipboard(
        event.clipboardData.getData(PROJECT_TABLE_CLIPBOARD_TYPE),
      );
      const source =
        internal ??
        parseProjectTableTsv(event.clipboardData.getData('text/plain')).map((row) =>
          row.map(clipboardPayloadFromText),
        );
      this.finishEditorBeforeAction(() => {
        this.pasteCells_abyssPrivate(source, bounds);
      });
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private linkRebaser_abyssPrivate(): ProjectLinkRebaser {
    return {
      resolve: (target: string, sourcePath: string) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
      linktext: (path: string, destinationPath: string) => {
        const file = this.context_abyssPrivate.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile
          ? this.context_abyssPrivate.app.metadataCache.fileToLinktext(file, destinationPath, true)
          : path;
      },
    };
  }

  private pasteCells_abyssPrivate(
    source: ReadonlyArray<readonly ProjectClipboardCell[]>,
    bounds: TableSelectionBounds,
  ): void {
    try {
      const mappings = resolveProjectPasteRectangle(source, {
        selection: bounds,
        focus: bounds.focus,
        rowCount: this.rowIds_abyssPrivate().length,
        columnCount: this.columnIds_abyssPrivate().length,
      });
      const statusNames = this.context_abyssPrivate.settings.projects.statuses.map(
        ({ name }) => name,
      );
      const assignments = mappings.map(({ row, column, source: clipboard }) => {
        const target = this.cellAt_abyssPrivate(row, column);
        if (target === undefined) throw new Error('Clipboard target is no longer visible');
        if (!editableField(target.field)) throw new Error(`${target.field.label} is read-only`);
        const coerced = coerceProjectClipboardValue(clipboard, target.field.type, statusNames);
        const value = rebaseProjectClipboardLinks(
          coerced,
          clipboard.sourcePath,
          target.project.path,
          this.linkRebaser_abyssPrivate(),
        );
        const change = this.changeForCell_abyssPrivate(target, value);
        return {
          key: `${change.path}\u0000${change.sourceProperty?.toLocaleLowerCase()}`,
          value,
          change,
        };
      });
      const changes = deduplicateProjectCellAssignments(assignments).map(({ change }) => change);
      this.runEditBatch_abyssPrivate('Could not paste project cells', changes);
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private changeForCell_abyssPrivate(cell: RenderedCellContext, value: unknown): ProjectCellChange {
    if (!editableField(cell.field)) throw new Error(`${cell.field.label} is read-only`);
    const state = projectCellEditorState(
      cell.project,
      cell.field,
      this.context_abyssPrivate.settings,
      cell.ownedClear,
    );
    return {
      path: cell.project.path,
      field: cell.field,
      value,
      expectedValue: copyProjectedValue(state.expectedValue),
      expectedExists: state.expectedExists,
      sourceProperty: state.sourceProperty,
      ...(state.sourceKey === undefined ? {} : { sourceKey: state.sourceKey }),
      ...(state.ownedClear === undefined ? {} : { ownedClear: state.ownedClear }),
    };
  }

  private clearSelection_abyssPrivate(): void {
    try {
      const assignments = this.selectedCells_abyssPrivate().map((cell) => {
        const change = this.changeForCell_abyssPrivate(cell, undefined);
        return {
          key: `${change.path}\u0000${change.sourceProperty?.toLocaleLowerCase()}`,
          value: undefined,
          change,
        };
      });
      if (assignments.length === 0) return;
      const changes = deduplicateProjectCellAssignments(assignments).map(({ change }) => change);
      this.runEditBatch_abyssPrivate('Could not clear project cells', changes);
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private runEditBatch_abyssPrivate(label: string, changes: readonly ProjectCellChange[]): void {
    this.runTableAction_abyssPrivate(label, async () => {
      const result = await this.context_abyssPrivate.applyEdits(changes);
      this.context_abyssPrivate.history.record(result);
      this.publishAppliedReceipts(result.applied);
      return result;
    });
  }

  private runHistory_abyssPrivate(direction: 'undo' | 'redo'): void {
    this.runTableAction_abyssPrivate(
      direction === 'undo' ? 'Could not undo project edits' : 'Could not redo project edits',
      async () => {
        const result = await this.context_abyssPrivate.history[direction]();
        this.publishAppliedReceipts(result.applied);
        return result;
      },
    );
  }

  private runTableAction_abyssPrivate(
    label: string,
    mutation: () => Promise<ProjectEditResult>,
  ): void {
    this.feedback_abyssPrivate.empty();
    void this.runTableSessionMutation(mutation).then(
      (result) => {
        if (result.failed.length === 0) return;
        const first = result.failed[0];
        const firstFailure = first === undefined ? '' : `: ${first.message}`;
        const message = `${result.applied.length} updated; ${result.failed.length} failed${firstFailure}`;
        this.feedback_abyssPrivate.setText(message);
        console.error(`[abyss-tasks] ${label}`, { result });
        new Notice(`${label}: ${message}`);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(message);
        if (isProjectEditValidationError(error)) return;
        console.error(`[abyss-tasks] ${label}`, error);
        new Notice(`${label}: ${message}`);
      },
    );
  }

  private showInputFailure_abyssPrivate(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.feedback_abyssPrivate.setText(message);
  }

  private bindProjectRowDrag_abyssPrivate(rendered: RenderedProjectRow): () => void {
    const row = rendered.element;
    let suppressClick = false;
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
      if (!row.draggable || this.isProtectedRowDragTarget_abyssPrivate(origin, row)) {
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
      this.activeRowDrag_abyssPrivate = payload;
      row.addClass('is-dragging');
      suppressClick = true;
    };
    const finishDrag = (): void => {
      clearGesture();
      row.removeClass('is-dragging');
      this.activeRowDrag_abyssPrivate = undefined;
      this.clearGroupDropStates_abyssPrivate();
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
    };
    const suppressDraggedClick = (event: MouseEvent): void => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const dropCleanup = this.bindGroupDropTarget_abyssPrivate(row, () => rendered.groupKey);
    row.addEventListener('pointerdown', rememberGesture, true);
    row.addEventListener('dragstart', startDrag);
    row.addEventListener('dragend', finishDrag);
    row.addEventListener('click', suppressDraggedClick, true);
    return () => {
      clearGesture();
      dropCleanup();
      row.removeEventListener('pointerdown', rememberGesture, true);
      row.removeEventListener('dragstart', startDrag);
      row.removeEventListener('dragend', finishDrag);
      row.removeEventListener('click', suppressDraggedClick, true);
    };
  }

  private isProtectedRowDragTarget_abyssPrivate(
    target: EventTarget | null,
    row: HTMLTableRowElement,
  ): boolean {
    if (this.activeEditor_abyssPrivate !== undefined || !(target instanceof Element)) return true;
    const action = target.closest(
      'a, input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor, button',
    );
    if (action === null || !row.contains(action)) return false;
    return !action.classList.contains('abyss-project-table-name');
  }

  private readRowDragPayload_abyssPrivate(
    dataTransfer: DataTransfer,
  ): ProjectRowDragPayload | undefined {
    try {
      const value = JSON.parse(
        dataTransfer.getData(PROJECT_TABLE_ROW_DRAG_TYPE),
      ) as Partial<ProjectRowDragPayload>;
      return value.version === 1 &&
        typeof value.projectPath === 'string' &&
        typeof value.occurrenceId === 'string' &&
        typeof value.sourceGroupKey === 'string'
        ? (value as ProjectRowDragPayload)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private groupDropPlan_abyssPrivate(
    payload: ProjectRowDragPayload,
    targetGroupKey: string,
  ): {
    readonly cell: RenderedCellContext;
    readonly value: unknown;
    readonly target: RenderedGroupContext;
  } {
    const source = this.renderedGroups_abyssPrivate.get(payload.sourceGroupKey);
    const target = this.renderedGroups_abyssPrivate.get(targetGroupKey);
    if (source === undefined || target === undefined) {
      throw new Error('Project group is no longer visible');
    }
    const sourceCell = this.renderedCells_abyssPrivate.find(
      ({ identity }) =>
        identity.occurrenceId === payload.occurrenceId &&
        identity.projectPath === payload.projectPath &&
        identity.groupKey === payload.sourceGroupKey,
    );
    if (sourceCell === undefined) throw new Error('Project row is no longer visible');
    const visibleProject = sourceCell.project;
    const groupField = findProjectFieldById(
      this.fields_abyssPrivate,
      this.context_abyssPrivate.settings.projects.table.groupBy,
    );
    if (groupField === undefined) throw new Error('Project grouping field is unavailable');
    const effective = this.effectiveField_abyssPrivate(visibleProject, groupField);
    const cell: RenderedCellContext = {
      identity: {
        occurrenceId: payload.occurrenceId,
        projectPath: visibleProject.path,
        groupKey: payload.sourceGroupKey,
        columnId: effective.field.id,
      },
      project: visibleProject,
      field: effective.field,
      ownedClear: effective.ownedClear,
      element: this.tableHost_abyssPrivate,
      contentSignature: '',
    };
    const currentValue = editableField(effective.field)
      ? projectCellSourceValue(
          visibleProject,
          effective.field,
          this.context_abyssPrivate.settings.projects,
        )
      : undefined;
    const value = planProjectGroupDrop({
      field: effective.field,
      currentValue,
      projectPath: visibleProject.path,
      source,
      target,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      groupIdentity: (raw, sourcePath) =>
        projectTableGroupLinkIdentity(
          raw,
          sourcePath,
          (linkTarget, linkSourcePath) =>
            this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(
              linkTarget,
              linkSourcePath,
            )?.path,
        ),
      rebase: (raw, sourcePath, destinationPath) =>
        rebaseProjectClipboardLinks(
          raw,
          sourcePath,
          destinationPath,
          this.linkRebaser_abyssPrivate(),
        ),
    });
    return { cell, value, target };
  }

  private previewGroupDrop_abyssPrivate(targetGroupKey: string): {
    readonly allowed: boolean;
    readonly message: string;
  } {
    const payload = this.activeRowDrag_abyssPrivate;
    if (payload === undefined) return { allowed: false, message: 'Invalid project row drag' };
    try {
      const plan = this.groupDropPlan_abyssPrivate(payload, targetGroupKey);
      const clearsList =
        (plan.cell.field.type === 'list' || plan.cell.field.type === 'tags') &&
        (targetGroupKey === 'empty' || targetGroupKey === 'none');
      return {
        allowed: true,
        message: clearsList
          ? `Drop to clear the entire ${plan.cell.field.label} list`
          : `Drop to move to ${plan.target.label}`,
      };
    } catch (error) {
      return {
        allowed: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private dropProjectIntoGroup_abyssPrivate(
    dataTransfer: DataTransfer,
    targetGroupKey: string,
  ): void {
    const active = this.activeRowDrag_abyssPrivate;
    const payload = this.readRowDragPayload_abyssPrivate(dataTransfer);
    this.activeRowDrag_abyssPrivate = undefined;
    if (payload === undefined || active === undefined || !sameRowDragPayload(payload, active)) {
      this.showInputFailure_abyssPrivate(new Error('Invalid project row drag'));
      return;
    }
    this.finishEditorBeforeAction(() => {
      try {
        const plan = this.groupDropPlan_abyssPrivate(payload, targetGroupKey);
        const change = this.changeForCell_abyssPrivate(plan.cell, plan.value);
        if (equalProjectedValue(change.expectedValue, change.value)) return;
        this.runEditBatch_abyssPrivate('Could not move project to group', [change]);
      } catch (error) {
        this.showInputFailure_abyssPrivate(error);
      }
    });
  }

  private clearGroupDropStates_abyssPrivate(): void {
    for (const row of this.tableHost_abyssPrivate.querySelectorAll<HTMLElement>(
      '.abyss-project-table-group-row, .abyss-project-table-row',
    )) {
      row.removeClass('is-drop-target', 'is-drop-disabled');
      row.querySelector<HTMLElement>('.abyss-project-table-drop-hint')?.empty();
      row.removeAttribute('title');
    }
  }

  private requestRemoveListValue_abyssPrivate(
    project: Project,
    field: ProjectFieldCatalogItem,
    ownedClear: OwnedInferredPropertyClear | undefined,
    valueIndex: number,
  ): void {
    this.finishEditorBeforeAction(() => {
      if (!editableField(field) || field.property === undefined) return;
      const current = projectCellSourceValue(
        project,
        field,
        this.context_abyssPrivate.settings.projects,
      );
      if (!Array.isArray(current)) return;
      this.removeListValue_abyssPrivate({
        ...projectCellEditorState(project, field, this.context_abyssPrivate.settings, ownedClear),
        project,
        field,
        value: current.filter((_value, index) => index !== valueIndex),
        expectedValue: current,
      });
    });
  }

  private finishEditorNavigation_abyssPrivate(
    edited: ProjectTableSelectableCell | undefined,
    navigation: ProjectCellEditorNavigation,
    deliberateFocus?: ProjectTableSelectableCell,
  ): void {
    const cells = this.selectableCells_abyssPrivate();
    if (navigation === 'preserve-focus') {
      if (deliberateFocus === undefined) return;
      const target = this.currentProjectionCell_abyssPrivate(deliberateFocus, cells);
      if (target === undefined) return;
      this.selection_abyssPrivate.select(target, cells, false);
      this.focusSelectionCell_abyssPrivate(target);
      return;
    }
    if (edited === undefined) return;
    const origin = this.currentProjectionCell_abyssPrivate(edited, cells);
    if (origin === undefined) return;
    this.selection_abyssPrivate.select(origin, cells, false);
    const target =
      navigation === 'restore-current'
        ? origin
        : this.selection_abyssPrivate.tab(cells, navigation === 'tab-backward');
    if (target !== undefined) this.focusSelectionCell_abyssPrivate(target);
  }

  private editorCloseDestination_abyssPrivate(
    edited: ProjectTableSelectableCell | undefined,
    navigation: ProjectCellEditorNavigation,
    initialTarget: HTMLElement | undefined,
    editorCell: HTMLElement,
  ): EditorCloseDestination {
    const initialCell = this.keydownCell_abyssPrivate(initialTarget ?? null)?.identity;
    const activeElement = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    const activeCell = this.keydownCell_abyssPrivate(activeElement)?.identity;
    const selectedCell = this.selection_abyssPrivate.focus;
    const selectionMoved =
      selectedCell !== undefined &&
      edited !== undefined &&
      (selectedCell.occurrenceId !== edited.occurrenceId ||
        selectedCell.columnId !== edited.columnId);
    return {
      cell: activeCell ?? (selectionMoved ? selectedCell : initialCell),
      preservesExternalFocus:
        navigation === 'preserve-focus' &&
        this.isExternalFocusDestination_abyssPrivate(activeElement, activeCell, editorCell),
    };
  }

  private isExternalFocusDestination_abyssPrivate(
    activeElement: Element | null,
    activeCell: ProjectTableSelectableCell | undefined,
    editorCell: HTMLElement,
  ): boolean {
    if (!(activeElement instanceof HTMLElement)) return false;
    if (!activeElement.isConnected) return false;
    if (activeElement === this.tableHost_abyssPrivate.ownerDocument.body) return false;
    if (activeCell !== undefined) return false;
    return !editorCell.contains(activeElement);
  }

  private currentProjectionCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
    cells: readonly ProjectTableSelectableCell[],
  ): ProjectTableSelectableCell | undefined {
    return (
      cells.find(
        ({ occurrenceId, columnId }) =>
          occurrenceId === identity.occurrenceId && columnId === identity.columnId,
      ) ??
      cells.find(
        ({ projectPath, columnId }) =>
          projectPath === identity.projectPath && columnId === identity.columnId,
      )
    );
  }

  private positionEditorHost_abyssPrivate(
    anchor: HTMLElement,
    host: HTMLElement,
    onMove: () => void,
  ): () => void {
    const stickyHeader = this.table_abyssPrivate?.tHead;
    return mountProjectCellEditorPosition({
      anchor,
      host,
      boundary: this.scroll_abyssPrivate,
      onMove,
      ...(stickyHeader === null || stickyHeader === undefined ? {} : { stickyHeader }),
    });
  }

  private editCell_abyssPrivate(
    cell: HTMLElement,
    project: Project,
    field: ProjectField,
    options: EditCellOptions,
  ): void {
    if (this.activeEditor_abyssPrivate !== undefined || !cell.isConnected) return;
    const { ownedClear } = options;
    const anchor = options.anchor ?? cell;
    const editorState = projectCellEditorState(
      project,
      field,
      this.context_abyssPrivate.settings,
      ownedClear,
    );
    const edited = this.renderedCells_abyssPrivate.find(
      ({ element }) => element === cell,
    )?.identity;
    const editorHost = anchor.createDiv({ cls: 'abyss-project-cell-editor-host' });
    anchor.prepend(editorHost);
    editorHost.toggleClass('is-expanded', field.id === 'description');
    cell.addClass('is-editing');
    anchor.addClass('is-editor-anchor');
    let positionCleanup = (): void => {};
    const handle = mountProjectCellEditor({
      app: this.context_abyssPrivate.app,
      container: editorHost,
      field,
      value: editorState.expectedValue,
      catalog: this.context_abyssPrivate.catalog,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      sourcePath: project.path,
      save: (value) => this.saveEditorValue_abyssPrivate(project, field, editorState, value),
      onClose: (_result, closeContext) => {
        const destination = this.editorCloseDestination_abyssPrivate(
          edited,
          closeContext.navigation,
          closeContext.focusTarget,
          cell,
        );
        positionCleanup();
        editorHost.remove();
        anchor.removeClass('is-editor-anchor');
        if (anchor.hasClass('abyss-project-description-editor-anchor')) anchor.remove();
        cell.removeClass('is-editing');
        this.activeEditor_abyssPrivate = undefined;
        this.renderTable_abyssPrivate();
        const pendingAction = this.pendingAction_abyssPrivate !== undefined;
        this.runPendingAction_abyssPrivate();
        if (!pendingAction && !destination.preservesExternalFocus) {
          this.finishEditorNavigation_abyssPrivate(
            edited,
            closeContext.navigation,
            destination.cell,
          );
        }
      },
      restoreFocus: () => {},
    });
    positionCleanup = this.positionEditorHost_abyssPrivate(anchor, editorHost, () => {
      handle.closeSuggestion();
    });
    this.activeEditor_abyssPrivate = {
      projectPath: project.path,
      columnId: field.id,
      handle,
      positionCleanup,
    };
    handle.focus();
  }

  private async saveEditorValue_abyssPrivate(
    project: Project,
    field: ProjectField,
    state: ProjectCellEditorState,
    value: unknown,
  ): Promise<void> {
    const nextState = await this.applyCellEdit_abyssPrivate({
      project,
      field,
      value,
      expectedValue: state.expectedValue,
      expectedExists: state.expectedExists,
      sourceProperty: state.sourceProperty,
      sourceKey: state.sourceKey,
      ownedClear: state.ownedClear,
    });
    Object.assign(state, nextState);
  }

  private effectiveField_abyssPrivate(
    project: Project,
    field: ProjectFieldCatalogItem,
  ): { readonly field: ProjectFieldCatalogItem; readonly ownedClear?: OwnedInferredPropertyClear } {
    if (field.property === undefined) return { field };
    let ownedClear: OwnedInferredPropertyClear | undefined;
    try {
      ownedClear = this.context_abyssPrivate.history.ownedClear(project.path, field);
    } catch {
      return { field };
    }
    if (ownedClear === undefined) return { field };
    return {
      field: projectFieldWithOwnedClear(
        project,
        field,
        this.context_abyssPrivate.catalog.inspect(field.property),
        ownedClear,
      ),
      ownedClear,
    };
  }

  private async applyCellEdit_abyssPrivate(
    request: ProjectCellEditRequest,
  ): Promise<ProjectCellEditorState> {
    const {
      project,
      field,
      value,
      expectedValue,
      expectedExists,
      sourceProperty,
      sourceKey,
      ownedClear,
    } = request;
    const receipt = await this.runTableSessionMutation(async () => {
      const change: ProjectCellChange = {
        path: project.path,
        field,
        value,
        expectedValue,
        expectedExists,
        sourceProperty,
        ...(sourceKey === undefined ? {} : { sourceKey }),
        ...(ownedClear === undefined ? {} : { ownedClear }),
      };
      const result = await this.context_abyssPrivate.applyEdits([change]);
      this.context_abyssPrivate.history.record(result);
      this.publishAppliedReceipts(result.applied);
      const failure = result.failed[0];
      if (failure !== undefined) throw new Error(failure.message);
      const applied = result.applied[0];
      if (applied === undefined) throw new Error(`Could not update ${field.label}`);
      return applied;
    });
    return {
      expectedValue: copyProjectedValue(receipt.value),
      expectedExists: receipt.appliedExists,
      sourceProperty: receipt.sourceProperty,
      sourceKey: receipt.sourceKey,
      ownedClear: this.context_abyssPrivate.history.ownedClear(project.path, field),
    };
  }

  /** Publishes successful editor, paste, drop, Undo, and Redo receipts into this session. */
  publishAppliedReceipts(receipts: readonly AppliedProjectCellChange[]): void {
    for (const receipt of receipts) {
      this.publishAppliedReceipt_abyssPrivate(receipt);
    }
    this.renderTable_abyssPrivate();
  }

  private publishAppliedReceipt_abyssPrivate(receipt: AppliedProjectCellChange): void {
    const activeRevisions = this.activeMutationSourceRevisions_abyssPrivate;
    const sourceRevisionAtMutationStart =
      activeRevisions !== undefined
        ? (activeRevisions.get(receipt.path) ?? 0)
        : (this.sourceObservations_abyssPrivate.get(receipt.path)?.revision ?? 0);
    const observation = this.sourceObservations_abyssPrivate.get(receipt.path);
    const observedDuringMutation =
      observation !== undefined && observation.revision > sourceRevisionAtMutationStart;
    const key = projectionKey(receipt);
    if (observedDuringMutation && observationMatchesReceipt(observation, receipt)) {
      this.receiptProjections_abyssPrivate.delete(key);
      return;
    }
    const projection: ProjectReceiptProjection = {
      receipt,
      sourceRevisionAtMutationStart,
      ordinal: ++this.nextReceiptOrdinal_abyssPrivate,
    };
    this.receiptProjections_abyssPrivate.set(key, projection);
    if (observedDuringMutation) {
      this.revalidateReceiptProjection_abyssPrivate(key, projection, observation);
    }
  }

  private revalidateReceiptProjection_abyssPrivate(
    key: string,
    projection: ProjectReceiptProjection,
    observation: ProjectSourceObservation,
  ): void {
    void this.context_abyssPrivate.revalidateSourceObservation(observation).then(
      (current) => {
        if (!current || this.receiptProjections_abyssPrivate.get(key) !== projection) return;
        if (this.sourceObservations_abyssPrivate.get(observation.path) !== observation) return;
        this.receiptProjections_abyssPrivate.delete(key);
        this.renderTable_abyssPrivate();
      },
      (error: unknown) => {
        console.error('[abyss-tasks] Could not revalidate project receipt projection', {
          path: observation.path,
          cause: error,
        });
      },
    );
  }

  private projectedProjects_abyssPrivate(): readonly Project[] {
    const byPath = new Map<string, ProjectReceiptProjection[]>();
    for (const projection of this.receiptProjections_abyssPrivate.values()) {
      const projections = byPath.get(projection.receipt.path) ?? [];
      projections.push(projection);
      byPath.set(projection.receipt.path, projections);
    }
    return this.projects_abyssPrivate.map((project) => {
      const projections = byPath.get(project.path);
      if (projections === undefined) return project;
      const frontmatter = { ...project.frontmatter };
      const sortedProjections = [...projections];
      sortedProjections.sort((left, right) => left.ordinal - right.ordinal);
      for (const { receipt } of sortedProjections) {
        if (receipt.appliedExists) {
          frontmatter[receipt.sourceKey] = copyProjectedValue(receipt.value);
        } else {
          delete frontmatter[receipt.sourceKey];
        }
      }
      return {
        ...project,
        frontmatter,
        ...resolveStatus(this.context_abyssPrivate.settings.projects, frontmatter),
      };
    });
  }

  private removeListValue_abyssPrivate(request: RemoveListValueRequest): void {
    const { field } = request;
    this.applyCellEdit_abyssPrivate(request).then(
      () => undefined,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(`Could not update ${field.label}: ${message}`);
        if (isProjectEditValidationError(error)) return;
        console.error('[abyss-tasks] Could not update project list property', {
          property: field.property,
          cause: error,
        });
        new Notice(`Could not update ${field.label}: ${message}`);
      },
    );
  }

  private findOccurrenceCell_abyssPrivate(
    occurrenceId: string,
    columnId: string,
  ): HTMLElement | null {
    const row = Array.from(
      this.tableHost_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-project-table-row'),
    ).find((candidate) => candidate.dataset['occurrenceId'] === occurrenceId);
    return (
      Array.from(row?.querySelectorAll<HTMLElement>('.abyss-project-table-cell') ?? []).find(
        (cell) => cell.dataset['columnId'] === columnId,
      ) ?? null
    );
  }

  private projectHasInvalidRange_abyssPrivate(project: Project): boolean {
    const startField = findProjectFieldById(this.fields_abyssPrivate, 'start');
    const endField = findProjectFieldById(this.fields_abyssPrivate, 'end');
    if (startField === undefined || endField === undefined) return false;
    const start = projectFieldValue(project, startField);
    const end = projectFieldValue(project, endField);
    return (
      typeof start === 'string' &&
      typeof end === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(start) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(end) &&
      start > end
    );
  }
}
