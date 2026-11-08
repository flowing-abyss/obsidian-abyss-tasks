import type {
  ApiResultV1,
  ApplyTaskContentV1,
  ContentMergePreservationV1,
  ContentPlanV1,
  ContentSourceCopyV1,
  PrepareTaskContentV1,
  ReadTaskTreeV1,
  TaskContentMutationResultV1,
  TaskContentOperationV1,
  TaskCreateTreeV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import {
  sameTaskNodeRef,
  taskNodeSourceLine,
  taskTreeNodes,
  type CommentRef,
  type PreparedTaskEditCommand,
  type TaskCommandResult,
  type TaskCreatePreparation,
  type TaskCreatePreparationApi,
  type TaskCreatePreparationDestination,
  type TaskCreateTreeNode,
  type TaskEditPreparation,
  type TaskEditPreparationApi,
  type TaskHierarchyPreparation,
  type TaskHierarchyPreparationApi,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskSnapshot,
  type TaskSourceCopy,
  type TaskStatusRule,
} from '../tasks';
import type { ProjectReadRegistry } from './ProjectReadRegistry';
import type { TaskApiContext } from './TaskApiProvider';
import type { TaskRequestRegistry } from './TaskRequestRegistry';
import type { ProjectPorts } from './projectApiMutations';
import { currentNode } from './taskApiMutations';
import { readError, readFailure } from './taskApiReads';
import {
  acceptedSourceComment,
  copyOrigin,
  projectSourceCopy,
  type ContentCopyOrigin,
} from './taskContentCopies';
import {
  contentReceipt,
  redactContentMutationResult,
  unknownContentReceipt,
  type ContentReceiptBasis,
} from './taskContentReceipt';
import {
  nativePatch,
  validateContentApply,
  validateContentPrepare,
  validateTreeRead,
} from './taskContentValidation';
import {
  contentFailure,
  findTreeNode,
  projectTree,
  readNodeFor,
  TaskTreeReader,
  type TreeProjection,
} from './taskTreeApi';
import { validateReadOptions } from './validation';
import { freezeValue } from './values';

export interface TaskContentPorts {
  readonly edits: TaskEditPreparationApi;
  readonly hierarchies?: TaskHierarchyPreparationApi;
  readonly creates: TaskCreatePreparationApi;
  readonly statuses: () => readonly TaskStatusRule[];
}
export interface ContentContext {
  readonly api: TaskApiContext;
  readonly ports: TaskContentPorts;
  readonly requests: TaskRequestRegistry;
  readonly consumerId: string;
  readonly epoch: string;
  readonly now: () => number;
  readonly isDisposed: () => boolean;
  readonly projects?: { ports: ProjectPorts; registry: ProjectReadRegistry };
}
type Native = Extract<
  TaskEditPreparation | TaskCreatePreparation | TaskHierarchyPreparation,
  { type: 'ready' }
>;
interface Family {
  consumed: boolean;
  release: () => void;
}
interface Version {
  readonly assessment?: Omit<ContentMergePreservationV1, 'planRevision'>;
  readonly copyOrigins: readonly ContentCopyOrigin[];
  readonly target: string;
  readonly revision: string;
  readonly expiresAt: number;
  readonly kind: 'edit' | 'create' | 'hierarchy';
  readonly native: Native;
  readonly origins: Native['continuations'];
  readonly family: Family;
  readonly originalTarget?: string | undefined;
  readonly destination?: ContentPlanV1['destination'] | undefined;
  readonly tasks: Map<string, TaskNodeRef>;
  readonly beforeTasks: Map<string, TaskNodeRef>;
  readonly beforeRevisions: Map<string, string>;
  readonly observedAtMs: number;
  readonly comments: Map<string, CommentRef>;
  readonly before: TaskSnapshot | null;
  readonly observation: ReturnType<TaskApiContext['reads']['capture']>;
  readonly bytes: number;
  superseded: boolean;
  published: boolean;
}
function commandResultError(result: TaskCommandResult): ApiResultV1<never> {
  if (result.type === 'conflict') return contentFailure('REVISION_CONFLICT');
  if (result.type === 'not-found') return readFailure('missing');
  if (result.type === 'ambiguous') return readFailure('ambiguous');
  if (result.type === 'invalid')
    return readError('validation', 'INVALID_ARGUMENT', 'The task content change is invalid.');
  return readError('io', 'IO_ERROR', 'The task content write could not be confirmed.');
}
function supportedTreeStatuses(tree: TaskCreateTreeV1, ports: TaskContentPorts): boolean {
  const symbol = tree.initial?.statusSymbol;
  if (symbol !== undefined && !ports.statuses().some((r) => r.symbol === symbol)) return false;
  return tree.children === undefined || tree.children.every((c) => supportedTreeStatuses(c, ports));
}
function nativeTree(tree: TaskCreateTreeV1, ports: TaskContentPorts): TaskCreateTreeNode {
  const { initial, children, ...rest } = tree;
  const symbol = initial?.statusSymbol;
  const status =
    symbol === undefined ? undefined : ports.statuses().find((r) => r.symbol === symbol);

  const patch = { ...initial };
  delete patch.statusSymbol;
  return {
    ...rest,
    ...(initial === undefined
      ? {}
      : { initial: { ...nativePatch(patch), ...(status === undefined ? {} : { status }) } }),
    ...(children === undefined ? {} : { children: children.map((c) => nativeTree(c, ports)) }),
  };
}
type NativePreparationOperation = Extract<
  TaskContentOperationV1,
  { type: 'set-initial-status' | 'copy-comment' | 'copy-subtree' | 'assess-merge' }
>;
function nativePreparationOperation(
  operation: TaskContentOperationV1,
): operation is NativePreparationOperation {
  return (
    operation.type === 'set-initial-status' ||
    operation.type === 'copy-comment' ||
    operation.type === 'copy-subtree' ||
    operation.type === 'assess-merge'
  );
}
function reorderCommand(
  operation: Extract<TaskContentOperationV1, { type: 'reorder' }>,
  tasks: ReadonlyMap<string, TaskNodeRef>,
  target: TaskNodeRef,
): PreparedTaskEditCommand | undefined {
  const relative = tasks.get(operation.relativeTo);
  if (
    target.type !== 'subtask' ||
    relative?.type !== 'subtask' ||
    !sameTaskNodeRef(target.ref.parent, relative.ref.parent)
  )
    return undefined;
  return {
    type: 'reorder-subtask',
    subtask: target.ref,
    target: relative.ref,
    placement: operation.placement,
  };
}
type HierarchyOperation = Extract<PrepareTaskContentV1, { kind: 'hierarchy' }>['operation'];
function hierarchyCommand(
  ctx: TaskApiContext,
  op: HierarchyOperation,
): ApiResultV1<Parameters<TaskHierarchyPreparationApi['prepareHierarchy']>[0]> {
  const source = currentNode(ctx, {
    target: op.source,
    expectedRevision: op.expectedSourceRevision,
  });
  if (!source.ok) return source;
  const target = source.value.node.value.target;
  if (op.type === 'promote')
    return target.type === 'subtask'
      ? { ok: true, value: { type: 'promote-subtask', subtask: target.ref } }
      : contentFailure('INVALID_ARGUMENT');
  const parent = currentNode(ctx, {
    target: op.parent,
    expectedRevision: op.expectedParentRevision,
  });
  return parent.ok
    ? {
        ok: true,
        value: { type: 'reparent-task', source: target, parent: parent.value.node.value.target },
      }
    : parent;
}
function translate(
  operation: TaskContentOperationV1,
  version: Pick<Version, 'tasks' | 'comments'>,
): PreparedTaskEditCommand | undefined {
  if (nativePreparationOperation(operation)) return undefined;
  if (operation.type === 'update-comment' || operation.type === 'remove-comment')
    return commentCommand(operation, version.comments);
  return translateNode(operation, version.tasks);
}
function translateNode(
  operation: Exclude<
    TaskContentOperationV1,
    NativePreparationOperation | { type: 'update-comment' | 'remove-comment' }
  >,
  tasks: Map<string, TaskNodeRef>,
): PreparedTaskEditCommand | undefined {
  const target = tasks.get(operation.target);
  if (target === undefined) return undefined;
  switch (operation.type) {
    case 'reorder':
      return reorderCommand(operation, tasks, target);
    case 'patch':
      return {
        type: 'patch',
        target,
        patch: nativePatch(operation.patch),
      } as PreparedTaskEditCommand;
    case 'description':
      return { type: 'set-description', target, text: operation.text };
    case 'add-child':
      return { type: 'add-subtask', parent: target, text: operation.markdownTitle };
    case 'add-comment':
      return { type: 'add-comment', parent: target, text: operation.text };
    case 'remove':
      return removeCommand(target);
  }
}
function removeCommand(target: TaskNodeRef): PreparedTaskEditCommand {
  return target.type === 'task'
    ? { type: 'delete', ref: target.ref }
    : { type: 'delete-subtask', subtask: target.ref };
}
function commentCommand(
  operation: Extract<TaskContentOperationV1, { type: 'update-comment' | 'remove-comment' }>,
  comments: Map<string, CommentRef>,
): PreparedTaskEditCommand | undefined {
  const comment = comments.get(operation.target);
  if (comment === undefined) return undefined;
  return operation.type === 'update-comment'
    ? { type: 'update-comment', comment, text: operation.text }
    : { type: 'delete-comment', comment };
}
interface PlanInput {
  readonly kind: 'edit' | 'create' | 'hierarchy';
  readonly originalTarget?: string;
  readonly release?: () => void;
  readonly destination?: ContentPlanV1['destination'];
}
/** One client owns transient plans. Native preparations alone retain source/candidate authority. */
export class TaskContentApi {
  private readonly versions_abyssPrivate = new Map<string, Version>();
  private readonly reader_abyssPrivate: TaskTreeReader;
  private count_abyssPrivate = 0;
  private disposed_abyssPrivate = false;
  constructor(private readonly ctx_abyssPrivate: ContentContext) {
    this.reader_abyssPrivate = new TaskTreeReader(
      ctx_abyssPrivate.api,
      ctx_abyssPrivate.now,
      `${ctx_abyssPrivate.epoch}:${ctx_abyssPrivate.consumerId}:${crypto.randomUUID()}`,
    );
  }
  private token_abyssPrivate(kind: string): string {
    return `${this.ctx_abyssPrivate.epoch}:content:${this.ctx_abyssPrivate.consumerId}:${kind}:${++this.count_abyssPrivate}:${crypto.randomUUID()}`;
  }
  dispose(): void {
    this.disposed_abyssPrivate = true;
    for (const v of this.versions_abyssPrivate.values()) v.family.release();
    this.versions_abyssPrivate.clear();
    this.reader_abyssPrivate.dispose();
  }
  private clean_abyssPrivate(): void {
    const now = this.ctx_abyssPrivate.now();
    for (const [key, v] of this.versions_abyssPrivate)
      if (v.expiresAt <= now) {
        this.versions_abyssPrivate.delete(key);
        if (![...this.versions_abyssPrivate.values()].some((x) => x.family === v.family))
          v.family.release();
      }
  }
  private lookup_abyssPrivate(
    target: string,
    revision: string,
    includeUnpublished = false,
  ): ApiResultV1<Version> {
    this.clean_abyssPrivate();
    const v = this.versions_abyssPrivate.get(revision);
    if (v?.target !== target || (!v.published && !includeUnpublished)) return contentFailure();
    if ('sourceCopiesAvailable' in v.native && !v.native.sourceCopiesAvailable())
      return readFailure('unavailable');
    const disclosure = this.originalDisclosure_abyssPrivate(v);
    if (disclosure !== undefined) return disclosure;
    return { ok: true, value: v };
  }
  private originalDisclosure_abyssPrivate(v: Version): ApiResultV1<never> | undefined {
    if (v.originalTarget !== undefined) {
      const identity = this.ctx_abyssPrivate.api.identities.lookup(v.originalTarget);
      if (!identity.ok) return identity;
      const health = this.ctx_abyssPrivate.api.reads.coverage({
        path: identity.value.address.filePath,
      });
      if (health.type === 'error') return readFailure(health.reason);
      if (!this.ctx_abyssPrivate.api.reads.canDisclose(identity.value.address))
        return readFailure('unavailable');
    }
    return this.hierarchyDisclosure_abyssPrivate(v);
  }
  private hierarchyDisclosure_abyssPrivate(v: Version): ApiResultV1<never> | undefined {
    if ('subjectBefore' in v.native)
      for (const root of v.native.affected.before) {
        const address = readNodeFor(this.ctx_abyssPrivate.api, {
          root,
          node: root,
          target: { type: 'task', ref: root.ref },
          path: [],
        }).address;
        const health = this.ctx_abyssPrivate.api.reads.coverage({ path: address.filePath });
        if (health.type === 'error') return readFailure(health.reason);
        if (!this.ctx_abyssPrivate.api.reads.canDisclose(address))
          return readFailure('unavailable');
      }
    return undefined;
  }
  private projection_abyssPrivate(v: Version, before = false): TreeProjection {
    const tasks = before ? v.beforeTasks : v.tasks,
      root = before ? v.before : v.native.after;
    return {
      draft: !before,
      task: (value) => this.taskIdentity_abyssPrivate(v, tasks, value, before),
      entry: (kind, parent, ref) => {
        const target = this.reader_abyssPrivate.entry(
          kind,
          `${v.revision}:${before ? 'before' : 'after'}:${parent}`,
          ref,
          true,
        );
        if (kind === 'comment' && !before && root !== null)
          v.comments.set(target, ref as CommentRef);
        return target;
      },
    };
  }
  private taskIdentity_abyssPrivate(
    v: Version,
    tasks: Map<string, TaskNodeRef>,
    value: TaskNodeSnapshot,
    before: boolean,
  ): ReturnType<TreeProjection['task']> {
    let target = [...tasks].find(([, ref]) => sameTaskNodeRef(ref, value.target))?.[0];
    if (target !== undefined)
      return {
        ok: true,
        value: {
          target,
          revision: before ? this.beforeTaskRevision_abyssPrivate(v, target) : v.revision,
          ...this.parent_abyssPrivate(tasks, value),
        },
      };
    if (tasks.size >= 50000)
      return readError('resource', 'RESOURCE_LIMIT', 'Plan target capacity exhausted.');
    const projected = this.issueTaskIdentity_abyssPrivate(v, value, before);
    if (!projected.ok) return projected;
    target = projected.value.target;
    if (before) v.beforeRevisions.set(target, projected.value.revision);
    tasks.set(target, value.target);
    return {
      ok: true,
      value: {
        target,
        revision: before ? this.beforeTaskRevision_abyssPrivate(v, target) : v.revision,
        ...this.parent_abyssPrivate(tasks, value),
      },
    };
  }
  private issueTaskIdentity_abyssPrivate(
    v: Version,
    value: TaskNodeSnapshot,
    before: boolean,
  ): ReturnType<TreeProjection['task']> {
    if (before) return this.beforeIdentity_abyssPrivate(v, value);
    const origin = v.origins.find(
      (pair) => pair.after !== undefined && sameTaskNodeRef(pair.after, value.target),
    );
    if (origin === undefined)
      return { ok: true, value: { target: this.token_abyssPrivate('task'), revision: v.revision } };
    const node = this.roots_abyssPrivate(v, true)
      .map((root) => findTreeNode(root, origin.before))
      .find((node) => node !== undefined);
    if (node === undefined) return contentFailure('STALE_TARGET');
    const identity = this.beforeIdentity_abyssPrivate(v, node);
    if (!identity.ok) return identity;
    v.beforeTasks.set(identity.value.target, origin.before);
    v.beforeRevisions.set(identity.value.target, identity.value.revision);
    return identity;
  }
  private beforeTaskRevision_abyssPrivate(v: Version, target: string): string {
    return v.beforeRevisions.get(target) ?? v.revision;
  }
  private hierarchyIdentity_abyssPrivate(
    value: TaskNodeSnapshot,
    semanticsRevision: number,
  ): ReturnType<TreeProjection['task']> {
    const ctx = this.ctx_abyssPrivate;
    const projected = readNodeFor(ctx.api, value);
    const current = ctx.api.reads.node(projected.address);
    if (
      current.type !== 'ok' ||
      current.value.value.root.source.originalBlock !== value.root.source.originalBlock ||
      !ctx.api.reads.canDisclose(projected.address)
    )
      return contentFailure('REVISION_CONFLICT');
    return ctx.api.identities.project(current.value, semanticsRevision);
  }
  private beforeIdentity_abyssPrivate(
    v: Version,
    value: TaskNodeSnapshot,
  ): ReturnType<TreeProjection['task']> {
    const ctx = this.ctx_abyssPrivate,
      state = ctx.api.reads.capture();
    if (
      state.scopeRevision !== v.observation.scopeRevision ||
      state.semanticsRevision !== v.observation.semanticsRevision
    )
      return contentFailure();
    if ('subjectBefore' in v.native)
      return this.hierarchyIdentity_abyssPrivate(value, state.semanticsRevision);
    const current = this.current_abyssPrivate(v.originalTarget ?? '');
    if (!current.ok) return current;
    const root = current.value.node.value.root;
    if (root.source.originalBlock !== value.root.source.originalBlock)
      return contentFailure('REVISION_CONFLICT');
    const offset = taskNodeSourceLine(value.target) - value.root.ref.line;
    const node = [...taskTreeNodes(root)].find(
      (n) => taskNodeSourceLine(n.target) - root.ref.line === offset,
    );
    if (node === undefined) return contentFailure('STALE_TARGET');
    return ctx.api.identities.project(readNodeFor(ctx.api, node), state.semanticsRevision);
  }
  private parent_abyssPrivate(
    tasks: Map<string, TaskNodeRef>,
    value: TaskNodeSnapshot,
  ): { parentTarget?: string } {
    if (value.target.type === 'subtask') {
      const parent = value.target.ref.parent;
      for (const [target, ref] of tasks)
        if (sameTaskNodeRef(ref, parent)) return { parentTarget: target };
    }
    return {};
  }
  private copies_abyssPrivate(v: Version): readonly ContentSourceCopyV1[] {
    const root = v.native.after;
    if (root === null) return [];
    const projection = this.projection_abyssPrivate(v);
    const task = (ref: TaskNodeRef): string | undefined => {
      const node = findTreeNode(root, ref);
      if (node === undefined) return undefined;
      const identity = projection.task(node);
      return identity.ok ? identity.value.target : undefined;
    };
    if (!('copies' in v.native)) return [];
    return v.native.copies.flatMap((evidence, i) => {
      const origin = v.copyOrigins[i];
      return origin === undefined
        ? []
        : [
            projectSourceCopy(evidence, origin, task, (ref) => {
              const parent = task(ref.parent);
              return parent === undefined ? undefined : projection.entry('comment', parent, ref);
            }),
          ];
    });
  }
  private render_abyssPrivate(v: Version): ApiResultV1<ContentPlanV1> {
    const tree = (root: TaskSnapshot | null, before: boolean): ApiResultV1<TaskTreeV1 | null> =>
      root === null
        ? { ok: true, value: null }
        : projectTree(
            this.ctx_abyssPrivate.api,
            { root, node: root, target: { type: 'task', ref: root.ref }, path: [] },
            this.projection_abyssPrivate(v, before),
            { now: v.observedAtMs },
          );
    if ('subjectBefore' in v.native) return this.renderHierarchy_abyssPrivate(v, v.native);
    const before = tree(v.before, true);
    if (!before.ok) return before;
    if (v.tasks.size === 0) this.continueTasks_abyssPrivate(v, v.beforeTasks);
    const after = tree(v.native.after, false);
    if (!after.ok) return after;
    return freezeValue({
      ok: true,
      value: {
        ...this.ctx_abyssPrivate.api.observation(v.observation),
        target: v.target,
        revision: v.revision,
        kind: v.kind,
        expiresAt: v.expiresAt,
        before: before.value,
        after: after.value,
        copies: this.copies_abyssPrivate(v),
        ...(v.assessment === undefined
          ? {}
          : { mergePreservation: { ...v.assessment, planRevision: v.revision } }),
        ...(v.destination === undefined ? {} : { destination: v.destination }),
      },
    });
  }
  private roots_abyssPrivate(v: Version, before: boolean): readonly TaskSnapshot[] {
    if ('affected' in v.native) return before ? v.native.affected.before : v.native.affected.after;
    const root = before ? v.before : v.native.after;
    return root === null ? [] : [root];
  }
  private renderHierarchy_abyssPrivate(
    v: Version,
    native: Extract<TaskHierarchyPreparation, { type: 'ready' }>,
  ): ApiResultV1<ContentPlanV1> {
    const roots = (before: boolean): TaskTreeV1[] | undefined => {
      const result: TaskTreeV1[] = [];
      for (const root of this.roots_abyssPrivate(v, before)) {
        const projected = projectTree(
          this.ctx_abyssPrivate.api,
          { root, node: root, target: { type: 'task', ref: root.ref }, path: [] },
          this.projection_abyssPrivate(v, before),
          { now: v.observedAtMs },
        );
        if (!projected.ok) return undefined;
        result.push(projected.value);
      }
      return result;
    };
    const beforeRoots = roots(true);
    if (beforeRoots === undefined) return contentFailure();
    this.continueTasks_abyssPrivate(v, v.beforeTasks);
    const afterRoots = roots(false);
    if (afterRoots === undefined) return contentFailure();
    const subject = (
      root: TaskSnapshot,
      target: TaskNodeRef,
      before: boolean,
    ): ApiResultV1<TaskTreeV1> => {
      const node = findTreeNode(root, target);
      return node === undefined
        ? contentFailure()
        : projectTree(this.ctx_abyssPrivate.api, node, this.projection_abyssPrivate(v, before), {
            now: v.observedAtMs,
          });
    };
    const before = subject(native.before, native.subjectBefore, true),
      after = subject(native.after, native.subjectAfter, false);
    if (!before.ok) return before;
    if (!after.ok) return after;
    return freezeValue({
      ok: true,
      value: {
        ...this.ctx_abyssPrivate.api.observation(v.observation),
        target: v.target,
        revision: v.revision,
        kind: 'hierarchy' as const,
        expiresAt: v.expiresAt,
        before: before.value,
        after: after.value,
        affected: { before: beforeRoots, after: afterRoots },
      },
    });
  }
  private metadata_abyssPrivate(
    native: Native,
    previous?: Version,
    input?: PlanInput,
  ): Pick<
    Version,
    | 'target'
    | 'expiresAt'
    | 'kind'
    | 'family'
    | 'before'
    | 'beforeTasks'
    | 'beforeRevisions'
    | 'observedAtMs'
    | 'observation'
    | 'originalTarget'
    | 'destination'
  > {
    if (previous !== undefined)
      return {
        target: previous.target,
        expiresAt: previous.expiresAt,
        kind: previous.kind,
        family: previous.family,
        before: previous.before,
        beforeTasks: new Map(previous.beforeTasks),
        beforeRevisions: new Map(previous.beforeRevisions),
        observedAtMs: previous.observedAtMs,
        observation: previous.observation,
        originalTarget: previous.originalTarget,
        destination: previous.destination,
      };
    if (input === undefined) throw new Error('Missing plan input');
    return {
      target: this.token_abyssPrivate('plan'),
      expiresAt: this.ctx_abyssPrivate.now() + 300000,
      kind: input.kind,
      family: { consumed: false, release: input.release ?? (() => {}) },
      before: native.before,
      beforeTasks: new Map<string, TaskNodeRef>(),
      beforeRevisions: new Map<string, string>(),
      observedAtMs: this.ctx_abyssPrivate.now(),
      observation: this.ctx_abyssPrivate.api.reads.capture(),
      originalTarget: input.originalTarget,
      destination: input.destination,
    };
  }
  private continueTasks_abyssPrivate(v: Version, tasks: ReadonlyMap<string, TaskNodeRef>): void {
    for (const [target, ref] of tasks) {
      const next = v.native.continuations.find((c) => sameTaskNodeRef(c.before, ref));
      if (next?.after !== undefined) v.tasks.set(target, next.after);
      else if (v.native.after !== null && findTreeNode(v.native.after, ref) !== undefined)
        v.tasks.set(target, ref);
    }
  }
  private originalContinuations_abyssPrivate(
    native: Native,
    previous?: Version,
  ): Native['continuations'] {
    if (previous === undefined) return native.before === null ? [] : native.continuations;
    return previous.origins.map((origin) => {
      const preceding = origin.after;
      if (preceding === undefined) return { before: origin.before };
      const next = native.continuations.find((pair) => sameTaskNodeRef(pair.before, preceding));
      return { before: origin.before, ...(next?.after === undefined ? {} : { after: next.after }) };
    });
  }
  private copyMetadata_abyssPrivate(
    previous: Version | undefined,
    evidence?: {
      copy?: ContentCopyOrigin;
      assessment?: Omit<ContentMergePreservationV1, 'planRevision'>;
    },
  ): Pick<Version, 'copyOrigins' | 'assessment'> {
    const copyOrigins = [...(previous?.copyOrigins ?? [])];
    if (evidence?.copy !== undefined) copyOrigins.push(evidence.copy);
    return {
      copyOrigins,
      ...(evidence?.assessment === undefined ? {} : { assessment: evidence.assessment }),
    };
  }
  private retain_abyssPrivate(
    native: Native,
    previous?: Version,
    input?: PlanInput,
    evidence?: {
      copy?: ContentCopyOrigin;
      assessment?: Omit<ContentMergePreservationV1, 'planRevision'>;
    },
  ): ApiResultV1<ContentPlanV1> {
    if (this.disposed_abyssPrivate || this.ctx_abyssPrivate.isDisposed())
      return readFailure('disposed');
    this.clean_abyssPrivate();
    const bytes = new TextEncoder().encode(
      JSON.stringify('affected' in native ? native.affected : [native.before, native.after]),
    ).length;
    if (
      this.versions_abyssPrivate.size >= 128 ||
      [...this.versions_abyssPrivate.values()].reduce((n, v) => n + v.bytes, bytes) >
        8 * 1024 * 1024
    )
      return readError('resource', 'RESOURCE_LIMIT', 'Content plan capacity exhausted.');
    const v: Version = {
      ...this.metadata_abyssPrivate(native, previous, input),
      revision: this.token_abyssPrivate('revision'),
      native,
      ...this.copyMetadata_abyssPrivate(previous, evidence),
      origins: this.originalContinuations_abyssPrivate(native, previous),
      tasks: new Map<string, TaskNodeRef>(),
      comments: new Map<string, CommentRef>(),
      bytes,
      superseded: false,
      published: false,
    };
    if (previous !== undefined) this.continueTasks_abyssPrivate(v, previous.tasks);
    const result = this.render_abyssPrivate(v);
    if (!result.ok) return result;
    this.versions_abyssPrivate.set(v.revision, v);
    return result;
  }
  async prepare(
    input: PrepareTaskContentV1,
    options?: unknown,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    const ctx = this.ctx_abyssPrivate,
      parsed = validateContentPrepare(input),
      read = validateReadOptions(options);
    if (!parsed.ok) return parsed;
    if (!read.ok) return read;
    let result: ApiResultV1<ContentPlanV1> | undefined;
    try {
      const failed = ctx.api.check(read.value.signal);
      if (failed !== undefined) return failed;
      result = await this.prepareValue_abyssPrivate(parsed.value);
      const late = ctx.api.check(read.value.signal);
      if (late !== undefined) return late;
      if (!result.ok) return result;
      const publication = this.publish_abyssPrivate(result.value, parsed.value);
      return publication ?? result;
    } catch {
      return ctx.api.internal('tasks.prepare');
    } finally {
      if (result?.ok === true) this.discardUnpublished_abyssPrivate(result.value.revision);
    }
  }
  private publish_abyssPrivate(
    plan: ContentPlanV1,
    input: PrepareTaskContentV1,
  ): ApiResultV1<never> | undefined {
    const owned = this.lookup_abyssPrivate(plan.target, plan.revision, true);
    if (!owned.ok) return owned;
    const version = owned.value;
    if (version.family.consumed) return contentFailure('PLAN_CONSUMED');
    if (input.kind === 'refresh') {
      const predecessor = this.versions_abyssPrivate.get(input.expectedPlanRevision);
      if (predecessor === undefined) return contentFailure();
      predecessor.superseded = true;
    }
    version.published = true;
    return undefined;
  }
  private discardUnpublished_abyssPrivate(revision: string): void {
    const version = this.versions_abyssPrivate.get(revision);
    if (version === undefined || version.published) return;
    this.versions_abyssPrivate.delete(revision);
    if (![...this.versions_abyssPrivate.values()].some((value) => value.family === version.family))
      version.family.release();
  }
  private async prepareValue_abyssPrivate(
    value: PrepareTaskContentV1,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    if (value.kind === 'hierarchy') return this.hierarchy_abyssPrivate(value);
    if (value.kind === 'edit') return this.edit_abyssPrivate(value);
    if (value.kind === 'create') return await this.create_abyssPrivate(value);
    const found = this.lookup_abyssPrivate(value.plan, value.expectedPlanRevision);
    if (!found.ok) return found;
    const v = found.value;
    if (v.family.consumed || v.superseded) return contentFailure('PLAN_CONSUMED');
    if (value.kind === 'refresh') return await this.refresh_abyssPrivate(v, value.afterRequestId);
    return this.append_abyssPrivate(v, value.operation);
  }
  private pinHierarchy_abyssPrivate(op: HierarchyOperation): ApiResultV1<() => void> {
    const pinned: Array<() => void> = [];
    const release = (): void => {
      for (const dispose of pinned) dispose();
    };
    for (const handle of [op.source, ...(op.type === 'reparent' ? [op.parent] : [])]) {
      const pin = this.ctx_abyssPrivate.api.identities.pin(handle);
      if (!pin.ok) {
        release();
        return pin;
      }
      pinned.push(pin.value);
    }
    return { ok: true, value: release };
  }
  private async hierarchy_abyssPrivate(
    input: Extract<PrepareTaskContentV1, { kind: 'hierarchy' }>,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    const ctx = this.ctx_abyssPrivate,
      op = input.operation;
    if (ctx.ports.hierarchies === undefined)
      return readError(
        'unsupported',
        'UNSUPPORTED_OPERATION',
        'Hierarchy preparation is unavailable.',
      );
    const command = hierarchyCommand(ctx.api, op);
    if (!command.ok) return command;
    const pinned = this.pinHierarchy_abyssPrivate(op);
    if (!pinned.ok) return pinned;
    let retained = false;
    try {
      const native = await ctx.ports.hierarchies.prepareHierarchy(command.value);
      if (native.type !== 'ready') return commandResultError(native.result);
      const current = hierarchyCommand(ctx.api, op);
      if (!current.ok) return current;
      const result = this.retain_abyssPrivate(native, undefined, {
        kind: 'hierarchy',
        originalTarget: op.source,
        release: pinned.value,
      });
      retained = result.ok;
      return result;
    } finally {
      if (!retained) pinned.value();
    }
  }
  private async edit_abyssPrivate(
    input: Extract<PrepareTaskContentV1, { kind: 'edit' }>,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    const ctx = this.ctx_abyssPrivate,
      node = currentNode(ctx.api, input);
    if (!node.ok) return node;
    const root = node.value.node.value.root;
    const rootNode = readNodeFor(ctx.api, {
      root,
      node: root,
      target: { type: 'task', ref: root.ref },
      path: [],
    });
    const identity = ctx.api.identities.project(
      rootNode,
      ctx.api.reads.capture().semanticsRevision,
    );
    if (!identity.ok) return identity;
    const pinned = ctx.api.identities.pin(identity.value.target);
    if (!pinned.ok) return pinned;
    let retained = false;
    try {
      const native = await ctx.ports.edits.prepare(root, []);
      if (native.type !== 'ready') return commandResultError(native.result);
      const check = ctx.api.check();
      if (check !== undefined) return check;
      const current = currentNode(ctx.api, input);
      if (!current.ok) return current;
      const initial = this.retain_abyssPrivate(native, undefined, {
        kind: 'edit',
        originalTarget: identity.value.target,
        release: pinned.value,
      });
      retained = initial.ok;
      return await this.finishInitialEdit_abyssPrivate(
        initial,
        input,
        root,
        current.value.node.value.target,
      );
    } finally {
      if (!retained) pinned.value();
    }
  }
  private async finishInitialEdit_abyssPrivate(
    initial: ApiResultV1<ContentPlanV1>,
    input: Extract<PrepareTaskContentV1, { kind: 'edit' }>,
    root: TaskSnapshot,
    selected: TaskNodeRef,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    if (!initial.ok) return initial;
    const found = this.versions_abyssPrivate.get(initial.value.revision);
    if (found === undefined) throw new Error('Missing retained plan');
    found.beforeTasks.set(input.target, selected);
    found.beforeRevisions.set(input.target, input.expectedRevision);
    this.continueTasks_abyssPrivate(found, new Map([[input.target, selected]]));
    if (input.operation === undefined) return initial;
    return this.firstAppend_abyssPrivate(found, root, input.operation);
  }

  private async firstAppend_abyssPrivate(
    found: Version,
    root: TaskSnapshot,
    operation: TaskContentOperationV1,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    let retained = false;
    try {
      for (const [target, ref] of found.beforeTasks) found.tasks.set(target, ref);
      this.initialOperationTargets_abyssPrivate(found, root, operation);
      const result = await this.append_abyssPrivate(found, operation);
      retained = result.ok;
      return result;
    } finally {
      this.versions_abyssPrivate.delete(found.revision);
      if (!retained) found.family.release();
    }
  }
  private initialOperationTargets_abyssPrivate(
    found: Version,
    root: TaskSnapshot,
    operation: TaskContentOperationV1,
  ): void {
    const selected = this.current_abyssPrivate(operation.target);
    if (
      selected.ok &&
      sameTaskNodeRef(
        { type: 'task', ref: selected.value.node.value.root.ref },
        { type: 'task', ref: root.ref },
      )
    )
      found.tasks.set(operation.target, selected.value.node.value.target);
    if (operation.type === 'reorder') {
      const relative = this.current_abyssPrivate(operation.relativeTo);
      if (
        relative.ok &&
        sameTaskNodeRef(
          { type: 'task', ref: relative.value.node.value.root.ref },
          { type: 'task', ref: root.ref },
        )
      )
        found.tasks.set(operation.relativeTo, relative.value.node.value.target);
    }
    this.initialComment_abyssPrivate(found, root, operation.target);
  }
  private initialComment_abyssPrivate(found: Version, root: TaskSnapshot, target: string): void {
    const comment = this.reader_abyssPrivate.comment(target);
    if (comment !== undefined) {
      for (const value of taskTreeNodes(root))
        for (const c of value.node.comments)
          if (JSON.stringify(c.ref) === JSON.stringify(comment)) found.comments.set(target, c.ref);
    }
  }
  private async append_abyssPrivate(
    v: Version,
    operation: TaskContentOperationV1,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    if (!('append' in v.native))
      return readError(
        'conflict',
        'HIERARCHY_REVIEW',
        'Confirm or discard this hierarchy preview before further content edits.',
      );
    if (operation.type === 'assess-merge') return this.assessMerge_abyssPrivate(v, operation);
    if (operation.type === 'copy-comment' || operation.type === 'copy-subtree')
      return this.copy_abyssPrivate(v, operation);
    if (operation.type === 'set-initial-status') {
      const target = v.tasks.get(operation.target);
      if (target === undefined) return contentFailure('STALE_TARGET');
      const native = v.native.refineInitialStatus({ target, symbol: operation.symbol });
      return native.type === 'ready'
        ? this.retain_abyssPrivate(native, v)
        : commandResultError(native.result);
    }
    const command = this.translate_abyssPrivate(v, operation);
    if (command === undefined) return contentFailure('STALE_TARGET');
    const native = v.native.append(command);
    if (native.type !== 'ready') return commandResultError(native.result);
    return this.retain_abyssPrivate(native, v);
  }
  private translate_abyssPrivate(
    v: Version,
    operation: TaskContentOperationV1,
  ): PreparedTaskEditCommand | undefined {
    const command = translate(operation, v);
    if (command !== undefined || operation.type !== 'remove-comment') return command;
    const source = acceptedSourceComment(
      this.ctx_abyssPrivate.api,
      this.reader_abyssPrivate.comment(operation.target, true),
    );
    const comment =
      source === undefined || !('continueSourceComment' in v.native)
        ? undefined
        : v.native.continueSourceComment(source);
    return comment === undefined ? undefined : { type: 'delete-comment', comment };
  }
  private async assessMerge_abyssPrivate(
    v: Version,
    operation: Extract<TaskContentOperationV1, { expectedSourceRevision: string }>,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    const parent = v.tasks.get(operation.target);
    if (parent?.type !== 'task' || v.originalTarget === operation.source)
      return contentFailure('STALE_TARGET');
    const source = currentNode(this.ctx_abyssPrivate.api, {
      target: operation.source,
      expectedRevision: operation.expectedSourceRevision,
    });
    if (!source.ok) return source;
    if (!('append' in v.native)) return contentFailure();
    const native = v.native.append({ type: 'patch', target: parent, patch: {} });
    if (native.type !== 'ready') return commandResultError(native.result);
    const report = await native.assessMerge(source.value.node.value.target);
    if (report === undefined) return contentFailure('STALE_TARGET');
    return this.retain_abyssPrivate(native, v, undefined, {
      assessment: {
        sourceRoot: { target: operation.source, revision: operation.expectedSourceRevision },
        state: report.state,
        entries: report.entries,
      },
    });
  }
  private copyInput_abyssPrivate(
    v: Version,
    operation: Extract<TaskContentOperationV1, { type: 'copy-comment' | 'copy-subtree' }>,
  ): ApiResultV1<TaskSourceCopy> {
    const parent = v.tasks.get(operation.target);
    if (parent === undefined) return contentFailure('STALE_TARGET');
    if (operation.type === 'copy-comment') {
      const source = acceptedSourceComment(
        this.ctx_abyssPrivate.api,
        this.reader_abyssPrivate.comment(operation.source, true),
      );
      if (source === undefined) return contentFailure('STALE_TARGET');
      return { ok: true, value: { type: 'comment', source, parent } };
    }
    const source = currentNode(this.ctx_abyssPrivate.api, {
      target: operation.source,
      expectedRevision: operation.expectedSourceRevision,
    });
    if (!source.ok) return source;
    return {
      ok: true,
      value: { type: 'subtree', source: source.value.node.value.target, parent },
    };
  }
  private async copy_abyssPrivate(
    v: Version,
    operation: Extract<TaskContentOperationV1, { type: 'copy-comment' | 'copy-subtree' }>,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    if (!('copySource' in v.native)) return contentFailure();
    const input = this.copyInput_abyssPrivate(v, operation);
    if (!input.ok) return input;
    const native = await v.native.copySource(input.value);
    if (native.type !== 'ready')
      return readError(
        'unsupported',
        'SOURCE_COPY_UNPROVEN',
        'Source ownership, container or reference preservation could not be proved.',
      );
    const evidence = native.copies[native.copies.length - 1];
    if (evidence === undefined) return contentFailure();
    const origin = copyOrigin(
      this.ctx_abyssPrivate.api,
      evidence,
      operation.source,
      (kind, parent, ref) => this.reader_abyssPrivate.entry(kind, parent, ref),
    );
    return origin.ok
      ? this.retain_abyssPrivate(native, v, undefined, { copy: origin.value })
      : origin;
  }
  private async create_abyssPrivate(
    input: Extract<PrepareTaskContentV1, { kind: 'create' }>,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    if (!supportedTreeStatuses(input.tree, this.ctx_abyssPrivate.ports))
      return readError(
        'unsupported',
        'UNSUPPORTED_STATUS',
        'The initial status symbol is not configured.',
      );
    const d = input.destination,
      selected = this.destination_abyssPrivate(d);
    if (!selected.ok) return selected;
    const destination = selected.value;
    const tree = nativeTree(input.tree, this.ctx_abyssPrivate.ports),
      native = await this.ctx_abyssPrivate.ports.creates.prepareCreateTree({ destination, tree });
    if (native.type !== 'ready') return commandResultError(native.result);
    const check = this.ctx_abyssPrivate.api.check();
    if (check !== undefined) return check;
    return this.retain_abyssPrivate(native, undefined, {
      kind: 'create',
      destination: {
        type: d.type,
        path: native.destination.filePath,
        insertion: native.destination.insertion,
        ...(d.type !== 'project'
          ? {}
          : { projectTarget: d.target, projectRevision: d.expectedRevision }),
      },
    });
  }
  private destination_abyssPrivate(
    d: Extract<PrepareTaskContentV1, { kind: 'create' }>['destination'],
  ): ApiResultV1<TaskCreatePreparationDestination> {
    let destination: TaskCreatePreparationDestination;
    if (d.type === 'configured-default') destination = d;
    else if (d.type === 'note')
      destination = {
        type: 'explicit',
        destination: { filePath: d.path, insertion: d.insertion },
        ...(d.provision === undefined ? {} : { provision: d.provision }),
      };
    else return this.projectDestination_abyssPrivate(d);

    return { ok: true, value: destination };
  }
  private projectDestination_abyssPrivate(
    d: Extract<PrepareTaskContentV1, { kind: 'create' }>['destination'] & { type: 'project' },
  ): ApiResultV1<TaskCreatePreparationDestination> {
    const projects = this.ctx_abyssPrivate.projects;
    if (projects === undefined)
      return readError('unsupported', 'UNSUPPORTED_OPERATION', 'Project destinations unavailable.');
    const proof = projects.registry.acquire(d.target, d.expectedRevision);
    if (!proof.ok) return proof;
    const selected = projects.ports.tasks.prepareDestination(proof.value);
    if (selected.type === 'error') return readFailure(selected.reason);
    return { ok: true, value: { type: 'project', destination: selected.value } };
  }
  private current_abyssPrivate(target: string): ReturnType<typeof currentNode> {
    const identity = this.ctx_abyssPrivate.api.identities.lookup(target);
    return identity.ok
      ? currentNode(this.ctx_abyssPrivate.api, {
          target,
          expectedRevision: identity.value.revision,
        })
      : identity;
  }
  private async refresh_abyssPrivate(
    v: Version,
    afterRequestId?: string,
  ): Promise<ApiResultV1<ContentPlanV1>> {
    let native:
      | Awaited<ReturnType<Extract<TaskEditPreparation, { type: 'ready' }>['refresh']>>
      | TaskCreatePreparation;
    if (v.kind === 'hierarchy')
      return readError(
        'conflict',
        'HIERARCHY_REVIEW',
        'Prepare a fresh hierarchy preview from current exact task references.',
      );
    if (v.kind === 'edit') {
      const found = this.current_abyssPrivate(v.originalTarget ?? '');
      if (!found.ok) return found;
      native = await (v.native as Extract<TaskEditPreparation, { type: 'ready' }>).refresh(
        found.value.node.value.root,
      );
    } else {
      const refreshed = await this.refreshCreate_abyssPrivate(v, afterRequestId);
      if (!refreshed.ok) return refreshed;
      native = refreshed.value;
    }
    if (native.type === 'unavailable') return readFailure('incomplete');
    if (native.type !== 'ready') return commandResultError(native.result);
    const result = this.retain_abyssPrivate(native, v);
    return result;
  }
  private async refreshCreate_abyssPrivate(
    v: Version,
    afterRequestId?: string,
  ): Promise<ApiResultV1<TaskCreatePreparation>> {
    const ctx = this.ctx_abyssPrivate;
    let anchor: TaskSnapshot | undefined;
    if (afterRequestId !== undefined) {
      const evidence = await ctx.requests.contentEvidence(ctx.consumerId, afterRequestId);
      if (
        evidence === undefined ||
        !('sharesDestinationBasis' in v.native) ||
        !v.native.sharesDestinationBasis(evidence.preparation)
      )
        return contentFailure('INVALID_CREATION_ANCHOR');
      const found = this.current_abyssPrivate(evidence.target);
      if (!found.ok) return found;
      anchor = found.value.node.value.root;
    }
    const native = await (v.native as Extract<TaskCreatePreparation, { type: 'ready' }>).refresh(
      anchor === undefined ? undefined : { createdDestinationAnchor: anchor },
    );
    return { ok: true, value: native };
  }
  async tree(query: ReadTaskTreeV1, options?: unknown): Promise<ApiResultV1<TaskTreePageV1>> {
    const parsed = validateTreeRead(query),
      read = validateReadOptions(options);
    if (!parsed.ok) return parsed;
    if (!read.ok) return read;
    const ctx = this.ctx_abyssPrivate;
    try {
      const failed = ctx.api.check(read.value.signal);
      if (failed !== undefined) return failed;
      await Promise.resolve();
      return ctx.api.check(read.value.signal) ?? this.treeValue_abyssPrivate(parsed.value);
    } catch {
      return ctx.api.internal('tasks.tree');
    }
  }
  private treeValue_abyssPrivate(q: ReadTaskTreeV1): ApiResultV1<TaskTreePageV1> {
    if (q.plan === undefined) return this.reader_abyssPrivate.accepted(q);
    const found = this.lookup_abyssPrivate(q.plan, q.expectedPlanRevision ?? '');
    if (!found.ok) return found;
    const expected = this.expectedPlanTask_abyssPrivate(q, found.value);
    if (expected !== undefined) return expected;
    const v = found.value,
      before = q.side === 'before',
      root = before ? v.before : v.native.after;
    if (root === null) return readFailure('missing');
    const target = (before ? v.beforeTasks : v.tasks).get(q.target);
    if (target === undefined) return contentFailure('STALE_TARGET');
    const node = this.roots_abyssPrivate(v, before)
      .map((candidate) => findTreeNode(candidate, target))
      .find((node) => node !== undefined);
    return node === undefined
      ? contentFailure('STALE_TARGET')
      : this.reader_abyssPrivate.read(
          q,
          node,
          this.projection_abyssPrivate(v, before),
          v.observedAtMs,
        );
  }
  private expectedPlanTask_abyssPrivate(
    q: ReadTaskTreeV1,
    v: Version,
  ): ApiResultV1<never> | undefined {
    const revision =
      q.side === 'before' ? this.beforeTaskRevision_abyssPrivate(v, q.target) : v.revision;
    return q.expectedRevision !== undefined && q.expectedRevision !== revision
      ? contentFailure('REVISION_CONFLICT')
      : undefined;
  }
  async mutate(
    method: 'tasks.apply' | 'tasks.create',
    input: ApplyTaskContentV1,
    options?: unknown,
  ): Promise<TaskContentMutationResultV1> {
    const ctx = this.ctx_abyssPrivate,
      parsed = validateContentApply(input),
      read = validateReadOptions(options);
    if (!parsed.ok) return { ...parsed, effects: 'unchanged', recovery: 'none' };
    if (!read.ok) return { ...read, effects: 'unchanged', recovery: 'none' };
    const result = await ctx.requests.executeContent(ctx.consumerId, method, parsed.value, {
      ...(read.value.signal === undefined ? {} : { signal: read.value.signal }),
      isDisposed: () => this.disposed_abyssPrivate || ctx.isDisposed(),
      admit: () => this.admit_abyssPrivate(method, parsed.value),
    });
    return redactContentMutationResult(result, ctx.api, this.deliveryLive_abyssPrivate());
  }

  private deliveryLive_abyssPrivate(): boolean {
    try {
      return (
        !this.disposed_abyssPrivate &&
        !this.ctx_abyssPrivate.isDisposed() &&
        this.ctx_abyssPrivate.api.check() === undefined
      );
    } catch {
      this.ctx_abyssPrivate.api.internal('tasks.content.delivery');
      return false;
    }
  }
  private admit_abyssPrivate(
    method: 'tasks.apply' | 'tasks.create',
    input: ApplyTaskContentV1,
  ): Parameters<TaskRequestRegistry['executeContent']>[3]['admit'] extends () => infer T
    ? T
    : never {
    const ctx = this.ctx_abyssPrivate;

    const failed = ctx.api.check();
    if (failed !== undefined) return failed;
    const found = this.lookup_abyssPrivate(input.plan, input.expectedPlanRevision);
    if (!found.ok) return found;
    const v = found.value;
    if (v.family.consumed || v.superseded) return contentFailure('PLAN_CONSUMED');
    if ((method === 'tasks.create') !== (v.kind === 'create'))
      return readError('validation', 'INVALID_ARGUMENT', 'Wrong content mutation method.');
    const reservation = ctx.api.identities.reserveNext();
    if (!reservation.ok) return reservation;
    const pinned =
      v.originalTarget === undefined
        ? { ok: true as const, value: () => {} }
        : ctx.api.identities.pin(v.originalTarget);
    if (!pinned.ok) {
      ctx.api.identities.releaseReservation(reservation.value);
      return pinned;
    }
    const coverage = new Map(v.tasks);
    const comments = new Map(v.comments);
    return {
      ok: true,
      value: {
        retainedBytes:
          v.bytes +
          new TextEncoder().encode(JSON.stringify([...coverage.keys()])).length * 4 +
          4096,
        release: () => {
          pinned.value();
          ctx.api.identities.releaseReservation(reservation.value);
        },
        execute: (acceptedAt) =>
          this.execute_abyssPrivate(v, input, {
            coverage,
            comments,
            reservation: reservation.value,
            acceptedAt,
          }),
        unknown: (acceptedAt: number, error) => ({
          ok: false,
          error,
          effects: 'unknown',
          recovery: 'reconcile',
          receipt: unknownContentReceipt(
            ctx.epoch,
            this.receiptBasis_abyssPrivate(v),
            input,
            acceptedAt,
          ),
        }),
      },
    };
  }
  private async execute_abyssPrivate(
    v: Version,
    input: ApplyTaskContentV1,
    admission: {
      coverage: Map<string, TaskNodeRef>;
      comments: Map<string, CommentRef>;
      reservation: Parameters<ContentContext['api']['identities']['claimNext']>[0];
      acceptedAt: number;
    },
  ): Promise<TaskContentMutationResultV1> {
    const ctx = this.ctx_abyssPrivate,
      { coverage, reservation, acceptedAt } = admission;

    v.family.consumed = true;
    const committed = await v.native.commit();
    const result = 'result' in committed ? committed.result : committed;
    const destinationEffects = 'result' in committed ? committed.destinationEffects : undefined;
    const receipt = contentReceipt(
      ctx.api,
      unknownContentReceipt(ctx.epoch, this.receiptBasis_abyssPrivate(v), input, acceptedAt),
      this.receiptBasis_abyssPrivate(v),
      {
        result,
        coverage,
        comments: admission.comments,
        commentHandle: (parent, ref) => this.reader_abyssPrivate.entry('comment', parent, ref),
        reservation,
        ...(destinationEffects === undefined ? {} : { destinationEffects }),
      },
    );
    if (
      v.kind === 'create' &&
      receipt.outcome === 'changed' &&
      receipt.effects === 'committed' &&
      receipt.task !== undefined
    )
      ctx.requests.retainContentEvidence(ctx.consumerId, input.requestId, {
        target: receipt.task.target,
        preparation: v.native as Extract<TaskCreatePreparation, { type: 'ready' }>,
      });
    if (result.type === 'ok') return { ok: true, receipt };
    const error = commandResultError(result);
    if (error.ok) throw new Error('Missing command error');
    return {
      ok: false,
      error: error.error,
      effects: receipt.effects,
      recovery: receipt.recovery,
      receipt,
    };
  }
  private receiptBasis_abyssPrivate(v: Version): ContentReceiptBasis {
    return {
      target: v.target,
      revision: v.revision,
      originalTarget: v.originalTarget,
      after: v.native.after,
      ...('affected' in v.native ? { affected: v.native.affected.after } : {}),
    };
  }
}
