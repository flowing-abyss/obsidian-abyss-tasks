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

function registryFor(application: TaskApplicationApi): NextActionRegistry {
  const existing = registries.get(application);
  if (existing) return existing;
  const registry: NextActionRegistry = {
    replacementTails: new Map(),
    committedTagState: new Map(),
    pendingProjects: new Set(),
  };
  registries.set(application, registry);
  return registry;
}

export class NextActionService {
  private readonly registry: NextActionRegistry;
  /** Bridges the TaskIndex publication lag after our own guarded root-tag commits. */
  constructor(
    private readonly application: TaskApplicationApi,
    private readonly projectMembership?: NextActionProjectMembership,
  ) {
    this.registry = registryFor(application);
    this.application.queries.subscribeSettled?.((event) => this.reconcileCommittedTagState(event));
  }

  async set(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    return await this.serialize(projectPath, async () => {
      const tagged = this.taggedForProject(projectPath, task);
      this.beginPending(projectPath, task, tagged);
      try {
        const result = await new NextActionReplacementCoordinator(this.application).replace(
          task,
          tagged,
          projectPath,
        );
        if (result.type === 'ok') {
          this.rememberTagState(task, true);
          for (const previous of tagged) this.rememberTagState(previous, false);
        }
        const verified = await this.verify(projectPath, task);
        if (result.type === 'integrity-conflict') {
          if (verified) {
            return { ...verified, diagnostic: `${result.diagnostic}; ${verified.diagnostic}` };
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
        return verified ?? result;
      } finally {
        this.endPending(projectPath);
      }
    });
  }

  async clear(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    if (!this.application.applyRootTagChanges) return this.unavailable();
    return await this.serialize(projectPath, async () => {
      this.beginPending(projectPath, task, [task]);
      try {
        const result = await this.application.applyRootTagChanges!({
          primary: task.ref,
          changes: [{ task, tags: { remove: [NEXT_ACTION_TAG] } }],
        });
        if (result.type === 'ok') this.rememberTagState(task, false);
        const verified = await this.verify(projectPath);
        if (result.type !== 'ok') return result;
        return verified ?? result;
      } finally {
        this.endPending(projectPath);
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
  ): void {
    this.registry.pendingProjects.add(projectPath);
    this.rememberTagState(target, false);
    for (const task of previous) this.rememberTagState(task, true);
  }

  private endPending(projectPath: string): void {
    this.registry.pendingProjects.delete(projectPath);
    // Keep the settled snapshot as the presentation bridge until a later publication
    // replaces stale mounted Project snapshots.
  }

  private async verify(
    projectPath: string,
    target?: TaskSnapshot,
  ): Promise<NextActionConflict | undefined> {
    // Compatibility adapters without the new barrier cannot be mistaken for a real TaskIndex.
    // The production TaskIndex always supplies it; legacy test/read-only adapters keep prior behavior.
    if (!this.application.queries.rescan) return undefined;
    await this.application.queries.rescan();
    const tagged = this.application.queries
      .list()
      .filter((task) => this.belongsToProject(projectPath, task, target ?? task))
      .filter((task) => task.tags.includes(NEXT_ACTION_TAG));
    let exact = tagged.length === 0;
    if (target) exact = tagged.length === 1 && sameTask(tagged[0]!, target);
    if (exact) return undefined;
    const diagnostic = target
      ? 'expected exactly one next action after authoritative rescan'
      : 'expected no next action after authoritative rescan';
    return this.integrityConflict(projectPath, diagnostic, tagged);
  }

  private integrityConflict(
    projectPath: string,
    diagnostic: string,
    tasks: readonly TaskSnapshot[] = [],
  ): NextActionConflict {
    return { type: 'integrity-conflict', projectPath, tag: NEXT_ACTION_TAG, tasks, diagnostic };
  }

  /** Stops our write-lag bridge from masking a later index or external publication. */
  private reconcileCommittedTagState(settled?: TaskIndexSettledEvent): void {
    if (settled) {
      const settledPaths = new Set(settled.files.map(({ path }) => path));
      for (const [key, pending] of this.registry.committedTagState) {
        if (
          settledPaths.has(pending.task.ref.filePath) &&
          ![...this.registry.pendingProjects].some((projectPath) =>
            this.belongsToProject(projectPath, pending.task, pending.task),
          )
        ) {
          this.registry.committedTagState.delete(key);
        }
      }
    }
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
    target: TaskSnapshot,
  ): boolean {
    if (this.projectMembership) return this.projectMembership(projectPath, candidate);
    return (
      candidate.source.filePath === projectPath ||
      candidate.source.filePath === target.source.filePath
    );
  }
}
