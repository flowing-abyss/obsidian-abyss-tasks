import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import {
  buildDefaultProjectKanbanSettings,
  type ProjectKanbanSettings,
} from '../../projects/projectKanbanSettings';
import type { ViewOptionsRow } from '../../ui/ViewOptionsPopover';

interface ProjectKanbanOptionsContext {
  readonly settings: ProjectKanbanSettings;
  readonly tableSettings: Parameters<typeof buildDefaultProjectKanbanSettings>[0];
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly onChange: (mutation: () => void) => Promise<boolean>;
}

async function applyMutation(
  context: ProjectKanbanOptionsContext,
  mutation: () => void,
): Promise<void> {
  await context.onChange(mutation);
}

function labelFor(
  fields: readonly ProjectFieldCatalogItem[],
  settings: ProjectKanbanSettings,
  tableSettings: ProjectKanbanOptionsContext['tableSettings'],
  fieldId: string,
): string {
  if (fieldId === 'none') return 'None';
  return (
    settings.fields.find(({ id }) => id === fieldId)?.label ??
    tableSettings.columns.find(({ id }) => id === fieldId)?.label ??
    fields.find(({ id }) => id === fieldId)?.label ??
    fieldId
  );
}

function selectableCardFields(
  fields: readonly ProjectFieldCatalogItem[],
): readonly ProjectFieldCatalogItem[] {
  return fields.filter(
    ({ id, type }) => type !== 'name' && id !== 'description' && type !== 'progress',
  );
}

function selectedFieldIds(settings: ProjectKanbanSettings): string[] {
  return settings.fields.filter(({ visible }) => visible).map(({ id }) => id);
}

function toggleField(
  settings: ProjectKanbanSettings,
  tableSettings: ProjectKanbanOptionsContext['tableSettings'],
  fieldId: string,
): void {
  const index = settings.fields.findIndex(({ id }) => id === fieldId);
  if (index < 0) {
    settings.fields.push({
      ...(tableSettings.columns.find(({ id }) => id === fieldId) ?? { id: fieldId }),
      id: fieldId,
      visible: true,
    });
    return;
  }
  const configured = settings.fields[index];
  if (configured !== undefined) configured.visible = !configured.visible;
}

function moveField(
  settings: ProjectKanbanSettings,
  fieldId: string,
  direction: 'up' | 'down',
): void {
  const index = settings.fields.findIndex(({ id }) => id === fieldId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= settings.fields.length) return;
  const [field] = settings.fields.splice(index, 1);
  if (field !== undefined) settings.fields.splice(target, 0, field);
}

function setBoolean(
  settings: ProjectKanbanSettings,
  key: 'showEmptyFields' | 'showEmptyProgress',
  value: string,
): void {
  settings[key] = value === 'show';
}

function fieldOptions(
  context: ProjectKanbanOptionsContext,
): Array<{ value: string; label: string }> {
  return selectableCardFields(context.fields).map((field) => ({
    value: field.id,
    label: labelFor(context.fields, context.settings, context.tableSettings, field.id),
  }));
}

function groupFieldOptions(
  context: ProjectKanbanOptionsContext,
): Array<{ value: string; label: string }> {
  return context.fields
    .filter(({ id }) => id !== 'status')
    .map((field) => ({
      value: field.id,
      label: labelFor(context.fields, context.settings, context.tableSettings, field.id),
    }));
}

function cardFieldsRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'multi',
    icon: 'list-plus',
    label: 'Card fields',
    displayValue: () => {
      const selectedCount = selectedFieldIds(context.settings).length;
      return selectedCount === 0 ? 'None' : `${selectedCount} shown`;
    },
    selected: () => selectedFieldIds(context.settings),
    options: fieldOptions(context),
    onToggle: (fieldId) =>
      applyMutation(context, () => {
        toggleField(context.settings, context.tableSettings, fieldId);
      }),
    onMove: (fieldId, direction) =>
      applyMutation(context, () => {
        moveField(context.settings, fieldId, direction);
      }),
  };
}

function descriptionLines(value: string): 0 | 1 | 2 {
  if (value === '2') return 2;
  if (value === '1') return 1;
  return 0;
}

function descriptionDisplay(lines: 0 | 1 | 2): string {
  if (lines === 0) return 'Hidden';
  return lines === 1 ? '1 line' : '2 lines';
}

function descriptionRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'text',
    label: 'Description',
    displayValue: descriptionDisplay(context.settings.descriptionLines),
    activeValue: String(context.settings.descriptionLines),
    options: [
      { value: '0', label: 'Hidden' },
      { value: '1', label: '1 line', isDefault: true },
      { value: '2', label: '2 lines' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings.descriptionLines = descriptionLines(value);
      }),
  };
}

function progressDisplay(progress: ProjectKanbanSettings['progress']): string {
  if (progress === 'hidden') return 'Hidden';
  return progress === 'bar' ? 'Bars' : 'Bars and numbers';
}

function progressRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'chart-no-axes-column-increasing',
    label: 'Progress',
    displayValue: progressDisplay(context.settings.progress),
    activeValue: context.settings.progress,
    options: [
      { value: 'hidden', label: 'Hidden' },
      { value: 'bar', label: 'Bars' },
      { value: 'full', label: 'Bars and numbers', isDefault: true },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings.progress = value === 'bar' || value === 'hidden' ? value : 'full';
      }),
  };
}

function booleanRow(
  context: ProjectKanbanOptionsContext,
  key: 'showEmptyFields' | 'showEmptyProgress',
  label: string,
  icon: string,
): ViewOptionsRow {
  const shown = context.settings[key];
  return {
    kind: 'single',
    icon,
    label,
    displayValue: shown ? 'Show' : 'Hide',
    activeValue: shown ? 'show' : 'hide',
    options: [
      { value: 'hide', label: 'Hide', isDefault: true },
      { value: 'show', label: 'Show' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        setBoolean(context.settings, key, value);
      }),
  };
}

function emptyColumnsRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'columns-3',
    label: 'Empty columns',
    displayValue: context.settings.emptyColumns === 'compact' ? 'Compact' : 'Expanded',
    activeValue: context.settings.emptyColumns,
    options: [
      { value: 'compact', label: 'Compact', isDefault: true },
      { value: 'expanded', label: 'Expanded' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings.emptyColumns = value === 'expanded' ? 'expanded' : 'compact';
      }),
  };
}

function groupRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  const { settings, fields, tableSettings } = context;
  const displayValue =
    settings.groupBy === 'status'
      ? 'Status columns'
      : labelFor(fields, settings, tableSettings, settings.groupBy);
  return {
    kind: 'single',
    icon: 'layout-list',
    label: 'Group by',
    displayValue,
    activeValue: settings.groupBy,
    options: [
      { value: 'none', label: 'None' },
      { value: 'status', label: 'Status columns', isDefault: true },
      ...groupFieldOptions(context),
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        settings.groupBy = value;
      }),
  };
}

function updateSort(settings: ProjectKanbanSettings, field: string): void {
  if (field === 'none') {
    settings.sortBy = { field: 'none', dir: 'asc' };
    return;
  }
  if (settings.sortBy.field !== field) {
    settings.sortBy = { field, dir: 'asc' };
    return;
  }
  settings.sortBy = { field, dir: settings.sortBy.dir === 'asc' ? 'desc' : 'asc' };
}

function sortRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  const { settings, fields, tableSettings } = context;
  const label = labelFor(fields, settings, tableSettings, settings.sortBy.field);
  const arrow = settings.sortBy.dir === 'asc' ? '↑' : '↓';
  return {
    kind: 'single',
    icon: 'arrow-up-down',
    label: 'Sort by',
    displayValue: settings.sortBy.field === 'none' ? 'Manual' : `${label} ${arrow}`,
    activeValue: settings.sortBy.field,
    options: [
      { value: 'none', label: 'Manual' },
      ...fields.map((field) => ({
        value: field.id,
        label: labelFor(fields, settings, tableSettings, field.id),
      })),
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        updateSort(settings, value);
      }),
  };
}

/** Builds the board-specific rows inside the existing project view-options surface. */
export function projectKanbanOptionsRows(context: ProjectKanbanOptionsContext): ViewOptionsRow[] {
  return [
    cardFieldsRow(context),
    descriptionRow(context),
    progressRow(context),
    booleanRow(context, 'showEmptyFields', 'Empty fields', 'rows-3'),
    booleanRow(context, 'showEmptyProgress', 'Progress without tasks', 'circle-slash-2'),
    emptyColumnsRow(context),
    groupRow(context),
    sortRow(context),
  ];
}

export function isProjectKanbanCustomized(
  settings: ProjectKanbanSettings,
  tableSettings: Parameters<typeof buildDefaultProjectKanbanSettings>[0],
): boolean {
  return (
    JSON.stringify(settings) !== JSON.stringify(buildDefaultProjectKanbanSettings(tableSettings))
  );
}
