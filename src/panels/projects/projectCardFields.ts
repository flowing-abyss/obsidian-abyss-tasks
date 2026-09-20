import { Menu } from 'obsidian';
import {
  findProjectFieldById,
  projectFieldValue,
  type ProjectColumn,
  type ProjectDateDisplay,
  type ProjectFieldCatalogItem,
  type ProjectTableSettings,
} from '../../projects/projectFields';
import { sameProjectPropertyName } from '../../projects/projectPropertyNames';
import type { Project } from '../../projects/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { ViewOption, ViewOptionAction, ViewOptionsRow } from '../../ui/ViewOptionsPopover';
import { configureProjectDateDisplayMenu, projectDateDisplayLabel } from './projectColumnMenu';

export interface ProjectCardFieldSettings {
  fields?: ProjectColumn[];
  showEmptyFields?: boolean;
}

export interface ProjectCardField {
  readonly field: ProjectFieldCatalogItem;
  readonly column: ProjectColumn;
  readonly label: string;
  readonly dateDisplay?: ProjectDateDisplay;
}

export interface ProjectCardFieldsOptionsContext<TSettings extends ProjectCardFieldSettings> {
  readonly settings: () => TSettings;
  readonly tableSettings: () => ProjectTableSettings;
  readonly fields: () => readonly ProjectFieldCatalogItem[];
  readonly onChange: (mutation: () => void) => Promise<boolean>;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isReservedField(field: ProjectFieldCatalogItem): boolean {
  return field.type === 'name' || field.id === 'description';
}

function effectiveColumnLabel(column: ProjectColumn, fallback: string): string {
  const label = column.label?.trim();
  return label === undefined || label === '' ? fallback : label;
}

/** Resolves ordered visible fields from shared card-like presentation settings. */
export function projectCardFields(
  project: Project,
  settings: ProjectCardFieldSettings,
  fields: readonly ProjectFieldCatalogItem[],
  fallbackFields: readonly ProjectColumn[] = [],
): ProjectCardField[] {
  const configured = settings.fields ?? fallbackFields;
  const showEmpty = settings.showEmptyFields ?? true;
  return configured.flatMap((column) => {
    if (!column.visible) return [];
    const field = findProjectFieldById(fields, column.id);
    if (field === undefined || isReservedField(field)) return [];
    if (!showEmpty && isEmpty(projectFieldValue(project, field))) return [];
    return [
      {
        field,
        column,
        label: effectiveColumnLabel(column, field.label),
        ...(column.dateDisplay === undefined ? {} : { dateDisplay: column.dateDisplay }),
      },
    ];
  });
}

export function projectCardDescription(
  project: Project,
  field: ProjectFieldCatalogItem | undefined,
): string {
  if (field === undefined) return '';
  const value = projectFieldValue(project, field);
  return typeof value === 'string' ? value : '';
}

function configuredFields<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
): ProjectColumn[] {
  return context.settings().fields ?? fallbackFields.map((field) => ({ ...field }));
}

function ensureFields<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
): ProjectColumn[] {
  const settings = context.settings();
  if (settings.fields !== undefined) return settings.fields;
  const fields = fallbackFields.map((field) => ({ ...field }));
  settings.fields = fields;
  return fields;
}

function labelFor<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fieldId: string,
): string {
  return (
    configuredFields(context, []).find(({ id }) => sameProjectPropertyName(id, fieldId))?.label ??
    context.tableSettings().columns.find(({ id }) => sameProjectPropertyName(id, fieldId))?.label ??
    findProjectFieldById(context.fields(), fieldId)?.label ??
    fieldId
  );
}

function selectableFields(
  fields: readonly ProjectFieldCatalogItem[],
): readonly ProjectFieldCatalogItem[] {
  return fields.filter(
    ({ id, type }) =>
      type !== 'name' && id !== 'description' && type !== 'progress' && type !== 'tracked',
  );
}

function setFieldDateDisplay<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
  fieldId: string,
  display: ProjectDateDisplay,
): void {
  const fields = ensureFields(context, fallbackFields);
  let configured = fields.find(({ id }) => sameProjectPropertyName(id, fieldId));
  if (configured === undefined) {
    configured = {
      ...(context
        .tableSettings()
        .columns.find(({ id }) => sameProjectPropertyName(id, fieldId)) ?? { id: fieldId }),
      id: fieldId,
      visible: false,
    };
    fields.push(configured);
  }
  configured.dateDisplay = display;
}

function fieldDateAction<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
  field: ProjectFieldCatalogItem,
): ViewOptionAction | undefined {
  if (field.type !== 'date' && field.type !== 'datetime') return undefined;
  const active = (): ProjectDateDisplay =>
    configuredFields(context, fallbackFields).find(({ id }) =>
      sameProjectPropertyName(id, field.id),
    )?.dateDisplay ?? 'pretty';
  return {
    label: () => projectDateDisplayLabel(active()),
    ariaLabel: `Date display for ${labelFor(context, field.id)}`,
    onSelect: (event, run, ownChild) => {
      const trigger = event.currentTarget as HTMLElement | null;
      const menu = new Menu();
      configureProjectDateDisplayMenu(menu, {
        active: active(),
        onSelect: (display) => {
          run(async () => {
            await context.onChange(() => {
              setFieldDateDisplay(context, fallbackFields, field.id, display);
            });
          });
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

function toggleField<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
  fieldId: string,
): void {
  const fields = ensureFields(context, fallbackFields);
  const configured = fields.find(({ id }) => sameProjectPropertyName(id, fieldId));
  if (configured === undefined) {
    fields.push({
      ...(context
        .tableSettings()
        .columns.find(({ id }) => sameProjectPropertyName(id, fieldId)) ?? { id: fieldId }),
      id: fieldId,
      visible: true,
    });
  } else configured.visible = !configured.visible;
}

function moveField<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  fallbackFields: readonly ProjectColumn[],
  fieldId: string,
  targetId: string,
): void {
  const fields = ensureFields(context, fallbackFields);
  const index = fields.findIndex(({ id }) => sameProjectPropertyName(id, fieldId));
  const target = fields.findIndex(({ id }) => sameProjectPropertyName(id, targetId));
  if (index < 0 || target < 0 || target >= fields.length) return;
  const [field] = fields.splice(index, 1);
  if (field !== undefined) fields.splice(target, 0, field);
}

/** Builds the shared field visibility, order, and date-presentation row. */
export function projectCardFieldsOptionsRow<TSettings extends ProjectCardFieldSettings>(
  context: ProjectCardFieldsOptionsContext<TSettings>,
  options: { readonly label: string; readonly fallbackFields?: readonly ProjectColumn[] },
): ViewOptionsRow {
  const fallbackFields = options.fallbackFields ?? [];
  const selected = (): string[] =>
    configuredFields(context, fallbackFields)
      .filter(({ visible }) => visible)
      .flatMap(({ id }) => {
        const field = findProjectFieldById(context.fields(), id);
        return field === undefined ? [] : [field.id];
      });
  const fieldOptions: ViewOption[] = selectableFields(context.fields()).map((field) => {
    const option = { value: field.id, label: () => labelFor(context, field.id) };
    const action = fieldDateAction(context, fallbackFields, field);
    return action === undefined ? option : { ...option, action };
  });
  return {
    kind: 'multi',
    icon: 'list-plus',
    label: options.label,
    displayValue: () => {
      const selectedCount = selected().length;
      return selectedCount === 0 ? 'None' : `${selectedCount} shown`;
    },
    selected,
    options: fieldOptions,
    onToggle: (fieldId) =>
      context
        .onChange(() => {
          toggleField(context, fallbackFields, fieldId);
        })
        .then(() => undefined),
    onMove: (fieldId, _direction, targetId) =>
      context
        .onChange(() => {
          moveField(context, fallbackFields, fieldId, targetId);
        })
        .then(() => undefined),
  };
}
