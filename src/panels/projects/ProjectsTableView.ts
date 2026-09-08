import { Notice, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import {
  buildProjectFieldCatalog,
  findProjectFieldById,
  isAvailableProjectField,
  projectFieldValue,
  type ProjectField,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import { buildProjectTableModel, type ProjectTableModel } from '../../projects/projectTableModel';
import { buildDefaultProjectTableSettings } from '../../projects/projectTableSettings';
import type { Project } from '../../projects/types';
import {
  enforceProjectTableColumnInvariants,
  setProjectColumnLabel,
  setProjectColumnWidth,
} from '../../settings/projectTableSettings';
import type { CalendarSettings } from '../../settings/types';
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
  readonly saveProperty: (
    path: string,
    field: ProjectField,
    value: unknown,
    expectedValue: unknown,
  ) => Promise<void>;
  readonly saveStatus: (
    path: string,
    statusId: string,
    expectedStatus: Pick<Project, 'statusId' | 'rawStatus'>,
  ) => Promise<void>;
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

interface RenderGroupOptions {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly columnCount: number;
  readonly statuses: ProjectTableModel['availableStatusGroups'];
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

export class ProjectsTableView {
  private projects_abyssPrivate: readonly Project[] = [];
  private fields_abyssPrivate: readonly ProjectFieldCatalogItem[] = [];
  private readonly root_abyssPrivate: HTMLElement;
  private readonly scroll_abyssPrivate: HTMLElement;
  private readonly tableHost_abyssPrivate: HTMLElement;
  private readonly feedback_abyssPrivate: HTMLElement;
  private readonly count_abyssPrivate: HTMLElement;
  private readonly toolbar_abyssPrivate: ProjectsTableToolbar;
  private activeEditor_abyssPrivate: ActiveEditor | undefined;
  private columnCleanup_abyssPrivate: (() => void) | undefined;
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private search_abyssPrivate = '';
  private mounted_abyssPrivate = false;

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
        this.search_abyssPrivate = query;
        this.renderTable_abyssPrivate();
      },
      onStatusToggle: (key) => {
        this.toggleStatus_abyssPrivate(key);
      },
      onViewChange: () => {
        this.persistAndRender_abyssPrivate();
      },
      onReset: () => {
        const defaults = buildDefaultProjectTableSettings();
        const table = this.context_abyssPrivate.settings.projects.table;
        table.groupBy = defaults.groupBy;
        table.sortBy = defaults.sortBy;
        table.hiddenStatuses = defaults.hiddenStatuses;
        this.persistAndRender_abyssPrivate();
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
      this.showNewProjectInput_abyssPrivate();
    });
    this.count_abyssPrivate = footer.createSpan({ cls: 'abyss-project-table-count' });
  }

  mount(projects: readonly Project[]): void {
    this.mounted_abyssPrivate = true;
    this.projects_abyssPrivate = projects;
    this.refreshFields();
  }

  update(projects: readonly Project[]): void {
    this.projects_abyssPrivate = projects;
    if (this.activeEditor_abyssPrivate !== undefined) return;
    this.renderTable_abyssPrivate();
  }

  refreshFields(): void {
    this.fields_abyssPrivate = buildProjectFieldCatalog(
      this.context_abyssPrivate.settings.projects,
      this.context_abyssPrivate.catalog.list(),
    );
    if (this.activeEditor_abyssPrivate !== undefined) return;
    this.renderTable_abyssPrivate();
  }

  destroy(): void {
    this.mounted_abyssPrivate = false;
    this.activeEditor_abyssPrivate?.handle.destroy();
    this.activeEditor_abyssPrivate = undefined;
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.toolbar_abyssPrivate.destroy();
    this.root_abyssPrivate.remove();
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
      projects: this.projects_abyssPrivate,
      fields: this.fields_abyssPrivate,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      settings: tableSettings,
      search: this.search_abyssPrivate,
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
        this.sortByColumn_abyssPrivate(field);
      },
      onRename: (columnId, label) => {
        this.renameColumn_abyssPrivate(columnId, label);
      },
      onMove: (columnId, targetColumnId, placement) => {
        this.moveColumn_abyssPrivate(columnId, targetColumnId, placement);
      },
      onResize: (resize) => {
        this.resizeColumns_abyssPrivate(resize);
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
    const { key, label, count, columnCount, statuses } = options;
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
    button.createSpan({ cls: 'abyss-projects-group-label', text: label });
    button.createSpan({ cls: 'abyss-projects-group-count', text: String(count) });
    button.addEventListener('click', () => {
      if (collapsed) this.collapsedGroups_abyssPrivate.delete(key);
      else this.collapsedGroups_abyssPrivate.add(key);
      this.renderTable_abyssPrivate();
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
    for (const { column, field } of columns) {
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
        openProject: this.context_abyssPrivate.openProject,
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
          this.editCell_abyssPrivate(cell, project, field);
        });
        cell.addEventListener('dblclick', () => {
          this.editCell_abyssPrivate(cell, project, field);
        });
        cell.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          this.editCell_abyssPrivate(cell, project, field);
        });
      }
    }
  }

  private editCell_abyssPrivate(cell: HTMLElement, project: Project, field: ProjectField): void {
    if (this.activeEditor_abyssPrivate !== undefined || !cell.isConnected) return;
    const expectedValue = projectFieldValue(project, field);
    const expectedStatus = { statusId: project.statusId, rawStatus: project.rawStatus };
    const nextCell = nextCellIdentity(cell);
    cell.empty();
    const handle = mountProjectCellEditor({
      app: this.context_abyssPrivate.app,
      container: cell,
      field,
      value: expectedValue,
      catalog: this.context_abyssPrivate.catalog,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      sourcePath: project.path,
      save: async (value) => {
        if (field.type === 'status') {
          await this.context_abyssPrivate.saveStatus(project.path, String(value), {
            ...expectedStatus,
          });
        } else {
          await this.context_abyssPrivate.saveProperty(project.path, field, value, expectedValue);
        }
      },
      onClose: (_result, closeContext) => {
        this.activeEditor_abyssPrivate = undefined;
        this.renderTable_abyssPrivate();
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
