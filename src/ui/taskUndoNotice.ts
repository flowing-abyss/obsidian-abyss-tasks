import type { TaskCommand, TaskCommandResult } from '../tasks';

/** Recovery is derived only from the committed mutation's exact source evidence. */
export function taskRemovalInverse(result: TaskCommandResult): TaskCommand | undefined {
  if (result.type !== 'ok' || !result.changed) return undefined;
  const { outcome } = result;
  if (outcome.type === 'task' && outcome.subtaskRemovalRecovery !== undefined)
    return { type: 'restore-subtask', ...outcome.subtaskRemovalRecovery };
  if (
    outcome.type === 'dependency' &&
    outcome.change === 'removed' &&
    outcome.removalRecovery !== undefined
  )
    return {
      type: 'restore-dependency',
      dependent: outcome.dependent.target,
      recovery: outcome.removalRecovery,
    };
  return undefined;
}
