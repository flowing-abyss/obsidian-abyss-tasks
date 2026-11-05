# Abyss Tasks API v1

Other Obsidian plugins can read and update tasks, work with project notes and subscribe to changes. For TypeScript, copy the standalone declaration into your project. [api.d.ts](api.d.ts)

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

## Projects

Check `client.projects` before use. Earlier v1 providers expose only the task methods. A project is a permitted Markdown note matching the user's project query, including a note with zero tasks. These methods work with the panel closed.

| Call on `client.projects`                                                              | Purpose                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema()`                                                                             | Read status choices and the field IDs, types, writable flags and suggestions available in this vault.                                                                                                           |
| `list({ limit?, cursor? }?)`                                                           | Page through project summaries in vault-path order, with status, root task counts and tracking totals.                                                                                                          |
| `get(target)`                                                                          | Read current project detail, including note tags and configured fields.                                                                                                                                         |
| `resolve({ path })`                                                                    | Look up an exact vault-relative Markdown path. Check for `found` or `not-found`.                                                                                                                                |
| `create({ name, statusId?, fields?, ...request })`                                     | Create the note in the configured folder using the usual collision policy and initial task section. Static templates support the core date, time and title substitutions. Executable templates are unsupported. |
| `update({ target, expectedRevision, statusId?, fields?, ...request })`                 | Apply the supplied status and field changes together to one note.                                                                                                                                               |
| `createTask({ target, expectedRevision, title, ...request })`                          | Insert a root task from a single input line, using dashboard placement, prefix and lifecycle settings.                                                                                                          |
| `moveTask({ target, expectedRevision, taskTarget, expectedTaskRevision, ...request })` | Move a root and its descendants into this project with dashboard move placement. Selecting a root already in the project yields a checked no-op.                                                                |

`request` supplies a unique `requestId` and an `expiresAt` deadline as for task writes. For a schema-dependent edit, read the project first, then call `schema()` and write with the captured project revision. A source edit or configuration change can invalidate that revision. Project targets identify one file incarnation at one path. Resolve again after a rename, replacement or reload.

```ts
async function addProjectTask(client: Abyss.TasksApiV1, path: string, requestId: string) {
  const projects = client.projects;
  if (projects === undefined) return;
  const found = await projects.resolve({ path });
  if (!found.ok || found.value.type !== 'found') return found;
  const project = found.value.project;
  return projects.createTask({
    target: project.target,
    expectedRevision: project.revision,
    title: 'Review the draft',
    requestId,
    expiresAt: Date.now() + client.info.limits.maxRequestWindowMs,
  });
}
```

Use `tasks.list({ path: project.path })` to read all physical occurrences in the note, including children. Project progress counts roots. Task and project pages share the subscription observation. If you combine pages or require a current project association, subscribe before scanning and verify that the final observation and project revision still match.

**Fields and statuses.** Pass assignments as `{ fieldId, value }`, using writable schema IDs such as `start`, `end`, `description` or `property:<configured-name>`. Text takes a string, number takes a finite number, checkbox takes a boolean, list takes an array of strings or finite numbers, and tags take a string array. Custom dates use `YYYY-MM-DD` and custom datetimes use a local ISO date and time. Curated start and end also accept ISO datetimes with a `Z` or numeric timezone offset. Presets offer a typed `value` and sometimes a `displayName` label. You can also supply another value of the field's type.

Omit a field to preserve it. Clear it with `null`. An empty string or array in a new assignment is invalid. Reads distinguish absent, supported values (including zero and false), and unsupported authored values. Derived name, progress, tracking and aggregated note tags are read-only. A configured frontmatter tags field can be writable.

Use `statusId` for a status change. Pick an ID from `schema().statuses` or pass `null` to clear it. Omission at creation uses the configured default or the first available choice when the default is blank. A summary distinguishes absent status, a configured ID, an unrecognized authored label and an unsupported value. Unavailable bindings, ambiguous keys and unknown property-definition versions restrict which fields can be read or changed.

**Receipts and recovery.** An accepted project write returns a receipt even on failure. Its optional project and task references contain only opaque targets and revisions. Each delivery checks current permission for each reference. A confirmed write can lose its reference before delivery. For a move, inspect both `destinationCopy` and `sourceRemoval`. Each can be `unchanged`, `committed` or `unknown`. Another edit can intervene between copy and removal. If only the copy committed, both notes can contain the subtree. Reread the permitted endpoints before deciding how to recover. Retrying the original input before `expiresAt` in the same epoch replays the receipt. Folder creation can likewise survive a failed project creation.

**Limits.** Read `info.projectLimits` for the provider's values. Initial limits are 64 assignments per write, 256 items per field, 16,384 UTF-16 units per text value, 65,536 UTF-8 JSON bytes per normalized write, 262,144 bytes per project result and 4 MiB of retained project request payloads. Oversized schemas, details and pages return `RESOURCE_LIMIT`. A smaller page can fit even when a larger page fails. The target and cursor capacities and TTLs in `info.limits` apply separately to tasks and projects. Both namespaces share client lifetimes, consumer IDs and request quotas. Reusing an accepted ID across methods returns `REQUEST_ID_REUSED`.
