import type { RecurrenceParseResult } from '../domain/recurrence';
import type { RecurrenceInputExtraction } from '../domain/recurrenceInputTypes';
import type { TaskInputRange } from '../domain/taskInputTypes';

export interface RecurrenceInputParser {
  parse(text: string): RecurrenceParseResult;
  extract(request: {
    readonly text: string;
    readonly protectedRanges: readonly TaskInputRange[];
  }): RecurrenceInputExtraction;
}
