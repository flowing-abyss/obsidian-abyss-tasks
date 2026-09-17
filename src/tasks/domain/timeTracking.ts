import type { OffsetAt, TimeEntryIssue } from './timeEntry';
import type { TaskNodeRef, TaskRef, TaskStatus } from './types';

export type { TimeEntryIssue };

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** One parsed entry line kept next to the source it came from, so writes can find it again. */
export interface TimeEntrySnapshot {
  readonly relativeLine: number;
  readonly originalMarkdown: string;
  readonly state: 'running' | 'closed' | 'broken';
  readonly startMs?: number;
  readonly endMs?: number;
  readonly tail?: string;
  readonly issue?: TimeEntryIssue;
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
  return Math.max(0, Math.min(endMs, toMs) - Math.max(startMs, fromMs));
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
 * The offset at a local midnight is not the offset that was in force at `guessOffsetMinutes`, so the
 * wall midnight is re-resolved once against the offset of its own approximate instant.
 */
function resolveDayStartMs(
  dayWallMs: number,
  guessOffsetMinutes: number,
  offsetAt: OffsetAt,
): number {
  return dayWallMs - offsetAt(dayWallMs - guessOffsetMinutes * MS_PER_MINUTE) * MS_PER_MINUTE;
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

/** A running entry is active right now, a closed one last counted when it ended inside the day. */
function activityMs(
  entry: TimeEntrySnapshot,
  dayStartMs: number,
  dayEndMs: number,
  nowMs: number,
): number {
  if (entry.state === 'running') return nowMs;
  if (entry.endMs === undefined) return dayStartMs;
  return Math.min(Math.max(entry.endMs, dayStartMs), dayEndMs);
}

function mergeIntoRow(
  row: MutableDayRow,
  entry: TrackedEntry,
  trackedMs: number,
  atMs: number,
): void {
  row.trackedMs += trackedMs;
  if (entry.entry.state === 'running') row.running = true;
  if (atMs >= row.lastActivityMs) {
    row.lastActivityMs = atMs;
    row.entryOfRecord = entry;
  }
}

function collectDay(
  entries: readonly TrackedEntry[],
  dayStartMs: number,
  dayEndMs: number,
  nowMs: number,
): TrackedDay | undefined {
  const rows = new Map<string, MutableDayRow>();
  let dayTotalMs = 0;
  for (const entry of entries) {
    const trackedMs = entryOverlapMs(entry.entry, dayStartMs, dayEndMs, nowMs);
    if (trackedMs <= 0) continue;
    dayTotalMs += trackedMs;
    const key = nodeKey(entry);
    const atMs = activityMs(entry.entry, dayStartMs, dayEndMs, nowMs);
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, {
        key,
        entryOfRecord: entry,
        trackedMs,
        running: entry.entry.state === 'running',
        lastActivityMs: atMs,
      });
      continue;
    }
    mergeIntoRow(existing, entry, trackedMs, atMs);
  }
  if (rows.size === 0) return undefined;
  const ordered = [...rows.values()].sort(
    (left, right) => right.lastActivityMs - left.lastActivityMs,
  );
  return { dayStartMs, totalMs: dayTotalMs, rows: Object.freeze(ordered) };
}

/** Newest day first, rows by last activity descending, days without rows omitted. */
export function groupTrackedDays(
  entries: readonly TrackedEntry[],
  options: { readonly nowMs: number; readonly offsetAt: OffsetAt; readonly days: number },
): readonly TrackedDay[] {
  const { nowMs, offsetAt, days } = options;
  const grouped: TrackedDay[] = [];
  let dayStartMs = localDayStartMs(nowMs, offsetAt);
  let dayEndMs = shiftLocalDayStartMs(dayStartMs, 1, offsetAt);
  for (let index = 0; index < days; index += 1) {
    const day = collectDay(entries, dayStartMs, dayEndMs, nowMs);
    if (day !== undefined) grouped.push(day);
    dayEndMs = dayStartMs;
    dayStartMs = shiftLocalDayStartMs(dayStartMs, -1, offsetAt);
  }
  return Object.freeze(grouped);
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
