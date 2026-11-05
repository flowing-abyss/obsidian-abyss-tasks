import type {
  ApiAbortSignalV1,
  ApiResultV1,
  MutationResultV1,
  ProjectDtoV1,
  ProjectRequestV1,
  ProjectSchemaV1,
  ProjectsApiV1,
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

async function createAndFindProject(
  projects: ProjectsApiV1,
  request: () => ProjectRequestV1,
): Promise<ProjectDtoV1 | undefined> {
  const created = await projects.create({ name: 'New', ...request() });
  if (!created.ok || created.receipt.project === undefined) return;
  const detail = await projects.get(created.receipt.project.target);
  if (!detail.ok) return;
  const resolved = await projects.resolve({ path: detail.value.path });
  if (!resolved.ok || resolved.value.type !== 'found') return;
  return resolved.value.project;
}
async function populateProject(
  projects: ProjectsApiV1,
  project: ProjectDtoV1,
  request: () => ProjectRequestV1,
) {
  const schema = await projects.schema();
  if (!schema.ok || !schema.value.fields.some((f) => f.id === 'description' && f.writable)) return;
  const updated = await projects.update({
    target: project.target,
    expectedRevision: project.revision,
    statusId: schema.value.defaultStatusId ?? null,
    fields: [{ fieldId: 'description', value: 'Text' }],
    ...request(),
  });
  if (!updated.ok || updated.receipt.project === undefined) return;
  return projects.createTask({
    target: project.target,
    expectedRevision: updated.receipt.project.revision,
    title: 'Task',
    ...request(),
  });
}
export async function exerciseProjects(
  client: TasksApiV1,
  taskToMove: TaskDtoV1,
  newRequestId: () => string,
): Promise<void> {
  const projects = client.projects;
  if (projects === undefined) return; // A task-only v1 provider remains valid.
  const request = () => ({
    requestId: newRequestId(),
    expiresAt: Date.now() + client.info.limits.maxRequestWindowMs,
  });
  await projects.list({ limit: 10 });
  const project = await createAndFindProject(projects, request);
  if (project === undefined) return;
  const inserted = await populateProject(projects, project, request);
  if (inserted === undefined || !inserted.ok || inserted.receipt.project === undefined) return;
  const source = await client.tasks.get(taskToMove.target);
  if (!source.ok || source.value.parentTarget !== undefined) return;
  const moved = await projects.moveTask({
    target: project.target,
    expectedRevision: inserted.receipt.project.revision,
    taskTarget: source.value.target,
    expectedTaskRevision: source.value.revision,
    ...request(),
  });
  if (!moved.ok && moved.recovery === 'reconcile')
    await client.tasks.list({ path: source.value.source.path });
  await client.tasks.list({ path: project.path });
}

/** A provider compiled against the original client and info shape remains assignable. */
export function legacyProvider(client: TasksApiV1): TasksApiProviderV1 {
  const { apiVersion, pluginVersion, providerEpoch, capabilities, limits } = client.info;
  const oldClient: TasksApiV1 = {
    info: { apiVersion, pluginVersion, providerEpoch, capabilities, limits },
    ready: client.ready,
    subscribe: client.subscribe,
    dispose: client.dispose,
    tasks: client.tasks,
  };
  return { getApi: () => ({ ok: true, value: oldClient }) };
}

export function schemaFields(schema: ProjectSchemaV1): readonly string[] {
  return schema.fields.map((field) => {
    if (field.kind === 'derived') {
      const type: 'name' | 'progress' | 'tracking' = field.type;
      const writable: false = field.writable;
      return `${type}:${writable}`;
    }
    if (field.kind === 'status') {
      const type: 'status' = field.type;
      return type;
    }
    if (field.kind === 'unavailable') {
      const writable: false = field.writable;
      return `${field.type}:${writable}`;
    }
    return field.type;
  });
}
