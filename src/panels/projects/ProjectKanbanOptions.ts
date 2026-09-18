import {
  isGroupableProjectField,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import {
  buildDefaultProjectKanbanSettings,
  type ProjectKanbanSettings,
} from '../../projects/projectKanbanSettings';
import type { ViewOption, ViewOptionsRow } from '../../ui/ViewOptionsPopover';
import { projectCardFieldsOptionsRow } from './projectCardFields';

interface ProjectKanbanOptionsContext {
  readonly settings: () => ProjectKanbanSettings;
  readonly tableSettings: () => Parameters<typeof buildDefaultProjectKanbanSettings>[0];
  readonly fields: () => readonly ProjectFieldCatalogItem[];
  readonly onChange: (mutation: () => void) => Promise<boolean>;
}

async function applyMutation(
  context: ProjectKanbanOptionsContext,
  mutation: () => void,
): Promise<void> {
  await context.onChange(mutation);
}

function labelFor(context: ProjectKanbanOptionsContext, fieldId: string): string {
  if (fieldId === 'none') return 'None';
  return (
    context.settings().fields.find(({ id }) => id === fieldId)?.label ??
    context.tableSettings().columns.find(({ id }) => id === fieldId)?.label ??
    context.fields().find(({ id }) => id === fieldId)?.label ??
    fieldId
  );
}

function setBoolean(
  settings: ProjectKanbanSettings,
  key: 'showEmptyFields' | 'showEmptyProgress',
  value: string,
): void {
  settings[key] = value === 'show';
}

function groupFieldOptions(context: ProjectKanbanOptionsContext): ViewOption[] {
  return context
    .fields()
    .filter((field) => field.id !== 'status' && isGroupableProjectField(field))
    .map((field) => ({
      value: field.id,
      label: () => labelFor(context, field.id),
    }));
}

function descriptionLines(value: string): ProjectKanbanSettings['descriptionLines'] {
  const values: Readonly<Record<string, ProjectKanbanSettings['descriptionLines']>> = {
    '1': 1,
    '2': 2,
    full: 'full',
  };
  return values[value] ?? 0;
}

function descriptionDisplay(lines: ProjectKanbanSettings['descriptionLines']): string {
  if (lines === 0) return 'Hidden';
  if (lines === 1) return '1 line';
  return lines === 2 ? '2 lines' : 'Full';
}

function descriptionRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'text',
    label: 'Description',
    displayValue: () => descriptionDisplay(context.settings().descriptionLines),
    activeValue: () => String(context.settings().descriptionLines),
    options: [
      { value: '0', label: 'Hidden' },
      { value: '1', label: '1 line', isDefault: true },
      { value: '2', label: '2 lines' },
      { value: 'full', label: 'Full' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings().descriptionLines = descriptionLines(value);
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
    displayValue: () => progressDisplay(context.settings().progress),
    activeValue: () => context.settings().progress,
    options: [
      { value: 'hidden', label: 'Hidden' },
      { value: 'bar', label: 'Bars' },
      { value: 'full', label: 'Bars and numbers', isDefault: true },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings().progress = value === 'bar' || value === 'hidden' ? value : 'full';
      }),
  };
}

function booleanRow(
  context: ProjectKanbanOptionsContext,
  key: 'showEmptyFields' | 'showEmptyProgress',
  label: string,
  icon: string,
): ViewOptionsRow {
  return {
    kind: 'single',
    icon,
    label,
    displayValue: () => (context.settings()[key] ? 'Show' : 'Hide'),
    activeValue: () => (context.settings()[key] ? 'show' : 'hide'),
    options: [
      { value: 'hide', label: 'Hide', isDefault: true },
      { value: 'show', label: 'Show' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        setBoolean(context.settings(), key, value);
      }),
  };
}

function emptyColumnsRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'columns-3',
    label: 'Empty columns',
    displayValue: () => (context.settings().emptyColumns === 'compact' ? 'Compact' : 'Expanded'),
    activeValue: () => context.settings().emptyColumns,
    options: [
      { value: 'compact', label: 'Compact', isDefault: true },
      { value: 'expanded', label: 'Expanded' },
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings().emptyColumns = value === 'expanded' ? 'expanded' : 'compact';
      }),
  };
}

function groupRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'layout-list',
    label: 'Group by',
    displayValue: () =>
      context.settings().groupBy === 'status'
        ? 'Status columns'
        : labelFor(context, context.settings().groupBy),
    activeValue: () => context.settings().groupBy,
    options: [
      { value: 'none', label: 'None' },
      { value: 'status', label: 'Status columns', isDefault: true },
      ...groupFieldOptions(context),
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        context.settings().groupBy = value;
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
  return {
    kind: 'single',
    icon: 'arrow-up-down',
    label: 'Sort by',
    displayValue: () => {
      const settings = context.settings();
      const label = labelFor(context, settings.sortBy.field);
      const arrow = settings.sortBy.dir === 'asc' ? '↑' : '↓';
      return settings.sortBy.field === 'none' ? 'Manual' : `${label} ${arrow}`;
    },
    activeValue: () => context.settings().sortBy.field,
    options: [
      { value: 'none', label: 'Manual' },
      ...context.fields().map((field) => ({
        value: field.id,
        label: () => {
          const settings = context.settings();
          const label = labelFor(context, field.id);
          const arrow = settings.sortBy.dir === 'asc' ? '↑' : '↓';
          return `${label} ${settings.sortBy.field === field.id ? arrow : ''}`.trim();
        },
      })),
    ],
    onSelect: (value) =>
      applyMutation(context, () => {
        updateSort(context.settings(), value);
      }),
  };
}

/** Builds the board-specific rows inside the existing project view-options surface. */
export function projectKanbanOptionsRows(context: ProjectKanbanOptionsContext): ViewOptionsRow[] {
  return [
    groupRow(context),
    sortRow(context),
    {
      kind: 'group',
      icon: 'columns-3',
      label: 'Kanban',
      displayValue: '6 options',
      rows: [
        projectCardFieldsOptionsRow(context, { label: 'Card fields' }),
        descriptionRow(context),
        progressRow(context),
        booleanRow(context, 'showEmptyFields', 'Empty fields', 'rows-3'),
        booleanRow(context, 'showEmptyProgress', 'Progress without tasks', 'circle-slash-2'),
        emptyColumnsRow(context),
      ],
    },
  ];
}

export function isProjectKanbanCustomized(
  settings: ProjectKanbanSettings,
  tableSettings: Parameters<typeof buildDefaultProjectKanbanSettings>[0],
): boolean {
  const preferences = projectKanbanPreferences(settings);
  const defaults = projectKanbanPreferences(buildDefaultProjectKanbanSettings(tableSettings));
  return JSON.stringify(preferences) !== JSON.stringify(defaults);
}

function projectKanbanPreferences({
  manualOrder: _manualOrder,
  ...preferences
}: ProjectKanbanSettings): Omit<ProjectKanbanSettings, 'manualOrder'> {
  return preferences;
}
