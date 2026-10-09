import { afterEach, describe, expect, it, vi } from 'vitest';
import * as dependencies from '../../src/tasks/domain/taskDependencies';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { canonicalStatusCatalog, createAppWithFiles, expectDefined } from '../helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
  vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
function generation(index: TaskIndex) {
  const subscription = index.searchSource().subscribe(() => {});
  subscription.unsubscribe();
  return subscription.state.generation;
}
async function ticks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function scheduler() {
  const pending: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const readYield = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => pending.push({ signal, resolve, reject })),
  );
  return {
    pending,
    readYield,
    async step() {
      expectDefined(pending.shift()).resolve();
      await ticks();
    },
  };
}
async function setup(markdown = '- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a', initialize = true) {
  const app = await createAppWithFiles({ 'a.md': markdown });
  const clock = scheduler();
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    readYield: clock.readYield,
  });
  indexes.push(index);
  if (initialize) await index.initialize();
  return { index, app, clock };
}
async function finish(clock: ReturnType<typeof scheduler>) {
  await ticks();
  for (let i = 0; clock.pending.length > 0 && i < 1000; i++) await clock.step();
  expect(clock.pending).toHaveLength(0);
}
const many = Array.from(
  { length: 300 },
  (_, i) => `- [ ] Root ${i} 🆔 id${i}\n  - [ ] Child ${i} ⛔ id0`,
).join('\n');

describe('canonical dependency preparation', () => {
  it('delete source listener sees the post-delete canonical store and graph', async () => {
    const { index, app } = await setup();
    const dependent = expectDefined(index.listNodes()[1]).target;
    expect(index.dependencySummary(dependent).activeBlockedByCount).toBe(1);
    const observations: number[] = [];
    index.searchSource().subscribe((event) => {
      if (event.type === 'files')
        observations.push(index.dependencySummary(dependent).activeBlockedByCount);
    });
    await app.fileManager.trashFile(expectDefined(app.vault.getFileByPath('a.md')));
    expect(observations).toEqual([0]);
  });
  it('shares three owners, aborts only one, and reuses completed cache across close/reopen', async () => {
    const { index, clock } = await setup(many);
    const build = vi.spyOn(dependencies, 'assembleTaskDependencyGraphSteps');
    const owner = new AbortController();
    const first = index
      .prepareDependencies(generation(index), owner.signal)
      .catch((error: unknown) => error);
    const second = index.prepareDependencies(generation(index), signal());
    const third = index.prepareDependencies(generation(index), signal());
    await ticks();
    expect(clock.readYield).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    owner.abort();
    expect(await first).toMatchObject({ code: 'aborted' });
    await finish(clock);
    await Promise.all([second, third]);
    expect(build).toHaveBeenCalledTimes(1);
    const count = clock.readYield.mock.calls.length;
    await index.prepareDependencies(generation(index), signal());
    expect(clock.readYield).toHaveBeenCalledTimes(count);
  });
  it.each([1, 5, 9, 15, 19])(
    'takeover at suspended slice %i drains one cursor; late rejection cannot clear replacement',
    async (pause) => {
      const { index, clock } = await setup(many);
      const build = vi.spyOn(dependencies, 'assembleTaskDependencyGraphSteps');
      const target = expectDefined(index.listNodes()[1]).target;
      const prepared = index.prepareDependencies(generation(index), signal());
      await ticks();
      for (let i = 1; i < pause; i++) await clock.step();
      const scheduled = expectDefined(clock.pending.shift());
      expect(index.dependencySummary(target).activeBlockedByCount).toBe(1);
      await prepared;
      expect(scheduled.signal.aborted).toBe(true);
      expect(build).toHaveBeenCalledTimes(1);
      index.installCommittedContent('b.md', '- [ ] New');
      const replacement = index.prepareDependencies(generation(index), signal());
      await ticks();
      scheduled.reject(new Error('late scheduler rejection'));
      await ticks();
      await finish(clock);
      await replacement;
      expect(build).toHaveBeenCalledTimes(2);
    },
  );
  it.each([1, 5, 9, 15, 19])(
    'last owner cancellation at slice %i closes unfinished work; replacement survives late release',
    async (pause) => {
      const { index, clock } = await setup(many);
      const owners = [new AbortController(), new AbortController(), new AbortController()];
      const owner = expectDefined(owners[2]);
      const companions = owners
        .slice(0, 2)
        .map((o) =>
          index.prepareDependencies(generation(index), o.signal).catch((error: unknown) => error),
        );
      const pending = index
        .prepareDependencies(generation(index), owner.signal)
        .catch((error: unknown) => error);
      await ticks();
      for (let i = 1; i < pause; i++) await clock.step();
      const scheduled = expectDefined(clock.pending.shift());
      expectDefined(owners[0]).abort();
      expectDefined(owners[1]).abort();
      expect(scheduled.signal.aborted).toBe(false);
      owner.abort();
      expect(await Promise.all(companions)).toEqual([
        expect.objectContaining({ code: 'aborted' }),
        expect.objectContaining({ code: 'aborted' }),
      ]);
      expect(await pending).toMatchObject({ code: 'aborted' });
      expect(scheduled.signal.aborted).toBe(true);
      const replacement = index.prepareDependencies(generation(index), signal());
      await ticks();
      scheduled.resolve();
      await ticks();
      await finish(clock);
      await replacement;
    },
  );
  it.each([1, 5, 9, 15, 19])(
    'generation invalidation at slice %i rejects old build and fresh build alone publishes',
    async (pause) => {
      const { index, clock } = await setup(many);
      const pending = index
        .prepareDependencies(generation(index), signal())
        .catch((error: unknown) => error);
      await ticks();
      for (let i = 1; i < pause; i++) await clock.step();
      index.installCommittedContent('a.md', '- [ ] Replacement');
      expect(await pending).toMatchObject({ code: 'stale' });
      const replacement = index.prepareDependencies(generation(index), signal());
      await finish(clock);
      await replacement;
      expect(index.dependencySummary(expectDefined(index.listNodes()[0]).target)).toEqual({
        activeBlockedByCount: 0,
        activeBlocksCount: 0,
      });
    },
  );
  it.each([1, 5, 9, 15, 19])(
    'at slice %i rejects failed yields with typed failure, settles all waiters, removes abort listeners and permits explicit retry',
    async (pause) => {
      const { index, clock } = await setup(many);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const owner = new AbortController();
      const remove = vi.spyOn(owner.signal, 'removeEventListener');
      const first = index
        .prepareDependencies(generation(index), owner.signal)
        .catch((error: unknown) => error);
      const second = index
        .prepareDependencies(generation(index), signal())
        .catch((error: unknown) => error);
      await ticks();
      for (let i = 1; i < pause; i++) await clock.step();
      expectDefined(clock.pending.shift()).reject(new Error('secret source'));
      expect(await first).toMatchObject({ code: 'unavailable' });
      expect(await second).toMatchObject({ code: 'unavailable' });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] dependency preparation failed', {
        phase: 'dependency-preparation',
        backend: 'canonical',
        generation: 1,
        pathCount: 1,
      });
      const retry = index.prepareDependencies(generation(index), signal());
      await finish(clock);
      await retry;
    },
  );
  it('initializing readiness, pre-abort, stale generation and disposal settle without hidden work', async () => {
    const { index, clock } = await setup('', false);
    const pending = index.prepareDependencies(0, signal());
    await ticks();
    expect(clock.readYield).not.toHaveBeenCalled();
    await index.initialize();
    await finish(clock);
    await pending;
    await expect(index.prepareDependencies(-1, signal())).rejects.toMatchObject({ code: 'stale' });
    const owner = new AbortController();
    owner.abort();
    await expect(index.prepareDependencies(0, owner.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    index.installCommittedContent('a.md', many);
    const disposed = index
      .prepareDependencies(generation(index), signal())
      .catch((error: unknown) => error);
    await ticks();
    index.destroy();
    expect(await disposed).toMatchObject({ code: 'disposed' });
    await finish(clock);
    await expect(index.prepareDependencies(generation(index), signal())).rejects.toMatchObject({
      code: 'disposed',
    });
  });
});

describe('preparation source transitions and actual work', () => {
  it.each(['delete', 'rename', 'exclude', 'status'] as const)(
    'invalidates %s at every suspended phase including the final pre-publication yield',
    async (change) => {
      // 300 roots, 600 nodes and 1200 dependent/ID/expanded-edge units:
      // yield 2 borrows, 6 registers, 12 expands edges, 19 precedes the last partial batch.
      for (const pause of [2, 6, 12, 19]) {
        const { index, app, clock } = await setup(many);
        const old = index
          .prepareDependencies(generation(index), signal())
          .catch((error: unknown) => error);
        await ticks();
        for (let i = 1; i < pause; i++) await clock.step();
        const scheduled = expectDefined(clock.pending.shift());
        if (change === 'delete')
          await app.fileManager.trashFile(expectDefined(app.vault.getFileByPath('a.md')));
        if (change === 'rename')
          await app.vault.rename(expectDefined(app.vault.getFileByPath('a.md')), 'z.md');
        if (change === 'exclude') await index.refreshSourceExclusion(() => true);
        if (change === 'status') index.setStatusCatalog(canonicalStatusCatalog());
        expect(await old).toMatchObject({ code: 'stale' });
        expect(scheduled.signal.aborted).toBe(true);
        const fresh = index.prepareDependencies(generation(index), signal());
        await ticks();
        scheduled.reject(new Error('late stale scheduler'));
        await ticks();
        await finish(clock);
        await fresh;
        const nodes = index.listNodes();
        const graph = dependencies.buildTaskDependencyGraph(nodes, (symbol) =>
          canonicalStatusCatalog().statusForSymbol(symbol),
        );
        for (const node of nodes.slice(0, 3))
          expect(index.dependencies(node.target)).toEqual(graph.dependencies(node.target));
        index.destroy();
      }
    },
  );
  it('walks one huge root incrementally, does not copy statuses or freeze source, and bounds iterator work between yields', async () => {
    const { index, clock } = await setup(
      `- [ ] Root 🆔 root\n${Array.from(
        { length: 800 },
        (_, i) => `  - [ ] Child ${i} ⛔ root`,
      ).join('\n')}`,
    );
    const original = dependencies.assembleTaskDependencyGraphSteps;
    let units = 0;
    const slices: number[] = [];
    vi.spyOn(dependencies, 'assembleTaskDependencyGraphSteps').mockImplementation(function* (
      ...args
    ) {
      const cursor = original(...args);
      let next = cursor.next();
      while (next.done !== true) {
        units++;
        yield;
        next = cursor.next();
      }
      return next.value;
    });
    const pending = index.prepareDependencies(generation(index), signal());
    await ticks();
    expect(units).toBe(0);
    while (clock.pending.length > 0) {
      const previous = units;
      await clock.step();
      slices.push(units - previous);
    }
    await pending;
    expect(Math.max(...slices)).toBeLessThanOrEqual(128);
    expect(units).toBe(3202);
    expect(slices.filter((n) => n > 0).length).toBeGreaterThan(20);
  });
  it('preserves global native comparator ties and child order across reverse file installation', async () => {
    const { index, clock } = await setup('');
    index.installCommittedContent('z.md', '- [ ] Z 🆔 duplicate');
    index.installCommittedContent('é.md', '- [ ] Composed 🆔 duplicate');
    index.installCommittedContent('é.md', '- [ ] Decomposed 🆔 duplicate');
    index.installCommittedContent(
      'a.md',
      '- [ ] A 🆔 duplicate\n  - [ ] Child 🆔 duplicate\n- [ ] Dependent ⛔ duplicate',
    );
    const nodes = index.listNodes();
    const expected = dependencies.buildTaskDependencyGraph(nodes, () => 'open');
    const pending = index.prepareDependencies(generation(index), signal());
    await finish(clock);
    await pending;
    for (const node of nodes)
      expect(index.dependencies(node.target)).toEqual(expected.dependencies(node.target));
    const dependent = expectDefined(nodes.find((n) => n.node.title === 'Dependent'));
    expect(index.dependencies(dependent.target).blockedBy[0]).toMatchObject({
      candidates: [
        { node: { title: 'A' } },
        { node: { title: 'Child' } },
        { node: { title: 'Composed' } },
        { node: { title: 'Decomposed' } },
        { node: { title: 'Z' } },
      ],
    });
  });
  it('failed initialization wakes readiness with unavailable, without retrying initialization', async () => {
    const { index, app, clock } = await setup('', false);
    vi.spyOn(app.vault, 'getMarkdownFiles').mockImplementation(() => {
      throw new Error('init failed');
    });
    const pending = index.prepareDependencies(0, signal()).catch((error: unknown) => error);
    await expect(index.initialize()).rejects.toThrow('init failed');
    expect(await pending).toMatchObject({ code: 'unavailable' });
    await expect(index.prepareDependencies(0, signal())).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(clock.readYield).not.toHaveBeenCalled();
  });
});

describe('atomic invalidation callbacks', () => {
  it.each(['replace', 'delete'] as const)(
    '%s installs canonical state before scheduler abort callbacks can query it',
    async (change) => {
      const app = await createAppWithFiles({ 'a.md': '- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a' });
      const counts: number[] = [];
      const index = new TaskIndex(app, {
        statusCatalog: canonicalStatusCatalog(),
        readYield: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                counts.push(index.dependencySummary(target).activeBlockedByCount);
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          }),
      });
      indexes.push(index);
      await index.initialize();
      const target = expectDefined(index.listNodes()[1]).target;
      const pending = index
        .prepareDependencies(generation(index), signal())
        .catch((error: unknown) => error);
      await ticks();
      if (change === 'replace') index.installCommittedContent('a.md', '- [ ] Replacement');
      else await app.fileManager.trashFile(expectDefined(app.vault.getFileByPath('a.md')));
      expect(await pending).toMatchObject({ code: 'stale' });
      expect(counts).toEqual([0]);
      expect(index.dependencySummary(target).activeBlockedByCount).toBe(0);
    },
  );
});

describe('borrowed status and failure boundaries', () => {
  it('current catalog controls summaries and detached child relation status without freezing canonical data', async () => {
    const { index, clock } = await setup(
      '- [ ] Root\n  - [ ] Blocker 🆔 child\n- [ ] Dependent ⛔ child',
    );
    const target = expectDefined(index.listNodes()[2]).target;
    const catalog = canonicalStatusCatalog();
    catalog.replace(
      catalog
        .all()
        .map((rule) => (rule.symbol === ' ' ? { ...rule, type: 'done' as const } : rule)),
    );
    index.setStatusCatalog(catalog);
    const pending = index.prepareDependencies(generation(index), signal());
    await finish(clock);
    await pending;
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(0);
    const relation = expectDefined(index.dependencies(target).blockedBy[0]);
    if (relation.type !== 'resolved') throw new Error('expected resolved');
    expect(relation.task.node.status).toBe('done');
    expect(Reflect.set(relation.task.root, 'title', 'mutated')).toBe(false);
    expect(Reflect.set(relation.task.path, 'length', 0)).toBe(false);
    expect(Reflect.set(relation.task.target.ref, 'relativeLine', 55)).toBe(false);
    expect(Reflect.set(relation.task.node, 'status', 'open')).toBe(false);
    expect(index.dependencies(target).blockedBy[0]).toEqual(relation);
  });
  it('unexpected assembly failure rejects shared waiters without synchronous fallback, then explicit retry succeeds', async () => {
    const { index, clock } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assembly = vi
      .spyOn(dependencies, 'assembleTaskDependencyGraphSteps')
      .mockImplementationOnce(function* () {
        yield;
        throw new Error('private contents must not escape');
      });
    const first = index
      .prepareDependencies(generation(index), signal())
      .catch((error: unknown) => error);
    const second = index
      .prepareDependencies(generation(index), signal())
      .catch((error: unknown) => error);
    await finish(clock);
    expect(await first).toMatchObject({
      code: 'unavailable',
      message: 'Dependency preparation failed',
    });
    expect(await second).toMatchObject({ code: 'unavailable' });
    expect(assembly).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] dependency preparation failed', {
      phase: 'dependency-preparation',
      backend: 'canonical',
      generation: 1,
      pathCount: 1,
    });
    const retry = index.prepareDependencies(generation(index), signal());
    await finish(clock);
    await retry;
    expect(assembly).toHaveBeenCalledTimes(2);
  });
});

describe('disposed reentrant readers', () => {
  it('an abort callback cannot resurrect canonical graph ownership during destruction', async () => {
    const app = await createAppWithFiles({ 'a.md': '- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a' });
    const observations: number[] = [];
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      readYield: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observations.push(index.dependencySummary(target).activeBlockedByCount);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    });
    indexes.push(index);
    await index.initialize();
    const target = expectDefined(index.listNodes()[1]).target;
    const pending = index
      .prepareDependencies(generation(index), signal())
      .catch((error: unknown) => error);
    await ticks();
    index.destroy();
    expect(await pending).toMatchObject({ code: 'disposed' });
    expect(observations).toEqual([0]);
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(0);
    const assembly = vi.spyOn(dependencies, 'assembleTaskDependencyGraphSteps');
    index.dependencySummary(target);
    index.dependencySummary(target);
    // Compatibility reads may return an empty projection, but a disposed owner retains no cache.
    expect(assembly).toHaveBeenCalledTimes(2);
  });
});

describe('disposal at suspended construction phases', () => {
  it.each([1, 5, 9, 15, 19])(
    'settles every owner at slice %i and discards late scheduler rejection',
    async (pause) => {
      const { index, clock } = await setup(many);
      const first = index
        .prepareDependencies(generation(index), signal())
        .catch((error: unknown) => error);
      const second = index
        .prepareDependencies(generation(index), signal())
        .catch((error: unknown) => error);
      await ticks();
      for (let i = 1; i < pause; i++) await clock.step();
      const scheduled = expectDefined(clock.pending.shift());
      index.destroy();
      expect(await first).toMatchObject({ code: 'disposed' });
      expect(await second).toMatchObject({ code: 'disposed' });
      expect(scheduled.signal.aborted).toBe(true);
      scheduled.reject(new Error('late disposed work'));
      await ticks();
      await expect(index.prepareDependencies(generation(index), signal())).rejects.toMatchObject({
        code: 'disposed',
      });
    },
  );
});
