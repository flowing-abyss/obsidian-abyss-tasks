import { NEXT_ACTION_TAG } from '../../projects/NextActionService';
import type { TaskSnapshot } from '../../tasks';

/** Presentation-only state; Next Action is changed exclusively through a context menu. */
export function isNextAction(task: TaskSnapshot): boolean {
  return task.tags.includes(NEXT_ACTION_TAG);
}
