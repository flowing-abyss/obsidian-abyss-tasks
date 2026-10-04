import { TFile, type CachedMetadata } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareStatisticsDataset } from '../../src/statistics';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import * as timeEntry from '../../src/tasks/domain/timeEntry';
import { TaskIndex, type TaskIndexOptions } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  metadataChangedEmitter,
  seedTaskCache,
} from '../helpers';
import { work } from '../helpers/statisticsFixtures';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
  vi.restoreAllMocks();
});

async function harness(
  files: Record<string, string>,
  options: Partial<TaskIndexOptions> = {},
  defaultPolicy = false,
) {
  const app = await createAppWithFiles(files);
  const statusCatalog = canonicalStatusCatalog();
  const refAuthority = new TaskRefAuthority();
  const index = new TaskIndex(app, {
    statusCatalog,
    refAuthority,
    ...(defaultPolicy
      ? {}
      : {
          excludeSource: ({ filePath }: { filePath: string }) =>
            filePath.startsWith('archive/') || filePath === 'ignored.md',
          statisticsFileKind: (path: string) => {
            if (path === 'ignored.md') return undefined;
            return path.startsWith('archive/') ? 'archive' : 'live';
          },
        }),
    ...options,
  });
  indexes.push(index);
  const file = (path: string): TFile => {
    const found = app.vault.getAbstractFileByPath(path);
    if (!(found instanceof TFile)) throw new Error(`Missing fixture ${path}`);
    return found;
  };
  const changed = (path: string, content: string, cache: CachedMetadata = {}) => {
    metadataChangedEmitter(app)(file(path), content, cache);
  };
  return { app, index, refAuthority, statusCatalog, file, changed };
}

describe('lazy complete task statistics evidence', () => {
  it.each([1000, 4000])(
    'shares exact archive provenance without copying it into %i wide/deep descendant keys',
    async (width) => {
      const content = `- [ ] Root\n${Array.from(
        { length: width },
        (_, i) => `  - [ ] Child ${i}\n`,
      ).join('')}${Array.from(
        { length: 32 },
        (_, depth) => `${'  '.repeat(depth + 1)}- [ ] Deep ${depth}\n`,
      ).join('')}`;
      const { index, refAuthority } = await harness({ 'archive/large.md': content });
      await index.initialize();
      index.subscribeStatistics(() => {});
      await index.whenStatisticsSettled();
      const snapshot = index.readStatistics(),
        root = expectDefined(snapshot.files[0]?.roots[0]);
      expect(root.ref.revision).toBe(`statistics:${root.source.originalBlock}`);
      expect(refAuthority.evidence(root.ref.revision)).toBeUndefined();
      const dataset = expectDefined(await prepareStatisticsDataset(snapshot, [], work));
      expect(dataset.tasks).toHaveLength(width + 33);
      for (const task of dataset.tasks) {
        let ref = task.ref;
        while (ref.type === 'subtask') ref = ref.ref.parent;
        expect(ref.ref).toBe(root.ref);
        expect(task.key.length).toBeLessThan(160);
        expect(task.key).not.toContain('statistics:');
      }
      expect(dataset.tasks.reduce((bytes, task) => bytes + task.key.length, 0)).toBeLessThan(
        (width + 33) * 60,
      );
    },
  );
  it('settles accepted work, unchanged work and nested holds without acquiring sources', async () => {
    const { index, app } = await harness({ 'live.md': '- [ ] Old\n' });
    await index.initialize();
    const release = index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const read = vi.spyOn(app.vault, 'cachedRead');
    const before = index.readStatistics();
    const outer = index.holdStatisticsPublication();
    const inner = index.holdStatisticsPublication();
    index.installCommittedContent('live.md', '- [ ] New\n');
    expect(index.isStatisticsCurrent(before)).toBe(false);
    let settled = false;
    const pending = index.whenStatisticsSettled().then(() => {
      settled = true;
    });
    await index.refreshStatistics();
    inner();
    inner();
    await Promise.resolve();
    expect(settled).toBe(false);
    outer();
    await pending;
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('New');
    expect(index.isStatisticsCurrent(index.readStatistics())).toBe(true);
    index.installCommittedContent('live.md', '- [ ] New\n');
    await index.whenStatisticsSettled();
    expect(read).not.toHaveBeenCalled();
    const hold = index.holdStatisticsPublication();
    const teardown = index.whenStatisticsSettled();
    release();
    await teardown;
    await index.whenStatisticsSettled();
    hold();
  });

  it('retains an in-flight publication hold across hide and reactivation while releasing old waiters', async () => {
    const { index } = await harness({ 'live.md': '- [ ] Original\n' });
    await index.initialize();
    const off = index.subscribeStatistics(() => {});
    await index.refreshStatistics();
    const release = index.holdStatisticsPublication();
    const hidden = index.whenStatisticsSettled();
    off();
    await hidden;
    index.installCommittedContent('live.md', '- [ ] In flight\n');
    const shown = index.subscribeStatistics(() => {});
    await index.refreshStatistics();
    expect(index.isStatisticsCurrent(index.readStatistics())).toBe(false);
    expect(index.readStatistics().files).toEqual([]);
    release();
    await index.whenStatisticsSettled();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('In flight');
    shown();
  });

  it.each(['---\nproject: A\n---\n', '---\nproject: B\n---\n- [ ] Same\n'])(
    'settles accepted metadata-only and empty-root files: %s',
    async (content) => {
      const { index } = await harness({ 'live.md': '' });
      await index.initialize();
      index.subscribeStatistics(() => undefined);
      await index.refreshStatistics();
      const prior = index.readStatistics();
      index.installCommittedContent('live.md', content);
      expect(index.isStatisticsCurrent(prior)).toBe(false);
      await index.whenStatisticsSettled();
      expect(index.isStatisticsCurrent(index.readStatistics())).toBe(true);
      expect(index.readStatistics()).not.toBe(prior);
    },
  );

  it('publishes ordinary restored tasks before statistics after explicit acquisition retry', async () => {
    const { app, index } = await harness({ 'live.md': '- [ ] Retained\n' }, {}, true);
    await index.initialize();
    const events: string[] = [];
    index.subscribe((event) => events.push(event.type));
    index.subscribeReconciled(() => events.push('reconciled'));
    index.subscribeStatistics(() => events.push('statistics'));
    await index.refreshStatistics();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(new Error('offline'));
    await index.refreshSourceExclusion(undefined);
    await flushMicrotasks();
    expect(index.list()).toHaveLength(0);
    read.mockRestore();
    events.length = 0;
    await index.refreshStatistics();
    expect(index.list()[0]?.title).toBe('Retained');
    expect(events).toEqual(['changed', 'statistics']);
  });

  it.each([true, false])(
    'queues accepted retry reconciliation before statistics when metadata changes=%s',
    async (metadataChanges) => {
      const original = '---\nproject: First\n---\n- [ ] Same\n';
      const updated = metadataChanges ? '---\nproject: Second\n---\n- [ ] Same\n' : original;
      const { app, index, changed } = await harness({ 'live.md': original }, {}, true);
      await index.initialize();
      const events: string[] = [];
      index.subscribe((event) => events.push(event.type));
      index.subscribeReconciled((paths) => events.push(`reconciled:${paths.join(',')}`));
      index.subscribeStatistics(() => events.push('statistics'));
      await index.refreshStatistics();
      const ordinary = index.list()[0];
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const parser = vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation(() => {
        throw new Error('metadata acceptance unavailable');
      });
      changed('live.md', updated);
      await flushMicrotasks();
      expect(index.list()[0]).toEqual(ordinary);
      expect(index.readStatistics().issues).toHaveLength(1);
      parser.mockRestore();
      await app.vault.adapter.write('live.md', updated);
      events.length = 0;
      await index.refreshStatistics();
      expect(index.list()[0]).toEqual(ordinary);
      expect(index.readStatistics().issues).toEqual([]);
      expect(events).toEqual(['reconciled:live.md', 'statistics']);
    },
  );

  it.each(['children', 'entries'] as const)(
    'bounds canonical traversal of one root with 1100 %s and cancels during traversal',
    async (shape) => {
      const children = Array.from({ length: 1100 }, (_, number) => `  - [x] Child ${number}`);
      const entries = Array.from(
        { length: 1100 },
        () => '  - 2026-10-01T10:00:00+00:00 → 2026-10-01T10:15:00+00:00',
      );
      const content = ['- [x] Parent', ...(shape === 'children' ? children : entries)].join('\n');
      const { index } = await harness({ 'archive/2026.md': content });
      await index.initialize();
      let calls = 0;
      let beforeYield = -1;
      let cancelDuringTraversal = false;
      let release: () => void = () => undefined;
      const observe = () => {
        calls += 1;
        if (calls === 1)
          queueMicrotask(() => {
            beforeYield = calls;
            if (cancelDuringTraversal) release();
          });
      };
      const parseTask = TaskMarkdownCodec.prototype.parseLine.bind(
        new TaskMarkdownCodec(canonicalStatusCatalog()),
      );
      vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation((...args) => {
        if (shape === 'children' && args[0].startsWith('  - [x] Child')) observe();
        return parseTask(...args);
      });
      const parseEntry = timeEntry.parseTimeEntryLine;
      vi.spyOn(timeEntry, 'parseTimeEntryLine').mockImplementation((...args) => {
        if (shape === 'entries') observe();
        return parseEntry(...args);
      });
      release = index.subscribeStatistics(() => undefined);
      await index.refreshStatistics();
      const root = expectDefined(index.readStatistics().files[0]?.roots[0]);
      expect(shape === 'children' ? root.subtasks : root.timeEntries).toHaveLength(1100);
      expect(beforeYield).toBeGreaterThan(0);
      expect(beforeYield).toBeLessThanOrEqual(1000);
      release();
      calls = 0;
      beforeYield = -1;
      cancelDuringTraversal = true;
      release = index.subscribeStatistics(() => undefined);
      await index.refreshStatistics();
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(1000);
      expect(index.readStatistics()).toMatchObject({ ready: false, files: [] });
    },
  );

  it('cancels canonical context preparation before parsing roots after the last lease ends', async () => {
    const content = Array.from({ length: 1100 }, (_, number) => `- [x] Retained ${number}`).join(
      '\n',
    );
    const { index } = await harness({ 'archive/2026.md': content });
    await index.initialize();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation(() => {
      throw new Error('disabled projection must not reach codec');
    });
    const release = index.subscribeStatistics(() => undefined);
    await new Promise<void>((resolve) =>
      window.setTimeout(() => {
        release();
        resolve();
      }, 0),
    );
    await index.refreshStatistics();
    expect(index.readStatistics().files).toEqual([]);
    expect(diagnostic.mock.calls).toEqual([]);
  });
  it('cancels a large archive projection between batches and rebuilds exact evidence on reentry', async () => {
    const content = Array.from({ length: 1100 }, (_, number) => `- [x] Retained ${number}`).join(
      '\n',
    );
    const { index } = await harness({ 'archive/2026.md': content });
    await index.initialize();
    const release = index.subscribeStatistics(() => undefined);
    await new Promise<void>((resolve) =>
      window.setTimeout(() => {
        release();
        resolve();
      }, 0),
    );
    await index.refreshStatistics();
    expect(index.readStatistics()).toMatchObject({ ready: false, files: [] });
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const roots = expectDefined(index.readStatistics().files[0]).roots;
    expect(roots).toHaveLength(1100);
    expect(roots[0]?.title).toBe('Retained 0');
    expect(roots[1099]?.title).toBe('Retained 1099');
  });

  it.each(['move', 'archive'] as const)(
    'publishes the single retained physical copy after successful %s',
    async (operation) => {
      const { app, index, statusCatalog, refAuthority } = await harness({
        'source.md': '- [x] Transfer\n  - [x] Child\n',
        'archive/2026.md': '',
      });
      await index.initialize();
      const counts: number[] = [];
      index.subscribeStatistics(() => {
        counts.push(index.readStatistics().files.flatMap(({ roots }) => roots).length);
      });
      await index.refreshStatistics();
      const repository = new ObsidianTaskRepository(app, {
        codec: new TaskMarkdownCodec(statusCatalog),
        editor: new TaskBlockEditor(),
        locator: new TaskLocator(refAuthority),
        refAuthority,
        snapshotState: index,
        snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
      });
      expect(
        (
          await repository[operation](expectDefined(index.list()[0]).ref, {
            filePath: 'archive/2026.md',
            insertion: { type: 'append' },
          })
        ).type,
      ).toBe('committed');
      await index.refreshStatistics();
      expect(counts.every((count) => count === 1)).toBe(true);
      expect(index.readStatistics().files[0]?.roots[0]?.subtasks[0]?.title).toBe('Child');
      expect(index.list()).toEqual([]);
    },
  );
  it('publishes active rename evidence before settlement when metadata supersedes the rename read', async () => {
    const { app, index, file } = await harness({ 'live.md': '- [ ] Original\n' }, {}, true);
    await index.initialize();
    const notified = vi.fn();
    const release = index.subscribeStatistics(notified);
    await index.whenStatisticsSettled();
    const before = index.readStatistics();
    notified.mockClear();
    await app.vault.rename(file('live.md'), 'renamed.md');
    seedTaskCache(app, 'renamed.md', [{ task: ' ', parent: -1, line: 0 }]);
    await index.whenStatisticsSettled();
    const after = index.readStatistics();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.files.map((entry) => entry.path)).toEqual(['renamed.md']);
    expect(after.files[0]?.roots[0]?.source.filePath).toBe('renamed.md');
    expect(after.files[0]?.roots[0]?.title).toBe('Original');
    expect(index.isStatisticsCurrent(after)).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);
    release();
  });

  it('keeps accepted evidence after an inactive fast rename in a default-policy harness', async () => {
    const { app, index, file } = await harness({ 'live.md': '- [ ] Relocated\n' }, {}, true);
    await index.initialize();
    await app.vault.rename(file('live.md'), 'renamed.md');
    expect(index.list()[0]?.source.filePath).toBe('renamed.md');
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.source.filePath).toBe('renamed.md');
    expect(index.readStatistics().files[0]?.roots[0]?.ref).toEqual(index.list()[0]?.ref);
  });
  it.each(['rename', 'delete'] as const)(
    'notifies ordinary %s reconciliation before statistics observers',
    async (operation) => {
      const { app, index, file } = await harness({ 'live.md': '- [ ] Record\n' });
      await index.initialize();
      const events: string[] = [];
      index.subscribe((event) => events.push(event.type));
      index.subscribeStatistics(() => events.push('statistics'));
      await index.refreshStatistics();
      events.length = 0;
      if (operation === 'rename') await app.vault.rename(file('live.md'), 'renamed.md');
      else await app.fileManager.trashFile(file('live.md'));
      await flushMicrotasks();
      expect(events[0]).toBe(operation === 'rename' ? 'renamed' : 'deleted');
      expect(events[events.length - 1]).toBe('statistics');
      expect(index.readStatistics().files.map(({ path }) => path)).toEqual(
        operation === 'rename' ? ['renamed.md'] : [],
      );
    },
  );

  it('reuses accepted bytes on activation and never rereads a hidden refresh', async () => {
    const { app, index, file } = await harness({ 'archive/2026.md': '- [x] Accepted\n' });
    await index.initialize();
    await app.vault.adapter.write('archive/2026.md', '- [x] Unobserved\n');
    await index.refreshStatistics();
    expect(index.readStatistics().files).toEqual([]);
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Accepted');
    await app.vault.modify(file('archive/2026.md'), '- [x] Observed\n');
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Observed');
  });

  it('reports a live canonical projection failure from metadata without losing its prior evidence', async () => {
    const { index, changed } = await harness({ 'live.md': '- [ ] Old\n' });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const parser = vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation(() => {
      throw new Error('codec failure');
    });
    expect(() => {
      changed('live.md', '- [ ] New\n');
    }).not.toThrow();
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]).toBe(before.files[0]);
    expect(index.readStatistics().issues).toEqual([
      { path: 'live.md', reason: 'projection-failed' },
    ]);
    parser.mockRestore();
  });
  it('settles a failed initial acquisition as partial evidence without manufacturing an empty file', async () => {
    const { app, index } = await harness({ 'archive/2026.md': '- [x] Unavailable\n' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(new Error('offline'));
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    expect(index.readStatistics()).toMatchObject({
      ready: true,
      files: [],
      issues: [{ path: 'archive/2026.md', reason: 'read-failed' }],
    });
    await index.whenStatisticsSettled();
    expect(index.isStatisticsCurrent(index.readStatistics())).toBe(true);
    read.mockRestore();
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Unavailable');
    expect(index.readStatistics().issues).toEqual([]);
  });

  it('retains the last archive projection after a codec failure and recovers on explicit retry', async () => {
    const { index, changed } = await harness({ 'archive/2026.md': '- [x] Old\n' });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const parser = vi.spyOn(TaskMarkdownCodec.prototype, 'parseLine').mockImplementation(() => {
      throw new Error('projection unavailable');
    });
    changed('archive/2026.md', '- [x] Updated\n');
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]).toBe(before.files[0]);
    expect(index.readStatistics().issues).toEqual([
      { path: 'archive/2026.md', reason: 'projection-failed' },
    ]);
    parser.mockRestore();
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Updated');
    expect(index.readStatistics().issues).toEqual([]);
  });

  it('queues ordinary reconciliation before notifying statistics observers', async () => {
    const { index, changed } = await harness({ 'live.md': '- [ ] Same\n' });
    await index.initialize();
    const events: string[] = [];
    index.subscribe(() => events.push('changed'));
    index.subscribeReconciled(() => events.push('reconciled'));
    index.subscribeStatistics(() => events.push('statistics'));
    await index.refreshStatistics();
    events.length = 0;
    changed('live.md', '---\nproject: Second\n---\n- [ ] Same\n');
    await index.refreshStatistics();
    expect(events).toEqual(['changed', 'statistics']);
    events.length = 0;
    changed('live.md', '---\nproject: Third\n---\n- [ ] Same\n');
    await index.refreshStatistics();
    expect(events).toEqual(['reconciled', 'statistics']);
  });

  it('keeps nested publication holds idempotent until final accepted files are materialized', async () => {
    const { index } = await harness({ 'live.md': '- [ ] Old\n', 'archive/2026.md': '' });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    const releaseOuter = index.holdStatisticsPublication();
    const releaseInner = index.holdStatisticsPublication();
    index.installCommittedContent('archive/2026.md', '- [ ] New\n');
    await index.refreshStatistics();
    index.installCommittedContent('live.md', '');
    releaseInner();
    releaseInner();
    expect(index.readStatistics()).toBe(before);
    releaseOuter();
    // A released hold must not expose an intermediate projection from another path.
    expect(index.readStatistics()).toBe(before);
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('New');
    expect(index.readStatistics().files.flatMap(({ roots }) => roots)).toHaveLength(1);
  });
  it('counts retained physical nodes, excludes ignored sources and grants no archive query authority', async () => {
    const { index, refAuthority } = await harness({
      'live.md': '- [ ] Parent ➕ 2026-09-28\n  - [x] Child ➕ 2026-09-29 ✅ 2026-10-01\n',
      'archive/2026.md': '- [x] Retained ➕ 2026-09-20 ✅ 2026-09-21\n',
      'ignored.md': '- [x] Private ✅ 2026-09-30\n',
    });
    await index.initialize();
    expect(index.readStatistics()).toMatchObject({ ready: false, files: [], issues: [] });
    const release = index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const snapshot = index.readStatistics();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: 'archive/2026.md', kind: 'archive' },
      { path: 'live.md', kind: 'live' },
    ]);
    expect(
      snapshot.files
        .flatMap(({ roots }) =>
          roots.map((root) => [root.title, ...root.subtasks.map((node) => node.title)]),
        )
        .flat(),
    ).toEqual(['Retained', 'Parent', 'Child']);
    expect(index.list().map(({ title }) => title)).toEqual(['Parent']);
    const archived = expectDefined(snapshot.files[0]?.roots[0]);
    expect(index.resolve(archived.ref).type).toBe('not-found');
    expect(refAuthority.evidence(archived.ref.revision)).toBeUndefined();
    expect(index.readStatistics()).toBe(snapshot);
    await index.refreshStatistics();
    expect(index.readStatistics()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(archived.planning)).toBe(true);
    expect(Object.isFrozen(snapshot.files[1]?.roots[0]?.subtasks)).toBe(true);
    release();
    expect(index.readStatistics().files).toEqual([]);
  });

  it('publishes archive-only edits and reuses unchanged file evidence', async () => {
    const { index, changed } = await harness({
      'live.md': '- [ ] Same\n',
      'archive/2026.md': '- [x] Old\n',
    });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    changed('archive/2026.md', '- [x] Old\n- [x] New\n');
    await index.refreshStatistics();
    const after = index.readStatistics();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.files[0]?.roots.map(({ title }) => title)).toEqual(['Old', 'New']);
    expect(after.files[1]).toBe(before.files[1]);
    expect(index.list().map(({ title }) => title)).toEqual(['Same']);
  });

  it('uses the current catalog plus raw cancellation precedence without changing ordinary list status', async () => {
    const { index } = await harness({
      'live.md': '- [?] Custom\n- [ ] Cancelled ❌ 2026-99-99\n  - [?] Nested\n',
    });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    index.setStatusCatalog(
      new StatusCatalog([{ id: 'custom', symbol: '?', type: 'done', defaultForType: true }]),
    );
    await index.refreshStatistics();
    const roots = expectDefined(index.readStatistics().files[0]).roots;
    expect(roots.map(({ status }) => status)).toEqual(['done', 'cancelled']);
    expect(roots[1]?.planning.cancelled).toBeUndefined();
    expect(roots[1]?.subtasks[0]?.status).toBe('done');
    expect(index.list()[0]?.status).toBe('open');
    expect(index.readStatistics().revision).toBeGreaterThan(before.revision);
  });

  it('drops newly forbidden evidence synchronously even when the policy refresh read fails', async () => {
    let excluded = false;
    const { app, index } = await harness(
      { 'live.md': '- [ ] Secret\n' },
      {
        excludeSource: () => excluded,
        statisticsFileKind: () => (excluded ? undefined : 'live'),
      },
    );
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    excluded = true;
    vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(new Error('unavailable'));
    const pending = index.refreshSourceExclusion(() => excluded);
    expect(index.readStatistics().files).toEqual([]);
    await pending;
    expect(index.readStatistics().issues).toEqual([]);
  });

  it('retains last valid evidence with a typed issue and retries failed approved sources', async () => {
    const { app, index } = await harness({ 'live.md': '- [ ] Retained\n' });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    const before = index.readStatistics();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(new Error('read unavailable'));
    await index.refreshSourceExclusion(({ filePath }) => filePath.startsWith('archive/'));
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]).toBe(before.files[0]);
    expect(index.readStatistics().issues).toEqual([{ path: 'live.md', reason: 'read-failed' }]);
    expect(index.readStatistics().ready).toBe(true);
    expect(
      diagnostic.mock.calls.some(([message]) => String(message).startsWith('[abyss-tasks]')),
    ).toBe(true);
    read.mockRestore();
    await index.refreshStatistics();
    expect(index.readStatistics().issues).toEqual([]);
    expect(index.readStatistics().ready).toBe(true);
  });

  it('settles reentrant accepted changes and lease disposal during publication', async () => {
    const { index } = await harness({ 'live.md': '- [ ] Initial\n' });
    await index.initialize();
    const observed: string[] = [];
    const release = index.subscribeStatistics(() => {
      const title = expectDefined(index.readStatistics().files[0]?.roots[0]?.title);
      observed.push(title);
      if (title === 'Initial') index.installCommittedContent('live.md', '- [ ] Reentrant\n');
    });
    await index.whenStatisticsSettled();
    expect(observed).toEqual(['Initial', 'Reentrant']);
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Reentrant');
    expect(index.isStatisticsCurrent(index.readStatistics())).toBe(true);
    release();
    const dispose = index.subscribeStatistics(() => {
      dispose();
    });
    await index.whenStatisticsSettled();
    expect(index.readStatistics()).toMatchObject({ ready: false, files: [] });
  });

  it('isolates observers and cancels the last lease without activating a hidden refresh', async () => {
    const { index, changed } = await harness({ 'live.md': '- [ ] Initial\n' });
    await index.initialize();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const releaseThrowing = index.subscribeStatistics(() => {
      throw new Error('observer');
    });
    let observed = 0;
    const releaseSecond = index.subscribeStatistics(() => {
      observed += 1;
    });
    await index.refreshStatistics();
    expect(observed).toBeGreaterThan(0);
    releaseThrowing();
    releaseThrowing();
    releaseSecond();
    await index.refreshStatistics();
    expect(index.readStatistics()).toMatchObject({ ready: false, files: [] });
    changed('live.md', '- [ ] Reenabled\n');
    await flushMicrotasks();
    expect(index.readStatistics().files).toEqual([]);
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.roots[0]?.title).toBe('Reenabled');
  });

  it('retains canonical invalid and ambiguous date evidence only on physical task lines', async () => {
    const { index } = await harness({
      'live.md': [
        '- [x] Root ➕ 2026-09-01 ➕ 2026-09-02 ✅ 2026-99-99',
        '  - [ ] Child 📅 nonsense',
        '- [ ] Literal `✅ 2026-99-99` [📅 2026-99-99](note.md)',
        '',
      ].join('\n'),
    });
    await index.initialize();
    index.subscribeStatistics(() => undefined);
    await index.refreshStatistics();
    expect(index.readStatistics().files[0]?.dateIssues).toEqual([
      { line: 0, field: 'created', reason: 'ambiguous-date' },
      { line: 0, field: 'completion', reason: 'invalid-date' },
      { line: 1, field: 'due', reason: 'invalid-date' },
    ]);
  });

  it.each(['rename', 'delete', 'disable'] as const)(
    'rejects stale acquisition after %s during initialization',
    async (event) => {
      const { app, index, file } = await harness({ 'archive/2026.md': '- [x] Stale\n' });
      const originalRead = app.vault.cachedRead.bind(app.vault);
      let finish!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let held = false;
      app.vault.cachedRead = async (candidate) => {
        if (!held) {
          held = true;
          started();
          await gate;
          return '- [x] Stale\n';
        }
        return originalRead(candidate);
      };
      const release = index.subscribeStatistics(() => undefined);
      const initializing = index.initialize();
      await entered;
      if (event === 'rename') await app.vault.rename(file('archive/2026.md'), 'archive/renamed.md');
      else if (event === 'delete') await app.fileManager.trashFile(file('archive/2026.md'));
      else release();
      finish();
      await initializing;
      await index.refreshStatistics();
      expect(index.readStatistics().files.map(({ path }) => path)).toEqual(
        event === 'rename' ? ['archive/renamed.md'] : [],
      );
    },
  );

  it.each(['move', 'archive'] as const)(
    'holds %s evidence across destination append and source removal, including partial failure',
    async (operation) => {
      const { app, index, statusCatalog, refAuthority } = await harness({
        'source.md': '- [x] Transferred ✅ 2026-10-01\n',
        'archive/2026.md': '',
      });
      await index.initialize();
      index.subscribeStatistics(() => undefined);
      await index.refreshStatistics();
      const repository = new ObsidianTaskRepository(app, {
        codec: new TaskMarkdownCodec(statusCatalog),
        editor: new TaskBlockEditor(),
        locator: new TaskLocator(refAuthority),
        refAuthority,
        snapshotState: index,
        snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
      });
      const before = index.readStatistics();
      let finish!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const process = app.vault.process.bind(app.vault);
      app.vault.process = async (candidate, transform, options) => {
        if (candidate.path === 'source.md') {
          entered();
          await gate;
          throw new Error('source removal failed');
        }
        return process(candidate, transform, options);
      };
      const pending = repository[operation](expectDefined(index.list()[0]).ref, {
        filePath: 'archive/2026.md',
        insertion: { type: 'append' },
      });
      await started;
      await index.refreshStatistics();
      expect(index.readStatistics()).toBe(before);
      finish();
      expect((await pending).type).toBe('partial');
      await index.refreshStatistics();
      expect(index.readStatistics().files.flatMap(({ roots }) => roots)).toHaveLength(2);
    },
  );
});
