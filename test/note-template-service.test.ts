import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { CreatedNoteTemplateError, NoteTemplateService } from '../src/notes/NoteTemplateService';
import { createAppWithFiles, expectDefined, flushMicrotasks, useRealMoment } from './helpers';

useRealMoment();

function fileAt(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Expected ${path} to exist`);
  return file;
}

function installTemplater(
  app: App,
  readAndParse: (template: TFile, target: TFile) => Promise<string>,
): { readonly starts: string[]; readonly finishes: string[]; readonly pending: Set<string> } {
  const starts: string[] = [];
  const finishes: string[] = [];
  const pending = new Set<string>();
  Object.defineProperty(app, 'plugins', {
    configurable: true,
    value: {
      getPlugin: (id: string) =>
        id === 'templater-obsidian'
          ? {
              templater: {
                files_with_pending_templates: pending,
                start_templater_task(path: string) {
                  starts.push(path);
                  this.files_with_pending_templates.add(path);
                },
                async end_templater_task(path: string) {
                  finishes.push(path);
                  this.files_with_pending_templates.delete(path);
                },
                create_running_config(template: TFile, target: TFile) {
                  return { template_file: template, target_file: target, run_mode: 2 };
                },
                async read_and_parse_template(config: {
                  template_file: TFile;
                  target_file: TFile;
                }) {
                  return await readAndParse(config.template_file, config.target_file);
                },
              },
            }
          : null,
    },
  });
  return { starts, finishes, pending };
}

async function runDelayedAutoCreate(
  app: App,
  pending: ReadonlySet<string>,
  path: string,
  content: string,
): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile && !pending.has(path)) await app.vault.modify(file, content);
}

describe('NoteTemplateService', () => {
  it('recursively creates folders and applies raw substitutions once', async () => {
    const app = await createAppWithFiles({
      'templates/task.md': '# {{title}}\nDate: {{date}}\nTime: {{time}}\n',
    });
    const service = new NoteTemplateService(app);

    const file = await service.ensureNote(
      'tasks/2026/09/active.md',
      'templates/task.md',
      '2026-09-14',
    );

    expect(file.path).toBe('tasks/2026/09/active.md');
    const today = window.moment().format('YYYY-MM-DD');
    expect(await app.vault.cachedRead(file)).toMatch(
      new RegExp(`^# 2026-09-14\\nDate: ${today}\\nTime: \\d{2}:\\d{2}\\n$`, 'u'),
    );
  });

  it('uses the local date for raw date placeholders instead of the note filename', async () => {
    const app = await createAppWithFiles({
      'templates/task.md': 'Date: {{date}}\nTitle: {{title}}\n',
    });
    const service = new NoteTemplateService(app);

    const file = await service.ensureNote('tasks/active.md', 'templates/task.md', 'active');

    expect(await app.vault.cachedRead(file)).toMatch(/^Date: \d{4}-\d{2}-\d{2}\nTitle: active\n$/u);
  });

  it('preserves an existing note without reading or applying the selected template', async () => {
    const app = await createAppWithFiles({ 'tasks/active.md': 'keep me\n' });
    const read = vi.spyOn(app.vault, 'cachedRead');

    const file = await new NoteTemplateService(app).ensureNote(
      'tasks/active.md',
      'templates/missing.md',
      'Active',
    );

    expect(await app.vault.cachedRead(file)).toBe('keep me\n');
    expect(read.mock.calls.filter(([candidate]) => candidate.path.includes('templates/'))).toEqual(
      [],
    );
  });

  it('shares one in-flight creation across service instances for the same app and path', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '# {{title}}\n' });
    const create = vi.spyOn(app.vault, 'create');
    const first = new NoteTemplateService(app);
    const second = new NoteTemplateService(app);

    const [left, right] = await Promise.all([
      first.ensureNote('nested/tasks.md', 'templates/task.md', 'Tasks'),
      second.ensureNote('nested/tasks.md', 'templates/task.md', 'Tasks'),
    ]);

    expect(left).toBe(right);
    expect(create.mock.calls.filter(([path]) => path === 'nested/tasks.md')).toHaveLength(1);
    expect(await app.vault.cachedRead(left)).toBe('# Tasks\n');
  });

  it('rejects a missing selected template before creating the destination', async () => {
    const app = await createAppWithFiles({});

    await expect(
      new NoteTemplateService(app).ensureNote(
        'tasks/missing-template.md',
        'templates/missing.md',
        'Tasks',
      ),
    ).rejects.toThrow(/template/i);
    expect(app.vault.getAbstractFileByPath('tasks/missing-template.md')).toBeNull();
  });

  it('awaits observable Templater output and cleans up its pending lifecycle', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% title %>\n' });
    let release: ((content: string) => void) | undefined;
    const parsed = new Promise<string>((resolve) => {
      release = resolve;
    });
    const lifecycle = installTemplater(app, async () => await parsed);
    const pending = new NoteTemplateService(app).ensureNote(
      'tasks/templated.md',
      'templates/task.md',
      'Templated',
    );
    await flushMicrotasks();

    expect(lifecycle.starts).toEqual(['tasks/templated.md']);
    expect(app.vault.getAbstractFileByPath('tasks/templated.md')).toBeInstanceOf(TFile);
    expect(lifecycle.finishes).toEqual([]);
    expectDefined(release)('# rendered\n');

    const file = await pending;
    expect(await app.vault.cachedRead(file)).toBe('# rendered\n');
    expect(lifecycle.finishes).toEqual(['tasks/templated.md']);
  });

  it('keeps selected-template ownership through Templater delayed auto-create handling', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% title %>\n' });
    const lifecycle = installTemplater(app, async () => '# selected\n');
    const service = new NoteTemplateService(app);
    const creation = service.ensureNote('tasks/selected.md', 'templates/task.md', 'Selected');
    await flushMicrotasks();
    const autoCreate = runDelayedAutoCreate(
      app,
      lifecycle.pending,
      'tasks/selected.md',
      '# auto\n',
    );

    const file = await creation;
    await autoCreate;

    expect(await app.vault.cachedRead(file)).toBe('# selected\n');
  });

  it('keeps empty selected destinations out of Templater delayed auto-create handling after failure', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% broken %>\n' });
    const lifecycle = installTemplater(app, async () => {
      throw new Error('parse failed');
    });
    const service = new NoteTemplateService(app);
    const creation = service.ensureNote('tasks/failed.md', 'templates/task.md', 'Failed');
    await flushMicrotasks();
    const autoCreate = runDelayedAutoCreate(app, lifecycle.pending, 'tasks/failed.md', '# auto\n');

    await expect(creation).rejects.toBeInstanceOf(CreatedNoteTemplateError);
    await autoCreate;

    expect(await app.vault.cachedRead(fileAt(app, 'tasks/failed.md'))).toBe('');
  });

  it('keeps empty no-template destinations out of Templater delayed auto-create handling', async () => {
    const app = await createAppWithFiles({});
    const lifecycle = installTemplater(app, async () => '# unused\n');
    const service = new NoteTemplateService(app);
    const creation = service.ensureNote('tasks/empty.md', '', 'Empty');
    await flushMicrotasks();
    const autoCreate = runDelayedAutoCreate(app, lifecycle.pending, 'tasks/empty.md', '# auto\n');

    const file = await creation;
    await autoCreate;

    expect(await app.vault.cachedRead(file)).toBe('');
  });

  it('retains an owned failed path for retry and does not duplicate the file', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% broken %>\n' });
    let attempt = 0;
    installTemplater(app, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('parse failed');
      return '# recovered\n';
    });
    const create = vi.spyOn(app.vault, 'create');
    const service = new NoteTemplateService(app);

    const failure = await service
      .ensureNote('tasks/retry.md', 'templates/task.md', 'Retry')
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CreatedNoteTemplateError);
    expect((failure as CreatedNoteTemplateError).createdPath).toBe('tasks/retry.md');

    const file = await service.ensureNote('tasks/retry.md', 'templates/task.md', 'Retry');
    expect(await app.vault.cachedRead(file)).toBe('# recovered\n');
    expect(create.mock.calls.filter(([path]) => path === 'tasks/retry.md')).toHaveLength(1);
  });

  it('retains a raw-template failure as an owned path that can be retried', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '# {{title}}\n' });
    const process = vi.spyOn(app.vault, 'process').mockRejectedValueOnce(new Error('disk full'));
    const create = vi.spyOn(app.vault, 'create');
    const service = new NoteTemplateService(app);

    const failure = await service
      .ensureNote('tasks/retry-raw.md', 'templates/task.md', 'Retry raw')
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CreatedNoteTemplateError);
    expect((failure as CreatedNoteTemplateError).createdPath).toBe('tasks/retry-raw.md');
    const recovered = await service.ensureNote(
      'tasks/retry-raw.md',
      'templates/task.md',
      'Retry raw',
    );
    expect(await app.vault.cachedRead(recovered)).toBe('# Retry raw\n');
    expect(create.mock.calls.filter(([path]) => path === 'tasks/retry-raw.md')).toHaveLength(1);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('preserves external content written after a failed template attempt', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% broken %>\n' });
    installTemplater(app, async () => {
      throw new Error('parse failed');
    });
    const service = new NoteTemplateService(app);
    await expect(
      service.ensureNote('tasks/retry.md', 'templates/task.md', 'Retry'),
    ).rejects.toBeInstanceOf(CreatedNoteTemplateError);
    const owned = fileAt(app, 'tasks/retry.md');
    await app.vault.modify(owned, 'external recovery\n');

    const recovered = await service.ensureNote('tasks/retry.md', 'templates/task.md', 'Retry');

    expect(recovered).toBe(owned);
    expect(await app.vault.cachedRead(recovered)).toBe('external recovery\n');
  });

  it('blocks retry of unchanged partial Templater output and preserves later external recovery', async () => {
    const path = 'tasks/partial.md';
    const app = await createAppWithFiles({ 'templates/task.md': '<% partial %>\n' });
    let renders = 0;
    installTemplater(app, async () => {
      renders += 1;
      await app.vault.modify(fileAt(app, path), 'partly prepared\n');
      throw new Error('template failed after writing the target');
    });
    const service = new NoteTemplateService(app);

    await expect(service.ensureNote(path, 'templates/task.md', 'Partial')).rejects.toBeInstanceOf(
      CreatedNoteTemplateError,
    );
    await expect(service.ensureNote(path, 'templates/task.md', 'Partial')).rejects.toBeInstanceOf(
      CreatedNoteTemplateError,
    );

    expect(renders).toBe(1);
    expect(await app.vault.cachedRead(fileAt(app, path))).toBe('partly prepared\n');

    await app.vault.modify(fileAt(app, path), 'external recovery\n');
    const recovered = await service.ensureNote(path, 'templates/task.md', 'Partial');
    expect(recovered.path).toBe(path);
    expect(await app.vault.cachedRead(recovered)).toBe('external recovery\n');
    expect(renders).toBe(1);
  });

  it('keeps initial partial output blocked when the post-failure snapshot read rejects', async () => {
    const path = 'tasks/unread-partial.md';
    const app = await createAppWithFiles({ 'templates/task.md': '<% partial %>\n' });
    let renders = 0;
    installTemplater(app, async () => {
      renders += 1;
      await app.vault.modify(fileAt(app, path), 'partly prepared\n');
      throw new Error('template failed after writing the target');
    });
    vi.spyOn(app.vault, 'cachedRead').mockRejectedValueOnce(new Error('transient read failure'));
    const service = new NoteTemplateService(app);

    const first: unknown = await service
      .ensureNote(path, 'templates/task.md', 'Partial')
      .catch((error: unknown): unknown => error);
    const second: unknown = await service
      .ensureNote(path, 'templates/task.md', 'Partial')
      .catch((error: unknown): unknown => error);

    expect(first).toBeInstanceOf(CreatedNoteTemplateError);
    expect((first as CreatedNoteTemplateError).createdPath).toBe(path);
    expect(second).toBeInstanceOf(CreatedNoteTemplateError);
    expect(renders).toBe(1);
    expect(await app.vault.read(fileAt(app, path))).toBe('partly prepared\n');
  });

  it('releases unknown failure ownership after the target is deleted and freshly recreated', async () => {
    const path = 'tasks/recreated-after-unread-partial.md';
    const app = await createAppWithFiles({ 'templates/task.md': '<% partial %>\n' });
    installTemplater(app, async () => {
      await app.vault.modify(fileAt(app, path), 'partly prepared\n');
      throw new Error('template failed after writing the target');
    });
    vi.spyOn(app.vault, 'cachedRead').mockRejectedValueOnce(new Error('transient read failure'));
    const service = new NoteTemplateService(app);

    await expect(service.ensureNote(path, 'templates/task.md', 'Partial')).rejects.toBeInstanceOf(
      CreatedNoteTemplateError,
    );
    await expect(service.ensureNote(path, 'templates/task.md', 'Partial')).rejects.toBeInstanceOf(
      CreatedNoteTemplateError,
    );
    await app.fileManager.trashFile(fileAt(app, path));

    const recreated = await service.ensureNote(path, '', 'Fresh');
    await app.vault.modify(recreated, '- [ ] Captured after recreation\n');
    const retained = await service.ensureNote(path, '', 'Fresh');

    expect(retained).toBe(recreated);
    expect(await app.vault.read(retained)).toBe('- [ ] Captured after recreation\n');
  });

  it('keeps retry partial output blocked when its post-failure snapshot read rejects', async () => {
    const path = 'tasks/unread-retry-partial.md';
    const app = await createAppWithFiles({ 'templates/task.md': '<% partial %>\n' });
    let renders = 0;
    installTemplater(app, async () => {
      renders += 1;
      if (renders === 1) throw new Error('initial render failure');
      await app.vault.modify(fileAt(app, path), 'retry partly prepared\n');
      throw new Error('retry failed after writing the target');
    });
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let targetReads = 0;
    vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
      if (file.path === path && ++targetReads === 3) throw new Error('transient read failure');
      return await cachedRead(file);
    });
    const service = new NoteTemplateService(app);

    await expect(service.ensureNote(path, 'templates/task.md', 'Partial')).rejects.toBeInstanceOf(
      CreatedNoteTemplateError,
    );
    const retry: unknown = await service
      .ensureNote(path, 'templates/task.md', 'Partial')
      .catch((error: unknown): unknown => error);
    const blocked: unknown = await service
      .ensureNote(path, 'templates/task.md', 'Partial')
      .catch((error: unknown): unknown => error);

    expect(retry).toBeInstanceOf(CreatedNoteTemplateError);
    expect(blocked).toBeInstanceOf(CreatedNoteTemplateError);
    expect(renders).toBe(2);
    expect(await app.vault.read(fileAt(app, path))).toBe('retry partly prepared\n');
  });

  it('does not adopt or overwrite external content changed while a retry is rendering', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% broken %>\n' });
    let attempt = 0;
    let release: ((content: string) => void) | undefined;
    const rendered = new Promise<string>((resolve) => {
      release = resolve;
    });
    installTemplater(app, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('initial parse failed');
      return await rendered;
    });
    const service = new NoteTemplateService(app);
    await expect(
      service.ensureNote('tasks/retry-race.md', 'templates/task.md', 'Retry'),
    ).rejects.toBeInstanceOf(CreatedNoteTemplateError);

    const owned = fileAt(app, 'tasks/retry-race.md');
    const retry = service.ensureNote('tasks/retry-race.md', 'templates/task.md', 'Retry');
    await flushMicrotasks();
    await app.vault.modify(owned, 'external change\n');
    expectDefined(release)('# rendered\n');

    await expect(retry).rejects.toBeInstanceOf(CreatedNoteTemplateError);
    expect(await app.vault.cachedRead(owned)).toBe('external change\n');
    const recovered = await service.ensureNote('tasks/retry-race.md', 'templates/task.md', 'Retry');
    expect(recovered).toBe(owned);
    expect(await app.vault.cachedRead(recovered)).toBe('external change\n');
    expect(attempt).toBe(2);
  });

  it('reads Templater availability when each note preparation begins', async () => {
    const app = await createAppWithFiles({ 'templates/task.md': '<% title %>\n' });
    const service = new NoteTemplateService(app);
    installTemplater(app, async () => '# dynamic\n');

    const file = await service.ensureNote('tasks/dynamic.md', 'templates/task.md', 'Dynamic');

    expect(await app.vault.cachedRead(file)).toBe('# dynamic\n');
  });

  it('keeps project collision ownership with createNoteFromTemplate', async () => {
    const app = await createAppWithFiles({ 'Projects/Existing.md': '# existing\n' });

    await expect(
      new NoteTemplateService(app).createNoteFromTemplate('Projects/Existing.md', '', 'Existing'),
    ).rejects.toThrow();
    expect(await app.vault.cachedRead(fileAt(app, 'Projects/Existing.md'))).toBe('# existing\n');
  });
});
