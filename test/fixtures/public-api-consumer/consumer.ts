import type {
  ApiAbortSignalV1,
  ApiResultV1,
  MutationResultV1,
  ResolutionV1,
  TaskDtoV1,
  TasksApiProviderV1,
  TasksApiV1,
} from '../../../api';

function value<T>(result: ApiResultV1<T>): T | undefined {
  if (result.ok) return result.value;
  const error: { category: string; code: string } = result.error;
  if (error.code.length === 0) throw new Error(error.category);
  return undefined;
}
function resolution(result: ResolutionV1): TaskDtoV1 | undefined {
  switch (result.type) {
    case 'found':
      return result.task;
    case 'not-found':
      return undefined;
    case 'ambiguous':
      return undefined; // The host must explicitly disambiguate before writing.
  }
}
function mutation(result: MutationResultV1): string {
  if (result.ok) return result.receipt.original.state;
  return result.receipt?.outcome ?? `${result.error.code}:${result.effects}:${result.recovery}`;
}
async function exerciseStatusIntents(
  client: TasksApiV1,
  task: TaskDtoV1,
  signal: ApiAbortSignalV1,
  host: { readonly newRequestId: () => string; readonly now: () => number },
): Promise<void> {
  const { newRequestId, now } = host;
  const inputFor = (current: TaskDtoV1) => ({
    target: current.target,
    expectedRevision: current.revision,
    requestId: newRequestId(),
    expiresAt: now() + client.info.limits.maxRequestWindowMs,
  });
  const current = value(await client.tasks.get(task.target, { signal }));
  if (current === undefined) return;
  const completed = await client.tasks.complete(inputFor(current), { signal });
  mutation(completed);
  if (!completed.ok) return;
  const fresh = value(await client.tasks.get(current.target, { signal }));
  const catalog = value(await client.tasks.statuses({ signal }));
  const open = catalog?.items.find((item) => item.status === 'open' && item.defaultForStatus);
  if (fresh === undefined || open === undefined) return;
  const reopened = await client.tasks.setStatus(
    { ...inputFor(fresh), symbol: open.symbol },
    { signal },
  );
  mutation(reopened);
  if (!reopened.ok) return;
  const latest = value(await client.tasks.get(fresh.target, { signal }));
  if (latest === undefined) return;
  mutation(await client.tasks.toggleCompletion(inputFor(latest), { signal }));
}
export async function consume(
  provider: TasksApiProviderV1,
  newRequestId: () => string,
  now: () => number,
): Promise<void> {
  const discovered = provider.getApi(1, { consumerId: 'fixture' });
  if (!discovered.ok) return;
  const client = discovered.value;
  const signal: ApiAbortSignalV1 = {
    aborted: false,
    addEventListener(_type, _listener, _options): void {},
    removeEventListener(_type, _listener): void {},
  };
  let latestRevision = -1;
  const subscribed = client.subscribe((event) => {
    latestRevision = event.revision;
  });
  try {
    if (!subscribed.ok || value(await client.ready({ signal })) === undefined) return;
    const page = value(
      await client.tasks.list({ limit: client.info.limits.maxPageSize }, { signal }),
    );
    const resolved = value(await client.tasks.resolve({ authoredId: 'authored' }, { signal }));
    if (resolved !== undefined) resolution(resolved);
    const task = page?.items[0];
    if (task === undefined) return;
    value(await client.tasks.resolve({ source: task.source }, { signal }));
    await exerciseStatusIntents(client, task, signal, { newRequestId, now });
    if (latestRevision < 0) throw new Error('Missing initial subscription state.');
  } finally {
    if (subscribed.ok) subscribed.value();
    client.dispose();
  }
}
