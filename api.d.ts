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
  readonly projectLimits?: {
    readonly maxFieldsPerWrite: number;
    readonly maxValuesPerField: number;
    readonly maxTextLength: number;
    readonly maxProjectInputBytes: number;
    readonly maxProjectResultBytes: number;
    readonly maxRetainedProjectBytes: number;
  };
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
  readonly projects?: ProjectsApiV1;
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

    readonly tree?: (
      query: ReadTaskTreeV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<TaskTreePageV1>>;
    readonly search?: (
      query: SearchTasksV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<TaskSearchPageV1>>;
    readonly tags?: (
      query?: ListTaskTagsV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<TaskTagPageV1>>;
    readonly prepare?: (
      input: PrepareTaskContentV1,
      options?: ReadOptionsV1,
    ) => Promise<ApiResultV1<ContentPlanV1>>;
    readonly apply?: (
      input: ApplyTaskContentV1,
      options?: MutationOptionsV1,
    ) => Promise<TaskContentMutationResultV1>;
    readonly create?: (
      input: ApplyTaskContentV1,
      options?: MutationOptionsV1,
    ) => Promise<TaskContentMutationResultV1>;

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

/** Project handles and revisions are opaque and valid only in this provider epoch. */
export type ProjectTargetV1 = string;
export type ProjectRevisionV1 = string;
export type ProjectFieldValueV1 = string | number | boolean | ReadonlyArray<string | number>;
export interface ProjectFieldAssignmentV1 {
  readonly fieldId: string;
  readonly value: ProjectFieldValueV1 | null;
}
export interface ProjectSchemaV1 extends ObservationV1 {
  readonly statuses: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly displayName?: string;
  }>;
  readonly defaultStatusId?: string;
  readonly fields: readonly ProjectSchemaFieldV1[];
}
export type ProjectEditableFieldTypeV1 =
  'text' | 'number' | 'checkbox' | 'list' | 'tags' | 'date' | 'datetime';
export type ProjectSchemaFieldV1 =
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'field';
      readonly type: ProjectEditableFieldTypeV1;
      readonly writable: boolean;
      readonly suggestions?: ReadonlyArray<{
        readonly value: ProjectFieldValueV1;
        readonly displayName?: string;
      }>;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'derived';
      readonly type: 'name' | 'progress' | 'tracking';
      readonly writable: false;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'status';
      readonly type: 'status';
      readonly writable: boolean;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'unavailable';
      readonly type: ProjectEditableFieldTypeV1 | 'status';
      readonly writable: false;
    };
export type ProjectStatusV1 =
  | { readonly state: 'absent' }
  | { readonly state: 'configured'; readonly id: string }
  | { readonly state: 'unrecognized'; readonly value: string }
  | { readonly state: 'unsupported' };
export interface ProjectSummaryV1 {
  readonly target: ProjectTargetV1;
  readonly revision: ProjectRevisionV1;
  readonly path: string;
  readonly name: string;
  readonly status: ProjectStatusV1;
  readonly stats: {
    readonly total: number;
    readonly done: number;
    readonly cancelled: number;
    readonly inProgress: number;
    readonly tracked: { readonly closedMs: number; readonly openStartsMs: readonly number[] };
  };
}
export interface ProjectDtoV1 extends ProjectSummaryV1 {
  readonly tags: readonly string[];
  readonly fields: ReadonlyArray<
    | { readonly fieldId: string; readonly state: 'absent' | 'unsupported' }
    | { readonly fieldId: string; readonly state: 'value'; readonly value: ProjectFieldValueV1 }
  >;
}
export interface ProjectPageV1 extends ObservationV1 {
  readonly items: readonly ProjectSummaryV1[];
  readonly nextCursor?: string;
}
export interface ListProjectsV1 {
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ResolveProjectV1 {
  readonly path: string;
}
export type ProjectResolutionV1 =
  | { readonly type: 'found'; readonly project: ProjectDtoV1; readonly observation: ObservationV1 }
  | { readonly type: 'not-found'; readonly observation: ObservationV1 };
export interface ProjectRequestV1 {
  readonly requestId: string;
  readonly expiresAt: number;
}
export interface CreateProjectV1 extends ProjectRequestV1 {
  readonly name: string;
  readonly statusId?: string | null;
  readonly fields?: readonly ProjectFieldAssignmentV1[];
}
export interface UpdateProjectV1 extends ProjectRequestV1 {
  readonly target: ProjectTargetV1;
  readonly expectedRevision: ProjectRevisionV1;
  readonly statusId?: string | null;
  readonly fields?: readonly ProjectFieldAssignmentV1[];
}
export interface CreateProjectTaskV1 extends ProjectRequestV1 {
  readonly target: ProjectTargetV1;
  readonly expectedRevision: ProjectRevisionV1;
  readonly title: string;
}
export interface MoveProjectTaskV1 extends ProjectRequestV1 {
  readonly target: ProjectTargetV1;
  readonly expectedRevision: ProjectRevisionV1;
  readonly taskTarget: TaskTargetV1;
  readonly expectedTaskRevision: TaskRevisionV1;
}
export interface ProjectMutationReceiptV1 {
  readonly providerEpoch: string;
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly expiresAt: number;
  readonly outcome: 'changed' | 'noop' | 'failed';
  readonly effects: EffectStateV1;
  readonly recovery: RecoveryV1;
  readonly project?: { readonly target: ProjectTargetV1; readonly revision: ProjectRevisionV1 };
  readonly task?: { readonly target: TaskTargetV1; readonly revision: TaskRevisionV1 };
  readonly destinationCopy?: 'unchanged' | 'committed' | 'unknown';
  readonly sourceRemoval?: 'unchanged' | 'committed' | 'unknown';
}
export type ProjectMutationResultV1 =
  | { readonly ok: true; readonly receipt: ProjectMutationReceiptV1 }
  | {
      readonly ok: false;
      readonly error: ApiErrorV1;
      readonly effects: EffectStateV1;
      readonly recovery: RecoveryV1;
      readonly receipt?: ProjectMutationReceiptV1;
    };
export interface ProjectsApiV1 {
  readonly schema: (options?: ReadOptionsV1) => Promise<ApiResultV1<ProjectSchemaV1>>;
  readonly list: (
    query?: ListProjectsV1,
    options?: ReadOptionsV1,
  ) => Promise<ApiResultV1<ProjectPageV1>>;
  readonly get: (
    target: ProjectTargetV1,
    options?: ReadOptionsV1,
  ) => Promise<ApiResultV1<ProjectDtoV1>>;
  readonly resolve: (
    input: ResolveProjectV1,
    options?: ReadOptionsV1,
  ) => Promise<ApiResultV1<ProjectResolutionV1>>;
  readonly create: (
    input: CreateProjectV1,
    options?: MutationOptionsV1,
  ) => Promise<ProjectMutationResultV1>;
  readonly update: (
    input: UpdateProjectV1,
    options?: MutationOptionsV1,
  ) => Promise<ProjectMutationResultV1>;
  readonly createTask: (
    input: CreateProjectTaskV1,
    options?: MutationOptionsV1,
  ) => Promise<ProjectMutationResultV1>;
  readonly moveTask: (
    input: MoveProjectTaskV1,
    options?: MutationOptionsV1,
  ) => Promise<ProjectMutationResultV1>;
}

export type RefreshTaskContentV1 = {
  readonly kind: 'refresh';
  readonly plan: ContentPlanTargetV1;
  readonly expectedPlanRevision: ContentPlanRevisionV1;
  readonly afterRequestId?: string;
};
export type TaskCommentTargetV1 = string;
export type ContentPlanTargetV1 = string;
export type ContentPlanRevisionV1 = string;

export interface TaskCommentV1 {
  readonly target: TaskCommentTargetV1;
  readonly parentTarget: TaskTargetV1;
  readonly text: string;
  readonly timestamp?:
    | { readonly precision: 'day'; readonly value: string }
    | { readonly precision: 'instant'; readonly atom: string; readonly epochMs: number };
}
export interface TaskTrackedActivityV1 {
  readonly closedMs: number;
  readonly runningCount: number;
  readonly runningMsAtObservation: number;
  readonly lastRecordedWorkAtMs?: number;
  readonly brokenEntryCount: number;
}
export interface TaskActivityV1 {
  readonly observedAtMs: number;
  readonly own: TaskTrackedActivityV1;
  readonly subtree: TaskTrackedActivityV1;
}
export interface TaskTimeEntryV1 {
  readonly target: string; // opaque read-only occurrence, bound to this tree revision
  readonly parentTarget: TaskTargetV1;
  readonly state: 'running' | 'closed' | 'broken';
  readonly startMs?: number;
  readonly endMs?: number;
  readonly note?: string;
  readonly issue?: 'invalid-start' | 'invalid-end' | 'end-before-start';
}
export type TaskTreeEntryV1 =
  | { readonly kind: 'child'; readonly target: TaskTargetV1 }
  | { readonly kind: 'comment'; readonly target: TaskCommentTargetV1 }
  | { readonly kind: 'time-entry'; readonly target: string };
export interface TaskTreeV1 extends Omit<TaskDtoV1, 'source'> {
  readonly source?: TaskDtoV1['source']; // absent for draft nodes
  readonly description?: string;
  readonly children: readonly TaskTreeV1[];
  readonly comments: readonly TaskCommentV1[];
  readonly activity: TaskActivityV1;
  readonly timeEntries: readonly TaskTimeEntryV1[];
  readonly entries: readonly TaskTreeEntryV1[]; // canonical direct-entry order for this page
  readonly timeEntryCount: number;
  readonly childCount: number;
  readonly commentCount: number;
  readonly complete: boolean; // all own content and recursive descendants present
  readonly truncated: boolean;
}
/** limit bounds direct entries, never scalar text bytes. Expand incomplete children separately. */
export interface ReadTaskTreeV1 {
  readonly target: TaskTargetV1;
  readonly expectedRevision?: TaskRevisionV1;
  readonly plan?: ContentPlanTargetV1;
  readonly expectedPlanRevision?: ContentPlanRevisionV1;
  readonly side?: 'before' | 'after'; // plan reads only, default after
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TaskTreePageV1 extends ObservationV1 {
  readonly tree: TaskTreeV1;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export type TaskFieldV1<T> =
  { readonly type: 'set'; readonly value: T } | { readonly type: 'clear' };
export interface TaskPatchV1 {
  readonly markdownTitle?: TaskFieldV1<string>;
  readonly priority?: TaskFieldV1<'A' | 'B' | 'C' | 'D' | 'E' | 'F'>;
  readonly due?: TaskFieldV1<string>;
  readonly scheduled?: TaskFieldV1<string>;
  readonly start?: TaskFieldV1<string>;
  readonly time?: TaskFieldV1<string>;
  readonly durationMinutes?: TaskFieldV1<number>;
  readonly recurrence?: TaskFieldV1<string>;
  readonly onCompletion?: TaskFieldV1<'keep' | 'delete'>;
  readonly tags?: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  };
}
export interface TaskInitialV1 extends Omit<TaskPatchV1, 'markdownTitle'> {
  readonly statusSymbol?: string;
}
export interface TaskCreateTreeV1 {
  readonly markdownTitle: string;
  readonly initial?: TaskInitialV1;
  readonly description?: string;
  readonly comments?: ReadonlyArray<{ readonly text: string }>;
  readonly children?: readonly TaskCreateTreeV1[];
}
export type TaskContentOperationV1 =
  | { readonly type: 'patch'; readonly target: string; readonly patch: TaskPatchV1 }
  | { readonly type: 'description'; readonly target: string; readonly text: string | null }
  | { readonly type: 'add-child'; readonly target: string; readonly markdownTitle: string }
  | { readonly type: 'remove'; readonly target: string }
  | { readonly type: 'add-comment'; readonly target: string; readonly text: string }
  | { readonly type: 'update-comment'; readonly target: string; readonly text: string }
  | { readonly type: 'remove-comment'; readonly target: string };

export type TaskCreateDestinationV1 =
  | { readonly type: 'configured-default' }
  | {
      readonly type: 'note';
      readonly path: string;
      readonly insertion: TaskInsertionV1;
      readonly provision?: 'if-missing';
    }
  | {
      readonly type: 'project';
      readonly target: ProjectTargetV1;
      readonly expectedRevision: ProjectRevisionV1;
    };
export type TaskInsertionV1 =
  | { readonly type: 'append' | 'prepend' }
  | { readonly type: 'section'; readonly heading: string; readonly position?: 'top' | 'bottom' };

export type PrepareTaskContentV1 =
  | RefreshTaskContentV1
  | {
      readonly kind: 'edit';
      readonly target: TaskTargetV1;
      readonly expectedRevision: TaskRevisionV1;
      readonly operation?: TaskContentOperationV1;
    }
  | {
      readonly kind: 'create';
      readonly destination: TaskCreateDestinationV1;
      readonly tree: TaskCreateTreeV1;
    }
  | {
      readonly kind: 'append';
      readonly plan: ContentPlanTargetV1;
      readonly expectedPlanRevision: ContentPlanRevisionV1;
      readonly operation: TaskContentOperationV1;
    };
/** revision is an opaque plan version; it replaces the numeric observation revision. */
export interface ContentPlanV1 extends Omit<ObservationV1, 'revision'> {
  readonly target: ContentPlanTargetV1;
  readonly revision: ContentPlanRevisionV1;
  readonly kind: 'edit' | 'create';
  readonly expiresAt: number;
  readonly before: TaskTreeV1 | null;
  readonly after: TaskTreeV1 | null;
  readonly destination?: {
    readonly type: TaskCreateDestinationV1['type'];
    readonly path: string;
    readonly insertion: TaskInsertionV1;
    readonly projectTarget?: ProjectTargetV1;
    readonly projectRevision?: ProjectRevisionV1;
  };
}
export interface ApplyTaskContentV1 {
  readonly plan: ContentPlanTargetV1;
  readonly expectedPlanRevision: ContentPlanRevisionV1;
  readonly requestId: string;
  readonly expiresAt: number;
}

export interface SearchTasksV1 extends ListTasksV1 {
  readonly query: string;
  readonly fields?: 'title' | 'body' | 'all';
  readonly matchScope?: 'node' | 'subtree';
}
export interface TaskSearchPageV1 extends TaskPageV1 {
  readonly complete: boolean;
  readonly truncated: boolean;
}
export interface ListTaskTagsV1 {
  readonly path?: string;
  readonly folder?: string;
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TaskTagPageV1 extends ObservationV1 {
  readonly items: readonly string[];
  readonly nextCursor?: string;
  readonly complete: boolean;
  readonly truncated: boolean;
}

export interface ContentCommitTaskContinuityV1 {
  readonly plan: ContentPlanTargetV1;
  readonly planRevision: ContentPlanRevisionV1; // final version actually committed
  readonly correspondence:
    | {
        readonly state: 'complete';
        readonly coverage: 'issued-plan-tasks';
        readonly root: {
          readonly target: TaskTargetV1;
          readonly revision: TaskRevisionV1;
        } | null; // null only for confirmed root deletion
        readonly tasks: ReadonlyArray<{
          readonly preparedTarget: TaskTargetV1;
          readonly committedTarget: TaskTargetV1;
          readonly committedRevision: TaskRevisionV1;
        }>;
      }
    | { readonly state: 'unavailable' | 'redacted' };
}

export interface TaskContentReceiptV1 {
  readonly providerEpoch: string;
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly expiresAt: number;
  readonly plan: ContentPlanTargetV1;
  readonly planRevision: ContentPlanRevisionV1;
  readonly outcome: MutationReceiptV1['outcome'];
  readonly effects: EffectStateV1;
  readonly recovery: RecoveryV1;
  readonly original?: {
    readonly target: TaskTargetV1;
    readonly state: 'retained' | 'removed' | 'unproven';
  };
  readonly task?: { readonly target: TaskTargetV1; readonly revision: TaskRevisionV1 };
  readonly destinationEffects?: NonNullable<ProjectMutationReceiptV1['destinationCopy']>;
  readonly snapshots: 'complete' | 'unavailable' | 'redacted';
  readonly contentContinuity: ContentCommitTaskContinuityV1;
  readonly warnings: readonly MutationWarningV1[];
}
export type TaskContentMutationResultV1 =
  | { readonly ok: true; readonly receipt: TaskContentReceiptV1 }
  | {
      readonly ok: false;
      readonly error: ApiErrorV1;
      readonly effects: EffectStateV1;
      readonly recovery: RecoveryV1;
      readonly receipt?: TaskContentReceiptV1;
    };
