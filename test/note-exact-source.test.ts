import { TFile } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { exactSourceMetadata } from '../src/markdown/exactSourceMetadata';
import * as vaultText from '../src/markdown/readVaultText';
import { readVaultText } from '../src/markdown/readVaultText';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { createAppWithFiles, deferred, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness } from './support/publicApiHarness';

it.each(['\uFEFF---\r\naliases: [Ada]\r\n---\r\nContact\r\n', '\uFEFF- [ ] Root\n', '\uFEFF'])(
  'recovers host-normalized BOM text from exact native bytes %j',
  async (raw) => {
    const app = await createAppWithFiles({ 'a.md': raw });
    const file = app.vault.getAbstractFileByPath('a.md');
    if (!(file instanceof TFile)) throw new Error('Missing note');
    vi.spyOn(app.vault, 'read').mockResolvedValue(raw.slice(1));
    vi.spyOn(app.vault, 'cachedRead').mockResolvedValue(raw.slice(1));
    expect(await readVaultText(app.vault, file)).toBe(raw);
    expect(await readVaultText(app.vault, file, 'cached')).toBe(raw);
  },
);
it('keeps ordinary cached acquisition and rejection scheduling unchanged', async () => {
  const app = await createAppWithFiles({ 'a.md': 'Contact🙂\r\n' });
  const file = app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing note');
  const binary = vi.spyOn(app.vault, 'readBinary');
  const pending = deferred<string>();
  vi.spyOn(app.vault, 'cachedRead').mockReturnValueOnce(pending.promise);
  const reading = readVaultText(app.vault, file, 'cached');
  expect(binary).not.toHaveBeenCalled();
  pending.resolve('Contact🙂\r\n');
  expect(await reading).toBe('Contact🙂\r\n');
  expect(binary).not.toHaveBeenCalled();
});
it('rejects a native replacement while fallback bytes are pending', async () => {
  const app = await createAppWithFiles({ 'a.md': '\uFEFFContact\n', 'b.md': '\uFEFFContact\n' });
  const file = app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing note');
  vi.spyOn(app.vault, 'read').mockResolvedValue('Contact\n');
  const pending = deferred<ArrayBuffer>();
  vi.spyOn(app.vault, 'readBinary').mockReturnValue(pending.promise);
  const reading = readVaultText(app.vault, file);
  await Promise.resolve();
  const lookup = app.vault.getAbstractFileByPath.bind(app.vault),
    replacement = lookup('b.md');
  vi.spyOn(app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
    path === 'a.md' ? replacement : lookup(path),
  );
  pending.resolve(new TextEncoder().encode('\uFEFFContact\n').buffer);
  await expect(reading).rejects.toThrow();
});

it('accepts BOM-normalized metadata only after binding raw bytes and projects heading coordinates', async () => {
  const raw = '\uFEFF# Topic\r\nContact\r\n';
  const h = await publicApiHarness({ 'a.md': raw }, { initialize: false });
  try {
    const original = h.app.vault.read.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) =>
      (await original(file)).replace(/^\uFEFF/u, ''),
    );
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation(async (file) =>
      (await original(file)).replace(/^\uFEFF/u, ''),
    );
    await h.index.initialize();
    const file = h.app.vault.getAbstractFileByPath('a.md');
    if (!(file instanceof TFile)) throw new Error('Missing source');
    metadataChangedEmitter(h.app)(file, raw.slice(1), {
      headings: [
        {
          heading: 'Topic',
          level: 1,
          position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 7, offset: 7 } },
        },
      ],
    });
    await flushMicrotasks();
    const acquired = await h.index.projectSources().acquire('a.md');
    if (acquired.type !== 'ok' || acquired.value === undefined)
      throw new Error('Missing accepted source');
    expect(acquired.value.content).toBe(raw);
    expect(h.index.noteStructure(acquired.value)?.headings?.[0]?.position.start).toEqual({
      line: 0,
      col: 1,
      offset: 1,
    });
    expect(h.noteService.sections(acquired.value)).toContainEqual({
      from: 1,
      to: 10,
      kind: 'heading',
      label: 'Topic',
      editable: false,
    });
  } finally {
    h.dispose();
  }
});
it('never copies the document BOM into an added child prefix', () => {
  const editor = new TaskBlockEditor();
  const raw = '\uFEFF- [ ] Root\r\n';
  const block = editor.rootBlocks(raw)[0];
  if (block === undefined) throw new Error('Missing root');
  const result = editor.edit(
    raw,
    block,
    { relativeLine: 0, lineCount: 1, childRanges: [] },
    { type: 'add-subtask', text: 'Child' },
  );
  expect(result).toMatchObject({ type: 'changed' });
  if (result.type === 'changed') expect(result.content.match(/\uFEFF/gu)).toHaveLength(1);
});

it('refuses malformed projected coordinates and non-BOM normalization', () => {
  const cache = {
    headings: [
      {
        heading: 'Topic',
        level: 1,
        position: { start: { line: 0, col: 2, offset: 0 }, end: { line: 0, col: 7, offset: 7 } },
      },
    ],
  };
  expect(exactSourceMetadata('# Topic', '\uFEFF# Topic', cache)).toBeUndefined();
  expect(exactSourceMetadata('# Topic', ' # Topic', {})).toBeUndefined();
});
it('rejects invalid UTF-8 fallback rather than replacing undecodable bytes', async () => {
  const app = await createAppWithFiles({ 'a.md': 'x' });
  const file = app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing source');
  vi.spyOn(app.vault, 'read').mockResolvedValue('');
  vi.spyOn(app.vault, 'readBinary').mockResolvedValue(new Uint8Array([0xff]).buffer);
  await expect(readVaultText(app.vault, file)).rejects.toThrow();
});
it('rejects contrary text instead of adopting unrelated fallback bytes', async () => {
  const app = await createAppWithFiles({ 'a.md': 'Original' });
  const file = app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing source');
  vi.spyOn(app.vault, 'read').mockResolvedValue('Changed body');
  await expect(readVaultText(app.vault, file)).rejects.toThrow();
});
it('keeps native I/O rejection distinct from a refused reconciliation basis', async () => {
  const h = await publicApiHarness({ 'a.md': 'Contact' });
  try {
    const file = h.app.vault.getFileByPath('a.md');
    if (file === null) throw new Error('Missing source');
    const install = vi.fn();
    const failure = new Error('Native read failed');
    const read = vi.spyOn(h.app.vault, 'read').mockRejectedValueOnce(failure);
    await expect(h.index.reconcileCommittedSource('a.md', file, 'Contact', install)).rejects.toBe(
      failure,
    );
    expect(install).not.toHaveBeenCalled();
    read.mockResolvedValueOnce('Contrary source');
    await expect(h.index.reconcileCommittedSource('a.md', file, 'Contact', install)).resolves.toBe(
      false,
    );
    expect(install).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});
it('does not recover stale cached text against a competing committed basis', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] Original' }, { initialize: false });
  try {
    h.index.installCommittedContent('a.md', '- [ ] Original');
    vi.spyOn(h.app.vault, 'cachedRead').mockResolvedValue('stale cached text');
    const read = h.app.vault.read.bind(h.app.vault);
    const fresh = vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
      const content = await read(file);
      h.index.installCommittedContent('a.md', '- [ ] Competing');
      return content;
    });
    await h.index.initialize();
    expect(fresh).toHaveBeenCalledOnce();
    expect(h.index.list().map((task) => task.title)).toEqual(['Competing']);
  } finally {
    h.dispose();
  }
});
it('checks the original native identity after the reader helper has returned', async () => {
  const h = await publicApiHarness({ 'a.md': 'Contact', 'b.md': 'Contact' }, { initialize: false });
  try {
    const original = vaultText.readVaultText;
    const lookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault);
    vi.spyOn(vaultText, 'readVaultText').mockImplementation(async (vault, file, mode) => {
      const text = await original(vault, file, mode);
      if (file.path === 'a.md')
        queueMicrotask(() => {
          vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
            path === 'a.md' ? lookup('b.md') : lookup(path),
          );
        });
      return text;
    });
    await h.index.initialize();
    expect(h.index.projectSources().get('a.md')).not.toMatchObject({
      type: 'ok',
      value: { content: 'Contact' },
    });
  } finally {
    h.dispose();
  }
});
