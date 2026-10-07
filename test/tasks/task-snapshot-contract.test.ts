import { TFile, type CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  metadataChangedEmitter,
  seedTaskCache,
  useRealMoment,
} from '../helpers';
import { expectDefined } from './../helpers';

useRealMoment();

function cache(lines: number[]): CachedMetadata {
  return {
    listItems: lines.map((line) => ({
      task: ' ',
      parent: -1,
      position: { start: { line, col: 0, offset: 0 }, end: { line, col: 40, offset: 40 } },
    })),
  };
}

async function snapshotIndex(content: string): Promise<{
  index: TaskIndex;
  fireChanged: (file: TFile, data: string, cache: CachedMetadata) => void;
  file: TFile;
}> {
  const app = await createAppWithFiles({ 'tasks.md': content });
  seedTaskCache(app, 'tasks.md', [{ task: ' ', parent: -1, line: 0 }]);
  const fireChanged = metadataChangedEmitter(app);
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
  });
  await index.initialize();
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('missing tasks.md');
  return { index, fireChanged, file };
}

describe('TaskSnapshot contract', () => {
  it('keeps inline-code tag lookalikes in root and nested titles while exposing only real tags', async () => {
    const content = [
      '- [ ] root `#inline` #real #real',
      '  - [ ] child ``code ` #nested`` #child #child',
    ].join('\n');
    const { index } = await snapshotIndex(content);

    expect(index.list()[0]).toMatchObject({
      markdownTitle: 'root `#inline`',
      title: 'root `#inline`',
      tags: ['#real', '#real'],
      subtasks: [
        {
          markdownTitle: 'child ``code ` #nested``',
          title: 'child ``code ` #nested``',
          tags: ['#child', '#child'],
        },
      ],
    });
    index.destroy();
  });

  it('projects lifecycle and recurrence contracts for root and nested subtasks', async () => {
    const content = [
      '- [x] root 🔁 every week 🏁 DELETE ➕ 2026-08-01 ✅ 2026-08-02 ❌ 2026-08-03',
      '  - [ ] child 🔁 every day 🏁 Keep ➕ 2026-08-04 ✅ 2026-08-05 ❌ 2026-08-06',
    ].join('\n');
    const { index } = await snapshotIndex(content);

    expect(index.list()[0]).toMatchObject({
      recurrence: 'every week',
      onCompletion: 'delete',
      onCompletionExplicit: true,
      planning: { created: '2026-08-01', completion: '2026-08-02', cancelled: '2026-08-03' },
      subtasks: [
        {
          recurrence: 'every day',
          onCompletion: 'keep',
          onCompletionExplicit: true,
          planning: {
            created: '2026-08-04',
            completion: '2026-08-05',
            cancelled: '2026-08-06',
          },
        },
      ],
    });
    index.destroy();
  });

  it('preserves authored dependency order and duplicates for roots and nested subtasks', async () => {
    const content = [
      '- [ ] Build API 🆔 build-api ⛔ schema, auth, schema',
      '  - [ ] Integrate client 🆔 client ⛔ build-api, auth, build-api',
    ].join('\n');
    const { index } = await snapshotIndex(content);

    expect(index.list()[0]).toMatchObject({
      markdownTitle: 'Build API',
      dependencyId: 'build-api',
      dependsOn: ['schema', 'auth', 'schema'],
      subtasks: [
        {
          markdownTitle: 'Integrate client',
          dependencyId: 'client',
          dependsOn: ['build-api', 'auth', 'build-api'],
        },
      ],
    });
    index.destroy();
  });

  it('returns detached non-empty dependency lists for nested subtasks', async () => {
    const { index } = await snapshotIndex('- [ ] root\n  - [ ] child ⛔ schema, auth');
    const firstChild = expectDefined(expectDefined(index.list()[0]).subtasks[0]);

    expect(firstChild.dependsOn).toEqual(['schema', 'auth']);
    (firstChild.dependsOn as unknown as string[]).push('mutated');

    const freshChild = expectDefined(expectDefined(index.list()[0]).subtasks[0]);
    expect(freshChild.dependsOn).toEqual(['schema', 'auth']);
    index.destroy();
  });

  it('initializes empty dependency lists when Tasks-compatible carriers are absent', async () => {
    const { index } = await snapshotIndex('- [ ] root\n  - [ ] child');
    const root = expectDefined(index.list()[0]);
    const child = expectDefined(root.subtasks[0]);

    expect(root.dependencyId).toBeUndefined();
    expect(root.dependsOn).toEqual([]);
    expect(child.dependencyId).toBeUndefined();
    expect(child.dependsOn).toEqual([]);
    index.destroy();
  });

  it('returns detached arrays, task objects, nested values, and calendar buckets', async () => {
    const content = [
      '- [ ] root #tag 📅 2026-07-13',
      '  - [ ] child #nested',
      '  - 2026-07-13: comment',
    ].join('\n');
    const { index } = await snapshotIndex(content);

    const first = index.list();
    const task = expectDefined(first[0]);
    (first as unknown as unknown[]).length = 0;
    (task as unknown as { title: string }).title = 'Mutated';
    (task.tags as unknown as string[]).push('#bad');
    (task.dependsOn as unknown as string[]).push('bad-id');
    (task.planning as unknown as { due: string }).due = '2099-01-01';
    (task.source as unknown as { filePath: string }).filePath = 'bad.md';
    (task.subtasks as unknown as unknown[]).length = 0;
    (task.comments as unknown as unknown[]).length = 0;
    const bucket = index.forCalendarProjection(['2026-07-13' as never]).materialized;
    (bucket as unknown as unknown[]).length = 0;

    const fresh = expectDefined(index.list()[0]);
    expect(fresh.title).toBe('root');
    expect(fresh.tags).toEqual(['#tag']);
    expect(fresh.dependsOn).toEqual([]);
    expect(fresh.planning.due).toBe('2026-07-13');
    expect(fresh.source.filePath).toBe('tasks.md');
    expect(fresh.subtasks).toHaveLength(1);
    expect(fresh.comments).toHaveLength(1);
    expect(index.forCalendarProjection(['2026-07-13' as never]).materialized).toHaveLength(1);
    index.destroy();
  });

  it('derives revisions from the exact observed root block, including child-only changes', async () => {
    const { index, fireChanged, file } = await snapshotIndex(
      ['- [ ] root', '  - [ ] child one'].join('\n'),
    );
    const before = expectDefined(index.list()[0]);
    expect(before.ref.revision).not.toBe(before.source.originalMarkdown);

    fireChanged(file, ['- [ ] root', '  - [ ] child two'].join('\n'), {
      listItems: [
        {
          task: ' ',
          parent: -1,
          position: { start: { line: 0 }, end: { line: 0 } },
        },
        {
          task: ' ',
          parent: 0,
          position: { start: { line: 1 }, end: { line: 1 } },
        },
      ],
    } as CachedMetadata);
    const after = expectDefined(index.list()[0]);
    expect(after.source.originalMarkdown).toBe(before.source.originalMarkdown);
    expect(after.ref.revision).not.toBe(before.ref.revision);
    index.destroy();
  });

  it('exposes the complete exact root block for safe conflict inspection', async () => {
    const block = [
      '- [ ] root',
      '  - > description',
      '  - 2026-07-14: comment',
      '  - [ ] child',
      '    - [ ] nested',
    ].join('\r\n');
    const { index } = await snapshotIndex(`${block}\r\n- [ ] sibling`);

    expect(expectDefined(index.list()[0]).source.originalBlock).toBe(block);
    index.destroy();
  });

  it('resolves exact, proven drift, visual continuity, uncertainty, and ambiguity safely', async () => {
    const { index, fireChanged, file } = await snapshotIndex('- [ ] same');
    const observed = expectDefined(index.list()[0]);
    expect(index.resolve(observed.ref)).toMatchObject({ type: 'exact', task: { title: 'same' } });

    fireChanged(file, ['plain', '- [ ] same'].join('\n'), cache([1]));
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'rebased',
      current: { source: { line: 1 } },
      evidence: 'byte-identical-relocation',
    });

    fireChanged(file, '- [ ] changed', cache([0]));
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { title: 'changed' },
      evidence: 'same-line',
    });
    expect(index.resolve({ ...observed.ref, line: 50 })).toEqual({
      type: 'uncertain',
      ref: { ...observed.ref, line: 50 },
    });

    fireChanged(file, ['plain', '- [ ] same', '- [ ] same'].join('\n'), cache([1, 2]));
    const ambiguous = index.resolve(observed.ref);
    expect(ambiguous.type).toBe('ambiguous');
    if (ambiguous.type === 'ambiguous') {
      expect(ambiguous.candidates.map((candidate) => candidate.root.source.line)).toEqual([1, 2]);
    }
    index.destroy();
  });

  it.each(['  ', '    ', '\t'])(
    'retains hierarchy and plain comments for authored prefix %j',
    async (prefix) => {
      const content = [
        '- [ ] root',
        `${prefix}- plain comment`,
        `${prefix}- [ ] first`,
        '',
        `${prefix}- [ ] second`,
        `${prefix}${prefix}- [ ] grandchild`,
        `${prefix}- > details`,
        `${prefix}- 2026-09-20T12:00:00+07:00 →`,
      ].join('\r\n');
      const { index } = await snapshotIndex(content);
      try {
        const roots = index.list();
        expect(roots).toHaveLength(1);
        const root = expectDefined(roots[0]);
        expect(root.source.originalBlock).toBe(content);
        expect(root.comments.map((comment) => comment.text)).toEqual(['plain comment']);
        expect(root.subtasks.map((child) => child.title)).toEqual(['first', 'second']);
        expect(root.subtasks[0]?.subtasks).toHaveLength(0);
        expect(root.subtasks[1]?.subtasks.map((child) => child.title)).toEqual(['grandchild']);
        expect(root.description).toBe('details');
        expect(root.timeEntries).toHaveLength(1);
      } finally {
        index.destroy();
      }
    },
  );
});

it('bounds a projected comment to the exact supplied root block', () => {
  const statusCatalog = canonicalStatusCatalog();
  const exactBlock = '   >   > - [ ] Root\n   >   >   - head';
  const projected = expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statusCatalog),
      statusCatalog,
      filePath: 'tasks.md',
      lines: `${exactBlock}\n> >     tail\n   >   >   - [ ] Child`.split('\n'),
      line: 0,
      exactBlock,
      ref: { filePath: 'tasks.md', line: 0, revision: 'before' },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
  expect(projected.comments.map((comment) => comment.text)).toEqual(['head']);
  expect(projected.subtasks).toEqual([]);
});

it('projects authored duration for root and exact ordinary child without rewriting bytes', async () => {
  const content = '- [ ] Root ⏰ 09:00 ⏱️ 1h\n  - [ ] Timed ⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h';
  const { index } = await snapshotIndex(content);
  const root = expectDefined(index.list()[0]);
  expect(root.planning.duration).toBe(60);
  expect(root.subtasks[0]?.planning).toMatchObject({ time: '09:00', duration: 60 });
  expect(root.source.originalBlock).toBe(content);
  const subscription = index.searchSource().subscribe(() => {});
  const compact: number[] = [];
  for await (const batch of index.organization(
    { expectedGeneration: subscription.state.generation, scope: 'nodes' },
    new AbortController().signal,
  ))
    for (const record of batch.items) compact.push(record.planning.duration ?? 0);
  expect(compact).toEqual([60, 60]);
  index.destroy();
});

it.each(['duration', 'time', 'body', 'root'] as const)(
  'protects complete competing child bytes and permits proved root-only retry: %s',
  async (kind) => {
    const h = await hierarchyHarness({
      'source.md': '- [ ] Parent\n  - [ ] Child ⏰ 09:00 ⏱️ 1h\n',
      'target.md': '- [ ] Other\n',
    });
    const child = expectDefined(h.source.subtasks[0]);
    const target = { type: 'subtask' as const, ref: child.ref };
    const edit = h.repository.edit.bind(h.repository);
    let raced = false;
    let competing = '';
    const observed = vi.spyOn(h.repository, 'edit').mockImplementation(async (request) => {
      if (!raced) {
        raced = true;
        let change: TaskCommand;
        if (kind === 'root')
          change = {
            type: 'patch',
            target: { type: 'task', ref: h.source.ref },
            patch: { markdownTitle: { type: 'set', value: 'Renamed parent' } },
          };
        else if (kind === 'body')
          change = { type: 'set-description', target, text: 'Competing body' };
        else
          change = {
            type: 'patch',
            target,
            patch:
              kind === 'time'
                ? { time: { type: 'set', value: localTime('10:00') } }
                : { duration: { type: 'set', value: durationMinutes(120) } },
          };
        expect((await h.service.execute(change)).type).toBe('ok');
        competing = await h.read('source.md');
        // Present the committed authority transition at the application retry boundary.
        // The second request below uses the real repository and current canonical target.
        if (kind === 'root')
          return {
            type: 'rebased',
            previous: h.source,
            current: expectDefined(h.index.list({ filePath: 'source.md' })[0]),
            evidence: 'authority-transition',
          };
      }
      return edit(request);
    });
    const result = await h.service.execute({
      type: 'patch',
      target,
      patch: { duration: { type: 'set', value: durationMinutes(90) } },
    });
    expect(result.type).toBe(kind === 'root' ? 'ok' : 'conflict');
    const attempts = observed.mock.calls.filter(([request]) => {
      const command = 'command' in request ? request.command : request;
      return (
        command.type === 'patch' &&
        command.patch.duration?.type === 'set' &&
        command.patch.duration.value === 90
      );
    });
    expect(attempts).toHaveLength(kind === 'root' ? 2 : 1);
    expect(await h.read('source.md')).toBe(
      kind === 'root' ? '- [ ] Renamed parent\n  - [ ] Child ⏰ 09:00 ⏱️ 1h30m\n' : competing,
    );
    h.index.destroy();
  },
);

it.each([false, true])(
  'validates point-role moves against exact full source, child=%s',
  async (child) => {
    const header = '- [ ] Inverted 🛫 2026-10-10 📅 2026-10-08 ⏳ 2026-10-10';
    const source = child ? `- [ ] Parent\n  ${header}\n` : `${header}\n`;
    const h = await hierarchyHarness({ 'source.md': source, 'target.md': '- [ ] Other\n' });
    const date = localDate('2026-10-10');
    const occurrence = expectDefined(
      projectCalendarOccurrences(
        h.index.forCalendarProjection([date]),
        { from: date, to: date },
        { removeScheduledDate: false },
      ).occurrences[0],
    );
    const display = taskSnapshotForCalendarOccurrence(occurrence);
    expect(
      (
        await h.service.execute(
          expectDefined(calendarPointPatchCommand(display, localDate('2026-10-11'))),
        )
      ).type,
    ).toBe('invalid');
    expect(await h.read('source.md')).toBe(source);
    expect(
      (
        await h.service.execute(
          expectDefined(calendarPointPatchCommand(display, localDate('2026-10-07'))),
        )
      ).type,
    ).toBe('ok');
    expect(await h.read('source.md')).toBe(source.replaceAll('2026-10-10', '2026-10-07'));
    h.index.destroy();
  },
);

import type { TaskCommand } from '../../src/tasks/domain/commands';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';
import {
  calendarPointPatchCommand,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../../src/views/calendarOccurrences';
import { hierarchyHarness } from '../support/taskHierarchyHarness';

it('clamps exact child timing and preserves its duration through subtree undo', async () => {
  const original =
    '- [ ] Parent\n  - [ ] Child ⏳ 2026-10-08 ⏰ 23:30 ⏱️ 1h\n  - [ ] Sibling 📅 malformed\n';
  const h = await hierarchyHarness({ 'source.md': original, 'target.md': '- [ ] Other\n' });
  const child = expectDefined(h.source.subtasks[0]);
  expect(
    (
      await h.service.execute({
        type: 'patch',
        target: { type: 'subtask', ref: child.ref },
        patch: { duration: { type: 'set', value: durationMinutes(90) } },
      })
    ).type,
  ).toBe('ok');
  const expected = original.replace('⏱️ 1h', '⏱️ 30m');
  expect(await h.read('source.md')).toBe(expected);
  const current = expectDefined(h.index.list({ filePath: 'source.md' })[0]?.subtasks[0]);
  expect(current.planning.duration).toBe(30);
  const removed = await h.service.execute({ type: 'delete-subtask', subtask: current.ref });
  if (removed.type !== 'ok' || removed.outcome.type !== 'task')
    throw new Error('expected removal receipt');
  const recovery = expectDefined(removed.outcome.subtaskRemovalRecovery);
  expect((await h.service.execute({ type: 'restore-subtask', ...recovery })).type).toBe('ok');
  expect(await h.read('source.md')).toBe(expected);
  h.index.destroy();
});

it.each([false, true])(
  'keeps distinct and malformed date siblings during scheduled point time moves, child=%s',
  async (child) => {
    const header = '- [ ] Timed 🛫 2026-10-10 📅 malformed ⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h';
    const source = child ? `- [ ] Parent\n  ${header}\n` : `${header}\n`;
    const h = await hierarchyHarness({ 'source.md': source, 'target.md': '- [ ] Other\n' });
    const date = localDate('2026-10-08');
    const occurrence = expectDefined(
      projectCalendarOccurrences(
        h.index.forCalendarProjection([date]),
        { from: date, to: date },
        { removeScheduledDate: false },
      ).occurrences[0],
    );
    const command = expectDefined(
      calendarPointPatchCommand(
        taskSnapshotForCalendarOccurrence(occurrence),
        localDate('2026-10-09'),
        { type: 'set', value: localTime('23:30') },
      ),
    );
    expect((await h.service.execute(command)).type).toBe('ok');
    expect(await h.read('source.md')).toBe(
      source.replace('⏳ 2026-10-08 ⏰ 09:00 ⏱️ 1h', '⏳ 2026-10-09 ⏰ 23:30 ⏱️ 30m'),
    );
    const beforeStaleAttempt = await h.read('source.md');
    await h.service.execute(command);
    expect(await h.read('source.md')).toBe(beforeStaleAttempt);
    h.index.destroy();
  },
);
