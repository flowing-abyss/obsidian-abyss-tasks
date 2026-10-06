import type { TaskSnapshot } from '../tasks';

export function todayTaskCategory(
  task: Pick<TaskSnapshot, 'planning'>,
  today: string,
): 'today' | 'overdue' | undefined {
  if (task.planning.due !== undefined && task.planning.due < today) return 'overdue';
  if (task.planning.due?.toString() === today || task.planning.scheduled?.toString() === today)
    return 'today';
  return undefined;
}

export function taskListDate(
  task: Pick<TaskSnapshot, 'planning'>,
  todayListDate?: string,
): string | undefined {
  if (todayListDate !== undefined && todayTaskCategory(task, todayListDate) === 'today') {
    return todayListDate;
  }
  return task.planning.due ?? task.planning.scheduled ?? task.planning.start;
}
