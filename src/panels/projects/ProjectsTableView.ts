import { Component, Notice, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { parseLinks } from '../../markdown/links';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import type { ProjectSourceObservation } from '../../projects/ProjectStore';
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
import { mountProjectCellEditor, type ProjectCellEditorHandle } from './ProjectCellEditor';
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
  readonly saveSettings: () => Promise<void>;
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
  readonly identity: ProjectTableSelectableCell;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
  readonly element: HTMLElement;
}

interface RenderedGroupContext extends ProjectTableDragGroup {
  readonly label: string;
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
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly columnCount: number;
  readonly statuses: ProjectTableModel['availableStatusGroups'];
  readonly value: unknown;
  readonly sourcePath?: string;
}

interface RenderTableGroupOptions {
  readonly body: HTMLTableSectionElement;
  readonly group: ProjectTableModel['groups'][number];
  readonly columns: readonly VisibleProjectColumn[];
  readonly grouped: boolean;
  readonly statuses: ProjectTableModel['availableStatusGroups'];
}

interface RenderProjectRowOptions {
  readonly body: HTMLTableSectionElement;
  readonly project: Project;
  readonly columns: readonly VisibleProjectColumn[];
  readonly group: ProjectTableModel['groups'][number];
  readonly grouped: boolean;
}

interface RenderProjectCellOptions {
  readonly row: HTMLTableRowElement;
  readonly rowOptions: RenderProjectRowOptions;
  readonly field: ProjectFieldCatalogItem;
  readonly columnId: string;
  readonly occurrenceId: string;
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

function nextCellIdentity(
  cell: HTMLElement,
): { readonly occurrenceId: string; readonly columnId: string } | undefined {
  const row = cell.closest<HTMLElement>('.abyss-project-table-row');
  const occurrenceId = row?.dataset['occurrenceId'];
  if (row === null || occurrenceId === undefined) return undefined;
  const cells = Array.from(row.querySelectorAll<HTMLElement>('.abyss-project-table-cell'));
  const index = cells.indexOf(cell);
  const next = cells[index + 1] ?? cells[0];
  const columnId = next?.dataset['columnId'];
  return next === undefined || columnId === undefined ? undefined : { occurrenceId, columnId };
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
  private activeEditor_abyssPrivate: ActiveEditor | undefined;
  private activeRowDrag_abyssPrivate: ProjectRowDragPayload | undefined;
  private columnCleanup_abyssPrivate: (() => void) | undefined;
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private readonly selection_abyssPrivate = new ProjectTableSelection();
  private renderedCells_abyssPrivate: RenderedCellContext[] = [];
  private readonly renderedGroups_abyssPrivate = new Map<string, RenderedGroupContext>();
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
          const defaults = buildDefaultProjectTableSettings();
          const table = this.context_abyssPrivate.settings.projects.table;
          table.groupBy = defaults.groupBy;
          table.sortBy = defaults.sortBy;
          table.hiddenStatuses = defaults.hiddenStatuses;
          this.persistAndRender_abyssPrivate();
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
        this.updateResponsiveNamePinning_abyssPrivate();
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
    this.activeEditor_abyssPrivate?.handle.destroy();
    this.activeEditor_abyssPrivate = undefined;
    this.activeRowDrag_abyssPrivate = undefined;
    this.selection_abyssPrivate.clear();
    this.renderedCells_abyssPrivate = [];
    this.renderedGroups_abyssPrivate.clear();
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.toolbar_abyssPrivate.destroy();
    this.resizeObserver_abyssPrivate?.disconnect();
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
    void this.context_abyssPrivate.saveSettings().catch((error: unknown) => {
      if (!this.mounted_abyssPrivate) return;
      const message = error instanceof Error ? error.message : String(error);
      this.feedback_abyssPrivate.setText(`Could not save project table settings: ${message}`);
      console.error('[abyss-tasks] Could not save project table settings', error);
      new Notice(`Could not save project table settings: ${message}`);
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
    this.activeRowDrag_abyssPrivate = undefined;
    const scrollTop = this.scroll_abyssPrivate.scrollTop;
    const scrollLeft = this.scroll_abyssPrivate.scrollLeft;
    const focusedIdentity = this.focusedCellIdentity_abyssPrivate();
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.tableHost_abyssPrivate.empty();
    this.renderedCells_abyssPrivate = [];
    this.renderedGroups_abyssPrivate.clear();

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

    const table = this.createTable_abyssPrivate(columns);
    this.renderTableBody_abyssPrivate(table, model, columns);
    this.updateResponsiveNamePinning_abyssPrivate();
    this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    this.syncSelection_abyssPrivate();
    this.restoreTablePosition_abyssPrivate(scrollTop, scrollLeft, focusedIdentity);
  }

  private createTable_abyssPrivate(columns: readonly VisibleProjectColumn[]): HTMLTableElement {
    const table = this.tableHost_abyssPrivate.createEl('table', {
      cls: 'abyss-project-table',
    });
    table.style.minWidth = `${columns.reduce(
      (total, { column, field }) => total + projectTableColumnWidth(column, field),
      0,
    )}px`;
    const tableSettings = this.context_abyssPrivate.settings.projects.table;
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
    table.addEventListener('copy', (event) => {
      this.handleCopy_abyssPrivate(event);
    });
    table.addEventListener('paste', (event) => {
      this.handlePaste_abyssPrivate(event);
    });
    return table;
  }

  private renderTableBody_abyssPrivate(
    table: HTMLTableElement,
    model: ProjectTableModel,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const body = table.createEl('tbody');
    if (model.groups.length === 0) {
      const row = body.createEl('tr');
      row.createEl('td', {
        cls: 'abyss-projects-empty',
        text: this.projects_abyssPrivate.length === 0 ? 'No projects yet' : 'No matching projects',
        attr: { colspan: String(Math.max(1, columns.length)) },
      });
      return;
    }

    const grouped = this.context_abyssPrivate.settings.projects.table.groupBy !== 'none';
    for (const group of model.groups) {
      this.renderTableGroup_abyssPrivate({
        body,
        group,
        columns,
        grouped,
        statuses: model.availableStatusGroups,
      });
    }
  }

  private renderTableGroup_abyssPrivate(options: RenderTableGroupOptions): void {
    const { body, group, columns, grouped, statuses } = options;
    this.renderedGroups_abyssPrivate.set(group.key, {
      key: group.key,
      label: group.label,
      value: group.value,
      ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
    });
    if (grouped) {
      this.renderGroup_abyssPrivate(body, {
        key: group.key,
        label: group.label,
        value: group.value,
        ...(group.sourcePath === undefined ? {} : { sourcePath: group.sourcePath }),
        count: group.projects.length,
        columnCount: columns.length,
        statuses,
      });
    }
    if (grouped && this.collapsedGroups_abyssPrivate.has(group.key)) return;
    for (const project of group.projects) {
      this.renderProjectRow_abyssPrivate({ body, project, columns, group, grouped });
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

  private renderGroup_abyssPrivate(
    body: HTMLTableSectionElement,
    options: RenderGroupOptions,
  ): void {
    const { key, label, value, sourcePath, count, columnCount, statuses } = options;
    const row = body.createEl('tr', {
      cls: 'abyss-project-table-group-row',
      attr: { 'data-group-key': key },
    });
    const cell = row.createEl('td', { attr: { colspan: String(Math.max(1, columnCount)) } });
    const collapsed = this.collapsedGroups_abyssPrivate.has(key);
    const button = cell.createEl('button', {
      cls: 'abyss-project-table-group-toggle',
      attr: {
        type: 'button',
        'aria-expanded': String(!collapsed),
        'data-group-key': key,
      },
    });
    button.createSpan({ cls: 'abyss-project-table-group-chevron', text: collapsed ? '›' : '⌄' });
    const status = statuses.find((candidate) => candidate.key === key);
    if (status?.color !== undefined) {
      const dot = button.createSpan({ cls: 'abyss-status-dot' });
      dot.style.background = status.color;
    }
    const labelEl = button.createSpan({ cls: 'abyss-projects-group-label' });
    if (typeof value === 'string' && sourcePath !== undefined && parseLinks(value).length > 0) {
      renderTaskText(labelEl, value, {
        app: this.context_abyssPrivate.app,
        sourcePath,
        component: this.markdown_abyssPrivate,
        beforeOpenLink: () => this.requestFinishActiveEditor(),
      });
    } else {
      labelEl.setText(label);
    }
    button.createSpan({ cls: 'abyss-projects-group-count', text: String(count) });
    const dropHint = button.createSpan({ cls: 'abyss-project-table-drop-hint' });
    button.addEventListener('click', () => {
      this.finishEditorBeforeAction(() => {
        if (collapsed) this.collapsedGroups_abyssPrivate.delete(key);
        else this.collapsedGroups_abyssPrivate.add(key);
        this.renderTable_abyssPrivate();
      });
    });
    const clearDropState = (): void => {
      row.removeClass('is-drop-target', 'is-drop-disabled');
      dropHint.empty();
    };
    const previewDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      clearDropState();
      const preview = this.previewGroupDrop_abyssPrivate(key);
      if (preview.allowed) {
        row.addClass('is-drop-target');
        event.dataTransfer.dropEffect = 'move';
      } else {
        row.addClass('is-drop-disabled');
        event.dataTransfer.dropEffect = 'none';
      }
      dropHint.setText(preview.message);
      row.setAttribute('title', preview.message);
    };
    row.addEventListener('dragenter', previewDrop);
    row.addEventListener('dragover', previewDrop);
    row.addEventListener('dragleave', (event) => {
      if (!row.contains(event.relatedTarget as Node | null)) clearDropState();
    });
    row.addEventListener('drop', (event) => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      clearDropState();
      this.dropProjectIntoGroup_abyssPrivate(event.dataTransfer, key);
    });
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

  private renderProjectRow_abyssPrivate(options: RenderProjectRowOptions): void {
    const { body, project, columns, group } = options;
    const occurrenceId = `${encodeURIComponent(group.key)}:${encodeURIComponent(project.path)}`;
    const row = body.createEl('tr', {
      cls: 'abyss-project-table-row',
      attr: {
        'data-project-path': project.path,
        'data-occurrence-id': occurrenceId,
        'data-group-key': group.key,
      },
    });
    for (const { column, field: rawField } of columns) {
      this.renderProjectCell_abyssPrivate({
        row,
        rowOptions: options,
        field: rawField,
        columnId: column.id,
        occurrenceId,
      });
    }
  }

  private renderProjectCell_abyssPrivate(options: RenderProjectCellOptions): void {
    const { row, rowOptions, field: rawField, columnId, occurrenceId } = options;
    const { project, group, grouped } = rowOptions;
    const { field, ownedClear } = this.effectiveField_abyssPrivate(project, rawField);
    const cell = row.createEl('td', {
      cls: `abyss-project-table-cell${field.type === 'name' ? ' abyss-project-table-name-cell' : ''}`,
      attr: {
        tabindex: '0',
        'data-column-id': columnId,
        'aria-label': `${field.label} for ${project.name}`,
      },
    });
    const rendered: RenderedCellContext = {
      identity: { occurrenceId, projectPath: project.path, groupKey: group.key, columnId },
      project,
      field,
      ownedClear,
      element: cell,
    };
    this.renderedCells_abyssPrivate.push(rendered);
    const content =
      field.type === 'name' && grouped
        ? cell.createDiv({ cls: 'abyss-project-table-name-content' })
        : cell;
    if (field.type === 'name' && grouped) this.renderRowDragHandle_abyssPrivate(content, rendered);
    this.renderProjectCellContent_abyssPrivate(content, rendered);
    this.decorateProjectCell_abyssPrivate(rendered);
  }

  private renderProjectCellContent_abyssPrivate(
    content: HTMLElement,
    rendered: RenderedCellContext,
  ): void {
    const { project, field, ownedClear } = rendered;
    renderProjectTableCell(content, project, {
      field,
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
        this.requestRemoveListValue_abyssPrivate(project, field, ownedClear, valueIndex);
      },
    });
  }

  private decorateProjectCell_abyssPrivate(rendered: RenderedCellContext): void {
    const { element: cell, project, field, ownedClear } = rendered;
    if (
      (field.id === 'start' || field.id === 'end') &&
      this.projectHasInvalidRange_abyssPrivate(project)
    ) {
      cell.addClass('is-invalid-range');
      cell.setAttribute('aria-invalid', 'true');
      cell.setAttribute('title', 'Project start is after its end date');
      cell.createSpan({
        cls: 'abyss-project-table-range-warning',
        text: '!',
        attr: { 'aria-label': 'Invalid date range' },
      });
    }
    if (editableField(field)) cell.addClass('is-editable');
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
      if (!editableField(field) || this.isCellActionTarget_abyssPrivate(event.target, cell)) return;
      event.preventDefault();
      this.selectCell_abyssPrivate(rendered, false);
      this.editCell_abyssPrivate(cell, project, field, ownedClear);
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
    this.syncSelection_abyssPrivate();
    if (next !== undefined) {
      const rendered = this.renderedCell_abyssPrivate(next);
      rendered?.element.focus({ preventScroll: true });
      if (rendered !== undefined) this.revealSelectionCell_abyssPrivate(rendered.element);
    }
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
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const focused = this.selection_abyssPrivate.focus;
    const editorCell = focused === undefined ? cell : this.renderedCell_abyssPrivate(focused);
    if (editorCell !== undefined && editableField(editorCell.field)) {
      this.editCell_abyssPrivate(
        editorCell.element,
        editorCell.project,
        editorCell.field,
        editorCell.ownedClear,
      );
    }
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

  private renderRowDragHandle_abyssPrivate(cell: HTMLElement, rendered: RenderedCellContext): void {
    const handle = cell.createEl('button', {
      cls: 'abyss-project-table-row-handle',
      text: '⋮⋮',
      attr: {
        type: 'button',
        draggable: 'true',
        tabindex: '-1',
        'aria-label': `Move ${rendered.project.name} to another group`,
        title: `Move ${rendered.project.name} to another group`,
      },
    });
    handle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('dragstart', (event) => {
      const dataTransfer = event.dataTransfer;
      if (dataTransfer === null) return;
      const payload: ProjectRowDragPayload = {
        version: 1,
        projectPath: rendered.project.path,
        occurrenceId: rendered.identity.occurrenceId,
        sourceGroupKey: rendered.identity.groupKey,
      };
      dataTransfer.setData(PROJECT_TABLE_ROW_DRAG_TYPE, JSON.stringify(payload));
      dataTransfer.effectAllowed = 'move';
      this.activeRowDrag_abyssPrivate = payload;
      handle.addClass('is-dragging');
    });
    handle.addEventListener('dragend', () => {
      handle.removeClass('is-dragging');
      this.activeRowDrag_abyssPrivate = undefined;
      this.clearGroupDropStates_abyssPrivate();
    });
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
      '.abyss-project-table-group-row',
    )) {
      row.removeClass('is-drop-target', 'is-drop-disabled');
      row.querySelector<HTMLElement>('.abyss-project-table-drop-hint')?.empty();
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

  private editCell_abyssPrivate(
    cell: HTMLElement,
    project: Project,
    field: ProjectField,
    ownedClear: OwnedInferredPropertyClear | undefined,
  ): void {
    if (this.activeEditor_abyssPrivate !== undefined || !cell.isConnected) return;
    const editorState = projectCellEditorState(
      project,
      field,
      this.context_abyssPrivate.settings,
      ownedClear,
    );
    const nextCell = nextCellIdentity(cell);
    const currentOccurrenceId = cell.closest<HTMLElement>('.abyss-project-table-row')?.dataset[
      'occurrenceId'
    ];
    cell.empty();
    const handle = mountProjectCellEditor({
      app: this.context_abyssPrivate.app,
      container: cell,
      field,
      value: editorState.expectedValue,
      catalog: this.context_abyssPrivate.catalog,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      sourcePath: project.path,
      save: (value) => {
        const pending = this.applyCellEdit_abyssPrivate({
          project,
          field,
          value,
          expectedValue: editorState.expectedValue,
          expectedExists: editorState.expectedExists,
          sourceProperty: editorState.sourceProperty,
          sourceKey: editorState.sourceKey,
          ownedClear: editorState.ownedClear,
        });
        return pending.then((nextState) => {
          editorState.expectedValue = nextState.expectedValue;
          editorState.expectedExists = nextState.expectedExists;
          editorState.sourceProperty = nextState.sourceProperty;
          editorState.sourceKey = nextState.sourceKey;
          editorState.ownedClear = nextState.ownedClear;
        });
      },
      onClose: (_result, closeContext) => {
        this.activeEditor_abyssPrivate = undefined;
        this.renderTable_abyssPrivate();
        this.runPendingAction_abyssPrivate();
        let target = nextCell;
        if (closeContext.restoreFocus) {
          target =
            currentOccurrenceId === undefined
              ? undefined
              : { occurrenceId: currentOccurrenceId, columnId: field.id };
        }
        if (target !== undefined) {
          this.findOccurrenceCell_abyssPrivate(target.occurrenceId, target.columnId)?.focus({
            preventScroll: true,
          });
        }
      },
      restoreFocus: () => {},
    });
    this.activeEditor_abyssPrivate = {
      projectPath: project.path,
      columnId: field.id,
      handle,
    };
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
