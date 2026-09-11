import {
  projectFieldValue,
  type ProjectColumn,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import type { ProjectKanbanSettings } from '../../projects/projectKanbanSettings';
import type { Project } from '../../projects/types';

export interface ProjectKanbanCardField {
  readonly field: ProjectFieldCatalogItem;
  readonly label: string;
  readonly dateDisplay?: 'relative';
}

export function projectKanbanCardKey(groupKey: string, projectPath: string): string {
  return `${groupKey}\u0000${projectPath}`;
}

export function projectKanbanOccurrenceId(
  statusKey: string,
  groupKey: string,
  projectPath: string,
): string {
  return `${statusKey}\u0000${groupKey}\u0000${projectPath}`;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isReservedCardField(field: ProjectFieldCatalogItem): boolean {
  return field.type === 'name' || field.id === 'description';
}

function effectiveColumnLabel(column: ProjectColumn, fallback: string): string {
  const label = column.label?.trim();
  return label === undefined || label === '' ? fallback : label;
}

function configuredCardField(
  project: Project,
  settings: ProjectKanbanSettings,
  fields: readonly ProjectFieldCatalogItem[],
  column: ProjectColumn,
): ProjectKanbanCardField | undefined {
  if (!column.visible) return undefined;
  const field = fields.find(({ id }) => id === column.id);
  if (field === undefined || isReservedCardField(field)) return undefined;
  if (!settings.showEmptyFields && isEmpty(projectFieldValue(project, field))) return undefined;
  return {
    field,
    label: effectiveColumnLabel(column, field.label),
    ...(column.dateDisplay === undefined ? {} : { dateDisplay: column.dateDisplay }),
  };
}

/** Resolves ordered visible card fields from the shared catalog and board preferences. */
export function projectKanbanCardFields(
  project: Project,
  settings: ProjectKanbanSettings,
  fields: readonly ProjectFieldCatalogItem[],
): ProjectKanbanCardField[] {
  const visible: ProjectKanbanCardField[] = [];
  for (const column of settings.fields) {
    const item = configuredCardField(project, settings, fields, column);
    if (item !== undefined) visible.push(item);
  }
  return visible;
}

export function projectKanbanDescription(
  project: Project,
  field: ProjectFieldCatalogItem | undefined,
): string {
  if (field === undefined) return '';
  const value = projectFieldValue(project, field);
  return typeof value === 'string' ? value : '';
}
