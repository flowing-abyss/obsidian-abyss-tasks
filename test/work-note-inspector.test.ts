import { describe, expect, it, vi } from 'vitest';
import { renderWorkNoteInspector } from '../src/panels/projects/WorkNoteInspector';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer } from './helpers';

const snapshot: WorkNoteSnapshot = {
  path: 'Work Notes/Research.md',
  presetRevision: 4,
  kind: 'ordinary',
  projectPath: 'Projects/Product.md',
  statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
  rawStatus: 'Active raw',
  writableStatusShape: true,
  priority: 'High',
  range: {},
  milestonePath: 'Work Notes/Milestone.md',
  blockedByPaths: ['Work Notes/Blocker.md'],
  relatedPaths: ['Work Notes/Related.md'],
  diagnostics: [{ type: 'unknown-status', field: 'status', rawValue: 'Review' }],
};

describe('renderWorkNoteInspector', () => {
  it('renders note identity and rich supporting metadata without task controls', () => {
    const root = freshContainer();
    renderWorkNoteInspector(root, snapshot, {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.querySelector('h3')?.textContent).toBe('Research');
    expect(root.textContent).toContain('Ordinary');
    expect(root.textContent).toContain('Product');
    expect(root.textContent).toContain('High');
    expect(root.textContent).toContain('Milestone');
    expect(root.textContent).toContain('Blocker');
    expect(root.textContent).toContain('Related');
    expect(root.textContent).toContain('Unknown status');
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
    expect(root.querySelector('[data-work-note-task-command]')).toBeNull();
  });

  it('opens the note and exposes status as a native-menu button', () => {
    const root = freshContainer();
    const openNote = vi.fn();
    renderWorkNoteInspector(root, snapshot, {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      onSetStatus: vi.fn(),
      openNote,
    });

    root.querySelector<HTMLButtonElement>('[aria-label="Open work note"]')!.click();
    expect(openNote).toHaveBeenCalledWith(snapshot.path);
    const status = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
    expect(status.textContent).toBe('Active');
    expect(status.getAttribute('aria-label')).toBe('Change work note status');
  });

  it('disables status mutation when the guarded capability is unavailable', () => {
    const root = freshContainer();
    renderWorkNoteInspector(root, snapshot, {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      commandsEnabled: false,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    const status = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
    expect(status.disabled).toBe(true);
    expect(status.title).toContain('accepted compatibility audit');
  });
});
