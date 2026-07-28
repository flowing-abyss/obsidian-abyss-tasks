// test/tag-manager-files.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import { createAppWithFiles } from './helpers';

async function makeManager(files: Record<string, string> = {}) {
  const settings: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    pinnedTags: [...DEFAULT_SETTINGS.pinnedTags],
    archivedTags: [...DEFAULT_SETTINGS.archivedTags],
    tagGroups: DEFAULT_SETTINGS.tagGroups.map((group) => ({
      ...group,
      tags: group.tags ? [...group.tags] : undefined,
    })),
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const app = await createAppWithFiles(files);
  const tm = new TagManager(app, settings, save);
  return { tm, app, settings, save };
}

async function read(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string) {
  return app.vault.read(app.vault.getAbstractFileByPath(path) as never);
}

describe('TagManager exact and prefix vault rename', () => {
  it('exact rename changes complete tokens but leaves descendants and lookalikes byte-identical', async () => {
    const original =
      'front #work; child #work/dev; lookalike #workplace; hyphen #work-place\n#work\n';
    const { tm, app } = await makeManager({ 'notes/tasks.md': original });

    const result = await tm.renameTagExact('work', 'focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      'front #focus; child #work/dev; lookalike #workplace; hyphen #work-place\n#focus\n',
    );
  });

  it('prefix rename changes the root and descendants but not adjacent tag names', async () => {
    const original = '- [ ] #work #work/dev #work/dev/api #workplace #work-place\n';
    const { tm, app } = await makeManager({
      'notes/tasks.md': original,
      'notes/untouched.md': '- [ ] #personal\n',
    });

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      '- [ ] #focus #focus/dev #focus/dev/api #workplace #work-place\n',
    );
    expect(await read(app, 'notes/untouched.md')).toBe('- [ ] #personal\n');
  });

  it.each([
    ['', '#new'],
    ['#', '#new'],
    ['#work/', '#new'],
    ['#work//dev', '#new'],
    ['#work dev', '#new'],
    ['#work', '#new/'],
  ])('rejects invalid values without file or settings writes: %s → %s', async (oldTag, newTag) => {
    const { tm, app, save } = await makeManager({ 'notes/tasks.md': '- [ ] #work\n' });
    const process = vi.spyOn(app.vault, 'process');

    const exact = await tm.renameTagExact(oldTag, newTag);
    const prefix = await tm.renameTagPrefix(oldTag, newTag);

    expect(exact).toEqual({ type: 'invalid', reason: 'invalid-tag' });
    expect(prefix).toEqual({ type: 'invalid', reason: 'invalid-tag' });
    expect(process).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects normalized no-ops without file or settings writes', async () => {
    const { tm, app, save } = await makeManager({ 'notes/tasks.md': '- [ ] #work\n' });
    const process = vi.spyOn(app.vault, 'process');

    expect(await tm.renameTagExact('work', '#work')).toEqual({
      type: 'invalid',
      reason: 'same-tag',
    });
    expect(await tm.renameTagPrefix('#work', 'work')).toEqual({
      type: 'invalid',
      reason: 'same-tag',
    });
    expect(process).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('exact rename replaces every settings reference and deduplicates in stable order', async () => {
    const { tm, settings, save } = await makeManager();
    settings.pinnedTags.push('#work', '#keep', '#work', '#focus');
    settings.archivedTags.push('#work', '#focus', '#archive', '#work');
    settings.tagGroups.push({
      id: 'g1',
      name: 'Manual',
      mode: 'manual',
      tags: ['#work', '#other', '#work', '#focus'],
    });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: [] });
    expect(settings.pinnedTags).toEqual(['#focus', '#keep']);
    expect(settings.archivedTags).toEqual(['#focus', '#archive']);
    expect(settings.tagGroups[0]?.tags).toEqual(['#focus', '#other']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('prefix rename updates subtree settings references and the owning prefix selector', async () => {
    const { tm, settings } = await makeManager();
    settings.pinnedTags.push('#work', '#work/dev', '#workplace', '#focus/dev');
    settings.archivedTags.push('#work/ops', '#focus/ops');
    settings.tagGroups.push(
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      {
        id: 'manual',
        name: 'Manual',
        mode: 'manual',
        tags: ['#work', '#work/dev', '#workplace', '#focus/dev'],
      },
    );

    await tm.renameTagPrefix('work', 'focus');

    expect(settings.pinnedTags).toEqual(['#focus', '#focus/dev', '#workplace']);
    expect(settings.archivedTags).toEqual(['#focus/ops']);
    expect(settings.tagGroups[0]?.prefix).toBe('focus');
    expect(settings.tagGroups[1]?.tags).toEqual(['#focus', '#focus/dev', '#workplace']);
  });

  it('prepares every changed file before performing sequential writes', async () => {
    const { tm, app } = await makeManager({
      'a.md': '- [ ] #work\n',
      'b.md': '- [ ] #work/dev\n',
    });
    const events: string[] = [];
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
      events.push(`read:${file.path}`);
      return cachedRead(file);
    });
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      events.push(`write:${file.path}`);
      return process(file, callback);
    });

    await tm.renameTagPrefix('#work', '#focus');

    // The mock vault's process() performs its own internal read after each write begins.
    expect(events.slice(0, 3)).toEqual(['read:a.md', 'read:b.md', 'write:a.md']);
    expect(events.filter((event) => event.startsWith('write:'))).toEqual([
      'write:a.md',
      'write:b.md',
    ]);
  });

  it('applies a prepared rename to the latest content without losing unrelated edits', async () => {
    const { tm, app } = await makeManager({ 'a.md': '- [ ] #work\n' });
    vi.spyOn(app.vault, 'cachedRead').mockResolvedValue('- [ ] #work\n');
    let written = '';
    vi.spyOn(app.vault, 'process').mockImplementation(async (_file, callback) => {
      written = callback('unrelated edit\n- [ ] #work\n');
      return written;
    });

    await tm.renameTagExact('#work', '#focus');

    expect(written).toBe('unrelated edit\n- [ ] #focus\n');
  });

  it('returns partial and continues sequentially when a later file write fails', async () => {
    const { tm, app } = await makeManager({
      'a.md': '- [ ] #work\n',
      'b.md': '- [ ] #work\n',
      'c.md': '- [ ] #work\n',
    });
    const writes: string[] = [];
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      writes.push(file.path);
      if (file.path === 'b.md') throw new Error('disk full');
      return process(file, callback);
    });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({
      type: 'partial',
      changedFiles: ['a.md', 'c.md'],
      failedFiles: ['b.md'],
    });
    expect(writes).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await read(app, 'a.md')).toBe('- [ ] #focus\n');
    expect(await read(app, 'b.md')).toBe('- [ ] #work\n');
    expect(await read(app, 'c.md')).toBe('- [ ] #focus\n');
  });
});
