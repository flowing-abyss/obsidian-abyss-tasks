export type CommandReferenceKind =
  't' | 'p' | 'n' | 'd' | 'nd' | 'c' | 's' | 'r' | 'u' | 'pd' | 'e';
type Fields = { readonly [key: string]: ReferenceShape };
export type ReferenceShape =
  CommandReferenceKind | Fields | ((value: Record<string, unknown>) => Fields);
const taskBasis: Fields = {
  target: 't',
  revision: 'r',
  expectedRevision: 'r',
  plan: 'd',
  expectedPlanRevision: 'r',
};
const noteBasis: Fields = {
  target: 'n',
  expectedRevision: 'r',
  plan: 'nd',
  expectedPlanRevision: 'r',
};
const noteLink: Fields = { from: 'n', expectedFromRevision: 'r' };
const noteSelector: Fields = { target: 'n', expectedRevision: 'r', section: 's', link: noteLink };
function operation(value: Record<string, unknown>): Fields {
  return {
    target: value['type'] === 'update-comment' || value['type'] === 'remove-comment' ? 'c' : 't',
    source: value['type'] === 'copy-comment' ? 'c' : 't',
    relativeTo: 't',
    parent: 't',
    expectedSourceRevision: 'r',
    expectedParentRevision: 'r',
  };
}
function task(value: Record<string, unknown>): Fields {
  if (value['kind'] === 'create') return { destination: { target: 'p', expectedRevision: 'r' } };
  return { ...taskBasis, operation, operations: operation };
}
function read(value: Record<string, unknown>): Fields {
  if (value['kind'] === 'note') return { selector: noteSelector, linkFor: noteLink, cursor: 'u' };
  return { ...taskBasis, target: value['kind'] === 'project' ? 'p' : 't', cursor: 'u' };
}
function selection(value: Record<string, unknown>): Fields {
  if (value['kind'] === 'task') return taskBasis;
  return { target: value['kind'] === 'project' ? 'p' : 'n', revision: 'r' };
}
export const commandReferenceInputs: Readonly<Record<string, ReferenceShape>> = {
  task: { input: task },
  read: { input: read },
  status: taskBasis,
  note: {
    input: {
      ...noteBasis,
      template: 'n',
      expectedTemplateRevision: 'r',
      operation: { section: 's' },
    },
  },
  project: {
    target: 'p',
    expectedRevision: 'r',
    taskTarget: 't',
    expectedTaskRevision: 'r',
    proposal: 'pd',
  },
  link: {
    target: 't',
    expectedRevision: 'r',
    taskPlan: 'd',
    taskRevision: 'r',
    notePlan: 'nd',
    comment: 'c',
  },
  cleanup: { destinationPlan: 'd', destinationRevision: 'r' },
  finish: { selection, reveal: { target: 't', revision: 'r' } },
};
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function mapReferenceShape(
  value: unknown,
  shape: ReferenceShape,
  map: (kind: CommandReferenceKind, value: string) => string,
): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) => mapReferenceShape(item, shape, map));
  if (typeof shape === 'string') return typeof value === 'string' ? map(shape, value) : value;
  const input = record(value);
  if (input === undefined) return value;
  const fields = typeof shape === 'function' ? shape(input) : shape;
  const result = { ...input };
  for (const [key, child] of Object.entries(fields))
    if (key in input) result[key] = mapReferenceShape(input[key], child, map);
  return result;
}
const outputFields: Readonly<Record<string, CommandReferenceKind>> = {
  parentTarget: 't',
  ownerTarget: 't',
  taskTarget: 't',
  relativeTo: 't',
  parent: 't',
  destinationParent: 't',
  projectTarget: 'p',
  notePlan: 'nd',
  taskPlan: 'd',
  destinationPlan: 'd',
  section: 's',
  comment: 'c',
  revision: 'r',
  expectedRevision: 'r',
  expectedPlanRevision: 'r',
  expectedSourceRevision: 'r',
  expectedParentRevision: 'r',
  expectedTaskRevision: 'r',
  expectedTemplateRevision: 'r',
  expectedFromRevision: 'r',
  projectRevision: 'r',
  taskRevision: 'r',
  destinationRevision: 'r',
  planRevision: 'r',
  cursor: 'u',
  nextCursor: 'u',
  proposal: 'pd',
};
function entityKind(
  value: Record<string, unknown>,
  parent: string,
): CommandReferenceKind | undefined {
  if ('expiresAt' in value && 'after' in value) return 'path' in value ? 'nd' : 'd';
  if ('canReplace' in value) return 's';
  if ('markdownTitle' in value) return 't';
  if ('aliases' in value) return 'n';
  if ('stats' in value) return 'p';
  return secondaryKind(value, parent);
}
function secondaryKind(
  value: Record<string, unknown>,
  parent: string,
): CommandReferenceKind | undefined {
  if ('parentTarget' in value) return 'text' in value ? 'c' : 'e';
  const kinds: Readonly<Record<string, CommandReferenceKind>> = {
    task: 't',
    tree: 't',
    child: 't',
    project: 'p',
    note: 'n',
    comment: 'c',
    'time-entry': 'e',
  };
  if (typeof value['kind'] === 'string' && kinds[value['kind']] !== undefined)
    return kinds[value['kind']];
  const parents: Readonly<Record<string, CommandReferenceKind>> = {
    note: 'n',
    selector: 'n',
    sourceRoot: 't',
    editBasis: 't',
    project: 'p',
  };
  return parents[parent];
}
export function outputReferenceKind(
  key: string,
  value: Record<string, unknown>,
  parent: string,
): CommandReferenceKind | undefined {
  if (key === 'target') return entityKind(value, parent);
  if (key === 'plan') return value['kind'] === 'refine' ? 'nd' : 'd';
  if (key === 'id' && value['kind'] === 'project-create') return 'pd';
  return copiedReferenceKind(key, value, parent) ?? outputFields[key];
}
function copiedReferenceKind(
  key: string,
  value: Record<string, unknown>,
  parent: string,
): CommandReferenceKind | undefined {
  if (key === 'from' && 'expectedFromRevision' in value) return 'n';
  if (key === 'sourceTarget' || key === 'destinationTarget')
    return parent === 'comments' ? 'c' : 't';
  if (key === 'source')
    return value['type'] === 'comment' || value['type'] === 'copy-comment' ? 'c' : 't';
  return undefined;
}
