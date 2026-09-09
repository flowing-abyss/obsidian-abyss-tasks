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

function addVaultProperties(
  fields: ProjectFieldCatalogItem[],
  settings: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[],
  seen: Set<string>,
): void {
  for (const property of properties) {
    const normalized = property.name.toLocaleLowerCase();
    if (isReservedProjectProperty(settings, property.name) || seen.has(normalized)) continue;
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
    if (
      property.length === 0 ||
      isReservedProjectProperty(settings, property) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    fields.push({ id: column.id, property, label: property, type: null });
  }
}

function curatedStatusType(
  property: string,
  properties: readonly ProjectPropertyInfo[] | null,
  info: ProjectPropertyInfo | undefined,
  collides: boolean,
): 'status' | null {
  if (property.length === 0 || collides || properties === null) return null;
  return info === undefined || info.type === 'text' ? 'status' : null;
}

function curatedDateType(
  properties: readonly ProjectPropertyInfo[] | null,
  info: ProjectPropertyInfo | undefined,
  collides: boolean,
): 'date' | null {
  if (collides || properties === null) return null;
  return info === undefined || info.type === 'date' ? 'date' : null;
}

function curatedDescriptionType(
  properties: readonly ProjectPropertyInfo[] | null,
  info: ProjectPropertyInfo | undefined,
  collides: boolean,
): 'text' | null {
  if (collides || properties === null) return null;
  return info === undefined || info.type === 'text' ? 'text' : null;
}

export function buildProjectFieldCatalog(
  settings: ProjectsSettings,
  properties: readonly ProjectPropertyInfo[] | null,
): ProjectFieldCatalogItem[] {
  const discoveredProperties = properties ?? [];
  const propertyNames = discoveredProperties.map(({ name }) => name);
  const statusProperty =
    findProjectPropertyName(propertyNames, settings.statusProperty) ?? settings.statusProperty;
  const startProperty =
    findProjectPropertyName(propertyNames, settings.startProperty) ?? settings.startProperty;
  const endProperty =
    findProjectPropertyName(propertyNames, settings.endProperty) ?? settings.endProperty;
  const descriptionProperty =
    findProjectPropertyName(propertyNames, DESCRIPTION_PROPERTY) ?? DESCRIPTION_PROPERTY;
  const curatedProperties = [statusProperty, startProperty, endProperty, descriptionProperty];
  const sourceCollides = (index: number): boolean =>
    curatedProperties.some(
      (property, candidate) =>
        candidate !== index && sameProperty(curatedProperties[index] ?? '', property),
    );
  const statusInfo = discoveredProperties.find(({ name }) => sameProperty(name, statusProperty));
  const startInfo = discoveredProperties.find(({ name }) => sameProperty(name, startProperty));
  const endInfo = discoveredProperties.find(({ name }) => sameProperty(name, endProperty));
  const descriptionInfo = discoveredProperties.find(({ name }) =>
    sameProperty(name, descriptionProperty),
  );
  const fields: ProjectFieldCatalogItem[] = [
    NAME_FIELD,
    {
      id: 'status',
      property: statusProperty,
      label: 'Status',
      type: curatedStatusType(statusProperty, properties, statusInfo, sourceCollides(0)),
    },
    PROGRESS_FIELD,
    {
      id: 'start',
      property: startProperty,
      label: 'Start',
      type: curatedDateType(properties, startInfo, sourceCollides(1)),
    },
    {
      id: 'end',
      property: endProperty,
      label: 'End',
      type: curatedDateType(properties, endInfo, sourceCollides(2)),
    },
    {
      id: 'description',
      property: descriptionProperty,
      label: 'Description',
      type: curatedDescriptionType(properties, descriptionInfo, sourceCollides(3)),
    },
  ];

  const seen = new Set<string>();
  addVaultProperties(fields, settings, discoveredProperties, seen);
  addSavedProperties(fields, settings, seen);
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
