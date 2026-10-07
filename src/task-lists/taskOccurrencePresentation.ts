import type { LocalDate, TaskDateRole, TaskOccurrenceCompletion } from '../tasks';

export interface TaskOccurrencePresentation {
  readonly kind: 'node' | 'today' | 'daily';
  readonly displayDate?: LocalDate;
  readonly dateRoles?: readonly TaskDateRole[];
  readonly interval?: { readonly start: LocalDate; readonly due: LocalDate };
  readonly completion: TaskOccurrenceCompletion;
}
