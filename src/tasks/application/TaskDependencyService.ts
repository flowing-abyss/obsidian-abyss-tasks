import type {
  DependencyCommandOutcome,
  DependencyRemovalRecovery,
  TaskCommand,
  TaskCommandResult,
  TaskOccurrenceResult,
} from '../domain/commands';
import {
  buildTaskDependencyGraph,
  enumerateTaskNodes,
  type ActiveBlockingRelation,
  type TaskDependencyEligibility,
  type TaskDependencyGraph,
  type TaskNodeSnapshot,
} from '../domain/taskDependencies';
import { isTaskDependencyId } from '../domain/taskLineSourceModel';
import { reconcileTaskNodeRef, type RootReconciliationBasis } from '../domain/taskReconciliation';
import {
  sameTaskNodeRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from '../domain/types';
import type { TaskDependencyQueryApi, TaskQueryApi } from './TaskApplicationApi';
import type {
  TaskEditCommand,
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from './TaskRepository';

type DependencyCommand = Extract<
  TaskCommand,
  {
    readonly type: 'add-dependency' | 'remove-dependency' | 'restore-dependency';
  }
>;
type MetadataCommand = Extract<
  TaskEditCommand,
  { readonly type: 'set-dependency-id' | 'set-depends-on' }
>;
interface ResolvedNode extends TaskNodeSnapshot {
  readonly basis: RootReconciliationBasis;
  readonly predecessor: TaskRef;
}
type NodeResolution = { readonly node: ResolvedNode } | { readonly result: TaskCommandResult };
type Rebase = Extract<TaskRepositoryResult, { readonly type: 'rebased' }>;
type AddCommand = Extract<DependencyCommand, { readonly type: 'add-dependency' }>;
type ChangeCommand = Exclude<DependencyCommand, AddCommand>;
interface DeclaredIdsChange {
  readonly dependencyId: string;
  readonly change: 'removed' | 'restored';
  readonly ids: readonly string[];
  readonly removalRecovery?: DependencyRemovalRecovery;
}
interface DependencyPair {
  readonly blocker: ResolvedNode;
  readonly dependent: ResolvedNode;
  readonly id: string;
}

export type TaskDependencyIdGenerator = (reserved: ReadonlySet<string>) => string;
interface TaskCommandDiagnostic {
  readonly operation: TaskCommand['type'];
  readonly phase: 'unexpected' | 'cross-file-edge-write';
  readonly cause: string;
}
export type TaskDiagnosticSink = (diagnostic: TaskCommandDiagnostic, error?: unknown) => void;

export class DependencyCompletionConflict extends Error {
  constructor() {
    super('Dependency completion target could not be proven');
  }
}

function requireSynchronousCompletionRead(result: unknown): void {
  if (!Array.isArray(result)) throw new DependencyCompletionConflict();
}

function rootKey(ref: TaskRef): string {
  return JSON.stringify([ref.filePath, ref.line, ref.revision]);
}

function dependencyIdentityContent(node: TaskSnapshot | SubtaskSnapshot): unknown {
  return {
    ...node,
    ref: undefined,
    source: undefined,
    dependencyId: undefined,
    dependsOn: undefined,
    status: undefined,
    statusSymbol: undefined,
    subtasks: node.subtasks.map(dependencyIdentityContent),
    comments: node.comments.map((comment) => ({
      ...comment,
      ref: {
        relativeLine: comment.ref.relativeLine,
        originalMarkdown: comment.ref.originalMarkdown,
      },
    })),
  };
}

const mutationQueues = new WeakMap<TaskRepository, { tail?: Promise<void> }>();

function coordinateMutation<T>(
  repository: TaskRepository,
  operation: (queued: boolean) => Promise<T>,
): Promise<T> {
  const queue = mutationQueues.get(repository) ?? {};
  mutationQueues.set(repository, queue);
  const previous = queue.tail;
  let release: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.tail = tail;
  const run = async (): Promise<T> => {
    try {
      return await operation(previous !== undefined);
    } finally {
      if (queue.tail === tail) delete queue.tail;
      release();
    }
  };
  return previous === undefined ? run() : previous.then(run);
}

function rootRef(target: TaskNodeRef): TaskRef {
  let current = target;
  while (current.type === 'subtask') current = current.ref.parent;
  return current.ref;
}

function rootAddress(ref: TaskRef): string {
  return JSON.stringify([ref.filePath, ref.line]);
}

function pathLines(target: TaskNodeRef): readonly number[] {
  const lines: number[] = [];
  let current = target;
  while (current.type === 'subtask') {
    lines.unshift(current.ref.relativeLine);
    current = current.ref.parent;
  }
  return lines;
}

function atAddress(root: TaskSnapshot, target: TaskNodeRef): TaskNodeSnapshot | undefined {
  const wanted = JSON.stringify(pathLines(target));
  return enumerateTaskNodes([root]).find(
    (candidate) => JSON.stringify(pathLines(candidate.target)) === wanted,
  );
}

function confirmedNode(
  root: TaskSnapshot,
  target: TaskNodeRef,
  previous = root,
): TaskNodeSnapshot | undefined {
  const current = reconcileTaskNodeRef(previous, root, target);
  return current === undefined ? undefined : atAddress(root, current);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function invalid(field = 'dependency'): TaskCommandResult {
  return { type: 'invalid', issues: [{ code: 'invalid-target', field }] };
}

function ioError(): TaskCommandResult {
  return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
}

function terminal(result: TaskRepositoryResult): TaskCommandResult {
  if (result.type === 'rebased') return { type: 'conflict', current: result.current };
  if (result.type === 'uncertain') return { type: 'not-found', target: result.target };
  if (result.type === 'committed') return ioError();
  return result;
}

function request(node: ResolvedNode, command: MetadataCommand): TaskEditRequest {
  return { command, baseRoot: node.root, baseTarget: node.target, reconciliation: node.basis };
}

function occurrence(node: TaskNodeSnapshot): TaskOccurrenceResult {
  return { root: node.root, target: node.target };
}

function declaredIdsInputIssue(command: ChangeCommand): TaskCommandResult | undefined {
  const id =
    command.type === 'remove-dependency' ? command.dependencyId : command.recovery.dependencyId;
  if (!isTaskDependencyId(id)) return invalid('dependency-id');
  if (
    command.type === 'restore-dependency' &&
    ![...command.recovery.beforeIds, ...command.recovery.afterIds].every(isTaskDependencyId)
  )
    return invalid('depends-on');
  return undefined;
}

function prepareDeclaredIds(
  command: ChangeCommand,
  dependent: ResolvedNode,
): { readonly change: DeclaredIdsChange } | { readonly result: TaskCommandResult } {
  const beforeIds = [...dependent.node.dependsOn];
  if (command.type === 'restore-dependency') {
    if (!sameIds(beforeIds, command.recovery.afterIds))
      return { result: { type: 'conflict', current: dependent.root } };
    return {
      change: {
        change: 'restored',
        dependencyId: command.recovery.dependencyId,
        ids: [...command.recovery.beforeIds],
      },
    };
  }
  const afterIds = beforeIds.filter((value) => value !== command.dependencyId);
  return {
    change: {
      change: 'removed',
      dependencyId: command.dependencyId,
      ids: afterIds,
      removalRecovery: { dependencyId: command.dependencyId, beforeIds, afterIds },
    },
  };
}

/** A deterministic fallback; the composition root may inject another collision-aware generator. */
export function nextTaskDependencyId(reserved: ReadonlySet<string>): string {
  let value = 0;
  while (reserved.has(value.toString(36).padStart(8, '0'))) value += 1;
  return value.toString(36).padStart(8, '0');
}

export class TaskDependencyService {
  private readonly completionBases: Array<{ previous: TaskSnapshot; current: TaskSnapshot }> = [];

  constructor(
    private readonly queries: TaskQueryApi & TaskDependencyQueryApi,
    private readonly repository: TaskRepository,
    private readonly generateId: TaskDependencyIdGenerator,
    private readonly diagnostics: TaskDiagnosticSink,
  ) {}

  async execute(command: DependencyCommand): Promise<TaskCommandResult> {
    return await this.serializeMutation(() => this.executeDependency(command));
  }

  serializeMutation<T>(operation: (queued: boolean) => Promise<T>): Promise<T> {
    return coordinateMutation(this.repository, operation);
  }

  withCompletionBasis(
    basis: { previous: TaskSnapshot; current: TaskSnapshot },
    readSync: () => readonly ActiveBlockingRelation[],
  ): readonly ActiveBlockingRelation[] {
    this.completionBases.push(basis);
    try {
      const result = readSync();
      requireSynchronousCompletionRead(result);
      return result;
    } finally {
      this.completionBases.pop();
    }
  }

  private async executeDependency(command: DependencyCommand): Promise<TaskCommandResult> {
    try {
      return command.type === 'add-dependency'
        ? await this.add(command)
        : await this.changeDeclaredIds(command);
    } catch {
      this.diagnostics({ operation: command.type, phase: 'unexpected', cause: 'repository-error' });
      return ioError();
    }
  }

  blockersForCompletion(
    currentRoot: TaskSnapshot,
    target: TaskNodeRef,
  ): readonly ActiveBlockingRelation[] {
    const indexed = this.queries.listNodes();
    const predecessor = this.completionPredecessor(currentRoot, target, indexed);
    const currentTarget = reconcileTaskNodeRef(predecessor, currentRoot, target);
    if (currentTarget === undefined) throw new DependencyCompletionConflict();
    const exact = indexed.some((node) => sameTaskNodeRef(node.target, currentTarget));
    const projection = exact
      ? this.queries.dependencies(currentTarget)
      : this.graph([{ root: currentRoot, predecessor: predecessor.ref }]).dependencies(
          currentTarget,
        );
    return projection.blockedBy.filter(
      (relation): relation is ActiveBlockingRelation =>
        relation.type !== 'unavailable' && relation.state === 'active',
    );
  }

  private completionPredecessor(
    current: TaskSnapshot,
    target: TaskNodeRef,
    indexed: readonly TaskNodeSnapshot[],
  ): TaskSnapshot {
    const ref = rootRef(target);
    const basis = this.completionBases[this.completionBases.length - 1];
    if (
      basis !== undefined &&
      rootKey(basis.current.ref) === rootKey(current.ref) &&
      [basis.current.ref, basis.previous.ref].some(
        (candidate) => rootKey(candidate) === rootKey(ref),
      )
    )
      return basis.previous;
    const exact = indexed.find(({ root }) => rootKey(root.ref) === rootKey(ref));
    if (exact !== undefined) return exact.root;
    const resolution = this.queries.resolve(ref);
    if (resolution.type === 'rebased') return resolution.previous;
    if (resolution.type === 'exact') return resolution.task;
    const content = JSON.stringify(dependencyIdentityContent(current));
    const roots = new Map(indexed.map(({ root }) => [rootKey(root.ref), root]));
    const matches = [...roots.values()].filter(
      (root) =>
        root.ref.filePath === current.ref.filePath &&
        JSON.stringify(dependencyIdentityContent(root)) === content,
    );
    const match = matches[0];
    if (matches.length === 1 && match !== undefined) return match;
    throw new DependencyCompletionConflict();
  }

  private graph(
    overlays: ReadonlyArray<{ root: TaskSnapshot; predecessor: TaskRef }> = [],
  ): TaskDependencyGraph {
    const roots = new Map(this.queries.listNodes().map(({ root }) => [rootKey(root.ref), root]));
    for (const { root, predecessor } of overlays) {
      roots.delete(rootKey(predecessor));
      roots.set(rootKey(root.ref), root);
    }
    const nodes = enumerateTaskNodes([...roots.values()]);
    const statuses = new Map(nodes.map(({ node }) => [node.statusSymbol, node.status]));
    return buildTaskDependencyGraph(nodes, (symbol) => statuses.get(symbol) ?? 'open');
  }

  private resolve(target: TaskNodeRef, rebases: readonly Rebase[] = []): NodeResolution {
    const original = rootRef(target);
    const rebase = rebases.find((entry) =>
      sameTaskNodeRef({ type: 'task', ref: entry.previous.ref }, { type: 'task', ref: original }),
    );
    const resolution =
      rebase === undefined
        ? this.queries.resolve(original)
        : {
            type: 'rebased' as const,
            previous: rebase.previous,
            current: rebase.current,
            basis: { observed: rebase.current },
          };
    if (resolution.type === 'ambiguous') return { result: resolution };
    if (resolution.type !== 'exact' && resolution.type !== 'rebased')
      return { result: { type: 'not-found', target } };
    const root = resolution.type === 'exact' ? resolution.task : resolution.current;
    const node = confirmedNode(
      root,
      target,
      resolution.type === 'exact' ? root : resolution.previous,
    );
    return node === undefined
      ? { result: { type: 'conflict', current: root } }
      : { node: { ...node, basis: resolution.basis, predecessor: original } };
  }

  private eligibility(blocker: ResolvedNode, dependent: ResolvedNode): TaskDependencyEligibility {
    const preview = this.queries.dependencyEligibility(blocker.target, dependent.target);
    return preview.type === 'rejected' &&
      (preview.reason === 'stale' || preview.reason === 'unavailable')
      ? this.graph([blocker, dependent]).eligibility(blocker.target, dependent.target)
      : preview;
  }

  private eligibilityFailure(
    eligibility: Extract<TaskDependencyEligibility, { readonly type: 'rejected' }>,
    blocker: ResolvedNode,
  ): TaskCommandResult {
    if (eligibility.reason === 'ambiguous')
      return {
        type: 'ambiguous',
        candidates: this.queries
          .listNodes()
          .filter(({ node }) => node.dependencyId === blocker.node.dependencyId)
          .map(occurrence),
      };
    return invalid();
  }

  private allocateId(): string | undefined {
    const reserved = new Set(
      this.queries
        .listNodes()
        .flatMap(({ node }) => [
          ...(node.dependencyId === undefined ? [] : [node.dependencyId]),
          ...node.dependsOn,
        ]),
    );
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = this.generateId(reserved);
      if (/^[a-z0-9]{8}$/u.test(id) && !reserved.has(id)) return id;
    }
    return undefined;
  }

  private edit(edit: TaskEditRequest): Promise<TaskRepositoryResult> {
    return this.repository.edit(
      this.repository.supportsRevisionPreconditions === true ? edit : edit.command,
    );
  }

  private async add(
    command: AddCommand,
    rebases: readonly Rebase[] = [],
  ): Promise<TaskCommandResult> {
    const blocker = this.resolve(command.blocker, rebases);
    if ('result' in blocker) return blocker.result;
    const dependent = this.resolve(command.dependent, rebases);
    if ('result' in dependent) return dependent.result;
    const eligibility = this.eligibility(blocker.node, dependent.node);
    if (eligibility.type === 'rejected') return this.eligibilityFailure(eligibility, blocker.node);
    const id = blocker.node.node.dependencyId ?? this.allocateId();
    if (id === undefined) return invalid('dependency-id');
    const pair = { blocker: blocker.node, dependent: dependent.node, id };
    if (pair.blocker.root.ref.filePath !== pair.dependent.root.ref.filePath)
      return await this.addAcrossFiles(command, pair, rebases);
    const result = await this.addWithinFile(pair);
    if (result.type === 'rebased' && rebases.length === 0) return await this.add(command, [result]);
    return this.addedResult(result, dependent.node, blocker.node, id);
  }

  private addWithinFile({ blocker, dependent, id }: DependencyPair): Promise<TaskRepositoryResult> {
    // Confirm both endpoints in the atomic transition, even when the blocker already has its ID.
    const edits = [
      request(blocker, { type: 'set-dependency-id', target: blocker.target, id }),
      request(dependent, {
        type: 'set-depends-on',
        target: dependent.target,
        ids: [...dependent.node.dependsOn, id],
      }),
    ];
    return this.repository.editBatch({
      filePath: dependent.root.ref.filePath,
      edits,
      outcomeTarget: dependent.target,
    });
  }

  private async addAcrossFiles(
    command: AddCommand,
    pair: DependencyPair,
    rebases: readonly Rebase[],
  ): Promise<TaskCommandResult> {
    const { blocker, id } = pair;
    let currentBlocker = blocker;
    if (blocker.node.dependencyId === undefined) {
      const assigned = await this.edit(
        request(blocker, { type: 'set-dependency-id', target: blocker.target, id }),
      );
      if (assigned.type === 'rebased' && rebases.length === 0)
        return await this.add(command, [assigned]);
      if (assigned.type !== 'committed') return terminal(assigned);
      const fresh = this.committedNode(assigned, blocker.target);
      if (fresh?.node.dependencyId !== id) return ioError();
      currentBlocker = { ...fresh, basis: { observed: fresh.root }, predecessor: blocker.root.ref };
    }
    try {
      const result = await this.writeCrossFileEdge({ ...pair, blocker: currentBlocker });
      if (result.type !== 'ok')
        this.diagnostics({
          operation: command.type,
          phase: 'cross-file-edge-write',
          cause: result.type,
        });
      return result;
    } catch {
      this.diagnostics({
        operation: command.type,
        phase: 'cross-file-edge-write',
        cause: 'repository-error',
      });
      return ioError();
    }
  }

  private async writeCrossFileEdge(pair: DependencyPair): Promise<TaskCommandResult> {
    const rebases: Rebase[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.currentPair(pair, rebases);
      if ('result' in current) return current.result;
      const { blocker, dependent, id } = current.pair;
      const result = await this.edit(
        request(dependent, {
          type: 'set-depends-on',
          target: dependent.target,
          ids: [...dependent.node.dependsOn, id],
        }),
      );
      if (result.type !== 'rebased' || attempt === 1)
        return this.addedResult(result, dependent, blocker, id);
      rebases.push(result);
    }
    return ioError();
  }

  private currentPair(
    pair: DependencyPair,
    rebases: readonly Rebase[],
  ): { readonly pair: DependencyPair } | { readonly result: TaskCommandResult } {
    const blocker = this.resolve(pair.blocker.target, rebases);
    if ('result' in blocker) return blocker;
    if (blocker.node.node.dependencyId !== pair.id)
      return { result: { type: 'conflict', current: blocker.node.root } };
    const dependent = this.resolve(pair.dependent.target, rebases);
    if ('result' in dependent) return dependent;
    const allowed = this.eligibility(blocker.node, dependent.node);
    return allowed.type === 'rejected'
      ? { result: this.eligibilityFailure(allowed, blocker.node) }
      : { pair: { blocker: blocker.node, dependent: dependent.node, id: pair.id } };
  }

  private committedNode(
    result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
    target: TaskNodeRef,
  ): TaskNodeSnapshot | undefined {
    return result.outcome.type === 'task' ? atAddress(result.outcome.task, target) : undefined;
  }

  private addedResult(
    result: TaskRepositoryResult,
    dependent: ResolvedNode,
    blocker: ResolvedNode,
    id: string,
  ): TaskCommandResult {
    if (result.type !== 'committed') return terminal(result);
    const freshDependent = this.committedNode(result, dependent.target);
    if (freshDependent?.node.dependsOn.includes(id) !== true) return ioError();
    const sameRoot = rootAddress(dependent.root.ref) === rootAddress(blocker.root.ref);
    const freshBlocker = this.projectedBlocker(
      blocker,
      id,
      sameRoot ? freshDependent.root : undefined,
    );
    return {
      type: 'ok',
      changed: result.changed,
      outcome: {
        type: 'dependency',
        change: 'added',
        dependencyId: id,
        dependent: occurrence(freshDependent),
        ...(freshBlocker === undefined ? {} : { blocker: occurrence(freshBlocker) }),
      },
    };
  }

  private projectedBlocker(
    blocker: ResolvedNode,
    id: string,
    committedRoot?: TaskSnapshot,
  ): TaskNodeSnapshot | undefined {
    const matches = this.queries.listNodes().filter(({ node }) => node.dependencyId === id);
    if (matches.length !== 1) return undefined;
    const candidate = matches[0];
    const resolution =
      committedRoot === undefined
        ? this.queries.resolve(blocker.root.ref)
        : { type: 'exact' as const, task: committedRoot };
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return undefined;
    const root = resolution.type === 'exact' ? resolution.task : resolution.current;
    const intended = atAddress(root, blocker.target);
    return candidate !== undefined &&
      intended !== undefined &&
      sameTaskNodeRef(candidate.target, intended.target)
      ? candidate
      : undefined;
  }

  private async changeDeclaredIds(
    command: ChangeCommand,
    rebases: readonly Rebase[] = [],
  ): Promise<TaskCommandResult> {
    const issue = declaredIdsInputIssue(command);
    if (issue !== undefined) return issue;
    const resolved = this.resolve(command.dependent, rebases);
    if ('result' in resolved) return resolved.result;
    const dependent = resolved.node;
    const prepared = prepareDeclaredIds(command, dependent);
    if ('result' in prepared) return prepared.result;
    const { change } = prepared;
    if (sameIds(dependent.node.dependsOn, change.ids))
      return this.changedIdsResult(dependent, change, false);
    const result = await this.edit(
      request(dependent, { type: 'set-depends-on', target: dependent.target, ids: change.ids }),
    );
    if (result.type === 'rebased' && rebases.length === 0)
      return await this.changeDeclaredIds(command, [result]);
    if (result.type !== 'committed') return terminal(result);
    const fresh = this.committedNode(result, dependent.target);
    return fresh === undefined ? ioError() : this.changedIdsResult(fresh, change, result.changed);
  }

  private changedIdsResult(
    dependent: TaskNodeSnapshot,
    change: DeclaredIdsChange,
    changed: boolean,
  ): TaskCommandResult {
    const { dependencyId: id, removalRecovery: recovery } = change;
    const matches = this.queries.listNodes().filter(({ node }) => node.dependencyId === id);
    const blocker = matches.length === 1 ? matches[0] : undefined;
    const outcome: DependencyCommandOutcome = {
      type: 'dependency',
      change: change.change,
      dependencyId: id,
      dependent: occurrence(dependent),
      ...(blocker === undefined ? {} : { blocker: occurrence(blocker) }),
      ...(recovery === undefined ? {} : { removalRecovery: recovery }),
    };
    return { type: 'ok', changed, outcome };
  }
}
