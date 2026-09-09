import { Component, Notice, type App } from 'obsidian';
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
import { buildProjectTableModel, type ProjectTableModel } from '../../projects/projectTableModel';
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
  projectTableColumnWidth,
  renderProjectTableColumns,
  type ProjectTableColumnResize,
  type VisibleProjectColumn,
} from './projectTableColumns';

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
}

interface ActiveEditor {
  readonly projectPath: string;
  readonly columnId: string;
  readonly handle: ProjectCellEditorHandle;
}

interface FocusedCellIdentity {
  readonly projectPath: string | undefined;
  readonly columnId: string | undefined;
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
): { readonly projectPath: string; readonly columnId: string } | undefined {
  const row = cell.closest<HTMLElement>('.abyss-project-table-row');
  const projectPath = row?.dataset['projectPath'];
  if (row === null || projectPath === undefined) return undefined;
  const cells = Array.from(row.querySelectorAll<HTMLElement>('.abyss-project-table-cell'));
  const index = cells.indexOf(cell);
  const next = cells[index + 1] ?? cells[0];
  const columnId = next?.dataset['columnId'];
  return next === undefined || columnId === undefined ? undefined : { projectPath, columnId };
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
  private columnCleanup_abyssPrivate: (() => void) | undefined;
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
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
    });
    this.tableHost_abyssPrivate = this.scroll_abyssPrivate.createDiv({
      cls: 'abyss-project-table-host',
    });
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
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.toolbar_abyssPrivate.destroy();
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
    const scrollTop = this.scroll_abyssPrivate.scrollTop;
    const scrollLeft = this.scroll_abyssPrivate.scrollLeft;
    const focusedIdentity = this.focusedCellIdentity_abyssPrivate();
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.tableHost_abyssPrivate.empty();

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
      this.renderProjectRow_abyssPrivate(body, project, columns);
    }
  }

  private restoreTablePosition_abyssPrivate(
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    this.scroll_abyssPrivate.scrollTop = scrollTop;
    this.scroll_abyssPrivate.scrollLeft = scrollLeft;
    if (focusedIdentity?.projectPath === undefined || focusedIdentity.columnId === undefined)
      return;
    this.findCell_abyssPrivate(focusedIdentity.projectPath, focusedIdentity.columnId)?.focus({
      preventScroll: true,
    });
  }

  private renderGroup_abyssPrivate(
    body: HTMLTableSectionElement,
    options: RenderGroupOptions,
  ): void {
    const { key, label, value, sourcePath, count, columnCount, statuses } = options;
    const row = body.createEl('tr', { cls: 'abyss-project-table-group-row' });
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
    button.addEventListener('click', () => {
      this.finishEditorBeforeAction(() => {
        if (collapsed) this.collapsedGroups_abyssPrivate.delete(key);
        else this.collapsedGroups_abyssPrivate.add(key);
        this.renderTable_abyssPrivate();
      });
    });
  }

  private focusedCellIdentity_abyssPrivate(): FocusedCellIdentity | undefined {
    const active = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    const focusedCell = active?.closest<HTMLElement>('.abyss-project-table-cell');
    if (focusedCell === undefined || focusedCell === null) return undefined;
    return {
      projectPath: focusedCell.closest<HTMLElement>('.abyss-project-table-row')?.dataset[
        'projectPath'
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

  private renderProjectRow_abyssPrivate(
    body: HTMLTableSectionElement,
    project: Project,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const row = body.createEl('tr', {
      cls: 'abyss-project-table-row',
      attr: { 'data-project-path': project.path },
    });
    for (const { column, field: rawField } of columns) {
      const { field, ownedClear } = this.effectiveField_abyssPrivate(project, rawField);
      const cell = row.createEl('td', {
        cls: `abyss-project-table-cell${field.type === 'name' ? ' abyss-project-table-name-cell' : ''}`,
        attr: {
          tabindex: '0',
          'data-column-id': column.id,
          'aria-label': `${field.label} for ${project.name}`,
        },
      });
      renderProjectTableCell(cell, project, {
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
      if (editableField(field)) {
        cell.addClass('is-editable');
        cell.addEventListener('click', () => {
          this.editCell_abyssPrivate(cell, project, field, ownedClear);
        });
        cell.addEventListener('dblclick', () => {
          this.editCell_abyssPrivate(cell, project, field, ownedClear);
        });
        cell.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          this.editCell_abyssPrivate(cell, project, field, ownedClear);
        });
      }
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
        const target = closeContext.restoreFocus
          ? { projectPath: project.path, columnId: field.id }
          : nextCell;
        if (target !== undefined) {
          this.findCell_abyssPrivate(target.projectPath, target.columnId)?.focus({
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
      const sourceRevisionAtMutationStart =
        this.activeMutationSourceRevisions_abyssPrivate?.get(receipt.path) ??
        this.sourceObservations_abyssPrivate.get(receipt.path)?.revision ??
        0;
      const observation = this.sourceObservations_abyssPrivate.get(receipt.path);
      const observedDuringMutation =
        observation !== undefined && observation.revision > sourceRevisionAtMutationStart;
      const key = projectionKey(receipt);
      if (observedDuringMutation && observationMatchesReceipt(observation, receipt)) {
        this.receiptProjections_abyssPrivate.delete(key);
        continue;
      }
      this.receiptProjections_abyssPrivate.set(key, {
        receipt,
        sourceRevisionAtMutationStart,
        ordinal: ++this.nextReceiptOrdinal_abyssPrivate,
      });
    }
    this.renderTable_abyssPrivate();
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

  private findCell_abyssPrivate(projectPath: string, columnId: string): HTMLElement | null {
    const row = Array.from(
      this.tableHost_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-project-table-row'),
    ).find((candidate) => candidate.dataset['projectPath'] === projectPath);
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
