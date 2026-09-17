import type { OffsetAt, ParsedTimeEntry } from './timeEntry';
import type { TaskNodeRef, TaskRef, TaskStatus } from './types';

export type { TimeEntryIssue } from './timeEntry';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** One parsed entry line kept next to the source it came from, so writes can find it again. */
export interface TimeEntrySnapshot extends ParsedTimeEntry {
  readonly relativeLine: number;
  readonly originalMarkdown: string;
}

/** One entry lifted out of the tree, carrying the node it belongs to. */
export interface TrackedEntry {
  readonly filePath: string;
  readonly root: TaskRef;
  readonly target: TaskNodeRef;
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

export interface TrackedDayRow {
  /** Stable per node: JSON of the file path, the root line and the relative-line path to the node. */
  readonly key: string;
  /** The most recent entry of this node on this day, which carries the target, title and status. */
  readonly entryOfRecord: TrackedEntry;
  /** Time spent on this node during this day, clipped at both midnights. */
  readonly trackedMs: number;
  readonly running: boolean;
  readonly lastActivityMs: number;
}

export interface TrackedDay {
  readonly dayStartMs: number;
  readonly totalMs: number;
  readonly rows: readonly TrackedDayRow[];
}

interface MutableDayRow {
  key: string;
  entryOfRecord: TrackedEntry;
  trackedMs: number;
  running: boolean;
  lastActivityMs: number;
}

/** The relative lines from the root task down to the node, which is empty for a root task. */
function relativeLinePath(target: TaskNodeRef): readonly number[] {
  const path: number[] = [];
  let node = target;
  while (node.type === 'subtask') {
    path.push(node.ref.relativeLine);
    node = node.ref.parent;
  }
  return path.reverse();
}

function nodeKey(entry: TrackedEntry): string {
  return JSON.stringify([entry.filePath, entry.root.line, relativeLinePath(entry.target)]);
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

function addToDay(
  day: DayWindow,
  entry: TrackedEntry,
  key: string,
  span: { readonly startMs: number; readonly endMs: number },
): void {
  const trackedMs = clampedSpanMs(span.startMs, span.endMs, day.dayStartMs, day.overlapEndMs);
  if (trackedMs <= 0) return;
  day.totalMs += trackedMs;
  const contribution: RowContribution = {
    trackedMs,
    running: day.current && entry.entry.state === 'running',
    // A running entry ends at `nowMs`, so this clamp reports `nowMs` on the day that holds it and
    // that day's own end boundary on every earlier one. It also keeps a hand-written end that lies
    // in the future from claiming activity the clock has not reached.
    atMs: Math.min(Math.max(span.endMs, day.dayStartMs), day.overlapEndMs),
  };
  const existing = day.rows.get(key);
  if (existing === undefined) {
    day.rows.set(key, {
      key,
      entryOfRecord: entry,
      trackedMs,
      running: contribution.running,
      lastActivityMs: contribution.atMs,
    });
    return;
  }
  mergeIntoRow(existing, entry, contribution);
}

/** Adds one entry to every window it touches, rejecting the rest of the window in constant time. */
function placeEntry(
  windows: readonly DayWindow[],
  bounds: { readonly startMs: number; readonly endMs: number },
  entry: TrackedEntry,
  nowMs: number,
): void {
  const startMs = measurableStartMs(entry.entry);
  const endMs = measurableEndMs(entry.entry, nowMs);
  if (startMs === undefined || endMs === undefined) return;
  if (endMs <= bounds.startMs || startMs >= bounds.endMs) return;
  const span = { startMs, endMs };
  const key = nodeKey(entry);
  for (let index = firstTouchedIndex(windows, startMs); index < windows.length; index += 1) {
    const day = windows[index];
    if (day === undefined || day.dayStartMs >= endMs) break;
    addToDay(day, entry, key, span);
  }
}

/** Newest day first, rows by last activity descending, days without rows omitted, all frozen. */
function frozenDays(windows: readonly DayWindow[]): readonly TrackedDay[] {
  const days: TrackedDay[] = [];
  for (const day of windows) {
    if (day.rows.size === 0) continue;
    const rows = [...day.rows.values()].sort(
      (left, right) => right.lastActivityMs - left.lastActivityMs,
    );
    for (const row of rows) Object.freeze(row);
    days.push(
      Object.freeze({
        dayStartMs: day.dayStartMs,
        totalMs: day.totalMs,
        rows: Object.freeze(rows),
      }),
    );
  }
  days.reverse();
  return Object.freeze(days);
}

/** Newest day first, rows by last activity descending, days without rows omitted. */
export function groupTrackedDays(
  entries: readonly TrackedEntry[],
  options: { readonly nowMs: number; readonly offsetAt: OffsetAt; readonly days: number },
): readonly TrackedDay[] {
  const { nowMs, offsetAt, days } = options;
  const windows = dayWindows(nowMs, offsetAt, days);
  const oldest = windows[0];
  const newest = windows[windows.length - 1];
  if (oldest === undefined || newest === undefined) return Object.freeze([]);
  const bounds = { startMs: oldest.dayStartMs, endMs: newest.overlapEndMs };
  for (const entry of entries) placeEntry(windows, bounds, entry, nowMs);
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
