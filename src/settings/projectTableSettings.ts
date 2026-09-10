import { Notice, setIcon, Setting, type App } from 'obsidian';
import type { ProjectPropertyCatalog } from '../projects/ObsidianProjectProperties';
import type {
  ProjectColumn,
  ProjectPropertyInfo,
  ProjectTableSettings,
} from '../projects/projectFields';
import { isReservedProjectProperty } from '../projects/projectFields';
import { ProjectPropertySuggest } from '../ui/ProjectPropertySuggest';
import { saveSettingsDraft } from './settingsSaveFailure';
import type { ProjectsSettings } from './types';

export interface RenderProjectTableSettingsOptions {
  readonly app: App;
  readonly container: HTMLElement;
  readonly projects: ProjectsSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly saveStatic: () => Promise<void>;
  readonly saveViewState: () => Promise<void>;
  readonly refresh: (focus?: 'add-property') => void;
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
  return sourceProperty(column) ?? CURATED_LABELS[column.id] ?? column.id;
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
  const adjustedTarget = index < target ? target - 1 : target;
  settings.columns.splice(adjustedTarget, 0, column);
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
  if (info.type === null) return 'unsupported';
  projects.table.columns.push({ id: `property:${info.name}`, visible: true });
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
  readonly index: number;
  readonly options: RenderProjectTableSettingsOptions;
  readonly persist: ProjectTablePersist;
}

type ProjectTablePersist = (refresh?: boolean | 'add-property') => void;

function createRemoveColumnAction(row: HTMLElement, label: string, onClick: () => void): void {
  const button = row.createEl('button', {
    cls: 'clickable-icon abyss-project-column-action',
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, 'x');
  button.addEventListener('click', onClick);
}

function columnDragId(event: DragEvent): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(event.dataTransfer?.getData('text/plain') ?? '');
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== 'object') return undefined;
  const record = payload as { type?: unknown; columnId?: unknown };
  return record.type === 'project-column' && typeof record.columnId === 'string'
    ? record.columnId
    : undefined;
}

function wireColumnDrag(
  row: HTMLElement,
  column: ProjectColumn,
  options: RenderProjectTableSettingsOptions,
  persist: ProjectTablePersist,
): void {
  const order = row.createSpan({ cls: 'abyss-project-column-order' });
  const grip = order.createSpan({ cls: 'abyss-settings-card-grip' });
  const curated = column.id in CURATED_LABELS;
  if (column.id === 'name') {
    grip.addClass('abyss-project-column-required');
    grip.setAttribute('aria-label', 'Required column');
    grip.setAttribute('title', 'Required column');
    setIcon(grip, 'lock');
  } else {
    setIcon(grip, 'grip-vertical');
    if (curated) {
      const required = order.createSpan({
        cls: 'abyss-project-column-required',
        attr: { 'aria-label': 'Required column', title: 'Required column' },
      });
      setIcon(required, 'lock');
    }
  }
  row.addEventListener('dragstart', (event) => {
    if (column.id === 'name') {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData(
      'text/plain',
      JSON.stringify({ type: 'project-column', columnId: column.id }),
    );
    row.addClass('abyss-dragging');
  });
  row.addEventListener('dragend', () => {
    row.removeClass('abyss-dragging');
  });
  row.addEventListener('dragover', (event) => {
    if (column.id === 'name') return;
    event.preventDefault();
    row.addClass('abyss-drag-over');
  });
  row.addEventListener('dragleave', () => {
    row.removeClass('abyss-drag-over');
  });
  row.addEventListener('drop', (event) => {
    row.removeClass('abyss-drag-over');
    const draggedId = columnDragId(event);
    if (
      draggedId !== undefined &&
      moveProjectColumn(options.projects.table, draggedId, column.id)
    ) {
      persist();
      options.refresh();
    }
  });
}

function renderColumnRow(context: ColumnRowContext): void {
  const { host, column, options, persist } = context;
  const source = projectColumnSourceLabel(options.projects, column);
  const display = projectColumnDisplayLabel(column);
  const row = host.createDiv({
    cls: 'abyss-project-column-setting',
    attr: { 'data-column-id': column.id, draggable: String(column.id !== 'name') },
  });
  wireColumnDrag(row, column, options, persist);
  const sourceElement = row.createDiv({ cls: 'abyss-project-column-source' });
  sourceElement.createSpan({ text: source });
  if (column.id === 'progress') {
    sourceElement.createSpan({
      cls: 'abyss-project-column-source-badge abyss-project-column-auto',
      text: 'Auto',
    });
  }

  const label = row.createEl('input', {
    cls: 'abyss-project-column-label',
    attr: { type: 'text', 'aria-label': `Display name for ${display}`, placeholder: display },
  });
  label.value = column.label ?? '';
  label.addEventListener('change', () => {
    if (setProjectColumnLabel(options.projects.table, column.id, label.value)) persist();
  });

  const visible = row.createEl('input', {
    cls: 'abyss-project-column-visible',
    attr: { type: 'checkbox', 'aria-label': `Show ${source}` },
  });
  visible.checked = column.visible;
  visible.disabled = column.id === 'name';
  visible.addEventListener('change', () => {
    if (setProjectColumnVisibility(options.projects.table, column.id, visible.checked)) persist();
  });

  const width = row.createEl('input', {
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

  if (column.id.startsWith('property:')) {
    createRemoveColumnAction(row, `Remove ${source} column`, () => {
      if (removeProjectColumn(options.projects.table, column.id)) {
        persist();
        options.refresh();
      }
    });
  } else {
    row.createSpan({
      cls: 'abyss-project-column-action-placeholder',
      attr: { 'aria-hidden': 'true' },
    });
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
      const properties =
        options.catalog
          .list()
          ?.filter(
            ({ name: property, type }) =>
              type === 'date' &&
              (!sameProperty(property, 'description') || sameProperty(property, current)),
          )
          .map(({ name: property }) => property) ?? [];
      const matching = properties.find((property) => sameProperty(property, current));
      const selected = matching ?? current;
      if (matching === undefined) {
        dropdown.addOption(current, `${current} (current)`);
      }
      for (const property of properties) dropdown.addOption(property, property);
      dropdown.setValue(selected).onChange((property) => {
        const siblingKeys = (['statusProperty', 'startProperty', 'endProperty'] as const).filter(
          (candidate) => candidate !== key,
        );
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
  readonly persist: ProjectTablePersist;
}

function renderAddPropertyControl(context: AddPropertyContext): () => void {
  const { section, feedback, available, options, persist } = context;
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
    const result = addProjectPropertyColumn(options.projects, available, property);
    if (result === 'added') {
      input.value = '';
      persist();
      options.refresh('add-property');
    } else if (result === 'duplicate') {
      feedback.setText('That property is already a table column.');
    } else if (result === 'reserved') {
      feedback.setText('That property is reserved for a curated project field or status.');
    } else if (result === 'unsupported') {
      feedback.setText('That Obsidian property type is not supported for editing.');
    } else {
      feedback.setText('Choose an existing Obsidian property.');
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
      input.value = property;
      choose(property);
    },
  });
  if (available.length === 0) {
    feedback.setText(
      'Obsidian property types are unavailable, or this vault has no properties to add.',
    );
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
  const persist = (save: () => Promise<void>, refresh: boolean | 'add-property' = false): void => {
    feedback.empty();
    saveSettingsDraft({
      action: 'save project table settings',
      save: async () => {
        await save();
        if (refresh !== false) {
          options.refresh(refresh === 'add-property' ? refresh : undefined);
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

  renderCuratedDateSource(section, 'startProperty', options, persistStatic);
  renderCuratedDateSource(section, 'endProperty', options, persistStatic);
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
  for (const label of ['', 'Source', 'Display name', 'Show', 'Width', '']) {
    headings.createSpan({ text: label, attr: label.length === 0 ? { 'aria-hidden': 'true' } : {} });
  }
  options.projects.table.columns.forEach((column, index) => {
    renderColumnRow({ host: rows, column, index, options, persist: persistViewState });
  });

  return renderAddPropertyControl({
    section,
    feedback,
    available: options.catalog.list() ?? [],
    options,
    persist: persistViewState,
  });
}
