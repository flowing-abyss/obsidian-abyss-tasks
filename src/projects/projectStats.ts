import type { TaskSnapshot, TrackedTotal } from '../tasks';
import type { ProjectStats } from './types';

export function computeStats(tasks: readonly TaskSnapshot[], tracked: TrackedTotal): ProjectStats {
  let done = 0,
    cancelled = 0,
    inProgress = 0;
  for (const task of tasks) {
    if (task.status === 'done') done++;
    else if (task.status === 'cancelled') cancelled++;
    else if (task.status === 'in-progress') inProgress++;
  }
  return { total: tasks.length, done, cancelled, inProgress, tracked };
}
