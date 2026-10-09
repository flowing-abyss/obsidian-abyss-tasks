import { dayOf, type StatisticsCalendar } from './statisticsCalendar';
import type { StatisticsTask } from './types';

/** Source issues remain separate from absent dates; no period can be inferred for either. */
export function dateProblem(
  task: StatisticsTask,
  field: 'created' | 'completion' | 'due',
  calendar: StatisticsCalendar,
): 'missing' | 'invalid' | 'future' | undefined {
  if (task.dateIssues.some((issue) => issue.field === field)) return 'invalid';
  const value = task[field];
  if (value === undefined) return 'missing';
  if (field !== 'due' && dayOf(value) > calendar.todayDay) return 'future';
  return undefined;
}
