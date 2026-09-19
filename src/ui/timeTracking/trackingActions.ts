import { Notice } from 'obsidian';
import type {
  TaskApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskNodeRef,
  TimeEntryRef,
  TimeEntryRemovalRecovery,
} from '../../tasks';
import { SHORT_ENTRY_NOTICE } from '../taskCommandResult';

/** The four writes every tracking surface shares, each already reported when it fails. */
export interface TrackingActions {
  start(target: TaskNodeRef): Promise<void>;
  pause(): Promise<void>;
  remove(entry: TimeEntryRef): Promise<TimeEntryRemovalRecovery | undefined>;
  /** Reports its own failure, and hands the outcome back for the surface that offered the undo. */
  restore(recovery: TimeEntryRemovalRecovery): Promise<TaskCommandResult>;
}

/** A rejected command leaves the note in a state nobody observed, so it reports as such. */
const REPOSITORY_FAILURE: TaskCommandResult = {
  type: 'io-error',
  cause: 'repository-error',
  contentState: 'unknown',
};

function discardedShortEntry(result: TaskCommandResult): boolean {
  if (result.type !== 'ok') return false;
  const outcome = result.outcome;
  if (outcome.type !== 'task' && outcome.type !== 'stopped') return false;
  return outcome.discardedShortEntry === true;
}

function removalRecovery(result: TaskCommandResult): TimeEntryRemovalRecovery | undefined {
  if (result.type !== 'ok' || result.outcome.type !== 'task') return undefined;
  return result.outcome.timeEntryRemovalRecovery;
}

/**
 * The presentation failure boundary for time tracking. Every command is awaited here, every
 * rejection becomes a reportable write failure rather than an unhandled promise, and every
 * non-ok result reaches `report`, which call sites bind to the shared command-result presentation.
 */
export function createTrackingActions(
  tasks: TaskApplicationApi,
  report: (result: TaskCommandResult) => void,
): TrackingActions {
  const run = async (command: TaskCommand): Promise<TaskCommandResult> => {
    const result = await tasks.execute(command).catch((error: unknown) => {
      console.error('[abyss-tasks] Could not complete a time tracking command', error);
      return REPOSITORY_FAILURE;
    });
    if (result.type !== 'ok') report(result);
    else if (discardedShortEntry(result)) new Notice(SHORT_ENTRY_NOTICE);
    return result;
  };

  return {
    async start(target) {
      await run({ type: 'start-tracking', parent: target });
    },
    async pause() {
      await run({ type: 'stop-tracking' });
    },
    async remove(entry) {
      return removalRecovery(await run({ type: 'delete-time-entry', entry }));
    },
    async restore(recovery) {
      return run({ type: 'restore-time-entry', ...recovery });
    },
  };
}
