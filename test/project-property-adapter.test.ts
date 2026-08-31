import { App, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectPropertyAdapter,
  parseProjectPropertyEditorValue,
} from '../src/projects/properties/ProjectPropertyAdapter';
import { ProjectPropertyCommands } from '../src/projects/properties/ProjectPropertyCommands';

describe('ProjectPropertyAdapter', () => {
  it('infers safe editable property kinds and preserves unsupported values', () => {
    const adapter = new ProjectPropertyAdapter();
    expect(adapter.describe('start', '2026-08-31').kind).toBe('date');
    expect(adapter.describe('estimate', 3).kind).toBe('number');
    expect(adapter.describe('labels', ['#one', '#two']).kind).toBe('tags');
    expect(adapter.describe('tags', ['one', 'two']).kind).toBe('tags');
    expect(adapter.describe('related', '[[Projects/Other]]').kind).toBe('link');
    expect(adapter.describe('nested', { unsafe: true }).writable).toBe(false);
  });

  it('enumerates arbitrary frontmatter alongside optional public Bases descriptors', () => {
    const adapter = new ProjectPropertyAdapter();
    expect(
      adapter.describeAll({ estimate: 3, nested: { preserve: true } }, [
        { id: 'estimate', displayName: 'Estimate hours', kind: 'number', writable: true },
      ]),
    ).toEqual([
      { id: 'estimate', displayName: 'Estimate hours', kind: 'number', writable: true },
      { id: 'nested', displayName: 'Nested', kind: 'unsupported', writable: false },
    ]);
  });

  it('keeps optional public Bases properties available when their carrier is absent', () => {
    const adapter = new ProjectPropertyAdapter();
    expect(
      adapter.describeAll({ estimate: 3 }, [
        { id: 'estimate', displayName: 'Estimate hours', kind: 'number', writable: true },
        { id: 'client', displayName: 'Client', kind: 'link', writable: true },
      ]),
    ).toEqual([
      { id: 'client', displayName: 'Client', kind: 'link', writable: true },
      { id: 'estimate', displayName: 'Estimate hours', kind: 'number', writable: true },
    ]);
  });

  it('parses editable carriers without accepting malformed number, date, or wikilink values', () => {
    const adapter = new ProjectPropertyAdapter();
    expect(parseProjectPropertyEditorValue(adapter.describe('estimate', 3), '4.5')).toEqual({
      type: 'value',
      value: 4.5,
    });
    expect(parseProjectPropertyEditorValue(adapter.describe('estimate', 3), 'four')).toEqual({
      type: 'invalid',
    });
    expect(
      parseProjectPropertyEditorValue(adapter.describe('labels', ['#one']), '#one, two'),
    ).toEqual({ type: 'value', value: ['one', 'two'] });
    expect(
      parseProjectPropertyEditorValue(adapter.describe('related', '[[Projects/A]]'), 'Projects/A'),
    ).toEqual({ type: 'invalid' });
    expect(
      parseProjectPropertyEditorValue(adapter.describe('start', '2026-08-31'), '2026-02-30'),
    ).toEqual({ type: 'invalid' });
    expect(
      parseProjectPropertyEditorValue(
        adapter.describe('when', '2026-08-31T09:00:00Z'),
        '2026-02-30T09:00',
      ),
    ).toEqual({ type: 'invalid' });
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

  it('rejects an unsupported structured replacement without touching frontmatter', async () => {
    const app = new App();
    const file = Object.assign(Object.create(TFile.prototype), { path: 'Projects/A.md' }) as TFile;
    const frontmatter: Record<string, unknown> = { nested: { preserve: true } };
    vi.spyOn(app.vault, 'getAbstractFileByPath').mockReturnValue(file);
    const process = vi
      .spyOn(app.fileManager, 'processFrontMatter')
      .mockImplementation(async (_file, mutate) => {
        mutate(frontmatter);
      });
    const commands = new ProjectPropertyCommands(app);
    expect(
      await commands.write({
        path: file.path,
        propertyId: 'nested',
        expected: frontmatter.nested,
        next: { replacement: true },
      }),
    ).toEqual({ type: 'unsupported', field: 'nested' });
    expect(process).not.toHaveBeenCalled();
    expect(frontmatter.nested).toEqual({ preserve: true });
  });

  it('refuses generic writes to Project fields owned by guarded command methods', async () => {
    const app = new App();
    const commands = new ProjectPropertyCommands(app);
    await expect(
      commands.write({ path: 'Projects/A.md', propertyId: 'priority', expected: 'C', next: 'A' }),
    ).resolves.toEqual({ type: 'unsupported', field: 'priority' });
  });
});
