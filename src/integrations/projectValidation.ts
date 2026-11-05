import type {
  ApiResultV1,
  CreateProjectTaskV1,
  CreateProjectV1,
  ListProjectsV1,
  MoveProjectTaskV1,
  ProjectFieldAssignmentV1,
  ProjectFieldValueV1,
  ResolveProjectV1,
  UpdateProjectV1,
} from '../../api';
import {
  boundedArray,
  integer,
  invalid,
  namespace,
  path,
  record,
  text,
  validated,
} from './validation';

export type ProjectOperation =
  'projects.create' | 'projects.update' | 'projects.createTask' | 'projects.moveTask';
export type ProjectMutationInput =
  CreateProjectV1 | UpdateProjectV1 | CreateProjectTaskV1 | MoveProjectTaskV1;
const MAX_INPUT = 65_536;

function line(value: unknown, max = 16_384): string {
  const result = text(value, max);
  return /[\r\n\0]/u.test(result) ? invalid() : result;
}
function scalar(value: unknown, account: (value: unknown) => void): { value: string | number } {
  if (typeof value === 'string') {
    const result = line(value);
    account(result);
    return { value: result };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid();
  account(value);
  return { value };
}
function fieldValue(
  value: unknown,
  account: (value: unknown) => void,
): { value: ProjectFieldValueV1 | null } {
  if (value === null || typeof value === 'boolean') {
    account(value);
    return { value };
  }
  if (Array.isArray(value))
    return { value: boundedArray(value, 256).map((item) => scalar(item, account).value) };
  return scalar(value, account);
}
function fields(value: unknown): readonly ProjectFieldAssignmentV1[] {
  const seen = new Set<string>();
  const result: ProjectFieldAssignmentV1[] = [];
  let bytes = 2;
  const account = (part: unknown): void => {
    bytes += new TextEncoder().encode(JSON.stringify(part)).length + 1;
    if (bytes > MAX_INPUT) invalid();
  };
  for (const entry of boundedArray(value, 64)) {
    const input = record(entry, ['fieldId', 'value']);
    const fieldId = line(input['fieldId'], 512);
    const folded = fieldId.toLowerCase();
    const key = folded.startsWith('property:') ? folded.slice(9) : folded;
    if (
      (!['start', 'end', 'description'].includes(folded) &&
        (!folded.startsWith('property:') || key.length === 0)) ||
      seen.has(folded) ||
      ['__proto__', 'prototype', 'constructor', 'status'].includes(key)
    )
      return invalid();
    seen.add(folded);
    account(fieldId);
    bytes += 24;
    const assignment = { fieldId, value: fieldValue(input['value'], account).value };
    result.push(assignment);
  }
  return result.sort((a, b) => a.fieldId.localeCompare(b.fieldId, 'en'));
}
export function validateProjectList(value: unknown): ApiResultV1<ListProjectsV1> {
  return validated(() => {
    const input = record(value === undefined ? {} : value, ['limit', 'cursor']);
    return {
      ...(input['limit'] === undefined ? {} : { limit: integer(input['limit'], 1, 500) }),
      ...(input['cursor'] === undefined ? {} : { cursor: text(input['cursor'], 512) }),
    };
  });
}
export function validateProjectResolve(value: unknown): ApiResultV1<ResolveProjectV1> {
  return validated(() => {
    const result = path(record(value, ['path'])['path']);
    if (/[\r\n]/u.test(result) || !result.endsWith('.md')) return invalid();
    return { path: result };
  });
}
const MUTATION_KEYS: Record<ProjectOperation, readonly string[]> = {
  'projects.create': ['name', 'statusId', 'fields'],
  'projects.update': ['target', 'expectedRevision', 'statusId', 'fields'],
  'projects.createTask': ['target', 'expectedRevision', 'title'],
  'projects.moveTask': ['target', 'expectedRevision', 'taskTarget', 'expectedTaskRevision'],
};
function projectChanges(
  input: Record<string, unknown>,
): Pick<CreateProjectV1, 'statusId' | 'fields'> {
  const status = input['statusId'];
  return {
    ...(status === undefined ? {} : { statusId: status === null ? null : line(status, 512) }),
    ...(input['fields'] === undefined ? {} : { fields: fields(input['fields']) }),
  };
}
function requiredLine(value: unknown): string {
  const result = line(value);
  return result.trim().length === 0 ? invalid() : result;
}
function parseMutation(method: ProjectOperation, value: unknown): ProjectMutationInput {
  const input = record(value, ['requestId', 'expiresAt', ...MUTATION_KEYS[method]]);
  const base = { requestId: namespace(input['requestId']), expiresAt: integer(input['expiresAt']) };
  if (method === 'projects.create')
    return { ...base, name: requiredLine(input['name']), ...projectChanges(input) };
  const target = {
    target: text(input['target'], 512),
    expectedRevision: text(input['expectedRevision'], 512),
  };
  if (method === 'projects.update') {
    if (input['statusId'] === undefined && input['fields'] === undefined) return invalid();
    return { ...base, ...target, ...projectChanges(input) };
  }
  if (method === 'projects.createTask')
    return { ...base, ...target, title: requiredLine(input['title']) };
  return {
    ...base,
    ...target,
    taskTarget: text(input['taskTarget'], 512),
    expectedTaskRevision: text(input['expectedTaskRevision'], 512),
  };
}
export function validateProjectMutation(
  method: ProjectOperation,
  value: unknown,
): ApiResultV1<ProjectMutationInput> {
  return validated(() => {
    const result = parseMutation(method, value);
    if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_INPUT) return invalid();
    return result;
  });
}
