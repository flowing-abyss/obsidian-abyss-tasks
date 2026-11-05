# Public API v1

Abyss Tasks exposes task reads and status transitions to other plugins. A calendar adapter can mirror tasks and send completion/status intents, including the plugin's existing recurrence behavior. The adapter owns remote transport, durable mapping, conflict reconciliation, and calendar event policy. V1 has no task creation, title/date editing, or durable changelog, so it does not provide full two-way calendar sync. See [calendar integration issue #9](https://github.com/flowing-abyss/obsidian-abyss-tasks/issues/9).

The [standalone contract](api.d.ts) defines every field and guarantee; [the architecture](ARCHITECTURE.md#portable-integration-contract) explains ownership and recovery. Copy/vendor `api.d.ts` into your integration and import it as types only. There is no npm SDK. The examples below share one TypeScript module, with the declaration beside it as `./api.d.ts`.

| Call/value                                            | Purpose and arguments                                                                            | Result and safe use                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `provider.getApi(1, { consumerId })`                  | Request exactly v1 from a host-supplied candidate.                                               | `ApiResultV1<TasksApiV1>`; check `ok` and `info.apiVersion`. Unsupported majors fail.                                             |
| `client.info`                                         | Version, epoch, capabilities, and resource limits.                                               | Read page sizes, TTLs, capacity, and request windows here. Capabilities and consumer IDs are not permissions.                     |
| `client.ready({ signal }?)`                           | Wait through initialization.                                                                     | Ready observation or structured error; readiness does not guarantee complete source coverage.                                     |
| `client.subscribe(listener)`                          | Observe invalidations before calling `ready`.                                                    | Result containing unsubscribe; synchronously emits current state. Events may coalesce and carry no task contents or deletion log. |
| `unsubscribe()` / `client.dispose()`                  | Release a subscription / the client's listeners and pending reads.                               | No later callbacks; disposal is idempotent. Accepted writes can still finish.                                                     |
| `tasks.list(query?, options?)`                        | Intersect path **or** folder, statuses, tags, and inclusive date ranges; page with limit/cursor. | Observed page of independent task rows. Continue with the same query and limit; stage all pages before publishing.                |
| `tasks.get(target, options?)`                         | Read an issued occurrence handle.                                                                | Current immutable DTO or error; an expired/excluded handle does not prove physical deletion.                                      |
| `tasks.resolve({ source: { path, line } }, options?)` | Find a task at exact vault-relative coordinates.                                                 | Found, not-found, or ambiguous resolution with observation. Lines are zero-based.                                                 |
| `tasks.resolve({ authoredId }, options?)`             | Look up an authored `🆔` value exactly.                                                          | Same resolution union; IDs can be duplicated. Require explicit selection on ambiguity.                                            |
| `tasks.statuses(options?)`                            | Read configured checkbox symbols and semantic status defaults.                                   | Observed catalog. Use its symbols for `setStatus`; preserve the space symbol.                                                     |
| `tasks.complete(input, options?)`                     | Complete a fresh target/revision, using configured behavior.                                     | Mutation result/receipt; recurrence may create a distinct next occurrence or remove the original.                                 |
| `tasks.setStatus({ ...input, symbol }, options?)`     | Request one configured checkbox character.                                                       | Mutation result/receipt; symbols map to `open`, `in-progress`, `done`, or `cancelled`. `X` normalizes to `x`.                     |
| `tasks.toggleCompletion(input, options?)`             | Deliberately invert current completion state.                                                    | Mutation result/receipt; use for an explicit toggle gesture, never to force a desired remote state.                               |

## Connect and release resources

The host supplies `candidate`; its plugin registry is outside this API contract. An Obsidian JavaScript plugin can pass `this.app.plugins?.plugins?.['abyss-tasks']` as `candidate` (absent or disabled means unavailable); isolate this host-specific lookup, which is outside v1 and Obsidian's public typings. Register both cleanup callbacks with your own plugin lifecycle. Subscription callbacks should schedule a rescan, retaining the latest observation even during initialization.

```ts
import type {
  ApiAbortSignalV1,
  ApiEventV1,
  ApiResultV1,
  ListTasksV1,
  MutationResultV1,
  ObservationV1,
  StatusMutationV1,
  TaskDtoV1,
  TasksApiProviderV1,
  TasksApiV1,
  TaskStatusV1,
} from './api';

function value<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(`${result.error.category}:${result.error.code}`);
  return result.value;
}

async function connect(
  candidate: unknown,
  registerCleanup: (fn: () => void) => void,
  onInvalidation: (event: ApiEventV1) => void,
) {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !('getApi' in candidate) ||
    typeof candidate.getApi !== 'function'
  )
    return;
  const provider = candidate as TasksApiProviderV1;
  const result = provider.getApi(1, { consumerId: 'my-calendar-adapter' });
  if (!result.ok) throw new Error(result.error.code);
  const client = result.value;
  registerCleanup(() => client.dispose());
  if (client.info.apiVersion !== 1) {
    client.dispose();
    return;
  }
  let latest: ObservationV1 | undefined;
  try {
    const unsubscribe = value(
      client.subscribe((event) => {
        latest = event;
        onInvalidation(event);
      }),
    );
    registerCleanup(unsubscribe);
    value(await client.ready());
    return { client, latest: () => latest };
  } catch (error) {
    client.dispose();
    throw error;
  }
}
```

`value` is a compact example helper. A consumer should route structured failures to its own diagnostics or UI; API calls do not show Obsidian notices. Listener exceptions are isolated. Unload ends the provider epoch: reconnect and resolve tasks again.

## Read a coherent calendar snapshot

DTOs are detached, recursively frozen plain values; do not mutate them. `source.path` preserves authored case/Unicode and uses vault-relative POSIX paths. `source.line` is an absolute zero-based physical line, including ancestor offsets. Dates are `YYYY-MM-DD` civil dates, not UTC instants; invalid or unsupported authored dates are omitted. Nested tasks are independent rows with `parentTarget` and can match a filter even when their parent does not.

Filters compose as intersections. Folder boundaries include descendants (`Projects` excludes `Projects-old`); `folder: ''` selects the vault root. Tags use case-insensitive identity. Empty filter arrays, duplicate statuses/date fields, and combined path/folder are invalid.

```ts
function sameObservation(a: ObservationV1, b: ObservationV1): boolean {
  return (
    ['providerEpoch', 'revision', 'generation', 'scopeRevision', 'semanticsRevision'] as const
  ).every((field) => a[field] === b[field]);
}

async function scanInto(
  client: TasksApiV1,
  query: Omit<ListTasksV1, 'cursor'>,
  latest: () => ObservationV1 | undefined,
  publish: (rows: readonly TaskDtoV1[]) => void,
  signal?: ApiAbortSignalV1,
): Promise<ApiResultV1<void>> {
  const rows: TaskDtoV1[] = [];
  let basis: ObservationV1 | undefined;
  let cursor: string | undefined;
  const invalidated = {
    ok: false,
    error: { category: 'conflict', code: 'SCAN_INVALIDATED', message: 'Restart the scan.' },
  } as const;
  do {
    const result = await client.tasks.list(
      { ...query, ...(cursor ? { cursor } : {}) },
      signal ? { signal } : undefined,
    );
    if (!result.ok) return result;
    const page = result.value;
    basis ??= page;
    if (!sameObservation(page, basis)) return invalidated;
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const current = latest();
  if (!current || !sameObservation(basis, current)) return invalidated;
  publish(rows); // Synchronous mirror replacement: no await after the check.
  return { ok: true, value: undefined };
}

async function refreshCalendar(
  client: TasksApiV1,
  latest: () => ObservationV1 | undefined,
  replaceMirror: (rows: readonly TaskDtoV1[]) => void,
  signal?: ApiAbortSignalV1,
) {
  return scanInto(
    client,
    {
      folder: 'Projects',
      statuses: ['open', 'in-progress'],
      tagsAll: ['#work'],
      dates: [{ field: 'due', from: '2026-11-01', to: '2026-11-30' }],
      limit: client.info.limits.defaultPageSize,
    },
    latest,
    replaceMirror,
    signal,
  );
}
```

Pass `connect`'s `latest` function and a synchronous mirror replacement callback. The query and limit must stay unchanged during the scan. `SCAN_INVALIDATED` above is consumer-defined. Restart after it, `STALE_CURSOR`, or `INCOMPLETE_READ`; retain your prior published mirror on failure. Schedule retries after relevant changes instead of spinning while coverage is unavailable. A scoped read can be incomplete even because of an unreadable empty note; narrowing the scope can help only when the failed source is outside it. Absence, exclusion, or failed reads never establish physical deletion.

## Resolve identity before acting

Targets and revisions are opaque handles for one provider epoch, subject to idle TTL/capacity limits. Do not decode, manufacture, or persist them as durable IDs. A target can survive proven relocation while its revision changes. Revisions cover the whole root, including siblings, descendants, and semantics: reread before each distinct write. Authored IDs and source coordinates aid reacquisition but do not themselves authorize a write.

```ts
async function findById(
  client: TasksApiV1,
  authoredId: string,
  chooseSource: (
    candidates: readonly TaskDtoV1[],
    truncated: boolean,
  ) => Promise<TaskDtoV1['source'] | undefined>,
): Promise<TaskDtoV1 | undefined> {
  const resolution = value(await client.tasks.resolve({ authoredId }));
  if (resolution.type === 'not-found') return;
  if (resolution.type === 'found') return resolution.task;
  const source = await chooseSource(resolution.candidates, resolution.truncated);
  if (!source) return; // Never pick an arbitrary ambiguous candidate.
  const chosen = resolution.candidates.find(
    (task) => task.source.path === source.path && task.source.line === source.line,
  );
  if (!chosen) return;
  const selected = value(await client.tasks.resolve({ source }));
  return selected.type === 'found' && selected.task.target === chosen.target
    ? selected.task
    : undefined; // A moved/replaced line needs a new selection.
}
```

`chooseSource` selects from the supplied candidates through an explicit user choice or independently verified mapping. Re-resolution must retain that chosen target; a stale source choice cannot silently select a replacement occurrence. `truncated` means the candidate list is incomplete; reacquire/refine the lookup when more choices are needed. A new provider epoch requires reconciliation and fresh resolution, including another ambiguity check.

## Send status intents and retry safely

The host's `newRequestId` must produce a never-reused ID for each distinct operation, including across reloads and expiry. `now` returns current Unix milliseconds; keep the host clock reasonable. The deadline permits acceptance, not completion: accepted work may finish later. A new write needs both a new ID and a freshly read revision.

```ts
function inputFor(
  client: TasksApiV1,
  task: TaskDtoV1,
  newRequestId: () => string,
  now: () => number,
): StatusMutationV1 {
  return {
    target: task.target,
    expectedRevision: task.revision,
    requestId: newRequestId(),
    expiresAt: now() + Math.min(30_000, client.info.limits.maxRequestWindowMs),
  };
}

async function setDesiredStatus(
  client: TasksApiV1,
  target: string,
  desired: TaskStatusV1,
  newRequestId: () => string,
  now: () => number,
): Promise<MutationResultV1> {
  const task = value(await client.tasks.get(target));
  const catalog = value(await client.tasks.statuses());
  const entry = catalog.items.find((item) => item.status === desired && item.defaultForStatus);
  if (!entry) throw new Error(`No configured default for ${desired}`);
  return client.tasks.setStatus({
    ...inputFor(client, task, newRequestId, now),
    symbol: entry.symbol,
  });
}

async function completeWithRetry(
  client: TasksApiV1,
  target: string,
  newRequestId: () => string,
  now: () => number,
): Promise<MutationResultV1> {
  const task = value(await client.tasks.get(target));
  const input = inputFor(client, task, newRequestId, now);
  const result = await client.tasks.complete(input);
  if (!result.ok && result.recovery === 'retry-same-request' && now() < input.expiresAt) {
    return client.tasks.complete(input); // Identical method/payload/deadline, once here.
  }
  return result;
}

async function deliberateToggle(
  client: TasksApiV1,
  target: string,
  newRequestId: () => string,
  now: () => number,
): Promise<MutationResultV1> {
  const current = value(await client.tasks.get(target));
  return client.tasks.toggleCompletion(inputFor(client, current, newRequestId, now));
}
```

Each function performs one intent; a caller must inspect its result before deciding on another. Read the task revision before the catalog so a later semantic change rejects the intent instead of pairing an old symbol mapping with a newer revision. Handle conflicts and do not trim a catalog symbol. To advance a recurring task, inspect the receipt's distinct `next.target`, reread it, and send a new request only for a deliberate next-occurrence intent.

Deduplication uses `(providerEpoch, consumerId, requestId)` across that consumer's clients. While retained and unexpired, identical accepted requests join/replay the original outcome, including failures, before fresh readiness/revision checks. Preserve method, target, expected revision, normalized symbol, ID, and deadline. Never extend a retry's deadline or repurpose an ID. Signal/client identity is excluded from payload equality. Capacity is bounded; expired settled records can be reclaimed. Replay is in memory and offers no exactly-once guarantee across provider unload. Missing responses, expiry, or reload require fresh reads/reconciliation before a new operation.

## Effects, recovery, and errors

A receipt describes historical effects; it is not a fresh read. It can report `changed`, `noop`, or `failed`. The original may be `retained`, `removed`, or `unproven`; recurrence Keep retains history and may create a next occurrence, while Delete removes the selected occurrence and may create a next one. Nonrecurring deletion has no next. Nested removal refers to the selected node. `unproven` never claims deletion.

Use `effects` and `recovery` on failures, and on successful receipts. `unchanged` confirms no effects; `committed` records proven effects; `partial` means some effects occurred; `unknown` needs reconciliation. A committed status can accompany tracking warnings. `snapshots` can be `complete`, `unavailable`, or `redacted` under current disclosure policy. A replay can omit DTOs without undoing the historical effects. Accepted state is published before receipts settle; invalidations still require a coherent rescan.

| Recovery             | Consumer action                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `none`               | Do not repeat known effects. Read again when current state is needed.                                                    |
| `reread`             | Obtain fresh state/revision, reconsider intent, then use a new ID for a distinct write.                                  |
| `retry-same-request` | Retry the identical request only within its original deadline; respect capacity/backoff.                                 |
| `reconcile`          | Keep prior mirror state until a coherent read succeeds; compare actual source/remote state before making another intent. |

An I/O rejection can follow an actual write. Accepted metadata evidence can still establish a committed result; source readback alone may leave occurrence identity unproven. Do not repeat committed, partial, or unknown effects just to recover a missing snapshot. An accepted failure such as `INCOMPLETE_READ` replays that failure; successful later coverage does not turn the old request into new work.

Dispatch on `error.code` and use `error.category` for fallback policy. Examples: `REVISION_CONFLICT` needs a fresh read; `STALE_CURSOR` restarts paging; `INCOMPLETE_READ` retains the prior mirror; `EXPIRED_TARGET` requires reacquisition; `DISPOSED` requires reconnection when appropriate. Validation/unsupported errors need corrected input or capability handling; blocked/conflict errors need a new decision; unavailable/resource/lifecycle errors need readiness or backoff; io/internal errors need diagnostics and the mutation's effect/recovery guidance. Codes are extensible: unknown codes must preserve state and be reported with category and optional `diagnosticId`. Never branch on explanatory messages.

Reads and writes accept an optional structural `ApiAbortSignalV1`; a standard `AbortSignal` is compatible without adding DOM types to this contract. The `signal` parameter in `refreshCalendar` shows portable use. Abort before admission writes nothing. After reservation, cancellation or client disposal cannot cancel shared accepted work, erase its receipt, or imply rollback. Register cleanup even when aborting. Provider unload ends receipt retention; reconcile on reconnect.
