import type {
  TaskInputCandidate,
  TaskInputRange,
  TaskInputReference,
} from '../domain/taskInputTypes';
import type { RecurrenceInputParser } from './RecurrenceInputParser';
export interface TaskInputRecognizerRequest {
  readonly pairingTransparentRanges?: readonly TaskInputRange[];
  readonly text: string;
  readonly reference: TaskInputReference;
  readonly protectedRanges: readonly TaskInputRange[];
}
export interface TaskInputRecognizer {
  recognize(request: TaskInputRecognizerRequest): readonly TaskInputCandidate[];
}
export interface TaskInputServices {
  readonly recurrence?: RecurrenceInputParser;
  readonly recognizer: TaskInputRecognizer;
  readonly readReference: () => TaskInputReference;
}
