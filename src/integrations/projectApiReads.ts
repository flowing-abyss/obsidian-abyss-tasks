import type {
  ApiResultV1,
  ListProjectsV1,
  ProjectDtoV1,
  ProjectPageV1,
  ProjectResolutionV1,
  ProjectsApiV1,
  ProjectSummaryV1,
  ReadOptionsV1,
  ResolveProjectV1,
} from '../../api';
import type { ProjectIntegrationReads, ProjectReadRecord } from '../projects/projectApi';
import type { TaskReadObservation } from '../tasks';
import type { ProjectReadRegistry } from './ProjectReadRegistry';
import { validateProjectList, validateProjectResolve } from './projectValidation';
import type { TaskApiContext } from './TaskApiProvider';
import { lifecycleError, readError, readFailure } from './taskApiReads';
import { validateReadOptions, validateTarget } from './validation';
import { freezeValue } from './values';

type Context = Pick<TaskApiContext, 'reads' | 'observation' | 'check' | 'internal'>;
type ReadMethods = Pick<ProjectsApiV1, 'schema' | 'list' | 'get' | 'resolve'>;
function isAfter(path: string, after: string | undefined): boolean {
  return after === undefined || path > after;
}
function* remainingPaths(paths: readonly string[], after: string | undefined): Iterable<string> {
  for (const path of paths) if (isAfter(path, after)) yield path;
}
export interface ProjectApiReads {
  readonly api: ReadMethods;
  acquire(target: string, expectedRevision?: string): ApiResultV1<ProjectReadRecord>;
}
function sized<T>(value: T): ApiResultV1<T> {
  try {
    if (
      withinLowerBound(value, { remaining: 262_144 }) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= 262_144
    )
      return freezeValue({ ok: true, value });
  } catch {
    /* Non-wire values cannot be disclosed. */
  }
  return readError('resource', 'RESOURCE_LIMIT', 'Project result is too large.');
}
/** Reject obvious oversize values before making a full JSON/UTF-8 copy. */
function withinLowerBound(value: unknown, budget: { remaining: number }): boolean {
  if (typeof value === 'string') budget.remaining -= value.length;
  else if (Array.isArray(value)) {
    budget.remaining -= value.length;
    return lowerBoundItems(value as readonly unknown[], budget);
  } else if (value !== null && typeof value === 'object') return lowerBoundObject(value, budget);
  return budget.remaining >= 0;
}
function lowerBoundItems(values: readonly unknown[], budget: { remaining: number }): boolean {
  for (const item of values)
    if (budget.remaining < 0 || !withinLowerBound(item, budget)) return false;
  return budget.remaining >= 0;
}
function lowerBoundObject(value: object, budget: { remaining: number }): boolean {
  for (const [key, item] of Object.entries(value)) {
    budget.remaining -= key.length;
    if (budget.remaining < 0 || !withinLowerBound(item, budget)) return false;
  }
  return budget.remaining >= 0;
}
class ProjectReadClient {
  constructor(
    private readonly context: Context,
    private readonly port: ProjectIntegrationReads,
    readonly registry: ProjectReadRegistry,
  ) {}
  async run<T, I>(
    operation: string,
    input: ApiResultV1<I>,
    opts: ReadOptionsV1 | undefined,
    read: (value: I, before: TaskReadObservation) => ApiResultV1<T>,
  ): Promise<ApiResultV1<T>> {
    try {
      if (!input.ok) return input;
      const valid = validateReadOptions(opts);
      if (!valid.ok) return valid;
      const initial =
        this.context.check(valid.value.signal) ?? lifecycleError(this.context.reads.capture());
      if (initial !== undefined) return initial;
      const before = this.context.reads.capture();
      await Promise.resolve();
      const later =
        this.context.check(valid.value.signal) ?? lifecycleError(this.context.reads.capture());
      if (later !== undefined) return later;
      return this.deliver(() => read(input.value, before));
    } catch {
      return this.context.internal(operation);
    }
  }
  private deliver<T>(read: () => ApiResultV1<T>): ApiResultV1<T> {
    const checkpoint = this.registry.checkpoint();
    try {
      const result = this.context.check() ?? read();
      const delivered = this.context.check() ?? result;
      if (!delivered.ok) this.registry.rollback(checkpoint);
      return delivered;
    } catch (error) {
      this.registry.rollback(checkpoint);
      throw error;
    }
  }
  list(query: ListProjectsV1, before: TaskReadObservation): ApiResultV1<ProjectPageV1> {
    this.registry.clean();
    const current = this.context.reads.capture(),
      limit = query.limit ?? 100;
    const resume =
      query.cursor === undefined ? undefined : this.registry.resume(query.cursor, limit, current);
    if (resume !== undefined && !resume.ok) return resume;
    if (current.generation !== before.generation)
      return readFailure(query.cursor === undefined ? 'incomplete' : 'generation-changed');
    const health = this.port.coverage();
    if (health.type === 'error') return readFailure(health.reason);
    return this.page(limit, resume?.value, current);
  }
  private page(
    limit: number,
    after: string | undefined,
    observation: TaskReadObservation,
  ): ApiResultV1<ProjectPageV1> {
    const result = this.rows(limit, after);
    if (!result.ok) return result;
    const { rows, more } = result.value;
    const last = rows[rows.length - 1];
    const next =
      more && last !== undefined ? this.registry.open(last.path, limit, observation) : undefined;
    if (next !== undefined && !next.ok) return next;
    return sized({
      ...this.context.observation(this.context.reads.capture()),
      items: rows,
      ...(next === undefined ? {} : { nextCursor: next.value }),
    });
  }
  private rows(
    limit: number,
    after: string | undefined,
  ): ApiResultV1<{ rows: ProjectSummaryV1[]; more: boolean }> {
    const rows: ProjectSummaryV1[] = [],
      semantic = this.port.semantics();
    for (const path of remainingPaths(this.port.paths(), after)) {
      const read = this.port.summary(path, semantic);
      if (read.type === 'error') return readFailure(read.reason);
      if (read.value === undefined) continue;
      if (rows.length === limit) return { ok: true, value: { rows, more: true } };
      const item = this.registry.project(read.value);
      if (!item.ok) return item;
      rows.push(item.value);
    }
    return { ok: true, value: { rows, more: false } };
  }
  get(target: string): ApiResultV1<ProjectDtoV1> {
    const read = this.registry.acquire(target);
    if (!read.ok) return read;
    const result = this.registry.project(read.value);
    return result.ok ? sized(result.value) : result;
  }
  resolve(selector: ResolveProjectV1): ApiResultV1<ProjectResolutionV1> {
    this.registry.clean();
    const read = this.port.get(selector.path);
    if (read.type === 'error') return readFailure(read.reason);
    const observation = this.context.observation(read.observation);
    if (read.value === undefined) return sized({ type: 'not-found', observation });
    const result = this.registry.project(read.value);
    if (!result.ok) return result;
    return sized({ type: 'found', project: result.value, observation });
  }
}
/** Each client supplies lifecycle context while all clients share the provider's registry. */
export function createProjectApiReads(
  context: Context,
  port: ProjectIntegrationReads,
  registry: ProjectReadRegistry,
): ProjectApiReads {
  const client = new ProjectReadClient(context, port, registry);
  return {
    api: Object.freeze({
      schema: (options?: ReadOptionsV1) =>
        client.run('projects.schema', { ok: true, value: undefined }, options, () =>
          sized({ ...context.observation(context.reads.capture()), ...port.schema() }),
        ),
      list: (query?: ListProjectsV1, options?: ReadOptionsV1) =>
        client.run('projects.list', validateProjectList(query), options, (input, before) =>
          client.list(input, before),
        ),
      get: (target: string, options?: ReadOptionsV1) =>
        client.run('projects.get', validateTarget(target), options, (input) => client.get(input)),
      resolve: (selector: ResolveProjectV1, options?: ReadOptionsV1) =>
        client.run('projects.resolve', validateProjectResolve(selector), options, (input) =>
          client.resolve(input),
        ),
    }),
    acquire: (target, revision) => registry.acquire(target, revision),
  };
}
