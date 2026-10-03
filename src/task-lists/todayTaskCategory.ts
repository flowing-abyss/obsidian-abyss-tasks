import type { LocalDate, TaskSnapshot } from '../tasks';

export function todayTaskCategory(
  task: Pick<TaskSnapshot, 'planning'>,
  today: LocalDate,
): 'today' | 'overdue' | undefined {
  if (task.planning.due !== undefined && task.planning.due < today) return 'overdue';
  if (task.planning.due === today || task.planning.scheduled === today) return 'today';
  return undefined;
}
