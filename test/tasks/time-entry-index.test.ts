import { TFile, type CachedMetadata } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TimeEntrySnapshot, TrackedEntry } from '../../src/tasks/domain/timeTracking';
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
    index.updateFile('long.md', [
      task({
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
      }),
    ]);

    expect(index.entriesOverlapping(startMs, startMs + MS_PER_DAY)).toHaveLength(1);
    expect(
      index.entriesOverlapping(startMs + 399 * MS_PER_DAY, startMs + 400 * MS_PER_DAY),
    ).toHaveLength(1);
    // Past the cap the entry is no longer bucketed, which is what keeps one absurd span cheap.
    expect(
      index.entriesOverlapping(startMs + 400 * MS_PER_DAY, startMs + 401 * MS_PER_DAY),
    ).toEqual([]);
    expect(index.fileTotal('long.md').closedMs).toBe(500 * MS_PER_DAY);
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
