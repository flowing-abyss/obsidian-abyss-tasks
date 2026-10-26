import { localDate, taskTodayOccurrence, type LocalDate, type TaskSnapshot } from '../tasks';

type TodayTask = Pick<TaskSnapshot, 'planning' | 'status'>;

export function todayTaskOccurrence(
  task: TodayTask,
  today: LocalDate,
): ReturnType<typeof taskTodayOccurrence> {
  if (task.status === 'done' || task.status === 'cancelled') {
    const date = task.status === 'done' ? task.planning.completion : task.planning.cancelled;
    return date === today
      ? { category: 'today', displayDate: today, completion: { kind: 'allowed' } }
      : undefined;
  }
  return taskTodayOccurrence(task.planning, today);
}

export function todayTaskCategory(task: TodayTask, today: string): 'today' | 'overdue' | undefined {
  return todayTaskOccurrence(task, localDate(today))?.category;
}

export function taskListDate(task: TodayTask, todayListDate?: string): string | undefined {
  if (todayListDate !== undefined && todayTaskCategory(task, todayListDate) === 'today') {
    return todayListDate;
  }
  return task.planning.due ?? task.planning.scheduled ?? task.planning.start;
}
