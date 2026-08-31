import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../tasks';

export const NEXT_ACTION_TAG = '#task/next_action';

export interface NextActionConflict {
  readonly type: 'integrity-conflict';
  readonly projectPath: string;
  readonly tag: typeof NEXT_ACTION_TAG;
  readonly tasks: readonly TaskSnapshot[];
  readonly diagnostic: string;
}

function sameFile(left: TaskSnapshot, right: TaskSnapshot): boolean {
  return left.ref.filePath === right.ref.filePath;
}

function isOk(result: TaskCommandResult): boolean {
  return result.type === 'ok';
}

/**
 * Makes a cross-file replacement deliberately compensating. The root-tag command
 * remains responsible for its own CAS and same-file atomic write.
 */
export class NextActionReplacementCoordinator {
  constructor(private readonly application: TaskApplicationApi) {}

  async replace(
    target: TaskSnapshot,
    previous: readonly TaskSnapshot[],
    projectPath = target.source.filePath,
  ): Promise<TaskCommandResult | NextActionConflict> {
    if (!this.application.applyRootTagChanges) return this.unavailable();
    const local = previous.filter((task) => sameFile(task, target));
    const external = previous.filter((task) => !sameFile(task, target));
    const add = await this.application.applyRootTagChanges({
      primary: target.ref,
      changes: [
        { task: target, tags: { add: [NEXT_ACTION_TAG] } },
        ...local.map((task) => ({ task, tags: { remove: [NEXT_ACTION_TAG] } })),
      ],
    });
    if (!isOk(add)) return add;
    if (external.length === 0) return add;

    const cleared = [...local];
    for (const task of external) {
      const cleanup = await this.application.applyRootTagChanges({
        primary: task.ref,
        changes: [{ task, tags: { remove: [NEXT_ACTION_TAG] } }],
      });
      if (isOk(cleanup)) {
        cleared.push(task);
        continue;
      }
      return (await this.compensate(target, cleared, projectPath, previous)) ?? cleanup;
    }
    return add;
  }

  private async compensate(
    target: TaskSnapshot,
    cleared: readonly TaskSnapshot[],
    projectPath: string,
    previous: readonly TaskSnapshot[],
  ): Promise<NextActionConflict | undefined> {
    const targetFile = cleared.filter((task) => sameFile(task, target));
    const external = cleared.filter((task) => !sameFile(task, target));
    const targetRollback = await this.application.applyRootTagChanges!({
      primary: target.ref,
      changes: [
        { task: target, tags: { remove: [NEXT_ACTION_TAG] } },
        ...targetFile.map((task) => ({ task, tags: { add: [NEXT_ACTION_TAG] } })),
      ],
    });
    if (!isOk(targetRollback)) return this.integrityConflict(projectPath, target, previous);
    for (const task of external) {
      const restore = await this.application.applyRootTagChanges!({
        primary: task.ref,
        changes: [{ task, tags: { add: [NEXT_ACTION_TAG] } }],
      });
      if (!isOk(restore)) return this.integrityConflict(projectPath, target, previous);
    }
    return undefined;
  }

  private integrityConflict(
    projectPath: string,
    target: TaskSnapshot,
    previous: readonly TaskSnapshot[],
  ): NextActionConflict {
    const observed = this.application.queries.list({ tag: NEXT_ACTION_TAG });
    const expected = [target, ...previous];
    const tasks = observed.filter((candidate) =>
      expected.some(
        (known) =>
          known.ref.filePath === candidate.ref.filePath && known.ref.line === candidate.ref.line,
      ),
    );
    return {
      type: 'integrity-conflict',
      projectPath,
      tag: NEXT_ACTION_TAG,
      tasks,
      diagnostic: 'compensation could not be proven from the authoritative task state',
    };
  }

  private unavailable(): TaskCommandResult {
    return {
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'next-action' }],
    };
  }
}
