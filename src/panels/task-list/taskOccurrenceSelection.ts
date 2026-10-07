import type { LocalDate, TaskOccurrenceCompletion } from '../../tasks';

/** Inclusive positions in the header-free task order. */
export interface TaskOrderSpan {
  readonly from: number;
  readonly to: number;
}

export type TaskOccurrenceRange =
  | {
      readonly kind: 'dates';
      readonly taskKey: string;
      readonly occurrenceKind: 'today' | 'daily';
      readonly groupKey: string;
      readonly from: LocalDate;
      readonly to: LocalDate;
    }
  | { readonly kind: 'group'; readonly taskKey: string; readonly groupKey: string };

export interface TaskSelectionSpans {
  readonly spans: readonly TaskOrderSpan[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface TaskSelectedValue<T> {
  readonly taskKey: string;
  readonly task: T;
  readonly completion: TaskOccurrenceCompletion;
}
