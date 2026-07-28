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

  it('renames Unicode and emoji tags without matching adjacent Unicode or emoji tags', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#работа #работа/срочно #работает\n#work #work/dev #worké #work🚀\n',
    });

    const exact = await tm.renameTagExact('#работа', '#фокус');
    const prefix = await tm.renameTagPrefix('#work', '#focus');

    expect(exact).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(prefix).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      '#фокус #работа/срочно #работает\n#focus #focus/dev #worké #work🚀\n',
    );
  });

  it('accepts emoji inside old and new tag names', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#work🚀 #work🚀/next #work🚀er\n',
    });

    const result = await tm.renameTagPrefix('#work🚀', '#фокус✨');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#фокус✨ #фокус✨/next #work🚀er\n');
  });

  it('accepts flag-only tags and exact rename leaves a flag-suffixed adjacent tag untouched', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#🇺🇸 #travel #travel/dev #travel🇺🇸\n',
    });

    const flag = await tm.renameTagExact('#🇺🇸', '#🇨🇦');
    const exact = await tm.renameTagExact('#travel', '#trip');

    expect(flag).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(exact).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#🇨🇦 #trip #travel/dev #travel🇺🇸\n');
  });

  it('prefix rename leaves a flag-suffixed adjacent tag untouched', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#travel #travel/dev #travel🇺🇸\n',
    });

    const result = await tm.renameTagPrefix('#travel', '#trip');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#trip #trip/dev #travel🇺🇸\n');
  });

  it('exact rename updates semantic body and frontmatter tags while preserving literal examples', async () => {
    const original = [
      '---',
      'title: "#work remains literal"',
      'tags:',
      '  - work',
      '  - work/dev',
      '  - "work"',
      '  - other',
      'aliases: [work]',
      '---',
      'Prose #work and descendant #work/dev.',
      'Inline `#work` and escaped \\#work remain literal.',
      '```md',
      '#work',
      '```',
      '~~~',
      '#work',
      '~~~',
      '',
    ].join('\n');
    const expected = original
      .replace('  - work\n', '  - focus\n')
      .replace('  - "work"\n', '  - "focus"\n')
      .replace('Prose #work and descendant', 'Prose #focus and descendant');
    const { tm, app } = await makeManager({ 'notes/block.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/block.md'] });
    expect(await read(app, 'notes/block.md')).toBe(expected);
  });

  it('prefix rename updates block and flow frontmatter tag subtrees without touching other YAML', async () => {
    const blockOriginal = [
      '---',
      'tags:',
      '  - work',
      '  - work/dev',
      '  - workplace',
      'category: work',
      '---',
      'Non-task prose: #work #work/dev #workplace.',
      '',
    ].join('\n');
    const flowOriginal = [
      '---',
      'tags: [work, work/dev, "work/ops", workplace, other] # keep spacing',
      'aliases: [work/dev]',
      '---',
      'Text `#work/dev` and #work/dev.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({
      'notes/block.md': blockOriginal,
      'notes/flow.md': flowOriginal,
    });

    const result = await tm.renameTagPrefix('work', 'focus');

    expect(result).toEqual({
      type: 'ok',
      changedFiles: ['notes/block.md', 'notes/flow.md'],
    });
    expect(await read(app, 'notes/block.md')).toBe(
      blockOriginal
        .replace('  - work\n', '  - focus\n')
        .replace('  - work/dev\n', '  - focus/dev\n')
        .replace('#work #work/dev #workplace', '#focus #focus/dev #workplace'),
    );
    expect(await read(app, 'notes/flow.md')).toBe(
      flowOriginal
        .replace(
          '[work, work/dev, "work/ops", workplace, other]',
          '[focus, focus/dev, "focus/ops", workplace, other]',
        )
        .replace('and #work/dev.', 'and #focus/dev.'),
    );
  });

  it('exact rename handles indentless and commented block tags while preserving quoted fences', async () => {
    const original = [
      '---',
      'title: "keep every unrelated byte"',
      'tags:',
      '- work',
      '- work/dev',
      '- "work" # keep quoted comment',
      '- work   # keep spaced comment',
      '- workplace',
      'aliases: [work]',
      '---',
      '> ```md',
      '> #work',
      '> ```',
      'Outside #work and #work/dev.',
      '',
    ].join('\n');
    const expected = [
      '---',
      'title: "keep every unrelated byte"',
      'tags:',
      '- focus',
      '- work/dev',
      '- "focus" # keep quoted comment',
      '- focus   # keep spaced comment',
      '- workplace',
      'aliases: [work]',
      '---',
      '> ```md',
      '> #work',
      '> ```',
      'Outside #focus and #work/dev.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/exact.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/exact.md'] });
    expect(await read(app, 'notes/exact.md')).toBe(expected);
  });

  it('prefix rename handles multiline flow tags while preserving blockquote fenced literals', async () => {
    const original = [
      '---',
      'tags: [',
      '  work,',
      '  "work/dev",',
      '  workplace,',
      '  other',
      '] # keep flow layout',
      'category: work',
      '---',
      '> ~~~md',
      '> #work/dev',
      '> ~~~',
      'Outside #work/dev and #workplace.',
      '',
    ].join('\n');
    const expected = [
      '---',
      'tags: [',
      '  focus,',
      '  "focus/dev",',
      '  workplace,',
      '  other',
      '] # keep flow layout',
      'category: work',
      '---',
      '> ~~~md',
      '> #work/dev',
      '> ~~~',
      'Outside #focus/dev and #workplace.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/prefix.md': original });

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/prefix.md'] });
    expect(await read(app, 'notes/prefix.md')).toBe(expected);
  });

  it.each([
    ['', '#new'],
    ['#', '#new'],
    ['#1984', '#new'],
    ['#work', '#1984'],
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

  it('returns a settings failure and rolls back in-memory references when persistence rejects', async () => {
    const { tm, app, settings, save } = await makeManager({
      'tasks.md': '- [ ] #work\n',
    });
    settings.pinnedTags = ['#work'];
    settings.archivedTags = ['#work/dev'];
    settings.tagGroups = [
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#work', '#work/dev'] },
    ];
    save.mockRejectedValueOnce(new Error('settings storage unavailable'));

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({
      type: 'settings-error',
      changedFiles: ['tasks.md'],
      failedFiles: [],
    });
    expect(await read(app, 'tasks.md')).toBe('- [ ] #focus\n');
    expect(settings.pinnedTags).toEqual(['#work']);
    expect(settings.archivedTags).toEqual(['#work/dev']);
    expect(settings.tagGroups).toEqual([
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#work', '#work/dev'] },
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not let an older rejected rename save clobber newer successfully saved settings', async () => {
    const { tm, settings, save } = await makeManager();
    settings.pinnedTags = ['#work'];
    settings.tagGroups = [{ id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' }];
    let rejectFirst!: (error: Error) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    save
      .mockImplementationOnce(() => {
        markFirstStarted();
        return firstSave;
      })
      .mockResolvedValueOnce(undefined);

    const rename = tm.renameTagPrefix('#work', '#focus');
    await firstStarted;
    settings.tagGroups[0]!.name = 'Newer name';
    await tm.pinTag('#later');
    rejectFirst(new Error('older save rejected'));

    await expect(rename).resolves.toEqual({
      type: 'settings-error',
      changedFiles: [],
      failedFiles: [],
    });
    expect(settings.pinnedTags).toEqual(['#focus', '#later']);
    expect(settings.tagGroups).toEqual([
      { id: 'prefix', name: 'Newer name', mode: 'prefix', prefix: 'focus' },
    ]);
    expect(save).toHaveBeenCalledTimes(2);
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

  it('serializes concurrent rename requests for the same vault', async () => {
    const { tm, app } = await makeManager({ 'a.md': '#one #two\n' });
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let readCount = 0;
    vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
      readCount++;
      if (readCount === 1) await firstRead;
      return cachedRead(file);
    });

    const first = tm.renameTagExact('#one', '#first');
    const second = tm.renameTagExact('#two', '#second');
    await Promise.resolve();
    await Promise.resolve();

    expect(readCount).toBe(1);
    releaseFirst();
    await expect(first).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    await expect(second).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    expect(await read(app, 'a.md')).toBe('#first #second\n');
  });

  it('releases the rename queue after an unexpected operation error', async () => {
    const { tm, app } = await makeManager({ 'a.md': '#two\n' });
    const getMarkdownFiles = app.vault.getMarkdownFiles.bind(app.vault);
    vi.spyOn(app.vault, 'getMarkdownFiles')
      .mockImplementationOnce(() => {
        throw new Error('vault unavailable');
      })
      .mockImplementation(() => getMarkdownFiles());

    const first = tm.renameTagExact('#one', '#first');
    const second = tm.renameTagExact('#two', '#second');

    await expect(first).rejects.toThrow('vault unavailable');
    await expect(second).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    expect(await read(app, 'a.md')).toBe('#second\n');
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
