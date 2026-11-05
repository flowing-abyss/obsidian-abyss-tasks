import type {
  ProjectDtoV1,
  ProjectFieldValueV1,
  ProjectSchemaFieldV1,
  ProjectStatusV1,
} from '../../api';
import { noteNameOfPath } from '../markdown/noteName';
import { evaluateQuery } from '../query/evaluateQuery';
import type { ProjectsSettings } from '../settings/types';
import type { ProjectSourceReadApi, TaskReadResult, TaskSnapshot, TrackedTotal } from '../tasks';
import type { ProjectIntegrationReads, ProjectReadRecord, ProjectReadSummary } from './projectApi';
import { parseProjectDate } from './projectDateValue';
import { buildProjectFieldCatalog, type ProjectFieldCatalogItem } from './projectFields';
import {
  hasAuthoritativeProjectPropertyDefinitions,
  resolveConfiguredProjectField,
} from './projectPropertyDefinitions';
import { compileProjectPropertyPresets } from './projectPropertyPresets';
import type { ProjectStats } from './types';

export function computeStats(tasks: readonly TaskSnapshot[], tracked: TrackedTotal): ProjectStats {
  let done = 0,
    cancelled = 0,
    inProgress = 0;
  for (const task of tasks) {
    if (task.status === 'done') done++;
    else if (task.status === 'cancelled') cancelled++;
    else if (task.status === 'in-progress') inProgress++;
  }
  return { total: tasks.length, done, cancelled, inProgress, tracked };
}

/** Configuration that affects disclosure, interpretation or a prospective write. */
export function projectSemantics(settings: ProjectsSettings): string {
  const {
    membershipQuery,
    createFolder,
    templatePath,
    statusProperty,
    startProperty,
    endProperty,
    propertyDefinitions,
    propertyDefinitionsVersion,
    statuses,
    defaultStatusId,
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  } = settings;
  return JSON.stringify({
    membershipQuery,
    createFolder,
    templatePath,
    statusProperty,
    startProperty,
    endProperty,
    propertyDefinitions,
    propertyDefinitionsVersion,
    statuses: statuses.map(({ id, name, displayName }) => ({ id, name, displayName })),
    defaultStatusId,
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  });
}
function catalog(settings: ProjectsSettings): ProjectFieldCatalogItem[] {
  const fields = buildProjectFieldCatalog(settings, null);
  return fields.filter(
    (field) =>
      !field.id.startsWith('property:') ||
      (!['__proto__', 'constructor', 'prototype'].includes(field.id.slice(9).toLocaleLowerCase()) &&
        hasAuthoritativeProjectPropertyDefinitions(settings) &&
        Object.keys(settings.propertyDefinitions).includes(field.id)),
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
  const presets = compileProjectPropertyPresets(settings.propertyDefinitions[field.id]).presets;
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
            value:
              field.type === 'list' || field.type === 'tags'
                ? [value as string | number]
                : (value as string | number),
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
  const keys = Object.keys(frontmatter).filter(
    (key) => key.toLocaleLowerCase() === property.toLocaleLowerCase(),
  );
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
  if (type === 'date' || type === 'datetime') return parseProjectDate(value)?.kind === type;
  return false;
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
    return compatible(field.type, item.value)
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
  if (resolveConfiguredProjectField(settings, 'status')?.type !== 'status')
    return { state: 'unsupported' };
  const item = authored(frontmatter, settings.statusProperty);
  if (item.state !== 'value') return { state: item.state };
  if (typeof item.value !== 'string') return { state: 'unsupported' };
  if (item.value === '') return { state: 'absent' };
  const matches = settings.statuses.filter(({ name }) => name === item.value);
  if (matches.length > 1) return { state: 'unsupported' };
  const status = matches[0];
  return status === undefined
    ? { state: 'unrecognized', value: item.value }
    : { state: 'configured', id: status.id };
}
class ProjectReads implements ProjectIntegrationReads {
  private semanticKey = '';
  private semanticToken: object = {};
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
    if (!evaluateQuery(current.membershipQuery, path, tags, value.metadata.frontmatter))
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
    const current = this.settings();
    return {
      statuses: current.statuses.map(({ id, name, displayName }) => ({
        id,
        name,
        ...(displayName === undefined || displayName === name ? {} : { displayName }),
      })),
      ...(current.statuses.some(({ id }) => id === current.defaultStatusId)
        ? { defaultStatusId: current.defaultStatusId }
        : {}),
      fields: catalog(current).map((field) => schemaField(field, current)),
    };
  }
  summary(path: string, captured?: object): TaskReadResult<ProjectReadSummary | undefined> {
    return this.read(path, false, captured);
  }
  get(path: string): TaskReadResult<ProjectReadRecord | undefined> {
    return this.read(path, true) as TaskReadResult<ProjectReadRecord | undefined>;
  }
  guard(proof: ProjectReadSummary, live: string, candidate: string): TaskReadResult<true> {
    if (proof.semantics !== this.semantics()) return { type: 'error', reason: 'stale' };
    const current = this.read(proof.path, false);
    if (current.type === 'error') return current;
    if (current.value?.identity !== proof.identity || current.value.version !== proof.version)
      return { type: 'error', reason: 'stale' };
    const staged = this.source.candidate(proof, live, candidate);
    if (staged.type === 'error') return staged;
    return evaluateQuery(
      this.settings().membershipQuery,
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
