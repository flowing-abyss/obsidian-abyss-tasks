import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { runTaskFileMutation } from '../../src/tasks/infrastructure/obsidian/taskFileMutationQueue';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, expectDefined } from '../helpers';

const pattern = 'tasks/{{DATE:YYYY-MM-DD}}.md';
const historical = 'tasks/2020-02-29.md';
const source = '- [ ] task\n';
async function harness(
  content = source,
  path = historical,
  policy: string | undefined = pattern,
  useAuthority = false,
) {
  const app = await createAppWithFiles({ [path]: content, 'personal.md': source });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const editor = new TaskBlockEditor();
  const authority = useAuthority ? new TaskRefAuthority('cleanup-test') : undefined;
  const locator = new TaskLocator(authority);
  const authorityOptions = authority === undefined ? {} : { refAuthority: authority };
  const index = new TaskIndex(app, { statusCatalog, ...authorityOptions });
  const diagnostics = vi.fn();
  const install = vi.fn((filePath: string, text: string) =>
    index.snapshotsFromContent(filePath, text),
  );
  let configured = policy;
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor,
    locator,
    snapshotsFromContent: (filePath, text) => index.snapshotsFromContent(filePath, text),
    ...authorityOptions,
    snapshotState: useAuthority
      ? index
      : {
          currentRoot: () => undefined,
          previewContent: (filePath, text) => index.snapshotsFromContent(filePath, text),
          installCommittedContent: install,
        },
    configuredTaskNotePath: () => configured,
    diagnostics,
  });
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('missing fixture');
  const block = expectDefined(editor.rootBlocks(content)[0]);
  const ref = { filePath: path, line: block.line, revision: locator.revision(block.source) };
  const hostTrash = app.fileManager.trashFile.bind(app.fileManager);
  const trashFile = vi.spyOn(app.fileManager, 'trashFile');
  return {
    app,
    repository,
    ref,
    file,
    trashFile,
    diagnostics,
    install,
    hostTrash,
    index,
    statusCatalog,
    policy: (value: string) => {
      configured = value;
    },
    remove: () => repository.edit({ type: 'delete', ref }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('explicit deletion cleanup of configured task notes', () => {
  it.each([
    [historical, pattern, source],
    [historical, pattern, `${source}  - [ ] child\n  - > description\n`],
    ['tasks.md', 'tasks.md', source],
    ['Tasks.MD', 'tasks.md', source],
    [historical, pattern, `---\nkind: task\n---\n\n${source}`],
    [historical, pattern, '\uFEFF---\r\nkind: task\r\n---\r\n\r\n- [ ] task\r\n'],
  ])('removes the exact empty note %s matching %s', async (path, policy, content) => {
    const h = await harness(content, path, policy);
    expect(await h.remove()).toMatchObject({
      type: 'committed',
      changed: true,
      outcome: { type: 'deleted' },
    });
    expect(h.trashFile).toHaveBeenCalledOnce();
    expect(h.trashFile).toHaveBeenCalledWith(h.file);
    expect(h.app.vault.getAbstractFileByPath(path)).toBeNull();
    expect(h.app.vault.getAbstractFileByPath('personal.md')).toBeInstanceOf(TFile);
    expect(h.diagnostics).not.toHaveBeenCalled();
  });

  it.each([
    ['tasks/other.md', pattern, source],
    ['personal.md', pattern, source],
    [historical, 'new/{{DATE:YYYY-MM-DD}}.md', source],
    [historical, 'tasks/{{DATE:bad}}.md', source],
    ['tasks/2025-02-29.md', pattern, source],
    [historical, '', source],
    [historical, pattern, `# Heading\n${source}`],
    [historical, pattern, `<!-- comment -->\n${source}`],
    [historical, pattern, `\`\`\`\ntext\n\`\`\`\n${source}`],
    [historical, pattern, `Template text\n${source}`],
    [historical, pattern, `[[link]]\n${source}`],
    [historical, pattern, `- \n${source}`],
    [historical, pattern, `---\nkey: [broken\n---\n${source}`],
    [historical, pattern, `---\n- scalar\n---\n${source}`],
    [historical, pattern, `${source}- [ ] remaining\n`],
  ])(
    'preserves content or paths without authority: %s / %s / %s',
    async (path, policy, content) => {
      const h = await harness(content, path, policy);
      await h.remove();
      expect(h.trashFile).not.toHaveBeenCalled();
      expect(h.app.vault.getAbstractFileByPath(path)).toBe(h.file);
      expect(h.diagnostics).not.toHaveBeenCalled();
    },
  );

  it.each(['body', 'frontmatter', 'policy', 'rename', 'replacement'] as const)(
    'preserves a note changed during fresh proof: %s',
    async (change) => {
      const h = await harness(`---\nkind: task\n---\n${source}`);
      const read = h.app.vault.read.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
        const content = await read(file);
        if (change === 'body') return `${content}New text`;
        if (change === 'frontmatter') return content.replace('task', 'personal');
        if (change === 'policy') h.policy('other.md');
        if (change === 'rename') await h.app.vault.rename(h.file, 'renamed.md');
        if (change === 'replacement') {
          await h.hostTrash(h.file);
          await h.app.vault.create(historical, content);
        }
        return content;
      });
      expect(await h.remove()).toMatchObject({ type: 'committed', changed: true });
      expect(h.trashFile).not.toHaveBeenCalled();
    },
  );

  it.each(['read-failed', 'removal-unconfirmed'] as const)(
    'keeps committed deletion on %s',
    async (cause) => {
      const h = await harness();
      if (cause === 'read-failed')
        vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('secret note text'));
      else h.trashFile.mockRejectedValue(new Error('secret note text'));
      expect(await h.remove()).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'deleted',
          noteCleanupWarning: { path: historical, cause },
        },
      });
      expect(h.diagnostics).toHaveBeenCalledExactlyOnceWith({
        operation: 'delete',
        phase: 'empty-note-cleanup',
        path: historical,
        cause,
      });
      expect(JSON.stringify(h.diagnostics.mock.calls)).not.toContain('secret');
    },
  );

  it('does not clean up after completion deletes a task', async () => {
    const h = await harness('- [ ] task 🏁 delete\n');
    await h.repository.edit({
      type: 'set-status',
      target: { type: 'task', ref: h.ref },
      symbol: 'x',
    });
    expect(h.trashFile).not.toHaveBeenCalled();
  });

  it('does not clean up a rejected root write', async () => {
    const h = await harness();
    vi.spyOn(h.app.vault, 'process').mockRejectedValue(new Error('write failure'));
    expect(await h.remove()).toMatchObject({ type: 'io-error' });
    expect(h.trashFile).not.toHaveBeenCalled();
  });

  it('holds same-path creation behind cleanup, then rejects the removed identity', async () => {
    const h = await harness();
    const entered = deferred();
    const release = deferred();
    const read = h.app.vault.read.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
      entered.resolve();
      await release.promise;
      return read(file);
    });
    const removing = h.remove();
    await entered.promise;
    const process = vi.spyOn(h.app.vault, 'process');
    const creating = h.repository.create(
      { filePath: historical, insertion: { type: 'append' } },
      { markdownBody: 'new task' },
    );
    await Promise.resolve();
    expect(process).not.toHaveBeenCalled();
    release.resolve();
    await removing;
    expect(await creating).toMatchObject({ type: 'io-error' });
    expect(process).not.toHaveBeenCalled();
  });

  it('preserves an earlier committed creation', async () => {
    const h = await harness();
    await h.repository.create(
      { filePath: historical, insertion: { type: 'append' } },
      { markdownBody: 'new task' },
    );
    await h.remove();
    expect(h.trashFile).not.toHaveBeenCalled();
    expect(await h.app.vault.read(h.file)).toContain('new task');
  });
});

it('publishes committed task deletion before trash and never after removal', async () => {
  const h = await harness();
  h.trashFile.mockImplementation(async (file) => {
    expect(h.install).toHaveBeenCalledExactlyOnceWith(historical, '');
    await h.hostTrash(file);
  });
  await h.remove();
  expect(h.install).toHaveBeenCalledOnce();
});

it('does not report confirmed cleanup when the host leaves the same file present', async () => {
  const h = await harness();
  h.trashFile.mockResolvedValue();
  expect(await h.remove()).toMatchObject({
    type: 'committed',
    changed: true,
    outcome: { noteCleanupWarning: { cause: 'removal-unconfirmed' } },
  });
});

it('does not roll back task success if the host removes the note then rejects', async () => {
  const h = await harness();
  h.trashFile.mockImplementation(async (file) => {
    await h.hostTrash(file);
    throw new Error('uncertain response');
  });
  expect(await h.remove()).toMatchObject({
    type: 'committed',
    changed: true,
    outcome: { noteCleanupWarning: { cause: 'removal-unconfirmed' } },
  });
  expect(h.app.vault.getAbstractFileByPath(historical)).toBeNull();
});

it('releases a rejected write so later creation can proceed', async () => {
  const h = await harness();
  vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('failure'));
  await h.remove();
  expect(
    await h.repository.create(
      { filePath: historical, insertion: { type: 'append' } },
      { markdownBody: 'next' },
    ),
  ).toMatchObject({ type: 'committed' });
  expect(await h.app.vault.read(h.file)).toContain('next');
});

it('queues a move destination behind cleanup without removing its source', async () => {
  const h = await harness();
  const entered = deferred();
  const release = deferred();
  const read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    if (file === h.file) {
      entered.resolve();
      await release.promise;
    }
    return read(file);
  });
  const removing = h.remove();
  await entered.promise;
  const moving = h.repository.move(
    { ...h.ref, filePath: 'personal.md' },
    { filePath: historical, insertion: { type: 'append' } },
  );
  await Promise.resolve();
  release.resolve();
  await removing;
  expect(await moving).not.toMatchObject({ type: 'committed' });
  const personal = h.app.vault.getAbstractFileByPath('personal.md');
  if (!(personal instanceof TFile)) throw new Error('missing personal note');
  expect(await read(personal)).toBe(source);
});

it('orders one App/path while independent paths and Apps can progress', async () => {
  const h = await harness();
  const other = await harness();
  const release = deferred();
  const events: string[] = [];
  const first = runTaskFileMutation(h.app, historical, async () => {
    events.push('first');
    await release.promise;
  });
  const next = runTaskFileMutation(h.app, historical, async () => {
    events.push('next');
  });
  await Promise.all([
    runTaskFileMutation(h.app, 'other.md', async () => {
      events.push('path');
    }),
    runTaskFileMutation(other.app, historical, async () => {
      events.push('app');
    }),
  ]);
  expect(events).toEqual(['first', 'path', 'app']);
  release.resolve();
  await Promise.all([first, next]);
  expect(events).toEqual(['first', 'path', 'app', 'next']);
});

it('publishes creation before a queued deletion starts its source proof', async () => {
  const h = await harness();
  const process = h.app.vault.process.bind(h.app.vault);
  const events: string[] = [];
  let removal: Promise<unknown> | undefined;
  let first = true;
  h.install.mockImplementation((_path, content) => {
    events.push(
      content.includes('new task') && content.includes('task\n')
        ? 'create-published'
        : 'delete-published',
    );
    return [];
  });
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
    if (first) {
      first = false;
      removal = h.remove();
    } else {
      events.push('delete-proof');
    }
    return process(file, transform);
  });
  await h.repository.create(
    { filePath: historical, insertion: { type: 'append' } },
    { markdownBody: 'new task' },
  );
  await removal;
  expect(events.indexOf('create-published')).toBeLessThan(events.indexOf('delete-proof'));
});

it('returns public ok/deleted/changed through the application after removing the note', async () => {
  const h = await harness(source, historical, pattern, true);
  await h.index.initialize();
  const task = expectDefined(h.index.list().find((entry) => entry.ref.filePath === historical));
  const application = new TaskApplicationService(h.index, h.repository, h.statusCatalog, {
    today: () => localDate('2026-10-15'),
  });
  expect(await application.execute({ type: 'delete', ref: task.ref })).toMatchObject({
    type: 'ok',
    changed: true,
    outcome: { type: 'deleted' },
  });
  expect(h.trashFile).toHaveBeenCalledExactlyOnceWith(h.file);
  h.index.destroy();
});

it.each(['stale', 'missing', 'ambiguous', 'skipped'] as const)(
  'preserves after %s root deletion',
  async (failure) => {
    const h = await harness();
    if (failure === 'stale') await h.app.vault.modify(h.file, '- [ ] changed task');
    if (failure === 'missing') await h.app.vault.modify(h.file, 'ordinary text');
    if (failure === 'ambiguous') await h.app.vault.modify(h.file, `prefix\n${source}${source}`);
    if (failure === 'skipped') vi.spyOn(h.app.vault, 'process').mockResolvedValue(source);
    expect(await h.remove()).not.toMatchObject({ type: 'committed', changed: true });
    expect(h.trashFile).not.toHaveBeenCalled();
  },
);

it.each(['move', 'archive'] as const)(
  'preserves the source note after %s removes its last task',
  async (operation) => {
    const h = await harness();
    expect(
      await h.repository[operation](h.ref, {
        filePath: 'personal.md',
        insertion: { type: 'append' },
      }),
    ).toMatchObject({ type: 'committed' });
    expect(await h.app.vault.read(h.file)).toBe('');
    expect(h.trashFile).not.toHaveBeenCalled();
  },
);

it('preserves task success when diagnostic reporting fails', async () => {
  const h = await harness();
  h.trashFile.mockRejectedValue(new Error('host failure'));
  h.diagnostics.mockImplementation(() => {
    throw new Error('diagnostic failure');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await h.remove()).toMatchObject({
    type: 'committed',
    changed: true,
    outcome: { noteCleanupWarning: { cause: 'removal-unconfirmed' } },
  });
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});

it('silently skips a note that disappears during the fresh read', async () => {
  const h = await harness();
  vi.spyOn(h.app.vault, 'read').mockImplementation(async () => {
    await h.hostTrash(h.file);
    throw new Error('file disappeared');
  });
  const result = await h.remove();
  expect(result).toMatchObject({ type: 'committed', changed: true, outcome: { type: 'deleted' } });
  expect(result).not.toHaveProperty('outcome.noteCleanupWarning');
  expect(h.trashFile).not.toHaveBeenCalled();
  expect(h.diagnostics).not.toHaveBeenCalled();
});

it('keeps the note after explicit subtask deletion', async () => {
  const content = '- [ ] parent\n  - [ ] child\n';
  const h = await harness(content);
  const task = expectDefined(h.index.snapshotsFromContent(historical, content)[0]);
  const child = expectDefined(task.subtasks[0]);
  const ref = { ...child.ref, parent: { type: 'task' as const, ref: h.ref } };
  expect(await h.repository.edit({ type: 'delete-subtask', subtask: ref })).toMatchObject({
    type: 'committed',
    changed: true,
  });
  expect(h.trashFile).not.toHaveBeenCalled();
  expect(await h.app.vault.read(h.file)).toContain('parent');
});

it('preserves unclosed frontmatter encountered before deletion', async () => {
  const h = await harness();
  const content = `---\nkind: task\n${source}`;
  await h.app.vault.modify(h.file, content);
  expect(await h.remove()).not.toMatchObject({ type: 'committed', changed: true });
  expect(await h.app.vault.read(h.file)).toBe(content);
  expect(h.trashFile).not.toHaveBeenCalled();
});
