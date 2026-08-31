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

export class NextActionService {
  private readonly replacementTails = new Map<string, Promise<void>>();
  /** Bridges the TaskIndex publication lag after our own guarded root-tag commits. */
  private readonly committedTagState = new Map<
    string,
    { readonly task: TaskSnapshot; readonly tagged: boolean }
  >();
  constructor(
    private readonly application: TaskApplicationApi,
    private readonly projectMembership?: NextActionProjectMembership,
  ) {
    this.application.queries.subscribeSettled?.((event) => this.reconcileCommittedTagState(event));
  }

  async set(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    return await this.serialize(projectPath, async () => {
      const tagged = this.taggedForProject(projectPath, task);
      const result = await new NextActionReplacementCoordinator(this.application).replace(
        task,
        tagged,
        projectPath,
      );
      if (result.type === 'ok') {
        this.rememberTagState(task, true);
        for (const previous of tagged) this.rememberTagState(previous, false);
      }
      return result;
    });
  }

  async clear(task: TaskSnapshot): Promise<TaskCommandResult> {
    if (!this.application.applyRootTagChanges) return this.unavailable();
    const result = await this.application.applyRootTagChanges({
      primary: task.ref,
      changes: [{ task, tags: { remove: [NEXT_ACTION_TAG] } }],
    });
    if (result.type === 'ok') this.rememberTagState(task, false);
    return result;
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
    for (const { task } of this.committedTagState.values()) {
      if (this.belongsToProject(projectPath, task, target)) candidates.set(this.key(task), task);
    }
    return [...candidates.values()].filter(
      (candidate) =>
        !sameTask(candidate, target) &&
        (this.committedTagState.get(this.key(candidate))?.tagged ??
          candidate.tags.includes(NEXT_ACTION_TAG)),
    );
  }

  private rememberTagState(task: TaskSnapshot, tagged: boolean): void {
    this.committedTagState.set(this.key(task), { task, tagged });
  }

  /** Stops our write-lag bridge from masking a later index or external publication. */
  private reconcileCommittedTagState(settled?: TaskIndexSettledEvent): void {
    if (settled) {
      const settledPaths = new Set(settled.files.map(({ path }) => path));
      for (const [key, pending] of this.committedTagState) {
        if (settledPaths.has(pending.task.ref.filePath)) this.committedTagState.delete(key);
      }
    }
    for (const task of this.application.queries.list()) {
      const key = this.key(task);
      const pending = this.committedTagState.get(key);
      if (pending && task.tags.includes(NEXT_ACTION_TAG) === pending.tagged) {
        this.committedTagState.delete(key);
      }
    }
  }

  private key(task: TaskSnapshot): string {
    return `${task.ref.filePath}\u0000${String(task.ref.line)}`;
  }

  private async serialize<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.replacementTails.get(projectPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.replacementTails.set(projectPath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.replacementTails.get(projectPath) === tail) {
        this.replacementTails.delete(projectPath);
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
