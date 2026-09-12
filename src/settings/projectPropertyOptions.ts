import { DropdownComponent, Setting } from 'obsidian';
import type { ProjectColumnAlignment, ProjectPropertyType } from '../projects/projectFields';
import type {
  ProjectPropertyDefinition,
  ProjectPropertyPreset,
} from '../projects/projectPropertyDefinitions';
import { projectPropertyTypeChoices } from '../projects/projectPropertyDefinitions';
import { projectPropertyPresetIssue } from '../projects/projectPropertyPresets';
import { renderProjectValueRow, type ProjectValueRowControls } from './projectValueRow';
import type { SettingsValueCommitRegistrar } from './settingsValueCommit';

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
  readonly valueCommit?: SettingsValueCommitRegistrar;
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
  readonly identities: string[];
  readonly id: string;
  readonly listKey: string;
  readonly labelers: Map<string, (label: string) => void>;
  readonly options: RenderProjectPropertyOptions;
}

interface PresetRowControls extends ProjectValueRowControls {
  readonly error: HTMLElement;
}

function movePreset(context: PresetRowContext, draggedId: string, targetId: string): boolean {
  const from = context.identities.indexOf(draggedId);
  const to = context.identities.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return false;
  const [preset] = context.rawPresets.splice(from, 1);
  const [identity] = context.identities.splice(from, 1);
  if (identity === undefined) return false;
  context.rawPresets.splice(to, 0, preset);
  context.identities.splice(to, 0, identity);
  context.identities.forEach((id, index) => {
    context.labelers.get(id)?.(`${context.options.label} preset ${index + 1}`);
  });
  context.options.onDefinitionChange();
  return true;
}

function createPresetRowControls(context: PresetRowContext): PresetRowControls {
  const { definition, id, identities, listKey, options, rawPresets } = context;
  const index = identities.indexOf(id);
  const record = isRecord(rawPresets[index]) ? rawPresets[index] : {};
  const rawValue = record['value'];
  const display = record['display'];
  const controls = renderProjectValueRow({
    container: context.host,
    id,
    listKey,
    label: `${options.label} preset ${index + 1}`,
    value: typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : '',
    valueType: definition.type === 'number' ? 'number' : 'text',
    ...(typeof record['displayName'] === 'string' ? { displayName: record['displayName'] } : {}),
    ...(typeof record['color'] === 'string' ? { color: record['color'] } : {}),
    ...(display === 'badge' || display === 'text' || display === 'dot' ? { display } : {}),
    onReorder: (draggedId, targetId) => movePreset(context, draggedId, targetId),
  });
  const error = renderPresetError(
    controls.row,
    projectPropertyPresetIssue(
      definition.type,
      rawPresets[index],
      rawPresets.filter((_candidate, candidateIndex) => candidateIndex !== index),
    ),
  );
  return { ...controls, error };
}

function renderPresetRow(context: PresetRowContext): void {
  const { definition, id, identities, options, rawPresets } = context;
  const currentIndex = (): number => identities.indexOf(id);
  const currentRecord = (): Record<string, unknown> | undefined => {
    const index = currentIndex();
    return index >= 0 && isRecord(rawPresets[index]) ? rawPresets[index] : undefined;
  };
  const controls = createPresetRowControls(context);
  context.labelers.set(id, controls.updateLabel);
  const commitValue = (): boolean => {
    const index = currentIndex();
    if (index < 0) return true;
    const current = currentRecord();
    const nextValue =
      definition.type === 'number' ? controls.value.valueAsNumber : controls.value.value;
    const next = { ...(current ?? {}), value: nextValue };
    const issue = projectPropertyPresetIssue(
      definition.type,
      next,
      rawPresets.filter((_candidate, candidateIndex) => candidateIndex !== index),
    );
    controls.error.setText(issue ?? '');
    if (issue !== undefined) return false;
    if (current !== undefined && Object.is(current['value'], nextValue)) return true;
    rawPresets[index] = next;
    options.onDefinitionChange();
    return true;
  };
  const commitDisplayName = (): void => {
    const index = currentIndex();
    if (index < 0) return;
    const record = currentRecord();
    if (record === undefined) return;
    const next: Record<string, unknown> = { ...record };
    if (controls.displayName.value.trim().length === 0) delete next['displayName'];
    else next['displayName'] = controls.displayName.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  };
  const commitColor = (): void => {
    const index = currentIndex();
    if (index < 0) return;
    const record = currentRecord();
    if (record === undefined) return;
    const next: Record<string, unknown> = { ...record };
    next['color'] = controls.color.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  };
  if (options.valueCommit === undefined) {
    controls.value.addEventListener('change', commitValue);
    controls.displayName.addEventListener('change', commitDisplayName);
    controls.color.addEventListener('change', commitColor);
  } else {
    options.valueCommit.register(controls.value, commitValue);
    options.valueCommit.register(controls.displayName, commitDisplayName);
    options.valueCommit.register(controls.color, commitColor);
  }
  controls.appearance.addEventListener('change', () => {
    const index = currentIndex();
    if (index < 0) return;
    const record = currentRecord();
    if (record === undefined) return;
    const next: Record<string, unknown> = { ...record };
    next['display'] = controls.appearance.value;
    rawPresets[index] = next;
    options.onDefinitionChange();
  });
  controls.remove.addEventListener('click', () => {
    const index = currentIndex();
    if (index < 0) return;
    rawPresets.splice(index, 1);
    identities.splice(index, 1);
    options.onDefinitionChange();
    options.refresh();
  });
}

interface PresetListState {
  readonly presets: unknown[];
  readonly listKey: string;
  readonly identities: string[];
}

const presetListStates = new WeakMap<ProjectPropertyDefinition, PresetListState>();
let nextPresetListId = 0;
let nextPresetRuntimeId = 0;

function appendPresetIdentity(state: PresetListState): string {
  const id = `project-preset-${++nextPresetRuntimeId}`;
  state.identities.push(id);
  return id;
}

function presetListState(
  definition: ProjectPropertyDefinition,
  presets: unknown[],
): PresetListState {
  const existing = presetListStates.get(definition);
  if (existing?.presets === presets) {
    while (existing.identities.length < presets.length) appendPresetIdentity(existing);
    if (existing.identities.length > presets.length) {
      existing.identities.splice(presets.length);
    }
    return existing;
  }
  const state: PresetListState = {
    presets,
    listKey: `project-presets-${++nextPresetListId}`,
    identities: [],
  };
  while (state.identities.length < presets.length) appendPresetIdentity(state);
  presetListStates.set(definition, state);
  return state;
}

function renderPresets(options: RenderProjectPropertyOptions): void {
  const definition = options.definition;
  if (definition === undefined || !PRESET_TYPES.has(definition.type)) return;
  new Setting(options.container)
    .setName('Predefined values')
    .setDesc('Offer configured values before values already used by this property.');
  const presets = rawPresetList(definition);
  if (presets === undefined && definition.presets !== undefined) {
    options.container.createDiv({
      cls: 'abyss-project-preset-error',
      text: 'Saved predefined values are malformed. Add a value to replace them.',
      attr: { role: 'status' },
    });
  }
  const values = presets ?? [];
  const list = options.container.createDiv({
    cls: 'abyss-project-value-list abyss-project-preset-list',
  });
  const state = presetListState(definition, values);
  const { identities, listKey } = state;
  const labelers = new Map<string, (label: string) => void>();
  identities.forEach((id) => {
    renderPresetRow({
      host: list,
      definition,
      rawPresets: values,
      identities,
      id,
      listKey,
      labelers,
      options,
    });
  });
  const add = options.container.createEl('button', {
    cls: 'abyss-project-value-add abyss-project-preset-add',
    text: '+ add predefined value',
    attr: { type: 'button' },
  });
  add.addEventListener('click', () => {
    const next = values;
    if (presets === undefined) definition.presets = next as ProjectPropertyPreset[];
    next.push({ value: definition.type === 'number' ? 0 : '' });
    appendPresetIdentity(state);
    options.onDefinitionChange();
    options.refresh();
  });
}

export function renderProjectPropertyOptions(options: RenderProjectPropertyOptions): void {
  renderType(options);
  renderAlignment(options);
  renderPresets(options);
}
