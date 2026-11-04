import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskReadResult } from '../src/tasks/application/TaskIntegrationReadApi';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import * as statisticsProjection from '../src/tasks/infrastructure/TaskStatisticsProjection';
import { deferred, expectDefined, flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
async function harness(...args: Parameters<typeof publicApiHarness>) {
  const h = await publicApiHarness(...args);
  cleanups.push(() => {
    h.dispose();
  });
  return h;
}
function ok<T>(result: TaskReadResult<T>): T {
  expect(result.type).toBe('ok');
  if (result.type !== 'ok') throw new Error(result.reason);
  return result.value;
}
function file(h: PublicApiHarness, path = 'a.md'): TFile {
  const f = h.app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) throw new Error('Missing source');
  return f;
}

describe('complete integration node reads', () => {
  it('finds a matching child when its parent does not match without changing root-filtered queries', async () => {
    const h = await harness({ 'a.md': '- [x] parent #other\n  - [ ] child #work\n' });
    expect(h.index.listNodes({ statuses: ['open'], tag: '#work' })).toEqual([]);
    const page = ok(h.reads.page({ statuses: ['open'], tagsAll: ['#work'] }, 1));
    expect(page.nodes.map((row) => row.value.node.title)).toEqual(['child']);
    expect(page.nodes[0]?.parent).toEqual({
      filePath: 'a.md',
      rootRevision: ok(h.reads.page({}, 10)).nodes[0]?.address.rootRevision,
      rootLine: 0,
      nodeOffset: 0,
    });
  });

  it('orders by code units then absolute line and resolves full ancestry exactly', async () => {
    const h = await harness({
      'a.md': '- [ ] lower',
      'Z.md': 'heading\n- [ ] root\n  text\n  - [ ] child\n    more\n    - [ ] deep\n',
      'Ä.md': '- [ ] umlaut',
    });
    const rows = ok(h.reads.page({}, 10)).nodes;
    expect(rows.map((row) => [row.address.filePath, row.line, row.value.node.title])).toEqual([
      ['Z.md', 1, 'root'],
      ['Z.md', 3, 'child'],
      ['Z.md', 5, 'deep'],
      ['a.md', 0, 'lower'],
      ['Ä.md', 0, 'umlaut'],
    ]);
    const deep = expectDefined(rows[2]);
    expect(deep.address.nodeOffset).toBe(4);
    expect(deep.parent?.nodeOffset).toBe(2);
    expect(ok(h.reads.node(deep.address)).line).toBe(5);
    expect(ok(h.reads.resolve({ source: { path: 'Z.md', line: 5 } })).nodes[0]?.address).toEqual(
      deep.address,
    );
    expect(ok(h.reads.resolve({ source: { path: 'Z.md', line: 4 } })).nodes).toEqual([]);
    expect(h.reads.node({ ...deep.address, rootRevision: 'old' })).toMatchObject({
      reason: 'stale',
    });
    expect(h.reads.node({ ...deep.address, nodeOffset: 3 })).toMatchObject({ reason: 'missing' });
  });

  it('ANDs filters with inclusive dates and projects only canonical valid planning while retaining recurrence', async () => {
    const h = await harness({
      'a.md':
        '- [ ] root #Work #two 🛫 2026-11-01 📅 2026-11-04 ⏰ 09:30 ⏱️ 1h30m 🔁 every nonsense\n- [ ] bad #work #two 📅 2026-02-30 ⏰ 25:99\n- [ ] other #work 🛫 2026-11-01 📅 2026-11-04\n- [x] wrong status #work #two 🛫 2026-11-01 📅 2026-11-04\n- [ ] wrong due #work #two 🛫 2026-11-01 📅 2026-11-05\n',
    });
    const rows = ok(
      h.reads.page(
        {
          tagsAll: ['#work', '#two'],
          statuses: ['open'],
          dates: [
            { field: 'start', from: '2026-11-01', to: '2026-11-01' },
            { field: 'due', from: '2026-11-04', to: '2026-11-04' },
          ],
        },
        10,
      ),
    ).nodes;
    expect(rows.map((row) => row.value.node.title)).toEqual(['root']);
    expect(rows[0]).toMatchObject({
      dates: { start: '2026-11-01', due: '2026-11-04' },
      time: '09:30',
      durationMinutes: 90,
      value: { node: { recurrence: 'every nonsense', tags: ['#Work', '#two'] } },
    });
    const bad = ok(h.reads.resolve({ source: { path: 'a.md', line: 1 } })).nodes[0];
    expect(bad?.dates).toEqual({});
    expect(bad?.time).toBeUndefined();
  });

  it('uses the current catalog with unknown-symbol fallback and authored cancellation precedence', async () => {
    const h = await harness({
      'a.md': '- [x] done\n- [?] unknown\n- [x] cancelled ❌ 2026-02-30\n',
    });
    h.index.setStatusCatalog(
      new StatusCatalog([{ id: 'x', symbol: 'x', type: 'in-progress', defaultForType: true }]),
    );
    expect(
      ok(h.reads.page({}, 10)).nodes.map((row) => [row.value.node.statusSymbol, row.status]),
    ).toEqual([
      ['x', 'in-progress'],
      ['?', 'open'],
      ['x', 'cancelled'],
    ]);
    expect(
      ok(h.reads.page({ statuses: ['open', 'in-progress'] }, 10)).nodes.map(
        (row) => row.value.node.title,
      ),
    ).toEqual(['done', 'unknown']);
    expect(ok(h.reads.statuses())).toEqual([
      { symbol: 'x', status: 'in-progress', defaultForStatus: true },
    ]);
    const before = h.reads.capture();
    h.index.updateIntegrationSemantics('behavior-key');
    expect(h.reads.capture().semanticsRevision).toBe(before.semanticsRevision + 1);
    h.index.updateIntegrationSemantics('behavior-key');
    expect(h.reads.capture().semanticsRevision).toBe(before.semanticsRevision + 1);
  });

  it('counts all duplicate authored IDs but retains only 100 resolved nodes', async () => {
    const h = await harness({
      'a.md': Array.from({ length: 101 }, (_, i) => `- [ ] Task ${i} 🆔 duplicate`).join('\n'),
    });
    const freeze = vi.spyOn(Object, 'freeze');
    const result = ok(h.reads.resolve({ authoredId: 'duplicate' }));
    expect(
      freeze.mock.calls.filter(
        ([value]) =>
          value !== null && typeof value === 'object' && 'address' in value && 'value' in value,
      ),
    ).toHaveLength(100);
    expect(result.nodes).toHaveLength(100);
    expect(result.ambiguous).toBe(true);
    expect(result.truncated).toBe(true);
    expect(ok(h.reads.resolve({ authoredId: 'absent' }))).toEqual({
      nodes: [],
      ambiguous: false,
      truncated: false,
    });
  });

  it('requires complete relevant coverage regardless of old node filters, with cursor mismatch taking precedence', async () => {
    const h = await harness({
      'a.md': '- [ ] A',
      'team/a.md': '- [ ] Team',
      'teammate/a.md': '- [ ] Sibling',
    });
    expect(
      ok(h.reads.page({ folder: 'team' }, 10)).nodes.map((row) => row.value.node.title),
    ).toEqual(['Team']);
    expect(ok(h.reads.page({ path: 'team/a.md' }, 10)).nodes).toHaveLength(1);
    const generation = h.reads.capture().generation;
    h.index.installCommittedContent('a.md', '- [ ] A');
    const pending = deferred<void>();
    vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error('unreadable');
    });
    h.app.metadataCache.trigger('changed', file(h), '', {});
    expect(h.reads.page({ statuses: ['done'] }, 10)).toMatchObject({ reason: 'incomplete' });
    expect(h.reads.page({}, 10, undefined, generation)).toMatchObject({
      reason: 'generation-changed',
    });
    expect(ok(h.reads.page({ folder: 'team' }, 10)).nodes).toHaveLength(1);
    pending.resolve();
    await flushMicrotasks();
  });

  it('does not disclose retained records for vanished or replaced current file objects', async () => {
    const h = await harness({ 'a.md': '- [ ] A' });
    const address = expectDefined(ok(h.reads.page({}, 1)).nodes[0]).address;
    const originalLookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault);
    const lookup = vi
      .spyOn(h.app.vault, 'getAbstractFileByPath')
      .mockImplementation((path) => (path === 'a.md' ? null : originalLookup(path)));
    expect(h.index.list()).toHaveLength(1);
    expect(h.reads.canDisclose(address)).toBe(false);
    expect(h.reads.node(address)).toMatchObject({ reason: 'unavailable' });
    expect(h.reads.page({}, 10)).toMatchObject({ reason: 'incomplete' });
    const replacement = await h.app.vault.create('replacement.md', '- [ ] Replacement');
    lookup.mockImplementation((path) => (path === 'a.md' ? replacement : originalLookup(path)));
    expect(h.reads.canDisclose(address)).toBe(false);
    expect(h.reads.node(address)).toMatchObject({ reason: 'unavailable' });
  });

  it('keeps ghost committed paths in legacy queries without granting integration disclosure', async () => {
    const h = await harness({});
    const roots = h.index.installCommittedContent('ghost.md', '- [ ] Ghost');
    expect(h.index.list()).toHaveLength(1);
    const root = expectDefined(roots[0]);
    const address = {
      filePath: 'ghost.md',
      rootRevision: root.ref.revision,
      rootLine: 0,
      nodeOffset: 0,
    };
    expect(h.reads.canDisclose(address)).toBe(false);
    expect(h.reads.node(address)).toMatchObject({ reason: 'unavailable' });
    expect(h.reads.page({}, 10)).toMatchObject({ reason: 'incomplete' });
  });

  it('keeps status discovery available during a failed source and rejects reads before readiness and after disposal', async () => {
    const h = await harness({ 'a.md': '' }, { initialize: false });
    expect(h.reads.page({}, 10)).toMatchObject({ reason: 'not-ready' });
    expect(h.reads.statuses()).toMatchObject({ reason: 'not-ready' });
    await h.index.initialize();
    h.index.installCommittedContent('a.md', '');
    vi.spyOn(h.app.vault, 'read').mockRejectedValueOnce(new Error('unreadable'));
    h.app.metadataCache.trigger('changed', file(h), 'conflicting', {});
    await flushMicrotasks();
    expect(h.reads.page({}, 10)).toMatchObject({ reason: 'incomplete' });
    expect(ok(h.reads.statuses()).length).toBeGreaterThan(0);
    h.dispose();
    expect(h.reads.page({}, 10)).toMatchObject({ reason: 'disposed' });
    expect(h.reads.statuses()).toMatchObject({ reason: 'disposed' });
  });

  it('does not grant a ghost acceptance the identity of a file created during its proof callback', async () => {
    const h = await harness({ 'a.md': '- [ ] Existing' });
    const originalLookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault);
    const replacement = file(h);
    let created = false;
    vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
      path === 'ghost.md' && created ? replacement : originalLookup(path),
    );
    h.index.installCommittedBatch(new Map([['ghost.md', '- [ ] Ghost']]), () => {
      created = true;
    });
    const roots = h.index.list({ filePath: 'ghost.md' });
    const root = expectDefined(roots[0]);
    expect(
      h.reads.canDisclose({
        filePath: 'ghost.md',
        rootRevision: root.ref.revision,
        rootLine: 0,
        nodeOffset: 0,
      }),
    ).toBe(false);
  });

  it('paginates 2,000 physical nodes without using ordinary whole-vault hydration or activating statistics', async () => {
    const h = await harness({
      'a.md': Array.from({ length: 1000 }, (_, i) => `- [ ] Root ${i}\n  - [ ] Child ${i}`).join(
        '\n',
      ),
    });
    vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
      throw new Error('whole-vault hydration');
    });
    const stats = h.index.readStatistics();
    const statisticsConstruction = vi.spyOn(statisticsProjection, 'TaskStatisticsProjection');
    const lines: number[] = [];
    let after: { path: string; line: number } | undefined;
    const freeze = vi.spyOn(Object, 'freeze');
    do {
      freeze.mockClear();
      const page = ok(h.reads.page({}, 10, after));
      const hydrated = freeze.mock.calls.filter(
        ([value]) =>
          value !== null && typeof value === 'object' && 'address' in value && 'value' in value,
      );
      expect(hydrated).toHaveLength(page.next === undefined ? 10 : 11);
      expect(page.nodes.length).toBeLessThanOrEqual(10);
      lines.push(...page.nodes.map((row) => row.line));
      after = page.next;
    } while (after !== undefined);
    expect(lines).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    expect(h.index.readStatistics()).toBe(stats);
    expect(statisticsConstruction).not.toHaveBeenCalled();
  });
});
