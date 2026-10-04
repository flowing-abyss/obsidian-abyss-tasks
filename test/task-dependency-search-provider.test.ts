import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { DependencyDirection } from '../src/tasks';
import * as snapshots from '../src/tasks/domain/cloneTaskSnapshot';
import { createTaskDependencySearchProvider } from '../src/ui/TaskDependencySearchProvider';
import { expectDefined, taskQueryApi } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});
async function harness(files: Record<string, string>) {
  const h = await createCanonicalSearchHarness(files, structuredClone(DEFAULT_SETTINGS));
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
        { ...request, addresses: Array.from({ length: 31 }, () => expectDefined(hits[0]).address) },
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

async function providerHarness(files: Record<string, string>) {
  const h = await harness(files);
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

describe('dependency search provider', () => {
  it.each(['blocks', 'blocked-by'] as const)(
    'hydrates 31 siblings across compact batches once (%s)',
    async (direction) => {
      const h = await providerHarness({
        'current.md': `- [ ] Current 🆔 current${direction === 'blocked-by' ? ' ⛔ child29' : ''}`,
        'rich.md': siblings(31, [29], direction),
      });
      const rich = expectDefined(h.index.list({ filePath: 'rich.md' })[0]);
      const expected = h.index
        .listNodes({ filePath: 'rich.md' })
        .filter(
          (task) => task.node.title.startsWith('candidate') && task.node.title !== 'candidate 029',
        )
        .map((task) => task.target);
      const session = await h.provider.open('candidate', h.current.target, direction, h.signal);
      const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
      const hydrate = vi.spyOn(h.search, 'resolvePage');
      const eligibility = vi.spyOn(h.index, 'searchEligibility');
      const page = await session.page(0, h.signal);
      expect(page.options.map((option) => option.task.target)).toEqual(expected);
      expect(page).toMatchObject({
        nextOffset: 31,
        totalCandidates: 31,
        hasMore: false,
        budgetExhausted: false,
      });
      expect(new Set(page.options.map((option) => option.task.root)).size).toBe(1);
      expect(expectDefined(page.options[0]).task.root).not.toBe(rich);
      expect(
        detach.mock.calls.filter(
          ([root]) =>
            root.ref.filePath === rich.ref.filePath &&
            root.ref.line === rich.ref.line &&
            root.ref.revision === rich.ref.revision,
        ),
      ).toHaveLength(1);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(eligibility.mock.calls.map(([request]) => request.addresses.length)).toEqual([30, 1]);
      expect(page.options[0]).toMatchObject({ context: 'rich.md:3', directions: [direction] });
    },
  );

  it('checks at most 90 omitted candidates without hydration or a blank-browse engine build', async () => {
    const h = await providerHarness({
      'a.md': '- [ ] Current 🆔 current',
      'b.md': Array.from({ length: 120 }, (_, i) => `- [ ] Candidate ${i} ⛔ current`).join('\n'),
    });
    const session = await h.provider.open('', h.current.target, 'blocks', h.signal);
    const detach = vi.spyOn(snapshots, 'taskSnapshotWithStatuses');
    const hydrate = vi.spyOn(h.search, 'resolvePage');
    const eligibility = vi.spyOn(h.index, 'dependencyEligibility');
    const page = await session.page(0, h.signal);
    expect(page).toMatchObject({
      options: [],
      nextOffset: 90,
      hasMore: true,
      budgetExhausted: true,
    });
    expect(eligibility).toHaveBeenCalledTimes(90);
    expect(hydrate).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(h.backends).toHaveLength(0);
  });

  it.each(['rich.md', 'unrelated.md'])(
    'rejects the entire assembly on %s changes between batches',
    async (path) => {
      const h = await providerHarness({
        'current.md': '- [ ] Current 🆔 current',
        'rich.md': siblings(31, [29]),
        'unrelated.md': '- [ ] Unrelated',
      });
      const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
      const real = h.index.searchEligibility.bind(h.index);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      vi.spyOn(h.index, 'searchEligibility').mockImplementation(async (request, signal) => {
        if (++calls === 2) {
          entered();
          await held;
        }
        return real(request, signal);
      });
      const hydrate = vi.spyOn(h.search, 'resolvePage');
      const pending = session.page(0, h.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'stale' });
      await waiting;
      h.index.installCommittedContent(path, '- [ ] Changed');
      release();
      await rejected;
      expect(hydrate).not.toHaveBeenCalled();
    },
  );

  it('rechecks generation after final hydration even for an unrelated update', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Current',
      'rich.md': siblings(1),
      'other.md': '- [ ] Other',
    });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const real = h.search.resolvePage.bind(h.search);
    vi.spyOn(h.search, 'resolvePage').mockImplementation(async (...args) => {
      const result = await real(...args);
      h.index.installCommittedContent('other.md', '- [ ] Changed');
      return result;
    });
    await expect(session.page(0, h.signal)).rejects.toMatchObject({ code: 'stale' });
  });

  it('retains the last-page cursor for Previous and consumes only displayed candidates', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(65) });
    const open = vi.spyOn(h.search, 'open');
    const release = vi.spyOn(h.search, 'release');
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const first = await session.page(0, h.signal);
    const second = await session.page(first.nextOffset, h.signal);
    const last = await session.page(second.nextOffset, h.signal);
    expect(last).toMatchObject({ startOffset: 60, nextOffset: 65, hasMore: false });
    const previous = await session.page(second.startOffset, h.signal);
    expect(previous.options.map((option) => option.address)).toEqual(
      second.options.map((option) => option.address),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    session.close();
    session.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('owner abort closes only its session while another picker can still page', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(3) });
    const otherOwner = new AbortController();
    const first = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const second = await h.provider.open(
      'candidate',
      h.current.target,
      'blocked-by',
      otherOwner.signal,
    );
    const release = vi.spyOn(h.search, 'release');
    h.controller.abort();
    await expect(first.page(0, otherOwner.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect((await second.page(0, otherOwner.signal)).options).toHaveLength(3);
    expect(release).toHaveBeenCalledTimes(1);
    second.close();
  });

  it.each(['deleted', 'renamed', 'moved'] as const)(
    'fresh resolve rejects a %s candidate',
    async (change) => {
      const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
      const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
      const option = expectDefined((await session.page(0, h.signal)).options[0]);
      const replacements = {
        deleted: '',
        renamed: siblings(1).replace('candidate 000', 'Renamed'),
        moved: `\n${siblings(1)}`,
      };
      h.index.installCommittedContent('rich.md', replacements[change]);
      await expect(session.resolve(option.address, h.signal)).rejects.toMatchObject({
        code: 'stale',
      });
    },
  );

  it.each(['blocks', 'blocked-by'] as const)(
    'fresh resolve enforces the actual cycle rule (%s)',
    async (direction) => {
      const files =
        direction === 'blocks'
          ? {
              'current.md': '- [ ] Current 🆔 current ⛔ middle',
              'middle.md': '- [ ] Middle 🆔 middle ⛔ candidate',
              'rich.md': '- [ ] candidate 🆔 candidate',
            }
          : {
              'current.md': '- [ ] Current 🆔 current',
              'middle.md': '- [ ] Middle 🆔 middle ⛔ current',
              'rich.md': '- [ ] candidate 🆔 candidate ⛔ middle',
            };
      const h = await providerHarness(files);
      const session = await h.provider.open('candidate', h.current.target, direction, h.signal);
      const option = expectDefined((await session.page(0, h.signal)).options[0]);
      expect(option).toMatchObject({ directions: [], disabledReason: 'Would create a cycle' });
      const hydrate = vi.spyOn(h.search, 'resolvePage');
      const eligibility = vi.spyOn(h.index, 'searchEligibility');
      await expect(session.resolve(option.address, h.signal)).rejects.toMatchObject({
        code: 'stale',
      });
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(eligibility).toHaveBeenCalledTimes(1);
    },
  );

  it('subscribes before opening and rejects a generation change before open returns', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Current',
      'rich.md': siblings(1),
      'other.md': '- [ ] Other',
    });
    const subscribe = vi.spyOn(h.search, 'subscribe');
    const real = h.search.open.bind(h.search);
    vi.spyOn(h.search, 'open').mockImplementation(async (...args) => {
      expect(subscribe).toHaveBeenCalledTimes(1);
      const cursor = await real(...args);
      h.index.installCommittedContent('other.md', '- [ ] Changed');
      return cursor;
    });
    await expect(
      h.provider.open('candidate', h.current.target, 'blocks', h.signal),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('aborts an obsolete page but retains the session for a new page request', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(35) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const real = h.index.searchEligibility.bind(h.index);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldSignal: AbortSignal | undefined;
    vi.spyOn(h.index, 'searchEligibility').mockImplementationOnce(async (request, signal) => {
      oldSignal = signal;
      entered();
      await held;
      return real(request, signal);
    });
    const pending = session.page(0, h.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await waiting;
    const fresh = session.page(30, h.signal);
    expect(oldSignal?.aborted).toBe(true);
    release();
    await rejected;
    expect((await fresh).options.map((option) => option.title)).toEqual([
      'candidate 030',
      'candidate 031',
      'candidate 032',
      'candidate 033',
      'candidate 034',
    ]);
  });

  it('owner abort cancels pending eligibility and releases exactly its cursor', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(2) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const real = h.index.searchEligibility.bind(h.index);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pendingSignal: AbortSignal | undefined;
    vi.spyOn(h.index, 'searchEligibility').mockImplementationOnce(async (request, signal) => {
      pendingSignal = signal;
      entered();
      await held;
      return real(request, signal);
    });
    const released = vi.spyOn(h.search, 'release');
    const hydrate = vi.spyOn(h.search, 'resolvePage');
    const pending = session.page(0, h.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await waiting;
    h.controller.abort();
    expect(pendingSignal?.aborted).toBe(true);
    expect(released).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect(hydrate).not.toHaveBeenCalled();
    session.close();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('releases a late open reply after query-owner cancellation', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
    const real = h.search.open.bind(h.search);
    vi.spyOn(h.search, 'open').mockImplementation(async (...args) => {
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

  it('per-page cancellation leaves the cursor available for a later read', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(2) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(session.page(0, cancelled.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect((await session.page(0, h.signal)).options).toHaveLength(2);
  });

  it('rejects a cycle introduced after display even when the chosen address remains exact', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Current 🆔 current ⛔ middle',
      'middle.md': '- [ ] Middle 🆔 middle',
      'rich.md': '- [ ] candidate 🆔 candidate',
    });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const option = expectDefined((await session.page(0, h.signal)).options[0]);
    expect(option.directions).toEqual(['blocks']);
    h.index.installCommittedContent('middle.md', '- [ ] Middle 🆔 middle ⛔ candidate');
    expect(
      (await h.search.resolvePage([{ address: option.address, score: 0 }], h.signal))[0]?.task
        .target,
    ).toEqual(option.task.target);
    await expect(session.resolve(option.address, h.signal)).rejects.toMatchObject({
      code: 'stale',
    });
    const fresh = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    await expect(fresh.resolve(option.address, h.signal)).rejects.toMatchObject({ code: 'stale' });
  });

  it('includes ambiguous candidates disabled and uses full paths to disambiguate titles', async () => {
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
    const page = await session.page(0, h.signal);
    expect(
      page.options.map(({ context, disabledReason, directions }) => ({
        context,
        disabledReason,
        directions,
      })),
    ).toEqual([
      { context: 'a.md:1', disabledReason: 'Multiple tasks use this ID', directions: [] },
      { context: 'b.md:1', disabledReason: 'Multiple tasks use this ID', directions: [] },
    ]);
  });

  it('uses exact nested current identity and prefers its containing file', async () => {
    const h = await providerHarness({
      'current.md': '- [ ] Owner\n  - [ ] Current 🆔 current',
      'rich.md': '- [ ] candidate linked ⛔ current\n- [ ] candidate allowed',
    });
    expect(h.current.target.type).toBe('subtask');
    const open = vi.spyOn(h.search, 'open');
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    expect(open.mock.calls[0]?.[0]).toEqual({
      kind: 'nodes',
      query: 'candidate',
      includeSourcePath: true,
      preferFilePath: 'current.md',
    });
    const page = await session.page(0, h.signal);
    expect(page.options.map((option) => option.title)).toEqual(['candidate allowed']);
    const option = expectDefined(page.options[0]);
    expect((await session.resolve(option.address, h.signal)).target).toEqual(option.task.target);
  });

  it.each(['rename', 'delete'] as const)(
    'rejects actual in-memory file %s without rebasing selection',
    async (action) => {
      const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(1) });
      const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
      const option = expectDefined((await session.page(0, h.signal)).options[0]);
      const file = h.app.vault.getAbstractFileByPath('rich.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture file');
      if (action === 'rename') await h.app.vault.rename(file, 'renamed.md');
      else await h.app.fileManager.trashFile(file);
      await expect(session.resolve(option.address, h.signal)).rejects.toMatchObject({
        code: 'stale',
      });
    },
  );

  it('fresh resolve returns the exact selected sibling from a new hydration', async () => {
    const h = await providerHarness({ 'current.md': '- [ ] Current', 'rich.md': siblings(2) });
    const session = await h.provider.open('candidate', h.current.target, 'blocks', h.signal);
    const option = expectDefined((await session.page(0, h.signal)).options[1]);
    const fresh = await session.resolve(option.address, h.signal);
    expect(fresh.target).toEqual(option.task.target);
    expect(fresh.root).not.toBe(option.task.root);
  });
});
