import {
  daysBetweenLocalDates,
  expandRecurrenceReferences,
  localDate,
  parseRecurrenceRule,
  shiftLocalDate,
  type CalendarProjectionSources,
  type CalendarTaskSource,
  type DateRange,
  type LocalDate,
  type RecurrencePolicy,
  type TaskApplicationApi,
  type TaskNodeRef,
  type TaskPlanning,
  type TaskRef,
  type TaskSnapshot,
} from '../tasks';

export type { CalendarProjectionSources, CalendarTaskSource } from '../tasks';

export type CalendarOccurrence =
  | {
      readonly kind: 'materialized';
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

export interface CalendarProjection {
  readonly occurrences: readonly CalendarOccurrence[];
  readonly issues: readonly CalendarProjectionIssue[];
}

interface ForecastTemplate {
  readonly key: string;
  readonly planning: TaskPlanning;
  readonly referenceDate: LocalDate;
  readonly ordinal: number;
}

interface ForecastCacheEntry {
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
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
): string {
  return [
    semanticSourceKey(source),
    source.root.ref.revision,
    visible.from,
    visible.to,
    policy.removeScheduledDate ? 'remove-scheduled' : 'keep-scheduled',
  ].join('|');
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

function shiftedPlanning(
  planning: TaskPlanning,
  reference: LocalDate,
  nextReference: LocalDate,
  policy: RecurrencePolicy,
): TaskPlanning | undefined {
  const dayDelta = daysBetweenLocalDates(reference, nextReference);
  const shifted: {
    start?: LocalDate;
    scheduled?: LocalDate;
    due?: LocalDate;
  } = {};
  for (const field of SHIFTED_DATE_FIELDS) {
    if (field === 'scheduled' && policy.removeScheduledDate) continue;
    const value = planning[field];
    if (value === undefined) continue;
    const next = shiftLocalDate(value, dayDelta);
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
  planning: TaskPlanning,
  reference: LocalDate,
  visible: DateRange,
  policy: RecurrencePolicy,
): DateRange | undefined {
  const dates = [
    planning.start,
    policy.removeScheduledDate ? undefined : planning.scheduled,
    planning.due,
  ].filter((date): date is LocalDate => date !== undefined);
  if (dates.length === 0) return undefined;
  const offsets = dates.map((date) => daysBetweenLocalDates(reference, date));
  const earliestOffset = Math.min(...offsets);
  const latestOffset = Math.max(...offsets);
  const from = shiftLocalDate(visible.from, -latestOffset);
  const to = shiftLocalDate(visible.to, -earliestOffset);
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}

function emptyCacheEntry(): ForecastCacheEntry {
  return Object.freeze({ forecasts: Object.freeze([]), issues: Object.freeze([]) });
}

function computeForecasts(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
): ForecastCacheEntry {
  const request = forecastExpansionRequest(source, visible, policy);
  if (request === undefined) return emptyCacheEntry();
  const expansion = expandRecurrenceReferences({
    rule: request.rule,
    planning: source.node.planning,
    visible: request.bounds,
    policy,
    maxVisible: 512,
    maxSequentialSteps: 4096,
  });
  if (expansion.type === 'invalid') return emptyCacheEntry();

  const forecasts: ForecastTemplate[] = [];
  for (const [index, referenceDate] of expansion.dates.entries()) {
    const planning = shiftedPlanning(
      source.node.planning,
      request.reference,
      referenceDate,
      policy,
    );
    if (planning === undefined || !intersectsVisible(planning, visible)) continue;
    forecasts.push(
      Object.freeze({
        key: `${semanticSourceKey(source)}:${referenceDate}`,
        planning,
        referenceDate,
        ordinal: index + 1,
      }),
    );
  }
  const issues: Array<Omit<CalendarProjectionIssue, 'source'>> = [];
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
    forecasts: Object.freeze(forecasts),
    issues: Object.freeze(issues),
  });
}

interface ForecastExpansionRequest {
  readonly rule: string;
  readonly reference: LocalDate;
  readonly bounds: DateRange;
}

function forecastExpansionRequest(
  source: CalendarTaskSource,
  visible: DateRange,
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
  const bounds = expansionBounds(node.planning, reference, visible, policy);
  return bounds === undefined ? undefined : { rule: node.recurrence, reference, bounds };
}

function forecastEntry(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
): ForecastCacheEntry {
  const key = projectionCacheKey(source, visible, policy);
  return cachedForecast(key) ?? cacheForecast(key, computeForecasts(source, visible, policy));
}

function materializedOccurrence(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
): CalendarOccurrence | undefined {
  const planning = Object.freeze({ ...source.node.planning });
  if (!intersectsVisible(planning, visible)) return undefined;
  const reference = recurrenceReference(planning, policy);
  if (reference === undefined) return undefined;
  return Object.freeze({
    kind: 'materialized',
    key: `${semanticSourceKey(source)}:${reference}`,
    source,
    planning,
    recurring: source.node.recurrence !== undefined,
  });
}

function occurrenceDate(occurrence: CalendarOccurrence): LocalDate {
  const planned =
    occurrence.planning.start ?? occurrence.planning.scheduled ?? occurrence.planning.due;
  if (planned !== undefined) return planned;
  if (occurrence.kind === 'forecast') return occurrence.referenceDate;
  return localDate('0000-01-01');
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
): CalendarProjection {
  const occurrencesByKey = new Map<string, CalendarOccurrence>();
  addMaterializedOccurrences(sources.materialized, visible, policy, occurrencesByKey);

  const issues: CalendarProjectionIssue[] = [];
  const issueKeys = new Set<string>();
  const accumulator = { occurrencesByKey, issues, issueKeys };
  for (const source of sources.recurringSources) {
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
  occurrencesByKey: Map<string, CalendarOccurrence>,
): void {
  for (const source of sources) {
    const occurrence = materializedOccurrence(source, visible, policy);
    if (occurrence !== undefined && !occurrencesByKey.has(occurrence.key)) {
      occurrencesByKey.set(occurrence.key, occurrence);
    }
  }
}

function addForecastEntry(
  source: CalendarTaskSource,
  visible: DateRange,
  policy: RecurrencePolicy,
  accumulator: ProjectionAccumulator,
): void {
  const entry = forecastEntry(source, visible, policy);
  for (const template of entry.forecasts) {
    if (!accumulator.occurrencesByKey.has(template.key)) {
      accumulator.occurrencesByKey.set(
        template.key,
        Object.freeze({ kind: 'forecast', source, ...template }),
      );
    }
  }
  for (const issue of entry.issues) addProjectionIssue(source, issue, accumulator);
}

interface ProjectionAccumulator {
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
    ...(node.recurrence !== undefined && { recurrence: node.recurrence }),
    onCompletion: node.onCompletion,
    onCompletionExplicit: node.onCompletionExplicit,
    subtasks: [...node.subtasks],
    comments: [...node.comments],
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
export function calendarTaskWithPlanning(task: TaskSnapshot, planning: TaskPlanning): TaskSnapshot {
  const preview = { ...task, planning };
  const occurrence = occurrenceBySnapshot.get(task);
  if (occurrence !== undefined) occurrenceBySnapshot.set(preview, occurrence);
  return preview;
}

/**
 * Resolves the explicit occurrence contract at a renderer boundary. Calendar projections already
 * register their derived snapshots in `occurrenceBySnapshot`; direct materialized snapshots (used
 * by non-projected callers and renderer unit tests) receive the same revision-free root contract
 * without inventing a persisted identity.
 */
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
  if (patch.duration !== undefined) return undefined;
  return { type: 'patch', target, patch };
}

/** Builds the source-owner patch used by the forecast's explicit Edit repeat action. */
export function calendarSourcePatchCommand(
  source: CalendarTaskSource,
  patch: TaskPatch,
): TaskCommand | undefined {
  if (source.target.type === 'task') {
    return { type: 'patch', target: source.target, patch };
  }
  if (patch.duration !== undefined) return undefined;
  return { type: 'patch', target: source.target, patch };
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
