import type { ApiResultV1, ErrorCategoryV1, ListTasksV1 } from '../../api';
import type { TaskReadObservation } from '../tasks';
import { validateList } from './validation';
import { apiError, freezeValue } from './values';

interface CursorRecord {
  readonly binding: string;
  readonly after: { readonly path: string; readonly line: number };
  readonly expires: number;
}
function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function binding(
  query: ListTasksV1,
  observation: TaskReadObservation,
  policy?: string,
): ApiResultV1<string> {
  const result = validateList({ ...query, cursor: undefined });
  if (!result.ok) return result;
  const normalized = result.value;
  return {
    ok: true,
    value: JSON.stringify({
      inbox: normalized.inbox,
      policy,
      path: normalized.path,
      folder: normalized.folder,
      statuses:
        normalized.statuses !== undefined ? [...normalized.statuses].sort(compare) : undefined,
      tagsAll: normalized.tagsAll !== undefined ? [...normalized.tagsAll].sort(compare) : undefined,
      dates:
        normalized.dates !== undefined
          ? [...normalized.dates].sort((a, b) => compare(a.field, b.field))
          : undefined,
      limit: normalized.limit ?? 100,
      generation: observation.generation,
      scope: observation.scopeRevision,
      semantics: observation.semanticsRevision,
    }),
  };
}
const errors = {
  DISPOSED: ['lifecycle', 'Task cursors are disposed.'],
  RESOURCE_LIMIT: ['resource', 'Task cursor capacity is exhausted.'],
  STALE_CURSOR: ['conflict', 'Task cursor is no longer current.'],
} as const satisfies Record<string, readonly [ErrorCategoryV1, string]>;
function failure(code: keyof typeof errors): ApiResultV1<never> {
  const [category, message] = errors[code];
  return freezeValue({ ok: false, error: apiError(category, code, message) });
}

/** Keeps only bounded query bindings and offsets; replay never extends the issuance deadline. */
export class TaskCursorRegistry {
  private readonly records_abyssPrivate = new Map<string, CursorRecord>();
  private readonly epoch_abyssPrivate: string;
  private readonly now_abyssPrivate: () => number;
  private readonly max_abyssPrivate: number;
  private readonly ttl_abyssPrivate: number;
  private counter_abyssPrivate = 0;
  private disposed_abyssPrivate = false;
  constructor(options: { epoch: string; now: () => number; maxCursors?: number; ttlMs?: number }) {
    this.epoch_abyssPrivate = options.epoch;
    this.now_abyssPrivate = options.now;
    this.max_abyssPrivate = options.maxCursors ?? 1_024;
    this.ttl_abyssPrivate = options.ttlMs ?? 60_000;
  }
  open(
    query: ListTasksV1,
    observation: TaskReadObservation,
    after: { path: string; line: number },
    policy?: string,
  ): ApiResultV1<string> {
    if (this.disposed_abyssPrivate) return failure('DISPOSED');
    const key = binding(query, observation, policy);
    if (!key.ok) return key;
    const now = this.now_abyssPrivate();
    for (const [token, record] of this.records_abyssPrivate) {
      if (record.expires <= now) this.records_abyssPrivate.delete(token);
    }
    if (
      this.records_abyssPrivate.size >= this.max_abyssPrivate ||
      this.counter_abyssPrivate >= Number.MAX_SAFE_INTEGER
    )
      return failure('RESOURCE_LIMIT');
    const token = `${this.epoch_abyssPrivate}:c:${++this.counter_abyssPrivate}`;
    this.records_abyssPrivate.set(token, {
      binding: key.value,
      after: Object.freeze({ ...after }),
      expires: now + this.ttl_abyssPrivate,
    });
    return Object.freeze({ ok: true, value: token });
  }
  resume(
    token: string,
    query: ListTasksV1,
    observation: TaskReadObservation,
    policy?: string,
  ): ApiResultV1<{ path: string; line: number }> {
    if (this.disposed_abyssPrivate) return failure('DISPOSED');
    const record = this.records_abyssPrivate.get(token);
    if (record === undefined) return failure('STALE_CURSOR');
    if (record.expires <= this.now_abyssPrivate()) {
      this.records_abyssPrivate.delete(token);
      return failure('STALE_CURSOR');
    }
    const key = binding(query, observation, policy);
    if (!key.ok || key.value !== record.binding) return failure('STALE_CURSOR');
    return freezeValue({ ok: true, value: { ...record.after } });
  }
  dispose(): void {
    this.disposed_abyssPrivate = true;
    this.records_abyssPrivate.clear();
  }
}
