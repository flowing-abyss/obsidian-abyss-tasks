import {
  addEntryToTotal,
  type TimeEntrySnapshot,
  type TrackedEntry,
  type TrackedTotal,
} from '../domain/timeTracking';
import type { SubtaskSnapshot, TaskNodeRef, TaskRef, TaskSnapshot } from '../domain/types';

const MS_PER_DAY = 86_400_000;
/** A closed entry fills every day it crosses, so one absurd span cannot fill the whole index. */
const MAX_DAY_KEYS = 400;

const EMPTY_ENTRIES: readonly TrackedEntry[] = Object.freeze([]);
const EMPTY_TOTAL: TrackedTotal = Object.freeze({
  closedMs: 0,
  openStartsMs: Object.freeze([]),
});

/** A closed entry with the instants the buckets need, so nothing is read back as optional. */
interface ClosedSpan {
  readonly tracked: TrackedEntry;
  readonly startMs: number;
  readonly endMs: number;
}

/** What one file contributes, gathered in a single walk of its roots. */
interface FileCollection {
  readonly closed: ClosedSpan[];
  readonly running: TrackedEntry[];
  readonly total: { closedMs: number; openStartsMs: number[] };
}

/** Per-file bookkeeping, so updating a file only touches the buckets that file filled. */
interface FileEntries {
  readonly dayKeys: ReadonlySet<number>;
  readonly total: TrackedTotal;
}

interface WalkContext {
  readonly filePath: string;
  readonly root: TaskRef;
  readonly collection: FileCollection;
}

interface NodeWalk {
  readonly node: TaskSnapshot | SubtaskSnapshot;
  readonly target: TaskNodeRef;
  readonly parentTitle: string | undefined;
}

function trackedEntry(
  context: WalkContext,
  walk: NodeWalk,
  entry: TimeEntrySnapshot,
): TrackedEntry {
  return Object.freeze({
    filePath: context.filePath,
    root: context.root,
    target: walk.target,
    title: walk.node.title,
    ...(walk.parentTitle === undefined ? {} : { parentTitle: walk.parentTitle }),
    status: walk.node.status,
    entry,
  });
}

/** A broken entry carries no instants, so it counts nothing and never reaches a query. */
function collectEntry(context: WalkContext, walk: NodeWalk, entry: TimeEntrySnapshot): void {
  const { startMs, endMs } = entry;
  if (entry.state === 'broken' || startMs === undefined) return;
  addEntryToTotal(context.collection.total, entry);
  const tracked = trackedEntry(context, walk, entry);
  if (entry.state === 'running') context.collection.running.push(tracked);
  else if (endMs !== undefined) context.collection.closed.push({ tracked, startMs, endMs });
}

function collectNode(context: WalkContext, walk: NodeWalk): void {
  for (const entry of walk.node.timeEntries) collectEntry(context, walk, entry);
  for (const child of walk.node.subtasks) {
    collectNode(context, {
      node: child,
      target: { type: 'subtask', ref: child.ref },
      parentTitle: walk.node.title,
    });
  }
}

function collectFile(filePath: string, roots: readonly TaskSnapshot[]): FileCollection {
  const collection: FileCollection = {
    closed: [],
    running: [],
    total: { closedMs: 0, openStartsMs: [] },
  };
  for (const root of roots) {
    collectNode(
      { filePath, root: root.ref, collection },
      { node: root, target: { type: 'task', ref: root.ref }, parentTitle: undefined },
    );
  }
  return collection;
}

function startMsOf(tracked: TrackedEntry): number {
  return tracked.entry.startMs ?? 0;
}

/** Stable across calls: the instant first, then the file, then the root line. */
function compareTrackedEntries(left: TrackedEntry, right: TrackedEntry): number {
  const startOrder = startMsOf(left) - startMsOf(right);
  if (startOrder !== 0) return startOrder;
  const pathOrder = left.filePath.localeCompare(right.filePath);
  return pathOrder !== 0 ? pathOrder : left.root.line - right.root.line;
}

function orderedResult(entries: TrackedEntry[]): readonly TrackedEntry[] {
  if (entries.length === 0) return EMPTY_ENTRIES;
  entries.sort(compareTrackedEntries);
  return Object.freeze(entries);
}

/** The day buckets are coarse, so a result is still cut down to the exact half-open range. */
function overlapsRange(entry: TimeEntrySnapshot, fromMs: number, toMs: number): boolean {
  const { startMs, endMs } = entry;
  if (startMs === undefined || endMs === undefined) return false;
  return startMs < toMs && endMs > fromMs;
}

function frozenTotal(total: FileCollection['total']): TrackedTotal {
  return Object.freeze({
    closedMs: total.closedMs,
    openStartsMs: Object.freeze(total.openStartsMs),
  });
}

/**
 * The incremental read model behind `TimeTrackingQueryApi`.
 *
 * Entries are lifted out of the indexed snapshots once per file update and then only read.
 * Closed entries live in epoch-UTC day buckets, which makes a range query cost the days it
 * asks for rather than the vault; running entries stay in their own small set, so a ticking
 * consumer never walks the buckets. Returned arrays and entries are frozen and shared.
 */
export class TimeEntryIndex {
  private readonly byFile = new Map<string, FileEntries>();
  private readonly byUtcDay = new Map<number, TrackedEntry[]>();
  private readonly runningByFile = new Map<string, readonly TrackedEntry[]>();

  updateFile(filePath: string, roots: readonly TaskSnapshot[]): void {
    this.removeFile(filePath);
    const collection = collectFile(filePath, roots);
    if (collection.closed.length === 0 && collection.running.length === 0) return;
    const dayKeys = new Set<number>();
    for (const span of collection.closed) this.bucketClosedSpan(span, dayKeys);
    if (collection.running.length > 0) {
      this.runningByFile.set(filePath, Object.freeze(collection.running));
    }
    this.byFile.set(filePath, { dayKeys, total: frozenTotal(collection.total) });
  }

  removeFile(filePath: string): void {
    const previous = this.byFile.get(filePath);
    this.byFile.delete(filePath);
    this.runningByFile.delete(filePath);
    if (previous === undefined) return;
    for (const dayKey of previous.dayKeys) this.dropFileFromDay(filePath, dayKey);
  }

  clear(): void {
    this.byFile.clear();
    this.byUtcDay.clear();
    this.runningByFile.clear();
  }

  activeEntries(): readonly TrackedEntry[] {
    const running: TrackedEntry[] = [];
    for (const entries of this.runningByFile.values()) running.push(...entries);
    return orderedResult(running);
  }

  /**
   * Closed entries overlapping `[fromMs, toMs)` plus every running entry started before `toMs`,
   * because a running entry keeps counting up to the moment the caller reads it.
   */
  entriesOverlapping(fromMs: number, toMs: number): readonly TrackedEntry[] {
    if (toMs <= fromMs) return EMPTY_ENTRIES;
    const found = new Set<TrackedEntry>();
    this.collectClosedInRange(found, fromMs, toMs);
    this.collectRunningStartedBefore(found, toMs);
    return orderedResult([...found]);
  }

  fileTotal(filePath: string): TrackedTotal {
    return this.byFile.get(filePath)?.total ?? EMPTY_TOTAL;
  }

  /** A bucket holds whole entries, so every candidate day is still cut down to the exact range. */
  private collectClosedInRange(found: Set<TrackedEntry>, fromMs: number, toMs: number): void {
    const lastKey = Math.floor((toMs - 1) / MS_PER_DAY);
    for (let dayKey = Math.floor(fromMs / MS_PER_DAY); dayKey <= lastKey; dayKey += 1) {
      for (const tracked of this.byUtcDay.get(dayKey) ?? EMPTY_ENTRIES) {
        if (overlapsRange(tracked.entry, fromMs, toMs)) found.add(tracked);
      }
    }
  }

  private collectRunningStartedBefore(found: Set<TrackedEntry>, toMs: number): void {
    for (const entries of this.runningByFile.values()) {
      for (const tracked of entries) {
        if (startMsOf(tracked) < toMs) found.add(tracked);
      }
    }
  }

  private bucketClosedSpan(span: ClosedSpan, dayKeys: Set<number>): void {
    const firstKey = Math.floor(span.startMs / MS_PER_DAY);
    // The range is half-open, so an entry ending exactly at midnight stops on the previous day.
    const spannedKey = Math.floor((span.endMs - 1) / MS_PER_DAY);
    const lastKey = Math.min(Math.max(firstKey, spannedKey), firstKey + MAX_DAY_KEYS - 1);
    for (let dayKey = firstKey; dayKey <= lastKey; dayKey += 1) {
      const bucket = this.byUtcDay.get(dayKey);
      if (bucket === undefined) this.byUtcDay.set(dayKey, [span.tracked]);
      else bucket.push(span.tracked);
      dayKeys.add(dayKey);
    }
  }

  private dropFileFromDay(filePath: string, dayKey: number): void {
    const bucket = this.byUtcDay.get(dayKey);
    if (bucket === undefined) return;
    const remaining = bucket.filter((tracked) => tracked.filePath !== filePath);
    if (remaining.length > 0) this.byUtcDay.set(dayKey, remaining);
    else this.byUtcDay.delete(dayKey);
  }
}
