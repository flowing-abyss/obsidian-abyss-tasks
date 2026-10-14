import { shiftLocalDate } from './localDateMath';
import { firstRecurrenceDate, parseRecurrenceRule, recurrenceLabel } from './recurrence';
import type { TaskInputRecurrenceCandidate } from './recurrenceInputTypes';
import { inputRangesOverlap, inputTextBarriers, validInputRange } from './taskInputGuards';
import {
  recurrenceInputBinding,
  type TaskInputBinding,
  type TaskInputState,
} from './taskInputState';
import type {
  TaskInputCandidate,
  TaskInputInitial,
  TaskInputInspection,
  TaskInputReference,
} from './taskInputTypes';
import type { LocalTime } from './types';

interface RecurrenceProjectionInput {
  readonly state: TaskInputState;
  readonly inspection: TaskInputInspection;
  readonly suppressed: readonly TaskInputBinding[];
  readonly recurrences: readonly TaskInputRecurrenceCandidate[];
  readonly candidates: readonly TaskInputCandidate[];
  readonly time?: LocalTime;
  readonly ambiguity: boolean;
  readonly initial: TaskInputInitial;
  readonly contextInitial?: TaskInputInitial;
  readonly sourceRecurrence?: string;
  readonly reference?: TaskInputReference;
}
interface InputRecurrenceProjection {
  readonly initial: TaskInputInitial;
  readonly bindings: readonly TaskInputBinding[];
  readonly recurrences: readonly TaskInputRecurrenceCandidate[];
  readonly recurrenceDateInferred: boolean;
}
function validRecurrences(
  input: RecurrenceProjectionInput,
): readonly TaskInputRecurrenceCandidate[] {
  const barriers = inputTextBarriers(input.state.raw, input.inspection.protectedRanges);
  return input.recurrences.filter(
    (candidate) =>
      candidate.ranges.length > 0 &&
      parseRecurrenceRule(candidate.rule).type === 'valid' &&
      candidate.ranges.every(
        (range) =>
          validInputRange(input.state.raw, range) &&
          !barriers.some((other) => inputRangesOverlap(range, other)),
      ) &&
      candidate.ranges.every((range, i) =>
        candidate.ranges.every((other, j) => i === j || !inputRangesOverlap(range, other)),
      ),
  );
}
function existingRecurrence(input: RecurrenceProjectionInput): TaskInputInitial['recurrence'] {
  const active = input.inspection.carriers.find(
    (carrier) =>
      carrier.role === 'recurrence' &&
      carrier.value !== undefined &&
      !input.suppressed.some(
        (binding) =>
          binding.role === 'recurrence' &&
          binding.ranges.some((range) => inputRangesOverlap(range, carrier.range)),
      ),
  );
  if (active?.value !== undefined) return { type: 'set', value: active.value };
  if (input.state.clearedFallbacks.includes('recurrence')) return { type: 'clear' };
  if (input.sourceRecurrence !== undefined) return { type: 'set', value: input.sourceRecurrence };
  return input.contextInitial?.recurrence;
}
function sameClause(raw: string, a: TaskInputRecurrenceCandidate, b: TaskInputCandidate): boolean {
  return a.ranges.some((left) =>
    b.ranges.some((right) => {
      const from = Math.min(left.to, right.to),
        to = Math.max(left.from, right.from);
      return !/[.!?;\n]/u.test(raw.slice(from, to));
    }),
  );
}
function contextRecurrenceInitial(
  input: RecurrenceProjectionInput,
  existing: TaskInputInitial['recurrence'],
): TaskInputInitial {
  // Source carriers already survive in Markdown and need no redundant patch.
  if (
    existing === undefined ||
    (existing.type === 'set' && input.sourceRecurrence === existing.value)
  )
    return input.initial;
  return { ...input.initial, recurrence: existing };
}
function activeNaturalRecurrence(
  input: RecurrenceProjectionInput,
  recurrences: readonly TaskInputRecurrenceCandidate[],
  existing: TaskInputInitial['recurrence'],
): TaskInputRecurrenceCandidate | undefined {
  if (
    existing?.type === 'set' ||
    input.contextInitial?.recurrence?.type === 'clear' ||
    recurrences.length !== 1
  )
    return undefined;
  const candidate = recurrences[0];
  if (
    candidate === undefined ||
    input.suppressed.some(
      (binding) =>
        binding.role === 'recurrence' &&
        binding.ranges.some((range) =>
          candidate.ranges.some((other) => inputRangesOverlap(range, other)),
        ),
    )
  )
    return undefined;
  return candidate;
}
function canInferRecurrenceDay(
  input: RecurrenceProjectionInput,
  candidate: TaskInputRecurrenceCandidate,
): boolean {
  return (
    !input.ambiguity &&
    !input.state.clearedFallbacks.includes('due') &&
    !input.inspection.carriers.some(
      (carrier) => carrier.role !== 'time' && carrier.role !== 'recurrence',
    ) &&
    !input.candidates.some(
      (point) => sameClause(input.state.raw, candidate, point) && point.status !== 'point',
    )
  );
}
function inferredRecurrenceDay(
  input: RecurrenceProjectionInput,
  candidate: TaskInputRecurrenceCandidate,
): TaskInputInitial['due'] {
  const reference = input.reference;
  if (reference === undefined || !canInferRecurrenceDay(input, candidate)) return undefined;
  const clock = input.time;
  const lower =
    clock !== undefined && clock <= reference.localTime
      ? shiftLocalDate(reference.localDate, 1)
      : reference.localDate;
  const date = lower === undefined ? undefined : firstRecurrenceDate(candidate.rule, lower);
  return date === undefined ? undefined : { type: 'set', value: date };
}
/** Recurrence consumes source only when its date is represented by the same final request. */
export function projectInputRecurrence(
  input: RecurrenceProjectionInput,
): InputRecurrenceProjection {
  const recurrences = validRecurrences(input);
  const existing = existingRecurrence(input);
  const base: InputRecurrenceProjection = {
    initial: contextRecurrenceInitial(input, existing),
    bindings: [],
    recurrences,
    recurrenceDateInferred: false,
  };
  const candidate = activeNaturalRecurrence(input, recurrences, existing);
  if (candidate === undefined) return base;
  const initial = { ...base.initial };
  const representedDay = (['due', 'scheduled', 'start'] as const).some(
    (role) => initial[role]?.type === 'set',
  );
  if (!representedDay) {
    const due = inferredRecurrenceDay(input, candidate);
    if (due === undefined) return base;
    initial.due = due;
  }
  initial.recurrence = { type: 'set', value: recurrenceLabel(candidate.rule) };
  return {
    initial,
    bindings: [recurrenceInputBinding(input.state, candidate)],
    recurrences,
    recurrenceDateInferred: !representedDay,
  };
}
