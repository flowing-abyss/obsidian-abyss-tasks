import { sameTag } from '../../markdown/tagSyntax';
import type {
  TaskIntegrationReadApi,
  TaskIntegrationReadStateApi,
  TaskNodeReadQuery,
  TaskReadNode,
  TaskReadObservation,
  TaskReadPage,
  TaskReadResult,
  TaskReadScope,
} from '../application/TaskIntegrationReadApi';
import type { StatusCatalog } from '../domain/StatusCatalog';
import type { TaskNodeSnapshot } from '../domain/taskDependencies';
import type { TaskOccurrenceAddress } from '../domain/taskOccurrence';
import { taskNodeSourceLine, taskTreeNodes } from '../domain/taskSearchProjection';
import type { TaskSnapshot, TaskStatus } from '../domain/types';

interface IntegrationProjectionOwner {
  readonly state: TaskIntegrationReadStateApi;
  activateOccurrences(): void;
  paths(): readonly string[];
  sourceCurrent(path: string): boolean;
  excludedPath(path: string): boolean;
  roots(path: string): readonly TaskSnapshot[];
  permitted(path: string): boolean;
  catalog(): StatusCatalog;
  status(value: TaskNodeSnapshot): TaskStatus;
}

function integrationScopeMatches(path: string, scope?: TaskReadScope): boolean {
  if (scope?.path !== undefined && path !== scope.path) return false;
  const folder = scope?.folder;
  return folder === undefined || folder === '' || path.startsWith(`${folder.replace(/\/$/u, '')}/`);
}

function address(value: TaskNodeSnapshot, line: number): TaskOccurrenceAddress {
  return Object.freeze({
    filePath: value.root.source.filePath,
    rootRevision: value.root.ref.revision,
    rootLine: value.root.source.line,
    nodeOffset: line - value.root.source.line,
  });
}

/** Bounded inward hydration borrows canonical records; the facade must copy only allowlisted fields. */
function hydrateIntegrationNode(value: TaskNodeSnapshot, status: TaskStatus): TaskReadNode {
  const line = taskNodeSourceLine(value.target);
  const parentRef = value.target.type === 'subtask' ? value.target.ref.parent : undefined;
  const planning = value.node.planning;
  const { time, duration, ...dates } = planning;
  return Object.freeze({
    value,
    address: address(value, line),
    ...(parentRef === undefined ? {} : { parent: address(value, taskNodeSourceLine(parentRef)) }),
    line,
    status,
    dates: Object.freeze(dates),
    ...(time === undefined ? {} : { time }),
    ...(duration === undefined ? {} : { durationMinutes: duration }),
  });
}

function matches(value: TaskNodeSnapshot, status: TaskStatus, query: TaskNodeReadQuery): boolean {
  return (
    (query.statuses === undefined || query.statuses.includes(status)) &&
    (query.tagsAll === undefined ||
      query.tagsAll.every((tag) => value.node.tags.some((authored) => sameTag(tag, authored)))) &&
    (query.dates === undefined ||
      query.dates.every((range) => {
        const date = value.node.planning[range.field];
        return (
          date !== undefined &&
          (range.from === undefined || date >= range.from) &&
          (range.to === undefined || date <= range.to)
        );
      }))
  );
}

function success<T>(value: T, observation: TaskReadObservation): TaskReadResult<T> {
  return Object.freeze({ type: 'ok', value, observation });
}

function integrationCoverage(
  owner: IntegrationProjectionOwner,
  scope?: TaskReadScope,
): TaskReadResult<true> {
  const health = owner.state.coverage(scope);
  if (health.type === 'error') return health;
  for (const path of owner.paths()) {
    if (
      integrationScopeMatches(path, scope) &&
      !owner.excludedPath(path) &&
      !owner.sourceCurrent(path)
    )
      return { type: 'error', reason: 'incomplete' };
  }
  return health;
}

function* integrationNodes(
  owner: IntegrationProjectionOwner,
  scope?: TaskReadScope,
): Iterable<TaskNodeSnapshot> {
  for (const path of owner.paths()) {
    if (!integrationScopeMatches(path, scope) || !owner.permitted(path)) continue;
    for (const root of owner.roots(path)) yield* taskTreeNodes(root);
  }
}

function current<T>(
  owner: IntegrationProjectionOwner,
  value: T,
  before: TaskReadObservation,
): TaskReadResult<T> {
  const after = owner.state.capture();
  return after.generation === before.generation
    ? success(value, after)
    : { type: 'error', reason: 'generation-changed' };
}

function readNode(
  owner: IntegrationProjectionOwner,
  target: TaskOccurrenceAddress,
): TaskReadResult<TaskReadNode> {
  const health = owner.state.coverage({ path: target.filePath });
  if (health.type === 'error' && health.reason !== 'incomplete') return health;
  if (!owner.permitted(target.filePath)) return { type: 'error', reason: 'unavailable' };
  if (health.type === 'error') return health;
  const roots = owner.roots(target.filePath).filter((root) => root.source.line === target.rootLine);
  if (roots.length > 1) return { type: 'error', reason: 'ambiguous' };
  const root = roots[0];
  if (root === undefined) return { type: 'error', reason: 'missing' };
  if (root.ref.revision !== target.rootRevision) return { type: 'error', reason: 'stale' };
  for (const value of taskTreeNodes(root)) {
    if (taskNodeSourceLine(value.target) - root.source.line === target.nodeOffset)
      return current(owner, hydrateIntegrationNode(value, owner.status(value)), health.observation);
  }
  return { type: 'error', reason: 'missing' };
}

type Position = { readonly path: string; readonly line: number };
function isAfter(value: TaskNodeSnapshot, after?: Position): boolean {
  const path = value.root.source.filePath;
  return (
    after === undefined ||
    path > after.path ||
    (path === after.path && taskNodeSourceLine(value.target) > after.line)
  );
}
function readPage(
  owner: IntegrationProjectionOwner,
  args: Parameters<TaskIntegrationReadApi['page']>,
): TaskReadResult<TaskReadPage> {
  const [query, limit, after, expectedGeneration] = args;
  const before = owner.state.capture();
  if (expectedGeneration !== undefined && expectedGeneration !== before.generation)
    return { type: 'error', reason: 'generation-changed' };
  const health = integrationCoverage(owner, query);
  if (health.type === 'error') return health;
  const rows: TaskReadNode[] = [];
  for (const value of integrationNodes(owner, query)) {
    if (!isAfter(value, after)) continue;
    const status = owner.status(value);
    if (!matches(value, status, query)) continue;
    rows.push(hydrateIntegrationNode(value, status));
    if (rows.length > limit) break;
  }
  return current(owner, pageRows(rows, limit), before);
}
function pageRows(rows: TaskReadNode[], limit: number): TaskReadPage {
  const hasNext = rows.length > limit;
  if (hasNext) rows.pop();
  const last = rows[rows.length - 1];
  return Object.freeze({
    nodes: Object.freeze(rows),
    ...(hasNext && last !== undefined
      ? { next: Object.freeze({ path: last.address.filePath, line: last.line }) }
      : {}),
  });
}

function readResolve(
  owner: IntegrationProjectionOwner,
  selector: Parameters<TaskIntegrationReadApi['resolve']>[0],
): ReturnType<TaskIntegrationReadApi['resolve']> {
  const scope = 'source' in selector ? { path: selector.source.path } : undefined;
  const health = integrationCoverage(owner, scope);
  if (health.type === 'error') return health;
  const rows: TaskReadNode[] = [];
  let count = 0;
  for (const value of integrationNodes(owner, scope)) {
    if (
      'source' in selector
        ? taskNodeSourceLine(value.target) !== selector.source.line
        : value.node.dependencyId !== selector.authoredId
    )
      continue;
    count += 1;
    if (rows.length < 100) rows.push(hydrateIntegrationNode(value, owner.status(value)));
  }
  return current(
    owner,
    Object.freeze({ nodes: Object.freeze(rows), ambiguous: count > 1, truncated: count > 100 }),
    health.observation,
  );
}

function readStatuses(
  owner: IntegrationProjectionOwner,
): ReturnType<TaskIntegrationReadApi['statuses']> {
  const before = owner.state.capture();
  if (before.lifecycle !== 'ready')
    return {
      type: 'error',
      reason: before.lifecycle === 'initializing' ? 'not-ready' : before.lifecycle,
    };
  const catalog = owner.catalog();
  return current(
    owner,
    Object.freeze(
      catalog.all().map((rule) =>
        Object.freeze({
          symbol: rule.symbol,
          status: catalog.statusForSymbol(rule.symbol),
          defaultForStatus: rule.defaultForType,
        }),
      ),
    ),
    before,
  );
}

/** No retained node population: the owner retains only sorted path keys between synchronous scans. */
export function taskIntegrationProjection(
  owner: IntegrationProjectionOwner,
): TaskIntegrationReadApi {
  return {
    activateOccurrences: () => {
      owner.activateOccurrences();
    },
    capture: () => owner.state.capture(),
    subscribe: (listener) => owner.state.subscribe(listener),
    coverage: (scope) => integrationCoverage(owner, scope),
    page: (...args) => readPage(owner, args),
    node: (target) => readNode(owner, target),
    resolve: (selector) => readResolve(owner, selector),
    statuses: () => readStatuses(owner),
    canDisclose: (target) => readNode(owner, target).type === 'ok',
  };
}
