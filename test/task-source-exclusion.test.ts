import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import {
  taskSourceIgnoreQuery,
  validateTaskStorageDraft,
} from '../src/settings/taskStorageSettings';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { TaskIndex, type TaskSourceMetadata } from '../src/tasks/infrastructure/TaskIndex';
import { createAppWithFiles, expectDefined, flushMicrotasks } from './helpers';

function catalog(): StatusCatalog {
  return new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
}

function sourceIndex(
  files: Record<string, string>,
  excludeSource?: (source: TaskSourceMetadata) => boolean,
): Promise<{
  readonly app: Awaited<ReturnType<typeof createAppWithFiles>>;
  readonly index: TaskIndex;
}> {
  return createAppWithFiles(files).then((app) => ({
    app,
    index: new TaskIndex(app, {
      statusCatalog: catalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
      ...(excludeSource === undefined ? {} : { excludeSource }),
    }),
  }));
}

describe('TaskIndex source exclusion', () => {
  it('keeps raw archive preview available while excluding archive roots and dependencies publicly', async () => {
    const { index } = await sourceIndex(
      {
        'active.md': '- [ ] Active 🆔 active-id\n',
        'archive/2026.md': '- [ ] Archived ⛔ active-id #archive-only\n',
      },
      ({ filePath }) => filePath.toLowerCase().startsWith('archive/'),
    );

    await index.initialize();

    expect(index.list().map((task) => task.title)).toEqual(['Active']);
    expect(index.listNodes().map((node) => node.node.title)).toEqual(['Active']);
    expect(index.previewContent('archive/2026.md', '- [ ] Proof task\n')).toHaveLength(1);
    expect(
      index.dependencies({ type: 'task', ref: expectDefined(index.list()[0]).ref }).blocks,
    ).toEqual([]);
    index.destroy();
  });

  it('excludes committed content and a note renamed under an excluded path', async () => {
    const { app, index } = await sourceIndex(
      { 'active.md': '- [ ] Active\n', 'archive/2026.md': '' },
      ({ filePath }) => filePath.toLowerCase().startsWith('archive/'),
    );
    await index.initialize();

    expect(index.installCommittedContent('archive/2026.md', '- [ ] Committed archive\n')).toEqual(
      [],
    );
    expect(index.list().map((task) => task.title)).toEqual(['Active']);
    const active = app.vault.getAbstractFileByPath('active.md');
    if (!(active instanceof TFile)) throw new Error('missing active note');
    await app.vault.rename(active, 'archive/active.md');
    await flushMicrotasks(20);

    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('rebuilds projections when a detached frontmatter exclusion predicate changes', async () => {
    const { index } = await sourceIndex({
      'active.md': '---\nkind: hidden\n---\n- [ ] Active\n',
      'visible.md': '- [ ] Visible\n',
    });
    await index.initialize();

    await index.refreshSourceExclusion(({ frontmatter }) => frontmatter['kind'] === 'hidden');

    expect(index.list().map((task) => task.title)).toEqual(['Visible']);
    index.destroy();
  });
});

describe('task storage settings', () => {
  it('implicitly excludes the current archive path and preserves a previous archive on change', () => {
    expect(
      taskSourceIgnoreQuery({ taskArchivePath: 'tasks/archive.md', taskIgnoreQuery: '' }),
    ).toBe('"tasks/archive.md"');

    expect(
      validateTaskStorageDraft(
        { taskArchivePath: 'tasks/archive.md', taskIgnoreQuery: 'status=done' },
        { taskArchivePath: 'archive/{{YYYY}}.md', taskIgnoreQuery: '#private' },
      ),
    ).toEqual({
      type: 'valid',
      settings: {
        taskArchivePath: 'archive/{{YYYY}}.md',
        taskIgnoreQuery: '(#private) OR ("tasks/archive.md")',
      },
    });
  });

  it('escapes retained archive paths and rejects invalid completed drafts', () => {
    expect(
      validateTaskStorageDraft(
        { taskArchivePath: 'team "done".md', taskIgnoreQuery: '' },
        { taskArchivePath: 'new.md', taskIgnoreQuery: '' },
      ),
    ).toMatchObject({
      type: 'valid',
      settings: { taskIgnoreQuery: '"team \\"done\\".md"' },
    });
    expect(
      validateTaskStorageDraft(
        { taskArchivePath: 'archive.md', taskIgnoreQuery: '' },
        { taskArchivePath: '../outside.md', taskIgnoreQuery: '' },
      ),
    ).toMatchObject({ type: 'invalid', field: 'taskArchivePath' });
    expect(
      validateTaskStorageDraft(
        { taskArchivePath: 'archive.md', taskIgnoreQuery: '' },
        { taskArchivePath: 'new.md', taskIgnoreQuery: '(#broken' },
      ),
    ).toMatchObject({ type: 'invalid', field: 'taskIgnoreQuery' });
  });
});
