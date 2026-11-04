import type {
  ApiAbortSignalV1,
  ApiResultV1,
  MutationResultV1,
  ResolutionV1,
  TaskDtoV1,
  TasksApiProviderV1,
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
      return result.truncated ? undefined : result.candidates[0];
  }
}
function mutation(result: MutationResultV1): string {
  if (result.ok) return result.receipt.original.state;
  return result.receipt?.outcome ?? `${result.error.code}:${result.effects}:${result.recovery}`;
}
export async function consume(provider: TasksApiProviderV1): Promise<void> {
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
    value(await client.ready({ signal }));
    const page = value(
      await client.tasks.list({ limit: client.info.limits.maxPageSize }, { signal }),
    );
    value(await client.tasks.statuses({ signal }));
    const resolved = value(await client.tasks.resolve({ authoredId: 'authored' }, { signal }));
    if (resolved !== undefined) resolution(resolved);
    const task = page?.items[0];
    if (task === undefined) return;
    value(await client.tasks.get(task.target, { signal }));
    value(await client.tasks.resolve({ source: task.source }, { signal }));
    const input = {
      target: task.target,
      expectedRevision: task.revision,
      requestId: 'fixture:1',
      expiresAt: 123,
    };
    mutation(await client.tasks.complete(input, { signal }));
    mutation(
      await client.tasks.setStatus({ ...input, requestId: 'fixture:2', symbol: ' ' }, { signal }),
    );
    mutation(await client.tasks.toggleCompletion({ ...input, requestId: 'fixture:3' }, { signal }));
    if (latestRevision < 0) throw new Error('Missing initial subscription state.');
  } finally {
    if (subscribed.ok) subscribed.value();
    client.dispose();
  }
}
