import type { ProjectsSettings } from '../settings/types';
import type { Project } from './types';

export type ProjectPropertyType =
  'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags';

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
  visible: boolean;
}

export interface ProjectTableSettings {
  columns: ProjectColumn[];
  groupBy: string;
  sortBy: { field: string; dir: 'asc' | 'desc' };
  hiddenStatuses: string[];
}

export interface UnavailableProjectField {
  id: string;
  property: string;
  label: string;
  type: null;
}

export type ProjectFieldCatalogItem = ProjectField | UnavailableProjectField;

const CORE_FIELDS: readonly ProjectField[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'progress', label: 'Progress', type: 'progress' },
];

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

/** Finds the exact vault/frontmatter spelling for a case-insensitive property name. */
export function findProjectPropertyName(
  names: readonly string[],
  property: string,
): string | undefined {
  return names.find((name) => sameProperty(name, property));
}

function statusPropertyNames(settings: ProjectsSettings): string[] {
  const properties: string[] = [];
  for (const status of settings.statuses) {
    if (status.match.kind === 'property') properties.push(status.match.property);
  }
  return properties;
}

function addVaultProperties(
  fields: ProjectFieldCatalogItem[],
  properties: readonly ProjectPropertyInfo[],
  seen: Set<string>,
): void {
  for (const property of properties) {
    const normalized = property.name.toLocaleLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    fields.push({
      id: `property:${property.name}`,
      property: property.name,
      label: property.name,
      type: property.type,
    });
  }
}

function addSavedProperties(
  fields: ProjectFieldCatalogItem[],
  settings: ProjectsSettings,
  seen: Set<string>,
): void {
  for (const column of settings.table.columns) {
    if (!column.id.startsWith('property:')) continue;
    const property = column.id.slice('property:'.length);
    const normalized = property.toLocaleLowerCase();
    if (property.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    fields.push({ id: column.id, property, label: property, type: null });
  }
}

export function buildProjectFieldCatalog(
  settings: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[],
): ProjectFieldCatalogItem[] {
  const propertyNames = properties.map(({ name }) => name);
  const startProperty = findProjectPropertyName(propertyNames, 'start') ?? 'start';
  const endProperty = findProjectPropertyName(propertyNames, 'end') ?? 'end';
  const fields: ProjectFieldCatalogItem[] = [
    ...CORE_FIELDS,
    { id: 'start', property: startProperty, label: 'Start', type: 'date' },
    { id: 'end', property: endProperty, label: 'End', type: 'date' },
  ];

  const reservesTags = settings.statuses.some((status) => status.match.kind === 'tag');
  const reserved = [startProperty, endProperty, ...statusPropertyNames(settings)];
  if (reservesTags) reserved.push('tags');

  const seen = new Set(reserved.map((name) => name.toLocaleLowerCase()));
  addVaultProperties(fields, properties, seen);
  addSavedProperties(fields, settings, seen);
  return fields;
}

export function isAvailableProjectField(field: ProjectFieldCatalogItem): field is ProjectField {
  return field.type !== null;
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
  if (field.type === 'status') return project.statusId ?? project.rawStatus;
  if (field.type === 'progress') return project.stats;
  if (field.property === undefined) return undefined;
  return findFrontmatterProperty(project.frontmatter, field.property)?.value;
}
