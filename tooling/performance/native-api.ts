import type { ObservationV1, TaskDtoV1, TasksApiProviderV1, TasksApiV1 } from '../../api.d.ts';
import { plugin, waitFor } from './native-helpers.ts';
import type { Measure } from './native-scenarios.ts';
import type { Host, NativeOptions } from './native-types.ts';

function connect(host: Host): TasksApiV1 {
  const candidate: unknown = plugin(host);
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !('getApi' in candidate) ||
    typeof candidate.getApi !== 'function'
  )
    throw new Error('Unsupported API profile: plugin does not provide getApi(1)');
  const result = (candidate as TasksApiProviderV1).getApi(1, {
    consumerId: 'abyss-performance-api',
  });
  if (!result.ok) throw new Error(`API profile discovery failed: ${result.error.code}`);
  return result.value;
}

function assertMatchingObservation(expected: ObservationV1, actual: ObservationV1): void {
  if (
    expected.providerEpoch !== actual.providerEpoch ||
    expected.revision !== actual.revision ||
    expected.generation !== actual.generation ||
    expected.scopeRevision !== actual.scopeRevision ||
    expected.semanticsRevision !== actual.semanticsRevision
  )
    throw new Error('API scan observation changed');
}

const taskFields = new Set([
  'target',
  'revision',
  'title',
  'markdownTitle',
  'status',
  'statusSymbol',
  'priority',
  'dates',
  'time',
  'durationMinutes',
  'tags',
  'recurrence',
  'onCompletion',
  'onCompletionExplicit',
  'authoredId',
  'source',
  'parentTarget',
]);

/** Only detached physical task DTOs belong to this workload. */
function collectPhysicalTask(task: TaskDtoV1, folder: string, targets: Set<string>): void {
  if (
    Object.keys(task).some((key) => !taskFields.has(key)) ||
    Object.keys(task.source).some((key) => key !== 'path' && key !== 'line') ||
    typeof task.target !== 'string' ||
    task.target.length === 0 ||
    !task.source.path.startsWith(`${folder}/`) ||
    !Number.isSafeInteger(task.source.line) ||
    task.source.line < 0
  )
    throw new Error('Invalid physical API task or raw source disclosure');
  if (targets.has(task.target)) throw new Error('Duplicate API target');
  targets.add(task.target);
}

async function scan(
  client: TasksApiV1,
  options: NativeOptions,
  latestRevision: () => number | undefined,
): Promise<{ nodes: number; pages: number; pageSize: number }> {
  let cursor: string | undefined;
  let pages = 0;
  const targets = new Set<string>();
  let firstObservation: ObservationV1 | undefined;
  let lastSource: TaskDtoV1['source'] | undefined;
  function assertNextSourceCoordinate(source: TaskDtoV1['source']): void {
    if (
      lastSource !== undefined &&
      (source.path < lastSource.path ||
        (source.path === lastSource.path && source.line <= lastSource.line))
    )
      throw new Error('API scan source order is not deterministic');
    lastSource = source;
  }
  do {
    const result = await client.tasks.list({
      folder: options.fixtureFolder,
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!result.ok) throw new Error(`API scan failed: ${result.error.code}`);
    firstObservation ??= result.value;
    assertMatchingObservation(firstObservation, result.value);
    for (const task of result.value.items) {
      collectPhysicalTask(task, options.fixtureFolder, targets);
      assertNextSourceCoordinate(task.source);
    }
    cursor = result.value.nextCursor;
    pages += 1;
  } while (cursor !== undefined);
  if (targets.size !== options.expectedNodes || firstObservation.revision !== latestRevision())
    throw new Error('Incomplete or invalidated API scan');
  return { nodes: targets.size, pages, pageSize: 100 };
}

type MutationResult = Awaited<ReturnType<TasksApiV1['tasks']['complete']>>;
type Receipt = Extract<MutationResult, { readonly ok: true }>['receipt'];

function assertCommitted(receipt: Receipt): void {
  if (
    receipt.effects !== 'committed' ||
    receipt.outcome !== 'changed' ||
    receipt.snapshots !== 'complete' ||
    receipt.warnings.length !== 0 ||
    receipt.next !== undefined
  )
    throw new Error('API status receipt did not prove a complete committed change');
}

function completedOriginal(result: MutationResult, target: string): TaskDtoV1 {
  if (!result.ok) throw new Error(`API status completion failed: ${result.error.code}`);
  assertCommitted(result.receipt);
  const original = result.receipt.original;
  if (
    original.target !== target ||
    original.state !== 'retained' ||
    original.task?.status !== 'done'
  )
    throw new Error('API status original is not retained and done');
  return original.task;
}

async function status(
  client: TasksApiV1,
  sandbox: TaskDtoV1,
): Promise<{ writes: number; requests: number; replays: number; hydrated: number }> {
  const input = {
    target: sandbox.target,
    expectedRevision: sandbox.revision,
    requestId: crypto.randomUUID(),
    expiresAt: Date.now() + 300_000,
  };
  const first = await client.tasks.complete(input);
  const replay = await client.tasks.complete(input);
  const original = completedOriginal(first, input.target);
  if (JSON.stringify(replay) !== JSON.stringify(first))
    throw new Error('API status replay mismatch');
  const final = await client.tasks.get(input.target);
  if (
    !final.ok ||
    final.value.status !== 'done' ||
    final.value.target !== input.target ||
    final.value.revision !== original.revision
  )
    throw new Error('API status final hydration failed');
  return { writes: 1, requests: 2, replays: 1, hydrated: 1 };
}

type ProfileQueries = NonNullable<Host['plugins']['plugins'][string]>['queries'];
type CreatedTask = Extract<ReturnType<ProfileQueries['resolve']>, { type: 'exact' }>['task'];
interface CreationObservation {
  readonly path: string;
  readonly file: NonNullable<ReturnType<Host['vault']['getFileByPath']>>;
  metadataStamp: number;
  metadataContent: string | undefined;
  acceptedStamp: number;
  closed: boolean;
}

function observeCreation(
  host: Host,
  path: string,
  signal: AbortSignal,
): { readonly state: CreationObservation; readonly close: () => void } {
  const file = host.vault.getFileByPath(path);
  if (file === null) throw new Error('API status fixture inbox missing');
  const state: CreationObservation = {
    path,
    file,
    metadataStamp: 0,
    metadataContent: undefined,
    acceptedStamp: 0,
    closed: false,
  };
  const cleanups: Array<() => void> = [];
  const close = (): void => {
    state.closed = true;
    state.metadataContent = undefined;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  const accepted = (files: readonly string[]): void => {
    if (files.includes(path)) state.acceptedStamp = state.metadataStamp;
  };
  try {
    const ref = host.metadataCache.on('changed', (updated, content) => {
      if (updated !== file || updated.path !== path) return;
      state.metadataStamp += 1;
      state.metadataContent = content;
    });
    cleanups.push(() => {
      host.metadataCache.offref(ref);
    });
    const queries = plugin(host).queries;
    cleanups.push(
      queries.subscribe((event) => {
        if (event.type === 'changed') accepted(event.files);
      }),
    );
    cleanups.push(queries.subscribeReconciled(accepted));
    signal.addEventListener('abort', close, { once: true });
    cleanups.push(() => {
      signal.removeEventListener('abort', close);
    });
    if (signal.aborted) throw new Error('API status preparation cancelled');
    return { state, close };
  } catch (error) {
    close();
    throw error;
  }
}

function assertCreationFile(host: Host, state: CreationObservation): void {
  if (state.closed) throw new Error('API status preparation cancelled');
  if (state.file.path !== state.path || host.vault.getFileByPath(state.path) !== state.file)
    throw new Error('API status fixture inbox identity changed');
}

function assertCreatedRoot(queries: ProfileQueries, created: CreatedTask): void {
  const current = queries.resolve(created.ref);
  if (
    current.type !== 'exact' ||
    current.task.ref.filePath !== created.ref.filePath ||
    current.task.ref.line !== created.ref.line ||
    current.task.ref.revision !== created.ref.revision ||
    current.task.source.originalBlock !== created.source.originalBlock
  )
    throw new Error('API status sandbox canonical root changed');
}

async function settleCreation(
  host: Host,
  state: CreationObservation,
  created: CreatedTask,
): Promise<void> {
  assertCreationFile(host, state);
  const expected = await host.vault.read(state.file);
  const block = created.source.originalBlock;
  const physical = expected
    .split('\n')
    .slice(created.ref.line, created.ref.line + block.split('\n').length)
    .join('\n');
  if (physical !== block) throw new Error('API status sandbox source block changed');
  await waitFor(
    async () => {
      assertCreationFile(host, state);
      const stamp = state.metadataStamp;
      if (stamp === 0 || state.acceptedStamp !== stamp || state.metadataContent !== expected)
        return false;
      const content = await host.vault.read(state.file);
      const cached = await host.vault.cachedRead(state.file);
      assertCreationFile(host, state);
      if (content !== expected) throw new Error('API status sandbox contents changed');
      if (cached !== expected || state.metadataStamp !== stamp) return false;
      assertCreatedRoot(plugin(host).queries, created);
      return true;
    },
    'API status sandbox metadata and canonical acceptance',
    30000,
  );
}

async function prepareStatus(
  host: Host,
  client: TasksApiV1,
  options: NativeOptions,
  signal: AbortSignal,
): Promise<TaskDtoV1> {
  const observation = observeCreation(host, `${options.fixtureFolder}/inbox.md`, signal);
  try {
    const created = await plugin(host).tasks.execute({
      type: 'create',
      markdownBody: 'Profile API status sandbox',
      destination: { type: 'configured-default' },
    });
    if (created.type !== 'ok' || created.outcome.type !== 'task')
      throw new Error('API status sandbox creation did not return a task');
    const ref = created.outcome.task.ref;
    if (ref.filePath !== observation.state.path)
      throw new Error('API status sandbox escaped the fixture inbox');
    await settleCreation(host, observation.state, created.outcome.task);
    const resolved = await client.tasks.resolve({ source: { path: ref.filePath, line: ref.line } });
    if (!resolved.ok || resolved.value.type !== 'found')
      throw new Error('API status sandbox resolution failed');
    return resolved.value.task;
  } finally {
    observation.close();
  }
}

export async function apiScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const preparation = new AbortController();
  let client: TasksApiV1 | undefined;
  let unsubscribe: (() => void) | undefined;
  let latestRevision: number | undefined;
  try {
    await measure(
      'api.scan',
      async () => {
        if (client === undefined) throw new Error('API scan preparation missing');
        return scan(client, options, () => latestRevision);
      },
      async () => {
        client = connect(host);
        const ready = await client.ready();
        if (!ready.ok) throw new Error(`API profile readiness failed: ${ready.error.code}`);
        const subscription = client.subscribe((event) => {
          latestRevision = event.revision;
        });
        if (!subscription.ok)
          throw new Error(`API profile subscription failed: ${subscription.error.code}`);
        unsubscribe = subscription.value;
      },
    );
    const active = client;
    if (active === undefined) throw new Error('API profile client missing');
    let sandbox: TaskDtoV1 | undefined;
    await measure(
      'api.status',
      async () => {
        if (sandbox === undefined) throw new Error('API status preparation missing');
        return status(active, sandbox);
      },
      async () => {
        sandbox = await prepareStatus(host, active, options, preparation.signal);
      },
    );
  } finally {
    preparation.abort();
    try {
      unsubscribe?.();
    } finally {
      client?.dispose();
    }
  }
}
