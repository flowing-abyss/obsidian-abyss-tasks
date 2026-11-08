import type {
  ApiResultV1,
  ApplyTaskContentV1,
  ContentLimitsV1,
  ListTaskTagsV1,
  PrepareTaskContentV1,
  ReadTaskTreeV1,
  SearchTasksV1,
  TaskContentOperationV1,
  TaskCreateDestinationV1,
  TaskCreateTreeV1,
  TaskInsertionV1,
  TaskPatchV1,
} from '../../api';
import {
  durationMinutes,
  localDate,
  localTime,
  normalizeTaskTagInput,
  type TaskPatch,
} from '../tasks';
import {
  boundedArray,
  integer,
  invalid,
  namespace,
  path,
  record,
  text,
  validated,
  validateList,
} from './validation';
export const CONTENT_LIMITS: ContentLimitsV1 = {
  maxVersionsPerClient: 128,
  maxVersionsPerProvider: 16384,
  maxSnapshotAccountingBytesPerClient: 8 * 1024 * 1024,
  familyTtlMs: 300000,
  maxPreparationInputBytes: 1024 * 1024,
  maxIssuedTaskHandlesPerVersionSide: 50000,
  maxEntryHandlesPerReader: 50000,
  entryHandleTtlMs: 60000,
  maxPageEntries: 500,
};
function optional<T>(
  input: Record<string, unknown>,
  key: string,
  parse: (v: unknown) => T,
): { [key: string]: T } {
  return input[key] === undefined ? {} : { [key]: parse(input[key]) };
}
function scalar(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}
function array(value: unknown, max = 500): unknown[] {
  if (Array.isArray(value) && value.length === 0) {
    if (Reflect.ownKeys(value).length !== 1) return invalid();
    return [];
  }
  return boundedArray(value, max);
}
function field(value: unknown, parse: (value: unknown) => unknown): unknown {
  const r = record(value, ['type', 'value']);
  if (r['type'] === 'clear' && r['value'] === undefined) return { type: 'clear' };
  if (r['type'] !== 'set') return invalid();
  return { type: 'set', value: parse(r['value']) };
}
function patchScalar(key: string, value: unknown): string {
  if (['due', 'scheduled', 'start'].includes(key)) return localDate(text(value, 10));
  if (key === 'time') return localTime(text(value, 5));
  if (
    key === 'priority' &&
    (typeof value !== 'string' || !['A', 'B', 'C', 'D', 'E', 'F'].includes(value))
  )
    return invalid();
  if (key === 'onCompletion' && value !== 'keep' && value !== 'delete') return invalid();
  return scalar(value);
}
function parseContentPatch(value: unknown): TaskPatchV1 {
  const keys = [
    'markdownTitle',
    'priority',
    'due',
    'scheduled',
    'start',
    'time',
    'durationMinutes',
    'recurrence',
    'onCompletion',
    'tags',
  ];
  const r = record(value, keys),
    out: Record<string, unknown> = {};
  for (const key of keys) {
    if (r[key] === undefined) continue;
    if (key === 'tags') {
      const t = record(r[key], ['add', 'remove']);
      out[key] = {
        ...optional(t, 'add', (v) =>
          array(v).map((tag) => {
            const tags = normalizeTaskTagInput(text(tag, 512));
            return tags?.length === 1 ? tags[0] : invalid();
          }),
        ),
        ...optional(t, 'remove', (v) =>
          array(v).map((tag) => {
            const tags = normalizeTaskTagInput(text(tag, 512));
            return tags?.length === 1 ? tags[0] : invalid();
          }),
        ),
      };
      continue;
    }
    out[key] =
      key === 'durationMinutes'
        ? field(r[key], (v) => durationMinutes(integer(v, 1)))
        : field(r[key], (v) => patchScalar(key, v));
  }
  return out;
}
export function nativePatch(value: TaskPatchV1): TaskPatch {
  const parsed = parseContentPatch(value);
  const { durationMinutes: duration, ...rest } = parsed;
  // Branded dates and durations have already passed the domain constructors above.
  return { ...rest, ...(duration === undefined ? {} : { duration }) } as TaskPatch;
}
function sourceOperation(value: unknown): TaskContentOperationV1 {
  const r = record(value, ['type', 'target', 'source', 'expectedSourceRevision', 'symbol']);
  const target = text(r['target'], 512);
  switch (r['type']) {
    case 'copy-comment':
      record(value, ['type', 'target', 'source']);
      return { type: 'copy-comment', target, source: text(r['source'], 512) };
    case 'copy-subtree':
    case 'assess-merge':
      record(value, ['type', 'target', 'source', 'expectedSourceRevision']);
      return {
        type: r['type'],
        target,
        source: text(r['source'], 512),
        expectedSourceRevision: text(r['expectedSourceRevision'], 512),
      };
    case 'set-initial-status':
      record(value, ['type', 'target', 'symbol']);
      return { type: 'set-initial-status', target, symbol: text(r['symbol'], 1) };
    default:
      return invalid();
  }
}
function reorderOperation(
  value: unknown,
  r: Record<string, unknown>,
  target: string,
): TaskContentOperationV1 {
  record(value, ['type', 'target', 'relativeTo', 'placement']);
  if (r['placement'] !== 'before' && r['placement'] !== 'after') return invalid();
  return {
    type: 'reorder',
    target,
    relativeTo: text(r['relativeTo'], 512),
    placement: r['placement'],
  };
}
function operation(value: unknown): TaskContentOperationV1 {
  const r = record(value, [
    'type',
    'target',
    'patch',
    'text',
    'markdownTitle',
    'symbol',
    'source',
    'expectedSourceRevision',
    'relativeTo',
    'placement',
  ]);
  const target = text(r['target'], 512);
  switch (r['type']) {
    case 'reorder':
      return reorderOperation(value, r, target);
    case 'patch':
      record(value, ['type', 'target', 'patch']);
      return { type: 'patch', target, patch: parseContentPatch(r['patch']) };
    case 'description':
      record(value, ['type', 'target', 'text']);
      return { type: 'description', target, text: r['text'] === null ? null : scalar(r['text']) };
    case 'add-child':
      record(value, ['type', 'target', 'markdownTitle']);
      return { type: 'add-child', target, markdownTitle: text(r['markdownTitle'], 16384) };
    case 'remove':
    case 'remove-comment':
      record(value, ['type', 'target']);
      return { type: r['type'], target };
    case 'add-comment':
    case 'update-comment':
      record(value, ['type', 'target', 'text']);
      return { type: r['type'], target, text: scalar(r['text']) };
    default:
      return sourceOperation(value);
  }
}
function tree(value: unknown, remaining: { nodes: number }): TaskCreateTreeV1 {
  if (--remaining.nodes < 0) return invalid();
  const r = record(value, ['markdownTitle', 'initial', 'description', 'comments', 'children']);
  let initial: TaskCreateTreeV1['initial'];
  if (r['initial'] !== undefined) {
    const i = record(r['initial'], [
      'statusSymbol',
      'priority',
      'due',
      'scheduled',
      'start',
      'time',
      'durationMinutes',
      'recurrence',
      'onCompletion',
      'tags',
    ]);
    const { statusSymbol, ...patch } = i;
    initial = {
      ...parseContentPatch(patch),
      ...(statusSymbol === undefined ? {} : { statusSymbol: text(statusSymbol, 1) }),
    };
  }
  return {
    markdownTitle: text(r['markdownTitle'], 16384),
    ...(initial === undefined ? {} : { initial }),
    ...optional(r, 'description', scalar),
    ...optional(r, 'comments', (v) =>
      array(v).map((c) => {
        const x = record(c, ['text']);
        return { text: scalar(x['text']) };
      }),
    ),
    ...optional(r, 'children', (v) => array(v).map((c) => tree(c, remaining))),
  };
}
function insertion(value: unknown): TaskInsertionV1 {
  const r = record(value, ['type', 'heading', 'position']);
  if (r['type'] === 'append' || r['type'] === 'prepend') {
    record(value, ['type']);
    return { type: r['type'] };
  }
  if (r['type'] !== 'section') return invalid();
  if (r['position'] !== undefined && r['position'] !== 'top' && r['position'] !== 'bottom')
    return invalid();
  return {
    type: 'section',
    heading: text(r['heading'], 4096),
    ...(r['position'] === undefined ? {} : { position: r['position'] }),
  };
}
function destination(value: unknown): TaskCreateDestinationV1 {
  const r = record(value, ['type', 'path', 'insertion', 'provision', 'target', 'expectedRevision']);
  if (r['type'] === 'configured-default') {
    record(value, ['type']);
    return { type: 'configured-default' };
  }
  if (r['type'] === 'project') {
    record(value, ['type', 'target', 'expectedRevision']);
    return {
      type: 'project',
      target: text(r['target'], 512),
      expectedRevision: text(r['expectedRevision'], 512),
    };
  }
  if (r['type'] !== 'note') return invalid();
  record(value, ['type', 'path', 'insertion', 'provision']);
  if (r['provision'] !== undefined && r['provision'] !== 'if-missing') return invalid();
  return {
    type: 'note',
    path: path(r['path']),
    insertion: insertion(r['insertion']),
    ...(r['provision'] === undefined ? {} : { provision: 'if-missing' }),
  };
}
function prepare(value: unknown): PrepareTaskContentV1 {
  const r = record(value, [
    'kind',
    'target',
    'expectedRevision',
    'operation',
    'destination',
    'tree',
    'plan',
    'expectedPlanRevision',
    'afterRequestId',
  ]);
  if (r['kind'] === 'hierarchy') {
    record(value, ['kind', 'operation']);
    const op = record(r['operation'], [
      'type',
      'source',
      'expectedSourceRevision',
      'parent',
      'expectedParentRevision',
    ]);
    const source = text(op['source'], 512),
      expectedSourceRevision = text(op['expectedSourceRevision'], 512);
    if (op['type'] === 'reparent')
      return {
        kind: 'hierarchy',
        operation: {
          type: 'reparent',
          source,
          expectedSourceRevision,
          parent: text(op['parent'], 512),
          expectedParentRevision: text(op['expectedParentRevision'], 512),
        },
      };
    record(r['operation'], ['type', 'source', 'expectedSourceRevision']);
    if (op['type'] !== 'promote') return invalid();
    return { kind: 'hierarchy', operation: { type: 'promote', source, expectedSourceRevision } };
  }
  if (r['kind'] === 'edit') {
    record(value, ['kind', 'target', 'expectedRevision', 'operation']);
    return {
      kind: 'edit',
      target: text(r['target'], 512),
      expectedRevision: text(r['expectedRevision'], 512),
      ...optional(r, 'operation', operation),
    };
  }
  if (r['kind'] === 'create') {
    record(value, ['kind', 'destination', 'tree']);
    return {
      kind: 'create',
      destination: destination(r['destination']),
      tree: tree(r['tree'], { nodes: 500 }),
    };
  }
  if (r['kind'] === 'append') {
    record(value, ['kind', 'plan', 'expectedPlanRevision', 'operation']);
    return {
      kind: 'append',
      plan: text(r['plan'], 512),
      expectedPlanRevision: text(r['expectedPlanRevision'], 512),
      operation: operation(r['operation']),
    };
  }
  if (r['kind'] !== 'refresh') return invalid();
  record(value, ['kind', 'plan', 'expectedPlanRevision', 'afterRequestId']);
  return {
    kind: 'refresh',
    plan: text(r['plan'], 512),
    expectedPlanRevision: text(r['expectedPlanRevision'], 512),
    ...optional(r, 'afterRequestId', namespace),
  };
}
export function validateContentPrepare(value: unknown): ApiResultV1<PrepareTaskContentV1> {
  return validated(() => {
    const parsed = prepare(value);
    if (
      new TextEncoder().encode(JSON.stringify(parsed)).length >
      CONTENT_LIMITS.maxPreparationInputBytes
    )
      return invalid();
    return parsed;
  });
}
export function validateContentApply(value: unknown): ApiResultV1<ApplyTaskContentV1> {
  return validated<ApplyTaskContentV1>(() => {
    const r = record(value, ['plan', 'expectedPlanRevision', 'requestId', 'expiresAt']);
    return {
      plan: text(r['plan'], 512),
      expectedPlanRevision: text(r['expectedPlanRevision'], 512),
      requestId: namespace(r['requestId']),
      expiresAt: integer(r['expiresAt']),
    };
  });
}
export function validateTreeRead(value: unknown): ApiResultV1<ReadTaskTreeV1> {
  return validated<ReadTaskTreeV1>(() => {
    const r = record(value, [
      'target',
      'expectedRevision',
      'plan',
      'expectedPlanRevision',
      'side',
      'limit',
      'cursor',
    ]);
    if ((r['plan'] === undefined) !== (r['expectedPlanRevision'] === undefined)) return invalid();
    if (
      r['side'] !== undefined &&
      (r['plan'] === undefined || (r['side'] !== 'before' && r['side'] !== 'after'))
    )
      return invalid();
    return {
      target: text(r['target'], 512),
      ...optional(r, 'expectedRevision', (v) => text(v, 512)),
      ...optional(r, 'plan', (v) => text(v, 512)),
      ...optional(r, 'expectedPlanRevision', (v) => text(v, 512)),
      ...optional(r, 'side', (v) => v as 'before' | 'after'),
      ...optional(r, 'limit', (v) => integer(v, 1, 500)),
      ...optional(r, 'cursor', (v) => text(v, 512)),
    };
  });
}
function validChoice(value: unknown, choices: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && choices.includes(value));
}
export function validateSearch(value: unknown): ApiResultV1<SearchTasksV1> {
  return validated<SearchTasksV1>(() => {
    const r = record(value, [
      'query',
      'fields',
      'matchScope',
      'path',
      'folder',
      'statuses',
      'tagsAll',
      'dates',
      'limit',
      'cursor',
    ]);
    const { query, fields, matchScope, ...filters } = r;
    const parsed = validateList(filters);
    if (!parsed.ok) return invalid();
    if (
      !validChoice(fields, ['title', 'body', 'all']) ||
      !validChoice(matchScope, ['node', 'subtree'])
    )
      return invalid();
    return {
      ...parsed.value,
      query: typeof query === 'string' && query.length <= 4096 ? query : invalid(),
      ...(fields === undefined ? {} : { fields: fields as NonNullable<SearchTasksV1['fields']> }),
      ...(matchScope === undefined
        ? {}
        : { matchScope: matchScope as NonNullable<SearchTasksV1['matchScope']> }),
    };
  });
}
export function validateTags(value: unknown): ApiResultV1<ListTaskTagsV1> {
  return validated<ListTaskTagsV1>(() => {
    const r = record(value ?? {}, ['path', 'folder', 'prefix', 'limit', 'cursor']);
    const { prefix, ...filters } = r;
    const parsed = validateList(filters);
    if (!parsed.ok) return invalid();
    return { ...parsed.value, ...(prefix === undefined ? {} : { prefix: scalar(prefix) }) };
  });
}
