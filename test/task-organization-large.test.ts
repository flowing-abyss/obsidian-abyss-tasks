import { expect, it, vi } from 'vitest';
import { drainCollectionSteps } from '../src/collectionSteps';
import { runTaskOrganization } from '../src/panels/task-list/runTaskOrganization';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { organizeTaskSearch } from '../src/task-lists/taskSearchOrganization';
import { localDate, type TaskOrganizationRecord } from '../src/tasks';
import { expectDefined } from './helpers';
import { finiteGroupCounts, finiteOccurrences } from './support/taskOrganizationRows';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
it('organizes 50k compact roots and 100k outgoing occurrences with bounded steps, and closes repeated partial work', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] seed' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const base: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      base.push(...batch.items);
    const record = expectDefined(base[0]);
    const records = Array.from({ length: 50000 }, (_, i) => ({
      ...record,
      address: { ...record.address, rootId: i },
      title: `Task ${50000 - i}`,
      source: { ...record.source, line: i },
    }));
    const links = new Map(
      records.map((r, i) => [
        `${r.source.filePath}:${r.source.line}`,
        [
          { key: `note:${i}`, label: `Group ${i}`, target: `${i}.md` },
          { key: 'note:all', label: 'All', target: 'all.md' },
        ],
      ]),
    );
    const input = {
      generation,
      records,
      hits: null,
      selection: null,
      settings: DEFAULT_SETTINGS,
      today: localDate('2026-10-04'),
      nowMs: 0,
      outgoingLinks: links,
      view: {
        relevance: false,
        list: {
          sortBy: { field: 'title' as const, dir: 'asc' as const },
          groupBy: 'outgoing-link' as const,
          filters: [],
        },
      },
    };
    for (const stop of [1, 100, 50000, 200000]) {
      const partial = organizeTaskSearch(input);
      for (let i = 0; i < stop; i++) expect(partial.next().done).not.toBe(true);
      partial.return(undefined);
      expect(partial.next().done).toBe(true);
    }
    let yields = 0;
    const scheduler = {
      now: () => 0,
      yield: async () => {
        yields++;
      },
    };
    const result = await runTaskOrganization(organizeTaskSearch(input), {
      signal: new AbortController().signal,
      scheduler,
      assertCurrent: () => {},
      phase: 'organization',
      budget: { targetMs: 4, maxSteps: 8192, clockCheckEvery: 32 },
    });
    expect(yields).toBeGreaterThan(100);
    expect(result.scope === 'roots' ? result.rootTotal : undefined).toBe(50000);
    expect(finiteOccurrences(result)).toHaveLength(100000);
    expect(finiteGroupCounts(result).get('note:all')).toBe(50000);
    expect(new Set(finiteOccurrences(result).map((o) => o.key)).size).toBe(100000);
    const native = vi.spyOn(Array.prototype, 'sort').mockImplementation(() => {
      throw new Error('Native sort in cooperative path');
    });
    try {
      const partial = drainCollectionSteps(
        organizeTaskSearch({ ...input, records: records.slice(0, 100) }),
      );
      expect(partial.scope === 'roots' ? partial.rootTotal : undefined).toBe(100);
    } finally {
      native.mockRestore();
    }
  } finally {
    h.close();
  }
});
