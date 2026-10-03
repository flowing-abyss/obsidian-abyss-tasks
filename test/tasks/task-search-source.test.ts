import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskSearchSourceEvent } from '../../src/tasks/application/TaskSearchSource';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import * as searchProjection from '../../src/tasks/domain/taskSearchProjection';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  metadataChangedEmitter,
  seedTaskCache,
} from '../helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});
async function openedIndex(markdown: string) {
  const app = await createAppWithFiles({ 'a.md': markdown });
  seedTaskCache(app, 'a.md', [{ task: ' ', parent: -1, line: 0 }]);
  const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
  indexes.push(index);
  await index.initialize();
  return index;
}
const signal = () => new AbortController().signal;

describe('canonical search source', () => {
  it('subscribes after readiness and rejects an address after accepted replacement', async () => {
    const index = await openedIndex('- [ ] Alpha\n  - [ ] Beta\n');
    const source = index.searchSource();
    const events: TaskSearchSourceEvent[] = [];
    const subscription = source.subscribe((event) => events.push(event));
    expect(subscription.state.type).toBe('ready');
    const docs = [...source.documents(expectDefined(source.files()[0]))];
    expect(docs.map((d) => d.title)).toEqual(['Alpha', 'Beta']);
    const hits = docs.map((document) => ({
      address: expectDefined(source.address(document.id)),
      score: 1,
    }));
    const result = await index.resolveSearchPage(hits, signal());
    expect(result[0]?.task.root).toBe(result[1]?.task.root);
    index.installCommittedContent('a.md', '- [ ] Replaced\n');
    await expect(index.resolveSearchPage(hits, signal())).rejects.toMatchObject({ code: 'stale' });
    expect(events.some((event) => event.type === 'files')).toBe(true);
    subscription.unsubscribe();
  });

  it('unrelated file update preserves exact address; replaced file or epoch is stale', async () => {
    const index = await openedIndex('- [ ] Alpha\n');
    const source = index.searchSource();
    const id = expectDefined([...source.nodes(expectDefined(source.files()[0]))][0]).id;
    const hit = { address: expectDefined(source.address(id)), score: 2 };
    index.installCommittedContent('b.md', '- [ ] Other\n');
    expect((await index.resolveSearchPage([hit], signal()))[0]?.task.node.title).toBe('Alpha');
    await expect(
      index.resolveSearchPage([{ ...hit, address: { ...hit.address, epoch: 'other' } }], signal()),
    ).rejects.toMatchObject({ code: 'stale' });
    const other = await openedIndex('- [ ] Alpha\n');
    await expect(other.resolveSearchPage([hit], signal())).rejects.toMatchObject({ code: 'stale' });
    index.installCommittedContent('a.md', '- [ ] New\n');
    expect(source.address(id)).toBeUndefined();
  });

  it('checks file version before every document and completion', async () => {
    const index = await openedIndex('- [ ] First\n- [ ] Second\n');
    const source = index.searchSource();
    const iterator = source.documents(expectDefined(source.files()[0]))[Symbol.iterator]();
    const first = iterator.next();
    expect(first.done).toBe(false);
    if (first.done !== true) expect(first.value.title).toBe('First');
    index.installCommittedContent('a.md', '- [ ] New\n');
    expect(() => iterator.next()).toThrow(expect.objectContaining({ code: 'stale' }));
  });

  it('initializing, failed and disposed are observable without fabricating readiness', async () => {
    const app = await createAppWithFiles({});
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    indexes.push(index);
    const source = index.searchSource();
    const events: TaskSearchSourceEvent[] = [];
    expect(source.subscribe((event) => events.push(event)).state.type).toBe('initializing');
    vi.spyOn(app.vault, 'getMarkdownFiles').mockImplementation(() => {
      throw new Error('failed listing');
    });
    await expect(index.initialize()).rejects.toThrow('failed listing');
    expect(source.subscribe(() => {}).state.type).toBe('failed');
    index.destroy();
    expect(source.subscribe(() => {}).state.type).toBe('disposed');
    expect(
      events.filter((event) => event.type === 'state').map((event) => event.state.type),
    ).toEqual(['failed', 'disposed']);
  });

  it.each(['commit', 'command', 'rename', 'delete', 'exclude'] as const)(
    'bootstrap %s cannot revive a blocked old read',
    async (action) => {
      const app = await createAppWithFiles({ 'a.md': '- [ ] Old\n' });
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const original = app.vault.cachedRead.bind(app.vault);
      let blocked = false;
      vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
        if (blocked) return original(file);
        blocked = true;
        started();
        await gate;
        return '- [ ] Old\n';
      });
      const { index, tasks } = configuredTaskApplication(app, DEFAULT_SETTINGS, {
        authority: true,
      });
      if (action === 'command') index.installCommittedContent('a.md', '- [ ] Old\n');
      indexes.push(index);
      const source = index.searchSource();
      const initializing = index.initialize();
      await ready;
      const file = app.vault.getAbstractFileByPath('a.md');
      if (!(file instanceof TFile)) throw new Error('missing file');
      if (action === 'commit') index.installCommittedContent('a.md', '- [ ] New\n');
      if (action === 'command') {
        const target = expectDefined(index.listNodes()[0]).target;
        if (target.type !== 'task') throw new Error('expected root');
        expect(
          (
            await tasks.execute({
              type: 'patch',
              target,
              patch: { markdownTitle: { type: 'set', value: 'New' } },
            })
          ).type,
        ).toBe('ok');
      }
      if (action === 'rename') await app.vault.rename(file, 'b.md');
      if (action === 'delete') await app.fileManager.trashFile(file);
      if (action === 'exclude') await index.refreshSourceExclusion(() => true);
      release();
      await initializing;
      const docs = source.files().flatMap((file) => [...source.documents(file)]);
      expect(docs.map((doc) => [doc.order.filePath, doc.title])).toEqual(
        {
          commit: [['a.md', 'New']],
          command: [['a.md', 'New']],
          rename: [['b.md', 'Old']],
          delete: [],
          exclude: [],
        }[action],
      );
    },
  );
  it('before-ready organization waits and never announces an empty completed result', async () => {
    const app = await createAppWithFiles({ 'a.md': '- [ ] Waiting' });
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    indexes.push(index);
    const batches = index.organization({ expectedGeneration: 1 }, signal());
    const pending = batches[Symbol.asyncIterator]().next();
    let completed = false;
    const observed = pending.then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(completed).toBe(false);
    await index.initialize();
    const batch = await pending;
    await observed;
    expect(batch.done).toBe(false);
    if (batch.done !== true)
      expect(batch.value.items.map((item) => item.title)).toEqual(['Waiting']);
  });

  it('status semantics without note write invalidates generation and updates vocabulary', async () => {
    const index = await openedIndex('- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a');
    const source = index.searchSource();
    const events: TaskSearchSourceEvent[] = [];
    const before = source.subscribe((event) => events.push(event)).state.generation;
    const file = expectDefined(source.files()[0]);
    const target = expectDefined(index.listNodes()[1]).target;
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(1);
    index.setStatusCatalog(
      new StatusCatalog([{ id: 'closed-space', symbol: ' ', type: 'done', defaultForType: true }]),
    );
    expect(source.files()).toEqual([file]);
    expect(events).toEqual([{ type: 'semantics', generation: before + 1 }]);
    expect([...source.documents(file)][0]?.metadata).toContain('done closed-space');
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(0);
    await expect(
      index.organization({ expectedGeneration: before }, signal())[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('command then delayed cache cannot roll back the accepted source', async () => {
    const old = '- [ ] Old\n';
    const app = await createAppWithFiles({ 'a.md': old });
    const { index, tasks } = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    indexes.push(index);
    await index.initialize();
    const target = expectDefined(index.listNodes()[0]).target;
    if (target.type !== 'task') throw new Error('expected root');
    const fireChanged = metadataChangedEmitter(app);
    const outcome = await tasks.execute({
      type: 'patch',
      target,
      patch: { markdownTitle: { type: 'set', value: 'New' } },
    });
    expect(outcome.type).toBe('ok');
    const file = app.vault.getAbstractFileByPath('a.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    fireChanged(file, old, { listItems: [] });
    await flushMicrotasks(20);
    const source = index.searchSource();
    expect(
      source
        .files()
        .flatMap((file) => [...source.documents(file)])
        .map((doc) => doc.title),
    ).toEqual(['New']);
    expect(index.list().map((task) => task.title)).toEqual(['New']);
  });

  it('delete then recreate same path and text rejects the old address', async () => {
    const app = await createAppWithFiles({ 'a.md': '- [ ] Same' });
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    indexes.push(index);
    await index.initialize();
    const source = index.searchSource();
    const first = expectDefined([...source.nodes(expectDefined(source.files()[0]))][0]);
    const old = expectDefined(source.address(first.id));
    const file = app.vault.getAbstractFileByPath('a.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    await app.fileManager.trashFile(file);
    await app.vault.create('a.md', '- [ ] Same');
    await flushMicrotasks(20);
    await expect(
      index.resolveSearchPage([{ address: old, score: 1 }], signal()),
    ).rejects.toMatchObject({ code: 'stale' });
    const next = expectDefined([...source.nodes(expectDefined(source.files()[0]))][0]);
    expect(next.id).toBeGreaterThan(first.id);
    expect(
      (
        await index.resolveSearchPage(
          [{ address: expectDefined(source.address(next.id)), score: 1 }],
          signal(),
        )
      )[0]?.task.node.title,
    ).toBe('Same');
  });

  it('observers cannot mutate another observer file event', async () => {
    const index = await openedIndex('- [ ] First');
    const source = index.searchSource();
    source.subscribe((event) => {
      if (event.type === 'files') Reflect.set(event.files[0] ?? {}, 'path', 'corrupted.md');
    });
    const paths: string[] = [];
    source.subscribe((event) => {
      if (event.type === 'files') paths.push(...event.files.map((file) => file.path));
    });
    index.installCommittedContent('a.md', '- [ ] Second');
    expect(paths).toEqual(['a.md']);
  });
  it('isolates listener failures with metadata-only diagnostics', async () => {
    const index = await openedIndex('- [ ] Private title');
    const source = index.searchSource();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    source.subscribe(() => {
      throw new Error('private query contents');
    });
    const events: TaskSearchSourceEvent[] = [];
    source.subscribe((event) => events.push(event));
    index.installCommittedContent('a.md', '- [ ] Another private title');
    expect(events).toHaveLength(1);
    expect(log.mock.calls).toEqual([
      [
        '[abyss-tasks] task search source listener failed',
        { phase: 'source-publication', backend: 'canonical', generation: 2, pathCount: 1 },
      ],
    ]);
  });
  it('allocates one compact handle per yield and reuses prefixes across overlapping iterators', async () => {
    const index = await openedIndex('- [ ] Root\n  - [ ] Child\n- [ ] Other');
    const source = index.searchSource();
    const file = expectDefined(source.files()[0]);
    const enumerate = searchProjection.taskTreeNodes;
    let visited = 0;
    vi.spyOn(searchProjection, 'taskTreeNodes').mockImplementation(function* (root) {
      for (const node of enumerate(root)) {
        visited++;
        yield node;
      }
    });
    const first = source.nodes(file)[Symbol.iterator]();
    const root = first.next();
    expect(visited).toBe(1);
    if (root.done === true) throw new Error('missing root');
    expect(root.value.order.childLines).toEqual([]);
    const all = [...source.nodes(file)];
    expect(all[0]?.id).toBe(root.value.id);
    const child = first.next();
    if (child.done === true) throw new Error('missing child');
    expect(child.value.id).toBe(all[1]?.id);
    expect(child.value.rootId).toBe(root.value.id);
    const other = first.next();
    if (other.done === true) throw new Error('missing other root');
    expect(other.value.id).toBe(all[2]?.id);
    expect(first.next().done).toBe(true);
    expect(new Set(all.map((node) => node.id)).size).toBe(3);
    expect([...source.documents(file)].map((node) => node.id)).toEqual(all.map((node) => node.id));
  });
});
