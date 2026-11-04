import type {
  TaskAcceptedOccurrenceChange,
  TaskAcceptedSourceEvidence,
  TaskReadEvent,
  TaskReadObservation,
  TaskSourceHealthChange,
} from '../application/TaskIntegrationReadApi';
import type {
  TaskStatusOccurrenceContinuation,
  TaskStatusOccurrenceContinuations,
  TaskStatusOccurrenceEffects,
  TaskStatusReadBasisApi,
  TaskStatusReadLease,
  TaskStrictStatusFailure,
  TaskStrictStatusGuard,
  TaskStrictWriteContext,
} from '../application/TaskStatusMutationApi';
import type { TaskOccurrenceAddress } from '../domain/taskOccurrence';
import { taskNodeSourceLine, taskTreeNodes } from '../domain/taskSearchProjection';
import { sameTaskNodeRef, type TaskNodeRef, type TaskSnapshot } from '../domain/types';
import type { TaskIntegrationReadState } from './TaskIntegrationReadState';
import { taskSourceMetadata, type TaskSourceMetadata } from './taskSourceMetadata';

interface LeaseSource {
  readonly tasks: readonly TaskSnapshot[];
  readonly fileIdentity: object | undefined;
  readonly revision: number;
  readonly content: string;
}
interface LeasePorts {
  readonly state: TaskIntegrationReadState;
  readonly source: (path: string) => LeaseSource | undefined;
  readonly permitted: (source: TaskSourceMetadata) => boolean;
  readonly current: (root: TaskSnapshot) => boolean;
  readonly activate: () => void;
}
interface PendingCandidate {
  readonly current: TaskStrictWriteContext;
  readonly content: string;
  readonly effects: TaskStatusOccurrenceEffects | undefined;
}
function sameObservation(left: TaskReadObservation, right: TaskReadObservation): boolean {
  return (
    left.revision === right.revision &&
    left.generation === right.generation &&
    left.scopeRevision === right.scopeRevision &&
    left.semanticsRevision === right.semanticsRevision &&
    left.lifecycle === right.lifecycle
  );
}
function address(root: TaskSnapshot, target: TaskNodeRef): TaskOccurrenceAddress {
  return {
    filePath: root.ref.filePath,
    rootRevision: root.ref.revision,
    rootLine: root.ref.line,
    nodeOffset: taskNodeSourceLine(target) - root.ref.line,
  };
}
function sameAddress(left: TaskOccurrenceAddress, right: TaskOccurrenceAddress): boolean {
  return (
    left.filePath === right.filePath &&
    left.rootRevision === right.rootRevision &&
    left.rootLine === right.rootLine &&
    left.nodeOffset === right.nodeOffset
  );
}
function owns(root: TaskSnapshot, value: TaskOccurrenceAddress): boolean {
  return (
    root.ref.filePath === value.filePath &&
    root.ref.line === value.rootLine &&
    root.ref.revision === value.rootRevision &&
    [...taskTreeNodes(root)].some(
      (node) => taskNodeSourceLine(node.target) === value.rootLine + value.nodeOffset,
    )
  );
}
function detached(value: TaskStatusOccurrenceContinuation): TaskStatusOccurrenceContinuation {
  return Object.freeze({
    origin: Object.freeze({ ...value.origin }),
    state: value.state,
    ...(value.current === undefined ? {} : { current: Object.freeze({ ...value.current }) }),
  });
}

function validEffects(
  effects: TaskStatusOccurrenceEffects,
  change: TaskAcceptedOccurrenceChange,
): boolean {
  const { original, next } = effects;
  const witness = change.witnesses.find(
    (value) => value.kind !== 'created' && sameAddress(value.before, original.before),
  );
  const validOriginal =
    original.after === undefined
      ? witness?.kind === 'removed'
      : witness?.kind === 'continued' && sameAddress(witness.after, original.after);
  if (!validOriginal) return false;
  return (
    next === undefined ||
    change.witnesses.some(
      (value) =>
        value.kind === 'created' && value.reason === 'recurrence' && sameAddress(value.after, next),
    )
  );
}

/** A lease owns only one in-flight candidate and the original/next occurrence proofs. */
export class TaskStatusReadLeaseOwner implements TaskStatusReadLease {
  private readonly operation_abyssPrivate = {};
  private readonly fileIdentity_abyssPrivate: object;
  private sourceRevision_abyssPrivate: number;
  private roots_abyssPrivate: readonly TaskSnapshot[];
  private original_abyssPrivate: TaskStatusOccurrenceContinuation;
  private next_abyssPrivate: TaskStatusOccurrenceContinuation | undefined;
  private mainKnown_abyssPrivate = false;
  private pending_abyssPrivate: PendingCandidate | undefined;
  private failure_abyssPrivate: TaskStrictStatusFailure | undefined;
  private readonly deferred_abyssPrivate = new Set<object>();
  private readonly proven_abyssPrivate = new Set<object>();
  private readonly unsubscribe_abyssPrivate: () => void;
  private disposed_abyssPrivate = false;

  private constructor(
    private readonly ports_abyssPrivate: LeasePorts,
    readonly observation: TaskReadObservation,
    initial: {
      readonly root: TaskSnapshot;
      readonly target: TaskNodeRef;
      readonly source: LeaseSource & { readonly fileIdentity: object };
    },
  ) {
    const { root, target, source } = initial;
    this.fileIdentity_abyssPrivate = source.fileIdentity;
    this.sourceRevision_abyssPrivate = source.revision;
    this.roots_abyssPrivate = [root];
    const origin = address(root, target);
    this.original_abyssPrivate = { origin, current: origin, state: 'retained' };
    this.unsubscribe_abyssPrivate = ports_abyssPrivate.state.subscribeInward((event) => {
      this.receive_abyssPrivate(event);
    }).unsubscribe;
  }

  static create(
    ports: LeasePorts,
    root: TaskSnapshot,
    target: TaskNodeRef,
    observation: TaskReadObservation,
  ): ReturnType<TaskStatusReadBasisApi['lease']> {
    const current = ports.state.capture();
    if (current.semanticsRevision !== observation.semanticsRevision)
      return { type: 'rejected', reason: 'semantics-changed' };
    if (current.scopeRevision !== observation.scopeRevision)
      return { type: 'rejected', reason: 'source-unavailable' };
    if (ports.state.coverage().type !== 'ok')
      return { type: 'rejected', reason: 'incomplete-read' };
    if (!sameObservation(current, observation) || !ports.current(root))
      return { type: 'rejected', reason: 'revision-changed' };
    const source = ports.source(root.ref.filePath);
    if (source?.fileIdentity === undefined)
      return { type: 'rejected', reason: 'source-unavailable' };
    if (!ports.permitted(taskSourceMetadata(root.ref.filePath, source.content)))
      return { type: 'rejected', reason: 'source-unavailable' };
    if (![...taskTreeNodes(root)].some((node) => sameTaskNodeRef(node.target, target)))
      return { type: 'rejected', reason: 'revision-changed' };
    ports.activate();
    return {
      type: 'ready',
      lease: new TaskStatusReadLeaseOwner(ports, observation, {
        root,
        target,
        source: { ...source, fileIdentity: source.fileIdentity },
      }),
    };
  }

  guard(root: TaskSnapshot, target: TaskNodeRef): TaskStrictStatusGuard {
    return {
      operation: this.operation_abyssPrivate,
      check: (current) => this.check_abyssPrivate(root, target, current),
      expectCommit: (current, content, effects) => {
        const reason = this.check_abyssPrivate(root, target, current);
        if (reason !== undefined) throw new Error('Rejected strict candidate');
        this.pending_abyssPrivate = { current, content, effects };
      },
    };
  }

  private check_abyssPrivate(
    root: TaskSnapshot,
    target: TaskNodeRef,
    current: TaskStrictWriteContext,
  ): TaskStrictStatusFailure | undefined {
    const sourceFailure = this.sourceFailure_abyssPrivate(root, current);
    if (sourceFailure !== undefined) {
      this.reject_abyssPrivate(sourceFailure);
      return sourceFailure;
    }
    if (this.failure_abyssPrivate !== undefined) return this.failure_abyssPrivate;
    const failure =
      this.basisFailure_abyssPrivate() ?? this.rootFailure_abyssPrivate(root, target, current);
    return failure === undefined ? undefined : this.reject_abyssPrivate(failure);
  }

  private sourceFailure_abyssPrivate(
    root: TaskSnapshot,
    current: TaskStrictWriteContext,
  ): TaskStrictStatusFailure | undefined {
    if (
      this.disposed_abyssPrivate ||
      current.fileIdentity !== this.fileIdentity_abyssPrivate ||
      current.filePath !== root.ref.filePath ||
      !this.ports_abyssPrivate.permitted(taskSourceMetadata(current.filePath, current.content))
    )
      return 'source-unavailable';
    if (this.ports_abyssPrivate.source(current.filePath)?.content !== current.content)
      return 'revision-changed';
    return undefined;
  }

  private observationFailure_abyssPrivate(
    observed: TaskReadObservation,
  ): TaskStrictStatusFailure | undefined {
    if (observed.semanticsRevision !== this.observation.semanticsRevision)
      return 'semantics-changed';
    if (observed.scopeRevision !== this.observation.scopeRevision) return 'source-unavailable';
    if (observed.lifecycle !== 'ready') return 'incomplete-read';
    return undefined;
  }

  private basisFailure_abyssPrivate(): TaskStrictStatusFailure | undefined {
    const changed = this.observationFailure_abyssPrivate(this.ports_abyssPrivate.state.capture());
    if (changed !== undefined) return changed;
    if (
      this.pending_abyssPrivate !== undefined ||
      this.deferred_abyssPrivate.size > 0 ||
      this.ports_abyssPrivate.state.coverage().type !== 'ok'
    )
      return 'incomplete-read';
    return undefined;
  }

  private rootFailure_abyssPrivate(
    root: TaskSnapshot,
    target: TaskNodeRef,
    current: TaskStrictWriteContext,
  ): TaskStrictStatusFailure | undefined {
    if (
      !this.roots_abyssPrivate.some(
        (owned) =>
          owned.ref.revision === root.ref.revision &&
          owned.ref.line === root.ref.line &&
          owned.source.originalBlock === root.source.originalBlock,
      ) ||
      !sameTaskNodeRef(current.target, target) ||
      current.root.ref.revision !== root.ref.revision ||
      current.root.source.originalBlock !== root.source.originalBlock
    )
      return 'revision-changed';
    return undefined;
  }

  failure(): TaskStrictStatusFailure | undefined {
    return this.failure_abyssPrivate;
  }
  occurrences(): TaskStatusOccurrenceContinuations {
    return Object.freeze({
      original: detached(this.original_abyssPrivate),
      ...(this.next_abyssPrivate === undefined ? {} : { next: detached(this.next_abyssPrivate) }),
    });
  }
  markMainUnknown(): void {
    if (!this.mainKnown_abyssPrivate) {
      this.original_abyssPrivate = { origin: this.original_abyssPrivate.origin, state: 'unproven' };
      this.next_abyssPrivate = undefined;
    }
    this.pending_abyssPrivate = undefined;
  }
  dispose(): void {
    this.disposed_abyssPrivate = true;
    this.unsubscribe_abyssPrivate();
    this.pending_abyssPrivate = undefined;
    this.roots_abyssPrivate = [];
    this.deferred_abyssPrivate.clear();
    this.proven_abyssPrivate.clear();
  }
  private reject_abyssPrivate(
    reason: TaskStrictStatusFailure,
    paths?: readonly string[],
  ): TaskStrictStatusFailure {
    this.failure_abyssPrivate ??= reason;
    this.pending_abyssPrivate = undefined;
    this.roots_abyssPrivate = [];
    this.deferred_abyssPrivate.clear();
    this.clearCurrents_abyssPrivate(
      (role) => paths === undefined || paths.includes(role.origin.filePath),
    );
    return this.failure_abyssPrivate;
  }
  private clearCurrents_abyssPrivate(
    affected: (role: TaskStatusOccurrenceContinuation) => boolean,
  ): void {
    const clear = (role: TaskStatusOccurrenceContinuation): TaskStatusOccurrenceContinuation =>
      affected(role) ? { origin: role.origin, state: role.state } : role;
    this.original_abyssPrivate = clear(this.original_abyssPrivate);
    if (this.next_abyssPrivate !== undefined)
      this.next_abyssPrivate = clear(this.next_abyssPrivate);
  }

  private invalidateChangedRoles_abyssPrivate(change: TaskAcceptedOccurrenceChange): void {
    this.clearCurrents_abyssPrivate((role) => {
      const current = role.current;
      if (current === undefined || !change.paths.includes(current.filePath)) return false;
      if (change.restored) return true;
      const source = change.sources.find((source) => source.filePath === current.filePath);
      return (
        source?.fileIdentity !== this.fileIdentity_abyssPrivate ||
        !change.after.some((root) => owns(root, current))
      );
    });
  }

  private revalidateCurrents_abyssPrivate(): void {
    // A pathless source bookkeeping event can follow accepted deletion/rename evidence.
    // Check only retained exact addresses; this neither follows successors nor grants writes.
    this.clearCurrents_abyssPrivate((role) => {
      const current = role.current;
      if (current === undefined) return false;
      const source = this.ports_abyssPrivate.source(current.filePath);
      return (
        source?.fileIdentity !== this.fileIdentity_abyssPrivate ||
        !source.tasks.some((root) => owns(root, current) && this.ports_abyssPrivate.current(root))
      );
    });
  }

  private invalidateAfterFailure_abyssPrivate(event: TaskReadEvent): void {
    if (event.type === 'accepted') {
      this.invalidateChangedRoles_abyssPrivate(event.change);
      return;
    }
    if (event.type === 'health') {
      if (this.proven_abyssPrivate.has(event.change.acquisition) && event.change.phase !== 'failed')
        return;
      this.clearCurrents_abyssPrivate((role) => role.origin.filePath === event.change.filePath);
      return;
    }
    this.revalidateCurrents_abyssPrivate();
  }

  private receive_abyssPrivate(event: TaskReadEvent): void {
    if (this.disposed_abyssPrivate) return;
    const failure = this.observationFailure_abyssPrivate(event.observation);
    if (failure !== undefined) {
      this.reject_abyssPrivate(failure);
      return;
    }
    if (this.failure_abyssPrivate !== undefined) {
      this.invalidateAfterFailure_abyssPrivate(event);
      return;
    }
    if (event.type === 'accepted') {
      this.accept_abyssPrivate(event.change);
      return;
    }
    if (event.type !== 'health') {
      this.revalidateCurrents_abyssPrivate();
      this.reject_abyssPrivate('revision-changed', []);
      return;
    }
    this.health_abyssPrivate(event.change);
  }

  private health_abyssPrivate(change: TaskSourceHealthChange): void {
    if (this.proven_abyssPrivate.has(change.acquisition) && change.phase !== 'failed') return;
    const pending = this.pending_abyssPrivate;
    if (
      change.phase !== 'failed' &&
      change.fileIdentity === pending?.current.fileIdentity &&
      change.filePath === pending.current.filePath
    ) {
      this.deferred_abyssPrivate.add(change.acquisition);
      return;
    }
    this.reject_abyssPrivate('incomplete-read', [change.filePath]);
  }

  private accept_abyssPrivate(change: TaskAcceptedOccurrenceChange): void {
    if (change.restored) {
      this.invalidateChangedRoles_abyssPrivate(change);
      this.reject_abyssPrivate('revision-changed', []);
      return;
    }
    const pending = this.pending_abyssPrivate;
    if (pending === undefined) {
      this.acceptEcho_abyssPrivate(change);
      return;
    }
    const source = this.matchingSource_abyssPrivate(change, pending);
    if (source === undefined) {
      this.invalidateChangedRoles_abyssPrivate(change);
      this.reject_abyssPrivate('revision-changed', []);
      return;
    }
    this.settleTokens_abyssPrivate(source);
    if (this.deferred_abyssPrivate.size > 0) {
      this.reject_abyssPrivate('incomplete-read');
      return;
    }
    if (!this.acceptRoles_abyssPrivate(pending, change)) {
      this.invalidateChangedRoles_abyssPrivate(change);
      this.reject_abyssPrivate('revision-changed', []);
      return;
    }
    this.roots_abyssPrivate = change.after.filter((root) =>
      [this.original_abyssPrivate.current, this.next_abyssPrivate?.current].some(
        (value) => value !== undefined && owns(root, value),
      ),
    );
    this.sourceRevision_abyssPrivate =
      this.ports_abyssPrivate.source(source.filePath)?.revision ?? -1;
    this.pending_abyssPrivate = undefined;
  }

  private acceptEcho_abyssPrivate(change: TaskAcceptedOccurrenceChange): void {
    const path = this.original_abyssPrivate.origin.filePath;
    const source = change.sources[0];
    const currentSource = this.ports_abyssPrivate.source(path);
    if (
      change.paths.length !== 1 ||
      change.paths[0] !== path ||
      source?.fileIdentity !== this.fileIdentity_abyssPrivate ||
      currentSource?.revision !== this.sourceRevision_abyssPrivate ||
      change.invalidated.length > 0
    ) {
      this.invalidateChangedRoles_abyssPrivate(change);
      this.reject_abyssPrivate('revision-changed', []);
      return;
    }
    this.settleTokens_abyssPrivate(source);
  }

  private matchingSource_abyssPrivate(
    change: TaskAcceptedOccurrenceChange,
    pending: PendingCandidate,
  ): TaskAcceptedSourceEvidence | undefined {
    if (
      change.operation !== this.operation_abyssPrivate ||
      change.paths.length !== 1 ||
      change.sources.length !== 1
    )
      return undefined;
    const source = change.sources[0];
    if (
      source?.filePath !== pending.current.filePath ||
      source.fileIdentity !== pending.current.fileIdentity ||
      source.content !== pending.content
    )
      return undefined;
    if (
      !change.before.some(
        (root) =>
          root.ref.revision === pending.current.root.ref.revision &&
          root.source.originalBlock === pending.current.root.source.originalBlock,
      )
    )
      return undefined;
    return source;
  }

  private settleTokens_abyssPrivate(source: TaskAcceptedSourceEvidence): void {
    for (const token of source.settledAcquisitions) {
      this.deferred_abyssPrivate.delete(token);
      this.proven_abyssPrivate.add(token);
    }
  }

  private acceptRoles_abyssPrivate(
    pending: PendingCandidate,
    change: TaskAcceptedOccurrenceChange,
  ): boolean {
    if (pending.effects !== undefined)
      return !this.mainKnown_abyssPrivate && this.seed_abyssPrivate(pending.effects, change);
    this.original_abyssPrivate = this.advance_abyssPrivate(this.original_abyssPrivate, change);
    if (this.next_abyssPrivate !== undefined)
      this.next_abyssPrivate = this.advance_abyssPrivate(this.next_abyssPrivate, change);
    return true;
  }

  private seed_abyssPrivate(
    effects: TaskStatusOccurrenceEffects,
    change: TaskAcceptedOccurrenceChange,
  ): boolean {
    const original = effects.original;
    if (!sameAddress(original.before, this.original_abyssPrivate.origin)) return false;
    if (!validEffects(effects, change)) return false;
    this.original_abyssPrivate = {
      origin: original.before,
      state: original.after === undefined ? 'removed' : 'retained',
      ...(original.after === undefined ? {} : { current: original.after }),
    };
    if (effects.next !== undefined)
      this.next_abyssPrivate = { origin: effects.next, current: effects.next, state: 'retained' };
    this.mainKnown_abyssPrivate = true;
    return true;
  }
  private advance_abyssPrivate(
    role: TaskStatusOccurrenceContinuation,
    change: TaskAcceptedOccurrenceChange,
  ): TaskStatusOccurrenceContinuation {
    if (role.current === undefined) return role;
    const current = role.current;
    const witness = change.witnesses.find(
      (value) => value.kind !== 'created' && sameAddress(value.before, current),
    );
    if (witness?.kind === 'continued') return { ...role, current: witness.after };
    if (change.after.some((root) => owns(root, current))) return role;
    return { origin: role.origin, state: role.state };
  }
}
