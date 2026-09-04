import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  captureChangedCallback,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  seedTaskCache,
  useRealMoment,
} from './helpers';

useRealMoment();

describe('store test helpers', () => {
  it('createAppWithFiles returns an App with pre-populated files', async () => {
    const app = await createAppWithFiles({
      'a.md': '- [ ] task1',
      'sub/b.md': '- [x] done',
    });
    const files = app.vault.getMarkdownFiles();
    expect(files.map((f) => f.path).sort((a, b) => a.localeCompare(b))).toEqual([
      'a.md',
      'sub/b.md',
    ]);
    expect(files[0]).toBeInstanceOf(TFile);
  });

  it('seedTaskCache sets a cache with parent=-1 listItems and frontmatter', async () => {
    const app = await createAppWithFiles({ 'a.md': '- [ ] task1 📅 2026-06-24' });
    seedTaskCache(app, 'a.md', [{ task: ' ', parent: -1, line: 0 }], { color: '#abc' });
    const file = expectDefined(app.vault.getMarkdownFiles()[0]);
    const cache = app.metadataCache.getFileCache(file);
    expect(cache?.listItems).toHaveLength(1);
    expect(cache?.listItems?.[0]?.parent).toBe(-1);
    expect(cache?.listItems?.[0]?.task).toBe(' ');
    expect(cache?.frontmatter?.['color']).toBe('#abc');
  });

  it('captureChangedCallback captures the changed handler and lets it be invoked', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] x' });
    seedTaskCache(app, 't.md', [{ task: ' ', parent: -1, line: 0 }]);
    const fireChanged = captureChangedCallback(app);
    // register a no-op changed listener to exercise the capture
    app.metadataCache.on('changed', () => {});
    const file = app.vault.getAbstractFileByPath('t.md');
    // fireChanged should not throw; it invokes the captured handler
    expect(() => {
      if (!(file instanceof TFile)) throw new Error('not a TFile');
      fireChanged(file, '- [ ] x', { listItems: [] });
    }).not.toThrow();
  });

  it('flushMicrotasks awaits a short timeout', async () => {
    const start = Date.now();
    await flushMicrotasks(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
