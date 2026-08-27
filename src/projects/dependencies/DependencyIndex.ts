import type { TaskIndexEvent, TaskQueryApi } from '../../tasks/application/TaskApplicationApi';
import type { TaskRef, TaskSnapshot } from '../../tasks/domain/types';

export type DependencyDiagnostic =
  | {
      readonly type: 'missing-prerequisite';
      readonly id: string;
    }
  | {
      readonly type: 'duplicate-id';
      readonly id: string;
      readonly candidates: readonly TaskRef[];
    }
  | { readonly type: 'self-edge'; readonly id: string }
  | { readonly type: 'cycle'; readonly ids: readonly string[] };

export type DependencyProjection =
  | { readonly type: 'ready'; readonly ref: TaskRef }
  | { readonly type: 'blocked'; readonly ref: TaskRef; readonly prerequisites: readonly TaskRef[] }
  | {
      readonly type: 'invalid';
      readonly ref: TaskRef;
      readonly diagnostics: readonly DependencyDiagnostic[];
    };

type Listener = (affected: readonly TaskRef[]) => void;

interface DependencyNode {
  readonly task: TaskSnapshot;
  readonly identity: string;
}

function compareRefs(left: TaskRef, right: TaskRef): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.revision.localeCompare(right.revision)
  );
}

function cloneRef(ref: TaskRef): TaskRef {
  return { ...ref };
}

function diagnosticSignature(diagnostic: DependencyDiagnostic): string {
  switch (diagnostic.type) {
    case 'missing-prerequisite':
    case 'self-edge':
      return `${diagnostic.type}:${diagnostic.id}`;
    case 'duplicate-id':
      return `${diagnostic.type}:${diagnostic.id}:${diagnostic.candidates
        .map((candidate) => nodeRefSignature(candidate))
        .join(',')}`;
    case 'cycle':
      return `${diagnostic.type}:${diagnostic.ids.join(',')}`;
  }
}

function nodeRefSignature(ref: TaskRef): string {
  return `${ref.filePath}\u0000${ref.line}\u0000${ref.revision}`;
}

function projectionSignature(projection: DependencyProjection): string {
  switch (projection.type) {
    case 'ready':
      return 'ready';
    case 'blocked':
      return `blocked:${projection.prerequisites.map(nodeRefSignature).join(',')}`;
    case 'invalid':
      return `invalid:${projection.diagnostics.map(diagnosticSignature).join('|')}`;
  }
}

function cloneProjection(projection: DependencyProjection): DependencyProjection {
  switch (projection.type) {
    case 'ready':
      return { type: 'ready', ref: cloneRef(projection.ref) };
    case 'blocked':
      return {
        type: 'blocked',
        ref: cloneRef(projection.ref),
        prerequisites: projection.prerequisites.map(cloneRef),
      };
    case 'invalid':
      return {
        type: 'invalid',
        ref: cloneRef(projection.ref),
        diagnostics: projection.diagnostics.map((diagnostic) => {
          if (diagnostic.type !== 'duplicate-id') return { ...diagnostic };
          return { ...diagnostic, candidates: diagnostic.candidates.map(cloneRef) };
        }),
      };
  }
}

/**
 * Read-only graph projection of Obsidian Tasks-compatible task carriers.
 *
 * It owns no task source of truth: files are supplied by TaskIndex (or a caller in tests), and
 * every update reprojects diagnostics before notifying only nodes whose graph input or output
 * changed. No source text is edited or normalized.
 */
export class DependencyIndex {
  private readonly tasksByFile = new Map<string, readonly TaskSnapshot[]>();
  private projections = new Map<string, DependencyProjection>();
  private nodes = new Map<string, DependencyNode>();
  private listeners: Listener[] = [];
  private unsubscribe: (() => void) | undefined;

  constructor(source?: Pick<TaskQueryApi, 'list' | 'subscribe'>) {
    if (!source) return;
    this.replace(source.list());
    this.unsubscribe = source.subscribe((event) => this.onTaskIndexEvent(source, event));
  }

  get(ref: TaskRef): DependencyProjection | undefined {
    const projection = [...this.projections.values()].find(
      (candidate) => nodeRefSignature(candidate.ref) === nodeRefSignature(ref),
    );
    return projection === undefined ? undefined : cloneProjection(projection);
  }

  list(): readonly DependencyProjection[] {
    return [...this.projections.values()]
      .sort((left, right) => compareRefs(left.ref, right.ref))
      .map(cloneProjection);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners = [];
    this.tasksByFile.clear();
    this.nodes.clear();
    this.projections.clear();
  }

  replace(tasks: readonly TaskSnapshot[]): void {
    const byFile = new Map<string, TaskSnapshot[]>();
    for (const task of tasks) {
      const current = byFile.get(task.source.filePath) ?? [];
      current.push(task);
      byFile.set(task.source.filePath, current);
    }
    this.tasksByFile.clear();
    for (const [path, fileTasks] of byFile) this.tasksByFile.set(path, fileTasks);
    this.reproject();
  }

  updateFile(filePath: string, tasks: readonly TaskSnapshot[]): void {
    this.updateFiles([[filePath, tasks]]);
  }

  private updateFiles(entries: readonly (readonly [string, readonly TaskSnapshot[]])[]): void {
    for (const [filePath, tasks] of entries) {
      if (tasks.length === 0) this.tasksByFile.delete(filePath);
      else this.tasksByFile.set(filePath, [...tasks]);
    }
    this.reproject();
  }

  private onTaskIndexEvent(source: Pick<TaskQueryApi, 'list'>, event: TaskIndexEvent): void {
    if (event.type === 'initialized') {
      this.replace(source.list());
      return;
    }
    if (event.type === 'changed') {
      this.updateFiles(
        event.files.map((filePath) => [filePath, source.list({ filePath })] as const),
      );
      return;
    }
    if (event.type === 'deleted') {
      this.updateFile(event.path, []);
      return;
    }
    if (event.type === 'renamed') {
      this.updateFiles([
        [event.oldPath, []],
        [event.newPath, source.list({ filePath: event.newPath })],
      ]);
    }
  }

  private reproject(): void {
    const nextNodes = this.buildNodes();
    const candidates = this.candidatesFor(nextNodes);
    const { resolvedEdges, diagnosticsByNode } = this.resolveEdges(nextNodes, candidates);
    const cycleByNode = this.cyclesFor(nextNodes, resolvedEdges);
    const nextProjections = this.projectNodes(
      nextNodes,
      resolvedEdges,
      diagnosticsByNode,
      cycleByNode,
    );
    this.publishChanges(nextNodes, nextProjections);
  }

  private buildNodes(): Map<string, DependencyNode> {
    const nextNodes = new Map<string, DependencyNode>();
    const tasks = [...this.tasksByFile.values()]
      .flat()
      .sort((left, right) => compareRefs(left.ref, right.ref));
    const idCounts = new Map<string, number>();
    for (const task of tasks) {
      const id = task.dependency?.id;
      if (id !== undefined) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    for (const task of tasks) {
      const id = task.dependency?.id;
      // A unique ID is intentionally the identity: moving or revising the source must not make
      // reverse dependents look like a different graph node. Duplicate candidates remain unique
      // by their raw source without ever choosing a winner.
      let base = `source:${task.source.filePath}\u0000${task.source.originalBlock}`;
      if (id !== undefined) {
        base =
          idCounts.get(id) === 1 ? `id:${id}` : `duplicate:${id}\u0000${task.source.originalBlock}`;
      }
      const identity = nextNodes.has(base) ? `${base}\u0000${nodeRefSignature(task.ref)}` : base;
      nextNodes.set(identity, { task, identity });
    }
    return nextNodes;
  }

  private candidatesFor(
    nextNodes: ReadonlyMap<string, DependencyNode>,
  ): Map<string, DependencyNode[]> {
    const candidates = new Map<string, DependencyNode[]>();
    for (const node of nextNodes.values()) {
      const id = node.task.dependency?.id;
      if (id === undefined) continue;
      const entries = candidates.get(id) ?? [];
      entries.push(node);
      candidates.set(id, entries);
    }
    for (const entries of candidates.values()) {
      entries.sort((left, right) => compareRefs(left.task.ref, right.task.ref));
    }
    return candidates;
  }

  private resolveEdges(
    nextNodes: ReadonlyMap<string, DependencyNode>,
    candidates: ReadonlyMap<string, readonly DependencyNode[]>,
  ): {
    readonly resolvedEdges: Map<string, DependencyNode[]>;
    readonly diagnosticsByNode: Map<string, DependencyDiagnostic[]>;
  } {
    const resolvedEdges = new Map<string, DependencyNode[]>();
    const diagnosticsByNode = new Map<string, DependencyDiagnostic[]>();
    const addDiagnostic = (node: DependencyNode, diagnostic: DependencyDiagnostic): void => {
      const diagnostics = diagnosticsByNode.get(node.identity) ?? [];
      diagnostics.push(diagnostic);
      diagnosticsByNode.set(node.identity, diagnostics);
    };

    for (const node of nextNodes.values()) {
      const ownId = node.task.dependency?.id;
      if (ownId !== undefined && (candidates.get(ownId)?.length ?? 0) > 1) {
        addDiagnostic(node, {
          type: 'duplicate-id',
          id: ownId,
          candidates: candidates.get(ownId)!.map((candidate) => cloneRef(candidate.task.ref)),
        });
      }
      const edges: DependencyNode[] = [];
      for (const dependencyId of node.task.dependency?.dependsOn ?? []) {
        if (dependencyId === ownId) {
          addDiagnostic(node, { type: 'self-edge', id: dependencyId });
          continue;
        }
        const matches = candidates.get(dependencyId) ?? [];
        if (matches.length === 0) {
          addDiagnostic(node, { type: 'missing-prerequisite', id: dependencyId });
        } else if (matches.length > 1) {
          addDiagnostic(node, {
            type: 'duplicate-id',
            id: dependencyId,
            candidates: matches.map((candidate) => cloneRef(candidate.task.ref)),
          });
        } else {
          edges.push(matches[0]!);
        }
      }
      resolvedEdges.set(node.identity, edges);
    }
    return { resolvedEdges, diagnosticsByNode };
  }

  private cyclesFor(
    nextNodes: ReadonlyMap<string, DependencyNode>,
    resolvedEdges: ReadonlyMap<string, readonly DependencyNode[]>,
  ): Map<string, readonly string[]> {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: DependencyNode[] = [];
    const cycleByNode = new Map<string, readonly string[]>();
    const visit = (node: DependencyNode): void => {
      if (visited.has(node.identity)) return;
      if (visiting.has(node.identity)) {
        const start = stack.findIndex((candidate) => candidate.identity === node.identity);
        const cycle = stack
          .slice(start)
          .map((candidate) => candidate.task.dependency?.id)
          .filter((id): id is string => id !== undefined)
          .sort((left, right) => left.localeCompare(right));
        for (const candidate of stack.slice(start)) cycleByNode.set(candidate.identity, cycle);
        return;
      }
      visiting.add(node.identity);
      stack.push(node);
      for (const edge of resolvedEdges.get(node.identity) ?? []) visit(edge);
      stack.pop();
      visiting.delete(node.identity);
      visited.add(node.identity);
    };
    for (const node of nextNodes.values()) visit(node);
    return cycleByNode;
  }

  private projectNodes(
    nextNodes: ReadonlyMap<string, DependencyNode>,
    resolvedEdges: ReadonlyMap<string, readonly DependencyNode[]>,
    diagnosticsByNode: ReadonlyMap<string, readonly DependencyDiagnostic[]>,
    cycleByNode: ReadonlyMap<string, readonly string[]>,
  ): Map<string, DependencyProjection> {
    const nextProjections = new Map<string, DependencyProjection>();
    for (const node of nextNodes.values()) {
      const diagnostics = [...(diagnosticsByNode.get(node.identity) ?? [])];
      const cycle = cycleByNode.get(node.identity);
      if (cycle) diagnostics.push({ type: 'cycle', ids: cycle });
      const orderedDiagnostics = [...diagnostics].sort((left, right) =>
        diagnosticSignature(left).localeCompare(diagnosticSignature(right)),
      );
      const ref = cloneRef(node.task.ref);
      if (orderedDiagnostics.length > 0) {
        nextProjections.set(node.identity, {
          type: 'invalid',
          ref,
          diagnostics: orderedDiagnostics,
        });
        continue;
      }
      const prerequisites = (resolvedEdges.get(node.identity) ?? []).map((edge) => edge.task);
      const incomplete = prerequisites.filter((prerequisite) => prerequisite.status !== 'done');
      nextProjections.set(
        node.identity,
        incomplete.length === 0
          ? { type: 'ready', ref }
          : {
              type: 'blocked',
              ref,
              prerequisites: incomplete.map((prerequisite) => cloneRef(prerequisite.ref)),
            },
      );
    }
    return nextProjections;
  }

  private publishChanges(
    nextNodes: Map<string, DependencyNode>,
    nextProjections: Map<string, DependencyProjection>,
  ): void {
    const affected = new Map<string, TaskRef>();
    for (const [identity, projection] of nextProjections) {
      const previous = this.projections.get(identity);
      const previousNode = this.nodes.get(identity)?.task;
      const currentNode = nextNodes.get(identity)?.task;
      const inputChanged =
        previousNode === undefined ||
        currentNode === undefined ||
        previousNode.status !== currentNode.status ||
        previousNode.dependency?.id !== currentNode.dependency?.id ||
        (previousNode.dependency?.dependsOn ?? []).join(',') !==
          (currentNode.dependency?.dependsOn ?? []).join(',');
      if (
        !previous ||
        inputChanged ||
        projectionSignature(previous) !== projectionSignature(projection)
      ) {
        affected.set(identity, cloneRef(projection.ref));
      }
    }
    for (const [identity, projection] of this.projections) {
      if (!nextProjections.has(identity)) affected.set(identity, cloneRef(projection.ref));
    }

    this.nodes = nextNodes;
    this.projections = nextProjections;
    const refs = [...affected.values()].sort(compareRefs);
    if (refs.length > 0) for (const listener of this.listeners) listener(refs);
  }
}
