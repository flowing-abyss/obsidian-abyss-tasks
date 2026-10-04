import {
  BrowserTaskCancelled,
  BrowserTaskScheduleError,
  type BrowserTaskScheduler,
} from '../../browserTaskScheduler';
import type { CollectionStep, CollectionSteps } from '../../collectionSteps';
export type TaskOrganizationPhase =
  'context' | 'cursor' | 'projection' | 'outgoing-links' | 'organization' | 'scheduler' | 'cleanup';
export type TaskOrganizationFailureKind =
  'construction' | 'enqueue' | 'rejection' | 'clock' | 'guard' | 'step' | 'cleanup';
export class TaskOrganizationFailure extends Error {
  constructor(
    readonly phase: TaskOrganizationPhase,
    readonly kind: TaskOrganizationFailureKind,
    readonly cleanupFailed = false,
  ) {
    super('Task organization failed');
  }
}
export interface TaskOrganizationExecution {
  readonly signal: AbortSignal;
  readonly scheduler: Pick<BrowserTaskScheduler, 'now' | 'yield'>;
  readonly assertCurrent: () => void;
  readonly phase: 'outgoing-links' | 'organization';
  readonly budget: {
    readonly targetMs: number;
    readonly maxSteps: number;
    readonly clockCheckEvery: number;
  };
}
function assertCurrent(execution: TaskOrganizationExecution): void {
  if (execution.signal.aborted) throw new BrowserTaskCancelled();
  try {
    execution.assertCurrent();
  } catch {
    throw new TaskOrganizationFailure(execution.phase, 'guard');
  }
}
function readClock(execution: TaskOrganizationExecution): number {
  try {
    return execution.scheduler.now();
  } catch {
    throw new TaskOrganizationFailure(execution.phase, 'clock');
  }
}
async function handoff(execution: TaskOrganizationExecution, signal: AbortSignal): Promise<void> {
  assertCurrent(execution);
  try {
    await execution.scheduler.yield(signal);
  } catch (error) {
    if (execution.signal.aborted) throw new BrowserTaskCancelled();
    if (error instanceof BrowserTaskScheduleError)
      throw new TaskOrganizationFailure('scheduler', error.kind, error.cleanupFailed);
    throw new TaskOrganizationFailure('scheduler', 'rejection');
  }
  assertCurrent(execution);
}
function advance<T>(
  steps: CollectionSteps<T>,
  execution: TaskOrganizationExecution,
): IteratorResult<CollectionStep, T | undefined> {
  assertCurrent(execution);
  let next: IteratorResult<CollectionStep, T | undefined>;
  try {
    next = steps.next();
  } catch {
    throw new TaskOrganizationFailure(execution.phase, 'step');
  }
  assertCurrent(execution);
  return next;
}
async function runSteps<T>(
  steps: CollectionSteps<T>,
  execution: TaskOrganizationExecution,
  continuation: AbortSignal,
): Promise<T> {
  await handoff(execution, continuation);
  let start = readClock(execution),
    count = 0,
    cheap = 0;
  for (;;) {
    const next = advance(steps, execution);
    if (next.done === true) {
      if (next.value === undefined) throw new TaskOrganizationFailure(execution.phase, 'step');
      return next.value;
    }
    count++;
    cheap++;
    let expired = false;
    if (next.value === 'atom' || cheap >= execution.budget.clockCheckEvery) {
      expired = readClock(execution) - start >= execution.budget.targetMs;
      cheap = 0;
    }
    if (expired || count >= execution.budget.maxSteps) {
      await handoff(execution, continuation);
      start = readClock(execution);
      count = 0;
      cheap = 0;
    }
  }
}
function cleanup(actions: ReadonlyArray<() => void>): boolean {
  let failed = false;
  for (const action of actions) {
    try {
      action();
    } catch {
      failed = true;
    }
  }
  return failed;
}
export async function runTaskOrganization<T>(
  steps: CollectionSteps<T>,
  execution: TaskOrganizationExecution,
): Promise<T> {
  const continuation = new AbortController();
  const abort = (): void => {
    continuation.abort();
  };
  let failed = false,
    primary: unknown,
    result: T | undefined;
  execution.signal.addEventListener('abort', abort, { once: true });
  if (execution.signal.aborted) abort();
  try {
    result = await runSteps(steps, execution, continuation.signal);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    const cleanupFailed = cleanup([
      () => {
        steps.return(undefined);
      },
      () => {
        continuation.abort();
      },
      () => {
        execution.signal.removeEventListener('abort', abort);
      },
    ]);
    if (cleanupFailed) {
      if (!failed) {
        failed = true;
        primary = new TaskOrganizationFailure('cleanup', 'cleanup', true);
      } else if (primary instanceof TaskOrganizationFailure)
        primary = new TaskOrganizationFailure(primary.phase, primary.kind, true);
    }
  }
  if (failed) throw primary;
  if (result === undefined) throw new TaskOrganizationFailure(execution.phase, 'step');
  return result;
}
