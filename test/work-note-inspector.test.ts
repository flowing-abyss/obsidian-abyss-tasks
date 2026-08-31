import { Menu, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkNoteInspector } from '../src/panels/projects/WorkNoteInspector';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { InspectorDraftRegistry } from '../src/ui/projectDraftContinuity';
import { deferred, freshContainer } from './helpers';

afterEach(() => vi.restoreAllMocks());

const snapshot: WorkNoteSnapshot = {
  path: 'Work Notes/Research.md',
  presetRevision: 4,
  presetFingerprint: 'fixture-fingerprint',
  kind: 'ordinary',
  projectPath: 'Projects/Product.md',
  statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
  rawStatus: 'Active raw',
  writableStatusShape: true,
  priority: 'High',
  description: 'Customer handoff and release readiness',
  range: {},
  milestonePath: 'Work Notes/Milestone.md',
  blockedByPaths: ['Work Notes/Blocker.md'],
  relatedPaths: ['Work Notes/Related.md'],
  diagnostics: [{ type: 'unknown-status', field: 'status', rawValue: 'Review' }],
};

describe('renderWorkNoteInspector', () => {
  it('uses the shared inspector field-row contract for its status, metadata, and relations', () => {
    const root = freshContainer();
    renderWorkNoteInspector(root, snapshot, {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.dataset['inspectorEntity']).toBe('work-note');
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>('.abyss-inspector-field-row'),
        (field) => field.dataset['inspectorField'],
      ),
    ).toEqual(['status', 'priority', 'description', 'relations', 'diagnostics']);
    expect(root.querySelector('[aria-label="Close Work Note details"]')).toBeNull();
  });

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
    expect(root.textContent).toContain('Customer handoff and release readiness');
    expect(root.querySelector('[data-work-note-description]')?.textContent).toBe(
      'Customer handoff and release readiness',
    );
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

  it('handles a rejected status promise as an accessible io error and restores focus', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    let click: (() => unknown) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      const item = {
        setTitle() {
          return this;
        },
        setIcon() {
          return this;
        },
        setChecked() {
          return this;
        },
        setDisabled() {
          return this;
        },
        onClick(callback: () => unknown) {
          click = callback;
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    try {
      renderWorkNoteInspector(root, snapshot, {
        statuses: DEFAULT_SETTINGS.projects.statuses,
        onSetStatus: vi.fn().mockRejectedValue(new Error('fixture io failure')),
        openNote: vi.fn(),
      });
      const trigger = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
      trigger.click();
      await click?.();

      await vi.waitFor(() => {
        const feedback = root.querySelector<HTMLElement>('[data-work-note-feedback]');
        expect(feedback?.dataset['resultType']).toBe('io-error');
        expect(feedback?.getAttribute('role')).toBe('status');
        expect(activeDocument.activeElement).toBe(trigger);
      });
    } finally {
      root.remove();
    }
  });

  it('keeps a remounted pending status disabled and republishes its settled conflict', async () => {
    const root = freshContainer();
    const registry = new InspectorDraftRegistry();
    const conflict = deferred<{ type: 'conflict'; field: 'status' }>();
    let click: (() => unknown) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      const item = {
        setTitle() {
          return this;
        },
        setIcon() {
          return this;
        },
        setChecked() {
          return this;
        },
        setDisabled() {
          return this;
        },
        onClick(callback: () => unknown) {
          click = callback;
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    const render = (): void =>
      renderWorkNoteInspector(root, snapshot, {
        statuses: DEFAULT_SETTINGS.projects.statuses,
        onSetStatus: () => conflict.promise,
        openNote: vi.fn(),
        draftRegistry: registry,
        onDraftSettled: render,
      });
    render();
    root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!.click();
    const pending = click?.();
    render();

    expect(root.querySelector<HTMLButtonElement>('.abyss-work-note-status')?.disabled).toBe(true);
    expect(root.querySelector('.abyss-work-note-draft-result')?.textContent).toContain('Saving');

    conflict.resolve({ type: 'conflict', field: 'status' });
    await pending;
    await vi.waitFor(() =>
      expect(root.querySelector('.abyss-work-note-draft-result')?.textContent).toContain(
        'changed outside calendar',
      ),
    );
    expect(root.querySelector<HTMLButtonElement>('.abyss-work-note-status')?.disabled).toBe(false);
    const settled = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
    settled.focus();
    settled.blur();
    render();
    expect(root.querySelector('.abyss-work-note-draft-result')?.textContent).toContain(
      'changed outside calendar',
    );
  });
});
