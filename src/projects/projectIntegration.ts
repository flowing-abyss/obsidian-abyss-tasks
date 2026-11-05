import type {
  ProjectDtoV1,
  ProjectFieldValueV1,
  ProjectSchemaFieldV1,
  ProjectStatusV1,
} from '../../api';
import { noteNameOfPath } from '../markdown/noteName';
import { compileQuery, type CompiledQuery } from '../query/evaluateQuery';
import type { ProjectsSettings } from '../settings/types';
import type { ProjectSourceReadApi, TaskReadResult } from '../tasks';
import type { ProjectIntegrationReads, ProjectReadRecord, ProjectReadSummary } from './projectApi';
import { parseProjectDate, validDate, validDatetime } from './projectDateValue';
import { buildProjectFieldCatalog, type ProjectFieldCatalogItem } from './projectFields';
import {
  hasAuthoritativeProjectPropertyDefinitions,
  resolveConfiguredProjectField,
} from './projectPropertyDefinitions';
import { sameProjectPropertyName } from './projectPropertyNames';
import { compileProjectPropertyPresets } from './projectPropertyPresets';
import { computeStats } from './projectStats';

/** Configuration that affects disclosure, interpretation or a prospective write. */
export function projectSemantics(settings: ProjectsSettings): string {
  const {
    membershipQuery,
    createFolder,
    templatePath,
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  } = settings;
  return JSON.stringify({
    membershipQuery,
    createFolder,
    templatePath,
    schema: schemaFor(settings),
    bindings: catalog(settings)
      .filter((field) => field.type !== null && field.property !== undefined)
      .map(({ id, property }) => ({ id, property })),
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  });
}
function schemaFor(settings: ProjectsSettings): ReturnType<ProjectIntegrationReads['schema']> {
  const statuses = statusChoices(settings);
  const fields = catalog(settings);
  return {
    statuses,
    ...(fields.some((field) => field.id === 'status' && field.type === 'status') &&
    statuses.some(({ id }) => id === settings.defaultStatusId)
      ? { defaultStatusId: settings.defaultStatusId }
      : {}),
    fields: fields.map((field) => schemaField(field, settings)),
  };
}
function statusChoices(
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
function catalog(settings: ProjectsSettings): ProjectFieldCatalogItem[] {
  const fields = buildProjectFieldCatalog(settings, null)
    .filter((field) => !field.id.startsWith('property:'))
    .map((field) =>
      field.property !== undefined && unsafeProperty(field.property)
        ? {
            id: field.id,
            label: field.label,
            property: field.property,
            type: null,
          }
        : field,
    );
  if (hasAuthoritativeProjectPropertyDefinitions(settings)) {
    for (const id of definitionIds(settings)) {
      if (!id.startsWith('property:')) continue;
      const field = resolveConfiguredProjectField(settings, id);
      if (field !== undefined && field.type !== null) fields.push(field);
    }
  }
  return fields.filter(
    (field) =>
      !field.id.startsWith('property:') ||
      (!unsafeProperty(field.id.slice(9)) &&
        hasAuthoritativeProjectPropertyDefinitions(settings) &&
        definitionIds(settings).includes(field.id)),
  );
}
function definitionIds(settings: ProjectsSettings): string[] {
  const definitions: unknown = settings.propertyDefinitions;
  return definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions)
    ? Object.keys(definitions)
    : [];
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
function fieldCompatible(
  field: ProjectFieldCatalogItem,
  value: unknown,
): value is ProjectFieldValueV1 {
  if (field.id === 'start' || field.id === 'end')
    return typeof value === 'string' && parseProjectDate(value) !== undefined;
  return field.type !== null && compatible(field.type, value);
}

function fieldsFor(
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
function statusFor(
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
class ProjectReads implements ProjectIntegrationReads {
  private semanticKey = '';
  private semanticToken: object = {};
  private membershipKey: string | undefined;
  private membership: CompiledQuery = () => false;
  constructor(
    private readonly source: ProjectSourceReadApi,
    private readonly settings: () => ProjectsSettings,
  ) {}
  semantics(): object {
    const next = projectSemantics(this.settings());
    if (next !== this.semanticKey) {
      this.semanticKey = next;
      this.semanticToken = {};
    }
    return this.semanticToken;
  }
  coverage(): TaskReadResult<true> {
    return this.source.coverage();
  }
  paths(): readonly string[] {
    return this.source.paths();
  }
  private matches(
    path: string,
    tags: readonly string[],
    frontmatter: Readonly<Record<string, unknown>>,
  ): boolean {
    const query = this.settings().membershipQuery;
    if (query !== this.membershipKey) {
      this.membershipKey = query;
      this.membership = compileQuery(query);
    }
    return this.membership(path, tags, frontmatter);
  }
  private read(
    path: string,
    detail: boolean,
    captured?: object,
  ): TaskReadResult<ProjectReadRecord | ProjectReadSummary | undefined> {
    const result = this.source.get(path);
    if (result.type === 'error') return result;
    if (result.value === undefined)
      return { type: 'ok', value: undefined, observation: result.observation };
    const value = result.value,
      current = this.settings();
    const tags = [...new Set(value.metadata.tags.map((tag) => tag.toLowerCase()))];
    if (!this.matches(path, tags, value.metadata.frontmatter))
      return { type: 'ok', value: undefined, observation: result.observation };
    const summary: ProjectReadSummary = {
      path,
      name: noteNameOfPath(path),
      identity: value.identity,
      version: value.version,
      semantics: captured ?? this.semantics(),
      status: statusFor(current, value.metadata.frontmatter),
      stats: computeStats(value.roots, {
        closedMs: value.tracked.closedMs,
        openStartsMs: [...value.tracked.openStartsMs],
      }),
    };
    return {
      type: 'ok',
      value: detail
        ? { ...summary, tags, fields: fieldsFor(catalog(current), value.metadata.frontmatter) }
        : summary,
      observation: result.observation,
    };
  }
  schema(): ReturnType<ProjectIntegrationReads['schema']> {
    return schemaFor(this.settings());
  }
  summary(path: string, captured?: object): TaskReadResult<ProjectReadSummary | undefined> {
    return this.read(path, false, captured);
  }
  get(path: string): TaskReadResult<ProjectReadRecord | undefined> {
    return this.read(path, true) as TaskReadResult<ProjectReadRecord | undefined>;
  }
  matchesFile(proof: ProjectReadSummary, file: object): boolean {
    return proof.semantics === this.semantics() && this.source.matchesFile(proof, file);
  }
  guard(proof: ProjectReadSummary, live: string, candidate: string): TaskReadResult<true> {
    if (proof.semantics !== this.semantics()) return { type: 'error', reason: 'stale' };
    const current = this.read(proof.path, false);
    if (current.type === 'error') return current;
    if (current.value?.identity !== proof.identity || current.value.version !== proof.version)
      return { type: 'error', reason: 'stale' };
    const staged = this.source.candidate(proof, live, candidate);
    if (staged.type === 'error') return staged;
    return this.matches(
      proof.path,
      staged.value.tags.map((tag) => tag.toLowerCase()),
      staged.value.frontmatter,
    )
      ? { type: 'ok', value: true, observation: staged.observation }
      : { type: 'error', reason: 'unavailable' };
  }
}
export function createProjectIntegrationReads(
  source: ProjectSourceReadApi,
  settings: () => ProjectsSettings,
): ProjectIntegrationReads {
  return new ProjectReads(source, settings);
}
