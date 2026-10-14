import type { TaskInputRange } from './taskInputTypes';

export interface TaskInputRecurrenceCandidate {
  readonly ranges: readonly TaskInputRange[];
  readonly rule: string;
}
export interface RecurrenceInputExtraction {
  readonly candidates: readonly TaskInputRecurrenceCandidate[];
  /** Protection of valid and unsupported source grants no removal authority. */
  readonly protectedRanges: readonly TaskInputRange[];
}
