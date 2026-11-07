import type {
  ApiAbortSignalV1,
  ApiErrorV1,
  ApiResultV1,
  ApplyTaskContentV1,
  ErrorCategoryV1,
  MutationResultV1,
  ProjectMutationReceiptV1,
  ProjectMutationResultV1,
  RecoveryV1,
  SetTaskStatusV1,
  StatusMutationV1,
  TaskContentMutationResultV1,
} from '../../api';
import type { TaskCreatePreparation } from '../tasks';
import {
  validateProjectMutation,
  type ProjectMutationInput,
  type ProjectOperation,
} from './projectValidation';
import { validateContentApply } from './taskContentValidation';
import { validateConsumer, validateMutation } from './validation';
import { apiError, freezeValue } from './values';

type TaskMethod = 'complete' | 'setStatus' | 'toggleCompletion';
type Method = TaskMethod | ProjectOperation | 'tasks.apply' | 'tasks.create';
type Result = MutationResultV1 | ProjectMutationResultV1 | TaskContentMutationResultV1;
interface ContentEvidence {
  readonly target: string;
  readonly preparation: Extract<TaskCreatePreparation, { type: 'ready' }>;
}
interface AdmissionTicket<T extends Result = MutationResultV1> {
  readonly retainedBytes?: number;
  readonly execute: (acceptedAt: number) => Promise<T>;
  readonly unknown?: (acceptedAt: number, error: ApiErrorV1) => T;
  readonly release: () => void;
}
interface RequestOptions<T extends Result = MutationResultV1> {
  readonly signal?: ApiAbortSignalV1;
  readonly isDisposed: () => boolean;
  readonly admit: () => ApiResultV1<AdmissionTicket<T>>;
}
type AcceptedProjectResult =
  | { readonly ok: true; readonly receipt: ProjectMutationReceiptV1 }
  | {
      readonly ok: false;
      readonly error: ApiErrorV1;
      readonly effects: ProjectMutationReceiptV1['effects'];
      readonly recovery: RecoveryV1;
      readonly receipt: ProjectMutationReceiptV1;
    };
export interface ProjectAdmissionTicket {
  readonly execute: (acceptedAt: number) => Promise<AcceptedProjectResult>;
  readonly release: () => void;
  readonly unknown: (acceptedAt: number) => ProjectMutationReceiptV1;
}
interface ProjectRequestOptions extends Omit<RequestOptions<ProjectMutationResultV1>, 'admit'> {
  readonly admit: () => ApiResultV1<ProjectAdmissionTicket>;
}
interface RegistryOptions {
  readonly epoch: string;
  readonly now: () => number;
  readonly maxPendingPerConsumer?: number;
  readonly maxRetainedPerConsumer?: number;
  readonly maxRetained?: number;
  readonly maxProjectBytes?: number;
}
interface RequestRecord {
  readonly consumerId: string;
  readonly payload: string;
  readonly expiresAt: number;
  readonly promise: Promise<Result>;
  readonly projectBytes: number;
  release: (() => void) | undefined;
  pending: boolean;
  contentEvidence?: ContentEvidence;
}
interface RequestContext {
  readonly consumerId: string;
  readonly method: Method;
  readonly request: StatusMutationV1 | ProjectMutationInput | ApplyTaskContentV1;
  readonly projectBytes: number;
  readonly key: string;
  readonly payload: string;
}
type AdmissionCheck =
  { readonly acceptedAt: number } | { readonly result: Result | Promise<Result> };
interface AbortObservation {
  readonly read: () => void;
  readonly state: () => 'aborted' | 'live' | 'failed';
  readonly release: () => void;
}
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
function observeAbort(signal: ApiAbortSignalV1 | undefined): AbortObservation {
  let state: 'aborted' | 'live' | 'failed' = 'live';
  const aborted = (): void => {
    state = 'aborted';
  };
  try {
    signal?.addEventListener('abort', aborted);
  } catch {
    state = 'failed';
  }
  return {
    read: () => {
      if (state !== 'live') return;
      try {
        if (signal?.aborted === true) state = 'aborted';
      } catch {
        state = 'failed';
      }
    },
    state: () => state,
    // Remove even after registration throws: it may have installed the listener first.
    release: () => {
      signal?.removeEventListener('abort', aborted);
    },
  };
}
function context(
  consumerId: string,
  method: TaskMethod,
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
      projectBytes: 0,
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
  private retainedProjectBytes_abyssPrivate = 0;
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
    method: TaskMethod,
    input: StatusMutationV1 | SetTaskStatusV1,
    options: RequestOptions,
  ): Promise<MutationResultV1> {
    // Qualified operation and exact payload equality ensure a replay has this result type.
    return this.run_abyssPrivate(
      method,
      () => context(consumerId, method, input),
      options,
    ) as Promise<MutationResultV1>;
  }
  async executeProject(
    consumerId: string,
    method: ProjectOperation,
    input: ProjectMutationInput,
    options: ProjectRequestOptions,
  ): Promise<ProjectMutationResultV1> {
    return this.run_abyssPrivate(
      method,
      () => {
        const consumer = validateConsumer(consumerId);
        const parsed = validateProjectMutation(method, input);
        if (!consumer.ok) return consumer;
        if (!parsed.ok) return parsed;
        const request = parsed.value;
        const payload = JSON.stringify([method, request]);
        const current: RequestContext = {
          consumerId: consumer.value,
          method,
          request,
          key: JSON.stringify([consumer.value, request.requestId]),
          payload,
          projectBytes: new TextEncoder().encode(payload).length,
        };
        return { ok: true, value: current };
      },
      {
        ...options,
        admit: () => {
          const admission = options.admit();
          if (!admission.ok) return admission;
          const ticket = admission.value;
          return {
            ok: true,
            value: {
              execute: ticket.execute,
              release: ticket.release,
              unknown: (acceptedAt, error) => ({
                ok: false,
                error,
                effects: 'unknown',
                recovery: 'reconcile',
                receipt: ticket.unknown(acceptedAt),
              }),
            },
          };
        },
      },
    );
  }
  async executeContent(
    consumerId: string,
    method: 'tasks.apply' | 'tasks.create',
    input: ApplyTaskContentV1,
    options: RequestOptions<TaskContentMutationResultV1>,
  ): Promise<TaskContentMutationResultV1> {
    return this.run_abyssPrivate(
      method,
      () => {
        const consumer = validateConsumer(consumerId),
          parsed = validateContentApply(input);
        if (!consumer.ok) return consumer;
        if (!parsed.ok) return parsed;
        const request = parsed.value,
          payload = JSON.stringify([
            method,
            request.plan,
            request.expectedPlanRevision,
            request.requestId,
            request.expiresAt,
          ]);
        return {
          ok: true,
          value: {
            consumerId: consumer.value,
            method,
            request,
            payload,
            projectBytes: new TextEncoder().encode(payload).length,
            key: JSON.stringify([consumer.value, request.requestId]),
          },
        };
      },
      options,
    ) as Promise<TaskContentMutationResultV1>;
  }
  retainContentEvidence(consumerId: string, requestId: string, evidence: ContentEvidence): void {
    const record = this.records_abyssPrivate.get(JSON.stringify([consumerId, requestId]));
    if (record?.pending === true) record.contentEvidence = evidence;
  }
  async contentEvidence(
    consumerId: string,
    requestId: string,
  ): Promise<ContentEvidence | undefined> {
    this.reclaim_abyssPrivate(this.time_abyssPrivate());
    const record = this.records_abyssPrivate.get(JSON.stringify([consumerId, requestId]));
    if (record === undefined || record.pending) return undefined;
    const result = await record.promise;
    if (
      !result.ok ||
      result.receipt.effects !== 'committed' ||
      record.expiresAt <= this.time_abyssPrivate()
    )
      return undefined;
    return record.contentEvidence;
  }
  private async run_abyssPrivate(
    method: Method,
    parse: () => ApiResultV1<RequestContext>,
    options: RequestOptions<Result>,
  ): Promise<Result> {
    try {
      if (this.closed_abyssPrivate(options)) return failure('DISPOSED');
      const parsed = parse();
      if (!parsed.ok) return rejected(parsed.error);
      const current = parsed.value;
      const now = this.time_abyssPrivate();
      this.reclaim_abyssPrivate(now);
      if (current.request.expiresAt <= now) return failure('REQUEST_EXPIRED');
      const replay = this.replay_abyssPrivate(current);
      if (replay !== undefined) return replay;
      if (current.request.expiresAt - now > 300_000) return failure('INVALID_ARGUMENT');
      return this.observeAdmission_abyssPrivate(current, options);
    } catch {
      return rejected(this.internal_abyssPrivate(method));
    }
  }
  private observeAdmission_abyssPrivate(
    current: RequestContext,
    options: RequestOptions<Result>,
  ): Result | Promise<Result> {
    const abort = observeAbort(options.signal);
    try {
      const checked = this.checkAdmission_abyssPrivate(current, options, abort);
      if ('result' in checked) return checked.result;
      return this.admit_abyssPrivate(current, options, abort);
    } finally {
      this.release_abyssPrivate(abort.release, current.method);
    }
  }
  private closed_abyssPrivate(options: RequestOptions<Result>): boolean {
    const clientDisposed = this.disposed_abyssPrivate ? true : options.isDisposed();
    return this.disposed_abyssPrivate || clientDisposed;
  }
  private checkAdmission_abyssPrivate(
    current: RequestContext,
    options: RequestOptions<Result>,
    abort: AbortObservation,
  ): AdmissionCheck {
    const initiallyClosed = this.closed_abyssPrivate(options);
    abort.read();
    // No untrusted signal getter runs after this client check. Abort notifications
    // raised by the check update the operation-owned latch synchronously instead.
    const closed = this.closed_abyssPrivate(options);
    const now = this.time_abyssPrivate();
    if (this.disposed_abyssPrivate || initiallyClosed || closed)
      return { result: failure('DISPOSED') };
    this.reclaim_abyssPrivate(now);
    if (current.request.expiresAt <= now) return { result: failure('REQUEST_EXPIRED') };
    const replay = this.replay_abyssPrivate(current);
    if (replay !== undefined) return { result: replay };
    const signal = abort.state();
    if (signal === 'failed')
      return { result: rejected(this.internal_abyssPrivate(current.method)) };
    if (signal === 'aborted') return { result: failure('ABORTED') };
    return { acceptedAt: now };
  }
  private admit_abyssPrivate(
    current: RequestContext,
    options: RequestOptions<Result>,
    abort: AbortObservation,
  ): Promise<Result> | Result {
    const admission = options.admit();
    let ticket = admission.ok ? admission.value : undefined;
    try {
      const checked = this.checkAdmission_abyssPrivate(current, options, abort);
      if ('result' in checked) return checked.result;
      if (!admission.ok) return rejected(admission.error);
      const retained = {
        ...current,
        projectBytes: current.projectBytes + (admission.value.retainedBytes ?? 0),
      };
      if (this.full_abyssPrivate(retained.consumerId, retained.projectBytes))
        return failure('RESOURCE_LIMIT');
      const promise = this.reserve_abyssPrivate(retained, admission.value, checked.acceptedAt);
      ticket = undefined;
      return promise;
    } finally {
      if (ticket !== undefined) this.release_abyssPrivate(ticket.release, current.method);
    }
  }
  private reserve_abyssPrivate(
    current: RequestContext,
    ticket: AdmissionTicket<Result>,
    acceptedAt: number,
  ): Promise<Result> {
    let resolve!: (result: Result) => void;
    const promise = new Promise<Result>((done) => {
      resolve = done;
    });
    const record: RequestRecord = {
      consumerId: current.consumerId,
      payload: current.payload,
      projectBytes: current.projectBytes,
      expiresAt: current.request.expiresAt,
      promise,
      pending: true,
      release: ticket.release,
    };
    this.records_abyssPrivate.set(current.key, record);
    this.retainedProjectBytes_abyssPrivate += record.projectBytes;
    this.settle_abyssPrivate(record, current, ticket, acceptedAt).then(resolve, () => {
      resolve(this.unknownResult_abyssPrivate(current, ticket, acceptedAt));
    });
    return promise;
  }
  private async settle_abyssPrivate(
    record: RequestRecord,
    current: RequestContext,
    ticket: AdmissionTicket<Result>,
    acceptedAt: number,
  ): Promise<Result> {
    let result: Result;
    try {
      result = await ticket.execute(acceptedAt);
      if (current.method.startsWith('projects.') && !result.ok && result.receipt === undefined) {
        result = {
          ...result,
          receipt: this.projectReceipt_abyssPrivate(
            current,
            acceptedAt,
            result.effects,
            result.recovery,
          ),
        };
      }
      result = freezeValue(result);
    } catch {
      result = this.unknownResult_abyssPrivate(current, ticket, acceptedAt);
    } finally {
      const release = record.release;
      record.release = undefined;
      if (release !== undefined) this.release_abyssPrivate(release, current.method);
      record.pending = false;
      if (this.disposed_abyssPrivate || record.expiresAt <= this.lastNow_abyssPrivate)
        this.delete_abyssPrivate(current.key, record);
    }
    return result;
  }
  private projectReceipt_abyssPrivate(
    current: RequestContext,
    acceptedAt: number,
    effects: ProjectMutationReceiptV1['effects'],
    recovery: ProjectMutationReceiptV1['recovery'],
  ): ProjectMutationReceiptV1 {
    return {
      providerEpoch: this.options_abyssPrivate.epoch,
      requestId: current.request.requestId,
      acceptedAt,
      expiresAt: current.request.expiresAt,
      outcome: 'failed',
      effects,
      recovery,
      ...(current.method === 'projects.moveTask'
        ? { destinationCopy: 'unknown' as const, sourceRemoval: 'unknown' as const }
        : {}),
    };
  }
  private unknownResult_abyssPrivate(
    current: RequestContext,
    ticket: AdmissionTicket<Result>,
    acceptedAt: number,
  ): Result {
    if (ticket.unknown !== undefined) {
      const error = this.internal_abyssPrivate(current.method);
      try {
        return freezeValue(ticket.unknown(acceptedAt, error));
      } catch {
        if ('plan' in current.request)
          return this.unknownContent_abyssPrivate(current.request, acceptedAt);
        return freezeValue<ProjectMutationResultV1>({
          ok: false,
          error,
          effects: 'unknown',
          recovery: 'reconcile',
          receipt: this.projectReceipt_abyssPrivate(current, acceptedAt, 'unknown', 'reconcile'),
        });
      }
    }
    return this.unknown_abyssPrivate(current, acceptedAt);
  }
  private unknown_abyssPrivate(current: RequestContext, acceptedAt: number): Result {
    if ('plan' in current.request)
      return this.unknownContent_abyssPrivate(current.request, acceptedAt);
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
        original: {
          target: 'target' in current.request ? current.request.target : '',
          state: 'unproven',
        },
        snapshots: 'unavailable',
        warnings: [],
      },
    });
  }
  private unknownContent_abyssPrivate(
    request: ApplyTaskContentV1,
    acceptedAt: number,
  ): TaskContentMutationResultV1 {
    return freezeValue<TaskContentMutationResultV1>({
      ok: false,
      error: this.internal_abyssPrivate('tasks.apply'),
      effects: 'unknown',
      recovery: 'reconcile',
      receipt: {
        providerEpoch: this.options_abyssPrivate.epoch,
        requestId: request.requestId,
        acceptedAt,
        expiresAt: request.expiresAt,
        plan: request.plan,
        planRevision: request.expectedPlanRevision,
        outcome: 'failed',
        effects: 'unknown',
        recovery: 'reconcile',
        snapshots: 'unavailable',
        contentContinuity: {
          plan: request.plan,
          planRevision: request.expectedPlanRevision,
          correspondence: { state: 'unavailable' },
        },
        warnings: [],
      },
    });
  }
  private replay_abyssPrivate(current: RequestContext): Promise<Result> | Result | undefined {
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
      if (!record.pending && record.expiresAt <= now) this.delete_abyssPrivate(key, record);
    }
  }
  private delete_abyssPrivate(key: string, record: RequestRecord): void {
    if (this.records_abyssPrivate.get(key) !== record) return;
    this.records_abyssPrivate.delete(key);
    this.retainedProjectBytes_abyssPrivate -= record.projectBytes;
  }
  private full_abyssPrivate(consumerId: string, projectBytes: number): boolean {
    if (
      this.retainedProjectBytes_abyssPrivate + projectBytes >
      (this.options_abyssPrivate.maxProjectBytes ?? 4 * 1024 * 1024)
    )
      return true;
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
      if (!record.pending) this.delete_abyssPrivate(key, record);
    }
  }
}
