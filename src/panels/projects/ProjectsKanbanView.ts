import { setIcon } from 'obsidian';
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
import { projectProgress } from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import {
  projectKanbanCardFields,
  projectKanbanCardKey,
  projectKanbanDescription,
  projectKanbanOccurrenceId,
} from './projectKanbanCards';

export interface ProjectKanbanCellIdentity {
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
  readonly cards: Map<string, ProjectKanbanOccurrenceContext<TCell>>;
  statusKey: string;
  groupKey: string;
  value: unknown;
}

export interface ProjectKanbanColumnContext<TCell extends ProjectKanbanCellContext> {
  readonly key: string;
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly groups: Map<string, ProjectKanbanGroupContext<TCell>>;
  statusKey: string;
  value: unknown;
}

export interface ProjectsKanbanViewContext<TCell extends ProjectKanbanCellContext> {
  readonly settings: () => ProjectKanbanSettings;
  readonly modelInput: () => Omit<ProjectKanbanModelInput, 'projects' | 'settings' | 'search'>;
  readonly renderCell: (options: {
    readonly host: HTMLElement;
    readonly project: Project;
    readonly field: ProjectFieldCatalogItem;
    readonly column: ProjectColumn | undefined;
    readonly occurrenceId: string;
    readonly groupKey: string;
    readonly existing?: TCell;
  }) => TCell;
  readonly selectCell: (cell: TCell) => void;
  readonly saveViewState: () => void;
  readonly applyChanges: (changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>;
  readonly projectSnapshot: (path: string) => Project | undefined;
}

export interface ProjectKanbanViewportState {
  readonly scrollLeft: number;
  readonly columnScrollTop: Readonly<Record<string, number>>;
}

interface RenderedCard<
  TCell extends ProjectKanbanCellContext,
> extends ProjectKanbanOccurrenceContext<TCell> {
  readonly title: HTMLElement;
  readonly description: HTMLElement;
  readonly fields: HTMLElement;
  readonly progress: HTMLElement;
}

interface RenderedColumn<
  TCell extends ProjectKanbanCellContext,
> extends ProjectKanbanColumnContext<TCell> {
  readonly marker: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly collapse: HTMLButtonElement;
}

interface PatchCardContext<TCell extends ProjectKanbanCellContext> {
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly settings: ProjectKanbanSettings;
  readonly retained: Set<string>;
  readonly visibleCells: TCell[];
}

export class ProjectsKanbanView<TCell extends ProjectKanbanCellContext> {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  private readonly columns_abyssPrivate = new Map<string, RenderedColumn<TCell>>();
  private readonly cards_abyssPrivate = new Map<string, RenderedCard<TCell>>();
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private projects_abyssPrivate: readonly Project[] = [];
  private search_abyssPrivate = '';
  private mounted_abyssPrivate = false;
  private selectedPath_abyssPrivate: string | undefined;
  private visibleCells_abyssPrivate: TCell[] = [];
  private model_abyssPrivate: ProjectKanbanModel | undefined;

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsKanbanViewContext<TCell>,
  ) {
    this.root = host.createDiv({ cls: 'abyss-project-kanban', attr: { tabindex: '-1' } });
    this.scroll = this.root.createDiv({
      cls: 'abyss-project-kanban-scroll',
      attr: { 'aria-label': 'Project Kanban board', tabindex: '0' },
    });
  }

  mount(projects: readonly Project[], search: string): void {
    this.mounted_abyssPrivate = true;
    this.update(projects, search);
  }

  update(projects: readonly Project[], search: string): void {
    this.projects_abyssPrivate = projects;
    this.search_abyssPrivate = search;
    if (this.mounted_abyssPrivate) this.render_abyssPrivate();
  }

  destroy(): void {
    this.mounted_abyssPrivate = false;
    this.columns_abyssPrivate.clear();
    this.cards_abyssPrivate.clear();
    this.visibleCells_abyssPrivate = [];
    this.root.remove();
  }

  selectedProjectPath(): string | undefined {
    return this.selectedPath_abyssPrivate;
  }

  visibleCells(): readonly TCell[] {
    return this.visibleCells_abyssPrivate;
  }

  currentModel(): ProjectKanbanModel | undefined {
    return this.model_abyssPrivate;
  }

  currentColumns(): ReadonlyArray<ProjectKanbanColumnContext<TCell>> {
    return [...this.columns_abyssPrivate.values()];
  }

  currentCards(): ReadonlyArray<ProjectKanbanOccurrenceContext<TCell>> {
    return [...this.cards_abyssPrivate.values()];
  }

  /** Guarded metadata seam used by the native drag adapter. */
  applyChanges(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> {
    return this.context_abyssPrivate.applyChanges(changes);
  }

  projectSnapshot(path: string): Project | undefined {
    return this.context_abyssPrivate.projectSnapshot(path);
  }

  retainedViewportState(): ProjectKanbanViewportState {
    return {
      scrollLeft: this.scroll.scrollLeft,
      columnScrollTop: Object.fromEntries(
        Array.from(this.columns_abyssPrivate, ([key, column]) => [key, column.body.scrollTop]),
      ),
    };
  }

  private render_abyssPrivate(): void {
    const focused = this.focusedDescendant_abyssPrivate();
    const settings = this.context_abyssPrivate.settings();
    const model = buildProjectKanbanModel({
      ...this.context_abyssPrivate.modelInput(),
      projects: this.projects_abyssPrivate,
      settings,
      search: this.search_abyssPrivate,
    });
    this.model_abyssPrivate = model;
    const desiredColumns: HTMLElement[] = [];
    const retainedColumns = new Set<string>();
    const retainedCards = new Set<string>();
    const visibleCells: TCell[] = [];
    for (const modelColumn of model.columns) {
      retainedColumns.add(modelColumn.status.key);
      const column = this.reconcileColumn_abyssPrivate(modelColumn);
      for (const group of column.groups.values()) group.cards.clear();
      desiredColumns.push(column.element);
      this.reconcileColumnGroups_abyssPrivate(column, modelColumn, retainedCards, visibleCells);
    }
    this.removeMissingColumns_abyssPrivate(retainedColumns);
    this.removeMissingCards_abyssPrivate(retainedCards);
    this.reconcileOrder_abyssPrivate(this.scroll, desiredColumns);
    this.visibleCells_abyssPrivate = visibleCells;
    this.reconcileSelectedPath_abyssPrivate();
    this.syncSelectedCards_abyssPrivate();
    this.restoreFocusedDescendant_abyssPrivate(focused);
  }

  private focusedDescendant_abyssPrivate(): HTMLElement | undefined {
    const active = this.root.ownerDocument.activeElement;
    return active instanceof HTMLElement && this.root.contains(active) ? active : undefined;
  }

  private restoreFocusedDescendant_abyssPrivate(focused: HTMLElement | undefined): void {
    if (
      focused === undefined ||
      !focused.isConnected ||
      this.root.ownerDocument.activeElement === focused
    )
      return;
    focused.focus({ preventScroll: true });
  }

  private removeMissingColumns_abyssPrivate(retained: ReadonlySet<string>): void {
    for (const [key, column] of this.columns_abyssPrivate) {
      if (retained.has(key)) continue;
      column.element.remove();
      this.columns_abyssPrivate.delete(key);
    }
  }

  private removeMissingCards_abyssPrivate(retained: ReadonlySet<string>): void {
    for (const [key, card] of this.cards_abyssPrivate) {
      if (retained.has(key)) continue;
      card.element.remove();
      this.cards_abyssPrivate.delete(key);
    }
  }

  private reconcileSelectedPath_abyssPrivate(): void {
    const selected = this.selectedPath_abyssPrivate;
    if (selected === undefined) return;
    const survives = Array.from(this.cards_abyssPrivate.values()).some(
      ({ project }) => project.path === selected,
    );
    if (!survives) this.selectedPath_abyssPrivate = undefined;
  }

  private reconcileColumn_abyssPrivate(model: ProjectKanbanColumn): RenderedColumn<TCell> {
    const key = model.status.key;
    let column = this.columns_abyssPrivate.get(key);
    if (column === undefined) {
      const element = this.scroll.createDiv({ cls: 'abyss-project-kanban-column' });
      const header = element.createDiv({ cls: 'abyss-project-kanban-column-header' });
      const marker = header.createSpan({ cls: 'abyss-status-dot' });
      const label = header.createSpan({ cls: 'abyss-project-kanban-column-label' });
      const count = header.createSpan({ cls: 'abyss-project-kanban-column-count' });
      const collapse = header.createEl('button', {
        cls: 'clickable-icon abyss-project-kanban-column-toggle',
        attr: { type: 'button' },
      });
      const body = element.createDiv({ cls: 'abyss-project-kanban-column-body' });
      column = {
        key,
        element,
        header,
        marker,
        label,
        count,
        collapse,
        body,
        groups: new Map(),
        statusKey: key,
        value: model.status.statusId,
      };
      const created = column;
      collapse.addEventListener('click', () => {
        this.toggleColumn_abyssPrivate(created);
      });
      this.columns_abyssPrivate.set(key, column);
    }
    column.statusKey = key;
    column.value = model.status.statusId;
    column.element.dataset['statusKey'] = key;
    column.label.setText(model.status.label);
    column.count.setText(String(model.uniqueVisibleCount));
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

  private toggleColumn_abyssPrivate(column: RenderedColumn<TCell>): void {
    const collapsed = this.context_abyssPrivate.settings().collapsedColumns;
    const index = collapsed.indexOf(column.key);
    if (index < 0) collapsed.push(column.key);
    else collapsed.splice(index, 1);
    this.context_abyssPrivate.saveViewState();
  }

  private reconcileColumnGroups_abyssPrivate(
    column: RenderedColumn<TCell>,
    model: ProjectKanbanColumn,
    retainedCards: Set<string>,
    visibleCells: TCell[],
  ): void {
    const desiredGroups: HTMLElement[] = [];
    const retainedGroups = new Set<string>();
    const grouped =
      this.context_abyssPrivate.settings().groupBy !== 'none' &&
      this.context_abyssPrivate.settings().groupBy !== 'status';
    for (const modelGroup of model.groups) {
      const key = `${column.key}\u0000${modelGroup.key}`;
      retainedGroups.add(key);
      let group = column.groups.get(key);
      if (group === undefined) {
        const element = column.body.createDiv({ cls: 'abyss-project-kanban-group' });
        const header = element.createEl('button', {
          cls: 'abyss-project-kanban-group-header',
          attr: { type: 'button' },
        });
        const body = element.createDiv({ cls: 'abyss-project-kanban-group-body' });
        group = {
          key,
          element,
          body,
          cards: new Map(),
          statusKey: column.key,
          groupKey: modelGroup.key,
          value: modelGroup.value,
        };
        header.addEventListener('click', () => {
          if (this.collapsedGroups_abyssPrivate.has(key))
            this.collapsedGroups_abyssPrivate.delete(key);
          else this.collapsedGroups_abyssPrivate.add(key);
          this.render_abyssPrivate();
        });
        column.groups.set(key, group);
      }
      group.statusKey = column.key;
      group.groupKey = modelGroup.key;
      group.value = modelGroup.value;
      const header = group.element.querySelector<HTMLButtonElement>(
        '.abyss-project-kanban-group-header',
      );
      if (header !== null) {
        header.setText(`${modelGroup.label} ${modelGroup.projects.length}`);
        header.hidden = !grouped;
        header.setAttribute('aria-expanded', String(!this.collapsedGroups_abyssPrivate.has(key)));
      }
      group.body.hidden = this.collapsedGroups_abyssPrivate.has(key);
      desiredGroups.push(group.element);
      this.reconcileCards_abyssPrivate(group, modelGroup.projects, retainedCards, visibleCells);
    }
    for (const [key, group] of column.groups) {
      if (retainedGroups.has(key)) continue;
      group.element.remove();
      column.groups.delete(key);
    }
    this.reconcileOrder_abyssPrivate(column.body, desiredGroups);
  }

  private reconcileCards_abyssPrivate(
    group: ProjectKanbanGroupContext<TCell>,
    projects: readonly Project[],
    retainedCards: Set<string>,
    visibleCells: TCell[],
  ): void {
    const desiredCards: HTMLElement[] = [];
    for (const project of projects) {
      const cardKey = projectKanbanCardKey(group.groupKey, project.path);
      retainedCards.add(cardKey);
      let card = this.cards_abyssPrivate.get(cardKey);
      if (card === undefined) {
        card = this.createCard_abyssPrivate(cardKey, group, project);
        this.cards_abyssPrivate.set(cardKey, card);
      }
      card.project = project;
      card.statusKey = group.statusKey;
      card.groupKey = group.groupKey;
      card.occurrenceId = projectKanbanOccurrenceId(group.statusKey, group.groupKey, project.path);
      card.element.dataset['projectPath'] = project.path;
      card.element.dataset['occurrenceId'] = card.occurrenceId;
      this.patchCard_abyssPrivate(card, visibleCells);
      group.cards.set(cardKey, card);
      desiredCards.push(card.element);
    }
    this.reconcileOrder_abyssPrivate(group.body, desiredCards);
  }

  private createCard_abyssPrivate(
    key: string,
    group: ProjectKanbanGroupContext<TCell>,
    project: Project,
  ): RenderedCard<TCell> {
    const element = group.body.createDiv({
      cls: 'abyss-project-kanban-card',
      attr: { tabindex: '0' },
    });
    const card: RenderedCard<TCell> = {
      key,
      element,
      title: element.createDiv({ cls: 'abyss-project-kanban-title' }),
      description: element.createDiv({ cls: 'abyss-project-kanban-description' }),
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
        event.target.closest('a, button, input, textarea, select, .abyss-project-cell-editor') !==
          null
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
    card.description.style.setProperty(
      '--abyss-project-description-lines',
      String(settings.descriptionLines),
    );
    if (!card.description.hidden && descriptionField !== undefined) {
      context.retained.add('description');
      const cell = this.reconcileCell_abyssPrivate(
        card,
        card.description,
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
      const column = settings.fields.find(({ id }) => id === item.field.id);
      const cell = this.reconcileCell_abyssPrivate(card, value, item.field, column);
      context.visibleCells.push(cell);
      desiredFields.push(row);
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
