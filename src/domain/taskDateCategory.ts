import type { TaskSnapshot } from '../tasks';

/**
 * Mutually-exclusive date category for a task relative to today.
 *
 * Priority rule for `relevantDate` when the task carries multiple dates:
 *   due → scheduled → start
 *
 * `completed` and `cancelled` are terminal — done/cancelled tasks are never
 * classified as overdue regardless of their dates.
 * `noDate` means no relevant date is present; this is distinct from overdue.
 */
export type TaskDateCategory =
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'noDate'
  | 'completed'
  | 'cancelled';

export function getTaskDateCategory(task: TaskSnapshot, today: string): TaskDateCategory {
  if (task.status === 'done') return 'completed';
  if (task.status === 'cancelled') return 'cancelled';

  const relevantDate = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
  if (!relevantDate) return 'noDate';
  if (relevantDate < today) return 'overdue';
  if (relevantDate === today) return 'today';
  return 'upcoming';
}
