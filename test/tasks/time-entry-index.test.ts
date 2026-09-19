import { TFile, type CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import {
  taskNodeAddress,
  type TimeEntrySnapshot,
  type TrackedEntry,
} from '../../src/tasks/domain/timeTracking';
import type { SubtaskSnapshot, TaskSnapshot } from '../../src/tasks/domain/types';
import { TimeEntryIndex } from '../../src/tasks/infrastructure/TimeEntryIndex';
import {
  captureChangedCallback,
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  seedTaskCache,
  subtask,
  task,
  useRealMoment,
} from '../helpers';

useRealMoment();

const MS_PER_DAY = 86_400_000;
const RANGE_FROM_MS = Date.parse('2026-09-14T00:00:00Z');
const RANGE_TO_MS = Date.parse('2026-09-21T00:00:00Z');
const RANGE_DAYS = 7;
/** The bucket cap of one closed entry, mirrored here so the cap stays observable from outside. */
const MAX_DAY_KEYS = 400;
const EPOCH_MS = Date.parse('1970-01-01T00:00:00Z');
const FAR_FUTURE_MS = Date.parse('2100-01-01T00:00:00Z');
/** A span wide enough to exceed a small bucket count and stay under a large one. */
const WIDE_FROM_MS = Date.parse('2026-09-01T00:00:00Z');
const WIDE_TO_MS = Date.parse('2026-10-01T00:00:00Z');
const WIDE_DAYS = 30;
const DISTANT_DAYS = 60;

type DayBucket = Map<string, readonly TrackedEntry[]>;

/**
 * The day buckets are private, so only their own maps can show that a query skipped them or that an
 * update left another file alone. Reading them keeps both guarantees structural rather than timed.
 */
function dayBuckets(index: TimeEntryIndex): Map<number, DayBucket> {
  return (index as unknown as { readonly byUtcDay: Map<number, DayBucket> }).byUtcDay;
}

function dayKeyOf(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);
}

function fileEntriesOn(
  index: TimeEntryIndex,
  day: string,
  filePath: string,
): readonly TrackedEntry[] {
  return expectDefined(expectDefined(dayBuckets(index).get(dayKeyOf(day))).get(filePath));
}

function closedEntry(start: string, end: string, relativeLine: number): TimeEntrySnapshot {
  return {
    state: 'closed',
    startMs: Date.parse(start),
    endMs: Date.parse(end),
    relativeLine,
    originalMarkdown: `    - ${start} → ${end}`,
  };
}

function runningEntry(start: string, relativeLine: number): TimeEntrySnapshot {
  return {
    state: 'running',
    startMs: Date.parse(start),
    relativeLine,
    originalMarkdown: `    - ${start} →`,
  };
}

function brokenEntry(relativeLine: number): TimeEntrySnapshot {
  return {
    state: 'broken',
    issue: 'end-before-start',
    relativeLine,
    originalMarkdown: '    - 2026-09-17T10:00:00Z → 2026-09-17T09:00:00Z',
  };
}

function titlesOf(entries: readonly TrackedEntry[]): readonly string[] {
  return entries.map((tracked) => tracked.title);
}

/** One root with a child, both carrying entries, so targets and parent titles are observable. */
function trackedFile(): { readonly root: TaskSnapshot; readonly child: SubtaskSnapshot } {
  const child = subtask({
    title: 'Child',
    status: 'in-progress',
    root: { filePath: 'a.md', line: 0 },
    ref: { relativeLine: 4 },
    timeEntries: [
      runningEntry('2026-09-18T14:05:00Z', 5),
      brokenEntry(6),
      closedEntry('2026-09-17T08:00:00Z', '2026-09-17T08:30:00Z', 7),
    ],
  });
  const root = task({
    title: 'Root',
    source: { filePath: 'a.md', line: 0 },
    subtasks: [child],
    timeEntries: [
      closedEntry('2026-09-17T09:12:00Z', '2026-09-17T10:42:00Z', 1),
      runningEntry('2026-09-19T06:00:00Z', 2),
      brokenEntry(3),
    ],
  });
  return { root, child };
}

function rangeFile(): TaskSnapshot {
  return task({
    title: 'Range root',
    source: { filePath: 'range.md', line: 0 },
    timeEntries: [
      closedEntry('2026-09-13T23:00:00Z', '2026-09-14T01:00:00Z', 1),
      closedEntry('2026-09-20T23:00:00Z', '2026-09-21T02:00:00Z', 2),
      closedEntry('2026-09-12T08:00:00Z', '2026-09-12T09:00:00Z', 3),
      closedEntry('2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z', 4),
      closedEntry('2026-09-16T22:00:00Z', '2026-09-18T03:00:00Z', 5),
      closedEntry('2026-09-13T22:00:00Z', '2026-09-14T00:00:00Z', 6),
      runningEntry('2026-09-10T07:00:00Z', 7),
      brokenEntry(8),
    ],
  });
}

/** Relative lines are unique per entry, so a query result reads back as the lines it found. */
function rangeLines(index: TimeEntryIndex): readonly number[] {
  return index
    .entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)
    .map((tracked) => tracked.entry.relativeLine);
}

/** One closed entry on each of many days well outside the wide range, purely to fill buckets. */
function distantRoot(dayCount: number): TaskSnapshot {
  const firstMs = Date.parse('2027-01-01T08:00:00Z');
  return task({
    title: 'Distant',
    source: { filePath: 'distant.md', line: 0 },
    timeEntries: Array.from({ length: dayCount }, (_unused, offset) => ({
      state: 'closed' as const,
      startMs: firstMs + offset * MS_PER_DAY,
      endMs: firstMs + offset * MS_PER_DAY + 3_600_000,
      relativeLine: offset + 1,
      originalMarkdown: `    - a distant entry ${offset}`,
    })),
  });
}

/** One closed entry far longer than the bucket cap, so the cap and its cleanup are observable. */
function longSpanRoot(startMs: number): TaskSnapshot {
  return task({
    title: 'Runaway',
    source: { filePath: 'long.md', line: 0 },
    timeEntries: [
      {
        state: 'closed',
        startMs,
        endMs: startMs + 500 * MS_PER_DAY,
        relativeLine: 1,
        originalMarkdown: '    - a span of five hundred days',
      },
    ],
  });
}

const TRACKED_CONTENT = [
  '- [ ] Track me',
  '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:42:00+03:00',
].join('\n');

const RUNNING_CONTENT = [TRACKED_CONTENT, '    - 2026-09-18T14:05:00+03:00 →'].join('\n');

function rootCache(): CachedMetadata {
  return {
    listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
  } as CachedMetadata;
}

function markdownFile(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`missing ${path}`);
  return file;
}

describe('time entry index', () => {
  it('reports only running entries with their node, parent title and target', () => {
    const index = new TimeEntryIndex();
    const { root, child } = trackedFile();
    index.updateFile('a.md', [root]);

    const active = index.activeEntries();
    expect(
      active.map((tracked) => ({
        title: tracked.title,
        parentTitle: tracked.parentTitle,
        status: tracked.status,
        filePath: tracked.filePath,
        relativeLine: tracked.entry.relativeLine,
      })),
    ).toEqual([
      {
        title: 'Child',
        parentTitle: 'Root',
        status: 'in-progress',
        filePath: 'a.md',
        relativeLine: 5,
      },
      {
        title: 'Root',
        parentTitle: undefined,
        status: 'open',
        filePath: 'a.md',
        relativeLine: 2,
      },
    ]);
    expect(expectDefined(active[0]).target).toEqual({ type: 'subtask', ref: child.ref });
    expect(expectDefined(active[1]).target).toEqual({ type: 'task', ref: root.ref });
    expect(expectDefined(active[1]).root).toBe(root.ref);
  });

  it('carries the node address and the root address every surface keys by', () => {
    const index = new TimeEntryIndex();
    const { root, child } = trackedFile();
    index.updateFile('a.md', [root]);

    const active = index.activeEntries();
    const rootAddress = taskNodeAddress({ type: 'task', ref: root.ref });

    expect(expectDefined(active[0]).address).toBe(
      taskNodeAddress({ type: 'subtask', ref: child.ref }),
    );
    expect(expectDefined(active[0]).rootAddress).toBe(rootAddress);
    expect(expectDefined(active[1]).address).toBe(rootAddress);
    expect(expectDefined(active[1]).rootAddress).toBe(rootAddress);
  });

  it('totals closed time per file, lists open starts and ignores broken entries', () => {
    const index = new TimeEntryIndex();
    const { root } = trackedFile();
    index.updateFile('a.md', [root]);

    expect(index.fileTotal('a.md')).toEqual({
      closedMs: 90 * 60_000 + 30 * 60_000,
      openStartsMs: [Date.parse('2026-09-19T06:00:00Z'), Date.parse('2026-09-18T14:05:00Z')],
    });
    expect(index.fileTotal('missing.md')).toEqual({ closedMs: 0, openStartsMs: [] });
  });

  it('answers a seven day range by exact overlap and lists a spanning entry once', () => {
    const index = new TimeEntryIndex();
    index.updateFile('range.md', [rangeFile()]);

    // Lines 1 and 2 cross the range edges, 5 spans three UTC days, 7 is still running.
    expect(rangeLines(index)).toEqual([7, 1, 5, 2]);
  });

  it('keeps the entries and total of another file identical when one file is updated', () => {
    const index = new TimeEntryIndex();
    const { root } = trackedFile();
    index.updateFile('a.md', [root]);
    index.updateFile('b.md', [
      task({
        title: 'Other',
        source: { filePath: 'b.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T12:00:00Z', '2026-09-17T13:00:00Z', 1)],
      }),
    ]);
    const before = index
      .entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)
      .filter((tracked) => tracked.filePath === 'b.md');
    const beforeTotal = index.fileTotal('b.md');
    expect(before).toHaveLength(1);

    index.updateFile('a.md', [
      task({
        title: 'Root',
        source: { filePath: 'a.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T09:12:00Z', '2026-09-17T09:20:00Z', 1)],
      }),
    ]);

    const after = index
      .entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)
      .filter((tracked) => tracked.filePath === 'b.md');
    expect(after).toHaveLength(1);
    expect(expectDefined(after[0])).toBe(expectDefined(before[0]));
    expect(index.fileTotal('b.md')).toBe(beforeTotal);
    expect(index.activeEntries()).toEqual([]);
  });

  it('drops stale entries after a removal and after a smaller update', () => {
    const index = new TimeEntryIndex();
    const { root } = trackedFile();
    index.updateFile('a.md', [root]);
    expect(index.activeEntries()).toHaveLength(2);

    index.updateFile('a.md', [
      task({
        title: 'Root',
        source: { filePath: 'a.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T09:12:00Z', '2026-09-17T10:42:00Z', 1)],
      }),
    ]);
    expect(index.activeEntries()).toEqual([]);
    expect(index.entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)).toHaveLength(1);
    expect(index.fileTotal('a.md')).toEqual({ closedMs: 90 * 60_000, openStartsMs: [] });

    index.removeFile('a.md');
    expect(index.entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)).toEqual([]);
    expect(index.fileTotal('a.md')).toEqual({ closedMs: 0, openStartsMs: [] });
  });

  it('bounds how many day buckets one entry can fill', () => {
    const index = new TimeEntryIndex();
    const startMs = Date.parse('2026-01-01T00:00:00Z');
    index.updateFile('long.md', [longSpanRoot(startMs)]);

    expect(index.entriesOverlapping(startMs, startMs + MS_PER_DAY)).toHaveLength(1);
    expect(
      index.entriesOverlapping(startMs + 399 * MS_PER_DAY, startMs + 400 * MS_PER_DAY),
    ).toHaveLength(1);
    // Between the cap and the day it ends on the entry is not bucketed, which is what keeps one
    // absurd span cheap.
    expect(
      index.entriesOverlapping(startMs + 400 * MS_PER_DAY, startMs + 401 * MS_PER_DAY),
    ).toEqual([]);
    expect(index.fileTotal('long.md').closedMs).toBe(500 * MS_PER_DAY);
  });

  it('finds a span past the cap on the day it ends as well as the day it starts', () => {
    const index = new TimeEntryIndex();
    // A year hand-typed as 2062 instead of 2026 leaves an entry running for decades, and whoever
    // has to notice it is reading the day it ends on.
    index.updateFile('typo.md', [
      task({
        title: 'Mistyped year',
        source: { filePath: 'typo.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T09:12:00Z', '2062-09-17T10:42:00Z', 1)],
      }),
    ]);
    const lastDayMs = dayKeyOf('2062-09-17') * MS_PER_DAY;

    expect(index.entriesOverlapping(RANGE_FROM_MS, RANGE_TO_MS)).toHaveLength(1);
    expect(index.entriesOverlapping(lastDayMs, lastDayMs + MS_PER_DAY)).toHaveLength(1);

    index.removeFile('typo.md');

    expect(index.entriesOverlapping(lastDayMs, lastDayMs + MS_PER_DAY)).toEqual([]);
    expect(dayBuckets(index).size).toBe(0);
  });

  it('empties every bucket a capped span filled when its file is removed', () => {
    const index = new TimeEntryIndex();
    const startMs = Date.parse('2026-01-01T00:00:00Z');
    index.updateFile('long.md', [longSpanRoot(startMs)]);
    // The capped run of days plus the single day the span ends on.
    expect(dayBuckets(index).size).toBe(MAX_DAY_KEYS + 1);

    index.removeFile('long.md');

    const middleMs = startMs + 200 * MS_PER_DAY;
    expect(index.entriesOverlapping(middleMs, middleMs + MS_PER_DAY)).toEqual([]);
    expect(dayBuckets(index).size).toBe(0);
  });

  it('reads the buckets it has when the range is wider than them, and steps days when it is not', () => {
    const index = new TimeEntryIndex();
    index.updateFile('range.md', [rangeFile()]);
    const lookups = vi.spyOn(dayBuckets(index), 'get');

    const wide = index.entriesOverlapping(EPOCH_MS, FAR_FUTURE_MS);

    expect(wide.map((tracked) => tracked.entry.relativeLine)).toEqual([7, 3, 6, 1, 5, 2, 4]);
    expect(lookups).not.toHaveBeenCalled();

    expect(rangeLines(index)).toEqual([7, 1, 5, 2]);
    expect(lookups).toHaveBeenCalledTimes(RANGE_DAYS);
  });

  it('returns the same entries whether the range guard or the day stepping answers', () => {
    const index = new TimeEntryIndex();
    index.updateFile('range.md', [rangeFile()]);
    const lookups = vi.spyOn(dayBuckets(index), 'get');

    // Nine buckets against thirty requested days, so the guard reads the buckets it has.
    expect(dayBuckets(index).size).toBeLessThan(WIDE_DAYS);
    const guarded = index.entriesOverlapping(WIDE_FROM_MS, WIDE_TO_MS);
    expect(lookups).not.toHaveBeenCalled();

    // The same range and the same entries in it, but now more buckets than days asked for.
    index.updateFile('distant.md', [distantRoot(DISTANT_DAYS)]);
    expect(dayBuckets(index).size).toBeGreaterThan(WIDE_DAYS);
    lookups.mockClear();
    const stepped = index.entriesOverlapping(WIDE_FROM_MS, WIDE_TO_MS);

    expect(lookups).toHaveBeenCalledTimes(WIDE_DAYS);
    expect(stepped).toEqual(guarded);
    expect(stepped.map((tracked) => tracked.entry.relativeLine)).toEqual([7, 3, 6, 1, 5, 2, 4]);
  });

  it('leaves the entries and the buckets of another file alone when one file is updated', () => {
    const index = new TimeEntryIndex();
    index.updateFile('b.md', [
      task({
        title: 'Other',
        source: { filePath: 'b.md', line: 0 },
        timeEntries: [
          closedEntry('2026-09-17T12:00:00Z', '2026-09-17T13:00:00Z', 1),
          closedEntry('2026-09-19T12:00:00Z', '2026-09-19T13:00:00Z', 2),
        ],
      }),
    ]);
    index.updateFile('a.md', [
      task({
        title: 'Root',
        source: { filePath: 'a.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T09:00:00Z', '2026-09-17T10:00:00Z', 1)],
      }),
    ]);
    const sharedBucket = expectDefined(dayBuckets(index).get(dayKeyOf('2026-09-17')));
    const soloBucket = expectDefined(dayBuckets(index).get(dayKeyOf('2026-09-19')));
    const otherEntries = fileEntriesOn(index, '2026-09-17', 'b.md');

    index.updateFile('a.md', [
      task({
        title: 'Root',
        source: { filePath: 'a.md', line: 0 },
        timeEntries: [closedEntry('2026-09-17T14:00:00Z', '2026-09-17T15:00:00Z', 1)],
      }),
    ]);

    // Rewriting one file replaces only its own array in the day it shares, and never reads the day
    // it does not touch at all.
    expect(fileEntriesOn(index, '2026-09-17', 'b.md')).toBe(otherEntries);
    expect(dayBuckets(index).get(dayKeyOf('2026-09-17'))).toBe(sharedBucket);
    expect(dayBuckets(index).get(dayKeyOf('2026-09-19'))).toBe(soloBucket);
    expect(rangeLines(index)).toEqual([1, 1, 2]);
  });

  it('orders entries that share one stamp by the entry line, whatever order they arrive in', () => {
    const index = new TimeEntryIndex();
    const startedAt = '2026-09-17T09:00:00Z';
    index.updateFile('tie.md', [
      task({
        title: 'Tie',
        source: { filePath: 'tie.md', line: 0 },
        timeEntries: [
          closedEntry(startedAt, '2026-09-17T09:30:00Z', 9),
          closedEntry(startedAt, '2026-09-17T10:00:00Z', 2),
          closedEntry(startedAt, '2026-09-17T11:00:00Z', 5),
          runningEntry(startedAt, 7),
          runningEntry(startedAt, 4),
        ],
      }),
    ]);

    expect(rangeLines(index)).toEqual([2, 4, 5, 7, 9]);
    expect(index.activeEntries().map((tracked) => tracked.entry.relativeLine)).toEqual([4, 7]);
  });

  it('hands back one active array until a file changes, so a ticker can skip by reference', () => {
    const index = new TimeEntryIndex();
    const { root } = trackedFile();
    index.updateFile('a.md', [root]);
    const first = index.activeEntries();
    expect(index.activeEntries()).toBe(first);

    index.updateFile('b.md', [
      task({
        title: 'Other',
        source: { filePath: 'b.md', line: 0 },
        timeEntries: [runningEntry('2026-09-19T07:00:00Z', 1)],
      }),
    ]);

    const second = index.activeEntries();
    expect(second).not.toBe(first);
    expect(titlesOf(second)).toEqual(['Child', 'Root', 'Other']);
    expect(index.activeEntries()).toBe(second);

    index.removeFile('b.md');
    expect(titlesOf(index.activeEntries())).toEqual(['Child', 'Root']);
    expect(index.activeEntries()).not.toBe(second);

    index.clear();
    expect(index.activeEntries()).toEqual([]);
  });

  it('follows vault edits, renames and deletions through the task queries', async () => {
    const app = await createAppWithFiles({ 'track.md': TRACKED_CONTENT });
    seedTaskCache(app, 'track.md', [{ task: ' ', parent: -1, line: 0 }]);
    const fireChanged = captureChangedCallback(app);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    expect(stack.tasks.queries.activeEntries()).toEqual([]);
    expect(stack.tasks.queries.fileTotal('track.md').closedMs).toBe(90 * 60_000);

    const changed: Array<readonly string[]> = [];
    stack.index.subscribe((event) => {
      if (event.type === 'changed') changed.push(event.files);
    });
    const file = markdownFile(app, 'track.md');
    await app.vault.modify(file, RUNNING_CONTENT);
    fireChanged(file, RUNNING_CONTENT, rootCache());
    await flushMicrotasks();

    expect(changed).toContainEqual(['track.md']);
    expect(titlesOf(stack.tasks.queries.activeEntries())).toEqual(['Track me']);

    await app.vault.rename(file, 'renamed.md');
    await flushMicrotasks();
    expect(stack.tasks.queries.activeEntries().map((tracked) => tracked.filePath)).toEqual([
      'renamed.md',
    ]);
    expect(stack.tasks.queries.fileTotal('track.md')).toEqual({ closedMs: 0, openStartsMs: [] });
    expect(stack.tasks.queries.fileTotal('renamed.md').closedMs).toBe(90 * 60_000);

    await app.fileManager.trashFile(markdownFile(app, 'renamed.md'));
    await flushMicrotasks();
    expect(stack.tasks.queries.activeEntries()).toEqual([]);
    expect(stack.tasks.queries.fileTotal('renamed.md')).toEqual({ closedMs: 0, openStartsMs: [] });
    stack.index.destroy();
  });
});
