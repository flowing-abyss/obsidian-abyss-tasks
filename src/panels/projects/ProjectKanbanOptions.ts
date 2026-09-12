import { Menu } from 'obsidian';
import type { ProjectDateDisplay, ProjectFieldCatalogItem } from '../../projects/projectFields';
import {
  buildDefaultProjectKanbanSettings,
  type ProjectKanbanSettings,
} from '../../projects/projectKanbanSettings';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { ViewOption, ViewOptionAction, ViewOptionsRow } from '../../ui/ViewOptionsPopover';
import { configureProjectDateDisplayMenu, projectDateDisplayLabel } from './projectColumnMenu';

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

function setFieldDateDisplay(
  context: ProjectKanbanOptionsContext,
  fieldId: string,
  display: ProjectDateDisplay,
): void {
  const settings = context.settings();
  let configured = settings.fields.find(({ id }) => id === fieldId);
  if (configured === undefined) {
    configured = {
      ...(context.tableSettings().columns.find(({ id }) => id === fieldId) ?? { id: fieldId }),
      id: fieldId,
      visible: false,
    };
    settings.fields.push(configured);
  }
  configured.dateDisplay = display;
}

function applyFieldDateDisplay(
  context: ProjectKanbanOptionsContext,
  fieldId: string,
  display: ProjectDateDisplay,
): Promise<void> {
  return applyMutation(context, () => {
    setFieldDateDisplay(context, fieldId, display);
  });
}

function fieldDateAction(
  context: ProjectKanbanOptionsContext,
  field: ProjectFieldCatalogItem,
): ViewOptionAction | undefined {
  if (field.type !== 'date' && field.type !== 'datetime') return undefined;
  const active = (): ProjectDateDisplay =>
    context.settings().fields.find(({ id }) => id === field.id)?.dateDisplay ?? 'pretty';
  return {
    label: () => projectDateDisplayLabel(active()),
    ariaLabel: `Date display for ${labelFor(context, field.id)}`,
    onSelect: (event, run, ownChild) => {
      const trigger = event.currentTarget as HTMLElement | null;
      const menu = new Menu();
      configureProjectDateDisplayMenu(menu, {
        active: active(),
        onSelect: (display) => {
          run(() => applyFieldDateDisplay(context, field.id, display));
        },
      });
      let releaseChild = (): void => undefined;
      menu.onHide(() => {
        releaseChild();
        if (trigger?.instanceOf(HTMLElement) === true && trigger.isConnected) {
          trigger.focus({ preventScroll: true });
        }
      });
      const surface = showMenuAtMouseEventWithFocus(menu, event);
      if (surface !== undefined) {
        releaseChild = ownChild(surface, () => {
          menu.close();
        });
      }
    },
  };
}

function toggleField(
  settings: ProjectKanbanSettings,
  tableSettings: ReturnType<ProjectKanbanOptionsContext['tableSettings']>,
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

function moveField(settings: ProjectKanbanSettings, fieldId: string, targetId: string): void {
  const index = settings.fields.findIndex(({ id }) => id === fieldId);
  const target = settings.fields.findIndex(({ id }) => id === targetId);
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

function fieldOptions(context: ProjectKanbanOptionsContext): ViewOption[] {
  return selectableCardFields(context.fields()).map((field) => {
    const option = {
      value: field.id,
      label: () => labelFor(context, field.id),
    };
    const action = fieldDateAction(context, field);
    return action === undefined ? option : { ...option, action };
  });
}

function groupFieldOptions(context: ProjectKanbanOptionsContext): ViewOption[] {
  return context
    .fields()
    .filter(({ id }) => id !== 'status')
    .map((field) => ({
      value: field.id,
      label: () => labelFor(context, field.id),
    }));
}

function cardFieldsRow(context: ProjectKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'multi',
    icon: 'list-plus',
    label: 'Card fields',
    displayValue: () => {
      const selectedCount = selectedFieldIds(context.settings()).length;
      return selectedCount === 0 ? 'None' : `${selectedCount} shown`;
    },
    selected: () => selectedFieldIds(context.settings()),
    options: fieldOptions(context),
    onToggle: (fieldId) =>
      applyMutation(context, () => {
        toggleField(context.settings(), context.tableSettings(), fieldId);
      }),
    onMove: (fieldId, _direction, targetId) =>
      applyMutation(context, () => {
        moveField(context.settings(), fieldId, targetId);
      }),
  };
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
        cardFieldsRow(context),
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
  return (
    JSON.stringify(settings) !== JSON.stringify(buildDefaultProjectKanbanSettings(tableSettings))
  );
}
