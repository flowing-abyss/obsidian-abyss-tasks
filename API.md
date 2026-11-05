# Abyss Tasks API v1

Other Obsidian plugins can read tasks, subscribe to changes and update task statuses. For TypeScript, copy the standalone declaration into your project. [api.d.ts](api.d.ts)

## Connect and read a page

In an Obsidian JavaScript plugin, pass `this.app.plugins?.plugins?.['abyss-tasks']` to `firstOpenPage` below after checking that the instance has a callable `getApi`. The registry lookup is specific to Obsidian.

```ts
import type * as Abyss from './api';

async function firstOpenPage(provider: Abyss.TasksApiProviderV1) {
  const opened = provider.getApi(1, { consumerId: 'my-plugin' });
  if (!opened.ok) return opened;
  const client = opened.value;
  try {
    if (client.info.apiVersion !== 1) throw new Error('Unsupported API version');
    const ready = await client.ready();
    if (!ready.ok) return ready;
    return await client.tasks.list({ statuses: ['open'], limit: 20 });
  } finally {
    client.dispose();
  }
}
```

A successful read returns `{ ok: true, value }`. On failure, use `error.code` and fall back to `error.category` for unfamiliar codes. If you keep a client across calls, dispose it when your plugin unloads.

## Methods

`tasks` below means `client.tasks`. Reads, writes and `ready` take an optional final `{ signal }` argument.

| Call                                                                           | Purpose                                                                                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.getApi(1, { consumerId })`                                           | Open a v1 client. Use your plugin ID as its request namespace.                                                                               |
| `client.info`                                                                  | Inspect the API and plugin versions, provider epoch, capabilities and current limits.                                                        |
| `client.ready()`                                                               | Wait for initialization. A later read can still be incomplete.                                                                               |
| `client.subscribe(listener)`                                                   | Receive the current state immediately, then notifications when data or state changes. If `result.ok`, call `result.value()` to unsubscribe.  |
| `client.dispose()`                                                             | Release this client, its subscriptions and pending reads.                                                                                    |
| `tasks.list(query?)`                                                           | Read one page of `items` with an optional `nextCursor`. Combine `path` or `folder` with `statuses`, `tagsAll` and inclusive `dates` filters. |
| `tasks.get(target)`                                                            | Read the current snapshot of a task occurrence.                                                                                              |
| `tasks.resolve({ authoredId })` or `tasks.resolve({ source: { path, line } })` | Look up a `🆔` value or a vault-relative path and zero-based line. On success, `value.type` is `found`, `not-found` or `ambiguous`.          |
| `tasks.statuses()`                                                             | List checkbox symbols and their mappings to `open`, `in-progress`, `done` or `cancelled`. `defaultForStatus` marks the default symbol.       |
| `tasks.complete(input)`                                                        | Mark a task done using its configured completion and recurrence rules.                                                                       |
| `tasks.setStatus({ ...input, symbol })`                                        | Apply a configured checkbox symbol. Preserve the space character when using it as a symbol.                                                  |
| `tasks.toggleCompletion(input)`                                                | Reopen a done task or complete an unfinished one.                                                                                            |

## Reading tasks

Task snapshots are immutable. Dates use `YYYY-MM-DD`. A `target` identifies one occurrence in the current provider epoch and can expire. After a provider reload, reconnect and resolve the task again. If an authored ID matches several tasks, confirm which candidate you mean before writing.

Pass `nextCursor` as `cursor` with the same filters and limit. For a consistent scan, subscribe before the first page. The `ObservationV1` values must match across pages and still match the latest event when you use the combined result. Discard the staged pages and restart after an intervening change, `STALE_CURSOR` or `INCOMPLETE_READ`.

## Changing a status

All three write methods use a freshly read task, a unique ID for the operation, and an acceptance deadline in Unix milliseconds. The revision covers the whole task block and its status rules. When choosing a symbol for `setStatus`, read the task **before** calling `statuses()` so a settings change invalidates the captured revision.

```ts
declare const client: Abyss.TasksApiV1;
declare const task: Abyss.TaskDtoV1;
declare const requestId: string;

const input = {
  target: task.target,
  expectedRevision: task.revision,
  requestId,
  expiresAt: Date.now() + client.info.limits.maxRequestWindowMs,
};
const result = await client.tasks.complete(input);
```

On success, check `result.receipt.effects` and `result.receipt.recovery`. The receipt records what happened to the original task and may identify a distinct `next` occurrence for a recurring task. Task snapshots in the receipt are optional. On failure, `error`, `effects` and `recovery` are on the result itself. Accepted writes can finish after cancellation or client disposal.

For `retry-same-request`, repeat the same call with the original `input` before `expiresAt`. Within one provider epoch, matching requests with the same `consumerId` and `requestId` share the accepted outcome, including failures. For `reread`, fetch the task again. For `reconcile`, or after expiry or a reload, check what took effect before issuing a new request.
