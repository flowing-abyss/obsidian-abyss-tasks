import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { configuredTaskApplication, createAppWithFiles, expectDefined } from './helpers';

// Metadata expectations were checked with Obsidian in dev-vault-tasks. Keep the package's
// parser active: replacing this cache would hide the quoted-list failure from mocks 7.2.2/7.2.3.
describe('task application with package-generated Obsidian metadata', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('completes a task containing a quoted ordered list with %s endings', async (_, newline) => {
    const path = 'quoted-list.md';
    const content = ['- [ ] Root', '  - > 1. first', '- [ ] Other', ''].join(newline);
    const app = await createAppWithFiles({ [path]: content });
    const file = expectDefined(app.vault.getFileByPath(path));
    const cache = expectDefined(app.metadataCache.getFileCache(file));

    expect(
      cache.listItems?.map(({ position, parent, task }) => [
        position.start.line,
        position.start.col,
        parent,
        task ?? null,
      ]),
    ).toEqual([
      [0, 0, -1, ' '],
      [1, 2, 0, null],
      [1, 6, -1, null],
      [2, 0, -1, ' '],
    ]);

    const stack = configuredTaskApplication(app, {
      ...DEFAULT_SETTINGS,
      taskLifecycle: { ...DEFAULT_SETTINGS.taskLifecycle, addCompletionDate: false },
    });
    try {
      await stack.index.initialize();
      expect(stack.tasks.queries.list().map((task) => task.title)).toEqual(['Root', 'Other']);
      const root = expectDefined(stack.tasks.queries.list()[0]);

      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: root.ref },
      });

      expect(result.type).toBe('ok');
      expect(await app.vault.read(file)).toBe(
        ['- [x] Root', '  - > 1. first', '- [ ] Other', ''].join(newline),
      );
      expect(stack.tasks.queries.list().map((task) => [task.title, task.status])).toEqual([
        ['Root', 'done'],
        ['Other', 'open'],
      ]);
    } finally {
      stack.index.destroy();
    }
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('discovers a task after tab-separated quote levels with %s endings', async (_, newline) => {
    const path = 'tab-quote.md';
    const app = await createAppWithFiles({
      [path]: ['>\t> 1. first', '', '- [ ] Real', ''].join(newline),
    });
    const file = expectDefined(app.vault.getFileByPath(path));
    const cache = expectDefined(app.metadataCache.getFileCache(file));
    expect(
      cache.listItems
        ?.filter((item) => item.task !== undefined)
        .map((item) => item.position.start.line),
    ).toEqual([2]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    try {
      await stack.index.initialize();
      expect(stack.tasks.queries.list().map((task) => [task.title, task.source.line])).toEqual([
        ['Real', 2],
      ]);
    } finally {
      stack.index.destroy();
    }
  });

  it('reads nested CRLF tasks after a fence without synthetic cache positions', async () => {
    const path = 'crlf-fence.md';
    const app = await createAppWithFiles({
      [path]: '```md\r\n- [ ] example\r\n```\r\n> - [ ] Real\r\n>   - [ ] Child\r\n',
    });
    const file = expectDefined(app.vault.getFileByPath(path));
    const cache = expectDefined(app.metadataCache.getFileCache(file));
    expect(
      cache.listItems?.map(({ position, parent, task }) => [position.start, parent, task]),
    ).toEqual([
      [{ line: 3, col: 2, offset: 29 }, -3, ' '],
      [{ line: 4, col: 4, offset: 45 }, 3, ' '],
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    try {
      await stack.index.initialize();
      expect(stack.tasks.queries.list()).toHaveLength(1);
      expect(stack.tasks.queries.list()[0]).toMatchObject({
        title: 'Real',
        source: { line: 3 },
        subtasks: [{ title: 'Child', ref: { relativeLine: 1 } }],
      });
    } finally {
      stack.index.destroy();
    }
  });
});
