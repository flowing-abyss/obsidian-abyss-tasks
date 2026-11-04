import type {
  ApiAbortSignalV1,
  ApiErrorV1,
  ApiResultV1,
  ErrorCategoryV1,
  MutationResultV1,
  RecoveryV1,
  SetTaskStatusV1,
  StatusMutationV1,
} from '../../api';
import { validateConsumer, validateMutation } from './validation';
import { apiError, freezeValue } from './values';

type Method = 'complete' | 'setStatus' | 'toggleCompletion';
interface AdmissionTicket {
  readonly execute: (acceptedAt: number) => Promise<MutationResultV1>;
  readonly release: () => void;
}
interface RequestOptions {
  readonly signal?: ApiAbortSignalV1;
  readonly isDisposed: () => boolean;
  readonly admit: () => ApiResultV1<AdmissionTicket>;
}
interface RegistryOptions {
  readonly epoch: string;
  readonly now: () => number;
  readonly maxPendingPerConsumer?: number;
  readonly maxRetainedPerConsumer?: number;
  readonly maxRetained?: number;
}
interface RequestRecord {
  readonly consumerId: string;
  readonly payload: string;
  readonly expiresAt: number;
  readonly promise: Promise<MutationResultV1>;
  release: (() => void) | undefined;
  pending: boolean;
}
interface RequestContext {
  readonly consumerId: string;
  readonly method: Method;
  readonly request: StatusMutationV1;
  readonly key: string;
  readonly payload: string;
}
type AdmissionCheck =
  | { readonly acceptedAt: number }
  | { readonly result: MutationResultV1 | Promise<MutationResultV1> };
const errors = {
  DISPOSED: ['lifecycle', 'Task requests are disposed.', 'none'],
  ABORTED: ['lifecycle', 'Task request was aborted before acceptance.', 'retry-same-request'],
  REQUEST_EXPIRED: ['validation', 'Task request deadline has expired.', 'none'],
  REQUEST_ID_REUSED: ['validation', 'Task request ID already has a different payload.', 'none'],
  INVALID_ARGUMENT: ['validation', 'Invalid API argument.', 'none'],
  RESOURCE_LIMIT: ['resource', 'Task request capacity is exhausted.', 'retry-same-request'],
} as const satisfies Record<string, readonly [ErrorCategoryV1, string, RecoveryV1]>;
function rejected(error: ApiErrorV1): MutationResultV1 {
  let recovery: RecoveryV1 = 'none';
  if (
    error.category === 'conflict' ||
    error.category === 'unavailable' ||
    error.code === 'NOT_READY' ||
    error.code === 'INITIALIZATION_FAILED'
  )
    recovery = 'reread';
  else if (error.code === 'RESOURCE_LIMIT' || error.code === 'ABORTED')
    recovery = 'retry-same-request';
  return freezeValue<MutationResultV1>({ ok: false, error, effects: 'unchanged', recovery });
}
function failure(code: keyof typeof errors): MutationResultV1 {
  const [category, message, recovery] = errors[code];
  return freezeValue<MutationResultV1>({
    ok: false,
    error: apiError(category, code, message),
    effects: 'unchanged',
    recovery,
  });
}
function abortState(options: RequestOptions): 'aborted' | 'live' | 'failed' {
  try {
    return options.signal?.aborted === true ? 'aborted' : 'live';
  } catch {
    return 'failed';
  }
}
function context(
  consumerId: string,
  method: Method,
  input: StatusMutationV1 | SetTaskStatusV1,
): ApiResultV1<RequestContext> {
  const consumer = validateConsumer(consumerId);
  if (!consumer.ok) return consumer;
  const parsed = validateMutation(method, input);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  return {
    ok: true,
    value: {
      consumerId: consumer.value,
      method,
      request,
      key: JSON.stringify([consumer.value, request.requestId]),
      payload: JSON.stringify([
        method,
        request.target,
        request.expectedRevision,
        request.requestId,
        request.expiresAt,
        'symbol' in request ? request.symbol : null,
      ]),
    },
  };
}

/** Owns accepted promises and receipts for one provider epoch; clients never erase them. */
export class TaskRequestRegistry {
  private readonly records_abyssPrivate = new Map<string, RequestRecord>();
  private readonly maxPending_abyssPrivate: number;
  private readonly maxConsumer_abyssPrivate: number;
  private readonly maxRetained_abyssPrivate: number;
  private lastNow_abyssPrivate = Number.NEGATIVE_INFINITY;
  private disposed_abyssPrivate = false;
  private diagnostics_abyssPrivate = 0;
  constructor(private readonly options_abyssPrivate: RegistryOptions) {
    this.maxPending_abyssPrivate = options_abyssPrivate.maxPendingPerConsumer ?? 32;
    this.maxConsumer_abyssPrivate = options_abyssPrivate.maxRetainedPerConsumer ?? 1_024;
    this.maxRetained_abyssPrivate = options_abyssPrivate.maxRetained ?? 4_096;
  }
  async execute(
    consumerId: string,
    method: Method,
    input: StatusMutationV1 | SetTaskStatusV1,
    options: RequestOptions,
  ): Promise<MutationResultV1> {
    try {
      if (this.closed_abyssPrivate(options)) return failure('DISPOSED');
      const parsed = context(consumerId, method, input);
      if (!parsed.ok) return rejected(parsed.error);
      const current = parsed.value;
      const now = this.time_abyssPrivate();
      this.reclaim_abyssPrivate(now);
      if (current.request.expiresAt <= now) return failure('REQUEST_EXPIRED');
      const replay = this.replay_abyssPrivate(current);
      if (replay !== undefined) return replay;
      if (current.request.expiresAt - now > 300_000) return failure('INVALID_ARGUMENT');
      const checked = this.checkAdmission_abyssPrivate(current, options);
      if ('result' in checked) return checked.result;
      return this.admit_abyssPrivate(current, options);
    } catch {
      return rejected(this.internal_abyssPrivate(method));
    }
  }
  private closed_abyssPrivate(options: RequestOptions): boolean {
    const clientDisposed = this.disposed_abyssPrivate ? true : options.isDisposed();
    return this.disposed_abyssPrivate || clientDisposed;
  }
  private checkAdmission_abyssPrivate(
    current: RequestContext,
    options: RequestOptions,
  ): AdmissionCheck {
    // Observe getter side effects before lifecycle, then refresh a still-live
    // signal: the lifecycle callback can itself abort before reservation.
    const initialSignal = abortState(options);
    const closed = this.closed_abyssPrivate(options);
    const signal = initialSignal === 'live' ? abortState(options) : initialSignal;
    const now = this.time_abyssPrivate();
    if (this.disposed_abyssPrivate || closed) return { result: failure('DISPOSED') };
    this.reclaim_abyssPrivate(now);
    if (current.request.expiresAt <= now) return { result: failure('REQUEST_EXPIRED') };
    const replay = this.replay_abyssPrivate(current);
    if (replay !== undefined) return { result: replay };
    if (signal === 'failed')
      return { result: rejected(this.internal_abyssPrivate(current.method)) };
    if (signal === 'aborted') return { result: failure('ABORTED') };
    return { acceptedAt: now };
  }
  private admit_abyssPrivate(
    current: RequestContext,
    options: RequestOptions,
  ): Promise<MutationResultV1> | MutationResultV1 {
    const admission = options.admit();
    let ticket = admission.ok ? admission.value : undefined;
    try {
      const checked = this.checkAdmission_abyssPrivate(current, options);
      if ('result' in checked) return checked.result;
      if (!admission.ok) return rejected(admission.error);
      if (this.full_abyssPrivate(current.consumerId)) return failure('RESOURCE_LIMIT');
      const promise = this.reserve_abyssPrivate(current, admission.value, checked.acceptedAt);
      ticket = undefined;
      return promise;
    } finally {
      if (ticket !== undefined) this.release_abyssPrivate(ticket.release, current.method);
    }
  }
  private reserve_abyssPrivate(
    current: RequestContext,
    ticket: AdmissionTicket,
    acceptedAt: number,
  ): Promise<MutationResultV1> {
    let resolve!: (result: MutationResultV1) => void;
    const promise = new Promise<MutationResultV1>((done) => {
      resolve = done;
    });
    const record: RequestRecord = {
      consumerId: current.consumerId,
      payload: current.payload,
      expiresAt: current.request.expiresAt,
      promise,
      pending: true,
      release: ticket.release,
    };
    this.records_abyssPrivate.set(current.key, record);
    this.settle_abyssPrivate(record, current, ticket, acceptedAt).then(resolve, () => {
      resolve(this.unknown_abyssPrivate(current, acceptedAt));
    });
    return promise;
  }
  private async settle_abyssPrivate(
    record: RequestRecord,
    current: RequestContext,
    ticket: AdmissionTicket,
    acceptedAt: number,
  ): Promise<MutationResultV1> {
    let result: MutationResultV1;
    try {
      result = freezeValue(await ticket.execute(acceptedAt));
    } catch {
      result = this.unknown_abyssPrivate(current, acceptedAt);
    }
    const release = record.release;
    record.release = undefined;
    if (release !== undefined) this.release_abyssPrivate(release, current.method);
    record.pending = false;
    if (this.disposed_abyssPrivate || record.expiresAt <= this.lastNow_abyssPrivate)
      this.records_abyssPrivate.delete(current.key);
    return result;
  }
  private unknown_abyssPrivate(current: RequestContext, acceptedAt: number): MutationResultV1 {
    return freezeValue<MutationResultV1>({
      ok: false,
      error: this.internal_abyssPrivate(current.method),
      effects: 'unknown',
      recovery: 'reconcile',
      receipt: {
        providerEpoch: this.options_abyssPrivate.epoch,
        requestId: current.request.requestId,
        acceptedAt,
        expiresAt: current.request.expiresAt,
        outcome: 'failed',
        effects: 'unknown',
        recovery: 'reconcile',
        original: { target: current.request.target, state: 'unproven' },
        snapshots: 'unavailable',
        warnings: [],
      },
    });
  }
  private replay_abyssPrivate(
    current: RequestContext,
  ): Promise<MutationResultV1> | MutationResultV1 | undefined {
    const record = this.records_abyssPrivate.get(current.key);
    if (record === undefined) return undefined;
    return record.payload === current.payload ? record.promise : failure('REQUEST_ID_REUSED');
  }
  private time_abyssPrivate(): number {
    const wallNow = this.options_abyssPrivate.now();
    this.lastNow_abyssPrivate = Math.max(this.lastNow_abyssPrivate, wallNow);
    return this.lastNow_abyssPrivate;
  }
  private reclaim_abyssPrivate(now: number): void {
    for (const [key, record] of this.records_abyssPrivate) {
      if (!record.pending && record.expiresAt <= now) this.records_abyssPrivate.delete(key);
    }
  }
  private full_abyssPrivate(consumerId: string): boolean {
    if (this.records_abyssPrivate.size >= this.maxRetained_abyssPrivate) return true;
    let pending = 0;
    let retained = 0;
    for (const record of this.records_abyssPrivate.values()) {
      if (record.consumerId !== consumerId) continue;
      retained++;
      if (record.pending) pending++;
    }
    return pending >= this.maxPending_abyssPrivate || retained >= this.maxConsumer_abyssPrivate;
  }
  private internal_abyssPrivate(method: Method): ApiErrorV1 {
    const diagnosticId = `${this.options_abyssPrivate.epoch}:request:${++this.diagnostics_abyssPrivate}`;
    console.error('[abyss-tasks] API request failed', {
      operation: method,
      code: 'INTERNAL_ERROR',
      diagnosticId,
    });
    return apiError('internal', 'INTERNAL_ERROR', 'Task request failed.', diagnosticId);
  }
  private release_abyssPrivate(release: () => void, method: Method): void {
    try {
      release();
    } catch {
      this.internal_abyssPrivate(method);
    }
  }
  dispose(): void {
    this.disposed_abyssPrivate = true;
    for (const [key, record] of this.records_abyssPrivate) {
      if (!record.pending) this.records_abyssPrivate.delete(key);
    }
  }
}
