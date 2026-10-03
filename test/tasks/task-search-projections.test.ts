import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloning from '../../src/tasks/domain/cloneTaskSnapshot';
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
async function records(index: TaskIndex) {
  const generation = index.searchSource().subscribe(() => {}).state.generation;
  const batches = [];
  for await (const batch of index.organization({ expectedGeneration: generation }, signal()))
    batches.push(batch);
  return batches;
}

describe('bounded exact search projections', () => {
  it('one clone for sibling and duplicate occurrences; rejects guessed child paths', async () => {
    const index = await setup('- [ ] Root\n  - [ ] Child\n  - [ ] Child2\n');
    const page = hits(index);
    vi.spyOn(index, 'resolve').mockImplementation(() => {
      throw new Error('must not rebase');
    });
    const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
    const results = await index.resolveSearchPage([...page, ...page], signal());
    expect(detach).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.task.root)).size).toBe(1);
    const first = expectDefined(page[0]);
    await expect(
      index.resolveSearchPage(
        [{ ...first, address: { ...first.address, childLines: [999] } }],
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
  });
  it('200 node and 50 root cap', async () => {
    const index = await setup(Array.from({ length: 51 }, (_, i) => `- [ ] Root ${i}`).join('\n'));
    const page = hits(index);
    await expect(index.resolveSearchPage(page, signal())).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      index.resolveSearchPage(
        Array.from({ length: 201 }, () => expectDefined(page[0])),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(await index.resolveSearchPage(page.slice(0, 50), signal())).toHaveLength(50);
  });
  it('organization yields no blocks or rich arrays and detaches nested values', async () => {
    const index = await setup('- [ ] Root #root\n  - [ ] Child #child\n');
    const batches = await records(index);
    const item = expectDefined(batches[0]?.items[0]);
    expect(item.treeTags).toEqual(['#root', '#child']);
    expect(Object.keys(item).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'address',
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
    await expect(index.resolveSearchPage([], abort.signal)).rejects.toMatchObject({
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
    const result = await index.resolveSearchPage([...page, ...page], signal());
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
