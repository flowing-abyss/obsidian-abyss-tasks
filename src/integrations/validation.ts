import type {
  ApiAbortSignalV1,
  ApiResultV1,
  DateFilterV1,
  ListTasksV1,
  ReadOptionsV1,
  SetTaskStatusV1,
  StatusMutationV1,
  TaskSelectorV1,
  TaskStatusV1,
} from '../../api';
import { localDate, normalizeTaskTagInput, sameTag } from '../tasks';
import { apiError, freezeValue } from './values';

type RecordValue = Record<string, unknown>;
const STATUSES: readonly TaskStatusV1[] = ['open', 'in-progress', 'done', 'cancelled'];
const DATE_FIELDS: ReadonlyArray<DateFilterV1['field']> = [
  'created',
  'start',
  'scheduled',
  'due',
  'completion',
  'cancelled',
];

function invalid(): never {
  throw new Error('invalid-api-argument');
}

/** Accept Object.prototype and null records, without invoking caller-owned accessors. */
function record(value: unknown, allowed: readonly string[]): RecordValue {
  if (value === null || typeof value !== 'object') return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const result = Object.create(null) as RecordValue;
  for (const key of Reflect.ownKeys(value)) {
    copyProperty(result, key, dataProperty(value, key), allowed);
  }
  return result;
}

function copyProperty(
  result: RecordValue,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  allowed: readonly string[],
): void {
  if (typeof key !== 'string') return invalid();
  if (descriptor.enumerable === true && !allowed.includes(key)) return invalid();
  if (allowed.includes(key) && descriptor.value !== undefined) result[key] = descriptor.value;
}

function dataProperty(value: object, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return invalid();
  return descriptor;
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) return invalid();
  const length = integer(dataProperty(value, 'length').value, 1, maximum);
  return recordArray(value, length);
}

function recordArray(value: unknown[], length: number): unknown[] {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) return invalid();
    result.push(dataProperty(value, key).value);
  }
  return result;
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : invalid();
}

function namespace(value: unknown): string {
  const result = text(value, 128);
  return /^[A-Za-z0-9._:-]+$/u.test(result) ? result : invalid();
}

function path(value: unknown, folder = false): string {
  if (folder && value === '') return '';
  const result = text(value, 4096);
  if (/[\\\0]/u.test(result)) return invalid();
  if (result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    return invalid();
  return result;
}

function integer(
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalid();
}

function parseStatuses(value: unknown): readonly TaskStatusV1[] {
  const result: TaskStatusV1[] = [];
  for (const item of boundedArray(value, 4)) {
    const status = STATUSES.find((candidate) => candidate === item);
    if (status === undefined || result.includes(status)) return invalid();
    result.push(status);
  }
  return result;
}

function parseTags(value: unknown): readonly string[] {
  const result: string[] = [];
  for (const item of boundedArray(value, 20)) {
    if (typeof item !== 'string' || !item.startsWith('#')) return invalid();
    const tags = normalizeTaskTagInput(item);
    if (tags?.length !== 1 || tags[0] !== item) return invalid();
    const normalized = item.toLowerCase();
    if (!result.some((tag) => sameTag(tag, normalized))) result.push(normalized);
  }
  return result;
}

function civilDate(value: unknown): string {
  return localDate(text(value, 10));
}

function optionalDate(value: unknown): string | undefined {
  return value === undefined ? undefined : civilDate(value);
}

function dateFilter(value: unknown): DateFilterV1 {
  const input = record(value, ['field', 'from', 'to']);
  const field = DATE_FIELDS.find((candidate) => candidate === input['field']);
  if (field === undefined || (input['from'] === undefined && input['to'] === undefined))
    return invalid();
  const from = optionalDate(input['from']);
  const to = optionalDate(input['to']);
  if (from !== undefined && to !== undefined && from > to) return invalid();
  return { field, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

function parseDates(value: unknown): readonly DateFilterV1[] {
  const result = boundedArray(value, 6).map(dateFilter);
  if (new Set(result.map((item) => item.field)).size !== result.length) return invalid();
  return result;
}

function validated<T>(parse: () => T): ApiResultV1<T> {
  try {
    return freezeValue({ ok: true, value: parse() });
  } catch {
    return freezeValue({
      ok: false,
      error: apiError('validation', 'INVALID_ARGUMENT', 'Invalid API argument.'),
    });
  }
}

export function validateConsumer(value: unknown): ApiResultV1<string> {
  return validated(() => namespace(value));
}

function scope(input: RecordValue): Pick<ListTasksV1, 'path' | 'folder'> {
  if (input['path'] !== undefined && input['folder'] !== undefined) return invalid();
  return {
    ...(input['path'] === undefined ? {} : { path: path(input['path']) }),
    ...(input['folder'] === undefined ? {} : { folder: path(input['folder'], true) }),
  };
}

function list(value: unknown): ListTasksV1 {
  const input = record(value === undefined ? {} : value, [
    'path',
    'folder',
    'statuses',
    'tagsAll',
    'dates',
    'limit',
    'cursor',
  ]);
  return {
    ...scope(input),
    ...(input['statuses'] === undefined ? {} : { statuses: parseStatuses(input['statuses']) }),
    ...(input['tagsAll'] === undefined ? {} : { tagsAll: parseTags(input['tagsAll']) }),
    ...(input['dates'] === undefined ? {} : { dates: parseDates(input['dates']) }),
    ...(input['limit'] === undefined ? {} : { limit: integer(input['limit'], 1, 500) }),
    ...(input['cursor'] === undefined ? {} : { cursor: text(input['cursor'], 512) }),
  };
}

export function validateList(value: unknown): ApiResultV1<ListTasksV1> {
  return validated(() => list(value));
}

export function validateSelector(value: unknown): ApiResultV1<TaskSelectorV1> {
  return validated(() => {
    const input = record(value, ['source', 'authoredId']);
    if ((input['source'] === undefined) === (input['authoredId'] === undefined)) return invalid();
    if (input['authoredId'] !== undefined) return { authoredId: text(input['authoredId'], 256) };
    const source = record(input['source'], ['path', 'line']);
    return { source: { path: path(source['path']), line: integer(source['line'], 0) } };
  });
}

export function validateMutation(
  method: 'complete' | 'setStatus' | 'toggleCompletion',
  value: unknown,
): ApiResultV1<StatusMutationV1 | SetTaskStatusV1> {
  return validated(() => {
    const keys = ['target', 'expectedRevision', 'requestId', 'expiresAt'];
    const input = record(value, method === 'setStatus' ? [...keys, 'symbol'] : keys);
    const result = {
      target: text(input['target'], 512),
      expectedRevision: text(input['expectedRevision'], 512),
      requestId: namespace(input['requestId']),
      expiresAt: integer(input['expiresAt']),
    };
    if (method !== 'setStatus') return result;
    const symbol = text(input['symbol'], 1);
    return { ...result, symbol: symbol === 'X' ? 'x' : symbol };
  });
}

function signal(value: unknown): ApiAbortSignalV1 {
  if (value === null || typeof value !== 'object') return invalid();
  if (!('aborted' in value) || typeof value.aborted !== 'boolean') return invalid();
  if (!('addEventListener' in value) || typeof value.addEventListener !== 'function')
    return invalid();
  if (!('removeEventListener' in value) || typeof value.removeEventListener !== 'function')
    return invalid();
  return value as ApiAbortSignalV1;
}

export function validateReadOptions(value: unknown): ApiResultV1<ReadOptionsV1> {
  try {
    const input = record(value === undefined ? {} : value, ['signal']);
    const options: ReadOptionsV1 = Object.freeze(
      input['signal'] === undefined ? {} : { signal: signal(input['signal']) },
    );
    // The signal is live and caller-owned, including when it is itself a plain record.
    return Object.freeze({ ok: true, value: options });
  } catch {
    return freezeValue({
      ok: false,
      error: apiError('validation', 'INVALID_ARGUMENT', 'Invalid API argument.'),
    });
  }
}
