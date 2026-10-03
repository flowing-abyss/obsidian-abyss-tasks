import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskApplicationApi } from '../../src/tasks';
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

async function patchFirstTask(index: TaskIndex, tasks: TaskApplicationApi): Promise<void> {
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
    'blocked bootstrap %s keeps pre-ready reads pending and rejects their superseded generation',
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
      indexes.push(index);
      const source = index.searchSource();
      const events: TaskSearchSourceEvent[] = [];
      const subscription = source.subscribe((event) => events.push(event));
      expect(subscription.state.type).toBe('initializing');
      index.installCommittedContent('a.md', '- [ ] Old\n');
      const accepted = expectDefined(events.find((event) => event.type === 'files'));
      const acceptedFile = expectDefined(accepted.files[0]);
      if (acceptedFile.version === null) throw new Error('missing accepted version');
      const initializing = index.initialize();
      await ready;
      const earlyDocuments = source.documents({
        path: acceptedFile.path,
        version: acceptedFile.version,
      });
      expect(() => earlyDocuments[Symbol.iterator]().next()).toThrow(
        expect.objectContaining({ code: 'unavailable' }),
      );
      const earlyBatches = index.organization(
        { expectedGeneration: accepted.generation },
        signal(),
      );
      const iterator = earlyBatches[Symbol.asyncIterator]();
      let settled = false;
      const pending = iterator.next().then(
        (batch) => {
          settled = true;
          return { type: 'success', batch };
        },
        (error: unknown) => {
          settled = true;
          return { type: 'error', error };
        },
      );
      await flushMicrotasks();
      expect(settled).toBe(false);
      const file = app.vault.getAbstractFileByPath('a.md');
      if (!(file instanceof TFile)) throw new Error('missing file');
      if (action === 'commit') index.installCommittedContent('a.md', '- [ ] New\n');
      if (action === 'command') await patchFirstTask(index, tasks);
      if (action === 'rename') await app.vault.rename(file, 'b.md');
      if (action === 'delete') await app.fileManager.trashFile(file);
      if (action === 'exclude') await index.refreshSourceExclusion(() => true);
      if (action === 'command') {
        metadataChangedEmitter(app)(file, '- [ ] Old\n', { listItems: [] });
      }
      await flushMicrotasks(20);
      expect(settled).toBe(false);
      release();
      await initializing;
      const state = source.subscribe(() => {}).state;
      expect(state.type).toBe('ready');
      expect(state.generation).toBeGreaterThan(accepted.generation);
      expect(events[events.length - 1]).toEqual({ type: 'state', state });
      expect(await pending).toMatchObject({ type: 'error', error: { code: 'stale' } });
      const expected = {
        commit: [['a.md', 'New']],
        command: [['a.md', 'New']],
        rename: [['b.md', 'Old']],
        delete: [],
        exclude: [],
      }[action];
      const docs = source.files().flatMap((file) => [...source.documents(file)]);
      expect(docs.map((doc) => [doc.order.filePath, doc.title])).toEqual(expected);
      const batches = [];
      for await (const batch of index.organization(
        { expectedGeneration: state.generation },
        signal(),
      ))
        batches.push(batch);
      expect(batches).toHaveLength(1);
      expect(batches.map((batch) => batch.generation)).toEqual([state.generation]);
      expect(
        batches.flatMap((batch) => batch.items.map((item) => [item.source.filePath, item.title])),
      ).toEqual(expected);
      expect(index.list().map((task) => [task.source.filePath, task.title])).toEqual(expected);
      subscription.unsubscribe();
    },
  );
  it('status semantics invalidates generation without changing text documents', async () => {
    const index = await openedIndex('- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a');
    const source = index.searchSource();
    const events: TaskSearchSourceEvent[] = [];
    const before = source.subscribe((event) => events.push(event)).state.generation;
    const file = expectDefined(source.files()[0]);
    const documentsBefore = [...source.documents(file)];
    const target = expectDefined(index.listNodes()[1]).target;
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(1);
    index.setStatusCatalog(
      new StatusCatalog([{ id: 'closed-space', symbol: ' ', type: 'done', defaultForType: true }]),
    );
    expect(source.files()).toEqual([file]);
    expect(events).toEqual([{ type: 'semantics', generation: before + 1 }]);
    expect([...source.documents(file)]).toEqual(documentsBefore);
    expect([...source.documents(file)][0]?.metadata).not.toContain('closed-space');
    const batches = [];
    for await (const batch of index.organization({ expectedGeneration: before + 1 }, signal()))
      batches.push(batch);
    expect(batches.flatMap((batch) => batch.items.map((item) => item.status))).toEqual([
      'done',
      'done',
    ]);
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
  it.each(['documents', 'organization'] as const)(
    'many-root %s reads perform only linear source-coordinate work',
    async (read) => {
      const count = 1000;
      const index = await openedIndex(
        Array.from({ length: count }, (_, i) => `- [ ] Root ${i}`).join('\n'),
      );
      const enumerate = searchProjection.taskTreeNodes;
      const instrumented = new WeakSet<object>();
      let lineReads = 0;
      vi.spyOn(searchProjection, 'taskTreeNodes').mockImplementation(function* (root) {
        if (!instrumented.has(root)) {
          instrumented.add(root);
          const line = root.source.line;
          Object.defineProperty(root.source, 'line', {
            get: () => {
              lineReads++;
              return line;
            },
          });
        }
        yield* enumerate(root);
      });
      const source = index.searchSource();
      const titles: string[] = [];
      if (read === 'documents') {
        for (const doc of source.documents(expectDefined(source.files()[0])))
          titles.push(doc.title);
      } else {
        const generation = source.subscribe(() => {}).state.generation;
        for await (const batch of index.organization({ expectedGeneration: generation }, signal()))
          titles.push(...batch.items.map((item) => item.title));
      }
      expect(titles).toHaveLength(count);
      expect(titles[0]).toBe('Root 0');
      expect(titles[count - 1]).toBe('Root 999');
      expect(lineReads).toBeLessThanOrEqual(count * 10);
    },
  );

  it('wide child document traversal performs only linear child-coordinate work', async () => {
    const count = 500;
    const index = await openedIndex(
      ['- [ ] Root', ...Array.from({ length: count }, (_, i) => `  - [ ] Child ${i}`)].join('\n'),
    );
    const enumerate = searchProjection.taskTreeNodes;
    const instrumented = new WeakSet<object>();
    let lineReads = 0;
    vi.spyOn(searchProjection, 'taskTreeNodes').mockImplementation(function* (root) {
      for (const task of enumerate(root)) {
        if (task.target.type === 'subtask' && !instrumented.has(task.target.ref)) {
          const ref = task.target.ref;
          instrumented.add(ref);
          const line = ref.relativeLine;
          Object.defineProperty(ref, 'relativeLine', {
            get: () => {
              lineReads++;
              return line;
            },
          });
        }
        yield task;
      }
    });
    const source = index.searchSource();
    const docs = [...source.documents(expectDefined(source.files()[0]))];
    expect(docs).toHaveLength(count + 1);
    expect(docs[1]?.title).toBe('Child 0');
    expect(docs[count]?.title).toBe('Child 499');
    expect(lineReads).toBeLessThanOrEqual(count * 6);
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
