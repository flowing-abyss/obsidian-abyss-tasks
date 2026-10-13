import { sameTag } from '../../markdown/tagSyntax';
import { currentInputBinding, inputRangesOverlap, removeOwnedInputRange } from './taskInputGuards';
import { inspectTaskInput } from './taskInputInspection';
import type { TaskInputProjection } from './taskInputProjection';
import type {
  TaskInputCandidate,
  TaskInputInspection,
  TaskInputPlanningRole,
  TaskInputRange,
} from './taskInputTypes';
import type { LocalDate } from './types';
export interface TaskInputBinding {
  readonly ranges: readonly TaskInputRange[];
  readonly slices: readonly string[];
  readonly role: TaskInputPlanningRole;
  readonly revision: number;
  readonly dateRanges: readonly TaskInputRange[];
  readonly timeRanges: readonly TaskInputRange[];
}
export type TaskInputDateRole = Exclude<TaskInputPlanningRole, 'time'>;
export interface TaskInputManualDate {
  readonly value: LocalDate;
  // Present only for an accepted complete point; absence grants no text consumption.
  readonly binding?: TaskInputBinding;
}
export interface TaskInputState {
  readonly raw: string;
  readonly revision: number;
  readonly suppressed: readonly TaskInputBinding[];
  readonly clearedFallbacks: readonly TaskInputPlanningRole[];
  readonly manual: Readonly<Partial<Record<TaskInputDateRole, TaskInputManualDate>>>;
  readonly removedTags: readonly string[];
  readonly restore?: {
    readonly bindings: readonly TaskInputBinding[];
    readonly fallbacks: readonly TaskInputPlanningRole[];
    readonly revision: number;
  };
}
export type TaskInputAction =
  | { readonly type: 'dismiss'; readonly role: TaskInputPlanningRole }
  | { readonly type: 'dismiss-ambiguity' }
  | {
      readonly type: 'select-date';
      readonly role: TaskInputDateRole;
      readonly value: LocalDate;
      readonly candidate?: TaskInputCandidate;
    }
  | { readonly type: 'remove-tag'; readonly tag: string }
  | { readonly type: 'restore' };
export function createTaskInputState(raw = ''): TaskInputState {
  return { raw, revision: 0, suppressed: [], clearedFallbacks: [], manual: {}, removedTags: [] };
}
export function inputBinding(
  state: TaskInputState,
  candidate: TaskInputCandidate,
  role: TaskInputPlanningRole,
): TaskInputBinding {
  return {
    ranges: candidate.ranges,
    slices: candidate.ranges.map((r) => state.raw.slice(r.from, r.to)),
    role,
    revision: state.revision,
    dateRanges: candidate.dateRanges,
    timeRanges: candidate.timeRanges,
  };
}
function lexicalBoundary(raw: string, range: TaskInputRange): boolean {
  return (
    !/[\p{L}\p{N}_]/u.test(raw[range.from - 1] ?? '') && !/[\p{L}\p{N}_]/u.test(raw[range.to] ?? '')
  );
}
interface InputEdit {
  readonly old: TaskInputState;
  readonly raw: string;
  readonly prefix: number;
  readonly suffix: number;
  readonly enclosingOffset?: number;
}
function inputEdit(state: TaskInputState, raw: string): InputEdit {
  let prefix = 0;
  while (prefix < Math.min(raw.length, state.raw.length) && raw[prefix] === state.raw[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(raw.length, state.raw.length) - prefix &&
    raw[raw.length - 1 - suffix] === state.raw[state.raw.length - 1 - suffix]
  )
    suffix++;
  const enclosing = raw.indexOf(state.raw);
  const unique =
    state.raw.length > 0 && enclosing >= 0 && raw.indexOf(state.raw, enclosing + 1) < 0;
  return { old: state, raw, prefix, suffix, ...(unique ? { enclosingOffset: enclosing } : {}) };
}
function shiftedEditRange(edit: InputEdit, range: TaskInputRange): TaskInputRange | undefined {
  if (edit.enclosingOffset !== undefined)
    return { from: range.from + edit.enclosingOffset, to: range.to + edit.enclosingOffset };
  if (range.to <= edit.prefix) return range;
  if (range.from < edit.old.raw.length - edit.suffix) return undefined;
  const delta = edit.raw.length - edit.old.raw.length;
  return { from: range.from + delta, to: range.to + delta };
}
function rebaseRange(edit: InputEdit, range: TaskInputRange): TaskInputRange | undefined {
  const shifted = shiftedEditRange(edit, range);
  if (shifted === undefined || !lexicalBoundary(edit.raw, shifted)) return undefined;
  return edit.raw.slice(shifted.from, shifted.to) === edit.old.raw.slice(range.from, range.to)
    ? shifted
    : undefined;
}
function definedRange(range: TaskInputRange | undefined): range is TaskInputRange {
  return range !== undefined;
}
function rebaseBinding(
  edit: InputEdit,
  binding: TaskInputBinding,
  calendarOnly = false,
): TaskInputBinding | undefined {
  if (!currentInputBinding(edit.old.raw, edit.old.revision, binding)) return undefined;
  const dateRanges = binding.dateRanges.map((range) => rebaseRange(edit, range));
  const timeRanges = binding.timeRanges.map((range) => rebaseRange(edit, range));
  const ranges = binding.ranges.map((range) => rebaseRange(edit, range));
  const revision = edit.old.revision + 1;
  if (ranges.every(definedRange))
    return {
      ...binding,
      ranges,
      dateRanges: dateRanges.filter(definedRange),
      timeRanges: timeRanges.filter(definedRange),
      revision,
    };
  if (!calendarOnly || dateRanges.length === 0 || !dateRanges.every(definedRange)) return undefined;
  return {
    ...binding,
    ranges: dateRanges,
    slices: dateRanges.map((range) => edit.raw.slice(range.from, range.to)),
    dateRanges,
    timeRanges: [],
    revision,
  };
}
function descendantRanges(
  edit: InputEdit,
  binding: TaskInputBinding,
  from: number,
): TaskInputRange[] {
  const ranges: TaskInputRange[] = [];
  let cursor = from;
  for (const slice of binding.slices) {
    const start = edit.raw.indexOf(slice, cursor);
    if (start < 0 || start + slice.length > edit.raw.length - edit.suffix) return [];
    ranges.push({ from: start, to: start + slice.length });
    cursor = start + slice.length;
  }
  return ranges.every((range) => lexicalBoundary(edit.raw, range)) ? ranges : [];
}
function componentDescendants(
  binding: TaskInputBinding,
  ranges: readonly TaskInputRange[],
  components: readonly TaskInputRange[],
): TaskInputRange[] {
  return components
    .map(
      (range) =>
        ranges[binding.ranges.findIndex((old) => old.from === range.from && old.to === range.to)],
    )
    .filter(definedRange);
}
function uncertainDescendants(edit: InputEdit, binding: TaskInputBinding): TaskInputBinding[] {
  const result: TaskInputBinding[] = [];
  const first = binding.slices[0];
  if (first === undefined) return result;
  for (let from = edit.prefix; from < edit.raw.length - edit.suffix; from++) {
    if (!edit.raw.startsWith(first, from)) continue;
    const ranges = descendantRanges(edit, binding, from);
    if (ranges.length !== binding.ranges.length) continue;
    result.push({
      ...binding,
      ranges,
      dateRanges: componentDescendants(binding, ranges, binding.dateRanges),
      timeRanges: componentDescendants(binding, ranges, binding.timeRanges),
      revision: edit.old.revision + 1,
    });
  }
  return result;
}
function rebaseSuppressions(edit: InputEdit, uncertain: boolean): TaskInputBinding[] {
  return edit.old.suppressed.flatMap((binding) => {
    const mapped = rebaseBinding(edit, binding);
    const result = mapped === undefined ? [] : [mapped];
    return uncertain ? [...result, ...uncertainDescendants(edit, binding)] : result;
  });
}
function rebaseManual(edit: InputEdit): TaskInputState['manual'] {
  const result: Partial<Record<TaskInputDateRole, TaskInputManualDate>> = {};
  for (const role of ['due', 'scheduled', 'start'] as const) {
    const manual = edit.old.manual[role];
    if (manual === undefined) continue;
    const binding =
      manual.binding === undefined ? undefined : rebaseBinding(edit, manual.binding, true);
    result[role] = { value: manual.value, ...(binding === undefined ? {} : { binding }) };
  }
  return result;
}
function remainingTagRemovals(edit: InputEdit): string[] {
  const oldTags = inspectTaskInput(edit.old.raw).tags,
    newTags = inspectTaskInput(edit.raw).tags;
  return edit.old.removedTags.filter(
    (tag) =>
      !newTags.some(
        (occurrence) =>
          sameTag(tag, occurrence.value) &&
          !oldTags.some(
            (old) =>
              sameTag(tag, old.value) &&
              rebaseRange(edit, old.range)?.from === occurrence.range.from,
          ),
      ),
  );
}
function rebaseRestore(edit: InputEdit): TaskInputState['restore'] {
  const restore = edit.old.restore;
  if (restore === undefined) return undefined;
  const bindings = restore.bindings.map((binding) => rebaseBinding(edit, binding));
  if (!bindings.every((binding): binding is TaskInputBinding => binding !== undefined))
    return undefined;
  return { ...restore, bindings, revision: edit.old.revision + 1 };
}
export function editTaskInput(
  state: TaskInputState,
  raw: string,
  kind: 'input' | 'paste' | 'composition' | 'history' = 'input',
): TaskInputState {
  if (raw === state.raw) return state;
  const edit = inputEdit(state, raw),
    restore = rebaseRestore(edit);
  return {
    raw,
    revision: state.revision + 1,
    suppressed: rebaseSuppressions(edit, kind !== 'input'),
    clearedFallbacks: state.clearedFallbacks,
    manual: rebaseManual(edit),
    removedTags: remainingTagRemovals(edit),
    ...(restore === undefined ? {} : { restore }),
  };
}
function withoutRestore(state: TaskInputState): TaskInputState {
  const result = { ...state };
  delete result.restore;
  return result;
}
function restoreDismissal(state: TaskInputState): TaskInputState {
  const restored = state.restore;
  if (
    restored?.revision !== state.revision ||
    !restored.bindings.every((binding) => currentInputBinding(state.raw, state.revision, binding))
  )
    return state;
  const matches = (a: TaskInputBinding, b: TaskInputBinding): boolean =>
    a.role === b.role && JSON.stringify(a.ranges) === JSON.stringify(b.ranges);
  return {
    ...withoutRestore(state),
    suppressed: state.suppressed.filter(
      (binding) => !restored.bindings.some((old) => matches(binding, old)),
    ),
    clearedFallbacks: state.clearedFallbacks.filter((role) => !restored.fallbacks.includes(role)),
  };
}
function removeTag(
  state: TaskInputState,
  tag: string,
  inspection: TaskInputInspection,
): TaskInputState {
  let raw = state.raw;
  for (const { range } of inspection.tags
    .filter((occurrence) => sameTag(occurrence.value, tag))
    .sort((a, b) => b.range.from - a.range.from))
    raw = removeOwnedInputRange(raw, range);
  const edited = editTaskInput(state, raw);
  return {
    ...edited,
    removedTags: [...edited.removedTags.filter((old) => !sameTag(old, tag)), tag],
  };
}
function chosenBinding(
  state: TaskInputState,
  action: Extract<TaskInputAction, { type: 'select-date' }>,
  projection: TaskInputProjection,
): TaskInputBinding | undefined {
  const chosen = action.candidate;
  if (chosen === undefined)
    return projection.bindings.find(
      (binding) =>
        binding.role === action.role &&
        binding.dateRanges.length > 0 &&
        projection.candidates.some(
          (candidate) =>
            candidate.status === 'point' &&
            JSON.stringify(candidate.ranges) === JSON.stringify(binding.ranges),
        ),
    );
  if (chosen.status !== 'point' || chosen.date === undefined) return undefined;
  const suppressed = state.suppressed.some((old) =>
    old.ranges.some((range) => chosen.ranges.some((other) => inputRangesOverlap(range, other))),
  );
  return suppressed ? undefined : inputBinding(state, chosen, action.role);
}
function afterRoleAction(state: TaskInputState, role: TaskInputPlanningRole): TaskInputState {
  const restore = state.restore;
  if (restore === undefined) return state;
  const affected =
    restore.fallbacks.includes(role) || restore.bindings.some((binding) => binding.role === role);
  return affected ? withoutRestore(state) : state;
}
function selectDate(
  state: TaskInputState,
  action: Extract<TaskInputAction, { type: 'select-date' }>,
  projection: TaskInputProjection,
): TaskInputState {
  if (action.candidate !== undefined && !projection.candidates.includes(action.candidate))
    return state;
  const binding = chosenBinding(state, action, projection);
  return {
    ...afterRoleAction(state, action.role),
    manual: {
      ...state.manual,
      [action.role]: { value: action.value, ...(binding === undefined ? {} : { binding }) },
    },
  };
}
function dismissedBindings(
  state: TaskInputState,
  role: TaskInputPlanningRole,
  projection: TaskInputProjection,
  inspection: TaskInputInspection,
): TaskInputBinding[] {
  const roles = role === 'due' ? ['due', 'time'] : [role];
  const candidates = projection.candidates
    .filter((candidate) => role === 'due' || (role === 'time' && candidate.time !== undefined))
    .map((candidate) => inputBinding(state, candidate, role));
  const carriers = inspection.carriers
    .filter((carrier) => carrier.role === role)
    .map((carrier) => ({
      ranges: [carrier.range],
      slices: [state.raw.slice(carrier.range.from, carrier.range.to)],
      role,
      revision: state.revision,
      dateRanges: role === 'time' ? [] : [carrier.range],
      timeRanges: role === 'time' ? [carrier.range] : [],
    }));
  return [
    ...candidates,
    ...projection.bindings.filter((binding) => roles.includes(binding.role)),
    ...carriers,
  ];
}
function dismissRole(
  state: TaskInputState,
  role: TaskInputPlanningRole,
  projection: TaskInputProjection,
  inspection: TaskInputInspection,
): TaskInputState {
  const roles: TaskInputPlanningRole[] = role === 'due' ? ['due', 'time'] : [role];
  const bindings = dismissedBindings(state, role, projection, inspection);
  const manual = { ...state.manual };
  if (role !== 'time') delete manual[role];
  const fallbacks = roles.filter((affected) => !state.clearedFallbacks.includes(affected));
  return {
    ...withoutRestore(state),
    manual,
    suppressed: [...state.suppressed, ...bindings],
    clearedFallbacks: [...state.clearedFallbacks, ...fallbacks],
    restore: { bindings, fallbacks, revision: state.revision },
  };
}
export function applyTaskInputAction(
  state: TaskInputState,
  action: TaskInputAction,
  projection: TaskInputProjection,
  inspection: TaskInputInspection,
): TaskInputState {
  if (projection.revision !== state.revision) return state;
  switch (action.type) {
    case 'restore':
      return restoreDismissal(state);
    case 'remove-tag':
      return removeTag(state, action.tag, inspection);
    case 'select-date':
      return selectDate(state, action, projection);
    case 'dismiss':
      return dismissRole(state, action.role, projection, inspection);
    case 'dismiss-ambiguity':
      return dismissRole(state, 'due', projection, inspection);
  }
}
