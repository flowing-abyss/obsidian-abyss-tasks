import { describe, expect, it, vi } from 'vitest';
import { renderSourceNoteChip, shouldShowSourceNote } from '../src/ui/sourceNoteChip';
import { freshContainer, task } from './helpers';

describe('shouldShowSourceNote', () => {
  it("'never' always returns false", () => {
    const t = task({ source: { filePath: 'Projects/alpha.md' } });
    expect(shouldShowSourceNote(t, 'never', '')).toBe(false);
    expect(shouldShowSourceNote(t, 'never', 'Projects/alpha.md')).toBe(false);
  });

  it("'always' always returns true", () => {
    const t = task({
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    expect(shouldShowSourceNote(t, 'always', '')).toBe(true);
  });

  it("'non-default' hides for daily note (dailyNoteDate set)", () => {
    const t = task({
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    expect(shouldShowSourceNote(t, 'non-default', '')).toBe(false);
  });

  it("'non-default' hides when filePath matches customFilePath", () => {
    const t = task({
      source: { filePath: 'Inbox/tasks.md' },
      presentation: {},
    });
    expect(shouldShowSourceNote(t, 'non-default', 'Inbox/tasks.md')).toBe(false);
  });

  it("'non-default' does NOT hide when customFilePath is empty (prevents false positive)", () => {
    const t = task({
      source: { filePath: 'Inbox/tasks.md' },
      presentation: {},
    });
    expect(shouldShowSourceNote(t, 'non-default', '')).toBe(true);
  });

  it("'non-default' shows for regular project note", () => {
    const t = task({
      source: { filePath: 'Projects/alpha.md' },
      presentation: {},
    });
    expect(shouldShowSourceNote(t, 'non-default', '')).toBe(true);
  });
});

describe('renderSourceNoteChip', () => {
  it('appends .abyss-task-source-note to container', () => {
    const container = freshContainer();
    const t = task({ source: { filePath: 'Projects/alpha.md' } });
    renderSourceNoteChip(container, t);
    expect(container.querySelector('.abyss-task-source-note')).not.toBeNull();
  });

  it('chip contains .abyss-task-source-note-icon element', () => {
    const container = freshContainer();
    renderSourceNoteChip(container, task({ source: { filePath: 'Projects/alpha.md' } }));
    expect(container.querySelector('.abyss-task-source-note-icon')).not.toBeNull();
  });

  it('chip text contains filename without path or extension', () => {
    const container = freshContainer();
    renderSourceNoteChip(container, task({ source: { filePath: 'a/b/deep-note.md' } }));
    const chip = container.querySelector('.abyss-task-source-note');
    expect(chip?.textContent).toContain('deep-note');
    expect(chip?.textContent).not.toContain('/');
    expect(chip?.textContent).not.toContain('.md');
  });

  it('chip has .abyss-task-source-note-name span with note name', () => {
    const container = freshContainer();
    renderSourceNoteChip(container, task({ source: { filePath: 'Note.md' } }));
    const name = container.querySelector('.abyss-task-source-note-name');
    expect(name?.textContent).toBe('Note');
  });

  it('calls onClick with filePath when chip is clicked', () => {
    const container = freshContainer();
    const t = task({ source: { filePath: 'notes/2026-06-26.md' } });
    const cb = vi.fn();
    renderSourceNoteChip(container, t, cb);
    const chip = container.querySelector('.abyss-task-source-note') as HTMLElement;
    chip.click();
    expect(cb).toHaveBeenCalledWith('notes/2026-06-26.md');
  });
});
