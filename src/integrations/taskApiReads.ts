import type {
  ApiResultV1,
  ErrorCategoryV1,
  ListTasksV1,
  ReadOptionsV1,
  ResolutionV1,
  StatusCatalogV1,
  TaskDtoV1,
  TaskPageV1,
} from '../../api';
import type { TaskReadNode, TaskReadObservation, TaskReadResult } from '../tasks';
import type { TaskApiContext, TaskReadClientV1 } from './TaskApiProvider';
import { toTaskDto } from './taskDto';
import { validateList, validateReadOptions, validateSelector, validateTarget } from './validation';
import { apiError, freezeValue } from './values';

export function readError(
  category: ErrorCategoryV1,
  code: string,
  message: string,
): Extract<ApiResultV1<never>, { ok: false }> {
  return freezeValue({ ok: false, error: apiError(category, code, message) });
}
export function lifecycleError(state: TaskReadObservation): ApiResultV1<never> | undefined {
  if (state.lifecycle === 'ready') return undefined;
  return readFailure(state.lifecycle === 'initializing' ? 'not-ready' : state.lifecycle);
}

export function readFailure(
  reason: Extract<TaskReadResult<never>, { type: 'error' }>['reason'],
): Extract<ApiResultV1<never>, { ok: false }> {
  switch (reason) {
    case 'not-ready':
      return readError('lifecycle', 'NOT_READY', 'Task reads are initializing.');
    case 'failed':
      return readError('lifecycle', 'INITIALIZATION_FAILED', 'Task initialization failed.');
    case 'disposed':
      return readError('lifecycle', 'DISPOSED', 'Task API is disposed.');
    case 'incomplete':
      return readError('unavailable', 'INCOMPLETE_READ', 'Task source coverage is incomplete.');
    case 'generation-changed':
      return readError('conflict', 'STALE_CURSOR', 'Task scan is no longer current.');
    case 'unavailable':
      return readError('unavailable', 'TARGET_UNAVAILABLE', 'Task disclosure is unavailable.');
    case 'missing':
      return readError('unavailable', 'NOT_FOUND', 'Task occurrence was removed.');
    case 'stale':
      return readError('unavailable', 'STALE_TARGET', 'Task identity is no longer proven.');
    case 'ambiguous':
      return readError('unavailable', 'AMBIGUOUS_TARGET', 'Task identity is ambiguous.');
  }
}
function project(
  context: TaskApiContext,
  nodes: readonly TaskReadNode[],
  observation: TaskReadObservation,
): ApiResultV1<readonly TaskDtoV1[]> {
  const items: TaskDtoV1[] = [];
  for (const node of nodes) {
    if (!context.reads.canDisclose(node.address)) return readFailure('unavailable');
    const identity = context.identities.project(node, observation.semanticsRevision);
    if (!identity.ok) return identity;
    items.push(toTaskDto(node, identity.value));
  }
  return freezeValue({ ok: true, value: items });
}
function list(
  context: TaskApiContext,
  query: ListTasksV1,
  before: TaskReadObservation,
): ApiResultV1<TaskPageV1> {
  const observation = context.reads.capture();
  const resume =
    query.cursor === undefined
      ? undefined
      : context.cursors.resume(query.cursor, query, observation);
  if (resume !== undefined && !resume.ok) return resume;
  if (observation.generation !== before.generation)
    return readFailure(query.cursor === undefined ? 'incomplete' : 'generation-changed');
  const page = context.reads.page(query, query.limit ?? 100, resume?.value, observation.generation);
  if (page.type === 'error') return readFailure(page.reason);
  const projected = project(context, page.value.nodes, page.observation);
  if (!projected.ok) return projected;
  return finishPage(context, query, page, projected.value);
}
function finishPage(
  context: TaskApiContext,
  query: ListTasksV1,
  page: Extract<ReturnType<TaskApiContext['reads']['page']>, { type: 'ok' }>,
  items: readonly TaskDtoV1[],
): ApiResultV1<TaskPageV1> {
  const next =
    page.value.next === undefined
      ? undefined
      : context.cursors.open(query, page.observation, page.value.next);
  if (next !== undefined && !next.ok) return next;
  return freezeValue({
    ok: true,
    value: {
      ...context.observation(page.observation),
      items,
      ...(next === undefined ? {} : { nextCursor: next.value }),
    },
  });
}
function get(context: TaskApiContext, target: string): ApiResultV1<TaskDtoV1> {
  const identity = context.identities.lookup(target);
  if (!identity.ok) return identity;
  const read = context.reads.node(identity.value.address);
  // Current permission and health precede cached identity outcome disclosure.
  if (
    read.type === 'error' &&
    ['unavailable', 'incomplete', 'not-ready', 'failed', 'disposed'].includes(read.reason)
  )
    return readFailure(read.reason);
  if (identity.value.state === 'removed') return readFailure('missing');
  if (identity.value.state === 'unproven') return readFailure('stale');
  if (read.type === 'error') return readFailure(read.reason);
  if (!context.reads.canDisclose(read.value.address)) return readFailure('unavailable');
  const projected = context.identities.project(read.value, read.observation.semanticsRevision);
  if (!projected.ok) return projected;
  return freezeValue({ ok: true, value: toTaskDto(read.value, projected.value) });
}
function resolve(
  context: TaskApiContext,
  selector: Parameters<TaskReadClientV1['tasks']['resolve']>[0],
): ApiResultV1<ResolutionV1> {
  const read = context.reads.resolve(selector);
  if (read.type === 'error') return readFailure(read.reason);
  const projected = project(context, read.value.nodes, read.observation);
  if (!projected.ok) return projected;
  const observation = context.observation(read.observation);
  if (read.value.ambiguous)
    return freezeValue({
      ok: true,
      value: {
        type: 'ambiguous' as const,
        candidates: projected.value,
        truncated: read.value.truncated,
        observation,
      },
    });
  const task = projected.value[0];
  return freezeValue({
    ok: true,
    value:
      task === undefined
        ? { type: 'not-found' as const, observation }
        : { type: 'found' as const, task, observation },
  });
}
function statuses(context: TaskApiContext): ApiResultV1<StatusCatalogV1> {
  const read = context.reads.statuses();
  if (read.type === 'error') return readFailure(read.reason);
  return freezeValue({
    ok: true,
    value: {
      ...context.observation(read.observation),
      items: read.value.map((item) => ({ ...item })),
    },
  });
}

/** Validate synchronously, then acquire and disclose only in the delivery turn. */
export function createTaskApiReads(context: TaskApiContext): TaskReadClientV1['tasks'] {
  async function run<T, Input>(
    operation: string,
    input: ApiResultV1<Input>,
    options: ReadOptionsV1 | undefined,
    read: (input: Input, before: TaskReadObservation) => ApiResultV1<T>,
  ): Promise<ApiResultV1<T>> {
    try {
      if (!input.ok) return input;
      const validatedOptions = validateReadOptions(options);
      if (!validatedOptions.ok) return validatedOptions;
      const { signal } = validatedOptions.value;
      const failed = context.check(signal) ?? lifecycleError(context.reads.capture());
      if (failed !== undefined) return failed;
      const before = context.reads.capture();
      await Promise.resolve();
      const deliveryFailure = context.check(signal) ?? lifecycleError(context.reads.capture());
      if (deliveryFailure !== undefined) return deliveryFailure;
      const result = read(input.value, before);
      return context.check() ?? result;
    } catch {
      return context.internal(operation);
    }
  }
  return Object.freeze({
    list: (query, options) =>
      run('tasks.list', validateList(query), options, (query, before) =>
        list(context, query, before),
      ),
    get: (target, options) =>
      run('tasks.get', validateTarget(target), options, (target) => get(context, target)),
    resolve: (selector, options) =>
      run('tasks.resolve', validateSelector(selector), options, (selector) =>
        resolve(context, selector),
      ),
    statuses: (options) =>
      run('tasks.statuses', { ok: true, value: undefined }, options, () => statuses(context)),
  });
}
