import type { ProjectsSettings } from '../settings/types';
import type { ProjectPropertyCatalog } from './ObsidianProjectProperties';
import type { ProjectFieldCatalogItem, ProjectPropertyType } from './projectFields';

export interface ProjectValuePresentation {
  displayName?: string;
  color?: string;
  display?: 'badge' | 'text' | 'dot';
}

export interface ProjectPropertyPreset extends ProjectValuePresentation {
  value: string | number | boolean;
}

export interface ProjectPropertyDefinition {
  type: ProjectPropertyType;
  /** @deprecated Presets are active whenever valid configured entries exist. */
  presetsEnabled?: boolean;
  presets?: ProjectPropertyPreset[];
}

const PROPERTY_PREFIX = 'property:';
const PROPERTY_TYPES = new Set<ProjectPropertyType>([
  'text',
  'list',
  'number',
  'checkbox',
  'date',
  'datetime',
  'tags',
]);

export function projectPropertyTypeChoices(property: string): readonly ProjectPropertyType[] {
  return sameIdentifier(property, 'tags')
    ? ['tags']
    : ['text', 'list', 'number', 'checkbox', 'date', 'datetime'];
}

function sameIdentifier(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPresetValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function hasOptionalPresetDisplay(record: Record<string, unknown>): boolean {
  const display = record['display'];
  return display === undefined || display === 'badge' || display === 'text' || display === 'dot';
}

function isProjectPropertyType(value: unknown): value is ProjectPropertyType {
  return typeof value === 'string' && PROPERTY_TYPES.has(value as ProjectPropertyType);
}

export function isProjectPropertyDefinition(value: unknown): value is ProjectPropertyDefinition {
  return isRecord(value) && isProjectPropertyType(value['type']);
}

function isProjectPropertyPreset(value: unknown): value is ProjectPropertyPreset {
  if (!isRecord(value) || !isPresetValue(value['value'])) return false;
  return (
    hasOptionalString(value, 'displayName') &&
    hasOptionalString(value, 'color') &&
    hasOptionalPresetDisplay(value)
  );
}

export function hasMalformedProjectPropertyDefinitionPresentation(value: unknown): boolean {
  if (!isProjectPropertyDefinition(value)) return false;
  if (value['presets'] === undefined) return false;
  return (
    !Array.isArray(value['presets']) ||
    value['presets'].some((preset) => !isProjectPropertyPreset(preset))
  );
}

function unavailableCustomField(fieldId: string): ProjectFieldCatalogItem {
  const property = fieldId.slice(PROPERTY_PREFIX.length);
  return { id: fieldId, property, label: property, type: null };
}

function configuredCuratedField(
  projects: ProjectsSettings,
  fieldId: string,
): ProjectFieldCatalogItem | undefined {
  const fields: Record<string, ProjectFieldCatalogItem> = {
    name: { id: 'name', label: 'Name', type: 'name' },
    progress: { id: 'progress', label: 'Progress', type: 'progress' },
    status: {
      id: 'status',
      property: projects.statusProperty,
      label: 'Status',
      type: 'status',
    },
    start: { id: 'start', property: projects.startProperty, label: 'Start', type: 'date' },
    end: { id: 'end', property: projects.endProperty, label: 'End', type: 'date' },
    description: {
      id: 'description',
      property: 'description',
      label: 'Description',
      type: 'text',
    },
  };
  return fields[fieldId];
}

function hasCuratedSourceCollision(projects: ProjectsSettings, property: string): boolean {
  const sources = [
    projects.statusProperty,
    projects.startProperty,
    projects.endProperty,
    'description',
  ];
  return sources.filter((source) => sameIdentifier(source, property)).length > 1;
}

function curatedField(
  projects: ProjectsSettings,
  fieldId: string,
): ProjectFieldCatalogItem | undefined {
  const field = configuredCuratedField(projects, fieldId);
  if (field === undefined) return undefined;
  const property = field.property;
  if (property === undefined) return field;
  if (
    property.length === 0 ||
    sameIdentifier(property, 'tags') ||
    hasCuratedSourceCollision(projects, property)
  ) {
    return { id: field.id, property, label: field.label, type: null };
  }
  return field;
}

function definitionEntries(projects: ProjectsSettings): Array<[string, unknown]> {
  const definitions: unknown = projects.propertyDefinitions;
  return isRecord(definitions) ? Object.entries(definitions) : [];
}

/** Mutates one unambiguous static definition without touching its raw preset payload. */
export function setProjectPropertyDefinitionType(
  projects: ProjectsSettings,
  fieldId: string,
  type: ProjectPropertyType,
): boolean {
  if (!fieldId.startsWith(PROPERTY_PREFIX)) return false;
  const property = fieldId.slice(PROPERTY_PREFIX.length);
  if (!projectPropertyTypeChoices(property).includes(type)) return false;
  if (isConfiguredProjectPropertySourceReserved(projects, property)) return false;
  const matches = definitionEntries(projects).filter(([key]) => sameIdentifier(key, fieldId));
  if (matches.length > 1) return false;
  const key = matches[0]?.[0] ?? fieldId;
  const current = projects.propertyDefinitions[key] as unknown;
  projects.propertyDefinitions[key] = {
    ...(isRecord(current) ? current : {}),
    type,
  };
  return true;
}

function isConfiguredProjectPropertySourceReserved(
  projects: Pick<ProjectsSettings, 'statusProperty' | 'startProperty' | 'endProperty'>,
  property: string,
): boolean {
  return [
    projects.statusProperty,
    projects.startProperty,
    projects.endProperty,
    'description',
  ].some((source) => source.length > 0 && sameIdentifier(source, property));
}

function isConfiguredCustomSourceCompatible(
  projects: ProjectsSettings,
  property: string,
  type: ProjectPropertyType,
): boolean {
  if (property.length === 0 || isConfiguredProjectPropertySourceReserved(projects, property)) {
    return false;
  }
  if (sameIdentifier(property, 'tags')) return type === 'tags';
  return type !== 'tags';
}

/** Resolves the current configured schema; native discovery is never write authority. */
export function resolveConfiguredProjectField(
  projects: ProjectsSettings,
  fieldId: string,
): ProjectFieldCatalogItem | undefined {
  if (!fieldId.startsWith(PROPERTY_PREFIX)) return curatedField(projects, fieldId);
  const matches = definitionEntries(projects).filter(([key]) => sameIdentifier(key, fieldId));
  if (matches.length !== 1) return unavailableCustomField(fieldId);
  const [savedId, definition] = matches[0] ?? [];
  if (savedId?.startsWith(PROPERTY_PREFIX) !== true) return unavailableCustomField(fieldId);
  const property = fieldId.slice(PROPERTY_PREFIX.length);
  if (!isProjectPropertyDefinition(definition)) return unavailableCustomField(fieldId);
  if (!isConfiguredCustomSourceCompatible(projects, property, definition.type))
    return unavailableCustomField(fieldId);
  return { id: fieldId, property, label: property, type: definition.type };
}

export function projectPresetPresentation(
  presets: readonly ProjectPropertyPreset[],
  value: unknown,
): ProjectValuePresentation | undefined {
  const preset = presets.find(
    (candidate) => isProjectPropertyPreset(candidate) && Object.is(candidate.value, value),
  );
  if (preset === undefined) return undefined;
  const { displayName, color, display } = preset;
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(color === undefined ? {} : { color }),
    ...(display === undefined ? {} : { display }),
  };
}

function savedCustomFieldIds(projects: ProjectsSettings): string[] {
  const ids = [
    ...projects.table.columns.map(({ id }) => id),
    projects.table.groupBy,
    projects.table.sortBy.field,
  ];
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (!id.startsWith(PROPERTY_PREFIX)) return false;
    const normalized = id.toLocaleLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function alreadyDefined(projects: ProjectsSettings, fieldId: string): boolean {
  if (definitionEntries(projects).some(([key]) => sameIdentifier(key, fieldId))) return true;
  const migration = (projects as unknown as Record<string, unknown>)['propertyDefinitionMigration'];
  return (
    isRecord(migration) &&
    'propertyDefinitions' in migration &&
    !isRecord(migration['propertyDefinitions'])
  );
}

function capturedType(
  catalog: ProjectPropertyCatalog,
  fieldId: string,
): ProjectPropertyType | undefined {
  const property = fieldId.slice(PROPERTY_PREFIX.length);
  const snapshot = catalog.inspect(property);
  if (snapshot.kind === 'available' && snapshot.assignment.kind === 'assigned') {
    return snapshot.assignment.type ?? undefined;
  }
  const properties = catalog.list();
  if (properties === null) return undefined;
  const matches = properties.filter(({ name }) => sameIdentifier(name, property));
  return matches.length === 1 ? (matches[0]?.type ?? undefined) : undefined;
}

/** Returns only supported definitions absent from the current saved settings. */
export function captureMissingProjectPropertyDefinitions(
  projects: ProjectsSettings,
  catalog: ProjectPropertyCatalog,
): Record<string, ProjectPropertyDefinition> {
  const captured: Record<string, ProjectPropertyDefinition> = {};
  for (const fieldId of savedCustomFieldIds(projects)) {
    if (alreadyDefined(projects, fieldId)) continue;
    const property = fieldId.slice(PROPERTY_PREFIX.length);
    const type = capturedType(catalog, fieldId);
    if (
      type === undefined ||
      isConfiguredProjectPropertySourceReserved(projects, property) ||
      (type === 'tags' && !sameIdentifier(property, 'tags')) ||
      (sameIdentifier(property, 'tags') && type !== 'tags')
    ) {
      continue;
    }
    captured[fieldId] = { type };
  }
  return captured;
}
