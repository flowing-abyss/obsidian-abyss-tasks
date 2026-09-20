/**
 * Reproducible performance harness for the time tracking read model.
 *
 * Excluded from the normal test suite via vitest.config.ts.
 * Run with:
 *   pnpm bench
 *   pnpm exec vitest run --config vitest.bench.config.ts test/perf/time-tracking-bench.test.ts
 *
 * Prints metrics to the test output in both human-readable and JSON form.
 */
import { App as ObsidianApp } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { moment } from '../../src/obsidianMoment';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { OffsetAt } from '../../src/tasks/domain/timeEntry';
import type { TrackedEntry } from '../../src/tasks/domain/timeTracking';
import {
  groupTrackedDays,
  localDayStartMs,
  shiftLocalDayStartMs,
} from '../../src/tasks/domain/timeTracking';
import { configuredTaskApplication } from '../helpers';

beforeEach(() => {
  (window as unknown as { moment: unknown }).moment = moment;
});

// ---------------------------------------------------------------------------
// Fixed workload
// ---------------------------------------------------------------------------

const FILE_COUNT = 2_000;
const TASKS_PER_FILE = 10;
const ENTRIES_PER_TASK = 10;
const COMMENTS_PER_TASK = 2;
/** Closed entries are spread over this many days back, which is the bucket cap of one entry. */
const SPREAD_DAYS = 400;
const WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
/** 09:12:00 to 10:40:51, the canonical entry of the design spec. */
const SESSION_MS = 88 * MS_PER_MINUTE + 51_000;
const OFFSET_MINUTES = 180;
const OFFSET_SUFFIX = '+03:00';
const offsetAt: OffsetAt = () => OFFSET_MINUTES;

/** 2026-09-18T12:00:00+03:00, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 9, 0, 0);
/** 2026-09-18T09:12:00+03:00, the newest entry start before per-task jitter. */
const ANCHOR_MS = Date.UTC(2026, 8, 18, 6, 12, 0);

const ARROW = '→';
/** The baseline vault keeps every byte but the arrow, so only the entry path differs. */
const BASELINE_SEPARATOR = 'to';

const QUERY_RUNS = 200;
const INSTALL_RUNS = 20;
const LIST_RUNS = 20;

function atomAt(epochMs: number): string {
  return `${new Date(epochMs + OFFSET_MINUTES * MS_PER_MINUTE).toISOString().slice(0, 19)}${OFFSET_SUFFIX}`;
}

/**
 * Spread over the whole window and backwards over the day, so no entry lands after `NOW_MS`. The
 * two offsets repeat together every 1,200 tasks, so about sixteen tasks share each start at this
 * size, which is the kind of tie a real vault has too rather than an artefact to avoid.
 */
function entryStartMs(taskIndex: number, entryIndex: number): number {
  const dayOffset = (taskIndex * 3 + entryIndex * 40) % SPREAD_DAYS;
  const minuteOffset = (taskIndex * 7 + entryIndex * 13) % 600;
  return ANCHOR_MS - dayOffset * MS_PER_DAY - minuteOffset * MS_PER_MINUTE;
}

function pushTaskLines(lines: string[], taskIndex: number, running: boolean): void {
  const due = `2026-${String((taskIndex % 12) + 1).padStart(2, '0')}-${String((taskIndex % 28) + 1).padStart(2, '0')}`;
  lines.push(`- [ ] Task ${taskIndex} 📅 ${due} #tag${taskIndex % 5}`);
  for (let entryIndex = 0; entryIndex < ENTRIES_PER_TASK; entryIndex++) {
    const startMs = entryStartMs(taskIndex, entryIndex);
    lines.push(`    - ${atomAt(startMs)} ${ARROW} ${atomAt(startMs + SESSION_MS)}`);
  }
  if (running) lines.push(`    - ${atomAt(NOW_MS - 45 * MS_PER_MINUTE)} ${ARROW}`);
  for (let comment = 0; comment < COMMENTS_PER_TASK; comment++) {
    lines.push(`    - a plain note ${comment} on task ${taskIndex}`);
  }
}

/** The one running entry of the whole vault lives on the first task of the first file. */
function buildFileContent(fileIndex: number): string {
  const lines: string[] = [`# File ${fileIndex}`];
  for (let slot = 0; slot < TASKS_PER_FILE; slot++) {
    const taskIndex = fileIndex * TASKS_PER_FILE + slot;
    pushTaskLines(lines, taskIndex, taskIndex === 0);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `entries` is the vault under test. `comments` keeps every byte but the arrow, so the same nested
 * lines are read by the comment path instead. `stripped` drops the entry lines altogether, which
 * is the vault the feature would cost nothing in.
 */
type Variant = 'entries' | 'comments' | 'stripped';

function variantContent(content: string, variant: Variant): string {
  if (variant === 'entries') return content;
  if (variant === 'comments') return content.replaceAll(ARROW, BASELINE_SEPARATOR);
  return content
    .split('\n')
    .filter((line) => !line.includes(ARROW))
    .join('\n');
}

function buildFiles(variant: Variant): Record<string, string> {
  const files: Record<string, string> = {};
  for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex++) {
    files[`file-${fileIndex}.md`] = variantContent(buildFileContent(fileIndex), variant);
  }
  return files;
}

/**
 * The same file with the first entry's end second moved. A byte-identical install returns before
 * the index updates, so the install measurement has to alternate two contents to measure anything.
 */
function shiftedFileContent(content: string): string {
  return content.replace(
    atomAt(ANCHOR_MS + SESSION_MS),
    atomAt(ANCHOR_MS + SESSION_MS + MS_PER_SECOND),
  );
}

// ---------------------------------------------------------------------------
// App factory (mirrors createAppWithFiles in test/helpers.ts)
// ---------------------------------------------------------------------------

async function createApp(files: Record<string, string>): Promise<ObsidianApp> {
  const app = (
    ObsidianApp as unknown as {
      createConfigured__: (p: { files: Record<string, string> }) => ObsidianApp;
    }
  ).createConfigured__({ files });
  await Promise.all(app.vault.getMarkdownFiles().map((f) => app.vault.cachedRead(f)));
  await new Promise<void>((r) => window.setTimeout(r, 10));
  return app;
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

/** Medians rather than averages, so one scheduling stall does not colour a whole row. */
function medianMs(fn: () => void, runs: number): number {
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

interface TrackingMetrics {
  readonly fileCount: number;
  readonly taskCount: number;
  readonly entryCount: number;
  readonly initWithEntriesMs: number;
  readonly initAsCommentsMs: number;
  readonly initWithoutEntriesMs: number;
  readonly initOverheadPerEntryUs: number;
  readonly installOneFileMs: number;
  readonly windowMs: number;
  readonly windowCount: number;
  readonly unboundedRangeMs: number;
  readonly unboundedCount: number;
  readonly emptyFarRangeMs: number;
  readonly activeEntriesMs: number;
  readonly activeCount: number;
  readonly fileTotalMs: number;
  readonly listWithEntriesMs: number;
  readonly listAsCommentsMs: number;
  readonly listWithoutEntriesMs: number;
  readonly listOneFileWithEntriesMs: number;
  readonly listOneFileAsCommentsMs: number;
  readonly listOneFileWithoutEntriesMs: number;
  readonly groupTrackedDaysMs: number;
  readonly groupedDayCount: number;
}

type Stack = ReturnType<typeof configuredTaskApplication>;

async function initializedStack(files: Record<string, string>): Promise<{
  readonly stack: Stack;
  readonly ms: number;
}> {
  const app = await createApp(files);
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
  const { ms } = await time(async () => {
    await stack.index.initialize();
  });
  return { stack, ms };
}

function countEntries(stack: Stack): number {
  let total = 0;
  for (const root of stack.index.list()) total += root.timeEntries.length;
  return total;
}

interface BaselineMetrics {
  readonly initMs: number;
  readonly listMs: number;
  readonly listOneFileMs: number;
}

/** Cloning one file's roots isolates per-task clone work from the heap the whole vault carries. */
function measureList(stack: Stack): Omit<BaselineMetrics, 'initMs'> {
  return {
    listMs: medianMs(() => {
      stack.tasks.queries.list();
    }, LIST_RUNS),
    listOneFileMs: medianMs(() => {
      stack.tasks.queries.list({ filePath: 'file-0.md' });
    }, QUERY_RUNS),
  };
}

async function measureBaseline(variant: Variant): Promise<BaselineMetrics> {
  const { stack, ms } = await initializedStack(buildFiles(variant));
  const listed = measureList(stack);
  stack.index.destroy();
  return { initMs: ms, ...listed };
}

interface WindowMetrics {
  readonly windowMs: number;
  readonly windowCount: number;
  readonly entries: readonly TrackedEntry[];
}

function measureWindow(stack: Stack): WindowMetrics {
  const todayMs = localDayStartMs(NOW_MS, offsetAt);
  const fromMs = shiftLocalDayStartMs(todayMs, -(WINDOW_DAYS - 1), offsetAt);
  const toMs = shiftLocalDayStartMs(todayMs, 1, offsetAt);
  const windowMs = medianMs(() => {
    stack.tasks.queries.entriesOverlapping(fromMs, toMs);
  }, QUERY_RUNS);
  const entries = stack.tasks.queries.entriesOverlapping(fromMs, toMs);
  return { windowMs, windowCount: entries.length, entries };
}

/** A consumer asking for everything it has, which must not cost one step per calendar day. */
function measureUnbounded(stack: Stack): { readonly ms: number; readonly count: number } {
  const fromMs = Date.UTC(1970, 0, 1);
  const toMs = Date.UTC(2100, 0, 1);
  const ms = medianMs(() => {
    stack.tasks.queries.entriesOverlapping(fromMs, toMs);
  }, LIST_RUNS);
  return { ms, count: stack.tasks.queries.entriesOverlapping(fromMs, toMs).length };
}

/** Alternating contents, because a repeated identical install never reaches the read model. */
function measureInstall(stack: Stack): number {
  const original = buildFileContent(0);
  const shifted = shiftedFileContent(original);
  let run = 0;
  const ms = medianMs(() => {
    stack.index.installCommittedContent('file-0.md', run % 2 === 0 ? shifted : original);
    run += 1;
  }, INSTALL_RUNS);
  // An even run count ends on the original, so every later measurement sees the built vault.
  return ms;
}

/** The same unbounded shape with nothing to find, which isolates the walk from the result. */
function measureEmptyFarRange(stack: Stack): number {
  const fromMs = Date.UTC(1970, 0, 1);
  const toMs = Date.UTC(2000, 0, 1);
  return medianMs(() => {
    stack.tasks.queries.entriesOverlapping(fromMs, toMs);
  }, QUERY_RUNS);
}

/**
 * The variants always run in this order and each holds its vault only for its own measurements, so
 * the initialization rows carry whatever heap the previous variant left behind. The order is fixed
 * rather than randomised so two runs stay comparable; read the rows against each other, not as
 * absolute timings.
 */
async function runBenchmark(): Promise<TrackingMetrics> {
  const asComments = await measureBaseline('comments');
  const withoutEntries = await measureBaseline('stripped');
  const { stack, ms: initWithEntriesMs } = await initializedStack(buildFiles('entries'));
  const queries = stack.tasks.queries;
  const taskCount = stack.index.list().length;
  const entryCount = countEntries(stack);

  const installOneFileMs = measureInstall(stack);
  const weekWindow = measureWindow(stack);
  const unbounded = measureUnbounded(stack);
  const emptyFarRangeMs = measureEmptyFarRange(stack);
  const activeEntriesMs = medianMs(() => {
    queries.activeEntries();
  }, QUERY_RUNS);
  const fileTotalMs = medianMs(() => {
    queries.fileTotal('file-1999.md');
  }, QUERY_RUNS);
  const listed = measureList(stack);
  const groupTrackedDaysMs = medianMs(() => {
    groupTrackedDays(weekWindow.entries, { nowMs: NOW_MS, offsetAt, days: WINDOW_DAYS });
  }, LIST_RUNS);
  const grouped = groupTrackedDays(weekWindow.entries, {
    nowMs: NOW_MS,
    offsetAt,
    days: WINDOW_DAYS,
  });
  const activeCount = queries.activeEntries().length;
  stack.index.destroy();

  return {
    fileCount: FILE_COUNT,
    taskCount,
    entryCount,
    initWithEntriesMs,
    initAsCommentsMs: asComments.initMs,
    initWithoutEntriesMs: withoutEntries.initMs,
    initOverheadPerEntryUs: ((initWithEntriesMs - withoutEntries.initMs) * 1000) / entryCount,
    installOneFileMs,
    windowMs: weekWindow.windowMs,
    windowCount: weekWindow.windowCount,
    unboundedRangeMs: unbounded.ms,
    unboundedCount: unbounded.count,
    emptyFarRangeMs,
    activeEntriesMs,
    activeCount,
    fileTotalMs,
    listWithEntriesMs: listed.listMs,
    listAsCommentsMs: asComments.listMs,
    listWithoutEntriesMs: withoutEntries.listMs,
    listOneFileWithEntriesMs: listed.listOneFileMs,
    listOneFileAsCommentsMs: asComments.listOneFileMs,
    listOneFileWithoutEntriesMs: withoutEntries.listOneFileMs,
    groupTrackedDaysMs,
    groupedDayCount: grouped.length,
  };
}

function printMetrics(metrics: TrackingMetrics): void {
  const lines = [
    `\n📊 ${FILE_COUNT} files × ${TASKS_PER_FILE} tasks × ${ENTRIES_PER_TASK} entries`,
    `   Tasks / entries:              ${metrics.taskCount} / ${metrics.entryCount}`,
    `   Initial index with entries:   ${metrics.initWithEntriesMs.toFixed(3)} ms`,
    `   Initial index as comments:    ${metrics.initAsCommentsMs.toFixed(3)} ms`,
    `   Initial index without them:   ${metrics.initWithoutEntriesMs.toFixed(3)} ms`,
    `   Overhead per entry line:      ${metrics.initOverheadPerEntryUs.toFixed(4)} µs`,
    `   installCommittedContent:      ${metrics.installOneFileMs.toFixed(3)} ms (${INSTALL_RUNS} median)`,
    `   entriesOverlapping 7 days:    ${metrics.windowMs.toFixed(4)} ms (${QUERY_RUNS} median, ${metrics.windowCount} entries)`,
    `   entriesOverlapping 1970-2100: ${metrics.unboundedRangeMs.toFixed(4)} ms (${LIST_RUNS} median, ${metrics.unboundedCount} entries)`,
    `   entriesOverlapping 1970-2000: ${metrics.emptyFarRangeMs.toFixed(4)} ms (${QUERY_RUNS} median, 0 entries)`,
    `   activeEntries:                ${metrics.activeEntriesMs.toFixed(4)} ms (${QUERY_RUNS} median, ${metrics.activeCount} running)`,
    `   fileTotal:                    ${metrics.fileTotalMs.toFixed(4)} ms (${QUERY_RUNS} median)`,
    `   list() with entries:          ${metrics.listWithEntriesMs.toFixed(3)} ms (${LIST_RUNS} median)`,
    `   list() as comments:           ${metrics.listAsCommentsMs.toFixed(3)} ms (${LIST_RUNS} median)`,
    `   list() without them:          ${metrics.listWithoutEntriesMs.toFixed(3)} ms (${LIST_RUNS} median)`,
    `   list(file) with entries:      ${metrics.listOneFileWithEntriesMs.toFixed(4)} ms (${QUERY_RUNS} median)`,
    `   list(file) as comments:       ${metrics.listOneFileAsCommentsMs.toFixed(4)} ms (${QUERY_RUNS} median)`,
    `   list(file) without them:      ${metrics.listOneFileWithoutEntriesMs.toFixed(4)} ms (${QUERY_RUNS} median)`,
    `   groupTrackedDays over window: ${metrics.groupTrackedDaysMs.toFixed(4)} ms (${LIST_RUNS} median, ${metrics.groupedDayCount} days)`,
    `   JSON: ${JSON.stringify(metrics)}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('time tracking read model benchmark', () => {
  it('uses the exact fixed workload', () => {
    expect({
      FILE_COUNT,
      TASKS_PER_FILE,
      ENTRIES_PER_TASK,
      COMMENTS_PER_TASK,
      SPREAD_DAYS,
      WINDOW_DAYS,
    }).toEqual({
      FILE_COUNT: 2_000,
      TASKS_PER_FILE: 10,
      ENTRIES_PER_TASK: 10,
      COMMENTS_PER_TASK: 2,
      SPREAD_DAYS: 400,
      WINDOW_DAYS: 7,
    });
    const content = buildFileContent(0);
    expect(content.split('\n')[2]).toBe(
      '    - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:40:51+03:00',
    );
    // Without a real difference the install row would time the unchanged early return instead.
    expect(shiftedFileContent(content).split('\n')[2]).toBe(
      '    - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:40:52+03:00',
    );
  });

  it('2,000 files × 10 tasks × 10 entries', async () => {
    const metrics = await runBenchmark();

    printMetrics(metrics);
    expect(metrics.taskCount).toBe(FILE_COUNT * TASKS_PER_FILE);
    expect(metrics.entryCount).toBe(FILE_COUNT * TASKS_PER_FILE * ENTRIES_PER_TASK + 1);
    expect(metrics.activeCount).toBe(1);
    expect(metrics.groupedDayCount).toBe(WINDOW_DAYS);
  }, 600_000);
});
