/**
 * Reproducible performance harness for TaskIndex / vault-wide indexing.
 *
 * Excluded from the normal test suite via vitest.config.ts.
 * Run with:
 *   npm run bench
 *   npx vitest run test/perf/taskstore-bench.test.ts
 *
 * Prints metrics to the test output in both human-readable and JSON form.
 */
// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import moment from 'moment';
import { App as ObsidianApp } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { LocalDate } from '../../src/tasks';
import { configuredTaskApplication } from '../helpers';

beforeEach(() => {
  (window as unknown as { moment: unknown }).moment = moment;
});

// ---------------------------------------------------------------------------
// Synthetic file builder
// ---------------------------------------------------------------------------

function buildFileContent(fileIndex: number, tasksPerFile: number): string {
  const lines: string[] = [`# File ${fileIndex}`];
  for (let t = 0; t < tasksPerFile; t++) {
    const i = fileIndex * tasksPerFile + t;
    const due = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
    lines.push(`- [ ] Task ${i} 📅 ${due} #tag${i % 5}`);
  }
  return lines.join('\n');
}

function buildFiles(fileCount: number, tasksPerFile: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) {
    files[`file-${i}.md`] = buildFileContent(i, tasksPerFile);
  }
  return files;
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

async function avgMs(fn: () => Promise<void> | void, runs: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    total += performance.now() - t0;
  }
  return total / runs;
}

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------

const DENSITY = 10; // tasks per file
const RUNS = 3;
const QUERY_RUNS = RUNS * 10; // frozen at 30 invocations per query path
const CALENDAR_DATES = Array.from({ length: 42 }, (_, offset) => {
  const date = new Date(Date.UTC(2026, 4, 25 + offset));
  return date.toISOString().slice(0, 10);
});

interface ScenarioMetrics {
  fileCount: number;
  tasksPerFile: number;
  totalTasks: number;
  initialIndexMs: number;
  queryAllMs: number;
  queryByTagMs: number;
  queryByListDateMs: number;
  queryByCalendarDateMs: number;
  queryByFileMs: number;
}

interface PerformanceBudget {
  readonly initialIndexMs: number;
  readonly queryAllMs: number;
  readonly queryByTagMs: number;
  readonly queryByListDateMs: number;
  readonly queryByCalendarDateMs: number;
  readonly queryByFileMs: number;
}

type ScenarioId = '1k' | '5k' | '10k' | 'dense';

interface Scenario {
  readonly label: string;
  readonly fileCount: number;
  readonly tasksPerFile: number;
  readonly budget: PerformanceBudget;
}

const SCENARIOS = {
  '1k': {
    label: '1,000 files × 10 tasks/file',
    fileCount: 1_000,
    tasksPerFile: DENSITY,
    budget: {
      initialIndexMs: 2_000,
      queryAllMs: 25,
      queryByTagMs: 50,
      queryByListDateMs: 50,
      queryByCalendarDateMs: 50,
      queryByFileMs: 5,
    },
  },
  '5k': {
    label: '5,000 files × 10 tasks/file',
    fileCount: 5_000,
    tasksPerFile: DENSITY,
    budget: {
      initialIndexMs: 5_000,
      queryAllMs: 50,
      queryByTagMs: 100,
      queryByListDateMs: 100,
      queryByCalendarDateMs: 100,
      queryByFileMs: 5,
    },
  },
  '10k': {
    label: '10,000 files × 10 tasks/file',
    fileCount: 10_000,
    tasksPerFile: DENSITY,
    budget: {
      initialIndexMs: 10_000,
      queryAllMs: 100,
      queryByTagMs: 200,
      queryByListDateMs: 200,
      queryByCalendarDateMs: 200,
      queryByFileMs: 10,
    },
  },
  dense: {
    label: 'dense: 100 files × 100 tasks/file',
    fileCount: 100,
    tasksPerFile: 100,
    budget: {
      initialIndexMs: 2_000,
      queryAllMs: 25,
      queryByTagMs: 50,
      queryByListDateMs: 50,
      queryByCalendarDateMs: 50,
      queryByFileMs: 5,
    },
  },
} as const satisfies Readonly<Record<ScenarioId, Scenario>>;

async function runScenario(fileCount: number, tasksPerFile: number): Promise<ScenarioMetrics> {
  const files = buildFiles(fileCount, tasksPerFile);
  const app = await createApp(files);

  // Initial indexing
  const { ms: initialMs } = await time(async () => {
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await application.index.initialize();
    application.index.destroy();
  });

  // Build a reusable final query index for benchmarks.
  const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
  await application.index.initialize();
  const queries = application.tasks.queries;
  const totalTasks = queries.list().length;

  // Query benchmarks (repeated for stable avg)
  const queryAllMs = await avgMs(() => {
    queries.list();
  }, QUERY_RUNS);
  const queryTagMs = await avgMs(() => {
    queries.list({ tag: '#tag1' });
  }, QUERY_RUNS);
  const queryListDateMs = await avgMs(() => {
    queries.list({
      dateRange: {
        from: '2026-01-01' as LocalDate,
        to: '2026-12-31' as LocalDate,
      },
    });
  }, QUERY_RUNS);
  const queryCalendarDateMs = await avgMs(() => {
    queries.forCalendarProjection(CALENDAR_DATES as LocalDate[]);
  }, QUERY_RUNS);
  const queryFileMs = await avgMs(() => {
    queries.list({ filePath: 'file-0.md' });
  }, QUERY_RUNS);

  application.index.destroy();

  return {
    fileCount,
    tasksPerFile,
    totalTasks,
    initialIndexMs: initialMs,
    queryAllMs,
    queryByTagMs: queryTagMs,
    queryByListDateMs: queryListDateMs,
    queryByCalendarDateMs: queryCalendarDateMs,
    queryByFileMs: queryFileMs,
  };
}

function printMetrics(label: string, metrics: ScenarioMetrics): void {
  console.log(`\n📊 ${label}`);
  console.log(`   Total tasks:                ${metrics.totalTasks}`);
  console.log(`   Initial index:              ${metrics.initialIndexMs.toFixed(3)} ms`);
  console.log(`   query list all:             ${metrics.queryAllMs.toFixed(3)} ms (30 avg)`);
  console.log(`   query list by tag:          ${metrics.queryByTagMs.toFixed(3)} ms (30 avg)`);
  console.log(`   query list date range:      ${metrics.queryByListDateMs.toFixed(3)} ms (30 avg)`);
  console.log(
    `   calendar date union:        ${metrics.queryByCalendarDateMs.toFixed(3)} ms (30 avg)`,
  );
  console.log(`   query list filePath:        ${metrics.queryByFileMs.toFixed(3)} ms (30 avg)`);
  console.log(`   JSON: ${JSON.stringify(metrics)}`);
}

function expectWithinBudget(metrics: ScenarioMetrics, budget: PerformanceBudget): void {
  expect(metrics.initialIndexMs).toBeLessThan(budget.initialIndexMs);
  expect(metrics.queryAllMs).toBeLessThan(budget.queryAllMs);
  expect(metrics.queryByTagMs).toBeLessThan(budget.queryByTagMs);
  expect(metrics.queryByListDateMs).toBeLessThan(budget.queryByListDateMs);
  expect(metrics.queryByCalendarDateMs).toBeLessThan(budget.queryByCalendarDateMs);
  expect(metrics.queryByFileMs).toBeLessThan(budget.queryByFileMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskIndex performance benchmark', () => {
  it('serves calendar projection sources without list queries or vault rescans', async () => {
    const app = await createApp({
      'recurring.md': '- [ ] repeat 🔁 every day 📅 2026-08-01',
      'plain.md': '- [ ] plain 📅 2026-08-08',
    });
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await application.index.initialize();
    const list = vi.spyOn(application.index, 'list');
    const vaultScan = vi.spyOn(app.vault, 'getMarkdownFiles');

    const projection = application.index.forCalendarProjection(['2026-08-08' as LocalDate]);

    expect(projection.materialized).toHaveLength(1);
    expect(projection.recurringSources).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    expect(vaultScan).not.toHaveBeenCalled();
    application.index.destroy();
  });

  it('uses the exact fixed workload and absolute budget matrix', () => {
    expect(SCENARIOS).toEqual({
      '1k': {
        label: '1,000 files × 10 tasks/file',
        fileCount: 1_000,
        tasksPerFile: 10,
        budget: {
          initialIndexMs: 2_000,
          queryAllMs: 25,
          queryByTagMs: 50,
          queryByListDateMs: 50,
          queryByCalendarDateMs: 50,
          queryByFileMs: 5,
        },
      },
      '5k': {
        label: '5,000 files × 10 tasks/file',
        fileCount: 5_000,
        tasksPerFile: 10,
        budget: {
          initialIndexMs: 5_000,
          queryAllMs: 50,
          queryByTagMs: 100,
          queryByListDateMs: 100,
          queryByCalendarDateMs: 100,
          queryByFileMs: 5,
        },
      },
      '10k': {
        label: '10,000 files × 10 tasks/file',
        fileCount: 10_000,
        tasksPerFile: 10,
        budget: {
          initialIndexMs: 10_000,
          queryAllMs: 100,
          queryByTagMs: 200,
          queryByListDateMs: 200,
          queryByCalendarDateMs: 200,
          queryByFileMs: 10,
        },
      },
      dense: {
        label: 'dense: 100 files × 100 tasks/file',
        fileCount: 100,
        tasksPerFile: 100,
        budget: {
          initialIndexMs: 2_000,
          queryAllMs: 25,
          queryByTagMs: 50,
          queryByListDateMs: 50,
          queryByCalendarDateMs: 50,
          queryByFileMs: 5,
        },
      },
    });
  });

  /*
   * Deliberately kept below the executable matrix contract so changing a
   * workload cannot silently retain the budget for a different dataset.
   */
  for (const scenario of Object.values(SCENARIOS)) {
    it(
      scenario.label,
      async () => {
        const metrics = await runScenario(scenario.fileCount, scenario.tasksPerFile);

        printMetrics(scenario.label, metrics);
        expect(metrics.totalTasks).toBe(scenario.fileCount * scenario.tasksPerFile);
        expectWithinBudget(metrics, scenario.budget);
      },
      120_000,
    );
  }
});
