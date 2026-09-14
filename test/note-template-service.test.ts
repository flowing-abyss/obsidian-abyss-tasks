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
): { readonly starts: string[]; readonly finishes: string[] } {
  const starts: string[] = [];
  const finishes: string[] = [];
  Object.defineProperty(app, 'plugins', {
    configurable: true,
    value: {
      getPlugin: (id: string) =>
        id === 'templater-obsidian'
          ? {
              templater: {
                files_with_pending_templates: new Set<string>(),
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
  return { starts, finishes };
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
    expect(await app.vault.cachedRead(file)).toMatch(
      /^# 2026-09-14\nDate: 2026-09-14\nTime: \d{2}:\d{2}\n$/u,
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
    const modify = vi.spyOn(app.vault, 'modify').mockRejectedValueOnce(new Error('disk full'));
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
    expect(modify).toHaveBeenCalledTimes(2);
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

  it('keeps project collision ownership with createNoteFromTemplate', async () => {
    const app = await createAppWithFiles({ 'Projects/Existing.md': '# existing\n' });

    await expect(
      new NoteTemplateService(app).createNoteFromTemplate('Projects/Existing.md', '', 'Existing'),
    ).rejects.toThrow();
    expect(await app.vault.cachedRead(fileAt(app, 'Projects/Existing.md'))).toBe('# existing\n');
  });
});
