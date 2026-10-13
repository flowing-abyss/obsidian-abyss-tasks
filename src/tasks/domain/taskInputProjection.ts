import { sameTag } from '../../markdown/tagSyntax';
import { shiftLocalDate } from './localDateMath';
import { currentInputBinding, inputRangesOverlap, validInputRange } from './taskInputGuards';
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
  TaskInputRange,
  TaskInputReference,
} from './taskInputTypes';
import { parseTaskLineSourceModel } from './taskLineSourceModel';
import type { TaskPlanning } from './types';

export interface TaskInputProjection {
  readonly revision: number;
  readonly markdownBody: string;
  /** A lowercase word following a fully consumed, initially uppercase natural prefix. */
  readonly capitalizationTarget?: {
    readonly sourceRange: TaskInputRange;
    readonly bodyOffset: number;
  };
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
type ContextProjectionInput = Omit<ProjectionInput, 'reference' | 'candidates'>;
type ProjectionSource =
  | (ProjectionInput & { readonly mode: 'recognized' })
  | (ContextProjectionInput & { readonly mode: 'context'; readonly candidates: readonly never[] });
type InputPlanning = Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>;
interface Decision {
  readonly input: ProjectionSource;
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
  input: ProjectionSource,
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
  input: ProjectionSource,
  suppressed: readonly TaskInputBinding[],
): InputPlanning {
  const result = { ...input.sourcePlanning };
  for (const role of ['due', 'scheduled', 'start', 'time'] as const)
    if (input.inspection.carriers.some((carrier) => carrier.role === role)) delete result[role];
  for (const carrier of input.inspection.carriers) {
    if (carrier.value === undefined) continue;
    const removed = suppressed.some(
      (binding) =>
        binding.role === carrier.role &&
        binding.ranges.some((range) => inputRangesOverlap(range, carrier.range)),
    );
    if (!removed) Object.assign(result, { [carrier.role]: carrier.value });
  }
  return result;
}
function isPlanningPoint(candidate: TaskInputCandidate): boolean {
  return candidate.status === 'point' || candidate.status === 'partial';
}
function hasActiveExplicitDay(
  input: ProjectionSource,
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
function decisionFor(input: ProjectionSource): Decision {
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
    active.some((candidate) => candidate.status === 'range' || candidate.reason === 'multiple');
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
function eligibleManualBinding(decision: Decision, binding: TaskInputBinding): boolean {
  const { state, inspection } = decision.input;
  if (!currentInputBinding(state.raw, state.revision, binding)) return false;
  if (
    binding.ranges.some((range) =>
      inspection.protectedRanges.some((protectedRange) =>
        inputRangesOverlap(range, protectedRange),
      ),
    )
  )
    return false;
  return decision.candidates.some(
    (candidate) =>
      candidate.status === 'point' &&
      candidate.date !== undefined &&
      !candidateSuppressed(decision.suppressed, candidate, 'due') &&
      JSON.stringify(candidate.dateRanges) === JSON.stringify(binding.dateRanges),
  );
}
function useManualDay(decision: Decision, role: TaskInputDateRole): boolean {
  const { state } = decision.input,
    manual = state.manual[role];
  if (manual === undefined) return false;
  decision.initial = { ...decision.initial, [role]: { type: 'set', value: manual.value } };
  if (manual.binding !== undefined && eligibleManualBinding(decision, manual.binding)) {
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
function hasTimeDay(decision: Decision): boolean {
  const { state } = decision.input;
  return (
    decision.initial.due?.type === 'set' ||
    decision.days.length > 0 ||
    decision.hasExplicitDay ||
    state.manual.scheduled !== undefined ||
    state.manual.start !== undefined
  );
}
function inferTimeDay(decision: Decision, clock: TaskInputCandidate): void {
  if (decision.input.mode === 'context' || hasTimeDay(decision) || clock.time === undefined) return;
  const { state, reference } = decision.input;
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
function inactiveCanonicalRanges(
  state: TaskInputState,
  inspection: TaskInputInspection,
): TaskInputRange[] {
  const sameRange = (a: TaskInputRange, b: TaskInputRange): boolean =>
    a.from === b.from && a.to === b.to;
  const planning = inspection.carriers
    .filter(
      (carrier) =>
        carrier.value !== undefined &&
        state.suppressed.some(
          (binding) =>
            binding.role === carrier.role &&
            currentInputBinding(state.raw, state.revision, binding) &&
            binding.ranges.some((range) => sameRange(range, carrier.range)),
        ),
    )
    .map((carrier) => carrier.range);
  const tags = inspection.tags
    .filter((tag) =>
      state.suppressedTags.some(
        (binding) =>
          sameTag(binding.tag, tag.value) &&
          currentInputBinding(state.raw, state.revision, binding) &&
          binding.ranges.some((range) => sameRange(range, tag.range)),
      ),
    )
    .map((tag) => tag.range);
  return [...planning, ...tags];
}
interface InputBody {
  readonly markdownBody: string;
  readonly retained: ReadonlyArray<{
    readonly sourceRange: TaskInputRange;
    readonly bodyOffset: number;
  }>;
}
/** All intervals refer to the original UTF-16 source, including bounded separator ownership. */
function buildInputBody(raw: string, ranges: readonly TaskInputRange[]): InputBody {
  const space = (value: string | undefined): boolean => value === ' ' || value === '\t';
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges
    .filter((item) => validInputRange(raw, item))
    .sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      (range.from <= last.to || (range.from === last.to + 1 && space(raw[last.to])))
    )
      last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  const owned = merged
    .map((range) => {
      let { from, to } = range;
      if (from === 0 && space(raw[to])) to++;
      else if (to === raw.length && space(raw[from - 1])) from--;
      else if (space(raw[from - 1]) && space(raw[to])) to++;
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);
  let cursor = 0,
    body = '';
  const retained: Array<{ sourceRange: TaskInputRange; bodyOffset: number }> = [];
  const retain = (from: number, to: number): void => {
    if (to <= from) return;
    retained.push({ sourceRange: { from, to }, bodyOffset: body.length });
    body += raw.slice(from, to);
  };
  for (const range of owned) {
    retain(cursor, range.from);
    cursor = Math.max(cursor, range.to);
  }
  retain(cursor, raw.length);
  return { markdownBody: body, retained };
}
export function taskInputPreflightBody(
  state: TaskInputState,
  inspection: TaskInputInspection,
): string {
  return buildInputBody(state.raw, inactiveCanonicalRanges(state, inspection)).markdownBody;
}
function hasConsumedNaturalPrefix(
  raw: string,
  targetFrom: number,
  naturalRanges: readonly TaskInputRange[],
): boolean {
  if (!/^\s*\p{Lu}/u.test(raw)) return false;
  // Canonical/tag deletion and separator ownership cannot supply natural-prefix evidence.
  for (let offset = 0; offset < targetFrom; offset++)
    if (
      !/\s/u.test(raw.charAt(offset)) &&
      !naturalRanges.some((range) => range.from <= offset && offset < range.to)
    )
      return false;
  return true;
}
function capitalizationTarget(
  decision: Decision,
  body: InputBody,
  naturalRanges: readonly TaskInputRange[],
): TaskInputProjection['capitalizationTarget'] {
  const { state, inspection } = decision.input;
  const leading = /^(?!\s*\S*[\p{Lu}\p{Lt}])(\s*)(\p{L}[\p{L}\p{M}]*)/u.exec(body.markdownBody);
  if (leading === null) return undefined;
  const word = leading[2];
  if (word === undefined || !/^\p{Ll}[\p{Ll}\p{M}]*$/u.test(word)) return undefined;
  const bodyOffset = leading[1]?.length ?? 0;
  const span = body.retained.find(
    (item) =>
      item.bodyOffset <= bodyOffset &&
      item.bodyOffset + item.sourceRange.to - item.sourceRange.from >= bodyOffset + word.length,
  );
  if (span === undefined) return undefined;
  const from = span.sourceRange.from + bodyOffset - span.bodyOffset;
  const sourceRange = { from, to: from + word.length };
  const protectedOrTemporal = [
    ...inspection.protectedRanges,
    ...decision.candidates.flatMap((candidate) => candidate.ranges),
  ];
  if (protectedOrTemporal.some((range) => inputRangesOverlap(range, sourceRange))) return undefined;
  if (!hasConsumedNaturalPrefix(state.raw, from, naturalRanges)) return undefined;
  return { sourceRange, bodyOffset };
}
function projectedBody(
  decision: Decision,
): Pick<TaskInputProjection, 'markdownBody' | 'capitalizationTarget'> {
  const naturalRanges = decision.consumed
    .filter((binding) => bindingFullyRepresented(decision, binding))
    .flatMap((binding) => binding.ranges);
  const body = buildInputBody(decision.input.state.raw, [
    ...inactiveCanonicalRanges(decision.input.state, decision.input.inspection),
    ...naturalRanges,
  ]);
  const target = capitalizationTarget(decision, body, naturalRanges);
  return {
    markdownBody: body.markdownBody,
    ...(target === undefined ? {} : { capitalizationTarget: target }),
  };
}
function hasAuthoredTitle(raw: string): boolean {
  const title = parseTaskLineSourceModel(`- [ ] ${raw}`)?.markdownTitle ?? '';
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(title);
}
function projectInput(input: ProjectionSource): TaskInputProjection {
  const decision = decisionFor(input);
  for (const role of ['due', 'scheduled', 'start'] as const) assignDay(decision, role);
  assignTime(decision);
  if (input.contextInitial?.duration !== undefined)
    decision.initial = { ...decision.initial, duration: input.contextInitial.duration };
  const body = projectedBody(decision);
  return {
    revision: input.state.revision,
    ...body,
    initial: decision.initial,
    bindings: decision.bindings,
    candidates: decision.candidates,
    ambiguity: decision.ambiguity,
    hasAuthoredTitle: hasAuthoredTitle(body.markdownBody),
  };
}

export function projectTaskInput(input: ProjectionInput): TaskInputProjection {
  return projectInput({ ...input, mode: 'recognized' });
}

/** Known canonical/manual context has no natural candidates or recognition reference. */
export function projectTaskInputContext(input: ContextProjectionInput): TaskInputProjection {
  return projectInput({ ...input, mode: 'context', candidates: [] });
}
