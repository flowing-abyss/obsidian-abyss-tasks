import type {
  ProjectDtoV1,
  ProjectFieldValueV1,
  ProjectSchemaFieldV1,
  ProjectStatusV1,
} from '../../api';
import type { ProjectsSettings } from '../settings/types';
import type { ProjectIntegrationReads } from './projectApi';
import { defaultProjectCreationStatus } from './projectCreation';
import { parseProjectDate, validDate, validDatetime } from './projectDateValue';
import { buildCuratedProjectFieldCatalog, type ProjectFieldCatalogItem } from './projectFields';
import {
  configuredProjectCustomFields,
  hasAuthoritativeProjectPropertyDefinitions,
  resolveConfiguredProjectField,
} from './projectPropertyDefinitions';
import { sameProjectPropertyName } from './projectPropertyNames';
import { compileProjectPropertyPresets } from './projectPropertyPresets';

export function schemaFor(
  settings: ProjectsSettings,
  fields = catalog(settings),
): ReturnType<ProjectIntegrationReads['schema']> {
  const statuses = statusChoices(settings);
  const defaultStatusId =
    typeof settings.defaultStatusId === 'string'
      ? defaultProjectCreationStatus(settings)
      : undefined;
  return {
    statuses,
    ...(fields.some((field) => field.id === 'status' && field.type === 'status') &&
    defaultStatusId !== undefined &&
    statuses.some(({ id }) => id === defaultStatusId)
      ? { defaultStatusId }
      : {}),
    fields: fields.map((field) => schemaField(field, settings)),
  };
}
export function statusChoices(
  settings: ProjectsSettings,
): Array<{ id: string; name: string; displayName?: string }> {
  const raw: readonly unknown[] = settings.statuses;
  const choices = raw.filter(isStatusChoice);
  return choices
    .filter(
      (item) =>
        choices.filter((other) => other.id === item.id || other.name === item.name).length === 1,
    )
    .map(({ id, name, displayName }) => ({
      id,
      name,
      ...(typeof displayName === 'string' && displayName !== name ? { displayName } : {}),
    }));
}
function isStatusChoice(
  value: unknown,
): value is { id: string; name: string; displayName?: unknown } {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item['id'] === 'string' &&
    item['id'].length > 0 &&
    typeof item['name'] === 'string' &&
    item['name'].length > 0
  );
}
export function catalog(settings: ProjectsSettings): ProjectFieldCatalogItem[] {
  const fields = buildCuratedProjectFieldCatalog(settings).map((field) =>
    field.property !== undefined && unsafeProperty(field.property)
      ? { ...field, property: field.property, type: null }
      : field,
  );
  return hasAuthoritativeProjectPropertyDefinitions(settings)
    ? fields.concat(
        configuredProjectCustomFields(settings).filter(
          (field) => !unsafeProperty(field.id.slice(9)),
        ),
      )
    : fields;
}
function unsafeProperty(property: string): boolean {
  return ['__proto__', 'constructor', 'prototype'].some((reserved) =>
    sameProjectPropertyName(property, reserved),
  );
}
function schemaField(
  field: ProjectFieldCatalogItem,
  settings: ProjectsSettings,
): ProjectSchemaFieldV1 {
  if (field.type === 'name' || field.type === 'progress' || field.type === 'tracked')
    return {
      id: field.id,
      label: field.label,
      kind: 'derived',
      type: field.type === 'tracked' ? 'tracking' : field.type,
      writable: false,
    };
  if (field.type === null) return unavailableField(field);
  if (field.type === 'status')
    return { id: field.id, label: field.label, kind: 'status', type: 'status', writable: true };
  const presets = field.id.startsWith('property:')
    ? compileProjectPropertyPresets(settings.propertyDefinitions[field.id]).presets
    : [];
  return {
    id: field.id,
    label: field.label,
    kind: 'field',
    type: field.type,
    writable: true,
    ...(presets.length === 0
      ? {}
      : {
          suggestions: presets.map(({ value, displayName }) => ({
            value: value as string | number,
            ...(displayName === undefined ? {} : { displayName }),
          })),
        }),
  };
}
function unavailableField(
  field: Extract<ProjectFieldCatalogItem, { type: null }>,
): ProjectSchemaFieldV1 {
  let type: 'status' | 'text' | 'date' = 'date';
  if (field.id === 'status') type = 'status';
  else if (field.id === 'description') type = 'text';
  return {
    id: field.id,
    label: field.label,
    kind: 'unavailable',
    type,
    writable: false,
  };
}

function authored(
  frontmatter: Readonly<Record<string, unknown>>,
  property: string,
): { state: 'absent' } | { state: 'unsupported' } | { state: 'value'; value: unknown } {
  const keys = Object.keys(frontmatter).filter((key) => sameProjectPropertyName(key, property));
  if (keys.length === 0) return { state: 'absent' };
  if (keys.length !== 1) return { state: 'unsupported' };
  return { state: 'value', value: frontmatter[keys[0] ?? ''] };
}
function compatible(type: string, value: unknown): value is ProjectFieldValueV1 {
  if (type === 'text') return typeof value === 'string';
  if (type === 'number') return finiteNumber(value);
  if (type === 'checkbox') return typeof value === 'boolean';
  if (type === 'list') return compatibleList(value);
  if (type === 'tags')
    return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
  if (type === 'date' || type === 'datetime') return compatibleDate(type, value);
  return false;
}
function compatibleDate(type: string, value: unknown): boolean {
  return typeof value === 'string' && (type === 'date' ? validDate(value) : validDatetime(value));
}
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function compatibleList(value: unknown): value is Array<string | number> {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
    )
  );
}
export function fieldCompatible(
  field: Pick<ProjectFieldCatalogItem, 'id' | 'type'>,
  value: unknown,
): value is ProjectFieldValueV1 {
  if (field.id === 'start' || field.id === 'end')
    return typeof value === 'string' && parseProjectDate(value) !== undefined;
  return field.type !== null && compatible(field.type, value);
}

export function fieldsFor(
  fields: readonly ProjectFieldCatalogItem[],
  frontmatter: Readonly<Record<string, unknown>>,
): ProjectDtoV1['fields'] {
  return fields.flatMap<ProjectDtoV1['fields'][number]>((field) => {
    if (field.property === undefined || field.id === 'status') return [];
    const item = authored(frontmatter, field.property);
    if (field.type === null || item.state === 'unsupported')
      return [{ fieldId: field.id, state: 'unsupported' as const }];
    if (item.state === 'absent') return [{ fieldId: field.id, state: 'absent' as const }];
    return fieldCompatible(field, item.value)
      ? [
          {
            fieldId: field.id,
            state: 'value' as const,
            value: Array.isArray(item.value)
              ? [...(item.value as ReadonlyArray<string | number>)]
              : item.value,
          },
        ]
      : [{ fieldId: field.id, state: 'unsupported' as const }];
  });
}
export function statusFor(
  settings: ProjectsSettings,
  frontmatter: Readonly<Record<string, unknown>>,
): ProjectStatusV1 {
  if (
    unsafeProperty(settings.statusProperty) ||
    resolveConfiguredProjectField(settings, 'status')?.type !== 'status'
  )
    return { state: 'unsupported' };
  const item = authored(frontmatter, settings.statusProperty);
  if (item.state !== 'value') return { state: item.state };
  if (typeof item.value !== 'string') return { state: 'unsupported' };
  if (item.value === '') return { state: 'absent' };
  const status = statusChoices(settings).find(({ name }) => name === item.value);
  if (
    status === undefined &&
    (settings.statuses as readonly unknown[]).some(
      (entry) =>
        entry !== null && typeof entry === 'object' && 'name' in entry && entry.name === item.value,
    )
  )
    return { state: 'unsupported' };
  return status === undefined
    ? { state: 'unrecognized', value: item.value }
    : { state: 'configured', id: status.id };
}
