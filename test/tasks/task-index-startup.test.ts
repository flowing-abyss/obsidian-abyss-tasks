import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskIndexEvent } from '../../src/tasks';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  metadataChangedEmitter,
} from '../helpers';

function yieldGate() {
  const entered = deferred<void>();
  let release!: () => void;
  let fail!: (error: Error) => void;
  const waiting = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  let holding = true;
  const signals: AbortSignal[] = [];
  return {
    entered: entered.promise,
    signals,
    async yield(signal: AbortSignal): Promise<void> {
      if (!holding) return;
      signals.push(signal);
      entered.resolve();
      const aborted = deferred<void>();
      const abort = (): void => {
        aborted.resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await Promise.race([waiting, aborted.promise]);
        if (signal.aborted) throw new Error('Scheduled read cancelled');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    release(): void {
      holding = false;
      release();
    },
    fail(error: Error): void {
      holding = false;
      fail(error);
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function startup() {
  const files = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [
      `note-${String(i).padStart(2, '0')}.md`,
      `- [ ] task ${i}\n  - [x] child ${i}`,
    ]),
  );
  const app = await createAppWithFiles(files);
  const gate = yieldGate();
  let excluded = '';
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    readYield: (signal) => gate.yield(signal),
    excludeSource: (source) => source.filePath === excluded,
  });
  const reads = vi.spyOn(app.vault, 'cachedRead');
  const events: TaskIndexEvent[] = [];
  index.subscribe((event) => events.push(event));
  const initializing = index.initialize();
  cleanup.push(async () => {
    gate.release();
    index.destroy();
    await initializing.catch(() => undefined);
  });
  expect(
    await Promise.race([gate.entered.then(() => 'yielded'), initializing.then(() => 'ready')]),
  ).toBe('yielded');
  return {
    app,
    index,
    gate,
    events,
    reads,
    initializing,
    exclude: (path: string): void => {
      excluded = path;
    },
  };
}

function file(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string): TFile {
  const value = app.vault.getAbstractFileByPath(path);
  if (!(value instanceof TFile)) throw new Error('Missing test file');
  return value;
}

describe('cooperative initial file acceptance', () => {
  it('keeps reads concurrent while yielding before all files are installed and publishes readiness once', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const state = await startup();
    expect(state.reads).toHaveBeenCalledTimes(50);
    expect(state.index.list()).toHaveLength(8);
    expect(state.events).toEqual([]);
    expect(state.index.searchSource().subscribe(() => {}).state.type).not.toBe('ready');
    state.gate.release();
    await Promise.all([state.initializing, state.index.initialize()]);
    expect(state.index.list()).toHaveLength(50);
    expect(state.index.listNodes()).toHaveLength(100);
    expect(state.events).toEqual([{ type: 'initialized' }]);
  });

  it('yields after the time budget is spent before reaching the file limit', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(6);
    const { index, gate, initializing } = await startup();
    expect(index.list()).toHaveLength(1);
    gate.release();
    await initializing;
    expect(index.list()).toHaveLength(50);
  });

  it.each(['metadata', 'commit', 'rename', 'delete', 'recreate'] as const)(
    'rejects a queued old observation after %s',
    async (operation) => {
      const state = await startup();
      const { app, index, gate, initializing } = state;
      const path = 'note-49.md';
      const target = file(app, path);
      expect(index.list({ filePath: path })).toEqual([]);
      if (operation === 'metadata' || operation === 'commit') {
        const content = '- [/] newer\n  - [ ] newer child';
        await app.vault.modify(target, content);
        if (operation === 'metadata') metadataChangedEmitter(app)(target, content, {});
        else index.installCommittedContent(path, content);
        expect(index.list({ filePath: path })[0]?.title).toBe('newer');
      } else if (operation === 'rename') {
        await app.vault.rename(target, 'renamed.md');
      } else {
        await app.fileManager.trashFile(target);
        if (operation === 'recreate') await app.vault.create(path, '- [ ] replacement');
      }
      gate.release();
      await initializing;
      const expected = {
        metadata: ['newer', 'newer child'],
        commit: ['newer', 'newer child'],
        recreate: ['replacement'],
        delete: [],
        rename: ['task 49', 'child 49'],
      };
      const resultPath = operation === 'rename' ? 'renamed.md' : path;
      expect(index.listNodes({ filePath: resultPath }).map(({ node }) => node.title)).toEqual(
        expected[operation],
      );
      if (operation === 'rename') expect(index.list({ filePath: path })).toEqual([]);
      expect(state.events.filter((event) => event.type === 'initialized')).toHaveLength(1);
    },
  );

  it('uses current status and exclusion policy when the queued file is accepted', async () => {
    const { index, gate, initializing, exclude } = await startup();
    index.setStatusCatalog(
      new StatusCatalog(
        canonicalStatusCatalog()
          .all()
          .map((rule) => (rule.symbol === ' ' ? { ...rule, type: 'cancelled' as const } : rule)),
      ),
    );
    exclude('note-49.md');
    gate.release();
    await initializing;
    expect(index.list({ filePath: 'note-48.md' })[0]?.status).toBe('cancelled');
    expect(index.list({ filePath: 'note-49.md' })).toEqual([]);
  });

  it('joins a concurrent exclusion refresh before retiring its acceptance queue', async () => {
    const { app, index, gate, initializing } = await startup();
    const path = 'note-00.md';
    index.installCommittedContent(path, await app.vault.read(file(app, path)));
    const started = deferred<void>();
    const release = deferred<void>();
    const read = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (target): Promise<string> => {
      if (target.path === path) {
        started.resolve();
        await release.promise;
      }
      return read(target);
    };
    const refreshing = index.refreshSourceExclusion((source) => source.filePath === path);
    await started.promise;
    let ready = false;
    initializing.then(
      () => {
        ready = true;
      },
      () => {
        ready = false;
      },
    );
    gate.release();
    try {
      await vi.waitFor(() => {
        expect(index.list({ filePath: 'note-49.md' })).toHaveLength(1);
      });
      await flushMicrotasks();
      expect(ready).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([initializing, refreshing]);
    }
    expect(index.list({ filePath: path })).toEqual([]);
    expect(index.list()).toHaveLength(49);
  });

  it('joins a create read before readiness and lets ready listeners create after the queue retires', async () => {
    const { app, index, gate, initializing } = await startup();
    await app.vault.create('during.md', '- [ ] during');
    let after: Promise<TFile> | undefined;
    index.subscribe((event) => {
      if (event.type === 'initialized') after = app.vault.create('after.md', '- [ ] after');
    });
    gate.release();
    await initializing;
    expect(index.list({ filePath: 'during.md' })[0]?.title).toBe('during');
    await expectDefined(after);
    await flushMicrotasks();
    expect(index.list({ filePath: 'after.md' })[0]?.title).toBe('after');
  });

  it('cancels a suspended queue on unload without repopulating or publishing readiness', async () => {
    const { index, gate, initializing, events } = await startup();
    index.destroy();
    await initializing;
    expect(gate.signals.every((signal) => signal.aborted)).toBe(true);
    expect(index.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each(Array.from({ length: 17 }, (_, delay) => delay))(
    'keeps an exclusion refresh admitted %i microtasks after the final initial file publication',
    async (delay) => {
      const { app, index, gate, initializing } = await startup();
      const started = deferred<void>();
      const release = deferred<void>();
      const read = app.vault.cachedRead.bind(app.vault);
      app.vault.cachedRead = async (target): Promise<string> => {
        if (target.path === 'note-00.md') {
          started.resolve();
          await release.promise;
        }
        return read(target);
      };
      let refreshing: Promise<void> | undefined;
      index.searchSource().subscribe((event) => {
        if (event.type !== 'files' || !event.files.some((entry) => entry.path === 'note-49.md'))
          return;
        refreshing = (async () => {
          for (let turn = 0; turn < delay; turn += 1) await Promise.resolve();
          const listing = vi
            .spyOn(app.vault, 'getMarkdownFiles')
            .mockReturnValue([file(app, 'note-00.md')]);
          try {
            return index.refreshSourceExclusion((source) => source.filePath === 'note-00.md');
          } finally {
            listing.mockRestore();
          }
        })();
      });
      gate.release();
      await started.promise;
      try {
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      } finally {
        release.resolve();
        await initializing;
        await expectDefined(refreshing);
        await flushMicrotasks();
      }
      expect(index.list({ filePath: 'note-00.md' })).toEqual([]);
    },
  );

  it('propagates scheduling failure without clearing accepted source and recovers on retry', async () => {
    const { index, gate, initializing } = await startup();
    index.subscribeStatistics(() => {});
    index.installCommittedContent('accepted.md', '- [ ] retained');
    gate.fail(new Error('Cannot schedule'));
    await expect(initializing).rejects.toThrow('Cannot schedule');
    expect(index.list({ filePath: 'accepted.md' })[0]?.title).toBe('retained');
    expect(index.searchSource().subscribe(() => {}).state.type).toBe('failed');
    await index.whenStatisticsSettled();
    const statistics = index.readStatistics();
    expect(index.isStatisticsCurrent(statistics)).toBe(true);
    expect(statistics.files.find((source) => source.path === 'accepted.md')?.roots[0]?.title).toBe(
      'retained',
    );
    expect(statistics.issues).toEqual([]);
    await index.initialize();
    expect(index.list()).toHaveLength(50);
    expect(index.searchSource().subscribe(() => {}).state.type).toBe('ready');
  });

  it('ignores a late read failure from a failed attempt after a successful retry', async () => {
    const { app, index, gate, initializing } = await startup();
    const issuePaths: string[] = [];
    index.subscribeStatistics(() => {
      issuePaths.push(...index.readStatistics().issues.map((issue) => issue.path));
    });
    const late = deferred<void>();
    const started = deferred<void>();
    const read = app.vault.cachedRead.bind(app.vault);
    let held = false;
    app.vault.cachedRead = async (target): Promise<string> => {
      if (target.path === 'late.md' && !held) {
        held = true;
        started.resolve();
        await late.promise;
        throw new Error('Old read failed');
      }
      return read(target);
    };
    await app.vault.create('late.md', '- [ ] latest');
    await started.promise;
    gate.fail(new Error('Cannot schedule'));
    await expect(initializing).rejects.toThrow('Cannot schedule');
    // The retry also drains the old read; release it only after the retry has accepted latest.
    const retry = index.initialize();
    await vi.waitFor(() => {
      expect(index.list({ filePath: 'late.md' })[0]?.title).toBe('latest');
    });
    late.resolve();
    await retry;
    expect(index.list({ filePath: 'late.md' })[0]?.title).toBe('latest');
    expect(index.list()).toHaveLength(51);
    await index.whenStatisticsSettled();
    const statistics = index.readStatistics();
    expect(index.isStatisticsCurrent(statistics)).toBe(true);
    expect(statistics.files.find((source) => source.path === 'late.md')?.roots[0]?.title).toBe(
      'latest',
    );
    expect(statistics.issues).toEqual([]);
    expect(issuePaths).toEqual([]);
  });
});
