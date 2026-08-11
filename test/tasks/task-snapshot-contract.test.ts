import { TFile, type CachedMetadata } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  captureChangedCallback,
  createAppWithFiles,
  seedTaskCache,
  useRealMoment,
} from '../helpers';

useRealMoment();

function cache(lines: number[]): CachedMetadata {
  return {
    listItems: lines.map((line) => ({
      task: ' ',
      parent: -1,
      position: { start: { line, col: 0, offset: 0 }, end: { line, col: 40, offset: 40 } },
    })),
  } as CachedMetadata;
}

async function snapshotIndex(content: string): Promise<{
  index: TaskIndex;
  fireChanged: (file: TFile, data: string, cache: CachedMetadata) => void;
  file: TFile;
}> {
  const app = await createAppWithFiles({ 'tasks.md': content });
  seedTaskCache(app, 'tasks.md', [{ task: ' ', parent: -1, line: 0 }]);
  const fireChanged = captureChangedCallback(app);
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    dailyNoteFormat: 'YYYY-MM-DD',
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

  it('returns detached arrays, task objects, nested values, and calendar buckets', async () => {
    const content = [
      '- [ ] root #tag 📅 2026-07-13',
      '  - [ ] child #nested',
      '  - 2026-07-13: comment',
    ].join('\n');
    const { index } = await snapshotIndex(content);

    const first = index.list();
    const task = first[0]!;
    (first as unknown as unknown[]).length = 0;
    (task as unknown as { title: string }).title = 'mutated';
    (task.tags as unknown as string[]).push('#bad');
    (task.planning as unknown as { due: string }).due = '2099-01-01';
    (task.source as unknown as { filePath: string }).filePath = 'bad.md';
    (task.subtasks as unknown as unknown[]).length = 0;
    (task.comments as unknown as unknown[]).length = 0;
    const bucket = index.forCalendarProjection(['2026-07-13' as never]).materialized;
    (bucket as unknown as unknown[]).length = 0;

    const fresh = index.list()[0]!;
    expect(fresh.title).toBe('root');
    expect(fresh.tags).toEqual(['#tag']);
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
    const before = index.list()[0]!;
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
    const after = index.list()[0]!;
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

    expect(index.list()[0]!.source.originalBlock).toBe(block);
    index.destroy();
  });

  it('resolves exact, proven drift, uncertainty, and ambiguous references safely', async () => {
    const { index, fireChanged, file } = await snapshotIndex('- [ ] same');
    const observed = index.list()[0]!;
    expect(index.resolve(observed.ref)).toMatchObject({ type: 'exact', task: { title: 'same' } });

    fireChanged(file, ['plain', '- [ ] same'].join('\n'), cache([1]));
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'rebased',
      current: { source: { line: 1 } },
      evidence: 'byte-identical-relocation',
    });

    fireChanged(file, '- [ ] changed', cache([0]));
    expect(index.resolve(observed.ref)).toEqual({ type: 'uncertain', ref: observed.ref });
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
});
