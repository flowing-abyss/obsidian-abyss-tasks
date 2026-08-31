import type {
  TaskApplicationApi,
  TaskCommandResult,
  TaskIndexSettledEvent,
  TaskSnapshot,
} from '../tasks';
import {
  NEXT_ACTION_TAG,
  NextActionReplacementCoordinator,
  type NextActionConflict,
} from './NextActionReplacementCoordinator';

export { NEXT_ACTION_TAG, type NextActionConflict } from './NextActionReplacementCoordinator';

export type NextActionProjectMembership = (projectPath: string, task: TaskSnapshot) => boolean;
export type NextActionProjectMembershipBarrier = (settled: TaskIndexSettledEvent) => Promise<void>;

function sameTask(left: TaskSnapshot, right: TaskSnapshot): boolean {
  return left.ref.filePath === right.ref.filePath && left.ref.line === right.ref.line;
}

interface NextActionRegistry {
  readonly replacementTails: Map<string, Promise<void>>;
  readonly committedTagState: Map<
    string,
    { readonly task: TaskSnapshot; readonly tagged: boolean }
  >;
  readonly pendingProjects: Set<string>;
  readonly pendingTokens: Map<string, symbol>;
  readonly pendingKeys: Map<symbol, ReadonlySet<string>>;
  readonly bridgedProjects: Map<
    string,
    { readonly token: symbol; readonly keys: ReadonlySet<string> }
  >;
  readonly listeners: Set<() => void>;
  notificationQueued: boolean;
}

const registries = new WeakMap<object, NextActionRegistry>();

/** Shared pending projection for remount-safe consumers while a guarded replacement settles. */
export function projectedNextAction(
  application: TaskApplicationApi,
  task: TaskSnapshot,
): boolean | undefined {
  return registryFor(application).committedTagState.get(
    `${task.ref.filePath}\u0000${String(task.ref.line)}`,
  )?.tagged;
}

/**
 * A Project surface calls this only after it has rendered the settled query
 * state.  It makes the final authoritative bridge one-render bounded without
 * allowing an old service instance to retire a newer pending operation.
 */
export function acknowledgeProjectedNextActions(
  application: TaskApplicationApi,
  projectPath: string,
  token?: symbol,
): void {
  const registry = registryFor(application);
  if (registry.pendingProjects.has(projectPath)) return;
  const bridge = registry.bridgedProjects.get(projectPath);
  if (!bridge || (token !== undefined && bridge.token !== token)) return;
  for (const key of bridge.keys) {
    registry.committedTagState.delete(key);
  }
  registry.bridgedProjects.delete(projectPath);
  notify(registry);
}

/** Application-owned projection invalidation; panel lifetimes must unsubscribe. */
export function subscribeProjectedNextActions(
  application: TaskApplicationApi,
  listener: () => void,
): () => void {
  const registry = registryFor(application);
  registry.listeners.add(listener);
  return () => registry.listeners.delete(listener);
}

export function projectedNextActionToken(
  application: TaskApplicationApi,
  projectPath: string,
): symbol | undefined {
  return registryFor(application).bridgedProjects.get(projectPath)?.token;
}

function notify(registry: NextActionRegistry): void {
  if (registry.notificationQueued) return;
  registry.notificationQueued = true;
  queueMicrotask(() => {
    registry.notificationQueued = false;
    for (const listener of registry.listeners) listener();
  });
}

function registryFor(application: TaskApplicationApi): NextActionRegistry {
  const existing = registries.get(application);
  if (existing) return existing;
  const registry: NextActionRegistry = {
    replacementTails: new Map(),
    committedTagState: new Map(),
    pendingProjects: new Set(),
    pendingTokens: new Map(),
    pendingKeys: new Map(),
    bridgedProjects: new Map(),
    listeners: new Set(),
    notificationQueued: false,
  };
  // The projection belongs to the application, not to a transient panel/service.
  // One listener is enough to retire settled bridges, and avoids remounts leaving
  // behind callbacks that can clear a later operation's overlay.
  application.queries.subscribeSettled?.((settled) => {
    if (registry.pendingProjects.size > 0) return;
    const paths = new Set(settled.files.map(({ path }) => path));
    for (const [key, pending] of registry.committedTagState) {
      if (paths.has(pending.task.ref.filePath)) registry.committedTagState.delete(key);
    }
    notify(registry);
  });
  registries.set(application, registry);
  return registry;
}

export class NextActionService {
  private readonly registry: NextActionRegistry;
  /** Bridges the TaskIndex publication lag after our own guarded root-tag commits. */
  constructor(
    private readonly application: TaskApplicationApi,
    private readonly projectMembership?: NextActionProjectMembership,
    private readonly awaitProjectMembership?: NextActionProjectMembershipBarrier,
  ) {
    this.registry = registryFor(application);
  }

  async set(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    return await this.serialize(projectPath, async () => {
      const tagged = this.taggedForProject(projectPath, task);
      const pending = this.beginPending(projectPath, task, tagged);
      try {
        const result = await new NextActionReplacementCoordinator(this.application).replace(
          task,
          tagged,
          projectPath,
        );
        const verified = await this.verify(projectPath, task);
        if (verified.ran) this.publishVerifiedState(projectPath, task, pending);
        if (result.type === 'integrity-conflict') {
          if (verified.conflict) {
            return {
              ...verified.conflict,
              diagnostic: `${result.diagnostic}; ${verified.conflict.diagnostic}`,
            };
          }
          if (verified.ran) {
            return this.integrityConflict(
              projectPath,
              `${result.diagnostic}; authoritative rescan verified the exact replacement state`,
              this.currentTagged(projectPath, task),
            );
          }
          return {
            type: 'integrity-conflict',
            projectPath,
            tag: NEXT_ACTION_TAG,
            tasks: [],
            diagnostic: `${result.diagnostic}; authoritative rescan found an indeterminate replacement state`,
          };
        }
        if (result.type !== 'ok') return result;
        if (!verified.ran) {
          // Legacy/read-only adapters do not provide the mandatory production
          // barrier. Preserve their existing sequential command behaviour,
          // while the real TaskIndex reaches this branch only after verify().
          if (!this.application.queries.rescan) {
            this.rememberTagState(task, true);
            for (const previous of tagged) this.rememberTagState(previous, false);
          }
        }
        return verified.conflict ?? result;
      } finally {
        this.endPending(projectPath, pending);
      }
    });
  }

  async clear(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    if (!this.application.applyRootTagChanges) return this.unavailable();
    return await this.serialize(projectPath, async () => {
      const pending = this.beginPending(projectPath, task, [task]);
      try {
        const result = await this.application.applyRootTagChanges!({
          primary: task.ref,
          changes: [{ task, tags: { remove: [NEXT_ACTION_TAG] } }],
        });
        const verified = await this.verify(projectPath);
        if (verified.ran) this.publishVerifiedState(projectPath, undefined, pending);
        if (result.type !== 'ok') return result;
        if (!verified.ran) {
          this.rememberTagState(task, false);
        }
        return verified.conflict ?? result;
      } finally {
        this.endPending(projectPath, pending);
      }
    });
  }

  private unavailable(): TaskCommandResult {
    return {
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'next-action' }],
    };
  }

  private taggedForProject(projectPath: string, target: TaskSnapshot): readonly TaskSnapshot[] {
    this.reconcileCommittedTagState();
    const candidates = new Map<string, TaskSnapshot>();
    for (const candidate of this.application.queries.list()) {
      if (this.belongsToProject(projectPath, candidate, target)) {
        candidates.set(this.key(candidate), candidate);
      }
    }
    for (const { task } of this.registry.committedTagState.values()) {
      if (this.belongsToProject(projectPath, task, target)) candidates.set(this.key(task), task);
    }
    return [...candidates.values()].filter(
      (candidate) =>
        !sameTask(candidate, target) &&
        (this.registry.committedTagState.get(this.key(candidate))?.tagged ??
          candidate.tags.includes(NEXT_ACTION_TAG)),
    );
  }

  private rememberTagState(task: TaskSnapshot, tagged: boolean): void {
    this.registry.committedTagState.set(this.key(task), { task, tagged });
  }

  private beginPending(
    projectPath: string,
    target: TaskSnapshot,
    previous: readonly TaskSnapshot[],
  ): symbol {
    const token = Symbol(projectPath);
    this.registry.pendingProjects.add(projectPath);
    this.registry.pendingTokens.set(projectPath, token);
    this.registry.pendingKeys.set(
      token,
      new Set([this.key(target), ...previous.map((candidate) => this.key(candidate))]),
    );
    this.rememberTagState(target, false);
    for (const task of previous) this.rememberTagState(task, true);
    notify(this.registry);
    return token;
  }

  private endPending(projectPath: string, token: symbol): void {
    if (this.registry.pendingTokens.get(projectPath) !== token) return;
    this.registry.pendingProjects.delete(projectPath);
    this.registry.pendingTokens.delete(projectPath);
    this.registry.pendingKeys.delete(token);
    // Both legacy adapters and a verified Project render need the bridge until
    // the application-owned acknowledgement/next settled publication retires it.
    notify(this.registry);
  }

  private publishVerifiedState(
    projectPath: string,
    target: TaskSnapshot | undefined,
    token: symbol,
  ): void {
    const current = this.application.queries
      .list()
      .filter((candidate) => this.belongsToProject(projectPath, candidate, target ?? candidate));
    const currentKeys = new Set(current.map((candidate) => this.key(candidate)));
    for (const candidate of current) {
      this.rememberTagState(candidate, candidate.tags.includes(NEXT_ACTION_TAG));
    }
    this.registry.bridgedProjects.set(projectPath, { token, keys: currentKeys });
    for (const [key, pending] of this.registry.committedTagState) {
      if (
        this.belongsToProject(projectPath, pending.task, target ?? pending.task) &&
        !currentKeys.has(key)
      ) {
        this.registry.committedTagState.delete(key);
      }
    }
    notify(this.registry);
  }

  private async verify(
    projectPath: string,
    target?: TaskSnapshot,
  ): Promise<{ readonly ran: boolean; readonly conflict?: NextActionConflict }> {
    // Compatibility adapters without the new barrier cannot be mistaken for a real TaskIndex.
    // The production TaskIndex always supplies it; legacy test/read-only adapters keep prior behavior.
    if (!this.application.queries.rescan) return { ran: false };
    const settled = await this.application.queries.rescan();
    await this.awaitProjectMembership?.(settled);
    const tagged = this.application.queries
      .list()
      .filter((task) => this.belongsToProject(projectPath, task, target ?? task))
      .filter((task) => task.tags.includes(NEXT_ACTION_TAG));
    let exact = tagged.length === 0;
    if (target) exact = tagged.length === 1 && sameTask(tagged[0]!, target);
    if (exact) return { ran: true };
    const diagnostic = target
      ? 'expected exactly one next action after authoritative rescan'
      : 'expected no next action after authoritative rescan';
    return { ran: true, conflict: this.integrityConflict(projectPath, diagnostic, tagged) };
  }

  private currentTagged(projectPath: string, target: TaskSnapshot): readonly TaskSnapshot[] {
    return this.application.queries
      .list()
      .filter((task) => this.belongsToProject(projectPath, task, target))
      .filter((task) => task.tags.includes(NEXT_ACTION_TAG));
  }

  private integrityConflict(
    projectPath: string,
    diagnostic: string,
    tasks: readonly TaskSnapshot[] = [],
  ): NextActionConflict {
    return { type: 'integrity-conflict', projectPath, tag: NEXT_ACTION_TAG, tasks, diagnostic };
  }

  /** Stops our write-lag bridge from masking a later index or external publication. */
  private reconcileCommittedTagState(_settled?: TaskIndexSettledEvent): void {
    // Settled-event cleanup is application-owned in registryFor().  A service
    // can only reconcile against the current query snapshot and can never
    // remove a bridge created by a later service/remount.
    if (this.registry.pendingProjects.size > 0) return;
    for (const task of this.application.queries.list()) {
      const key = this.key(task);
      const pending = this.registry.committedTagState.get(key);
      if (pending && task.tags.includes(NEXT_ACTION_TAG) === pending.tagged) {
        this.registry.committedTagState.delete(key);
      }
    }
  }

  private key(task: TaskSnapshot): string {
    return `${task.ref.filePath}\u0000${String(task.ref.line)}`;
  }

  private async serialize<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.registry.replacementTails.get(projectPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.registry.replacementTails.set(projectPath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.registry.replacementTails.get(projectPath) === tail) {
        this.registry.replacementTails.delete(projectPath);
      }
    }
  }

  private belongsToProject(
    projectPath: string,
    candidate: TaskSnapshot,
    _target: TaskSnapshot,
  ): boolean {
    // Direct-file membership is the only safe fallback. Joined work-note
    // membership is supplied by the canonical Project relation resolver.
    return (
      candidate.source.filePath === projectPath ||
      this.projectMembership?.(projectPath, candidate) === true
    );
  }
}
