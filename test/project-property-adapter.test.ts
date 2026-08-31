import { App, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ProjectPropertyAdapter } from '../src/projects/properties/ProjectPropertyAdapter';
import { ProjectPropertyCommands } from '../src/projects/properties/ProjectPropertyCommands';

describe('ProjectPropertyAdapter', () => {
  it('infers safe editable property kinds and preserves unsupported values', () => {
    const adapter = new ProjectPropertyAdapter();
    expect(adapter.describe('start', '2026-08-31').kind).toBe('date');
    expect(adapter.describe('estimate', 3).kind).toBe('number');
    expect(adapter.describe('labels', ['#one', '#two']).kind).toBe('tags');
    expect(adapter.describe('related', '[[Projects/Other]]').kind).toBe('link');
    expect(adapter.describe('nested', { unsafe: true }).writable).toBe(false);
  });

  it('uses observed values for guarded generic writes without changing unrelated frontmatter', async () => {
    const app = new App();
    const file = Object.assign(Object.create(TFile.prototype), { path: 'Projects/A.md' }) as TFile;
    const frontmatter: Record<string, unknown> = { title: 'old', unknown: { nested: true } };
    vi.spyOn(app.vault, 'getAbstractFileByPath').mockReturnValue(file);
    vi.spyOn(app.fileManager, 'processFrontMatter').mockImplementation(async (_file, mutate) => {
      mutate(frontmatter);
    });
    const commands = new ProjectPropertyCommands(app);
    expect(
      await commands.write({
        path: file.path,
        propertyId: 'title',
        expected: 'other',
        next: 'new',
      }),
    ).toEqual({ type: 'conflict', current: 'old' });
    expect(
      await commands.write({ path: file.path, propertyId: 'title', expected: 'old', next: 'new' }),
    ).toEqual({ type: 'ok', value: 'new' });
    expect(frontmatter.unknown).toEqual({ nested: true });
  });
});
