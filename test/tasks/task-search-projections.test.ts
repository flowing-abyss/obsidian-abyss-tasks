import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloning from '../../src/tasks/domain/cloneTaskSnapshot';
import {
  rootTaskNodeSnapshot,
  taskNodeSourceLine,
  taskSearchAddressKey,
} from '../../src/tasks/domain/taskSearchProjection';
import type {
  TaskOrganizationRecord,
  TaskOrganizationRequest,
} from '../../src/tasks/domain/taskSearchTypes';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { canonicalStatusCatalog, createAppWithFiles, expectDefined } from '../helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});
async function setup(markdown: string, readYield?: (signal: AbortSignal) => Promise<void>) {
  const app = await createAppWithFiles({ 'a.md': markdown });
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    refAuthority: new TaskRefAuthority('projection-tests'),
    ...(readYield === undefined ? {} : { readYield }),
  });
  indexes.push(index);
  await index.initialize();
  return index;
}
const signal = () => new AbortController().signal;
function hits(index: TaskIndex) {
  const source = index.searchSource();
  return source
    .files()
    .flatMap((file) => [...source.nodes(file)])
    .map((node) => ({ address: expectDefined(source.address(node.id)), score: 1 }));
}
async function records(
  index: TaskIndex,
  request: Omit<TaskOrganizationRequest, 'expectedGeneration'> = {},
) {
  const generation = index.searchSource().subscribe(() => {}).state.generation;
  const batches = [];
  for await (const batch of index.organization(
    { expectedGeneration: generation, ...request },
    signal(),
  ))
    batches.push(batch);
  return batches;
}

describe('bounded exact search projections', () => {
  it('node scope projects own fields and full paths while omission stays roots', async () => {
    const index = await setup(
      '- [ ] Parent #one-off\n  - [ ] Same #inbox\n    - [/] Deep #work\n  - [ ] Same #other\n',
    );
    const generation = index.searchSource().subscribe(() => {}).state.generation;
    const found: TaskOrganizationRecord[] = [];
    for await (const batch of index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      signal(),
    ))
      found.push(...batch.items);
    expect(found.map((r) => [r.depth, r.tags, r.source.line])).toEqual([
      [0, ['#one-off'], 0],
      [1, ['#inbox'], 1],
      [2, ['#work'], 2],
      [1, ['#other'], 3],
    ]);
    expect(new Set(found.map((r) => taskSearchAddressKey(r.address))).size).toBe(4);
    expect((await records(index)).flatMap((b) => b.items)).toHaveLength(1);
    const hydrated = await index.resolveSearchHits(
      found.map((r) => ({ address: r.address, score: 0 })),
      signal(),
    );
    expect(hydrated[2]?.task.path.map((n) => n.title)).toEqual(['Same', 'Deep']);
    expect(hydrated[2]?.task.root.title).toBe('Parent');
  });
  it('one clone for sibling and duplicate occurrences; rejects guessed child paths', async () => {
    const index = await setup('- [ ] Root\n  - [ ] Child\n  - [ ] Child2\n');
    const page = hits(index);
    vi.spyOn(index, 'resolve').mockImplementation(() => {
      throw new Error('must not rebase');
    });
    const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
    const results = await index.resolveSearchHits([...page, ...page], signal());
    expect(detach).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.task.root)).size).toBe(1);
    const first = expectDefined(page[0]);
    await expect(
      index.resolveSearchHits(
        [{ ...first, address: { ...first.address, childLines: [999] } }],
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
  });
  it('200 node and 50 root cap', async () => {
    const index = await setup(Array.from({ length: 51 }, (_, i) => `- [ ] Root ${i}`).join('\n'));
    const page = hits(index);
    await expect(index.resolveSearchHits(page, signal())).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      index.resolveSearchHits(
        Array.from({ length: 201 }, () => expectDefined(page[0])),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(await index.resolveSearchHits(page.slice(0, 50), signal())).toHaveLength(50);
  });
  it('organization yields no blocks or rich arrays and detaches nested values', async () => {
    const index = await setup('- [ ] Root #root\n  - [ ] Child #child\n');
    const batches = await records(index);
    const item = expectDefined(batches[0]?.items[0]);
    expect(item.treeTags).toEqual(['#root', '#child']);
    expect(Object.keys(item).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'address',
        'depth',
        'markdownTitle',
        'planning',
        'priority',
        'source',
        'status',
        'statusSymbol',
        'tags',
        'title',
        'tracked',
        'treeTags',
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(item.source).toEqual({ filePath: 'a.md', line: 0 });
    expect(JSON.stringify(item)).not.toContain('revision');
    expect(JSON.stringify(item)).not.toContain('originalBlock');
    expect((await records(index))[0]?.items[0]?.planning).not.toBe(item.planning);
  });

  it('node scope keeps own metadata and subtree aggregates detached without canonical clones', async () => {
    const index = await setup(
      'Heading\n\n- [ ] Parent #parent 📅 2026-10-09 ⏫\n  - [/] **Same** #child ⏳ 2026-10-08 🔽\n    - 2026-10-04T10:00:00+07:00 → 2026-10-04T10:10:00+07:00\n    - [x] Deep #deep 📅 2026-10-07\n      - 2026-10-04T10:10:00+07:00 → 2026-10-04T10:30:00+07:00\n  - [ ] Same #sibling\n',
    );
    const clone = vi.spyOn(cloning, 'cloneTaskSnapshot');
    const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
    const found = (await records(index, { scope: 'nodes' })).flatMap((batch) => batch.items);
    expect(clone).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(
      found.map((item) => [
        item.title,
        item.markdownTitle,
        item.status,
        item.statusSymbol,
        item.priority,
        item.source.line,
      ]),
    ).toEqual([
      ['Parent', 'Parent', 'open', ' ', 'B', 2],
      ['**Same**', '**Same**', 'in-progress', '/', 'E', 3],
      ['Deep', 'Deep', 'done', 'x', 'D', 5],
      ['Same', 'Same', 'open', ' ', 'D', 7],
    ]);
    expect(found.map((item) => item.planning)).toEqual([
      { due: '2026-10-09' },
      { scheduled: '2026-10-08' },
      { due: '2026-10-07' },
      {},
    ]);
    expect(found.map((item) => item.treeTags)).toEqual([
      ['#parent', '#child', '#deep', '#sibling'],
      ['#child', '#deep'],
      ['#deep'],
      ['#sibling'],
    ]);
    expect(found.map((item) => item.tracked.closedMs)).toEqual([1800000, 1800000, 1200000, 0]);
    const children = found.slice(1).map((item) => ({ address: item.address, score: 0 }));
    const hydrated = await index.resolveSearchHits(children, signal());
    expect(detach).toHaveBeenCalledTimes(1);
    expect(new Set(hydrated.map((item) => item.task.root)).size).toBe(1);
    expect(hydrated.map((item) => taskNodeSourceLine(item.task.target))).toEqual([3, 5, 7]);
    const root = expectDefined(hydrated[0]).task.root;
    expect(rootTaskNodeSnapshot(root)).toEqual({
      root,
      node: root,
      target: { type: 'task', ref: root.ref },
      path: [],
    });
    expect(taskNodeSourceLine(rootTaskNodeSnapshot(root).target)).toBe(2);
    const child = expectDefined(found[1]);
    Reflect.set(child.planning, 'due', '2026-11-01');
    Reflect.set(child.tags, 0, '#corrupt');
    Reflect.set(child.treeTags, 0, '#corrupt');
    Reflect.set(child.address.childLines, 0, 999);
    const fresh = (await records(index, { scope: 'nodes' })).flatMap((batch) => batch.items);
    expect(fresh[1]).toMatchObject({
      planning: { scheduled: '2026-10-08' },
      tags: ['#child'],
      treeTags: ['#child', '#deep'],
    });
    expect(fresh[1]?.planning).not.toHaveProperty('due');
    expect(fresh[1]?.address.childLines).toEqual([1]);
    expect(JSON.stringify(fresh)).not.toMatch(/originalBlock|revision/);
  });

  it('node scope expands duplicate root constraints once and rejects child constraints', async () => {
    const index = await setup(
      '- [ ] Same\n  - [ ] Same\n    - [ ] Same\n      - [ ] Same\n        - [ ] Same\n  - [ ] Same\n- [ ] Other',
    );
    const page = hits(index);
    const root = expectDefined(page[0]).address;
    const found = (await records(index, { scope: 'nodes', roots: [root, root] })).flatMap(
      (batch) => batch.items,
    );
    expect(found.map((item) => [item.depth, item.address.childLines, item.source.line])).toEqual([
      [0, [], 0],
      [1, [1], 1],
      [2, [1, 1], 2],
      [3, [1, 1, 1], 3],
      [4, [1, 1, 1, 1], 4],
      [1, [5], 5],
    ]);
    expect(new Set(found.map((item) => taskSearchAddressKey(item.address))).size).toBe(6);
    expect(taskSearchAddressKey(root)).not.toBe(taskSearchAddressKey({ ...root, epoch: 'other' }));
    expect(taskSearchAddressKey(root)).not.toBe(
      taskSearchAddressKey({ ...root, version: root.version + 1 }),
    );
    expect(taskSearchAddressKey(root)).not.toBe(
      taskSearchAddressKey(expectDefined(page[6]).address),
    );
    expect(
      (await records(index, { scope: 'nodes', roots: [root], filePath: 'other.md' }))[0]?.items,
    ).toEqual([]);
    await expect(
      records(index, { scope: 'nodes', roots: [expectDefined(page[1]).address] }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      records(index, { scope: 'nodes', roots: [{ ...root, epoch: 'foreign' }] }),
    ).rejects.toMatchObject({ code: 'stale' });
    index.installCommittedContent('a.md', '- [ ] Replacement');
    await expect(records(index, { scope: 'nodes', roots: [root] })).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it.each(['abort', 'change', 'exclude', 'dispose'] as const)(
    'node scope rejects %s after its first bounded batch',
    async (change) => {
      const index = await setup(
        ['- [ ] Root', ...Array.from({ length: 205 }, (_, i) => `  - [ ] Child ${i}`)].join('\n'),
        async () => {},
      );
      const controller = new AbortController();
      const generation = index.searchSource().subscribe(() => {}).state.generation;
      const batches = index.organization(
        { expectedGeneration: generation, scope: 'nodes' },
        controller.signal,
      );
      const iterator = batches[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done === true) throw new Error('missing first batch');
      expect(first.value.items).toHaveLength(200);
      expect(first.value.items[199]?.title).toBe('Child 198');
      if (change === 'abort') controller.abort();
      if (change === 'change') index.installCommittedContent('a.md', '- [ ] Replacement');
      if (change === 'exclude') await index.refreshSourceExclusion(() => true);
      if (change === 'dispose') index.destroy();
      const codes = { abort: 'aborted', change: 'stale', exclude: 'stale', dispose: 'disposed' };
      await expect(iterator.next()).rejects.toMatchObject({ code: codes[change] });
    },
  );

  it('node scope excludes source files before projection and rejects an already aborted read', async () => {
    const app = await createAppWithFiles({
      'a.md': '- [ ] Visible\n  - [ ] Visible child',
      'excluded.md': '- [ ] Hidden\n  - [ ] Hidden child',
    });
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    indexes.push(index);
    await index.initialize();
    await index.refreshSourceExclusion((source) => source.filePath === 'excluded.md');
    const found = (await records(index, { scope: 'nodes' })).flatMap((batch) => batch.items);
    expect(found.map((item) => item.title)).toEqual(['Visible', 'Visible child']);
    expect((await records(index, { scope: 'nodes', filePath: 'excluded.md' }))[0]?.items).toEqual(
      [],
    );
    const controller = new AbortController();
    controller.abort();
    const generation = index.searchSource().subscribe(() => {}).state.generation;
    const batches = index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      controller.signal,
    );
    await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'aborted' });
  });
  it('empty organization emits generation; stale and aborted slices never complete', async () => {
    const empty = await setup('');
    expect(await records(empty)).toEqual([{ generation: 0, items: [] }]);
    const index = await setup(
      Array.from({ length: 201 }, (_, i) => `- [ ] Root ${i}`).join('\n'),
      async () => {
        index.installCommittedContent('b.md', '- [ ] New');
      },
    );
    const generation = index.searchSource().subscribe(() => {}).state.generation;
    const batches = index.organization({ expectedGeneration: generation }, signal());
    const iterator = batches[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done !== true) expect(first.value.items).toHaveLength(200);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'stale' });
    const abort = new AbortController();
    abort.abort();
    await expect(index.resolveSearchHits([], abort.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
  });
  it('organization deduplicates exact roots and rejects child handles', async () => {
    const index = await setup('- [ ] Root\n  - [ ] Child');
    const [root, child] = hits(index);
    const generation = index.searchSource().subscribe(() => {}).state.generation;
    const batches = index.organization(
      {
        expectedGeneration: generation,
        roots: [expectDefined(root).address, expectDefined(root).address],
      },
      signal(),
    );
    const iterator = batches[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done !== true) expect(first.value.items).toHaveLength(1);
    const children = index.organization(
      { expectedGeneration: generation, roots: [expectDefined(child).address] },
      signal(),
    );
    await expect(children[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });
  it('megabyte TaskRef.revision absent from source documents and organization', async () => {
    const index = await setup(`- [ ] Root\n  ${'body '.repeat(210000)}\n  - [ ] Child`);
    const source = index.searchSource();
    const docs = source.files().flatMap((file) => [...source.documents(file)]);
    expect(docs).toHaveLength(2);
    expect(docs[1]?.description).toBe('');
    const revision = expectDefined(index.list()[0]).ref.revision;
    expect(revision.length).toBeGreaterThan(1_000_000);
    const serialized = JSON.stringify(docs);
    expect(serialized).not.toContain(JSON.stringify(revision));
    expect(serialized).not.toContain('revision');
    expect(serialized).not.toContain('originalBlock');
    expect(JSON.stringify(await records(index)).length).toBeLessThan(2000);
  });
  it('byte-identical roots have distinct handles and detach once each', async () => {
    const index = await setup('- [ ] Same\n- [ ] Same');
    const page = hits(index);
    expect(new Set(page.map((hit) => hit.address.rootId)).size).toBe(2);
    const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
    const result = await index.resolveSearchHits([...page, ...page], signal());
    expect(detach).toHaveBeenCalledTimes(2);
    expect(result[0]?.task.root).toBe(result[2]?.task.root);
    expect(result[0]?.task.root).not.toBe(result[1]?.task.root);
  });

  it('organization rejects stale completion even after its final batch was consumed', async () => {
    const index = await setup('- [ ] Root');
    const generation = index.searchSource().subscribe(() => {}).state.generation;
    const batches = index.organization({ expectedGeneration: generation }, signal());
    const iterator = batches[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    index.installCommittedContent('b.md', '- [ ] Other');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'stale' });
  });
});
