import { sameTag } from '../../markdown/tagSyntax';
import { shiftLocalDate } from './localDateMath';
import {
  currentInputBinding,
  inputRangesOverlap,
  removeOwnedInputRange,
  validInputRange,
} from './taskInputGuards';
import {
  inputBinding,
  type TaskInputBinding,
  type TaskInputDateRole,
  type TaskInputState,
} from './taskInputState';
import type {
  TaskInputCandidate,
  TaskInputInitial,
  TaskInputInspection,
  TaskInputPlanningRole,
  TaskInputReference,
} from './taskInputTypes';
import { parseTaskLineSourceModel } from './taskLineSourceModel';
import type { TaskPlanning } from './types';

export interface TaskInputProjection {
  readonly revision: number;
  readonly markdownBody: string;
  readonly initial: TaskInputInitial;
  readonly bindings: readonly TaskInputBinding[];
  readonly candidates: readonly TaskInputCandidate[];
  readonly ambiguity: boolean;
  readonly hasAuthoredTitle: boolean;
}
interface ProjectionInput {
  readonly state: TaskInputState;
  readonly reference: TaskInputReference;
  readonly candidates: readonly TaskInputCandidate[];
  readonly inspection: TaskInputInspection;
  readonly sourcePlanning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
  readonly contextInitial?: TaskInputInitial;
}
type InputPlanning = Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
interface Decision {
  readonly input: ProjectionInput;
  readonly suppressed: readonly TaskInputBinding[];
  readonly candidates: readonly TaskInputCandidate[];
  readonly days: readonly TaskInputCandidate[];
  readonly clocks: readonly TaskInputCandidate[];
  readonly ambiguity: boolean;
  readonly explicit: InputPlanning;
  readonly hasExplicitDay: boolean;
  readonly bindings: TaskInputBinding[];
  readonly consumed: TaskInputBinding[];
  initial: TaskInputInitial;
}
export function taskInputPreflightInitial(
  state: TaskInputState,
  contextInitial?: TaskInputInitial,
): TaskInputInitial {
  const context = { ...contextInitial };
  delete context.due;
  delete context.scheduled;
  delete context.start;
  delete context.time;
  delete context.duration;
  if (state.removedTags.length === 0) return context;
  const tags = context.tags;
  const additions = tags?.add?.filter(
    (tag) => !state.removedTags.some((removed) => sameTag(tag, removed)),
  );
  const removals = state.removedTags.filter(
    (tag) => !(tags?.remove?.some((old) => sameTag(tag, old)) ?? false),
  );
  return {
    ...context,
    tags: {
      ...tags,
      ...(additions === undefined ? {} : { add: additions }),
      remove: [...(tags?.remove ?? []), ...removals],
    },
  };
}
function candidateSuppressed(
  suppressed: readonly TaskInputBinding[],
  candidate: TaskInputCandidate,
  role: 'due' | 'time',
): boolean {
  return suppressed.some(
    (binding) =>
      (binding.role === role || (role === 'time' && binding.role === 'due')) &&
      binding.ranges.some((range) =>
        candidate.ranges.some((other) => inputRangesOverlap(range, other)),
      ),
  );
}
function activeCarrier(
  input: ProjectionInput,
  suppressed: readonly TaskInputBinding[],
  role: TaskInputPlanningRole,
): boolean {
  return input.inspection.carriers.some(
    (carrier) =>
      carrier.role === role &&
      carrier.value !== undefined &&
      !suppressed.some(
        (binding) =>
          binding.role === role &&
          binding.ranges.some((range) => inputRangesOverlap(range, carrier.range)),
      ),
  );
}
function explicitPlanning(
  input: ProjectionInput,
  suppressed: readonly TaskInputBinding[],
): InputPlanning {
  const result = { ...input.sourcePlanning };
  for (const carrier of input.inspection.carriers) {
    if (carrier.value === undefined) continue;
    const removed = suppressed.some(
      (binding) =>
        binding.role === carrier.role &&
        binding.ranges.some((range) => inputRangesOverlap(range, carrier.range)),
    );
    if (removed) delete result[carrier.role];
    else Object.assign(result, { [carrier.role]: carrier.value });
  }
  return result;
}
function competingDays(days: readonly TaskInputCandidate[]): boolean {
  return days.some((candidate, index) =>
    days.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        candidate.ranges.some((range) =>
          other.ranges.some((otherRange) => inputRangesOverlap(range, otherRange)),
        ),
    ),
  );
}
function isPlanningPoint(candidate: TaskInputCandidate): boolean {
  return candidate.status === 'point' || candidate.status === 'partial';
}
function hasActiveExplicitDay(
  input: ProjectionInput,
  suppressed: readonly TaskInputBinding[],
): boolean {
  const prefix = (['due', 'start', 'scheduled'] as const).some(
    (role) =>
      input.sourcePlanning[role] !== undefined && !input.state.clearedFallbacks.includes(role),
  );
  const raw = input.inspection.carriers.some(
    (carrier) =>
      carrier.role !== 'time' &&
      !suppressed.some(
        (binding) =>
          binding.role === carrier.role &&
          binding.ranges.some((range) => inputRangesOverlap(range, carrier.range)),
      ),
  );
  return prefix || raw;
}
function decisionFor(input: ProjectionInput): Decision {
  const { state } = input;
  const suppressed = state.suppressed.filter((binding) =>
    currentInputBinding(state.raw, state.revision, binding),
  );
  const candidates = input.candidates.filter(
    (candidate) =>
      candidate.ranges.length > 0 &&
      candidate.ranges.every((range) => validInputRange(state.raw, range)),
  );
  const active = candidates.filter(
    (candidate) => !candidateSuppressed(suppressed, candidate, 'due'),
  );
  const days = active.filter(
    (candidate) => candidate.date !== undefined && isPlanningPoint(candidate),
  );
  const clocks = active.filter(
    (candidate) =>
      candidate.time !== undefined &&
      isPlanningPoint(candidate) &&
      !candidateSuppressed(suppressed, candidate, 'time'),
  );
  const ambiguity =
    days.length > 1 ||
    clocks.length > 1 ||
    active.some((candidate) => candidate.status === 'range' || candidate.reason === 'multiple') ||
    competingDays(days);
  const hasExplicitDay = hasActiveExplicitDay(input, suppressed);
  return {
    input,
    suppressed,
    candidates,
    days,
    clocks,
    ambiguity,
    explicit: explicitPlanning(input, suppressed),
    hasExplicitDay,
    bindings: [],
    consumed: [],
    initial: taskInputPreflightInitial(state, input.contextInitial),
  };
}
function fallback(decision: Decision, role: TaskInputPlanningRole): void {
  const { state, contextInitial } = decision.input;
  if (state.clearedFallbacks.includes(role))
    decision.initial = { ...decision.initial, [role]: { type: 'clear' } };
  else if (contextInitial?.[role] !== undefined)
    decision.initial = { ...decision.initial, [role]: contextInitial[role] };
}
function useNaturalDay(decision: Decision): boolean {
  const day = decision.days[0];
  if (
    decision.hasExplicitDay ||
    decision.ambiguity ||
    decision.days.length !== 1 ||
    day?.date === undefined
  )
    return false;
  decision.initial = { ...decision.initial, due: { type: 'set', value: day.date } };
  const binding = inputBinding(decision.input.state, day, 'due');
  decision.bindings.push(binding);
  if (day.status === 'point') decision.consumed.push(binding);
  return true;
}
function useManualDay(decision: Decision, role: TaskInputDateRole): boolean {
  const { state } = decision.input,
    manual = state.manual[role];
  if (manual === undefined) return false;
  decision.initial = { ...decision.initial, [role]: { type: 'set', value: manual.value } };
  if (
    manual.binding !== undefined &&
    currentInputBinding(state.raw, state.revision, manual.binding)
  ) {
    decision.bindings.push(manual.binding);
    decision.consumed.push(manual.binding);
  }
  return true;
}
function explicitRoleActive(decision: Decision, role: TaskInputPlanningRole): boolean {
  return (
    decision.explicit[role] !== undefined &&
    (activeCarrier(decision.input, decision.suppressed, role) ||
      !decision.input.state.clearedFallbacks.includes(role))
  );
}
function assignDay(decision: Decision, role: TaskInputDateRole): void {
  if (useManualDay(decision, role)) return;
  if (explicitRoleActive(decision, role)) {
    decision.initial = {
      ...decision.initial,
      [role]: { type: 'set', value: decision.explicit[role] },
    };
    return;
  }
  if (role === 'due' && useNaturalDay(decision)) return;
  fallback(decision, role);
}
function inferTimeDay(decision: Decision, clock: TaskInputCandidate): void {
  const { state, reference } = decision.input;
  const blocked =
    decision.initial.due?.type === 'set' ||
    decision.days.length > 0 ||
    decision.hasExplicitDay ||
    state.manual.scheduled !== undefined ||
    state.manual.start !== undefined;
  if (blocked || clock.time === undefined) return;
  const due =
    clock.time > reference.localTime ? reference.localDate : shiftLocalDate(reference.localDate, 1);
  if (due === undefined) return;
  decision.initial = { ...decision.initial, due: { type: 'set', value: due } };
  decision.bindings.push(inputBinding(state, clock, 'due'));
}
function clockFullyRepresented(decision: Decision, clock: TaskInputCandidate): boolean {
  if (clock.date === undefined) return true;
  const manual = decision.input.state.manual.due;
  if (manual !== undefined && manual.binding === undefined) return false;
  return decision.bindings.some(
    (binding) =>
      binding.role === 'due' &&
      binding.ranges.some((range) =>
        clock.dateRanges.some((date) => range.from === date.from && range.to === date.to),
      ),
  );
}
function assignTime(decision: Decision): void {
  const explicitTime = decision.explicit.time;
  if (explicitTime !== undefined && explicitRoleActive(decision, 'time')) {
    decision.initial = {
      ...decision.initial,
      time: { type: 'set', value: explicitTime },
    };
    return;
  }
  const clock = decision.clocks[0];
  if (decision.ambiguity || decision.clocks.length !== 1 || clock?.time === undefined) {
    fallback(decision, 'time');
    return;
  }
  decision.initial = { ...decision.initial, time: { type: 'set', value: clock.time } };
  inferTimeDay(decision, clock);
  const binding = inputBinding(decision.input.state, clock, 'time');
  decision.bindings.push(binding);
  if (clock.status === 'point' && clockFullyRepresented(decision, clock))
    decision.consumed.push(binding);
}
function bindingFullyRepresented(decision: Decision, binding: TaskInputBinding): boolean {
  if (binding.timeRanges.length === 0) return true;
  const source = decision.candidates.find(
    (candidate) => JSON.stringify(candidate.ranges) === JSON.stringify(binding.ranges),
  );
  const time = decision.initial.time;
  return source?.time !== undefined && time?.type === 'set' && time.value === source.time;
}
function projectedBody(decision: Decision): string {
  const ranges = decision.consumed
    .filter((binding) => bindingFullyRepresented(decision, binding))
    .flatMap((binding) => binding.ranges)
    .filter(
      (range, index, all) =>
        all.findIndex((other) => other.from === range.from && other.to === range.to) === index,
    )
    .sort((a, b) => b.from - a.from);
  let raw = decision.input.state.raw;
  for (const range of ranges) raw = removeOwnedInputRange(raw, range);
  return raw;
}
function hasAuthoredTitle(raw: string): boolean {
  const title = parseTaskLineSourceModel(`- [ ] ${raw}`)?.markdownTitle ?? '';
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(title);
}
export function projectTaskInput(input: ProjectionInput): TaskInputProjection {
  const decision = decisionFor(input);
  for (const role of ['due', 'scheduled', 'start'] as const) assignDay(decision, role);
  assignTime(decision);
  if (input.contextInitial?.duration !== undefined)
    decision.initial = { ...decision.initial, duration: input.contextInitial.duration };
  const markdownBody = projectedBody(decision);
  return {
    revision: input.state.revision,
    markdownBody,
    initial: decision.initial,
    bindings: decision.bindings,
    candidates: decision.candidates,
    ambiguity: decision.ambiguity,
    hasAuthoredTitle: hasAuthoredTitle(markdownBody),
  };
}
