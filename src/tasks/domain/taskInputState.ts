import { sameTag } from '../../markdown/tagSyntax';
import { currentInputBinding, inputRangesOverlap } from './taskInputGuards';
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
interface TaskInputTagBinding {
  readonly ranges: readonly TaskInputRange[];
  readonly slices: readonly string[];
  readonly revision: number;
  readonly tag: string;
}
export type TaskInputDateRole = Exclude<TaskInputPlanningRole, 'time'>;
interface TaskInputManualDate {
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
  readonly suppressedTags: readonly TaskInputTagBinding[];
  readonly restore?: {
    readonly bindings: readonly TaskInputBinding[];
    readonly fallbacks: readonly TaskInputPlanningRole[];
    readonly tags: readonly TaskInputTagBinding[];
    readonly removedTags: readonly string[];
    readonly manual: TaskInputState['manual'];
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
  return {
    raw,
    revision: 0,
    suppressed: [],
    clearedFallbacks: [],
    manual: {},
    removedTags: [],
    suppressedTags: [],
  };
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
  readonly revision: number;
  readonly prefix: number;
  readonly suffix: number;
  readonly enclosingOffset?: number;
}
function inputEdit(state: TaskInputState, raw: string, revision: number): InputEdit {
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
  return {
    old: state,
    raw,
    revision,
    prefix,
    suffix,
    ...(unique ? { enclosingOffset: enclosing } : {}),
  };
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
  const revision = edit.revision;
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
      revision: edit.revision,
    });
  }
  return result;
}
function rebaseSuppressions(edit: InputEdit, uncertain: boolean): TaskInputBinding[] {
  const carriers = inspectTaskInput(edit.old.raw).carriers;
  return edit.old.suppressed.flatMap((binding) => {
    const mapped = rebaseBinding(edit, binding);
    const result = mapped === undefined ? [] : [mapped];
    // Canonical removal owns only the old occurrence, never a matching newly authored carrier.
    const canonical = carriers.some(
      (carrier) =>
        carrier.value !== undefined &&
        carrier.role === binding.role &&
        binding.ranges.some(
          (range) => range.from === carrier.range.from && range.to === carrier.range.to,
        ),
    );
    return uncertain && !canonical ? [...result, ...uncertainDescendants(edit, binding)] : result;
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
function rebaseTag(edit: InputEdit, binding: TaskInputTagBinding): TaskInputTagBinding | undefined {
  if (!currentInputBinding(edit.old.raw, edit.old.revision, binding)) return undefined;
  const ranges = binding.ranges.map((range) => rebaseRange(edit, range));
  if (!ranges.every(definedRange)) return undefined;
  const tags = inspectTaskInput(edit.raw).tags;
  if (
    !ranges.every((range) =>
      tags.some(
        (tag) =>
          sameTag(tag.value, binding.tag) &&
          tag.range.from === range.from &&
          tag.range.to === range.to,
      ),
    )
  )
    return undefined;
  return { ...binding, ranges, revision: edit.revision };
}
function rebaseRestore(edit: InputEdit): TaskInputState['restore'] {
  const restore = edit.old.restore;
  if (restore === undefined) return undefined;
  const bindings = restore.bindings.map((binding) => rebaseBinding(edit, binding));
  const tags = restore.tags.map((binding) => rebaseTag(edit, binding));
  if (
    !bindings.every((binding): binding is TaskInputBinding => binding !== undefined) ||
    !tags.every((binding): binding is TaskInputTagBinding => binding !== undefined)
  )
    return undefined;
  const removedTags = remainingTagRemovals(edit);
  if (restore.removedTags.some((tag) => !removedTags.some((old) => sameTag(old, tag))))
    return undefined;
  const roles = [
    ...restore.fallbacks,
    ...restore.bindings.map((binding) => binding.role),
    ...Object.keys(restore.manual),
  ];
  const before = inspectTaskInput(edit.old.raw).carriers;
  if (
    inspectTaskInput(edit.raw).carriers.some(
      (carrier) =>
        roles.includes(carrier.role) &&
        !before.some(
          (old) =>
            old.role === carrier.role && rebaseRange(edit, old.range)?.from === carrier.range.from,
        ),
    )
  )
    return undefined;
  const manual = rebaseManual({ ...edit, old: { ...edit.old, manual: restore.manual } });
  return { ...restore, bindings, tags, manual, revision: edit.revision };
}
export function editTaskInput(
  state: TaskInputState,
  raw: string,
  kind: 'input' | 'paste' | 'composition' | 'history' = 'input',
  revision = state.revision + 1,
): TaskInputState {
  if (raw === state.raw && revision === state.revision + 1) return state;
  const edit = inputEdit(state, raw, revision),
    restore = rebaseRestore(edit);
  return {
    raw,
    revision,
    suppressed: rebaseSuppressions(edit, kind !== 'input'),
    clearedFallbacks: state.clearedFallbacks,
    manual: rebaseManual(edit),
    removedTags: remainingTagRemovals(edit),
    suppressedTags: state.suppressedTags.flatMap((binding) => {
      const next = rebaseTag(edit, binding);
      return next === undefined ? [] : [next];
    }),
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
    ![...restored.bindings, ...restored.tags].every((binding) =>
      currentInputBinding(state.raw, state.revision, binding),
    )
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
    manual: { ...state.manual, ...restored.manual },
    removedTags: state.removedTags.filter(
      (tag) => !restored.removedTags.some((old) => sameTag(old, tag)),
    ),
    suppressedTags: state.suppressedTags.filter(
      (binding) =>
        !restored.tags.some(
          (old) =>
            sameTag(old.tag, binding.tag) &&
            JSON.stringify(old.ranges) === JSON.stringify(binding.ranges),
        ),
    ),
  };
}
function removeTag(
  state: TaskInputState,
  tag: string,
  inspection: TaskInputInspection,
): TaskInputState {
  const tags = inspection.tags
    .filter((occurrence) => sameTag(occurrence.value, tag))
    .map((occurrence) => ({
      tag: occurrence.value,
      ranges: [occurrence.range],
      slices: [state.raw.slice(occurrence.range.from, occurrence.range.to)],
      revision: state.revision,
    }))
    .filter(
      (binding) =>
        !state.suppressedTags.some(
          (old) =>
            sameTag(old.tag, tag) && JSON.stringify(old.ranges) === JSON.stringify(binding.ranges),
        ),
    );
  const removedTags = state.removedTags.some((old) => sameTag(old, tag)) ? [] : [tag];
  if (tags.length === 0 && removedTags.length === 0) return state;
  return {
    ...state,
    suppressedTags: [...state.suppressedTags, ...tags],
    removedTags: [...state.removedTags, ...removedTags],
    restore: {
      bindings: [],
      fallbacks: [],
      tags,
      removedTags,
      manual: {},
      revision: state.revision,
    },
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
    restore.fallbacks.includes(role) ||
    restore.bindings.some((binding) => binding.role === role) ||
    (role !== 'time' && restore.manual[role] !== undefined);
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
    .filter((carrier) => carrier.role === role && carrier.value !== undefined)
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
  const bindings = dismissedBindings(state, role, projection, inspection).filter(
    (binding, index, all) => {
      const same = (other: TaskInputBinding): boolean =>
        other.role === binding.role &&
        JSON.stringify(other.ranges) === JSON.stringify(binding.ranges);
      return !state.suppressed.some(same) && all.findIndex(same) === index;
    },
  );
  const removedManual =
    role === 'time' || state.manual[role] === undefined ? {} : { [role]: state.manual[role] };
  const manual = { ...state.manual };
  if (role !== 'time') delete manual[role];
  const fallbacks = roles.filter((affected) => !state.clearedFallbacks.includes(affected));
  if (bindings.length === 0 && fallbacks.length === 0 && Object.keys(removedManual).length === 0)
    return state;
  return {
    ...withoutRestore(state),
    manual,
    suppressed: [...state.suppressed, ...bindings],
    clearedFallbacks: [...state.clearedFallbacks, ...fallbacks],
    restore: {
      bindings,
      fallbacks,
      tags: [],
      removedTags: [],
      manual: removedManual,
      revision: state.revision,
    },
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
