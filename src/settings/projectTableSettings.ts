import { Notice, setIcon, Setting, type App } from 'obsidian';
import type { ProjectPropertyCatalog } from '../projects/ObsidianProjectProperties';
import type {
  ProjectColumn,
  ProjectColumnAlignment,
  ProjectPropertyInfo,
  ProjectTableSettings,
} from '../projects/projectFields';
import { isReservedProjectProperty } from '../projects/projectFields';
import type { ProjectPropertyDefinition } from '../projects/projectPropertyDefinitions';
import { isProjectPropertyDefinition } from '../projects/projectPropertyDefinitions';
import { ProjectPropertySuggest } from '../ui/ProjectPropertySuggest';
import { renderProjectPropertyOptions } from './projectPropertyOptions';
import { renderSettingsCard } from './settingsCard';
import { saveSettingsDraft } from './settingsSaveFailure';
import type { ProjectsSettings } from './types';

export interface RenderProjectTableSettingsOptions {
  readonly app: App;
  readonly container: HTMLElement;
  readonly projects: ProjectsSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly saveStatic: () => Promise<void>;
  readonly saveViewState: () => Promise<void>;
  readonly renderStatusSettings?: (container: HTMLElement) => void;
  readonly expandedCards?: Set<string>;
  readonly refresh: (focusCardId?: string) => void;
}

const CURATED_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  status: 'Status',
  progress: 'Progress',
  start: 'Start',
  end: 'End',
};

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function sourceProperty(column: ProjectColumn): string | undefined {
  return column.id.startsWith('property:') ? column.id.slice('property:'.length) : undefined;
}

function projectColumnDisplayLabel(column: ProjectColumn): string {
  return column.label ?? sourceProperty(column) ?? CURATED_LABELS[column.id] ?? column.id;
}

const expandedPropertyCards = new WeakMap<ProjectsSettings, Set<string>>();

function propertyCardsFor(projects: ProjectsSettings): Set<string> {
  const existing = expandedPropertyCards.get(projects);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  expandedPropertyCards.set(projects, created);
  return created;
}

function definitionEntry(
  projects: ProjectsSettings,
  fieldId: string,
): { key: string; value: ProjectPropertyDefinition } | undefined {
  const key = Object.keys(projects.propertyDefinitions).find((candidate) =>
    sameProperty(candidate, fieldId),
  );
  if (key === undefined) return undefined;
  const value: unknown = projects.propertyDefinitions[key];
  return isProjectPropertyDefinition(value) ? { key, value } : undefined;
}

function setProjectColumnAlignment(
  settings: ProjectTableSettings,
  columnId: string,
  alignment: ProjectColumnAlignment | undefined,
): boolean {
  const column = settings.columns.find(({ id }) => id === columnId);
  if (column === undefined) return false;
  if (alignment === undefined || alignment === 'left') delete column.alignment;
  else column.alignment = alignment;
  return true;
}

function projectColumnSourceLabel(projects: ProjectsSettings, column: ProjectColumn): string {
  if (column.id === 'name') return 'Filename';
  if (column.id === 'progress') return 'Tasks';
  if (column.id === 'status') return projects.statusProperty;
  if (column.id === 'start') return projects.startProperty;
  if (column.id === 'end') return projects.endProperty;
  return sourceProperty(column) ?? column.id;
}

export function enforceProjectTableColumnInvariants(settings: ProjectTableSettings): void {
  const nameIndex = settings.columns.findIndex(({ id }) => id === 'name');
  if (nameIndex < 0) settings.columns.unshift({ id: 'name', visible: true });
  else {
    const name = settings.columns.splice(nameIndex, 1)[0];
    if (name !== undefined) {
      name.visible = true;
      settings.columns.unshift(name);
    }
  }
}

export function setProjectColumnLabel(
  settings: ProjectTableSettings,
  columnId: string,
  label: string,
): boolean {
  const column = settings.columns.find(({ id }) => id === columnId);
  if (column === undefined) return false;
  const normalized = label.trim();
  if (normalized.length === 0 || normalized === projectColumnDisplayLabel(column))
    delete column.label;
  else column.label = normalized;
  return true;
}

function setProjectColumnVisibility(
  settings: ProjectTableSettings,
  columnId: string,
  visible: boolean,
): boolean {
  const column = settings.columns.find(({ id }) => id === columnId);
  if (column === undefined) return false;
  column.visible = column.id === 'name' ? true : visible;
  enforceProjectTableColumnInvariants(settings);
  return true;
}

export function setProjectColumnWidth(
  settings: ProjectTableSettings,
  columnId: string,
  width: number | undefined,
): boolean {
  const column = settings.columns.find(({ id }) => id === columnId);
  if (column === undefined || (width !== undefined && (!Number.isFinite(width) || width <= 0))) {
    return false;
  }
  if (width === undefined) delete column.width;
  else column.width = width;
  return true;
}

function moveProjectColumn(
  settings: ProjectTableSettings,
  columnId: string,
  targetId: string,
): boolean {
  enforceProjectTableColumnInvariants(settings);
  const index = settings.columns.findIndex(({ id }) => id === columnId);
  const target = settings.columns.findIndex(({ id }) => id === targetId);
  if (index <= 0 || target <= 0 || index === target) return false;
  const [column] = settings.columns.splice(index, 1);
  if (column === undefined) return false;
  settings.columns.splice(target, 0, column);
  return true;
}

function selectedProperty(settings: ProjectTableSettings, property: string): boolean {
  return settings.columns.some((column) => {
    const source = sourceProperty(column);
    return source !== undefined && sameProperty(source, property);
  });
}

export function addProjectPropertyColumn(
  projects: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[],
  property: string,
): 'added' | 'duplicate' | 'reserved' | 'unsupported' | 'missing' {
  const info = properties.find(({ name }) => sameProperty(name, property.trim()));
  if (info === undefined) return 'missing';
  if (isReservedProjectProperty(projects, info.name)) return 'reserved';
  if (selectedProperty(projects.table, info.name)) return 'duplicate';
  const fieldId = `property:${info.name}`;
  if (definitionEntry(projects, fieldId) === undefined) {
    const type = sameProperty(info.name, 'tags') ? 'tags' : (info.type ?? 'text');
    projects.propertyDefinitions[fieldId] = { type };
  }
  projects.table.columns.push({ id: fieldId, visible: true });
  enforceProjectTableColumnInvariants(projects.table);
  return 'added';
}

function removeProjectColumn(settings: ProjectTableSettings, columnId: string): boolean {
  if (!columnId.startsWith('property:')) return false;
  const index = settings.columns.findIndex(({ id }) => id === columnId);
  if (index < 0) return false;
  settings.columns.splice(index, 1);
  if (settings.groupBy === columnId) settings.groupBy = 'status';
  if (settings.sortBy.field === columnId) settings.sortBy = { field: 'start', dir: 'asc' };
  return true;
}

interface ColumnRowContext {
  readonly host: HTMLElement;
  readonly column: ProjectColumn;
  readonly options: RenderProjectTableSettingsOptions;
  readonly persist: ProjectTablePersist;
  readonly persistStatic: ProjectTablePersist;
}

interface ColumnRenderContext extends ColumnRowContext {
  readonly source: string;
  readonly display: string;
  readonly cardId: string;
  readonly expanded: Set<string>;
}

type ProjectTablePersist = (refresh?: boolean) => void;

function createRemoveColumnAction(row: HTMLElement, label: string, onClick: () => void): void {
  const button = row.createEl('button', {
    cls: 'clickable-icon abyss-project-column-action',
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, 'x');
  button.addEventListener('click', onClick);
}

function renderColumnSummary(summary: HTMLElement, context: ColumnRenderContext): void {
  const { column, options, persist, source, display, cardId, expanded } = context;
  const sourceElement = summary.createDiv({ cls: 'abyss-project-column-source' });
  sourceElement.createSpan({ text: source });
  if (column.id === 'progress') {
    sourceElement.createSpan({
      cls: 'abyss-project-column-source-badge abyss-project-column-auto',
      text: 'Auto',
    });
  }
  const label = summary.createEl('input', {
    cls: 'abyss-project-column-label',
    attr: { type: 'text', 'aria-label': `Display name for ${display}`, placeholder: display },
  });
  label.value = column.label ?? '';
  label.addEventListener('change', () => {
    if (setProjectColumnLabel(options.projects.table, column.id, label.value)) persist();
  });
  const visible = summary.createEl('input', {
    cls: 'abyss-project-column-visible',
    attr: { type: 'checkbox', 'aria-label': `Show ${source}` },
  });
  visible.checked = column.visible;
  visible.disabled = column.id === 'name';
  visible.addEventListener('change', () => {
    if (setProjectColumnVisibility(options.projects.table, column.id, visible.checked)) persist();
  });
  const width = summary.createEl('input', {
    cls: 'abyss-project-column-width',
    attr: {
      type: 'number',
      min: '60',
      step: '10',
      'aria-label': `Width for ${source}`,
      placeholder: 'Auto',
    },
  });
  width.value = column.width === undefined ? '' : String(column.width);
  width.addEventListener('change', () => {
    const next = width.value === '' ? undefined : width.valueAsNumber;
    if (setProjectColumnWidth(options.projects.table, column.id, next)) persist();
  });
  if (!column.id.startsWith('property:')) {
    summary.createSpan({
      cls: 'abyss-project-column-action-placeholder',
      attr: { 'aria-hidden': 'true' },
    });
    return;
  }
  createRemoveColumnAction(summary, `Remove ${source} column`, () => {
    if (!removeProjectColumn(options.projects.table, column.id)) return;
    expanded.delete(cardId);
    persist();
    options.refresh();
  });
}

function reservedOwner(projects: ProjectsSettings, property: string): string {
  if (sameProperty(property, projects.statusProperty)) return 'Status';
  if (sameProperty(property, projects.startProperty)) return 'Start';
  if (sameProperty(property, projects.endProperty)) return 'End';
  return 'Description';
}

function columnType(
  column: ProjectColumn,
  entry: ReturnType<typeof definitionEntry>,
): ProjectPropertyDefinition['type'] | 'status' | 'name' | 'progress' | null {
  if (column.id === 'name') return 'name';
  if (column.id === 'status') return 'status';
  if (column.id === 'progress') return 'progress';
  if (column.id === 'start' || column.id === 'end') return 'date';
  return entry?.value.type ?? null;
}

function setDefinitionType(
  context: ColumnRenderContext,
  entry: ReturnType<typeof definitionEntry>,
  type: ProjectPropertyDefinition['type'],
): void {
  const key = entry?.key ?? context.column.id;
  const current: unknown = context.options.projects.propertyDefinitions[key];
  context.options.projects.propertyDefinitions[key] = {
    ...(current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}),
    type,
  };
  context.persistStatic(true);
}

function renderCuratedColumnSettings(body: HTMLElement, context: ColumnRenderContext): void {
  const { column, options, persistStatic } = context;
  if (column.id === 'start') renderCuratedDateSource(body, 'startProperty', options, persistStatic);
  if (column.id === 'end') renderCuratedDateSource(body, 'endProperty', options, persistStatic);
  if (column.id === 'status') options.renderStatusSettings?.(body);
}

function renderColumnBody(body: HTMLElement, context: ColumnRenderContext): void {
  const { column, options, persist, persistStatic, display } = context;
  body.addClass('abyss-project-property-details');
  const entry = definitionEntry(options.projects, column.id);
  const native = sourceProperty(column);
  if (native !== undefined && isReservedProjectProperty(options.projects, native)) {
    body.createDiv({
      cls: 'abyss-project-property-inactive',
      text: `Used by ${reservedOwner(options.projects, native)}. This custom column is inactive; its type and predefined values remain saved.`,
    });
  }
  renderProjectPropertyOptions({
    container: body,
    label: display,
    ...(native === undefined ? {} : { property: native }),
    type: columnType(column, entry),
    ...(entry === undefined ? {} : { definition: entry.value }),
    ...(column.alignment === undefined ? {} : { alignment: column.alignment }),
    ...(native === undefined
      ? {}
      : {
          onTypeChange: (type) => {
            setDefinitionType(context, entry, type);
          },
        }),
    onAlignmentChange: (alignment) => {
      if (setProjectColumnAlignment(options.projects.table, column.id, alignment)) persist();
    },
    onDefinitionChange: () => {
      persistStatic();
    },
    refresh: options.refresh,
  });
  renderCuratedColumnSettings(body, context);
}

function renderColumnRow(base: ColumnRowContext): void {
  const context: ColumnRenderContext = {
    ...base,
    source: projectColumnSourceLabel(base.options.projects, base.column),
    display: projectColumnDisplayLabel(base.column),
    cardId: `project-property:${base.column.id}`,
    expanded: base.options.expandedCards ?? propertyCardsFor(base.options.projects),
  };
  const { host, column, options, persist, display, cardId, expanded } = context;
  const row = renderSettingsCard({
    container: host,
    item: column,
    expandedIds: expanded,
    id: () => cardId,
    listKey: 'project-properties',
    draggable: column.id !== 'name',
    title: () => display,
    cardClass: 'abyss-project-column-setting abyss-project-property-card',
    toggleClass: 'abyss-project-property-toggle',
    renderSummary: (summary) => {
      renderColumnSummary(summary, context);
    },
    renderBody: (body) => {
      renderColumnBody(body, context);
    },
    onReorder: (draggedCardId) => {
      const draggedId = draggedCardId.startsWith('project-property:')
        ? draggedCardId.slice('project-property:'.length)
        : '';
      if (!moveProjectColumn(options.projects.table, draggedId, column.id)) return false;
      persist();
      return true;
    },
  });
  row.setAttribute('data-column-id', column.id);
  row.setAttribute('draggable', String(column.id !== 'name'));
  if (column.id in CURATED_LABELS) {
    const grip = row.querySelector<HTMLElement>('.abyss-settings-card-grip');
    grip?.addClass('abyss-project-column-required');
    grip?.setAttribute('aria-label', 'Required column');
    grip?.setAttribute('title', 'Required column');
  }
}

function renderCuratedDateSource(
  section: HTMLElement,
  key: 'startProperty' | 'endProperty',
  options: RenderProjectTableSettingsOptions,
  persistStatic: (refresh?: boolean) => void,
): void {
  const name = key === 'startProperty' ? 'Start property' : 'End property';
  const current = options.projects[key];
  new Setting(section)
    .setName(name)
    .setDesc(
      `The date property used by the curated ${key === 'startProperty' ? 'Start' : 'End'} column.`,
    )
    .addDropdown((dropdown) => {
      const siblingKeys = (['statusProperty', 'startProperty', 'endProperty'] as const).filter(
        (candidate) => candidate !== key,
      );
      const properties =
        options.catalog
          .list()
          ?.filter(
            ({ name: property }) =>
              !sameProperty(property, 'tags') &&
              !sameProperty(property, 'description') &&
              !siblingKeys.some((candidate) => sameProperty(options.projects[candidate], property)),
          )
          .map(({ name: property }) => property) ?? [];
      const matching = properties.find((property) => sameProperty(property, current));
      const selected = matching ?? current;
      if (matching === undefined) {
        dropdown.addOption(current, `${current} (current)`);
      }
      for (const property of properties) {
        const suspended = definitionEntry(options.projects, `property:${property}`) !== undefined;
        dropdown.addOption(property, suspended ? `${property} (suspends custom column)` : property);
      }
      dropdown.setValue(selected).onChange((property) => {
        if (
          sameProperty(property, 'description') ||
          siblingKeys.some((candidate) => sameProperty(options.projects[candidate], property))
        ) {
          dropdown.selectEl.value = selected;
          new Notice(`${name} must use a different property from the other curated fields.`);
          return;
        }
        options.projects[key] = property;
        persistStatic(true);
      });
    });
}

interface AddPropertyContext {
  readonly section: HTMLElement;
  readonly feedback: HTMLElement;
  readonly available: readonly ProjectPropertyInfo[];
  readonly options: RenderProjectTableSettingsOptions;
}

function renderAddPropertyControl(context: AddPropertyContext): () => void {
  const { section, feedback, available, options } = context;
  const addRow = section.createDiv({ cls: 'abyss-project-column-add-row' });
  const input = addRow.createEl('input', {
    cls: 'abyss-project-column-add-input',
    attr: {
      type: 'text',
      placeholder: 'Add property',
      'aria-label': 'Add project property column',
      autocomplete: 'off',
    },
  });
  const add = addRow.createEl('button', {
    cls: 'abyss-project-column-add mod-cta',
    text: 'Add property',
    attr: { type: 'button' },
  });
  const choose = (property: string): void => {
    feedback.empty();
    const selected = available.find(({ name }) => sameProperty(name, property.trim()));
    const result = addProjectPropertyColumn(options.projects, available, property);
    if (result === 'added') {
      suggest.close();
      input.value = '';
      saveSettingsDraft({
        action: 'add project property',
        save: async () => {
          await options.saveStatic();
          await options.saveViewState();
          options.refresh(`project-property:property:${selected?.name ?? property.trim()}`);
        },
      });
    } else if (result === 'duplicate') {
      feedback.setText('That property is already a table column.');
    } else if (result === 'reserved') {
      feedback.setText('That property is reserved for a curated project field or status.');
    } else {
      feedback.setText('Choose an existing configured or vault property.');
    }
  };
  add.addEventListener('click', () => {
    choose(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    choose(input.value);
  });
  const suggest = new ProjectPropertySuggest({
    app: options.app,
    input,
    values: available
      .filter(({ name }) => !isReservedProjectProperty(options.projects, name))
      .map(({ name }) => name),
    onPick: (property) => {
      if (typeof property !== 'string') return;
      input.value = property;
      choose(property);
    },
  });
  if (available.length === 0) {
    feedback.setText('This vault has no supported properties to add.');
    input.disabled = true;
    add.disabled = true;
  }
  return () => {
    suggest.close();
  };
}

/** Renders the shared project-column preference editor and returns its suggestion cleanup. */
export function renderProjectTableSettings(options: RenderProjectTableSettingsOptions): () => void {
  enforceProjectTableColumnInvariants(options.projects.table);
  const section = options.container.createDiv({ cls: 'abyss-project-table-settings' });
  section.createEl('h4', { text: 'Table columns' });
  const feedback = section.createDiv({
    cls: 'abyss-project-table-settings-error',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  const persist = (save: () => Promise<void>, refresh: boolean | string = false): void => {
    feedback.empty();
    saveSettingsDraft({
      action: 'save project table settings',
      save: async () => {
        await save();
        if (refresh !== false) {
          options.refresh(typeof refresh === 'string' ? refresh : undefined);
        }
      },
    });
  };

  const persistStatic: ProjectTablePersist = (refresh = false): void => {
    persist(options.saveStatic, refresh);
  };
  const persistViewState: ProjectTablePersist = (refresh = false): void => {
    persist(options.saveViewState, refresh);
  };

  const descriptionSetting = new Setting(section)
    .setName('Show description')
    .setDesc('Display the description property beneath each project name.');
  const descriptionToggle = descriptionSetting.controlEl.createEl('input', {
    cls: 'abyss-project-show-description',
    attr: { type: 'checkbox', 'aria-label': 'Show project descriptions' },
  });
  descriptionToggle.checked = options.projects.table.showDescription;
  descriptionToggle.addEventListener('change', () => {
    options.projects.table.showDescription = descriptionToggle.checked;
    persistViewState();
  });

  const rows = section.createDiv({ cls: 'abyss-project-column-settings' });
  const headings = rows.createDiv({ cls: 'abyss-project-column-settings-header' });
  for (const label of ['', 'Source', 'Display name', 'Show', 'Width', '', '']) {
    headings.createSpan({ text: label, attr: label.length === 0 ? { 'aria-hidden': 'true' } : {} });
  }
  options.projects.table.columns.forEach((column) => {
    renderColumnRow({
      host: rows,
      column,
      options,
      persist: persistViewState,
      persistStatic,
    });
  });

  const catalogProperties = options.catalog.list() ?? [];
  const configuredProperties = Object.entries(options.projects.propertyDefinitions).flatMap(
    ([fieldId, definition]): ProjectPropertyInfo[] => {
      if (!fieldId.startsWith('property:') || !isProjectPropertyDefinition(definition)) return [];
      return [{ name: fieldId.slice('property:'.length), type: definition.type }];
    },
  );
  const available = [...catalogProperties];
  for (const configured of configuredProperties) {
    if (!available.some(({ name }) => sameProperty(name, configured.name)))
      available.push(configured);
  }

  return renderAddPropertyControl({
    section,
    feedback,
    available,
    options,
  });
}
