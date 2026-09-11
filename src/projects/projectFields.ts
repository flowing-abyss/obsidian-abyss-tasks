import type { ProjectsSettings } from '../settings/types';
import { resolveConfiguredProjectField } from './projectPropertyDefinitions';
import type { Project } from './types';

export type ProjectPropertyType =
  'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags';

export type ProjectColumnAlignment = 'left' | 'center' | 'right';

export interface ProjectField {
  id: string;
  property?: string;
  label: string;
  type: ProjectPropertyType | 'status' | 'progress' | 'name';
}

export interface ProjectPropertyInfo {
  name: string;
  type: ProjectPropertyType | null;
}

export interface ProjectColumn {
  id: string;
  label?: string;
  width?: number;
  alignment?: ProjectColumnAlignment;
  dateDisplay?: 'relative';
  visible: boolean;
}

export interface ProjectTableSettings {
  columns: ProjectColumn[];
  showDescription: boolean;
  groupBy: string;
  sortBy: { field: string; dir: 'asc' | 'desc' };
  hiddenStatuses: string[];
}

interface UnavailableProjectField {
  id: string;
  property: string;
  label: string;
  type: null;
}

export type ProjectFieldCatalogItem = ProjectField | UnavailableProjectField;

const NAME_FIELD: ProjectField = { id: 'name', label: 'Name', type: 'name' };
const PROGRESS_FIELD: ProjectField = { id: 'progress', label: 'Progress', type: 'progress' };
const DESCRIPTION_PROPERTY = 'description';

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

/** Finds the exact vault/frontmatter spelling for a case-insensitive property name. */
function findProjectPropertyName(names: readonly string[], property: string): string | undefined {
  return names.find((name) => sameProperty(name, property));
}

/** True when a property is owned by one of the configured curated fields. */
export function isReservedProjectProperty(settings: ProjectsSettings, property: string): boolean {
  return [
    DESCRIPTION_PROPERTY,
    settings.statusProperty,
    settings.startProperty,
    settings.endProperty,
  ].some((configured) => configured.length > 0 && sameProperty(configured, property));
}

function customFieldIds(
  settings: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[],
): string[] {
  const definitions: unknown = settings.propertyDefinitions;
  const definitionIds =
    definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions)
      ? Object.keys(definitions)
      : [];
  return [
    ...settings.table.columns.map(({ id }) => id),
    settings.table.groupBy,
    settings.table.sortBy.field,
    ...(settings.kanban?.fields.map(({ id }) => id) ?? []),
    ...(settings.kanban === undefined
      ? []
      : [settings.kanban.groupBy, settings.kanban.sortBy.field]),
    ...definitionIds,
    ...properties.map(({ name }) => `property:${name}`),
  ];
}

function appendCustomField(
  fields: ProjectFieldCatalogItem[],
  seen: Set<string>,
  settings: ProjectsSettings,
  fieldId: string,
): void {
  if (!fieldId.startsWith('property:')) return;
  const property = fieldId.slice('property:'.length);
  const normalized = property.toLocaleLowerCase();
  if (property.length === 0 || isReservedProjectProperty(settings, property)) return;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  fields.push(
    resolveConfiguredProjectField(settings, fieldId) ?? {
      id: fieldId,
      property,
      label: property,
      type: null,
    },
  );
}

export function buildProjectFieldCatalog(
  settings: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[] | null,
): ProjectFieldCatalogItem[] {
  const fields: ProjectFieldCatalogItem[] = [
    NAME_FIELD,
    resolveConfiguredProjectField(settings, 'status') ?? {
      id: 'status',
      property: settings.statusProperty,
      label: 'Status',
      type: null,
    },
    PROGRESS_FIELD,
    resolveConfiguredProjectField(settings, 'start') ?? {
      id: 'start',
      property: settings.startProperty,
      label: 'Start',
      type: null,
    },
    resolveConfiguredProjectField(settings, 'end') ?? {
      id: 'end',
      property: settings.endProperty,
      label: 'End',
      type: null,
    },
    resolveConfiguredProjectField(settings, 'description') ?? {
      id: 'description',
      property: DESCRIPTION_PROPERTY,
      label: 'Description',
      type: null,
    },
  ];
  const seen = new Set<string>();
  for (const fieldId of customFieldIds(settings, properties ?? [])) {
    appendCustomField(fields, seen, settings, fieldId);
  }
  return fields;
}

export function isAvailableProjectField(field: ProjectFieldCatalogItem): field is ProjectField {
  return field.type !== null;
}

/** True for the curated Status field regardless of current edit availability. */
export function isProjectStatusField(field: ProjectFieldCatalogItem): boolean {
  return field.id === 'status';
}

export function findProjectFieldById(
  fields: readonly ProjectFieldCatalogItem[],
  id: string,
): ProjectFieldCatalogItem | undefined {
  const exact = fields.find((field) => field.id === id);
  if (exact !== undefined || !id.startsWith('property:')) return exact;
  const property = id.slice('property:'.length);
  return fields.find(
    (field) =>
      field.property !== undefined &&
      field.id.startsWith('property:') &&
      sameProperty(field.property, property),
  );
}

export function findFrontmatterProperty(
  frontmatter: Readonly<Record<string, unknown>>,
  property: string,
): { key: string; value: unknown } | undefined {
  const key = findProjectPropertyName(Object.keys(frontmatter), property);
  return key === undefined ? undefined : { key, value: frontmatter[key] };
}

export function projectFieldValue(project: Project, field: ProjectFieldCatalogItem): unknown {
  if (field.type === 'name') return project.name;
  if (isProjectStatusField(field)) return project.statusId ?? project.rawStatus;
  if (field.type === 'progress') return project.stats;
  if (field.property === undefined) return undefined;
  return findFrontmatterProperty(project.frontmatter, field.property)?.value;
}
