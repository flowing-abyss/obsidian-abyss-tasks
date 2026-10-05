import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TaskSearchError, type DependencyDirection } from '../src/tasks';
import * as snapshots from '../src/tasks/domain/cloneTaskSnapshot';
import { createTaskDependencySearchProvider } from '../src/ui/TaskDependencySearchProvider';
import { deferred, expectDefined, flushMicrotasks, taskQueryApi } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});
async function harness(
  files: Record<string, string>,
  readYield?: (signal: AbortSignal) => Promise<void>,
) {
  const h = await createCanonicalSearchHarness(
    files,
    structuredClone(DEFAULT_SETTINGS),
    true,
    undefined,
    undefined,
    readYield,
  );
  cleanups.push(() => {
    h.close();
  });
  const current = h.index.listNodes().find((task) => task.node.title === 'Current');
  if (current === undefined) throw new Error('Missing current fixture');
  const controller = new AbortController();
  cleanups.push(() => {
    controller.abort();
  });
  return { ...h, current, controller, signal: controller.signal };
}

describe('compact dependency eligibility', () => {
  it('uses the canonical graph in both directions without detaching roots', async () => {
    const h = await harness({
      'current.md': '- [ ] Current 🆔 current',
      'other.md': '- [ ] Candidate 🆔 candidate ⛔ current',
    });
    const cursor = await h.search.open({ kind: 'nodes', query: 'candidate' }, h.signal);
    const { hits } = await h.search.read(cursor, 0, 30, h.signal);
    const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
    expect(typeof h.index.searchEligibility).toBe('function');
    for (const [direction, reason] of [
      ['blocks', 'duplicate'],
      ['blocked-by', 'inverse'],
    ] as const) {
      const result = await h.index.searchEligibility(
        {
          expectedGeneration: cursor.generation,
          current: h.current.target,
          direction,
          addresses: hits.map((hit) => hit.address),
        },
        h.signal,
      );
      expect(result).toEqual({
        generation: cursor.generation,
        items: [
          { address: expectDefined(hits[0]).address, eligibility: { type: 'rejected', reason } },
        ],
      });
    }
    expect(detach).not.toHaveBeenCalled();
  });

  it('rejects oversize, foreign handles, obsolete current refs and global generations', async () => {
    const h = await harness({ 'current.md': '- [ ] Current', 'other.md': '- [ ] Candidate' });
    const cursor = await h.search.open({ kind: 'nodes', query: '' }, h.signal);
    const { hits } = await h.search.read(cursor, 0, 30, h.signal);
    const request = {
      expectedGeneration: cursor.generation,
      current: h.current.target,
      direction: 'blocks' as const,
      addresses: [expectDefined(hits[0]).address],
    };
    expect(typeof h.index.searchEligibility).toBe('function');
    await expect(
      h.index.searchEligibility(
        {
          ...request,
          addresses: Array.from({ length: 201 }, () => expectDefined(hits[0]).address),
        },
        h.signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      h.index.searchEligibility(
        { ...request, addresses: [{ ...expectDefined(hits[0]).address, epoch: 'foreign' }] },
        h.signal,
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    h.index.installCommittedContent('current.md', '- [ ] Changed');
    await expect(h.index.searchEligibility(request, h.signal)).rejects.toMatchObject({
      code: 'stale',
    });
    const newer = await h.search.open({ kind: 'nodes', query: '' }, h.signal);
    await expect(
      h.index.searchEligibility(
        { ...request, expectedGeneration: newer.generation, addresses: [] },
        h.signal,
      ),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('rejects a global change during candidate yields without publishing a partial batch', async () => {
    const h = await harness({
      'current.md': '- [ ] Current',
      'rich.md': siblings(3),
      'other.md': '- [ ] Other',
    });
    const cursor = await h.search.open({ kind: 'nodes', query: 'candidate' }, h.signal);
    const { hits } = await h.search.read(cursor, 0, 30, h.signal);
    const real = h.index.dependencyEligibility.bind(h.index);
    vi.spyOn(h.index, 'dependencyEligibility').mockImplementationOnce((...args) => {
      const result = real(...args);
      queueMicrotask(() => {
        h.index.installCommittedContent('other.md', '- [ ] Changed');
      });
      return result;
    });
    const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
    await expect(
      h.index.searchEligibility(
        {
          expectedGeneration: cursor.generation,
          current: h.current.target,
          direction: 'blocks',
          addresses: hits.map((hit) => hit.address),
        },
        h.signal,
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(detach).not.toHaveBeenCalled();
  });

  it('requires the real adapter for nonempty helper requests', async () => {
    const h = await harness({ 'current.md': '- [ ] Current' });
    const queries = taskQueryApi();
    expect(typeof queries.searchEligibility).toBe('function');
    const request = {
      expectedGeneration: 0,
      current: h.current.target,
      direction: 'blocks' as const,
      addresses: [],
    };
    await expect(queries.searchEligibility(request, h.signal)).resolves.toEqual({
      generation: 0,
      items: [],
    });
    await expect(
      queries.searchEligibility(
        { ...request, addresses: [{ epoch: 'test', version: 0, rootId: 1, childLines: [] }] },
        h.signal,
      ),
    ).rejects.toThrow('Search reads require configuredTaskApplication');
    await expect(
      queries.searchEligibility({ ...request, expectedGeneration: 1 }, h.signal),
    ).rejects.toMatchObject({ code: 'stale' });
  });
});

async function providerHarness(
  files: Record<string, string>,
  readYield?: (signal: AbortSignal) => Promise<void>,
) {
  const h = await harness(files, readYield);
  const provider = createTaskDependencySearchProvider(h.search, h.index, h.scheduler);
  return { ...h, provider };
}
function siblings(
  count: number,
  omitted: number[] = [],
  direction: DependencyDirection = 'blocks',
) {
  const children = Array.from(
    { length: count },
    (_, i) =>
      `  - [ ] candidate ${String(i).padStart(3, '0')} 🆔 child${i}${omitted.includes(i) && direction === 'blocks' ? ' ⛔ current' : ''}`,
  ).join('\n');
  return `- [ ] Rich root\n  Complete description\n${children}`;
}

describe('dependency search provider ranges', () => {
  it('reads exact head, tail, backward and repeated intervals without hydration; keeps the cursor', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(65) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    expect(session.totalCandidates).toBe(65);
    const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
    const release = vi.spyOn(h.search, 'release');
    const tail = await session.readRange(53, 12, h.signal);
    const head = await session.readRange(0, 12, h.signal);
    expect(head.generation).toBe(tail.generation);
    expect(head.candidates.map((c) => c.offset)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(tail.candidates.map((c) => c.offset)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 53),
    );
    expect(await session.readRange(0, 12, h.signal)).toEqual(head);
    expect(await session.readRange(53, 12, h.signal)).toEqual(tail);
    expect(detach).not.toHaveBeenCalled();
    const options = await session.options(head.candidates, h.signal);
    expect(options).toHaveLength(12);
    expect(options.every((option) => !('task' in option))).toBe(true);
    expect(release).not.toHaveBeenCalled();
    session.close();
    session.close();
    expect(release).toHaveBeenCalledTimes(1);
    await expect(session.readRange(0, 1, h.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('accepts 200 exact eligibility reads, yields per candidate, rejects 201 and invalid intervals', async () => {
    const checkpoints = vi.fn(async () => {});
    const h = await providerHarness(
      { 'current.md': '- [ ] Current', 'rich.md': siblings(205) },
      checkpoints,
    );
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const range = await session.readRange(0, 200, h.signal);
    expect(range.candidates).toHaveLength(200);
    const request = {
      expectedGeneration: session.generation,
      current: h.current.target,
      direction: 'blocks' as const,
      addresses: range.candidates.map((c) => c.hit.address),
    };
    const eligibility = vi.spyOn(h.index, 'dependencyEligibility');
    checkpoints.mockClear();
    await expect(h.index.searchEligibility(request, h.signal)).resolves.toMatchObject({
      generation: session.generation,
    });
    expect(eligibility).toHaveBeenCalledTimes(200);
    expect(checkpoints).toHaveBeenCalledTimes(200);
    await expect(
      h.index.searchEligibility(
        { ...request, addresses: [...request.addresses, expectDefined(request.addresses[0])] },
        h.signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    for (const [offset, limit] of [
      [0, 201],
      [-1, 1],
      [206, 1],
      [0.5, 1],
      [0, 0],
      [0, 1.5],
    ])
      await expect(
        session.readRange(expectDefined(offset), expectDefined(limit), h.signal),
      ).rejects.toMatchObject({
        code: 'invalid-request',
      });
  });

  it.each(['blocks', 'blocked-by'] as const)(
    'projects requested siblings only and detaches their root once (%s)',
    async (direction) => {
      const h = await providerHarness({
        'current.md': `- [ ] Current 🆔 current${direction === 'blocked-by' ? ' ⛔ child29' : ''}`,
        'rich.md': siblings(31, [29], direction),
      });
      const session = await h.provider.open('candidate', h.current.target, direction, h.signal);
      const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
      const range = await session.readRange(0, 31, h.signal);
      expect(range.candidates).toHaveLength(31);
      expect(detach).not.toHaveBeenCalled();
      const options = await session.options(range.candidates, h.signal);
      expect(options.map((o) => o.title)).toEqual(
        Array.from({ length: 31 }, (_, i) => `candidate ${String(i).padStart(3, '0')}`).filter(
          (t) => t !== 'candidate 029',
        ),
      );
      expect(detach).toHaveBeenCalledTimes(1);
      expect(options.every((o) => !('task' in o))).toBe(true);
      expect(options[0]).toMatchObject({ context: 'rich.md:3', directions: [direction] });
    },
  );

  it('returns omitted candidates exactly without hydrating or implying exhaustion', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Current 🆔 current',
      'rich.md': siblings(
        120,
        Array.from({ length: 120 }, (_, i) => i),
      ),
    });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const hydrate = vi.spyOn(h.search, 'resolveHits');
    const range = await session.readRange(40, 20, h.signal);
    expect(range.candidates).toHaveLength(20);
    expect(range.candidates.every((c) => c.eligibility.type === 'rejected')).toBe(true);
    expect(await session.options(range.candidates, h.signal)).toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
    expect(session.totalCandidates).toBe(120);
  });

  it.each(['rich.md', 'other.md', 'current.md'])(
    'rejects source changes between eligibility and projection (%s)',
    async (path) => {
      const h = await providerHarness({
        'current.md': '- [ ] Current',
        'rich.md': siblings(2),
        'other.md': '- [ ] Other',
      });
      const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
      const range = await session.readRange(0, 2, h.signal);
      const hydrate = vi.spyOn(h.search, 'resolveHits');
      h.index.installCommittedContent(path, '- [ ] Changed');
      await expect(session.options(range.candidates, h.signal)).rejects.toMatchObject({
        code: 'stale',
      });
      expect(hydrate).not.toHaveBeenCalled();
    },
  );

  it('rechecks source after hydration and discards its rich values', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Current',
      'rich.md': siblings(2),
      'other.md': '- [ ] Other',
    });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const range = await session.readRange(0, 2, h.signal);
    const real = h.search.resolveHits.bind(h.search);
    vi.spyOn(h.search, 'resolveHits').mockImplementation(async (...args) => {
      const result = await real(...args);
      h.index.installCommittedContent('other.md', '- [ ] Changed');
      return result;
    });
    await expect(session.options(range.candidates, h.signal)).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('abort cancels only its session; per-read cancellation keeps the other cursor usable', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(3) });
    const other = new AbortController();
    const first = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const second = await h.provider.open('candidate', h.current.target, 'blocked-by', other.signal);
    h.controller.abort();
    await expect(first.readRange(0, 1, other.signal)).rejects.toMatchObject({ code: 'aborted' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(second.readRange(0, 1, cancelled.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect((await second.readRange(0, 3, other.signal)).candidates).toHaveLength(3);
    second.close();
  });

  it.each(['rename', 'duplicate', 'cycle'] as const)(
    'fresh resolve refuses a changed %s and revalidates exact authority',
    async (change) => {
      const h = await providerHarness({
        'current.md': '- [ ] Current 🆔 current ⛔ middle',
        'middle.md': '- [ ] Middle 🆔 middle',
        'rich.md': '- [ ] candidate 🆔 candidate',
      });
      const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
      const range = await session.readRange(0, 1, h.signal);
      const address = expectDefined(range.candidates[0]).hit.address;
      const first = await session.resolve(address, h.signal);
      const second = await session.resolve(address, h.signal);
      expect(second.target).toEqual(first.target);
      expect(second.root).not.toBe(first.root);
      const replacements = {
        cycle: '- [ ] Middle 🆔 middle ⛔ candidate',
        duplicate: '- [ ] candidate 🆔 candidate ⛔ current',
        rename: '- [ ] Renamed 🆔 candidate',
      };
      h.index.installCommittedContent(
        change === 'cycle' ? 'middle.md' : 'rich.md',
        replacements[change],
      );
      await expect(session.resolve(address, h.signal)).rejects.toMatchObject({ code: 'stale' });
      if (change === 'cycle') {
        const fresh = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
        const options = await fresh.options(
          (await fresh.readRange(0, 1, h.signal)).candidates,
          h.signal,
        );
        expect(options[0]).toMatchObject({
          directions: [],
          disabledReason: 'Would create a cycle',
        });
        await expect(fresh.resolve(address, h.signal)).rejects.toMatchObject({ code: 'stale' });
      }
    },
  );

  it('subscribes before open and releases a late reply after cancellation', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
    const subscribe = vi.spyOn(h.search, 'subscribe');
    const real = h.search.open.bind(h.search);
    vi.spyOn(h.search, 'open').mockImplementation(async (...args) => {
      expect(subscribe).toHaveBeenCalledTimes(1);
      const cursor = await real(...args);
      h.controller.abort();
      return cursor;
    });
    const release = vi.spyOn(h.search, 'release');
    await expect(
      h.provider.open('candidate', h.current.target, 'blocks', h.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('empty dependency ranges', () => {
  it.each([
    ['root', 'changed', 'no-match'],
    ['root', 'deleted', 'no-match'],
    ['nested', 'changed', 'no-match'],
    ['nested', 'deleted', 'no-match'],
    ['root', 'changed', 'terminal'],
    ['root', 'deleted', 'terminal'],
    ['nested', 'changed', 'terminal'],
    ['nested', 'deleted', 'terminal'],
  ] as const)('rejects a captured %s ref %s before open (%s)', async (level, change, pageKind) => {
    const h = await providerHarness({
      'current.md': '- [ ] Current\n  - [ ] Child\n    - [ ] Nested',
      'candidate.md': '- [ ] Candidate',
    });
    const current =
      level === 'root'
        ? h.current.target
        : expectDefined(h.index.listNodes().find(({ node }) => node.title === 'Nested')).target;
    const changed =
      level === 'root' ? '- [ ] Changed' : '- [ ] Current\n  - [ ] Child\n    - [ ] Changed';
    const deleted = level === 'root' ? '' : '- [ ] Current\n  - [ ] Child';
    const replacement = change === 'changed' ? changed : deleted;
    h.index.installCommittedContent('current.md', replacement);
    const session = await h.provider.open(
      pageKind === 'no-match' ? 'nonexistentxyz' : 'Candidate',
      current,
      'blocks',
      h.signal,
    );
    const evaluate = vi.spyOn(h.index, 'dependencyEligibility');
    const prepare = vi.spyOn(h.index, 'prepareDependencies');
    const hydrate = vi.spyOn(h.search, 'resolveHits');
    const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
    await expect(
      session.readRange(pageKind === 'no-match' ? 0 : 1, 1, h.signal),
    ).rejects.toMatchObject({
      code: 'stale',
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it.each(['nonexistentxyz', ''])(
    'validates valid empty/terminal pages without candidate work (query=%s)',
    async (query) => {
      const h = await providerHarness({ 'current.md': '- [ ] Current' });
      const session = await h.provider.open(query, h.current.target, 'blocks', h.signal);
      const eligibility = vi.spyOn(h.index, 'searchEligibility');
      const prepare = vi.spyOn(h.index, 'prepareDependencies');
      const evaluate = vi.spyOn(h.index, 'dependencyEligibility');
      const hydrate = vi.spyOn(h.search, 'resolveHits');
      const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
      const offset = query === '' ? 1 : 0;
      expect(await session.readRange(offset, 1, h.signal)).toEqual({
        offset,
        generation: session.generation,
        candidates: [],
      });
      expect(eligibility).toHaveBeenCalledTimes(1);
      expect(eligibility.mock.calls[0]?.[0]).toMatchObject({
        current: h.current.target,
        addresses: [],
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
      if (query === '') expect(h.backends).toHaveLength(0);
    },
  );

  it('keeps empty eligibility signal/generation/current authority without graph preparation', async () => {
    const h = await harness({ 'current.md': '- [ ] Current' });
    const cursor = await h.search.open({ kind: 'nodes', query: '' }, h.signal);
    const request = {
      expectedGeneration: cursor.generation,
      current: h.current.target,
      direction: 'blocks' as const,
      addresses: [],
    };
    const prepare = vi.spyOn(h.index, 'prepareDependencies');
    const evaluate = vi.spyOn(h.index, 'dependencyEligibility');
    await expect(h.index.searchEligibility(request, h.signal)).resolves.toEqual({
      generation: cursor.generation,
      items: [],
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(h.index.searchEligibility(request, cancelled.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    h.index.installCommittedContent('other.md', '- [ ] Other');
    await expect(h.index.searchEligibility(request, h.signal)).rejects.toMatchObject({
      code: 'stale',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(h.backends).toHaveLength(0);
  });
});

it('serializes session operations while a cancelled read is still unwinding', async () => {
  const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(3) });
  const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
  const held = deferred<void>();
  const entered = deferred<void>();
  const real = h.search.read.bind(h.search);
  const read = vi.spyOn(h.search, 'read').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await held.promise;
    return real(...args);
  });
  const first = session.readRange(0, 1, h.signal);
  const rejected = expect(first).rejects.toMatchObject({ code: 'aborted' });
  await entered.promise;
  const second = session.readRange(2, 1, h.signal);
  await flushMicrotasks(20);
  expect(read).toHaveBeenCalledTimes(1);
  held.resolve();
  await rejected;
  expect((await second).candidates[0]?.offset).toBe(2);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['offset', 'cursor', 'short', 'done'] as const)(
  'rejects malformed cursor progress (%s) before eligibility',
  async (fault) => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(3) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const real = h.search.read.bind(h.search);
    vi.spyOn(h.search, 'read').mockImplementationOnce(async (...args) => {
      const batch = await real(...args);
      if (fault === 'offset') return { ...batch, offset: 1 };
      if (fault === 'cursor') return { ...batch, cursor: { ...batch.cursor, id: 'foreign' } };
      if (fault === 'short') return { ...batch, hits: batch.hits.slice(1) };
      return { ...batch, done: true };
    });
    const check = vi.spyOn(h.index, 'searchEligibility');
    await expect(session.readRange(0, 2, h.signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(check).not.toHaveBeenCalled();
    expect((await session.readRange(0, 2, h.signal)).candidates).toHaveLength(2);
  },
);

it('groups interleaved sibling roots before bounded 50-root projection', async () => {
  const files: Record<string, string> = { 'current.md': '- [ ] Current' };
  for (let i = 0; i < 51; i++) files[`r${String(i).padStart(2, '0')}.md`] = siblings(2);
  const h = await providerHarness(files);
  const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
  const candidates = (await session.readRange(0, 200, h.signal)).candidates;
  const interleaved = [
    ...candidates.filter((c) => c.offset % 2 === 0),
    ...candidates.filter((c) => c.offset % 2 !== 0),
  ];
  const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
  const hydrate = vi.spyOn(h.search, 'resolveHits');
  const options = await session.options(interleaved, h.signal);
  expect(options.map((o) => o.offset)).toEqual(interleaved.map((c) => c.offset));
  expect(detach).toHaveBeenCalledTimes(51);
  expect(hydrate.mock.calls.map(([hits]) => hits.length)).toEqual([100, 2]);
});

it('yields and repeats a root detach only for an exceptional demand above 200 siblings', async () => {
  const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(205) });
  const yieldTask = vi.fn(async () => {});
  const provider = createTaskDependencySearchProvider(h.search, h.index, { yield: yieldTask });
  const session = await provider.open('candidate', h.current.target, 'blocks', h.signal);
  const first = await session.readRange(0, 200, h.signal);
  const last = await session.readRange(200, 5, h.signal);
  const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
  const hydrate = vi.spyOn(h.search, 'resolveHits');
  const options = await session.options([...first.candidates, ...last.candidates], h.signal);
  expect(options).toHaveLength(205);
  expect(hydrate.mock.calls.map(([hits]) => hits.length)).toEqual([200, 5]);
  expect(detach).toHaveBeenCalledTimes(2);
  expect(yieldTask).toHaveBeenCalled();
});

it('releases acquisition subscription on open failure without resetting shared search', async () => {
  const h = await providerHarness({ 'current.md': '- [ ] Current' });
  const real = h.search.subscribe.bind(h.search);
  const stop = vi.fn();
  vi.spyOn(h.search, 'subscribe').mockImplementation((listener) => {
    const unsubscribe = real(listener);
    return () => {
      stop();
      unsubscribe();
    };
  });
  vi.spyOn(h.search, 'open').mockRejectedValueOnce(
    new TaskSearchError('unavailable', 'failed read'),
  );
  await expect(
    h.provider.open('candidate', h.current.target, 'blocks', h.signal),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(stop).toHaveBeenCalledTimes(1);
  const session = await h.provider.open('', h.current.target, 'blocks', h.signal);
  expect((await session.readRange(0, 1, h.signal)).candidates).toHaveLength(1);
});

it('retains ambiguous candidates disabled, with full paths, without rich list scans', async () => {
  const h = await providerHarness({
    'current.md': '- [ ] Current',
    'a.md': '- [ ] candidate 🆔 duplicate',
    'b.md': '- [ ] candidate 🆔 duplicate',
  });
  vi.spyOn(h.index, 'list').mockImplementation(() => {
    throw new Error('Full list forbidden');
  });
  vi.spyOn(h.index, 'listNodes').mockImplementation(() => {
    throw new Error('Full node list forbidden');
  });
  const session = await h.provider.open('candidate', h.current.target, 'blocked-by', h.signal);
  const range = await session.readRange(0, 2, h.signal);
  const options = await session.options(range.candidates, h.signal);
  expect(
    options.map(({ context, disabledReason, directions }) => ({
      context,
      disabledReason,
      directions,
    })),
  ).toEqual([
    { context: 'a.md:1', disabledReason: 'Multiple tasks use this ID', directions: [] },
    { context: 'b.md:1', disabledReason: 'Multiple tasks use this ID', directions: [] },
  ]);
});

it('uses exact nested current identity and freshly resolves the selected sibling', async () => {
  const h = await providerHarness({
    'current.md': '- [ ] Owner\n  - [ ] Current 🆔 current',
    'rich.md': siblings(3, [0]),
  });
  const open = vi.spyOn(h.search, 'open');
  const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
  expect(open.mock.calls[0]?.[0]).toEqual({
    kind: 'nodes',
    query: 'candidate',
    includeSourcePath: true,
    preferFilePath: 'current.md',
  });
  const range = await session.readRange(0, 3, h.signal);
  const options = await session.options(range.candidates, h.signal);
  expect(options.map((o) => o.title)).toEqual(['candidate 001', 'candidate 002']);
  const option = expectDefined(options[1]);
  const fresh = await session.resolve(option.address, h.signal);
  expect(fresh.node.title).toBe('candidate 002');
  expect((await session.resolve(option.address, h.signal)).root).not.toBe(fresh.root);
});

it.each(['deleted', 'renamed', 'moved'] as const)(
  'rejects a %s nested candidate without rebasing its address',
  async (change) => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const address = expectDefined((await session.readRange(0, 1, h.signal)).candidates[0]).hit
      .address;
    const replacement = {
      deleted: '',
      renamed: siblings(1).replace('candidate 000', 'Renamed'),
      moved: `\n${siblings(1)}`,
    };
    h.index.installCommittedContent('rich.md', replacement[change]);
    await expect(session.resolve(address, h.signal)).rejects.toMatchObject({ code: 'stale' });
  },
);

it('rejects a generation change before open returns and releases that acquired cursor', async () => {
  const h = await providerHarness({
    'current.md': '- [ ] Current',
    'rich.md': siblings(1),
    'other.md': '- [ ] Other',
  });
  const real = h.search.open.bind(h.search);
  vi.spyOn(h.search, 'open').mockImplementation(async (...args) => {
    const cursor = await real(...args);
    h.index.installCommittedContent('other.md', '- [ ] Changed');
    return cursor;
  });
  const release = vi.spyOn(h.search, 'release');
  await expect(
    h.provider.open('candidate', h.current.target, 'blocks', h.signal),
  ).rejects.toMatchObject({ code: 'stale' });
  expect(release).toHaveBeenCalledTimes(1);
});

it('owner abort cancels held eligibility and releases exactly its cursor without hydration', async () => {
  const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(2) });
  const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
  const held = deferred<void>();
  const entered = deferred<AbortSignal>();
  const real = h.index.searchEligibility.bind(h.index);
  vi.spyOn(h.index, 'searchEligibility').mockImplementationOnce(async (request, signal) => {
    entered.resolve(signal);
    await held.promise;
    return real(request, signal);
  });
  const release = vi.spyOn(h.search, 'release');
  const hydrate = vi.spyOn(h.search, 'resolveHits');
  const pending = session.readRange(0, 2, h.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
  const signal = await entered.promise;
  h.controller.abort();
  expect(signal.aborted).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
  held.resolve();
  await rejected;
  expect(hydrate).not.toHaveBeenCalled();
  session.close();
  expect(release).toHaveBeenCalledTimes(1);
});

it('preserves disabled cycle reasons and fresh exact revalidation in blocked-by direction', async () => {
  const h = await providerHarness({
    'current.md': '- [ ] Current 🆔 current',
    'middle.md': '- [ ] Middle 🆔 middle ⛔ current',
    'rich.md': '- [ ] candidate 🆔 candidate ⛔ middle',
  });
  const session = await h.provider.open('candidate', h.current.target, 'blocked-by', h.signal);
  const range = await session.readRange(0, 1, h.signal);
  const options = await session.options(range.candidates, h.signal);
  expect(options[0]).toMatchObject({ directions: [], disabledReason: 'Would create a cycle' });
  await expect(session.resolve(expectDefined(options[0]).address, h.signal)).rejects.toMatchObject({
    code: 'stale',
  });
});

it.each(['rename', 'delete'] as const)(
  'rejects actual in-memory file %s without rebasing selection',
  async (action) => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const address = expectDefined((await session.readRange(0, 1, h.signal)).candidates[0]).hit
      .address;
    const file = h.app.vault.getAbstractFileByPath('rich.md');
    if (!(file instanceof TFile)) throw new Error('Missing fixture file');
    if (action === 'rename') await h.app.vault.rename(file, 'renamed.md');
    else await h.app.fileManager.trashFile(file);
    await expect(session.resolve(address, h.signal)).rejects.toMatchObject({ code: 'stale' });
  },
);
