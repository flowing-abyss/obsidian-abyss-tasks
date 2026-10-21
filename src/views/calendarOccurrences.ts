import {
  daysBetweenLocalDates,
  expandRecurrenceReferences,
  localDate,
  parseRecurrenceRule,
  shiftLocalDate,
  taskOccupiedDates,
  type CalendarProjectionSources,
  type CalendarTaskSource,
  type DateRange,
  type FieldUpdate,
  type LocalDate,
  type LocalTime,
  type RecurrencePolicy,
  type TaskApplicationApi,
  type TaskDateRole,
  type TaskNodeRef,
  type TaskPlanning,
  type TaskRef,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../tasks';

export type { CalendarProjectionSources, CalendarTaskSource } from '../tasks';

export type CalendarOccurrence =
  | {
      readonly kind: 'materialized';
      readonly occupied:
        | { readonly kind: 'interval'; readonly start: LocalDate; readonly due: LocalDate }
        | {
            readonly kind: 'point';
            readonly date: LocalDate;
            readonly roles: readonly TaskDateRole[];
          };
      readonly key: string;
      readonly source: CalendarTaskSource;
      readonly planning: TaskPlanning;
      readonly recurring: boolean;
    }
  | {
      readonly kind: 'forecast';
      readonly key: string;
      readonly source: CalendarTaskSource;
      readonly planning: TaskPlanning;
      readonly referenceDate: LocalDate;
      readonly ordinal: number;
    };

export interface CalendarProjectionIssue {
  readonly code: 'forecast-limit-reached';
  readonly source: TaskRef;
  readonly phase: 'visible-occurrences' | 'sequential-seek';
  readonly limit: 512 | 4096;
}

export interface CalendarPlanningOverride {
  readonly source: CalendarTaskSource;
  readonly planning: TaskPlanning;
}

export interface CalendarProjection {
  readonly occurrences: readonly CalendarOccurrence[];
  readonly issues: readonly CalendarProjectionIssue[];
}

interface ForecastTemplate {
  readonly shiftedDates: readonly LocalDate[];
  readonly referenceDate: LocalDate;
  readonly ordinal: number;
}

interface ForecastCacheEntry {
  readonly originalDates: readonly LocalDate[];
  readonly forecasts: readonly ForecastTemplate[];
  readonly issues: ReadonlyArray<Omit<CalendarProjectionIssue, 'source'>>;
}

const MAX_PROJECTION_CACHE_ENTRIES = 256;
const projectionCache = new Map<string, ForecastCacheEntry>();
const occurrenceBySnapshot = new WeakMap<TaskSnapshot, CalendarOccurrence>();
const SHIFTED_DATE_FIELDS = ['start', 'scheduled', 'due'] as const;
type TaskCommand = Parameters<TaskApplicationApi['execute']>[0];
type TaskPatch = Extract<
  TaskCommand,
  { readonly type: 'patch'; readonly target: { readonly type: 'task' } }
>['patch'];

function recurrenceReference(
  planning: TaskPlanning,
  policy: RecurrencePolicy,
): LocalDate | undefined {
  if (policy.removeScheduledDate) return planning.due ?? planning.start ?? planning.scheduled;
  return planning.due ?? planning.scheduled ?? planning.start;
}

function targetPath(target: TaskNodeRef): readonly number[] {
  if (target.type === 'task') return [];
  return [...targetPath(target.ref.parent), target.ref.relativeLine];
}

function semanticSourceKey(source: CalendarTaskSource): string {
  const root = `${source.root.source.filePath}:${source.root.source.line}`;
  const path = targetPath(source.target);
  return path.length === 0 ? root : `${root}:subtask:${path.join('.')}`;
}

function projectionCacheKey(
  request: ForecastExpansionRequest,
  visible: DateRange,
  policy: RecurrencePolicy,
): string {
  // Role geometry and source identity are hydrated only after shared date arithmetic.
  return JSON.stringify([
    request.rule,
    request.reference,
    request.originalDates,
    visible.from,
    visible.to,
    policy.removeScheduledDate,
  ]);
}

function cachedForecast(key: string): ForecastCacheEntry | undefined {
  const cached = projectionCache.get(key);
  if (cached == null) return undefined;
  projectionCache.delete(key);
  projectionCache.set(key, cached);
  return cached;
}

function cacheForecast(key: string, entry: ForecastCacheEntry): ForecastCacheEntry {
  projectionCache.set(key, entry);
  while (projectionCache.size > MAX_PROJECTION_CACHE_ENTRIES) {
    const oldest = projectionCache.keys().next().value;
    if (oldest === undefined) break;
    projectionCache.delete(oldest);
  }
  return entry;
}

function hydratePlanning(
  planning: TaskPlanning,
  entry: ForecastCacheEntry,
  template: ForecastTemplate,
  policy: RecurrencePolicy,
): TaskPlanning | undefined {
  const shifted: {
    start?: LocalDate;
    scheduled?: LocalDate;
    due?: LocalDate;
  } = {};
  for (const field of SHIFTED_DATE_FIELDS) {
    if (field === 'scheduled' && policy.removeScheduledDate) continue;
    const value = planning[field];
    if (value === undefined) continue;
    const next = template.shiftedDates[entry.originalDates.indexOf(value)];
    if (next === undefined) return undefined;
    shifted[field] = next;
  }
  return Object.freeze({
    ...shifted,
    ...(planning.time !== undefined && { time: planning.time }),
    ...(planning.duration !== undefined && { duration: planning.duration }),
  });
}

function intersectsVisible(planning: TaskPlanning, visible: DateRange): boolean {
  const pointIntersects = [planning.start, planning.scheduled, planning.due].some(
    (date) => date !== undefined && date >= visible.from && date <= visible.to,
  );
  if (
    planning.start !== undefined &&
    planning.due !== undefined &&
    planning.start <= planning.due
  ) {
    return pointIntersects || (planning.start <= visible.to && planning.due >= visible.from);
  }
  return pointIntersects;
}

function expansionBounds(
  dates: readonly LocalDate[],
  reference: LocalDate,
  visible: DateRange,
): DateRange | undefined {
  const offsets = dates.map((date) => daysBetweenLocalDates(reference, date));
  const earliestOffset = Math.min(...offsets);
  const latestOffset = Math.max(...offsets);
  const from = shiftLocalDate(visible.from, -latestOffset);
  const to = shiftLocalDate(visible.to, -earliestOffset);
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}

function computeForecasts(
  request: ForecastExpansionRequest,
  visible: DateRange,
  policy: RecurrencePolicy,
): ForecastCacheEntry {
  const forecasts: ForecastTemplate[] = [];
  const issues: Array<Omit<CalendarProjectionIssue, 'source'>> = [];
  const empty = (): ForecastCacheEntry =>
    Object.freeze({
      originalDates: request.originalDates,
      forecasts: Object.freeze([]),
      issues: Object.freeze([]),
    });
  const bounds = expansionBounds(request.originalDates, request.reference, visible);
  if (bounds === undefined) return empty();
  const expansion = expandRecurrenceReferences({
    rule: request.rule,
    planning: { due: request.reference },
    visible: bounds,
    policy,
    maxVisible: 512,
    maxSequentialSteps: 4096,
  });
  if (expansion.type === 'invalid') return empty();

  for (const [index, referenceDate] of expansion.dates.entries()) {
    const dayDelta = daysBetweenLocalDates(request.reference, referenceDate);
    const shiftedDates = request.originalDates.map((date) => shiftLocalDate(date, dayDelta));
    // Reject the entire planning if any effective date overflows, preserving expansion ordinals.
    if (!shiftedDates.every((date): date is LocalDate => date !== undefined)) continue;
    forecasts.push(
      Object.freeze({
        shiftedDates: Object.freeze(shiftedDates),
        referenceDate,
        ordinal: index + 1,
      }),
    );
  }
  if (expansion.type === 'limited') {
    issues.push(
      Object.freeze({
        code: 'forecast-limit-reached',
        phase: expansion.phase,
        limit: expansion.limit,
      }),
    );
  }
  return Object.freeze({
    originalDates: request.originalDates,
    forecasts: Object.freeze(forecasts),
    issues: Object.freeze(issues),
  });
}

interface ForecastExpansionRequest {
  readonly rule: string;
  readonly reference: LocalDate;
  readonly originalDates: readonly LocalDate[];
}

function forecastExpansionRequest(
  source: CalendarTaskSource,
  policy: RecurrencePolicy,
): ForecastExpansionRequest | undefined {
  const { node } = source;
  if (node.recurrence === undefined || (node.status !== 'open' && node.status !== 'in-progress')) {
    return undefined;
  }
  const parsed = parseRecurrenceRule(node.recurrence);
  if (parsed.type === 'invalid' || parsed.whenDone) return undefined;
  const reference = recurrenceReference(node.planning, policy);
  if (reference === undefined) return undefined;
  const originalDates = Object.freeze(
    [
      ...new Set(
        SHIFTED_DATE_FIELDS.filter((field) => field !== 'scheduled' || !policy.removeScheduledDate)
          .map((field) => node.planning[field])
          .filter((date): date is LocalDate => date !== undefined),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  );
  return originalDates.length === 0
    ? undefined
    : { rule: node.recurrence, reference, originalDates };
}

function forecastEntry(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
): ForecastCacheEntry | undefined {
  // Validate every current source before lookup; status is deliberately absent from the key.
  const request = forecastExpansionRequest(source, policy);
  if (request === undefined) return undefined;
  const key = projectionCacheKey(request, visible, policy);
  return cachedForecast(key) ?? cacheForecast(key, computeForecasts(request, visible, policy));
}

function materializedOccurrences(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
  effectivePlanning = source.node.planning,
): readonly CalendarOccurrence[] {
  const planning = Object.freeze({ ...effectivePlanning });
  const occupied = taskOccupiedDates(planning);
  const common = {
    kind: 'materialized' as const,
    source,
    planning,
    recurring: source.node.recurrence !== undefined,
  };
  if (occupied.kind === 'interval') {
    if (occupied.start > visible.to || occupied.due < visible.from) return [];
    return [
      Object.freeze({
        ...common,
        occupied,
        key: `${semanticSourceKey(source)}:${recurrenceReference(planning, policy)}`,
      }),
    ];
  }
  return occupied.points
    .filter((point) => point.date >= visible.from && point.date <= visible.to)
    .map((point) =>
      Object.freeze({
        ...common,
        occupied: { kind: 'point' as const, ...point },
        key: `${semanticSourceKey(source)}:${point.date}`,
      }),
    );
}

function occurrenceDate(occurrence: CalendarOccurrence): LocalDate {
  if (occurrence.kind === 'materialized')
    return occurrence.occupied.kind === 'point'
      ? occurrence.occupied.date
      : occurrence.occupied.start;
  const planned =
    occurrence.planning.start ?? occurrence.planning.scheduled ?? occurrence.planning.due;
  if (planned !== undefined) return planned;
  return occurrence.referenceDate;
}

function stableOccurrenceOrder(left: CalendarOccurrence, right: CalendarOccurrence): number {
  const kindOrder = Number(left.kind === 'forecast') - Number(right.kind === 'forecast');
  const dateOrder = occurrenceDate(left).localeCompare(occurrenceDate(right));
  if (dateOrder !== 0) return dateOrder;
  const timeOrder = (left.planning.time ?? '99:99').localeCompare(right.planning.time ?? '99:99');
  if (timeOrder !== 0) return timeOrder;
  const keyOrder = left.key.localeCompare(right.key);
  return keyOrder !== 0 ? keyOrder : kindOrder;
}

export function projectCalendarOccurrences(
  sources: CalendarProjectionSources,
  visible: DateRange,
  policy: RecurrencePolicy,
  pending: readonly CalendarPlanningOverride[] = [],
): CalendarProjection {
  const overrides = new Map(pending.map((entry) => [semanticSourceKey(entry.source), entry]));
  const retained = (
    input: readonly CalendarTaskSource[],
    recurring = false,
  ): CalendarTaskSource[] => [
    ...new Map(
      [
        ...input,
        ...pending
          .map((entry) => entry.source)
          .filter((source) => !recurring || source.node.recurrence !== undefined),
      ].map((source) => [
        semanticSourceKey(source),
        overrides.get(semanticSourceKey(source))?.source ?? source,
      ]),
    ).values(),
  ];
  const occurrencesByKey = new Map<string, CalendarOccurrence>();
  const issues: CalendarProjectionIssue[] = [];
  const issueKeys = new Set<string>();
  const accumulator = { occurrencesByKey, issues, issueKeys, overrides };
  addMaterializedOccurrences(
    pending.length === 0 ? sources.materialized : retained(sources.materialized),
    visible,
    policy,
    accumulator,
  );

  for (const source of pending.length === 0
    ? sources.recurringSources
    : retained(sources.recurringSources, true)) {
    addForecastEntry(source, visible, policy, accumulator);
  }

  return Object.freeze({
    occurrences: Object.freeze([...occurrencesByKey.values()].sort(stableOccurrenceOrder)),
    issues: Object.freeze(issues),
  });
}

function addMaterializedOccurrences(
  sources: readonly CalendarTaskSource[],
  visible: DateRange,
  policy: RecurrencePolicy,
  accumulator: ProjectionAccumulator,
): void {
  const { occurrencesByKey, overrides } = accumulator;
  for (const source of sources) {
    for (const occurrence of materializedOccurrences(
      source,
      visible,
      policy,
      overrides.get(semanticSourceKey(source))?.planning,
    )) {
      if (!occurrencesByKey.has(occurrence.key)) occurrencesByKey.set(occurrence.key, occurrence);
    }
  }
}

function addForecastEntry(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
  accumulator: ProjectionAccumulator,
): void {
  const effectivePlanning =
    accumulator.overrides.get(semanticSourceKey(source))?.planning ?? source.node.planning;
  const entry = forecastEntry(
    effectivePlanning === source.node.planning
      ? source
      : { ...source, node: { ...source.node, planning: effectivePlanning } },
    visible,
    policy,
  );
  if (entry === undefined) return;
  for (const template of entry.forecasts) {
    const planning = hydratePlanning(effectivePlanning, entry, template, policy);
    if (planning === undefined || !intersectsVisible(planning, visible)) continue;
    const key = `${semanticSourceKey(source)}:${template.referenceDate}`;
    if (!accumulator.occurrencesByKey.has(key)) {
      accumulator.occurrencesByKey.set(
        key,
        Object.freeze({
          kind: 'forecast',
          key,
          source,
          planning,
          referenceDate: template.referenceDate,
          ordinal: template.ordinal,
        }),
      );
    }
  }
  for (const issue of entry.issues) addProjectionIssue(source, issue, accumulator);
}

interface ProjectionAccumulator {
  readonly overrides: ReadonlyMap<string, CalendarPlanningOverride>;
  readonly occurrencesByKey: Map<string, CalendarOccurrence>;
  readonly issues: CalendarProjectionIssue[];
  readonly issueKeys: Set<string>;
}

function addProjectionIssue(
  source: CalendarTaskSource,
  issue: Omit<CalendarProjectionIssue, 'source'>,
  accumulator: ProjectionAccumulator,
): void {
  const key = `${semanticSourceKey(source)}:${issue.phase}:${issue.limit}`;
  if (accumulator.issueKeys.has(key)) return;
  accumulator.issueKeys.add(key);
  accumulator.issues.push(
    Object.freeze({ ...issue, source: Object.freeze({ ...source.root.ref }) }),
  );
}

const NO_TIME_ENTRIES: readonly TimeEntrySnapshot[] = Object.freeze([]);

export function taskSnapshotForCalendarOccurrence(occurrence: CalendarOccurrence): TaskSnapshot {
  const { root, node } = occurrence.source;
  const snapshot: TaskSnapshot = {
    ref: root.ref,
    title: node.title,
    markdownTitle: node.markdownTitle,
    status: node.status,
    statusSymbol: node.statusSymbol,
    priority: node.priority,
    planning: { ...occurrence.planning },
    tags: [...node.tags],
    ...(occurrence.kind === 'materialized' &&
      node.dependencyId !== undefined && { dependencyId: node.dependencyId }),
    dependsOn: occurrence.kind === 'materialized' ? [...node.dependsOn] : [],
    ...(node.recurrence !== undefined && { recurrence: node.recurrence }),
    onCompletion: node.onCompletion,
    onCompletionExplicit: node.onCompletionExplicit,
    subtasks: [...node.subtasks],
    comments: [...node.comments],
    // A forecast occurrence has not happened yet, so it carries none of the tracked time already
    // written on the materialized one.
    timeEntries: occurrence.kind === 'materialized' ? node.timeEntries : NO_TIME_ENTRIES,
    ...(node.description !== undefined && { description: node.description }),
    source: { ...root.source },
    presentation: { ...root.presentation },
  };
  occurrenceBySnapshot.set(snapshot, occurrence);
  return snapshot;
}

export function calendarOccurrenceForTask(task: TaskSnapshot): CalendarOccurrence | undefined {
  return occurrenceBySnapshot.get(task);
}

/**
 * Copies one calendar snapshot for a transient planning preview while preserving its semantic
 * occurrence registration. The identity stays non-enumerable and process-local in the existing
 * WeakMap; no persisted ref/id or second metadata grammar is introduced.
 */
export function calendarTaskWithPlanning(
  task: TaskSnapshot,
  planning: TaskPlanning,
  intent?: 'create-span',
): TaskSnapshot {
  const preview = { ...task, planning };
  const occurrence = occurrenceBySnapshot.get(task);
  if (occurrence?.kind === 'materialized') {
    const promoted = intent === 'create-span' ? taskOccupiedDates(planning) : undefined;
    occurrenceBySnapshot.set(preview, {
      ...occurrence,
      planning,
      occupied:
        promoted?.kind === 'interval'
          ? promoted
          : occupiedWithPlanning(occurrence.occupied, planning),
    });
  } else if (occurrence !== undefined) occurrenceBySnapshot.set(preview, occurrence);
  return preview;
}

function occupiedWithPlanning(
  occupied: Extract<CalendarOccurrence, { kind: 'materialized' }>['occupied'],
  planning: TaskPlanning,
): Extract<CalendarOccurrence, { kind: 'materialized' }>['occupied'] {
  if (occupied.kind === 'interval')
    return {
      ...occupied,
      start: planning.start ?? occupied.start,
      due: planning.due ?? occupied.due,
    };
  const role = occupied.roles[0];
  const date = role === undefined ? undefined : planning[role];
  return { ...occupied, date: date ?? occupied.date };
}

/**
 * Resolves the explicit occurrence contract at a renderer boundary. Calendar projections already
 * register their derived snapshots in `occurrenceBySnapshot`; direct materialized snapshots (used
 * by non-projected callers and renderer unit tests) receive the same revision-free root contract
 * without inventing a persisted identity.
 */
function occupiedForUnprojectedTask(
  planning: TaskPlanning,
): Extract<CalendarOccurrence, { kind: 'materialized' }>['occupied'] {
  const dates = taskOccupiedDates(planning);
  if (dates.kind === 'interval') return dates;
  // Unregistered callers have no displayed-point authority: retain the legacy scheduling anchor.
  let role: TaskDateRole = 'start';
  if (planning.due !== undefined) role = 'due';
  if (planning.scheduled !== undefined) role = 'scheduled';
  const date = planning[role];
  return {
    kind: 'point',
    date: date ?? localDate('0000-01-01'),
    roles: date === undefined ? [] : [role],
  };
}

export function calendarOccurrenceForRender(task: TaskSnapshot): CalendarOccurrence {
  const projected = occurrenceBySnapshot.get(task);
  if (projected !== undefined) return projected;
  const reference = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
  const source: CalendarTaskSource = {
    root: task,
    node: task,
    target: { type: 'task', ref: task.ref },
  };
  return {
    kind: 'materialized',
    occupied: occupiedForUnprojectedTask(task.planning),
    key: `${semanticSourceKey(source)}:${reference ?? 'undated'}`,
    source,
    planning: task.planning,
    recurring: task.recurrence !== undefined,
  };
}

export function isForecastCalendarTask(task: TaskSnapshot): boolean {
  return occurrenceBySnapshot.get(task)?.kind === 'forecast';
}

export function calendarMutationTarget(task: TaskSnapshot): TaskNodeRef | undefined {
  const occurrence = occurrenceBySnapshot.get(task);
  if (occurrence?.kind === 'forecast') return undefined;
  return occurrence?.source.target ?? { type: 'task', ref: task.ref };
}

/** Builds a patch only for an authoritative materialized target. */
export function calendarPatchCommand(
  task: TaskSnapshot,
  patch: TaskPatch,
): TaskCommand | undefined {
  const target = calendarMutationTarget(task);
  if (target === undefined) return undefined;
  if (target.type === 'task') return { type: 'patch', target, patch };
  return { type: 'patch', target, patch };
}

/** Point gestures edit only the roles carried by this exact materialized occurrence. */
export function calendarPointPatchCommand(
  task: TaskSnapshot,
  date: LocalDate,
  time?: FieldUpdate<LocalTime>,
): TaskCommand | undefined {
  const occurrence = calendarOccurrenceForRender(task);
  if (
    occurrence.kind !== 'materialized' ||
    occurrence.occupied.kind !== 'point' ||
    occurrence.occupied.roles.length === 0
  )
    return undefined;
  let patch: TaskPatch = {};
  for (const role of occurrence.occupied.roles)
    patch = { ...patch, [role]: { type: 'set', value: date } };
  return calendarPatchCommand(task, time === undefined ? patch : { ...patch, time });
}

/** Builds the source-owner patch for explicit series edits from a forecast. */
export function calendarSourcePatchCommand(
  source: CalendarTaskSource,
  patch: TaskPatch,
): TaskCommand | undefined {
  if (source.target.type === 'task') {
    return { type: 'patch', target: source.target, patch };
  }
  return { type: 'patch', target: source.target, patch };
}

/** Date gestures preserve the occurrence's node target, including materialized children. */
export function calendarSpanBoundaryCommand(
  task: TaskSnapshot,
  boundary: 'start' | 'due' | 'create-span',
  date: LocalDate,
): TaskCommand | undefined {
  const target = calendarMutationTarget(task);
  if (target == null) return undefined;
  if (target.type === 'task') {
    return boundary === 'create-span'
      ? { type: 'extend-span', ref: target.ref, due: date }
      : { type: 'set-span-boundary', ref: target.ref, boundary, date };
  }
  if (boundary !== 'create-span') {
    return calendarPatchCommand(task, { [boundary]: { type: 'set', value: date } });
  }
  const start = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
  return start == null
    ? undefined
    : calendarPatchCommand(task, {
        start: { type: 'set', value: start },
        due: { type: 'set', value: date },
      });
}

function calendarShiftFields(planning: TaskPlanning): ReadonlyArray<'start' | 'scheduled' | 'due'> {
  if (planning.start != null && planning.due != null) return ['start', 'due'];
  return [planning.scheduled != null ? 'scheduled' : 'due'];
}

export function calendarShiftPlanning(
  planning: TaskPlanning,
  days: number,
  occupied?: Extract<CalendarOccurrence, { kind: 'materialized' }>['occupied'],
): TaskPlanning | undefined {
  const shiftedPlanning = { ...planning };
  for (const field of occupied?.kind === 'point' ? occupied.roles : calendarShiftFields(planning)) {
    const value = planning[field];
    const shifted = value == null ? undefined : shiftLocalDate(value, days);
    if (shifted == null) return undefined;
    shiftedPlanning[field] = shifted;
  }
  return shiftedPlanning;
}

export function calendarShiftScheduleCommand(
  task: TaskSnapshot,
  days: number,
): TaskCommand | undefined {
  const target = calendarMutationTarget(task);
  if (target == null || !Number.isSafeInteger(days) || days === 0) return undefined;
  const occurrence = calendarOccurrenceForRender(task);
  if (occurrence.kind === 'materialized' && occurrence.occupied.kind === 'point') {
    const date = shiftLocalDate(occurrence.occupied.date, days);
    return date === undefined ? undefined : calendarPointPatchCommand(task, date);
  }
  if (target.type === 'task') return { type: 'shift-schedule', ref: target.ref, days };
  return calendarChildShiftCommand(task, days);
}

function calendarChildShiftCommand(task: TaskSnapshot, days: number): TaskCommand | undefined {
  const planning = calendarShiftPlanning(task.planning, days);
  if (planning == null) return undefined;
  const fields = calendarShiftFields(task.planning);
  const patch: Partial<Record<'start' | 'scheduled' | 'due', NonNullable<TaskPatch['due']>>> = {};
  for (const field of fields) {
    const value = planning[field];
    if (value != null) patch[field] = { type: 'set', value };
  }
  return calendarPatchCommand(task, patch);
}

export function calendarRootTaskRef(task: TaskSnapshot): TaskRef | undefined {
  const target = calendarMutationTarget(task);
  return target?.type === 'task' ? target.ref : undefined;
}

export function hasOtherCalendarRecurrenceOwner(source: CalendarTaskSource): boolean {
  if (source.root !== source.node && source.root.recurrence !== undefined) return true;
  const pending = [...source.root.subtasks];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node === undefined) continue;
    if (node !== source.node && node.recurrence !== undefined) return true;
    pending.push(...node.subtasks);
  }
  return false;
}
