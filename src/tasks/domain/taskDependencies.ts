import { cloneTaskSnapshot } from './cloneTaskSnapshot';
import {
  sameTaskNodeRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskSnapshot,
  type TaskStatus,
} from './types';

export interface TaskNodeSnapshot {
  readonly root: TaskSnapshot;
  readonly path: readonly SubtaskSnapshot[];
  readonly target: TaskNodeRef;
  readonly node: TaskSnapshot | SubtaskSnapshot;
}

export type DependencyDirection = 'blocked-by' | 'blocks';

interface ResolvedTaskDependencyRelation {
  readonly type: 'resolved';
  readonly dependencyId: string;
  readonly task: TaskNodeSnapshot;
  readonly state: 'active' | 'satisfied';
}

interface AmbiguousTaskDependencyRelation {
  readonly type: 'ambiguous';
  readonly dependencyId: string;
  readonly candidates: readonly TaskNodeSnapshot[];
  readonly state: 'active' | 'satisfied';
}

type ActiveTaskDependencyRelation = Omit<ResolvedTaskDependencyRelation, 'state'> & {
  readonly state: 'active';
};
type ActiveAmbiguousTaskDependencyRelation = Omit<AmbiguousTaskDependencyRelation, 'state'> & {
  readonly state: 'active';
};
export type ActiveBlockingRelation =
  ActiveTaskDependencyRelation | ActiveAmbiguousTaskDependencyRelation;

export type TaskDependencyRelation =
  | ResolvedTaskDependencyRelation
  | AmbiguousTaskDependencyRelation
  | {
      readonly type: 'unavailable';
      readonly dependencyId: string;
      readonly reason: 'missing';
    };

export interface TaskDependencyProjection {
  readonly blockedBy: readonly TaskDependencyRelation[];
  readonly blocks: readonly ResolvedTaskDependencyRelation[];
  readonly activeBlockedByCount: number;
  readonly activeBlocksCount: number;
}

export type TaskDependencyEligibility =
  | { readonly type: 'allowed' }
  | {
      readonly type: 'rejected';
      readonly reason:
        'self' | 'duplicate' | 'inverse' | 'cycle' | 'stale' | 'ambiguous' | 'unavailable';
    };

export interface TaskDependencyGraph {
  dependencies(target: TaskNodeRef): TaskDependencyProjection;
  eligibility(blocker: TaskNodeRef, dependent: TaskNodeRef): TaskDependencyEligibility;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function enumerateTaskNodes(tasks: readonly TaskSnapshot[]): readonly TaskNodeSnapshot[] {
  const nodes: TaskNodeSnapshot[] = [];
  const visit = (
    root: TaskSnapshot,
    children: readonly SubtaskSnapshot[],
    path: readonly SubtaskSnapshot[],
  ): void => {
    for (const node of [...children].sort((a, b) => a.ref.relativeLine - b.ref.relativeLine)) {
      const nextPath = [...path, node];
      nodes.push({ root, path: nextPath, target: { type: 'subtask', ref: node.ref }, node });
      visit(root, node.subtasks, nextPath);
    }
  };
  const roots = [...tasks].sort((a, b) => {
    const fileOrder = a.source.filePath.localeCompare(b.source.filePath);
    return fileOrder !== 0 ? fileOrder : a.source.line - b.source.line;
  });
  for (const source of roots) {
    const root = cloneTaskSnapshot(source);
    nodes.push({ root, path: [], target: { type: 'task', ref: root.ref }, node: root });
    visit(root, root.subtasks, []);
  }
  return freeze(nodes);
}

/** Structural address excludes revision/content so obsolete references can be rejected as stale. */
function address(target: TaskNodeRef): string {
  const path: number[] = [];
  let current = target;
  while (current.type === 'subtask') {
    path.unshift(current.ref.relativeLine);
    current = current.ref.parent;
  }
  return JSON.stringify([current.ref.filePath, current.ref.line, ...path]);
}

type RevisionLookup<T> = Map<string, Map<string, T>>;
function rootRevision(target: TaskNodeRef): string {
  let root = target;
  while (root.type === 'subtask') root = root.ref.parent;
  return root.ref.revision;
}
function revisionGet<T>(
  lookup: ReadonlyMap<string, ReadonlyMap<string, T>>,
  target: TaskNodeRef,
): T | undefined {
  return lookup.get(rootRevision(target))?.get(address(target));
}
function revisionSet<T>(lookup: RevisionLookup<T>, target: TaskNodeRef, value: T): void {
  const revision = rootRevision(target);
  const entries = lookup.get(revision) ?? new Map<string, T>();
  entries.set(address(target), value);
  lookup.set(revision, entries);
}

function reaches(
  start: TaskNodeSnapshot,
  target: TaskNodeSnapshot,
  prerequisites: ReadonlyMap<TaskNodeSnapshot, readonly TaskNodeSnapshot[]>,
): boolean {
  const pending = [start];
  const visited = new Set<TaskNodeSnapshot>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || visited.has(node)) continue;
    if (node === target) return true;
    visited.add(node);
    pending.push(...(prerequisites.get(node) ?? []));
  }
  return false;
}

function isActive(
  statusForSymbol: (symbol: string) => TaskStatus,
  { node }: TaskNodeSnapshot,
): boolean {
  const status = statusForSymbol(node.statusSymbol);
  return status === 'open' || status === 'in-progress';
}

function exact(
  byRevision: ReadonlyMap<string, ReadonlyMap<string, TaskNodeSnapshot>>,
  ref: TaskNodeRef,
): TaskNodeSnapshot | undefined {
  const node = revisionGet(byRevision, ref);
  return node !== undefined && sameTaskNodeRef(node.target, ref) ? node : undefined;
}

function blockedByRelation(
  byId: ReadonlyMap<string, readonly TaskNodeSnapshot[]>,
  statusForSymbol: (symbol: string) => TaskStatus,
  dependent: TaskNodeSnapshot,
  dependencyId: string,
): TaskDependencyRelation {
  const candidates = byId.get(dependencyId) ?? [];
  const first = candidates[0];
  if (first === undefined) return { type: 'unavailable', dependencyId, reason: 'missing' };
  const state =
    isActive(statusForSymbol, dependent) &&
    candidates.some((candidate) => isActive(statusForSymbol, candidate))
      ? 'active'
      : 'satisfied';
  return candidates.length === 1
    ? { type: 'resolved', dependencyId, task: first, state }
    : { type: 'ambiguous', dependencyId, candidates, state };
}

function pairEligibility(
  byId: ReadonlyMap<string, readonly TaskNodeSnapshot[]>,
  prerequisites: ReadonlyMap<TaskNodeSnapshot, readonly TaskNodeSnapshot[]>,
  blocker: TaskNodeSnapshot,
  dependent: TaskNodeSnapshot,
): TaskDependencyEligibility {
  const blockerId = blocker.node.dependencyId;
  if (blockerId !== undefined && (byId.get(blockerId)?.length ?? 0) > 1)
    return { type: 'rejected', reason: 'ambiguous' };
  if (prerequisites.get(dependent)?.includes(blocker) === true)
    return { type: 'rejected', reason: 'duplicate' };
  if (prerequisites.get(blocker)?.includes(dependent) === true)
    return { type: 'rejected', reason: 'inverse' };
  if (reaches(blocker, dependent, prerequisites)) return { type: 'rejected', reason: 'cycle' };
  return { type: 'allowed' };
}

interface DependencyEdge {
  readonly blocker: TaskNodeRef;
  readonly dependent: TaskNodeRef;
}

/** Synchronous compatibility driver over the same checkpointed assembly. */
export function assembleTaskDependencyGraph(
  input: Iterable<TaskNodeSnapshot>,
  statusForSymbol: (symbol: string) => TaskStatus,
  without?: DependencyEdge,
): TaskDependencyGraph {
  const cursor = assembleTaskDependencyGraphSteps(input, statusForSymbol, without);
  let step = cursor.next();
  while (step.done !== true) step = cursor.next();
  return step.value;
}

interface DependencyIndexes {
  byRevision: RevisionLookup<TaskNodeSnapshot>;
  addresses: Set<string>;
  byId: Map<string, TaskNodeSnapshot[]>;
  prerequisites: Map<TaskNodeSnapshot, TaskNodeSnapshot[]>;
  dependents: Map<TaskNodeSnapshot, TaskNodeSnapshot[]>;
}

function* dependencyIndexes(
  input: Iterable<TaskNodeSnapshot>,
  without?: DependencyEdge,
): Generator<void, DependencyIndexes> {
  const byId = new Map<string, TaskNodeSnapshot[]>();
  const prerequisites = new Map<TaskNodeSnapshot, TaskNodeSnapshot[]>();
  const dependents = new Map<TaskNodeSnapshot, TaskNodeSnapshot[]>();
  const byRevision: RevisionLookup<TaskNodeSnapshot> = new Map();
  const addresses = new Set<string>();
  const nodes: TaskNodeSnapshot[] = [];
  for (const node of input) {
    nodes.push(node);
    revisionSet(byRevision, node.target, node);
    addresses.add(address(node.target));
    const id = node.node.dependencyId;
    if (id !== undefined) {
      const matches = byId.get(id) ?? [];
      matches.push(node);
      byId.set(id, matches);
    }
    yield;
  }
  yield* dependencyEdges(nodes, { byId, prerequisites, dependents }, without);
  return { byRevision, addresses, byId, prerequisites, dependents };
}

function includesDependencyEdge(
  blocker: TaskNodeSnapshot,
  dependent: TaskNodeSnapshot,
  without?: DependencyEdge,
): boolean {
  return (
    without === undefined ||
    !sameTaskNodeRef(dependent.target, without.dependent) ||
    !sameTaskNodeRef(blocker.target, without.blocker)
  );
}

function* dependencyEdges(
  nodes: readonly TaskNodeSnapshot[],
  {
    byId,
    prerequisites,
    dependents,
  }: Pick<DependencyIndexes, 'byId' | 'prerequisites' | 'dependents'>,
  without?: DependencyEdge,
): Generator<void> {
  for (const dependent of nodes) {
    const blockers: TaskNodeSnapshot[] = [];
    prerequisites.set(dependent, blockers);
    const seen = new Set<string>();
    yield;
    for (const id of dependent.node.dependsOn) {
      const duplicate = seen.has(id);
      seen.add(id);
      yield;
      if (duplicate) continue;
      yield* expandDependencyCandidates(
        byId.get(id) ?? [],
        dependent,
        { blockers, dependents },
        without,
      );
    }
  }
}

function* expandDependencyCandidates(
  candidates: readonly TaskNodeSnapshot[],
  dependent: TaskNodeSnapshot,
  {
    blockers,
    dependents,
  }: { blockers: TaskNodeSnapshot[]; dependents: Map<TaskNodeSnapshot, TaskNodeSnapshot[]> },
  without?: DependencyEdge,
): Generator<void> {
  for (const blocker of candidates) {
    if (includesDependencyEdge(blocker, dependent, without)) {
      blockers.push(blocker);
      const matches = dependents.get(blocker) ?? [];
      matches.push(dependent);
      dependents.set(blocker, matches);
    }
    yield;
  }
}

/** Inward borrowed assembly. Each yield completes one node, declared ID or expanded edge. */
export function* assembleTaskDependencyGraphSteps(
  input: Iterable<TaskNodeSnapshot>,
  statusForSymbol: (symbol: string) => TaskStatus,
  without?: DependencyEdge,
): Generator<void, TaskDependencyGraph> {
  const { byRevision, addresses, byId, prerequisites, dependents } = yield* dependencyIndexes(
    input,
    without,
  );
  // No final traversal: the closure retains only the query indexes.
  return {
    dependencies(target: TaskNodeRef): TaskDependencyProjection {
      const node = exact(byRevision, target);
      const blockedBy =
        node === undefined
          ? []
          : [...new Set(node.node.dependsOn)].map((id) =>
              blockedByRelation(byId, statusForSymbol, node, id),
            );
      const blocks: ResolvedTaskDependencyRelation[] =
        node === undefined
          ? []
          : (dependents.get(node) ?? []).map((dependent) => ({
              type: 'resolved',
              dependencyId: node.node.dependencyId ?? '',
              task: dependent,
              state:
                isActive(statusForSymbol, node) && isActive(statusForSymbol, dependent)
                  ? 'active'
                  : 'satisfied',
            }));
      return {
        blockedBy,
        blocks,
        activeBlockedByCount: blockedBy.filter(
          (row) => row.type !== 'unavailable' && row.state === 'active',
        ).length,
        activeBlocksCount: blocks.filter((row) => row.state === 'active').length,
      };
    },
    eligibility(blockerRef: TaskNodeRef, dependentRef: TaskNodeRef): TaskDependencyEligibility {
      const blocker = exact(byRevision, blockerRef);
      const dependent = exact(byRevision, dependentRef);
      if (blocker === undefined || dependent === undefined) {
        const absent = [blockerRef, dependentRef].some((ref) => !addresses.has(address(ref)));
        return { type: 'rejected', reason: absent ? 'unavailable' : 'stale' };
      }
      if (blocker === dependent) return { type: 'rejected', reason: 'self' };
      return pairEligibility(byId, prerequisites, blocker, dependent);
    },
  };
}

/** Defensive public builder; assembly itself also serves the index's private borrowed adapter. */
export function buildTaskDependencyGraph(
  input: readonly TaskNodeSnapshot[],
  statusForSymbol: (symbol: string) => TaskStatus,
  without?: DependencyEdge,
): TaskDependencyGraph {
  const requested: RevisionLookup<TaskNodeRef> = new Map();
  for (const node of input) revisionSet(requested, node.target, node.target);
  const nodes = enumerateTaskNodes([...new Set(input.map((node) => node.root))]).filter((node) => {
    const ref = revisionGet(requested, node.target);
    return ref !== undefined && sameTaskNodeRef(ref, node.target);
  });
  const graph = assembleTaskDependencyGraph(nodes, statusForSymbol, without);
  return {
    dependencies: (target) => freeze(graph.dependencies(target)),
    eligibility: (blocker, dependent) => graph.eligibility(blocker, dependent),
  };
}
