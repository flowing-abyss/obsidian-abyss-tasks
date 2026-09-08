import { Notice, type App } from 'obsidian';
import type { ProjectPropertyCatalog } from '../projects/ObsidianProjectProperties';
import type {
  ProjectColumn,
  ProjectPropertyInfo,
  ProjectTableSettings,
} from '../projects/projectFields';
import { isReservedProjectProperty } from '../projects/projectFields';
import { ProjectPropertySuggest } from '../ui/ProjectPropertySuggest';
import type { ProjectsSettings } from './types';

export interface RenderProjectTableSettingsOptions {
  readonly app: App;
  readonly container: HTMLElement;
  readonly projects: ProjectsSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly save: () => Promise<void>;
  readonly refresh: () => void;
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

export function projectColumnSourceLabel(column: ProjectColumn): string {
  return sourceProperty(column) ?? CURATED_LABELS[column.id] ?? column.id;
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
  if (normalized.length === 0 || normalized === projectColumnSourceLabel(column))
    delete column.label;
  else column.label = normalized;
  return true;
}

export function setProjectColumnVisibility(
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

export function moveProjectColumn(
  settings: ProjectTableSettings,
  columnId: string,
  delta: -1 | 1,
): boolean {
  enforceProjectTableColumnInvariants(settings);
  const index = settings.columns.findIndex(({ id }) => id === columnId);
  const target = index + delta;
  if (index <= 0 || target <= 0 || target >= settings.columns.length) return false;
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
  if (info.type === null) return 'unsupported';
  projects.table.columns.push({ id: `property:${info.name}`, visible: true });
  enforceProjectTableColumnInvariants(projects.table);
  return 'added';
}

export function removeProjectColumn(settings: ProjectTableSettings, columnId: string): boolean {
  if (!columnId.startsWith('property:')) return false;
  const index = settings.columns.findIndex(({ id }) => id === columnId);
  if (index < 0) return false;
  settings.columns.splice(index, 1);
  if (settings.groupBy === columnId) settings.groupBy = 'status';
  if (settings.sortBy.field === columnId) settings.sortBy = { field: 'end', dir: 'asc' };
  return true;
}

interface ColumnRowContext {
  readonly host: HTMLElement;
  readonly column: ProjectColumn;
  readonly index: number;
  readonly options: RenderProjectTableSettingsOptions;
  readonly persist: (refresh?: boolean) => void;
}

function renderColumnRow(context: ColumnRowContext): void {
  const { host, column, index, options, persist } = context;
  const source = projectColumnSourceLabel(column);
  const row = host.createDiv({
    cls: 'abyss-project-column-setting',
    attr: { 'data-column-id': column.id },
  });
  row.createDiv({ cls: 'abyss-project-column-source', text: source });

  const label = row.createEl('input', {
    cls: 'abyss-project-column-label',
    attr: { type: 'text', 'aria-label': `Display name for ${source}`, placeholder: source },
  });
  label.value = column.label ?? '';
  label.addEventListener('change', () => {
    if (setProjectColumnLabel(options.projects.table, column.id, label.value)) persist();
  });

  const visible = row.createEl('input', {
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

  const up = row.createEl('button', {
    text: 'Up',
    attr: { type: 'button', 'aria-label': `Move ${source} up` },
  });
  up.disabled = index <= 1;
  up.addEventListener('click', () => {
    if (moveProjectColumn(options.projects.table, column.id, -1)) persist(true);
  });
  const down = row.createEl('button', {
    text: 'Down',
    attr: { type: 'button', 'aria-label': `Move ${source} down` },
  });
  down.disabled = column.id === 'name' || index >= options.projects.table.columns.length - 1;
  down.addEventListener('click', () => {
    if (moveProjectColumn(options.projects.table, column.id, 1)) persist(true);
  });

  if (column.id.startsWith('property:')) {
    const remove = row.createEl('button', {
      cls: 'mod-warning',
      text: 'Remove',
      attr: { type: 'button', 'aria-label': `Remove ${source} column` },
    });
    remove.addEventListener('click', () => {
      if (removeProjectColumn(options.projects.table, column.id)) persist(true);
    });
  }
}

interface AddPropertyContext {
  readonly section: HTMLElement;
  readonly feedback: HTMLElement;
  readonly available: readonly ProjectPropertyInfo[];
  readonly options: RenderProjectTableSettingsOptions;
  readonly persist: (refresh?: boolean) => void;
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
      persist(true);
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
  const persist = (refresh = false): void => {
    feedback.empty();
    void options.save().then(
      () => {
        if (refresh) options.refresh();
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        feedback.setText(`Could not save project table settings: ${message}`);
        console.error('[abyss-tasks] Could not save project table settings', error);
        new Notice(`Could not save project table settings: ${message}`);
      },
    );
  };

  const rows = section.createDiv({ cls: 'abyss-project-column-settings' });
  options.projects.table.columns.forEach((column, index) => {
    renderColumnRow({ host: rows, column, index, options, persist });
  });

  return renderAddPropertyControl({
    section,
    feedback,
    available: options.catalog.list(),
    options,
    persist,
  });
}
