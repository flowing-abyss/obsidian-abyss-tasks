import { DropdownComponent, Setting } from 'obsidian';
import type { ProjectColumnAlignment, ProjectPropertyType } from '../projects/projectFields';
import type {
  ProjectPropertyDefinition,
  ProjectPropertyPreset,
} from '../projects/projectPropertyDefinitions';
import { projectPropertyPresetIssue } from '../projects/projectPropertyPresets';

const PROPERTY_TYPE_LABELS: Readonly<Record<ProjectPropertyType, string>> = {
  text: 'Text',
  list: 'List',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  datetime: 'Date & time',
  tags: 'Tags',
};

const PRESET_TYPES = new Set<ProjectPropertyType>(['text', 'list', 'number', 'tags']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectPropertyTypeChoices(property: string): readonly ProjectPropertyType[] {
  return property.localeCompare('tags', undefined, { sensitivity: 'accent' }) === 0
    ? ['tags']
    : ['text', 'list', 'number', 'checkbox', 'date', 'datetime'];
}

interface RenderProjectPropertyOptions {
  readonly container: HTMLElement;
  readonly label: string;
  readonly property?: string;
  readonly type: ProjectPropertyType | 'status' | 'name' | 'progress' | null;
  readonly definition?: ProjectPropertyDefinition;
  readonly alignment?: ProjectColumnAlignment;
  readonly onTypeChange?: (type: ProjectPropertyType) => void;
  readonly onAlignmentChange: (alignment: ProjectColumnAlignment | undefined) => void;
  readonly onDefinitionChange: () => void;
  readonly refresh: () => void;
}

function fixedTypeLabel(type: RenderProjectPropertyOptions['type']): string {
  if (type === 'name' || type === 'progress')
    return `${type === 'name' ? 'Name' : 'Progress'} (derived)`;
  if (type === 'status') return 'Status (curated)';
  if (type === null) return 'Choose a type';
  return `${PROPERTY_TYPE_LABELS[type]} (curated)`;
}

function renderType(options: RenderProjectPropertyOptions): void {
  const setting = new Setting(options.container).setName('Type');
  if (options.onTypeChange === undefined || options.property === undefined) {
    setting.setDesc(fixedTypeLabel(options.type));
    return;
  }
  setting.settingEl.addClass('abyss-project-property-single-line-setting');
  const dropdown = new DropdownComponent(setting.controlEl);
  const select = dropdown.selectEl;
  select.addClass('dropdown');
  select.setAttribute('aria-label', `Type for ${options.label}`);
  if (options.type === null) dropdown.addOption('', 'Choose type');
  for (const type of projectPropertyTypeChoices(options.property)) {
    dropdown.addOption(type, PROPERTY_TYPE_LABELS[type]);
  }
  dropdown.setValue(options.type ?? '');
  select.addEventListener('change', () => {
    if (select.value !== '') options.onTypeChange?.(select.value as ProjectPropertyType);
  });
}

function renderAlignment(options: RenderProjectPropertyOptions): void {
  const setting = new Setting(options.container).setName('Alignment');
  setting.settingEl.addClass('abyss-project-property-single-line-setting');
  const dropdown = new DropdownComponent(setting.controlEl)
    .addOptions({ left: 'Left', center: 'Center', right: 'Right' })
    .setValue(options.alignment ?? 'left');
  const select = dropdown.selectEl;
  select.addClass('dropdown');
  select.setAttribute('aria-label', `Alignment for ${options.label}`);
  select.addEventListener('change', () => {
    options.onAlignmentChange(
      select.value === 'left' ? undefined : (select.value as ProjectColumnAlignment),
    );
  });
}

function rawPresetList(definition: ProjectPropertyDefinition): unknown[] | undefined {
  const presets: unknown = definition.presets;
  return Array.isArray(presets) ? presets : undefined;
}

function renderPresetError(row: HTMLElement, issue: string | undefined): HTMLElement {
  const error = row.createDiv({
    cls: 'abyss-project-preset-error',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  error.setText(issue ?? '');
  return error;
}

interface PresetRowContext {
  readonly host: HTMLElement;
  readonly definition: ProjectPropertyDefinition;
  readonly rawPresets: unknown[];
  readonly index: number;
  readonly options: RenderProjectPropertyOptions;
}

interface PresetRowControls {
  readonly value: HTMLInputElement;
  readonly displayName: HTMLInputElement;
  readonly color: HTMLInputElement;
  readonly appearance: HTMLSelectElement;
  readonly remove: HTMLButtonElement;
  readonly error: HTMLElement;
}

function createPresetRowControls(row: HTMLElement, context: PresetRowContext): PresetRowControls {
  const { definition, index, options, rawPresets } = context;
  const record = isRecord(rawPresets[index]) ? rawPresets[index] : {};
  const rawValue = record['value'];
  const value = row.createEl('input', {
    cls: 'abyss-project-preset-value',
    attr: {
      type: definition.type === 'number' ? 'number' : 'text',
      'aria-label': `Value for ${options.label} preset ${index + 1}`,
      placeholder: 'Value',
    },
  });
  value.value =
    typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : '';
  const displayName = row.createEl('input', {
    cls: 'abyss-project-preset-display-name',
    attr: {
      type: 'text',
      'aria-label': `Display name for ${options.label} preset ${index + 1}`,
      placeholder: 'Display name',
    },
  });
  displayName.value = typeof record['displayName'] === 'string' ? record['displayName'] : '';
  const color = row.createEl('input', {
    cls: 'abyss-project-preset-color',
    attr: { type: 'color', 'aria-label': `Color for ${options.label} preset ${index + 1}` },
  });
  color.value =
    typeof record['color'] === 'string' && /^#[\da-f]{6}$/iu.test(record['color'])
      ? record['color']
      : '#888888';
  const appearanceDropdown = new DropdownComponent(row)
    .addOptions({ badge: 'Badge', text: 'Text' })
    .setValue(record['display'] === 'text' ? 'text' : 'badge');
  const appearance = appearanceDropdown.selectEl;
  appearance.addClasses(['dropdown', 'abyss-project-preset-appearance']);
  appearance.setAttribute('aria-label', `Appearance for ${options.label} preset ${index + 1}`);
  const remove = row.createEl('button', {
    cls: 'clickable-icon abyss-project-preset-remove',
    text: '×',
    attr: { type: 'button', 'aria-label': `Remove ${options.label} preset ${index + 1}` },
  });
  const error = renderPresetError(
    row,
    projectPropertyPresetIssue(
      definition.type,
      rawPresets[index],
      rawPresets.filter((_candidate, candidateIndex) => candidateIndex !== index),
    ),
  );
  return { value, displayName, color, appearance, remove, error };
}

function renderPresetRow(context: PresetRowContext): void {
  const { host, definition, rawPresets, index, options } = context;
  const currentRecord = (): Record<string, unknown> =>
    isRecord(rawPresets[index]) ? rawPresets[index] : {};
  const row = host.createDiv({
    cls: 'abyss-project-preset-row',
    attr: { 'data-preset-index': String(index) },
  });
  const controls = createPresetRowControls(row, context);
  controls.value.addEventListener('change', () => {
    const nextValue =
      definition.type === 'number' ? controls.value.valueAsNumber : controls.value.value;
    const next = { ...currentRecord(), value: nextValue };
    const issue = projectPropertyPresetIssue(
      definition.type,
      next,
      rawPresets.filter((_candidate, candidateIndex) => candidateIndex !== index),
    );
    controls.error.setText(issue ?? '');
    if (issue !== undefined) return;
    rawPresets[index] = next;
    options.onDefinitionChange();
  });
  controls.displayName.addEventListener('change', () => {
    const next: Record<string, unknown> = {
      ...currentRecord(),
      value: currentRecord()['value'] ?? controls.value.value,
    };
    if (controls.displayName.value.trim().length === 0) delete next['displayName'];
    else next['displayName'] = controls.displayName.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  });
  controls.color.addEventListener('change', () => {
    const next: Record<string, unknown> = {
      ...currentRecord(),
      value: currentRecord()['value'] ?? controls.value.value,
    };
    next['color'] = controls.color.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  });
  controls.appearance.addEventListener('change', () => {
    const next: Record<string, unknown> = {
      ...currentRecord(),
      value: currentRecord()['value'] ?? controls.value.value,
    };
    next['display'] = controls.appearance.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  });
  controls.remove.addEventListener('click', () => {
    rawPresets.splice(index, 1);
    options.onDefinitionChange();
    options.refresh();
  });
}

function renderPresets(options: RenderProjectPropertyOptions): void {
  const definition = options.definition;
  if (definition === undefined || !PRESET_TYPES.has(definition.type)) return;
  const setting = new Setting(options.container)
    .setName('Predefined values')
    .setDesc('Offer configured values before values already used by this property.');
  const toggle = setting.controlEl.createEl('input', {
    attr: { type: 'checkbox', 'aria-label': `Use predefined values for ${options.label}` },
  });
  toggle.checked = definition.presetsEnabled === true;
  toggle.addEventListener('change', () => {
    definition.presetsEnabled = toggle.checked;
    options.onDefinitionChange();
    options.refresh();
  });
  const presets = rawPresetList(definition);
  if (presets === undefined && definition.presets !== undefined) {
    options.container.createDiv({
      cls: 'abyss-project-preset-error',
      text: 'Saved predefined values are malformed. Add a value to replace them.',
      attr: { role: 'status' },
    });
  }
  const values = presets ?? [];
  const list = options.container.createDiv({ cls: 'abyss-project-preset-list' });
  values.forEach((_preset, index) => {
    renderPresetRow({ host: list, definition, rawPresets: values, index, options });
  });
  const add = options.container.createEl('button', {
    cls: 'abyss-project-preset-add',
    text: '+ add predefined value',
    attr: { type: 'button' },
  });
  add.disabled = definition.presetsEnabled !== true;
  add.addEventListener('click', () => {
    const next = presets ?? [];
    if (presets === undefined) definition.presets = next as ProjectPropertyPreset[];
    next.push({ value: definition.type === 'number' ? 0 : '' });
    options.onDefinitionChange();
    options.refresh();
  });
}

export function renderProjectPropertyOptions(options: RenderProjectPropertyOptions): void {
  renderType(options);
  renderAlignment(options);
  renderPresets(options);
}
