/**
 * Abyss Tasks public integration API, version 1.
 *
 * This declaration is standalone: consumers need neither Obsidian nor DOM typings.
 * Task data, observations, errors and receipts are detached, recursively frozen plain
 * values. Optional fields are absent when unavailable. The cancellation signal is
 * a retained live capability: its identity and mutable state remain caller-owned.
 *
 * Discover a provider structurally from a candidate supplied by your integration.
 * No particular host plugin registry is part of this contract. Request exactly v1,
 * check the result and apiVersion, and register cleanup before using the client:
 *
 * ```ts
 * function connect(candidate: unknown, cleanup: (fn: () => void) => void,
 *                  onInvalidation: (event: ApiEventV1) => void) {
 *   if (candidate === null || typeof candidate !== 'object' ||
 *       !('getApi' in candidate) || typeof candidate.getApi !== 'function') return;
 *   const provider = candidate as TasksApiProviderV1;
 *   const result = provider.getApi(1, { consumerId: 'my-plugin' });
 *   if (!result.ok || result.value.info.apiVersion !== 1) return;
 *   const client = result.value;
 *   cleanup(() => client.dispose());
 *   const subscription = client.subscribe(onInvalidation);
 *   if (subscription.ok) cleanup(subscription.value);
 *   return client;
 * }
 * ```
 *
 * getApi rejects unsupported versions rather than negotiating another major.
 * consumerId is a diagnostic/request namespace, not authentication or permission.
 * Calls return structured errors without UI notices; codes are extensible and
 * messages are explanatory, not dispatch keys. Handle unknown error codes.
 */
/** Opaque occurrence handle; never decode, manufacture, or persist across provider epochs. */
export type TaskTargetV1 = string;
/**
 * Opaque whole-root basis, including descendants, siblings, tracking and semantics.
 * Compare only for equality; any source-basis change requires a fresh read before writing.
 * A proven relocation may retain target while changing revision. Tokens are not IDs.
 */
export type TaskRevisionV1 = string;
export type TaskStatusV1 = 'open' | 'in-progress' | 'done' | 'cancelled';
export type EffectStateV1 = 'unchanged' | 'committed' | 'partial' | 'unknown';
export type RecoveryV1 = 'none' | 'reread' | 'retry-same-request' | 'reconcile';
export type ErrorCategoryV1 =
  | 'validation'
  | 'unavailable'
  | 'conflict'
  | 'blocked'
  | 'unsupported'
  | 'lifecycle'
  | 'resource'
  | 'io'
  | 'internal';
export interface ApiErrorV1 {
  readonly category: ErrorCategoryV1;
  readonly code: string; // extensible; callers handle unknown codes
  readonly message: string; // explanatory, never a dispatch key
  readonly diagnosticId?: string;
}
export type ApiResultV1<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ApiErrorV1;
    };
// Structural cancellation permits standard AbortSignal without requiring DOM typings.
export interface ApiAbortSignalV1 {
  readonly aborted: boolean;
  readonly addEventListener: (
    type: 'abort',
    listener: () => void,
    options?: {
      readonly once?: boolean;
    },
  ) => void;
  readonly removeEventListener: (type: 'abort', listener: () => void) => void;
}
export interface ReadOptionsV1 {
  readonly signal?: ApiAbortSignalV1;
}
export interface ObservationV1 {
  readonly providerEpoch: string;
  readonly revision: number;
  readonly generation: number;
  readonly scopeRevision: number;
  readonly semanticsRevision: number;
}
/**
 * Read limits from this object; future implementations may change them prospectively
 * while preserving guarantees for accepted in-flight requests. Initial limits are
 * documented on each property below. Capability strings describe operations, not permissions.
 */
export interface ApiInfoV1 {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly providerEpoch: string;
  readonly capabilities: readonly string[];
  readonly limits: {
    /** Initial limit: 100. */
    readonly defaultPageSize: number;
    /** Initial limit: 500. */
    readonly maxPageSize: number;
    /** Initial limit: 60000. */
    readonly cursorTtlMs: number;
    /** Initial limit: 1024. */
    readonly maxCursors: number;
    /** Initial limit: 1800000. */
    readonly targetIdleTtlMs: number;
    /** Initial limit: 50000. */
    readonly maxTargets: number;
    /** Initial limit: 300000. */
    readonly maxRequestWindowMs: number;
    /** Initial limit: 32. */
    readonly maxPendingRequestsPerConsumer: number;
    /** Initial limit: 1024. */
    readonly maxRetainedRequestsPerConsumer: number;
    /** Initial limit: 4096. */
    readonly maxRetainedRequests: number;
    /** Initial limit: 128. */
    readonly maxClients: number;
    /** Initial limit: 32. */
    readonly maxListenersPerClient: number;
  };
}
export type ApiLifecycleV1 = 'initializing' | 'ready' | 'failed' | 'disposed';
/**
 * Invalidation only: no task content, durable offset, deletion log or origin promise.
 * For a race-free scan, subscribe first and remember the latest event revision.
 * Scan every page with matching observation fields; accept only if that revision
 * still equals the latest event revision. Restart on an intervening event,
 * STALE_CURSOR or INCOMPLETE_READ. Accepted state is published before receipts settle.
 */
export interface ApiEventV1 extends ObservationV1 {
  readonly type: 'state' | 'changed';
  readonly lifecycle: ApiLifecycleV1;
}
export interface ReadyV1 extends ObservationV1 {
  readonly lifecycle: 'ready';
}
/** Canonical YYYY-MM-DD civil dates; absent invalid or unsupported authored values are omitted. */
export interface TaskDatesV1 {
  readonly created?: string;
  readonly start?: string;
  readonly scheduled?: string;
  readonly due?: string;
  readonly completion?: string;
  readonly cancelled?: string;
}
export interface TaskDtoV1 {
  readonly target: TaskTargetV1;
  readonly revision: TaskRevisionV1;
  readonly title: string;
  readonly markdownTitle: string;
  readonly status: TaskStatusV1;
  readonly statusSymbol: string;
  readonly priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  readonly dates: TaskDatesV1;
  readonly time?: string;
  readonly durationMinutes?: number;
  readonly tags: readonly string[];
  readonly recurrence?: string;
  readonly onCompletion: 'keep' | 'delete';
  readonly onCompletionExplicit: boolean;
  readonly authoredId?: string;
  readonly source: {
    /** Vault-relative POSIX path, with authored case and Unicode preserved. */
    readonly path: string;
    /** Absolute zero-based physical source line, including all ancestor offsets. */
    readonly line: number;
  };
  readonly parentTarget?: TaskTargetV1;
}
export interface DateFilterV1 {
  readonly field: 'created' | 'start' | 'scheduled' | 'due' | 'completion' | 'cancelled';
  readonly from?: string;
  readonly to?: string;
}
/**
 * path and folder are mutually exclusive; folder '' means the vault root. Folders
 * include descendants by segment boundary. Filters compose as an intersection;
 * tags use shared case-insensitive identity, and date endpoints are inclusive.
 * A cursor binds the provider epoch, scan generation, normalized query and page
 * limit. Continue with the same query/limit; restart after expiry or invalidation.
 * Empty filter arrays, duplicate statuses and duplicate date fields are invalid.
 */
export interface ListTasksV1 {
  readonly path?: string;
  readonly folder?: string;
  readonly statuses?: readonly TaskStatusV1[];
  readonly tagsAll?: readonly string[];
  readonly dates?: readonly DateFilterV1[];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TaskPageV1 extends ObservationV1 {
  readonly items: readonly TaskDtoV1[];
  readonly nextCursor?: string;
}
export type TaskSelectorV1 =
  | {
      readonly source: {
        readonly path: string;
        readonly line: number;
      };
    }
  | {
      readonly authoredId: string;
    };
export type ResolutionV1 =
  | {
      readonly type: 'found';
      readonly task: TaskDtoV1;
      readonly observation: ObservationV1;
    }
  | {
      readonly type: 'not-found';
      readonly observation: ObservationV1;
    }
  | {
      readonly type: 'ambiguous';
      readonly candidates: readonly TaskDtoV1[];
      readonly truncated: boolean;
      readonly observation: ObservationV1;
    };
export interface StatusCatalogV1 extends ObservationV1 {
  readonly items: ReadonlyArray<{
    readonly symbol: string;
    readonly status: TaskStatusV1;
    readonly defaultForStatus: boolean;
  }>;
}
/**
 * Admission requires a fresh expectedRevision and complete permitted source coverage.
 * expiresAt is a safe integer Unix-millisecond acceptance deadline, strictly after
 * current provider time and at most info.limits.maxRequestWindowMs ahead. Accepted
 * work can finish after the deadline; expiration does not roll back a write.
 *
 * Every new operation requires a new requestId in this consumer namespace. Never
 * repurpose an ID, including after expiry or provider reload. For a retry, preserve
 * the exact method, target, revision, normalized symbol, ID and deadline:
 *
 * ```ts
 * const input = { target: task.target, expectedRevision: task.revision,
 *   requestId: newlyGeneratedId, expiresAt: now + client.info.limits.maxRequestWindowMs };
 * const result = await client.tasks.complete(input);
 * if (!result.ok && result.recovery === 'retry-same-request' && now < input.expiresAt) {
 *   await client.tasks.complete(input); // identical payload, never extend the deadline
 * }
 * ```
 *
 * Deduplication is scoped to providerEpoch/consumerId/requestId. Equal accepted
 * requests join/replay while retained; changed payloads are rejected while retained
 * and unexpired. Bounded storage cannot detect every reuse after record eviction.
 * Replay precedes current readiness, revision, catalog and source-health admission
 * checks. Accepted failures replay too; they never execute again. Signal and client
 * identity are excluded from payload equality. Expiry is checked before replay using
 * provider time that never decreases, so clock rollback cannot revive a request.
 * Only expired settled records are reclaimed. Live capacity exhaustion rejects new
 * work with unchanged effects and retry-same-request; accepted duplicates still join.
 * The original expired payload is rejected even after eviction. An unknown outcome,
 * provider reload, missing response or expiry needs fresh reads/reconciliation before
 * any new operation; that operation uses a new ID. There is no durable exactly-once
 * guarantee across provider reloads. Multiple clients share their consumer's namespace.
 */
export interface StatusMutationV1 {
  readonly target: TaskTargetV1;
  readonly expectedRevision: TaskRevisionV1;
  readonly requestId: string;
  readonly expiresAt: number; // Unix milliseconds, acceptance deadline
}
/** One configured checkbox character; X normalizes to x, and the space symbol is not trimmed. */
export interface SetTaskStatusV1 extends StatusMutationV1 {
  readonly symbol: string;
}
/**
 * Abort before admission writes nothing. After reservation, abort or client disposal
 * cannot cancel the shared accepted operation, erase its receipt or claim rollback.
 */
export interface MutationOptionsV1 {
  readonly signal?: ApiAbortSignalV1;
}
export interface MutationWarningV1 {
  readonly code: string;
  readonly message: string;
}
/**
 * Describes effects, not a new read. Keep recurrence retains original and may return
 * a distinct next occurrence; Delete recurrence removes original and may return next.
 * A nonrecurring deletion has no next. Nested deletion refers to the selected node.
 * Unproven never claims deletion. Tracking warnings can accompany a committed status.
 * Snapshots reflect final proven identities and may be unavailable or redacted under
 * current disclosure policy. Replayed receipts describe the original operation and
 * do not invite repeating committed effects. Follow recovery, then reread if needed.
 */
export interface MutationReceiptV1 {
  readonly providerEpoch: string;
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly expiresAt: number;
  readonly outcome: 'changed' | 'noop' | 'failed';
  readonly effects: EffectStateV1;
  readonly recovery: RecoveryV1;
  readonly original: {
    readonly target: TaskTargetV1;
    readonly state: 'retained' | 'removed' | 'unproven';
    readonly task?: TaskDtoV1;
  };
  readonly next?: {
    readonly target: TaskTargetV1;
    readonly task?: TaskDtoV1;
  };
  readonly snapshots: 'complete' | 'unavailable' | 'redacted';
  readonly warnings: readonly MutationWarningV1[];
}
export type MutationResultV1 =
  | {
      readonly ok: true;
      readonly receipt: MutationReceiptV1;
    }
  | {
      readonly ok: false;
      readonly error: ApiErrorV1;
      readonly effects: EffectStateV1;
      readonly recovery: RecoveryV1;
      readonly receipt?: MutationReceiptV1;
    };
/**
 * A client belongs to one provider epoch. ready waits through initialization but
 * does not promise complete source coverage. Calls during initialization/failure
 * return lifecycle errors. subscribe registers atomically and synchronously emits
 * the current state before returning. Listener failures are isolated; change events
 * may coalesce. No callbacks run after unsubscribe, client disposal or provider unload.
 * dispose is idempotent and releases listeners and pending reads/readiness waits.
 * Accepted writes and retained receipts survive client disposal, but not unload.
 */
export interface TasksApiV1 {
  readonly info: ApiInfoV1;
  readonly ready: (options?: ReadOptionsV1) => Promise<ApiResultV1<ReadyV1>>;
  readonly subscribe: (listener: (event: ApiEventV1) => void) => ApiResultV1<() => void>;
  readonly dispose: () => void;
  readonly tasks: {
    readonly list: (
      query?: ListTasksV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<TaskPageV1>>;
    readonly get: (
      target: TaskTargetV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<TaskDtoV1>>;
    readonly resolve: (
      selector: TaskSelectorV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<ResolutionV1>>;
    readonly statuses: (options?: ReadOptionsV1) => Promise<ApiResultV1<StatusCatalogV1>>;
    readonly complete: (
      input: StatusMutationV1,
      options?: MutationOptionsV1,
    ) => Promise<MutationResultV1>;
    readonly setStatus: (
      input: SetTaskStatusV1,
      options?: MutationOptionsV1,
    ) => Promise<MutationResultV1>;
    readonly toggleCompletion: (
      input: StatusMutationV1,
      options?: MutationOptionsV1,
    ) => Promise<MutationResultV1>;
  };
}
export interface TasksApiProviderV1 {
  readonly getApi: (
    version: number,
    options: {
      readonly consumerId: string;
    },
  ) => ApiResultV1<TasksApiV1>;
}
