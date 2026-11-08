import type { ProjectDtoV1, ProjectFieldAssignmentV1, ProjectSchemaV1 } from '../../api';
import { parseProjectDate } from '../projects/projectDateValue';
import { fieldCompatible } from '../projects/projectMetadataPolicy';
import { CommandFailure } from './commandTypes';

export function validateCommandProject(
  schema: ProjectSchemaV1,
  input: {
    readonly name?: string;
    readonly fields?: readonly ProjectFieldAssignmentV1[];
    readonly statusId?: string | null;
  },
  before?: ProjectDtoV1,
): void {
  if (input.name !== undefined && (input.name.trim().length === 0 || /[\r\n\0]/u.test(input.name)))
    throw new CommandFailure('PROJECT_VALUE', 'Use a nonempty, single-line project name.');
  validateStatus(schema, input.statusId);
  const seen = new Set<string>();
  const fields = new Map(
    (before?.fields ?? []).flatMap((f) =>
      f.state === 'value' ? [[f.fieldId, f.value] as const] : [],
    ),
  );
  for (const assignment of input.fields ?? []) {
    validateField(schema, assignment, seen);
    if (assignment.value === null) fields.delete(assignment.fieldId);
    else fields.set(assignment.fieldId, assignment.value);
  }
  validateRange(fields.get('start'), fields.get('end'));
}
function validateStatus(schema: ProjectSchemaV1, statusId: string | null | undefined): void {
  if (statusId === undefined) return;
  if (
    !schema.fields.some((f) => f.kind === 'status' && f.writable) ||
    (statusId !== null && !schema.statuses.some((s) => s.id === statusId))
  )
    throw new CommandFailure('PROJECT_VALUE', 'Choose a writable configured project status.');
}
function validateField(
  schema: ProjectSchemaV1,
  assignment: ProjectFieldAssignmentV1,
  seen: Set<string>,
): void {
  const field = schema.fields.find((f) => f.id === assignment.fieldId);
  if (
    seen.has(assignment.fieldId) ||
    field?.kind !== 'field' ||
    !field.writable ||
    (assignment.value !== null && !fieldCompatible(field, assignment.value))
  )
    throw new CommandFailure(
      'PROJECT_VALUE',
      `Use a valid value for writable project field ${assignment.fieldId}.`,
    );
  seen.add(assignment.fieldId);
}
function validateRange(startValue: unknown, endValue: unknown): void {
  const start = parseProjectDate(startValue),
    end = parseProjectDate(endValue);
  if (start !== undefined && end !== undefined && start.value.getTime() > end.value.getTime())
    throw new CommandFailure('PROJECT_VALUE', 'End date must be on or after start date.');
}
export function sameCommandProjectSchema(
  before: ProjectSchemaV1,
  current: ProjectSchemaV1,
): boolean {
  return (
    before.providerEpoch === current.providerEpoch &&
    before.scopeRevision === current.scopeRevision &&
    before.semanticsRevision === current.semanticsRevision &&
    JSON.stringify([before.fields, before.statuses, before.defaultStatusId]) ===
      JSON.stringify([current.fields, current.statuses, current.defaultStatusId])
  );
}
