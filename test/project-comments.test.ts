import { TFile, type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ProjectCommandService } from '../src/projects/ProjectCommandService';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { clockFrom } from '../src/tasks/domain/clock';
import { createAppWithFiles, flushMicrotasks, queryApiForTasks, useRealMoment } from './helpers';

useRealMoment();

function fileAt(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`${path} is not a file`);
  return file;
}

function commentField(app: App, file: TFile): unknown {
  return (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown>)['comments'];
}

describe('Project comments', () => {
  it('projects Atom and legacy-day comments and keeps malformed source diagnostics read-only', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': [
        '---',
        'comments:',
        '  - "2026-08-11T16:32:10+07:00: instant body"',
        '  - "2026-08-10: day body"',
        '  - "2026-99-10: malformed body"',
        '  - ordinary body',
        '---',
      ].join('\n'),
    });
    const store = new ProjectStore(app, queryApiForTasks(() => []) as never, DEFAULT_SETTINGS);
    store.initialize();

    expect(store.get('Projects/A.md')).toMatchObject({
      comments: [
        { kind: 'timestamp', text: 'instant body', timestamp: { precision: 'instant' } },
        { kind: 'timestamp', text: 'day body', timestamp: { precision: 'day' } },
        { kind: 'malformed', raw: '2026-99-10: malformed body' },
        { kind: 'undated', text: 'ordinary body' },
      ],
      metadataDiagnostics: [{ field: 'comments', issue: 'malformed', index: 2 }],
    });
    store.destroy();
  });

  it('appends normalized comment text at the injected Atom instant without rewriting prior entries', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ncomments:\n  - "2026-08-10: prior"\nunknown: keep\n---\n\nBody\n',
    });
    const file = fileAt(app, 'Projects/A.md');
    const service = new ProjectCommandService(
      app,
      () => [],
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 420),
    );

    expect(
      await service.appendComment(
        { path: file.path, value: ['2026-08-10: prior'] },
        'first\r\nsecond',
      ),
    ).toMatchObject({ type: 'ok', comment: { raw: '2026-08-11T16:32:10+07:00: first\nsecond' } });
    await flushMicrotasks();
    expect(commentField(app, file)).toEqual([
      '2026-08-10: prior',
      '2026-08-11T16:32:10+07:00: first\nsecond',
    ]);
    const content = await app.vault.read(file);
    expect(content).toContain('unknown: keep');
    expect(content).toContain('Body');
  });

  it('rejects a concurrent whole-comments-field change and preserves the draft', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\ncomments:\n  - old\n---\n' });
    const file = fileAt(app, 'Projects/A.md');
    const service = new ProjectCommandService(app, () => [], clockFrom(0, 0));
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['comments'] = ['external'];
    });

    expect(await service.appendComment({ path: file.path, value: ['old'] }, 'draft')).toEqual({
      type: 'conflict',
      current: ['external'],
    });
    await flushMicrotasks();
    expect(commentField(app, file)).toEqual(['external']);
  });

  it('refuses to normalize non-string or non-list comments fields', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ncomments:\n  - retained\n  - nested: value\n---\n',
      'Projects/B.md': '---\ncomments: retained\n---\n',
    });
    const service = new ProjectCommandService(app, () => [], clockFrom(0, 0));

    expect(
      await service.appendComment(
        { path: 'Projects/A.md', value: ['retained', { nested: 'value' }] },
        'draft',
      ),
    ).toEqual({ type: 'unsupported', field: 'comments' });
    expect(
      await service.appendComment({ path: 'Projects/B.md', value: 'retained' }, 'draft'),
    ).toEqual({
      type: 'unsupported',
      field: 'comments',
    });
  });

  it('surfaces mixed and non-list comments as read-only while retaining their raw structures', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ncomments:\n  - retained\n  - nested: value\n---\n',
      'Projects/B.md': '---\ncomments: retained\n---\n',
    });
    const store = new ProjectStore(app, queryApiForTasks(() => []) as never, DEFAULT_SETTINGS);
    store.initialize();

    expect(store.get('Projects/A.md')).toMatchObject({
      comments: [],
      observed: { comments: ['retained', { nested: 'value' }] },
      metadataDiagnostics: [{ field: 'comments', issue: 'unsupported' }],
    });
    expect(store.get('Projects/B.md')).toMatchObject({
      comments: [],
      observed: { comments: 'retained' },
      metadataDiagnostics: [{ field: 'comments', issue: 'unsupported' }],
    });
    store.destroy();
  });

  it('re-observes its own append without a false external conflict', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\ncomments: []\n---\n' });
    const file = fileAt(app, 'Projects/A.md');
    const store = new ProjectStore(app, queryApiForTasks(() => []) as never, DEFAULT_SETTINGS);
    store.initialize();
    const service = new ProjectCommandService(app, () => [], clockFrom(0, 0));

    const first = store.get(file.path)!;
    await service.appendComment(service.observeComments(first), 'first');
    await flushMicrotasks();
    store.refresh();
    const second = store.get(file.path)!;

    expect(await service.appendComment(service.observeComments(second), 'second')).toMatchObject({
      type: 'ok',
      comment: { text: 'second' },
    });
    store.destroy();
  });
});
