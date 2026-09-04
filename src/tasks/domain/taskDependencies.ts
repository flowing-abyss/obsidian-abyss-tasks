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

export interface ResolvedTaskDependencyRelation {
  readonly type: 'resolved';
  readonly dependencyId: string;
  readonly task: TaskNodeSnapshot;
  readonly state: 'active' | 'satisfied';
}

export interface AmbiguousTaskDependencyRelation {
  readonly type: 'ambiguous';
  readonly dependencyId: string;
  readonly candidates: readonly TaskNodeSnapshot[];
  readonly state: 'active' | 'satisfied';
}

export type ActiveTaskDependencyRelation = Omit<ResolvedTaskDependencyRelation, 'state'> & {
  readonly state: 'active';
};
export type ActiveAmbiguousTaskDependencyRelation = Omit<
  AmbiguousTaskDependencyRelation,
  'state'
> & {
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

export type DependencyDirection = 'blocked-by' | 'blocks';

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

export function buildTaskDependencyGraph(
  input: readonly TaskNodeSnapshot[],
  statusForSymbol: (symbol: string) => TaskStatus,
): TaskDependencyGraph {
  return new DerivedTaskDependencyGraph(input, statusForSymbol);
}

class DerivedTaskDependencyGraph implements TaskDependencyGraph {
  private readonly byAddress: ReadonlyMap<string, TaskNodeSnapshot>;
  private readonly byId = new Map<string, TaskNodeSnapshot[]>();
  private readonly prerequisites = new Map<TaskNodeSnapshot, TaskNodeSnapshot[]>();
  private readonly dependents = new Map<TaskNodeSnapshot, TaskNodeSnapshot[]>();

  constructor(
    input: readonly TaskNodeSnapshot[],
    private readonly statusForSymbol: (symbol: string) => TaskStatus,
  ) {
    const requested = new Map(input.map((node) => [address(node.target), node.target]));
    const nodes = enumerateTaskNodes([...new Set(input.map((node) => node.root))]).filter(
      (node) => {
        const ref = requested.get(address(node.target));
        return ref !== undefined && sameTaskNodeRef(ref, node.target);
      },
    );
    this.byAddress = new Map(nodes.map((node) => [address(node.target), node]));
    for (const node of nodes) {
      const id = node.node.dependencyId;
      if (id === undefined) continue;
      const matches = this.byId.get(id) ?? [];
      matches.push(node);
      this.byId.set(id, matches);
    }
    for (const dependent of nodes) {
      const blockers = [...new Set(dependent.node.dependsOn)].flatMap(
        (id) => this.byId.get(id) ?? [],
      );
      this.prerequisites.set(dependent, blockers);
      for (const blocker of blockers) {
        const matches = this.dependents.get(blocker) ?? [];
        matches.push(dependent);
        this.dependents.set(blocker, matches);
      }
    }
  }

  private isActive({ node }: TaskNodeSnapshot): boolean {
    const status = this.statusForSymbol(node.statusSymbol);
    return status === 'open' || status === 'in-progress';
  }

  private exact(ref: TaskNodeRef): TaskNodeSnapshot | undefined {
    const node = this.byAddress.get(address(ref));
    return node !== undefined && sameTaskNodeRef(node.target, ref) ? node : undefined;
  }

  private blockedByRelation(
    dependent: TaskNodeSnapshot,
    dependencyId: string,
  ): TaskDependencyRelation {
    const candidates = this.byId.get(dependencyId) ?? [];
    const first = candidates[0];
    if (first === undefined) return { type: 'unavailable', dependencyId, reason: 'missing' };
    const state =
      this.isActive(dependent) && candidates.some((candidate) => this.isActive(candidate))
        ? 'active'
        : 'satisfied';
    return candidates.length === 1
      ? { type: 'resolved', dependencyId, task: first, state }
      : { type: 'ambiguous', dependencyId, candidates, state };
  }

  dependencies(target: TaskNodeRef): TaskDependencyProjection {
    const node = this.exact(target);
    const blockedBy =
      node === undefined
        ? []
        : [...new Set(node.node.dependsOn)].map((id) => this.blockedByRelation(node, id));
    const blocks: ResolvedTaskDependencyRelation[] =
      node === undefined
        ? []
        : (this.dependents.get(node) ?? []).map((dependent) => ({
            type: 'resolved',
            dependencyId: node.node.dependencyId ?? '',
            task: dependent,
            state: this.isActive(node) && this.isActive(dependent) ? 'active' : 'satisfied',
          }));
    return freeze({
      blockedBy,
      blocks,
      activeBlockedByCount: blockedBy.filter(
        (row) => row.type !== 'unavailable' && row.state === 'active',
      ).length,
      activeBlocksCount: blocks.filter((row) => row.state === 'active').length,
    });
  }

  eligibility(blockerRef: TaskNodeRef, dependentRef: TaskNodeRef): TaskDependencyEligibility {
    const blocker = this.exact(blockerRef);
    const dependent = this.exact(dependentRef);
    if (blocker === undefined || dependent === undefined) {
      const absent = [blockerRef, dependentRef].some((ref) => !this.byAddress.has(address(ref)));
      return { type: 'rejected', reason: absent ? 'unavailable' : 'stale' };
    }
    if (blocker === dependent) return { type: 'rejected', reason: 'self' };
    return this.pairEligibility(blocker, dependent);
  }

  private pairEligibility(
    blocker: TaskNodeSnapshot,
    dependent: TaskNodeSnapshot,
  ): TaskDependencyEligibility {
    const blockerId = blocker.node.dependencyId;
    if (blockerId !== undefined && (this.byId.get(blockerId)?.length ?? 0) > 1)
      return { type: 'rejected', reason: 'ambiguous' };
    if (this.prerequisites.get(dependent)?.includes(blocker) === true)
      return { type: 'rejected', reason: 'duplicate' };
    if (this.prerequisites.get(blocker)?.includes(dependent) === true)
      return { type: 'rejected', reason: 'inverse' };
    if (reaches(blocker, dependent, this.prerequisites))
      return { type: 'rejected', reason: 'cycle' };
    return { type: 'allowed' };
  }
}
