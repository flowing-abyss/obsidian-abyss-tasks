import { localDate, taskTodayOccurrence, type TaskSnapshot } from '../tasks';

export function todayTaskCategory(
  task: Pick<TaskSnapshot, 'planning'>,
  today: string,
): 'today' | 'overdue' | undefined {
  return taskTodayOccurrence(task.planning, localDate(today))?.category;
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
