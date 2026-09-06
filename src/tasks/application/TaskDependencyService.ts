import type {
  CreateDependencySubtaskCommand,
  DependencyCommandOutcome,
  DependencyRemovalRecovery,
  DependencySubtaskCreationOutcome,
  ReverseDependencyCommand,
  TaskCommand,
  TaskCommandResult,
  TaskOccurrenceResult,
} from '../domain/commands';
import { dependencySubtaskChild } from '../domain/dependencySubtaskProof';
import { taskNodeRootRef as rootRef } from '../domain/taskCommandTargets';
import {
  buildTaskDependencyGraph,
  enumerateTaskNodes,
  type ActiveBlockingRelation,
  type TaskDependencyEligibility,
  type TaskDependencyGraph,
  type TaskNodeSnapshot,
} from '../domain/taskDependencies';
import { isTaskDependencyId } from '../domain/taskLineSourceModel';
import {
  reconcileTaskNodeRef,
  sameTaskTreeExceptDependencies,
  type RootReconciliationBasis,
} from '../domain/taskReconciliation';
import { sameTaskTreeWithOwnedChanges } from '../domain/taskTreeChangeProof';
import {
  sameTaskNodeRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from '../domain/types';
import type { TaskDependencyQueryApi, TaskQueryApi } from './TaskApplicationApi';
import type {
  CreateDependencySubtaskRequest,
  DependencyReversalPhase,
  TaskEditBatchRequest,
  TaskEditCommand,
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from './TaskRepository';

type DependencyCommand = Extract<
  TaskCommand,
  {
    readonly type:
      'add-dependency' | 'remove-dependency' | 'restore-dependency' | 'reverse-dependency';
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
type ChangeCommand = Exclude<DependencyCommand, AddCommand | ReverseDependencyCommand>;
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
  readonly phase: 'unexpected' | 'cross-file-edge-write' | `reversal-${DependencyReversalPhase}`;
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

function rootAddress(ref: Pick<TaskRef, 'filePath' | 'line'>): string {
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

function taskLine(node: TaskSnapshot | SubtaskSnapshot): string {
  return 'source' in node
    ? node.source.originalMarkdown
    : (node.ref.originalBlock.split(/\r?\n/u, 1)[0] ?? '');
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

function request(
  node: ResolvedNode,
  command: MetadataCommand,
): TaskEditRequest & { readonly command: MetadataCommand } {
  return { command, baseRoot: node.root, baseTarget: node.target, reconciliation: node.basis };
}

function declaredIdsRequest(
  dependent: ResolvedNode,
  change: DeclaredIdsChange,
  command: ChangeCommand,
): TaskEditRequest {
  const restoreSource =
    command.type === 'restore-dependency' ? command.recovery.source?.before : undefined;
  return request(dependent, {
    type: 'set-depends-on',
    target: dependent.target,
    ids: change.ids,
    ...(restoreSource === undefined ? {} : { restoreSource }),
  });
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
    if (
      !sameIds(beforeIds, command.recovery.afterIds) ||
      (command.recovery.source !== undefined &&
        taskLine(dependent.node) !== command.recovery.source.after)
    )
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

interface DependencyContext {
  readonly queries: TaskQueryApi & TaskDependencyQueryApi;
  readonly repository: TaskRepository;
  readonly generateId: TaskDependencyIdGenerator;
  readonly diagnostics: TaskDiagnosticSink;
  readonly completionBases: Array<{ previous: TaskSnapshot; current: TaskSnapshot }>;
}

async function executeDependency(
  context: DependencyContext,
  command: DependencyCommand,
): Promise<TaskCommandResult> {
  try {
    if (command.type === 'reverse-dependency') return await reverse(context, command);
    return command.type === 'add-dependency'
      ? await add(context, command)
      : await changeDeclaredIds(context, command);
  } catch {
    context.diagnostics({
      operation: command.type,
      phase: 'unexpected',
      cause: 'repository-error',
    });
    return ioError();
  }
}

function completionPredecessor(
  context: DependencyContext,
  current: TaskSnapshot,
  target: TaskNodeRef,
  indexed: readonly TaskNodeSnapshot[],
): TaskSnapshot {
  const { completionBases } = context;
  const ref = rootRef(target);
  const basis = completionBases[completionBases.length - 1];
  if (
    basis !== undefined &&
    rootKey(basis.current.ref) === rootKey(current.ref) &&
    [basis.current.ref, basis.previous.ref].some((candidate) => rootKey(candidate) === rootKey(ref))
  )
    return basis.previous;
  const exact = indexed.find(({ root }) => rootKey(root.ref) === rootKey(ref));
  if (exact !== undefined) return exact.root;
  const resolution = context.queries.resolve(ref);
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

function dependencyNodes(
  context: DependencyContext,
  overlays: ReadonlyArray<{ root: TaskSnapshot; predecessor: TaskRef }> = [],
): readonly TaskNodeSnapshot[] {
  const roots = new Map(context.queries.listNodes().map(({ root }) => [rootKey(root.ref), root]));
  for (const { root, predecessor } of overlays) {
    roots.delete(rootKey(predecessor));
    roots.set(rootKey(root.ref), root);
  }
  return enumerateTaskNodes([...roots.values()]);
}

function graph(
  context: DependencyContext,
  overlays: ReadonlyArray<{ root: TaskSnapshot; predecessor: TaskRef }> = [],
): TaskDependencyGraph {
  const nodes = dependencyNodes(context, overlays);
  const statuses = new Map(nodes.map(({ node }) => [node.statusSymbol, node.status]));
  return buildTaskDependencyGraph(nodes, (symbol) => statuses.get(symbol) ?? 'open');
}

function resolve(
  context: DependencyContext,
  target: TaskNodeRef,
  rebases: readonly Rebase[] = [],
): NodeResolution {
  const original = rootRef(target);
  const rebase = rebases.find((entry) =>
    sameTaskNodeRef({ type: 'task', ref: entry.previous.ref }, { type: 'task', ref: original }),
  );
  const resolution =
    rebase === undefined
      ? context.queries.resolve(original)
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

function dependencyEligibility(
  context: DependencyContext,
  blocker: ResolvedNode,
  dependent: ResolvedNode,
): TaskDependencyEligibility {
  const preview = context.queries.dependencyEligibility(blocker.target, dependent.target);
  return preview.type === 'rejected' &&
    (preview.reason === 'stale' || preview.reason === 'unavailable')
    ? graph(context, [blocker, dependent]).eligibility(blocker.target, dependent.target)
    : preview;
}

function eligibilityFailure(
  context: DependencyContext,
  eligibility: Extract<TaskDependencyEligibility, { readonly type: 'rejected' }>,
  blocker: ResolvedNode,
): TaskCommandResult {
  if (eligibility.reason === 'ambiguous')
    return {
      type: 'ambiguous',
      candidates: context.queries
        .listNodes()
        .filter(({ node }) => node.dependencyId === blocker.node.dependencyId)
        .map(occurrence),
    };
  return invalid();
}

function allocateId(
  context: DependencyContext,
  nodes = context.queries.listNodes(),
): string | undefined {
  const reserved = new Set(
    nodes.flatMap(({ node }) => [
      ...(node.dependencyId === undefined ? [] : [node.dependencyId]),
      ...node.dependsOn,
    ]),
  );
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = context.generateId(reserved);
    if (/^[a-z0-9]{8}$/u.test(id) && !reserved.has(id)) return id;
  }
  return undefined;
}

async function createSubtask(
  context: DependencyContext,
  command: CreateDependencySubtaskCommand,
  lifecycle: Pick<CreateDependencySubtaskRequest, 'today' | 'addCreatedDate'>,
  rebases: readonly Rebase[] = [],
): Promise<TaskCommandResult> {
  const resolved = resolve(context, command.current, rebases);
  if ('result' in resolved) return resolved.result;
  const current = resolved.node;
  const allocation = creationId(context, current, command.direction);
  if ('result' in allocation) return allocation.result;
  const { id } = allocation;
  const result = await context.repository.createDependencySubtask({
    baseRoot: current.root,
    baseTarget: current.target,
    reconciliation: current.basis,
    direction: command.direction,
    text: command.text,
    ...(command.direction === 'blocks' ? { currentId: id } : { childId: id }),
    ...lifecycle,
  });
  if (result.type === 'rebased' && rebases.length === 0)
    return await createSubtask(context, command, lifecycle, [result]);
  if (result.type !== 'committed') return terminal(result);
  return createdSubtaskResult(context, result, current, { command, id });
}

function creationId(
  context: DependencyContext,
  current: ResolvedNode,
  direction: CreateDependencySubtaskCommand['direction'],
): { readonly id: string } | { readonly result: TaskCommandResult } {
  const existing = direction === 'blocks' ? current.node.dependencyId : undefined;
  const nodes = dependencyNodes(context, [current]);
  if (existing !== undefined) {
    const candidates = nodes.filter(({ node }) => node.dependencyId === existing);
    if (candidates.length !== 1)
      return { result: { type: 'ambiguous', candidates: candidates.map(occurrence) } };
  }
  const id = existing ?? allocateId(context, nodes);
  return id === undefined ? { result: invalid('dependency-id') } : { id };
}

function createdSubtaskResult(
  context: DependencyContext,
  result: Extract<TaskRepositoryResult, { type: 'committed' }>,
  current: ResolvedNode,
  expected: { readonly command: CreateDependencySubtaskCommand; readonly id: string },
): TaskCommandResult {
  const { command, id } = expected;
  const outcome = result.outcome;
  if (
    outcome.type !== 'dependency-subtask' ||
    outcome.direction !== command.direction ||
    outcome.dependencyId !== id ||
    !provenCreatedSubtask(context, current, outcome, command)
  )
    throw new Error('Unproven dependency subtask creation');
  return { type: 'ok', changed: result.changed, outcome };
}

function provenCreationRoot(
  context: DependencyContext,
  current: TaskSnapshot,
  outcome: DependencySubtaskCreationOutcome,
): boolean {
  const root = outcome.current.root;
  const authority = context.queries.resolve(root.ref);
  const snapshot = JSON.stringify(root);
  return (
    rootAddress(root.source) === rootAddress(current.source) &&
    root.ref.revision !== current.ref.revision &&
    authority.type === 'exact' &&
    JSON.stringify(authority.task) === snapshot &&
    JSON.stringify(outcome.child.root) === snapshot
  );
}

function provenCreatedSubtask(
  context: DependencyContext,
  current: ResolvedNode,
  outcome: DependencySubtaskCreationOutcome,
  command: CreateDependencySubtaskCommand,
): boolean {
  if (!provenCreationRoot(context, current.root, outcome)) return false;
  const fresh = atAddress(outcome.current.root, current.target);
  if (fresh === undefined) return false;
  const child = dependencySubtaskChild(current.node, fresh.node, command);
  if (child === undefined) return false;
  const path = nodeIndices(current);
  return (
    sameTaskTreeWithOwnedChanges(current.root, fresh.root, path, {
      fields: new Set(['dependencyId', 'dependsOn']),
      append: true,
    }) &&
    sameTaskNodeRef(fresh.target, outcome.current.target) &&
    sameTaskNodeRef({ type: 'subtask', ref: child.ref }, outcome.child.target) &&
    (command.direction === 'blocks' ? fresh.node.dependencyId : child.dependencyId) ===
      outcome.dependencyId
  );
}

function nodeIndices(current: TaskNodeSnapshot): number[] {
  return current.path.map(
    (node, index) =>
      (index === 0 ? current.root : current.path[index - 1])?.subtasks.indexOf(node) ?? -1,
  );
}

function edit(context: DependencyContext, edit: TaskEditRequest): Promise<TaskRepositoryResult> {
  const { repository } = context;
  return repository.edit(repository.supportsRevisionPreconditions === true ? edit : edit.command);
}

async function add(
  context: DependencyContext,
  command: AddCommand,
  rebases: readonly Rebase[] = [],
): Promise<TaskCommandResult> {
  const blocker = resolve(context, command.blocker, rebases);
  if ('result' in blocker) return blocker.result;
  const dependent = resolve(context, command.dependent, rebases);
  if ('result' in dependent) return dependent.result;
  const eligibility = dependencyEligibility(context, blocker.node, dependent.node);
  if (eligibility.type === 'rejected')
    return eligibilityFailure(context, eligibility, blocker.node);
  const id = blocker.node.node.dependencyId ?? allocateId(context);
  if (id === undefined) return invalid('dependency-id');
  const pair = { blocker: blocker.node, dependent: dependent.node, id };
  if (pair.blocker.root.ref.filePath !== pair.dependent.root.ref.filePath)
    return await addAcrossFiles(context, command, pair, rebases);
  const result = await addWithinFile(context, pair);
  if (result.type === 'rebased' && rebases.length === 0)
    return await add(context, command, [result]);
  return addedResult(context, result, pair);
}

async function reverse(
  context: DependencyContext,
  command: ReverseDependencyCommand,
): Promise<TaskCommandResult> {
  const prepared = prepareReversal(context, command);
  if ('result' in prepared) return prepared.result;
  const { blocker: original, dependent: next, id } = prepared.pair;
  if (context.repository.reverseDependency === undefined) return invalid('dependency-write');
  const edits = [
    request(next, { type: 'set-dependency-id', target: next.target, id }),
    request(next, {
      type: 'set-depends-on',
      target: next.target,
      ids: next.node.dependsOn.filter((value) => value !== command.dependencyId),
    }),
    request(original, {
      type: 'set-depends-on',
      target: original.target,
      ids: [...original.node.dependsOn, id],
    }),
  ];
  const batches = new Map<string, TaskEditBatchRequest>();
  for (const edit of edits) {
    const filePath = edit.baseRoot.ref.filePath;
    const previous = batches.get(filePath);
    batches.set(filePath, {
      filePath,
      edits: [...(previous?.edits ?? []), edit],
      outcomeTarget: edit.command.target,
    });
  }
  const result = await context.repository.reverseDependency({
    batches: [...batches.values()],
    proveReversal: (roots) => reversedOutcome(roots, original, next, id),
    diagnostic: (phase, cause) => {
      context.diagnostics({ operation: command.type, phase: `reversal-${phase}`, cause });
    },
  });
  return result.type === 'committed'
    ? { type: 'ok', changed: result.changed, outcome: result.outcome }
    : terminal(result);
}

function prepareReversal(
  context: DependencyContext,
  command: ReverseDependencyCommand,
): { readonly pair: DependencyPair } | { readonly result: TaskCommandResult } {
  if (!isTaskDependencyId(command.dependencyId)) return { result: invalid('dependency-id') };
  const blocker = resolve(context, command.blocker);
  if ('result' in blocker) return blocker;
  const dependent = resolve(context, command.dependent);
  if ('result' in dependent) return dependent;
  const original = blocker.node;
  const next = dependent.node;
  const nodes = dependencyNodes(context, [original, next]);
  if (
    original.node.dependencyId !== command.dependencyId ||
    !next.node.dependsOn.includes(command.dependencyId)
  )
    return { result: invalid() };
  if (nodes.filter(({ node }) => node.dependencyId === command.dependencyId).length !== 1)
    return {
      result: {
        type: 'ambiguous',
        candidates: nodes
          .filter(({ node }) => node.dependencyId === command.dependencyId)
          .map(occurrence),
      },
    };
  const eligibility = buildTaskDependencyGraph(nodes, () => 'open', {
    blocker: original.target,
    dependent: next.target,
  }).eligibility(next.target, original.target);
  if (eligibility.type === 'rejected')
    return { result: eligibilityFailure(context, eligibility, next) };
  const id = next.node.dependencyId ?? allocateId(context, nodes);
  return id === undefined
    ? { result: invalid('dependency-id') }
    : { pair: { blocker: original, dependent: next, id } };
}

function reversedOutcome(
  roots: readonly TaskSnapshot[],
  original: TaskNodeSnapshot,
  next: TaskNodeSnapshot,
  id: string,
): DependencyCommandOutcome | undefined {
  const fresh = [original, next].map((before) => {
    const root = roots.find(
      (candidate) => rootAddress(candidate.ref) === rootAddress(before.root.ref),
    );
    return root === undefined || !sameTaskTreeExceptDependencies(before.root, root)
      ? undefined
      : atAddress(root, before.target);
  });
  const [dependent, blocker] = fresh;
  if (
    dependent === undefined ||
    blocker === undefined ||
    dependent.node.dependencyId !== original.node.dependencyId ||
    blocker.node.dependencyId !== id ||
    !sameIds(dependent.node.dependsOn, [...original.node.dependsOn, id]) ||
    !sameIds(
      blocker.node.dependsOn,
      next.node.dependsOn.filter((value) => value !== original.node.dependencyId),
    )
  )
    return undefined;
  return {
    type: 'dependency',
    change: 'reversed',
    dependencyId: id,
    dependent: occurrence(dependent),
    blocker: occurrence(blocker),
  };
}

function addWithinFile(
  context: DependencyContext,
  { blocker, dependent, id }: DependencyPair,
): Promise<TaskRepositoryResult> {
  // Confirm both endpoints in the atomic transition, even when the blocker already has its ID.
  const edits = [
    request(blocker, { type: 'set-dependency-id', target: blocker.target, id }),
    request(dependent, {
      type: 'set-depends-on',
      target: dependent.target,
      ids: [...dependent.node.dependsOn, id],
    }),
  ];
  return context.repository.editBatch({
    filePath: dependent.root.ref.filePath,
    edits,
    outcomeTarget: dependent.target,
  });
}

async function addAcrossFiles(
  context: DependencyContext,
  command: AddCommand,
  pair: DependencyPair,
  rebases: readonly Rebase[],
): Promise<TaskCommandResult> {
  const { diagnostics } = context;
  const { blocker, id } = pair;
  let currentBlocker = blocker;
  if (blocker.node.dependencyId === undefined) {
    const assigned = await edit(
      context,
      request(blocker, { type: 'set-dependency-id', target: blocker.target, id }),
    );
    if (assigned.type === 'rebased' && rebases.length === 0)
      return await add(context, command, [assigned]);
    if (assigned.type !== 'committed') return terminal(assigned);
    const fresh = committedNode(assigned, blocker.target);
    if (fresh?.node.dependencyId !== id) return ioError();
    currentBlocker = { ...fresh, basis: { observed: fresh.root }, predecessor: blocker.root.ref };
  }
  try {
    const result = await writeCrossFileEdge(context, { ...pair, blocker: currentBlocker });
    if (result.type !== 'ok')
      diagnostics({
        operation: command.type,
        phase: 'cross-file-edge-write',
        cause: result.type,
      });
    return result;
  } catch {
    diagnostics({
      operation: command.type,
      phase: 'cross-file-edge-write',
      cause: 'repository-error',
    });
    return ioError();
  }
}

async function writeCrossFileEdge(
  context: DependencyContext,
  pair: DependencyPair,
): Promise<TaskCommandResult> {
  const rebases: Rebase[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = currentPair(context, pair, rebases);
    if ('result' in current) return current.result;
    const { dependent, id } = current.pair;
    const result = await edit(
      context,
      request(dependent, {
        type: 'set-depends-on',
        target: dependent.target,
        ids: [...dependent.node.dependsOn, id],
      }),
    );
    if (result.type !== 'rebased' || attempt === 1)
      return addedResult(context, result, current.pair);
    rebases.push(result);
  }
  return ioError();
}

function currentPair(
  context: DependencyContext,
  pair: DependencyPair,
  rebases: readonly Rebase[],
): { readonly pair: DependencyPair } | { readonly result: TaskCommandResult } {
  const blocker = resolve(context, pair.blocker.target, rebases);
  if ('result' in blocker) return blocker;
  if (blocker.node.node.dependencyId !== pair.id)
    return { result: { type: 'conflict', current: blocker.node.root } };
  const dependent = resolve(context, pair.dependent.target, rebases);
  if ('result' in dependent) return dependent;
  const allowed = dependencyEligibility(context, blocker.node, dependent.node);
  return allowed.type === 'rejected'
    ? { result: eligibilityFailure(context, allowed, blocker.node) }
    : { pair: { blocker: blocker.node, dependent: dependent.node, id: pair.id } };
}

function committedNode(
  result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
  target: TaskNodeRef,
): TaskNodeSnapshot | undefined {
  return result.outcome.type === 'task' ? atAddress(result.outcome.task, target) : undefined;
}

function addedResult(
  context: DependencyContext,
  result: TaskRepositoryResult,
  { dependent, blocker, id }: DependencyPair,
): TaskCommandResult {
  if (result.type !== 'committed') return terminal(result);
  const freshDependent = committedNode(result, dependent.target);
  if (freshDependent?.node.dependsOn.includes(id) !== true) return ioError();
  const sameRoot = rootAddress(dependent.root.ref) === rootAddress(blocker.root.ref);
  const freshBlocker = projectedBlocker(
    context,
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

function projectedBlocker(
  context: DependencyContext,
  blocker: ResolvedNode,
  id: string,
  committedRoot?: TaskSnapshot,
): TaskNodeSnapshot | undefined {
  const { queries } = context;
  const matches = queries.listNodes().filter(({ node }) => node.dependencyId === id);
  if (matches.length !== 1) return undefined;
  const candidate = matches[0];
  const resolution =
    committedRoot === undefined
      ? queries.resolve(blocker.root.ref)
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

async function changeDeclaredIds(
  context: DependencyContext,
  command: ChangeCommand,
  rebases: readonly Rebase[] = [],
): Promise<TaskCommandResult> {
  const issue = declaredIdsInputIssue(command);
  if (issue !== undefined) return issue;
  const resolved = resolve(context, command.dependent, rebases);
  if ('result' in resolved) return resolved.result;
  const dependent = resolved.node;
  const prepared = prepareDeclaredIds(command, dependent);
  if ('result' in prepared) return prepared.result;
  const { change } = prepared;
  const beforeSource = taskLine(dependent.node);
  if (sameIds(dependent.node.dependsOn, change.ids))
    return changedIdsResult(context, dependent, change, { changed: false, beforeSource });
  const result = await edit(context, declaredIdsRequest(dependent, change, command));
  if (result.type === 'rebased' && rebases.length === 0)
    return await changeDeclaredIds(context, command, [result]);
  if (result.type !== 'committed') return terminal(result);
  const fresh = committedNode(result, dependent.target);
  return fresh === undefined
    ? ioError()
    : changedIdsResult(context, fresh, change, { changed: result.changed, beforeSource });
}

function changedIdsResult(
  context: DependencyContext,
  dependent: TaskNodeSnapshot,
  change: DeclaredIdsChange,
  { changed, beforeSource }: { changed: boolean; beforeSource: string },
): TaskCommandResult {
  const { dependencyId: id, removalRecovery: recovery } = change;
  const matches = context.queries.listNodes().filter(({ node }) => node.dependencyId === id);
  const blocker = matches.length === 1 ? matches[0] : undefined;
  const outcome: DependencyCommandOutcome = {
    type: 'dependency',
    change: change.change,
    dependencyId: id,
    dependent: occurrence(dependent),
    ...(blocker === undefined ? {} : { blocker: occurrence(blocker) }),
    ...(recovery === undefined
      ? {}
      : {
          removalRecovery: {
            ...recovery,
            source: { before: beforeSource, after: taskLine(dependent.node) },
          },
        }),
  };
  return { type: 'ok', changed, outcome };
}

export class TaskDependencyService {
  private readonly context: DependencyContext;

  constructor(
    queries: TaskQueryApi & TaskDependencyQueryApi,
    repository: TaskRepository,
    generateId: TaskDependencyIdGenerator,
    diagnostics: TaskDiagnosticSink,
  ) {
    this.context = { queries, repository, generateId, diagnostics, completionBases: [] };
  }

  async execute(command: DependencyCommand): Promise<TaskCommandResult> {
    return await this.serializeMutation(() => executeDependency(this.context, command));
  }

  createSubtask(
    command: CreateDependencySubtaskCommand,
    lifecycle: Pick<CreateDependencySubtaskRequest, 'today' | 'addCreatedDate'>,
  ): Promise<TaskCommandResult> {
    return this.serializeMutation(() => createSubtask(this.context, command, lifecycle));
  }

  serializeMutation<T>(operation: (queued: boolean) => Promise<T>): Promise<T> {
    return coordinateMutation(this.context.repository, operation);
  }

  withCompletionBasis(
    basis: { previous: TaskSnapshot; current: TaskSnapshot },
    readSync: () => readonly ActiveBlockingRelation[],
  ): readonly ActiveBlockingRelation[] {
    this.context.completionBases.push(basis);
    try {
      const result = readSync();
      requireSynchronousCompletionRead(result);
      return result;
    } finally {
      this.context.completionBases.pop();
    }
  }

  blockersForCompletion(
    currentRoot: TaskSnapshot,
    target: TaskNodeRef,
  ): readonly ActiveBlockingRelation[] {
    const indexed = this.context.queries.listNodes();
    const predecessor = completionPredecessor(this.context, currentRoot, target, indexed);
    const currentTarget = reconcileTaskNodeRef(predecessor, currentRoot, target);
    if (currentTarget === undefined) throw new DependencyCompletionConflict();
    const exact = indexed.some((node) => sameTaskNodeRef(node.target, currentTarget));
    const projection = exact
      ? this.context.queries.dependencies(currentTarget)
      : graph(this.context, [{ root: currentRoot, predecessor: predecessor.ref }]).dependencies(
          currentTarget,
        );
    return projection.blockedBy.filter(
      (relation): relation is ActiveBlockingRelation =>
        relation.type !== 'unavailable' && relation.state === 'active',
    );
  }
}
