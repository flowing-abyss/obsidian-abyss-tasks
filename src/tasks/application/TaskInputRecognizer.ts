import type {
  TaskInputCandidate,
  TaskInputRange,
  TaskInputReference,
} from '../domain/taskInputTypes';
export interface TaskInputRecognizerRequest {
  readonly text: string;
  readonly reference: TaskInputReference;
  readonly protectedRanges: readonly TaskInputRange[];
}
export interface TaskInputRecognizer {
  recognize(request: TaskInputRecognizerRequest): readonly TaskInputCandidate[];
}
export interface TaskInputServices {
  readonly recognizer: TaskInputRecognizer;
  readonly readReference: () => TaskInputReference;
}
