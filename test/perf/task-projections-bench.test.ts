import { Platform } from 'obsidian';
import { expect, it } from 'vitest';
import { runTaskOrganization } from '../../src/panels/task-list/runTaskOrganization';
import { taskDailyRowsAudit } from '../../src/panels/task-list/taskDailyRows';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { organizeTaskSearch } from '../../src/task-lists/taskSearchOrganization';
import { localDate, type TaskOrganizationRecord } from '../../src/tasks';
import { expectDefined } from '../helpers';
import { createCanonicalSearchHarness } from '../support/taskSearchHarness';

it('records complete-domain and finite-node construction/slice costs without a wall-clock assertion', async () => {
  if (!Platform.isDesktop) throw new Error('Benchmark requires desktop runtime metadata');
  const { cpus, platform, release } = await import('node:os');
  console.debug('Task projection benchmark runtime', {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
  });
  for (const data of [
    {
      name: '10k point nodes',
      nodes: 10000,
      start: '2026-10-07',
      due: '2026-10-07',
      today: '2026-10-06',
    },
    {
      name: '10k nodes dense cold second day',
      nodes: 10000,
      start: '2026-10-07',
      due: '2026-10-08',
      today: '2026-10-06',
    },
    {
      name: '100 overlapping ten-year intervals',
      nodes: 100,
      start: '2026-10-07',
      due: '2036-10-06',
      today: '2026-10-06',
    },
    {
      name: 'full canonical domain',
      nodes: 1,
      start: '0000-01-01',
      due: '9999-12-31',
      today: '0000-01-01',
    },
  ]) {
    const h = await createCanonicalSearchHarness(
      {
        'bench.md': Array.from(
          { length: data.nodes },
          (_, i) => `- [ ] Task ${i} 🛫 ${data.start} 📅 ${data.due}`,
        ).join('\n'),
      },
      DEFAULT_SETTINGS,
    );
    try {
      const source = h.index.searchSource().subscribe(() => {}),
        generation = source.state.generation;
      source.unsubscribe();
      const signal = new AbortController().signal,
        records: TaskOrganizationRecord[] = [];
      for await (const batch of h.index.organization(
        { expectedGeneration: generation, scope: 'nodes' },
        signal,
      ))
        records.push(...batch.items);
      let previous = performance.now(),
        maxSliceMs = 0,
        checkpoints = 0,
        yields = 0;
      const start = performance.now();
      const generator = organizeTaskSearch({
        records,
        generation,
        scope: 'nodes',
        hits: null,
        selection: 'upcoming',
        view: {
          relevance: false,
          list: { groupBy: 'date', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
        },
        settings: DEFAULT_SETTINGS,
        today: localDate(data.today),
        nowMs: 0,
        outgoingLinks: new Map(),
      });
      const measured = function* () {
        for (;;) {
          const result = generator.next();
          if (result.done === true) return result.value;
          checkpoints++;
          yield result.value;
        }
      };
      const result = await runTaskOrganization(measured(), {
        signal,
        scheduler: {
          now: () => performance.now(),
          yield: async () => {
            const now = performance.now();
            maxSliceMs = Math.max(maxSliceMs, now - previous);
            previous = now;
            yields++;
          },
        },
        assertCurrent: () => {},
        phase: 'organization',
        budget: { targetMs: 4, maxSteps: 8192, clockCheckEvery: 32 },
      });
      const rows = expectDefined(result).rows;
      maxSliceMs = Math.max(maxSliceMs, performance.now() - previous);
      const constructMs = performance.now() - start;
      const offset = Math.max(0, rows.rowCount - 40);
      const cachedBefore = taskDailyRowsAudit(rows)?.cachedDays;
      const coldAt = performance.now();
      const cold = [...rows.slice(offset, rows.rowCount)];
      const firstSliceMs = performance.now() - coldAt;
      const cachedAfter = taskDailyRowsAudit(rows)?.cachedDays;
      const cacheMiss = cachedBefore !== cachedAfter;
      const coldMs = cacheMiss ? firstSliceMs : null;
      const warmAt = performance.now();
      const warm = [...rows.slice(offset, rows.rowCount)];
      const warmMs = performance.now() - warmAt;
      const selectAt = performance.now();
      const selection = rows.captureSelection({
        spans: [{ from: 0, to: rows.taskCount - 1 }],
        include: [],
        exclude: [],
      });
      expect(rows.selectedNodes(selection)).toHaveLength(data.nodes);
      console.debug('Task projection benchmark', {
        dataset: data.name,
        nodes: data.nodes,
        rows: rows.rowCount,
        tasks: rows.taskCount,
        checkpoints,
        yields,
        constructMs,
        maxSliceMs,
        cachedBefore,
        cachedAfter,
        cacheMiss,
        firstSliceMs,
        coldMs,
        warmMs,
        selectionMs: performance.now() - selectAt,
        selectionDescriptors: selection.length,
        ...taskDailyRowsAudit(rows),
      });
      expect(warm.map((row) => row.key)).toEqual(cold.map((row) => row.key));
      expect(rows.indexOf(expectDefined(rows.taskKeyAt(rows.taskCount - 1)))).toBe(
        rows.taskCount - 1,
      );
    } finally {
      h.close();
    }
  }
});
