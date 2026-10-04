/** Repeatable observational timings; deterministic correctness lives in statistics-scale.test.ts.
 * pnpm exec vitest run --config vitest.bench.config.ts test/perf/statistics-bench.test.ts
 */
import { Platform } from 'obsidian';
import { expect, it, vi } from 'vitest';
import {
  prepareStatisticsDataset,
  STATISTICS_VIEWS,
  StatisticsSession,
  type StatisticsWork,
} from '../../src/statistics';
import { prepareCalendar } from '../../src/statistics/statisticsCalendar';
import { required } from '../../src/statistics/statisticsWork';
import * as timeEntry from '../../src/tasks/domain/timeEntry';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, createAppWithFiles } from '../helpers';
import { request, source, task, work } from '../helpers/statisticsFixtures';
import {
  scaleProjects,
  scaleTransitions,
  statisticsScaleFixture,
} from '../helpers/statisticsScaleFixtures';

interface Timing {
  wallMs: number;
  computeMs: number;
  maxChunkMs: number;
  yields: number;
}
async function measure<T>(
  run: (work: StatisticsWork) => Promise<T>,
): Promise<{ value: T; timing: Timing }> {
  const begin = performance.now();
  let chunkStart = begin,
    computeMs = 0,
    maxChunkMs = 0,
    yields = 0;
  const chunk = () => {
    const duration = performance.now() - chunkStart;
    computeMs += duration;
    maxChunkMs = Math.max(maxChunkMs, duration);
  };
  const value = await run({
    isCancelled: () => false,
    yieldControl: async () => {
      chunk();
      yields++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      chunkStart = performance.now();
    },
  });
  chunk();
  return { value, timing: { wallMs: performance.now() - begin, computeMs, maxChunkMs, yields } };
}
function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: required(sorted[Math.floor(sorted.length / 2)]),
    p95: required(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: Math.max(...values),
  };
}
function timings(values: readonly Timing[]) {
  return {
    wallMs: percentiles(values.map((v) => v.wallMs)),
    computeMs: percentiles(values.map((v) => v.computeMs)),
    maxChunkMs: Math.max(...values.map((v) => v.maxChunkMs)),
    yields: values.map((v) => v.yields),
  };
}
function archiveMarkdown(nodes: number): string {
  return Array.from(
    { length: nodes },
    (_, i) =>
      `- [x] Retained ${i} ➕ 2026-09-28 ✅ 2026-10-03\n  - 2026-09-28T09:00:00+00:00 → 2026-09-28T09:30:00+00:00\n  - 2026-10-01T23:50:00+00:00 → 2026-10-02T00:10:00+00:00\n  - 1926-10-04T12:00:00+00:00 → 2026-10-04T12:00:00+00:00`,
  ).join('\n');
}
async function acquisition(nodes: number) {
  const app = await createAppWithFiles({ 'archive.md': archiveMarkdown(nodes) });
  const reads = vi.spyOn(app.vault, 'cachedRead');
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    refAuthority: new TaskRefAuthority(),
    excludeSource: () => true,
    statisticsFileKind: () => 'archive',
  });
  const start = performance.now();
  await index.initialize();
  const timers: { setTimeout(callback: () => void, delay?: number): number } = window;
  const acquiredMs = performance.now() - start,
    originalTimer = timers.setTimeout.bind(window);
  let began = performance.now(),
    chunkWork = 0,
    maxWork = 0,
    maxChunkMs = 0,
    scheduled = 0;
  const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
  const parseLine = codec.parseLine.bind(codec),
    parseEntry = timeEntry.parseTimeEntryLine;
  vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation(function (
    this: TaskMarkdownCodec,
    ...args
  ) {
    chunkWork++;
    return parseLine(...args);
  });
  vi.spyOn(timeEntry, 'parseTimeEntryLine').mockImplementation((...args) => {
    chunkWork++;
    return parseEntry(...args);
  });
  vi.spyOn(timers, 'setTimeout').mockImplementation((handler, delay) => {
    maxWork = Math.max(maxWork, chunkWork);
    maxChunkMs = Math.max(maxChunkMs, performance.now() - began);
    scheduled++;
    chunkWork = 0;
    if (typeof handler !== 'function') throw new Error('Expected scheduled projection callback');
    return originalTimer(() => {
      began = performance.now();
      handler();
    }, delay);
  });
  const projectionStart = performance.now(),
    release = index.subscribeStatistics(() => {});
  try {
    await index.whenStatisticsSettled();
    maxWork = Math.max(maxWork, chunkWork);
    maxChunkMs = Math.max(maxChunkMs, performance.now() - began);
    const snapshot = index.readStatistics(),
      file = required(snapshot.files[0]);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.issues).toEqual([]);
    expect(file.roots).toHaveLength(nodes);
    expect(file.roots.reduce((sum, root) => sum + root.timeEntries.length, 0)).toBe(nodes * 3);
    expect(maxWork).toBeLessThanOrEqual(1000);
    const count = reads.mock.calls.length;
    for (let i = 0; i < 30; i++) {
      expect(index.readStatistics()).toBe(snapshot);
      await index.whenStatisticsSettled();
    }
    expect(reads.mock.calls).toHaveLength(count);
    return {
      acquiredMs,
      projectionMs: performance.now() - projectionStart,
      scheduled,
      maxChunkMs,
      maxObservedParserCalls: maxWork,
      reads: count,
      files: 1,
      nodes,
      entries: nodes * 3,
    };
  } finally {
    release();
    index.destroy();
    vi.restoreAllMocks();
  }
}

it('reports source, normalization, cold/warm eleven-view, evidence and graph timings', async () => {
  if (!Platform.isDesktop) throw new Error('Desktop-only benchmark');
  const { cpus, platform, totalmem } = await import('node:os');
  process.stdout.write(
    `${JSON.stringify({
      statisticsEnvironment: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        ramGiB: totalmem() / 2 ** 30,
        platform: platform(),
        node: process.version,
        mode: 'Vitest jsdom development runtime',
        profiling: false,
        explicitGC: false,
        trials: 5,
        asOf: '2026-10-04T12:00:00.000Z',
        offset: 'UTC constant',
        transitions: 'same frozen empty array',
        fixtureConstructionTimed: false,
      },
    })}\n`,
  );
  // Warm JIT/module paths outside all reported measurements.
  const warm = required(
    await prepareStatisticsDataset(statisticsScaleFixture(1000), scaleProjects, work),
  );
  const warmSession = new StatisticsSession(warm);
  for (const { id } of STATISTICS_VIEWS)
    await warmSession.view(
      request({ view: id, period: 'week', calendarTransitions: scaleTransitions }),
      work,
    );
  for (const n of [1000, 10000, 100000]) await benchmarkSize(n);
}, 300000);

async function benchmarkSize(n: number) {
  const fixture = statisticsScaleFixture(n),
    normalization: Timing[] = [];
  let dataset = required(await prepareStatisticsDataset(fixture, scaleProjects, work));
  for (let trial = 0; trial < 5; trial++) {
    const measured = await measure((port) =>
      prepareStatisticsDataset(fixture, scaleProjects, port),
    );
    dataset = required(measured.value);
    normalization.push(measured.timing);
    expect(dataset.tasks).toHaveLength(n);
    expect(dataset.entries).toHaveLength(n * 3);
  }
  const baseline = request({ period: 'week', calendarTransitions: scaleTransitions });
  const calendar = await measure((port) => prepareCalendar(dataset, baseline, port));
  const views: Record<string, unknown> = {};
  for (const { id } of STATISTICS_VIEWS) {
    const cold: Timing[] = [],
      warmTimes: number[] = [];
    for (let trial = 0; trial < 5; trial++) {
      const session = new StatisticsSession(dataset),
        input = { ...baseline, view: id };
      const observed = await measure((port) => session.view(input, port));
      const model = required(observed.value);
      cold.push(observed.timing);
      expect(model.coverage.scope.nodes).toBe(n);
      for (let repeat = 0; repeat < 10; repeat++) {
        const warmed = await measure((port) => session.view(input, port));
        expect(warmed.value).toBe(model);
        expect(warmed.timing.yields).toBe(0);
        warmTimes.push(warmed.timing.wallMs);
      }
    }
    views[id] = { cold: timings(cold), warmMs: percentiles(warmTimes) };
  }
  const session = new StatisticsSession(dataset),
    rhythm = required(await session.view(baseline, work)),
    timeline = required(await session.view({ ...baseline, view: 'timeline' }, work));
  const evidence: Record<string, unknown> = {};
  for (const [name, model, selection, total] of [
    ['dense', rhythm, 'created:2:recurring', n / 5],
    ['sparse', timeline, 'day-time:1', n / 10],
  ] as const) {
    for (const offset of [0, total - 50]) {
      const samples = [];
      for (let trial = 0; trial < 20; trial++) {
        const start = performance.now();
        const page = model.evidence(selection, offset, 50);
        samples.push(performance.now() - start);
        expect(page.total).toBe(total);
      }
      evidence[`${name}:${offset}`] = percentiles(samples);
    }
  }
  const allPatterns = await measure((port) =>
    session.view({ ...baseline, view: 'patterns', period: 'all' }, port),
  );
  expect(
    required(allPatterns.value)
      .sections.flatMap((s) => s.metrics)
      .find((m) => m.id === 'recorded-minutes')?.value,
  ).toBe((52596620 * n) / 10);
  for (let i = 0; i < 30; i++)
    await session.view({ ...baseline, view: required(STATISTICS_VIEWS[i % 11]).id }, work);
  expect(session['cache'].size).toBe(11);
  let cancellationYields = 0;
  const cancellationStart = performance.now();
  expect(
    await prepareStatisticsDataset(fixture, scaleProjects, {
      yieldControl: async () => {
        cancellationYields++;
      },
      isCancelled: () => cancellationYields > 0,
    }),
  ).toBeUndefined();
  const cancellationMs = performance.now() - cancellationStart;
  process.stdout.write(
    `${JSON.stringify({
      statisticsBenchmark: {
        n,
        entries: n * 3,
        files: 4,
        acquisition: await acquisition(n / 5),
        normalization: timings(normalization),
        calendar: calendar.timing,
        views,
        evidence,
        allPatterns: allPatterns.timing,
        retainedViewsAfter30: session['cache'].size,
        cancellation: {
          yields: cancellationYields,
          wallMs: cancellationMs,
        },
      },
    })}\n`,
  );
}

it('reports focused 100k star, chain and independent-edge cases without all-node reachability', async () => {
  for (const shape of ['star', 'chain', 'independent'] as const) {
    const n = 100000;
    const nodes = Array.from({ length: n }, (_, i) =>
      task(`Node ${i}`, { dependencyId: `n${i}`, dependsOn: graphPrerequisites(shape, i) }),
    );
    const dataset = required(await prepareStatisticsDataset(source(nodes), [], work));
    const base = request({
      view: 'dependencies',
      period: 'week',
      calendarTransitions: scaleTransitions,
    });
    const ranking = await measure((port) => new StatisticsSession(dataset).view(base, port));
    const focus = await measure((port) =>
      new StatisticsSession(dataset).view(
        { ...base, focusKey: required(dataset.tasks[0]).key },
        port,
      ),
    );
    const model = required(focus.value),
      metrics = model.sections.flatMap((s) => s.metrics);
    expect(metrics.find((m) => m.id === 'downstream')?.value).toBe(
      shape === 'independent' ? 1 : n - 1,
    );
    const graph = required(
      model.sections.flatMap((s) => s.charts).find((c) => c.kind === 'network'),
    );
    expect(graph.marks.length).toBeLessThanOrEqual(80);
    expect(graph.edges?.length ?? 0).toBeLessThanOrEqual(160);
    process.stdout.write(
      `${JSON.stringify({
        statisticsGraphBenchmark: {
          shape,
          n,
          edges: shape === 'independent' ? 10000 : n - 1,
          ranking: ranking.timing,
          focus: focus.timing,
          marks: graph.marks.length,
          renderedEdges: graph.edges?.length,
        },
      })}\n`,
    );
  }
}, 300000);
function graphPrerequisites(shape: 'star' | 'chain' | 'independent', index: number): string[] {
  if (index === 0) return [];
  if (shape === 'star') return ['n0'];
  if (shape === 'chain') return [`n${index - 1}`];
  return index < 20000 && index % 2 === 1 ? [`n${index - 1}`] : [];
}
