import type { OffsetAt, ParsedTimeEntry } from './timeEntry';
import type { TaskNodeRef, TaskRef, TaskStatus, TimeEntryRef } from './types';

export type { TimeEntryIssue } from './timeEntry';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** One parsed entry line kept next to the source it came from, so writes can find it again. */
export interface TimeEntrySnapshot extends ParsedTimeEntry {
  readonly relativeLine: number;
  readonly originalMarkdown: string;
}

/** Addresses the entry line for a write, the way `CommentRef` addresses a comment line. */
export function timeEntryRef(parent: TaskNodeRef, entry: TimeEntrySnapshot): TimeEntryRef {
  return { parent, relativeLine: entry.relativeLine, originalMarkdown: entry.originalMarkdown };
}

/** One entry lifted out of the tree, carrying the node it belongs to. */
export interface TrackedEntry {
  readonly filePath: string;
  readonly root: TaskRef;
  readonly target: TaskNodeRef;
  /** `taskNodeAddress(target)`, read once per node when the entry is lifted out of the tree. */
  readonly address: string;
  /** The same address for the root that owns the node, which is what a card badge is keyed by. */
  readonly rootAddress: string;
  readonly title: string;
  readonly parentTitle?: string;
  readonly status: TaskStatus;
  readonly entry: TimeEntrySnapshot;
}

/** Closed time plus the starts of every still running entry, so a tick only re-adds the open ones. */
export interface TrackedTotal {
  readonly closedMs: number;
  readonly openStartsMs: readonly number[];
}

/** A broken entry has no usable instants, so every consumer reads it as zero. */
function measurableStartMs(entry: TimeEntrySnapshot): number | undefined {
  return entry.state === 'broken' ? undefined : entry.startMs;
}

/** The instant an entry stops counting, which is the clock itself while it runs. */
function measurableEndMs(entry: TimeEntrySnapshot, nowMs: number): number | undefined {
  return entry.state === 'running' ? nowMs : entry.endMs;
}

/** Zero for a broken entry, elapsed time so far for a running one. */
export function entryDurationMs(entry: TimeEntrySnapshot, nowMs: number): number {
  const startMs = measurableStartMs(entry);
  const endMs = measurableEndMs(entry, nowMs);
  if (startMs === undefined || endMs === undefined) return 0;
  return Math.max(0, endMs - startMs);
}

/** The length of `[startMs, endMs)` once it is cut down to `[fromMs, toMs)`. */
function clampedSpanMs(startMs: number, endMs: number, fromMs: number, toMs: number): number {
  return Math.max(0, Math.min(endMs, toMs) - Math.max(startMs, fromMs));
}

/** The part of an entry that falls inside `[fromMs, toMs)`, which is how a day clips at midnight. */
export function entryOverlapMs(
  entry: TimeEntrySnapshot,
  fromMs: number,
  toMs: number,
  nowMs: number,
): number {
  const startMs = measurableStartMs(entry);
  const endMs = measurableEndMs(entry, nowMs);
  if (startMs === undefined || endMs === undefined) return 0;
  return clampedSpanMs(startMs, endMs, fromMs, toMs);
}

export function totalMs(total: TrackedTotal, nowMs: number): number {
  let sum = total.closedMs;
  for (const startMs of total.openStartsMs) sum += Math.max(0, nowMs - startMs);
  return sum;
}

/**
 * Elapsed time that can be counted. A total is arithmetic over instants a note can hand out, so a
 * missing or infinite one reads as no time at all rather than reaching a branded constructor that
 * rejects it.
 */
function countableMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/**
 * Elapsed time the way a reader says it, `0m`, `47m`, `1h` or `17h 37m`. Part minutes have not been
 * earned yet, so a total floors to whole minutes, and a zero hour is left unsaid rather than padded
 * into a clock. This is the one place that turns milliseconds into a label, so the project table,
 * the inspector badge and the task line can never disagree.
 */
export function formatTrackedDuration(ms: number): string {
  const minutes = Math.floor(countableMs(ms) / MS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const restMinutes = minutes % MINUTES_PER_HOUR;
  if (hours === 0) return `${restMinutes}m`;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/**
 * The same label down to the second, `12s`, `1m 5s` or `1h 20m 30s`, for the one running row a
 * popover shows. The seconds are the proof that a timer really is running, so they are spelled out
 * where a reader is already looking at one session rather than on every total. Minutes are kept
 * between hours and seconds even at zero, so the units never skip a step.
 */
export function formatTrackedDurationWithSeconds(ms: number): string {
  const seconds = Math.floor(countableMs(ms) / MS_PER_SECOND);
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const restSeconds = seconds % SECONDS_PER_MINUTE;
  if (hours > 0) return `${hours}h ${minutes}m ${restSeconds}s`;
  return minutes === 0 ? `${restSeconds}s` : `${minutes}m ${restSeconds}s`;
}

/** Folds one entry into an accumulator so a subtree walk never allocates an intermediate total. */
export function addEntryToTotal(
  total: { closedMs: number; openStartsMs: number[] },
  entry: TimeEntrySnapshot,
): void {
  const startMs = measurableStartMs(entry);
  if (startMs === undefined) return;
  if (entry.state === 'running') {
    total.openStartsMs.push(startMs);
    return;
  }
  if (entry.endMs === undefined) return;
  total.closedMs += Math.max(0, entry.endMs - startMs);
}

interface NodeWithEntries {
  readonly timeEntries: readonly TimeEntrySnapshot[];
  readonly subtasks: readonly NodeWithEntries[];
}

function collectSubtree(
  node: NodeWithEntries,
  total: { closedMs: number; openStartsMs: number[] },
): void {
  for (const entry of node.timeEntries) addEntryToTotal(total, entry);
  for (const subtask of node.subtasks) collectSubtree(subtask, total);
}

/** The node's own entries plus every descendant's, in depth-first source order. */
export function subtreeTotal(node: NodeWithEntries): TrackedTotal {
  const total = { closedMs: 0, openStartsMs: [] as number[] };
  collectSubtree(node, total);
  return total;
}

/**
 * Whether a timer is open anywhere in the subtree. This answers the same question as a non-empty
 * `subtreeTotal().openStartsMs`, but it stops at the first open entry and sums nothing, so a
 * surface that only needs the boolean neither walks the whole subtree nor allocates a total.
 */
export function subtreeRunning(node: NodeWithEntries): boolean {
  for (const entry of node.timeEntries) {
    if (entry.state === 'running' && entry.startMs !== undefined) return true;
  }
  for (const subtask of node.subtasks) {
    if (subtreeRunning(subtask)) return true;
  }
  return false;
}

/**
 * The instant of a wall midnight. The offset in force at that midnight is not the offset of the
 * instant used to guess it, so the candidate is re-checked against its own offset. Where a zone
 * changes exactly at local midnight the first candidate can miss by the size of the change, and
 * where the local midnight never happens at all the two candidates simply trade offsets, so the
 * later one is taken because the transition itself is then the first moment of the local day.
 */
function resolveDayStartMs(wallMs: number, guessOffsetMinutes: number, offsetAt: OffsetAt): number {
  const firstOffsetMinutes = offsetAt(wallMs - guessOffsetMinutes * MS_PER_MINUTE);
  const firstMs = wallMs - firstOffsetMinutes * MS_PER_MINUTE;
  const secondOffsetMinutes = offsetAt(firstMs);
  if (secondOffsetMinutes === firstOffsetMinutes) return firstMs;
  const secondMs = wallMs - secondOffsetMinutes * MS_PER_MINUTE;
  if (offsetAt(secondMs) === secondOffsetMinutes) return secondMs;
  return Math.max(firstMs, secondMs);
}

/** The local wall midnight of a day, read as if the wall clock were UTC. */
function dayWallMs(epochMs: number, offsetMinutes: number): number {
  return Math.floor((epochMs + offsetMinutes * MS_PER_MINUTE) / MS_PER_DAY) * MS_PER_DAY;
}

/** The device-local midnight at or before `nowMs`. */
export function localDayStartMs(nowMs: number, offsetAt: OffsetAt): number {
  const offsetMinutes = offsetAt(nowMs);
  return resolveDayStartMs(dayWallMs(nowMs, offsetMinutes), offsetMinutes, offsetAt);
}

/** Moves a day start by whole wall days, so a DST day is still one step away from its neighbours. */
export function shiftLocalDayStartMs(dayStartMs: number, days: number, offsetAt: OffsetAt): number {
  const offsetMinutes = offsetAt(dayStartMs);
  const shiftedWallMs = dayWallMs(dayStartMs, offsetMinutes) + days * MS_PER_DAY;
  return resolveDayStartMs(shiftedWallMs, offsetMinutes, offsetAt);
}

/** How many local days back every tracked-time surface looks. */
const RECENT_TRACKING_DAYS = 7;

/**
 * The `[fromMs, toMs)` the tracked-time surfaces read, which is the last seven local days up to the
 * midnight that ends today. The rail widget and the palette command both resume from this window,
 * so both ask for it here rather than each rolling its own span back from the clock.
 */
export function recentTrackingWindow(
  nowMs: number,
  offsetAt: OffsetAt,
): { readonly fromMs: number; readonly toMs: number; readonly days: number } {
  const todayStartMs = localDayStartMs(nowMs, offsetAt);
  return {
    fromMs: shiftLocalDayStartMs(todayStartMs, 1 - RECENT_TRACKING_DAYS, offsetAt),
    toMs: shiftLocalDayStartMs(todayStartMs, 1, offsetAt),
    days: RECENT_TRACKING_DAYS,
  };
}

export interface TrackedDayRow {
  /** Stable per node: JSON of the file path, the root line and the relative-line path to the node. */
  readonly key: string;
  /** The most recent entry of this node on this day, which carries the target, title and status. */
  readonly entryOfRecord: TrackedEntry;
  /** Time spent on this node during this day, clipped at both midnights. */
  readonly trackedMs: number;
  readonly running: boolean;
  /** The start of every timer still open on this node, so a tick adds all of them, not one. */
  readonly openStartsMs: readonly number[];
  readonly lastActivityMs: number;
}

export interface TrackedDay {
  readonly dayStartMs: number;
  readonly totalMs: number;
  /** Every open start of the day, which is the union of its rows' and grows the heading alike. */
  readonly openStartsMs: readonly number[];
  readonly rows: readonly TrackedDayRow[];
}

interface MutableDayRow {
  key: string;
  entryOfRecord: TrackedEntry;
  trackedMs: number;
  running: boolean;
  openStartsMs: number[];
  lastActivityMs: number;
}

/**
 * What open timers have added since a grouping was read. A grouping already counts every timer up
 * to the instant it was taken, so a tick only adds what each of them earned after that. Reading
 * every open start rather than one keeps a day whose skip policy left two timers running exact.
 */
export function openTimersExtraMs(
  openStartsMs: readonly number[],
  anchorMs: number,
  nowMs: number,
): number {
  let extra = 0;
  for (const startMs of openStartsMs) extra += Math.max(0, nowMs - Math.max(anchorMs, startMs));
  return extra;
}

/**
 * Where a node sits, as its file, its root line and the relative lines down to it. A ref carries
 * the revision it was read at, so it reports the same node as a new one after every write; this
 * address is what survives a write and identifies the node across snapshots.
 */
export function taskNodeAddress(target: TaskNodeRef): string {
  const path: number[] = [];
  let node = target;
  while (node.type === 'subtask') {
    path.push(node.ref.relativeLine);
    node = node.ref.parent;
  }
  path.reverse();
  return JSON.stringify([node.ref.filePath, node.ref.line, path]);
}

/** One day of the window, with the rows collected into it so far. */
interface DayWindow {
  readonly dayStartMs: number;
  /** The real local midnight that ends the day. */
  readonly dayEndMs: number;
  /** Where time stops counting, which is `nowMs` on the day that holds it. */
  readonly overlapEndMs: number;
  /** True only for the day that contains `nowMs`, so only its rows can look live. */
  readonly current: boolean;
  readonly rows: Map<string, MutableDayRow>;
  /** Only the day holding `nowMs` collects these, because only its total can still grow. */
  readonly openStartsMs: number[];
  totalMs: number;
}

/** The `days` windows ending with today, oldest first, so they can be searched by instant. */
function dayWindows(nowMs: number, offsetAt: OffsetAt, days: number): readonly DayWindow[] {
  const windows: DayWindow[] = [];
  let dayStartMs = localDayStartMs(nowMs, offsetAt);
  let dayEndMs = shiftLocalDayStartMs(dayStartMs, 1, offsetAt);
  for (let index = 0; index < days; index += 1) {
    windows.push({
      dayStartMs,
      dayEndMs,
      overlapEndMs: Math.min(dayEndMs, nowMs),
      current: dayStartMs <= nowMs && nowMs < dayEndMs,
      rows: new Map(),
      openStartsMs: [],
      totalMs: 0,
    });
    dayEndMs = dayStartMs;
    dayStartMs = shiftLocalDayStartMs(dayStartMs, -1, offsetAt);
  }
  windows.reverse();
  return windows;
}

/** Index of the oldest window that has not already ended at `atMs`, by binary search. */
function firstTouchedIndex(windows: readonly DayWindow[], atMs: number): number {
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const day = windows[middle];
    if (day === undefined) break;
    if (day.dayEndMs <= atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** What one entry adds to one day, once it has been cut down to that day. */
interface RowContribution {
  readonly trackedMs: number;
  readonly running: boolean;
  readonly atMs: number;
}

function mergeIntoRow(
  row: MutableDayRow,
  entry: TrackedEntry,
  contribution: RowContribution,
): void {
  row.trackedMs += contribution.trackedMs;
  if (contribution.running) row.running = true;
  if (contribution.atMs >= row.lastActivityMs) {
    row.lastActivityMs = contribution.atMs;
    row.entryOfRecord = entry;
  }
}

/** Folds one contribution into a day, opening the node's row when this is its first. */
function contributeToDay(
  day: DayWindow,
  entry: TrackedEntry,
  key: string,
  contribution: RowContribution,
): void {
  const existing = day.rows.get(key);
  if (existing === undefined) {
    day.rows.set(key, {
      key,
      entryOfRecord: entry,
      trackedMs: contribution.trackedMs,
      running: contribution.running,
      openStartsMs: [],
      lastActivityMs: contribution.atMs,
    });
    return;
  }
  mergeIntoRow(existing, entry, contribution);
}

function addToDay(
  day: DayWindow,
  entry: TrackedEntry,
  key: string,
  span: { readonly startMs: number; readonly endMs: number },
): void {
  const trackedMs = clampedSpanMs(span.startMs, span.endMs, day.dayStartMs, day.overlapEndMs);
  if (trackedMs <= 0) return;
  day.totalMs += trackedMs;
  contributeToDay(day, entry, key, {
    trackedMs,
    running: day.current && entry.entry.state === 'running',
    // A running entry ends at `nowMs`, so this clamp reports `nowMs` on the day that holds it and
    // that day's own end boundary on every earlier one. It also keeps a hand-written end that lies
    // in the future from claiming activity the clock has not reached.
    atMs: Math.min(Math.max(span.endMs, day.dayStartMs), day.overlapEndMs),
  });
}

/**
 * An open timer is what today is about, so its row exists from the instant it is opened rather than
 * from the first millisecond it earns. The contribution is empty, so the day's total is untouched
 * and the rows of a day still add up to its heading. Its start is remembered on the row and on the
 * day, so a tick can add every open timer instead of assuming there is only one.
 */
function openToday(
  day: DayWindow,
  entry: TrackedEntry,
  key: string,
  open: { readonly startMs: number; readonly nowMs: number },
): void {
  contributeToDay(day, entry, key, { trackedMs: 0, running: true, atMs: open.nowMs });
  day.openStartsMs.push(open.startMs);
  day.rows.get(key)?.openStartsMs.push(open.startMs);
}

/** Everything every entry of one grouping is placed against, built once for the whole pass. */
interface Placement {
  readonly windows: readonly DayWindow[];
  /** Nothing before this instant or at and after `endMs` can land in any window. */
  readonly startMs: number;
  readonly endMs: number;
  /** The window holding `nowMs`, which is the only one an open timer can be live on. */
  readonly today: DayWindow | undefined;
  readonly nowMs: number;
}

/** Every window the span touches, in order, once it is known to reach at least one of them. */
function spreadOverDays(
  placement: Placement,
  entry: TrackedEntry,
  span: { readonly startMs: number; readonly endMs: number },
): void {
  const { windows } = placement;
  for (let index = firstTouchedIndex(windows, span.startMs); index < windows.length; index += 1) {
    const day = windows[index];
    if (day === undefined || day.dayStartMs >= span.endMs) break;
    addToDay(day, entry, entry.address, span);
  }
}

/** Adds one entry to every window it touches, rejecting the rest of the window in constant time. */
function placeEntry(placement: Placement, entry: TrackedEntry): void {
  const { today, nowMs } = placement;
  const startMs = measurableStartMs(entry.entry);
  const endMs = measurableEndMs(entry.entry, nowMs);
  if (startMs === undefined || endMs === undefined) return;
  // Every reject is arithmetic on instants the entry already carries, so an entry outside the
  // window costs nothing but two comparisons.
  const outside = endMs <= placement.startMs || startMs >= placement.endMs;
  const opens = today !== undefined && entry.entry.state === 'running';
  if (outside && !opens) return;
  // Before the span, because a timer started this instant has earned nothing and would otherwise be
  // rejected outright, leaving the node it runs on with no row on the day it is running.
  if (opens) openToday(today, entry, entry.address, { startMs, nowMs });
  if (!outside) spreadOverDays(placement, entry, { startMs, endMs });
}

/** Newest day first, rows by last activity descending, days without rows omitted, all frozen. */
function frozenDays(windows: readonly DayWindow[]): readonly TrackedDay[] {
  const days: TrackedDay[] = [];
  for (const day of windows) {
    if (day.rows.size === 0) continue;
    const rows = [...day.rows.values()].sort(
      (left, right) => right.lastActivityMs - left.lastActivityMs,
    );
    for (const row of rows) {
      Object.freeze(row.openStartsMs);
      Object.freeze(row);
    }
    days.push(
      Object.freeze({
        dayStartMs: day.dayStartMs,
        totalMs: day.totalMs,
        openStartsMs: Object.freeze(day.openStartsMs),
        rows: Object.freeze(rows),
      }),
    );
  }
  days.reverse();
  return Object.freeze(days);
}

/**
 * Newest day first, rows by last activity descending, days without rows omitted. A day whose only
 * row is an open timer that has earned nothing yet still counts as a day with a row.
 */
export function groupTrackedDays(
  entries: readonly TrackedEntry[],
  options: { readonly nowMs: number; readonly offsetAt: OffsetAt; readonly days: number },
): readonly TrackedDay[] {
  const { nowMs, offsetAt, days } = options;
  const windows = dayWindows(nowMs, offsetAt, days);
  const oldest = windows[0];
  const newest = windows[windows.length - 1];
  if (oldest === undefined || newest === undefined) return Object.freeze([]);
  const placement: Placement = {
    windows,
    startMs: oldest.dayStartMs,
    endMs: newest.overlapEndMs,
    today: newest.current ? newest : undefined,
    nowMs,
  };
  for (const entry of entries) placeEntry(placement, entry);
  return frozenDays(windows);
}

/** When an entry last mattered, and whether it still does. A broken entry has no candidacy. */
interface ResumeCandidate {
  readonly running: boolean;
  readonly atMs: number;
}

function resumeCandidate(entry: TimeEntrySnapshot): ResumeCandidate | undefined {
  const startMs = measurableStartMs(entry);
  if (startMs === undefined) return undefined;
  if (entry.state === 'running') return { running: true, atMs: startMs };
  return entry.endMs === undefined ? undefined : { running: false, atMs: entry.endMs };
}

function beatsResume(candidate: ResumeCandidate, best: ResumeCandidate | undefined): boolean {
  if (best === undefined) return true;
  if (candidate.running !== best.running) return candidate.running;
  return candidate.atMs > best.atMs;
}

/** The node with the most recent activity, where a running entry beats every closed one. */
export function resumeTarget(entries: readonly TrackedEntry[]): TrackedEntry | undefined {
  let best: TrackedEntry | undefined;
  let bestCandidate: ResumeCandidate | undefined;
  for (const entry of entries) {
    const candidate = resumeCandidate(entry.entry);
    if (candidate === undefined || !beatsResume(candidate, bestCandidate)) continue;
    best = entry;
    bestCandidate = candidate;
  }
  return best;
}
