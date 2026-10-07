import type { LocalDate, TaskPlanning } from './types';

export type TaskDateRole = 'start' | 'scheduled' | 'due';
export interface TaskOccupiedPoint {
  readonly date: LocalDate;
  readonly roles: readonly TaskDateRole[];
}
export type TaskOccupiedDates =
  | { readonly kind: 'interval'; readonly start: LocalDate; readonly due: LocalDate }
  | { readonly kind: 'points'; readonly points: readonly TaskOccupiedPoint[] };
export interface TaskTodayOccurrence {
  readonly category: 'today' | 'overdue';
  readonly displayDate: LocalDate;
  readonly completion: TaskOccurrenceCompletion;
}
export type TaskOccurrenceCompletion =
  { readonly kind: 'allowed' } | { readonly kind: 'continuation'; readonly due: LocalDate };

export function taskOccupiedDates(planning: TaskPlanning): TaskOccupiedDates {
  if (planning.start !== undefined && planning.due !== undefined && planning.start <= planning.due)
    return { kind: 'interval', start: planning.start, due: planning.due };
  const points = new Map<LocalDate, TaskDateRole[]>();
  for (const role of ['start', 'scheduled', 'due'] as const) {
    const date = planning[role];
    if (date === undefined) continue;
    const roles = points.get(date) ?? [];
    roles.push(role);
    points.set(date, roles);
  }
  return {
    kind: 'points',
    points: [...points]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, roles]) => ({ date, roles })),
  };
}

export function taskOccurrenceCompletion(
  planning: TaskPlanning,
  displayDate?: LocalDate,
): TaskOccurrenceCompletion {
  if (
    displayDate !== undefined &&
    planning.start !== undefined &&
    planning.due !== undefined &&
    planning.start <= displayDate &&
    displayDate < planning.due
  )
    return { kind: 'continuation', due: planning.due };
  return { kind: 'allowed' };
}

export function taskTodayOccurrence(
  planning: TaskPlanning,
  today: LocalDate,
): TaskTodayOccurrence | undefined {
  const occupied = taskOccupiedDates(planning);
  if (occupied.kind === 'interval' && occupied.start <= today && today <= occupied.due)
    return {
      category: 'today',
      displayDate: today,
      completion: taskOccurrenceCompletion(planning, today),
    };
  if (planning.due !== undefined && planning.due < today)
    return { category: 'overdue', displayDate: planning.due, completion: { kind: 'allowed' } };
  if (occupied.kind === 'points' && occupied.points.some(({ date }) => date === today))
    return { category: 'today', displayDate: today, completion: { kind: 'allowed' } };
  return undefined;
}

export function taskHasFutureDate(planning: TaskPlanning, today: LocalDate): boolean {
  const occupied = taskOccupiedDates(planning);
  return occupied.kind === 'interval'
    ? occupied.due > today
    : occupied.points.some(({ date }) => date > today);
}
