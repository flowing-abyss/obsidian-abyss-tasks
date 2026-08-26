import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../tasks';

export const NEXT_ACTION_TAG = '#task/next_action';

export interface NextActionConflict {
  readonly type: 'integrity-conflict';
  readonly projectPath: string;
  readonly tag: typeof NEXT_ACTION_TAG;
  readonly tasks: readonly TaskSnapshot[];
}

function sameTask(left: TaskSnapshot, right: TaskSnapshot): boolean {
  return left.ref.filePath === right.ref.filePath && left.ref.line === right.ref.line;
}

export class NextActionService {
  constructor(private readonly application: TaskApplicationApi) {}

  async set(
    projectPath: string,
    task: TaskSnapshot,
  ): Promise<TaskCommandResult | NextActionConflict> {
    const tagged = this.application.queries
      .list({ tag: NEXT_ACTION_TAG })
      .filter((candidate) => !sameTask(candidate, task));
    if (tagged.length > 1) {
      return { type: 'integrity-conflict', projectPath, tag: NEXT_ACTION_TAG, tasks: tagged };
    }
    if (
      tagged.length === 1 &&
      tagged[0]!.source.filePath !== projectPath &&
      tagged[0]!.source.filePath !== task.source.filePath
    ) {
      return { type: 'integrity-conflict', projectPath, tag: NEXT_ACTION_TAG, tasks: tagged };
    }
    if (!this.application.applyRootTagChanges) return this.unavailable();
    return await this.application.applyRootTagChanges({
      primary: task.ref,
      changes: [
        { task, tags: { add: [NEXT_ACTION_TAG] } },
        ...tagged.map((previous) => ({
          task: previous,
          tags: { remove: [NEXT_ACTION_TAG] },
        })),
      ],
    });
  }

  async clear(task: TaskSnapshot): Promise<TaskCommandResult> {
    if (!this.application.applyRootTagChanges) return this.unavailable();
    return await this.application.applyRootTagChanges({
      primary: task.ref,
      changes: [{ task, tags: { remove: [NEXT_ACTION_TAG] } }],
    });
  }

  private unavailable(): TaskCommandResult {
    return {
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'next-action' }],
    };
  }
}
