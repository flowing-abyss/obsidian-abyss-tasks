import { describe, expect, it } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import {
  deriveInspectorSelection,
  type InspectorSelection,
} from '../src/ui/inspector/InspectorSelection';
import { mountInspectorShell } from '../src/ui/inspector/InspectorShell';
import {
  InspectorDraftRegistry,
  type InspectorDraftIdentity,
} from '../src/ui/projectDraftContinuity';
import { freshContainer, task, testStatusRegistry } from './helpers';

const project = (path = 'Projects/Atlas.md'): Extract<InspectorSelection, { type: 'project' }> => ({
  type: 'project',
  path,
});

describe('InspectorSelection', () => {
  it('prefers the active scope child and otherwise falls back to its project', () => {
    const task: InspectorSelection = {
      type: 'task',
      task: { filePath: 'Projects/Atlas.md', line: 4, revision: 'task-1' },
    };
    const note: InspectorSelection = {
      type: 'work-note',
      path: 'Notes/Brief.md',
      projectPath: 'Projects/Atlas.md',
    };

    expect(
      deriveInspectorSelection({ project: project(), activeScope: 'tasks', task, workNote: note }),
    ).toEqual(task);
    expect(
      deriveInspectorSelection({
        project: project(),
        activeScope: 'work-notes',
        task,
        workNote: note,
      }),
    ).toEqual(note);
    expect(
      deriveInspectorSelection({ project: project(), activeScope: 'work-notes', task }),
    ).toEqual(project());
  });

  it('hides a filtered child without discarding its remembered selection', () => {
    const task: InspectorSelection = {
      type: 'task',
      task: { filePath: 'Projects/Atlas.md', line: 4, revision: 'task-1' },
    };
    expect(
      deriveInspectorSelection({
        project: project(),
        activeScope: 'tasks',
        task,
        taskVisible: false,
      }),
    ).toEqual(project());
    expect(
      deriveInspectorSelection({
        project: project(),
        activeScope: 'tasks',
        task,
        taskVisible: true,
      }),
    ).toEqual(task);
  });
});

describe('InspectorShell', () => {
  it.each(['Project', 'Task', 'Work Note'])(
    '%s drawer focuses content, traps focus, and returns to its identity',
    async (kind) => {
      const host = freshContainer();
      host.ownerDocument.body.append(host);
      const origin = host.ownerDocument.createElement('button');
      origin.textContent = `Open ${kind}`;
      host.append(origin);
      const narrow = mountInspectorShell(host, {
        label: `${kind} details`,
        narrow: true,
        returnFocus: origin,
        render: (content) => {
          content.createEl('input', { attr: { 'aria-label': `${kind} editor` } });
          content.createEl('button', { text: 'Last' });
        },
      });

      expect(narrow.element.getAttribute('role')).toBe('dialog');
      expect(narrow.element.getAttribute('aria-modal')).toBe('true');
      const editor = narrow.element.querySelector<HTMLInputElement>('input')!;
      const buttons = Array.from(narrow.element.querySelectorAll<HTMLButtonElement>('button'));
      const last = buttons[buttons.length - 1]!;
      await Promise.resolve();
      expect(host.ownerDocument.activeElement).toBe(editor);
      last.focus();
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(host.ownerDocument.activeElement).toBe(
        narrow.element.querySelector<HTMLButtonElement>('.abyss-inspector-shell-close'),
      );
      narrow.close();
      expect(host.ownerDocument.activeElement).toBe(origin);

      const desktop = mountInspectorShell(host, {
        label: 'Project details',
        narrow: false,
        render: () => undefined,
      });
      expect(desktop.element.getAttribute('role')).toBe('region');
      expect(desktop.element.hasAttribute('aria-modal')).toBe(false);
      host.remove();
    },
  );

  it('keeps a dirty narrow inspector open on Escape and outside pointer input', () => {
    const host = freshContainer();
    host.ownerDocument.body.append(host);
    let closeRequests = 0;
    const shell = mountInspectorShell(host, {
      label: 'Project details',
      narrow: true,
      isDirty: () => true,
      onRequestClose: () => {
        closeRequests += 1;
      },
      render: (content) =>
        content.createEl('input', { attr: { 'aria-label': 'Project description' } }),
    });

    shell.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const outsidePointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    host.ownerDocument.dispatchEvent(outsidePointer);
    expect(closeRequests).toBe(0);
    expect(outsidePointer.defaultPrevented).toBe(true);
    expect(shell.element.textContent).toContain('Draft kept');
    expect(host.contains(shell.element)).toBe(true);
    host.remove();
  });

  it('closes a clean narrow drawer on outside pointer input and restores its origin', () => {
    const host = freshContainer();
    host.ownerDocument.body.append(host);
    const origin = host.ownerDocument.createElement('button');
    const outside = host.ownerDocument.createElement('button');
    host.append(origin, outside);
    let closeRequests = 0;
    const shell = mountInspectorShell(host, {
      label: 'Project details',
      narrow: true,
      returnFocus: origin,
      onRequestClose: () => {
        closeRequests += 1;
      },
      render: (content) => content.createEl('input'),
    });

    const outsidePointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    outside.dispatchEvent(outsidePointer);

    expect(closeRequests).toBe(1);
    expect(outsidePointer.defaultPrevented).toBe(true);
    expect(shell.element.isConnected).toBe(false);
    expect(host.ownerDocument.activeElement).toBe(origin);
    host.remove();
  });
});

describe('InspectorDraftRegistry', () => {
  it('keeps independent Project and Work Note field drafts across rename, detach, and restore', () => {
    const registry = new InspectorDraftRegistry();
    const projectIdentity: InspectorDraftIdentity = {
      type: 'project',
      path: 'Projects/Atlas.md',
    };
    const noteIdentity: InspectorDraftIdentity = {
      type: 'work-note',
      path: 'Work Notes/Brief.md',
      projectPath: 'Projects/Atlas.md',
    };
    registry.capture(projectIdentity, 'description', {
      value: 'My project draft',
      baseline: 'Published description',
      selectionStart: 3,
      selectionEnd: 8,
      hadFocus: true,
    });
    registry.capture(projectIdentity, 'comment', {
      value: 'Append this later',
      baseline: '',
      selectionStart: 2,
      selectionEnd: 5,
      hadFocus: false,
    });
    registry.capture(noteIdentity, 'status', {
      value: 'review',
      baseline: 'active',
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: true,
      pending: true,
    });

    registry.renamePath('Projects/Atlas.md', 'Projects/Atlas renamed.md');
    const renamedProject = {
      type: 'project' as const,
      path: 'Projects/Atlas renamed.md',
    };
    const renamedNote = {
      ...noteIdentity,
      projectPath: 'Projects/Atlas renamed.md',
    };
    expect(registry.get(renamedProject, 'description')).toMatchObject({
      value: 'My project draft',
      selectionStart: 3,
      selectionEnd: 8,
      hadFocus: true,
      dirty: true,
    });
    expect(registry.get(renamedProject, 'comment')?.value).toBe('Append this later');
    expect(registry.get(renamedNote, 'status')).toMatchObject({ value: 'review', pending: true });

    registry.detach(renamedNote);
    expect(registry.get(renamedNote, 'status')).toMatchObject({ detached: true, dirty: true });
    expect(registry.detached()).toHaveLength(1);
    registry.discard(renamedNote, 'status');
    expect(registry.detached()).toHaveLength(0);
  });

  it('detaches inactive child drafts on parent deletion and recovers rename collisions', () => {
    const registry = new InspectorDraftRegistry();
    const source = { type: 'project' as const, path: 'Projects/Source.md' };
    const destination = { type: 'project' as const, path: 'Projects/Destination.md' };
    const child = {
      type: 'work-note' as const,
      path: 'Work Notes/Inactive.md',
      projectPath: source.path,
    };
    registry.capture(destination, 'description', {
      value: 'Dormant destination draft',
      baseline: 'Destination',
      selectionStart: 3,
      selectionEnd: 3,
      hadFocus: false,
    });
    registry.capture(source, 'description', {
      value: 'Live source draft',
      baseline: 'Source',
      selectionStart: 4,
      selectionEnd: 4,
      hadFocus: true,
    });
    registry.capture(child, 'status', {
      value: 'review',
      baseline: 'active',
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: false,
    });

    registry.renamePath(source.path, destination.path);

    expect(registry.get(destination, 'description')?.value).toBe('Live source draft');
    const dormant = registry.detached().find(({ value }) => value === 'Dormant destination draft')!;
    expect(dormant).toMatchObject({ detached: true });
    registry.discardEntry(dormant);
    expect(registry.get(destination, 'description')?.value).toBe('Live source draft');
    registry.detachPath(destination.path);
    expect(registry.detached()).toContainEqual(
      expect.objectContaining({ identity: expect.objectContaining({ path: child.path }) }),
    );
  });

  it('settles the exact pending operation after rename and preserves detached failures', () => {
    const registry = new InspectorDraftRegistry();
    const project = { type: 'project' as const, path: 'Projects/Before.md' };
    registry.capture(project, 'description', {
      value: 'Mine',
      baseline: 'Published',
      selectionStart: 4,
      selectionEnd: 4,
      hadFocus: true,
    });
    const pendingProject = registry.markPending(project, 'description', 'Mine', 'Published', true);
    registry.renamePath(project.path, 'Projects/After.md');
    registry.settlePending(pendingProject, 'conflict');
    expect(
      registry.get({ type: 'project', path: 'Projects/After.md' }, 'description'),
    ).toMatchObject({ pending: false, result: 'conflict', dirty: true, hadFocus: true });

    const note = {
      type: 'work-note' as const,
      path: 'Work Notes/Brief.md',
      projectPath: 'Projects/After.md',
    };
    registry.capture(note, 'status', {
      value: 'review',
      baseline: 'active',
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: true,
    });
    const pendingNote = registry.markPending(note, 'status', 'review', 'active', true);
    registry.detachPath(note.path);
    registry.settlePending(pendingNote, 'invalid');
    expect(registry.get(note, 'status')).toMatchObject({
      pending: false,
      result: 'invalid',
      dirty: true,
      detached: true,
    });
  });
});

describe('project inspector arbitration', () => {
  it('renders an active Work Note and Project fallback ahead of a stale task stack', () => {
    const state = new AppState();
    const host = freshContainer();
    const rendered: InspectorSelection[] = [];
    const panel = new RightPanel(
      state,
      {} as never,
      testStatusRegistry(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (_host, selection) => {
        rendered.push(selection);
        return () => undefined;
      },
    );
    state.set('mode', 'projects');
    state.set('taskStack', [task({ title: 'Stale task' })]);
    state.set('inspectorSelection', {
      type: 'work-note',
      path: 'Notes/Brief.md',
      projectPath: 'Projects/Atlas.md',
    });
    panel.mount(host);
    expect(rendered[rendered.length - 1]).toMatchObject({
      type: 'work-note',
      path: 'Notes/Brief.md',
    });

    state.set('inspectorSelection', { type: 'project', path: 'Projects/Atlas.md' });
    expect(rendered[rendered.length - 1]).toEqual({ type: 'project', path: 'Projects/Atlas.md' });
    panel.destroy();
  });

  it('restores a dirty Task draft after visiting a Project inspector', () => {
    const state = new AppState();
    const host = freshContainer();
    const selected = task({ title: 'Published task' });
    const panel = new RightPanel(
      state,
      {} as never,
      testStatusRegistry(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (inspectorHost, selection) => {
        if (selection.type !== 'project') return undefined;
        inspectorHost.createDiv({ text: selection.path });
        return () => undefined;
      },
    );
    state.batch(() => {
      state.set('mode', 'projects');
      state.set('taskStack', [selected]);
      state.set('inspectorSelection', { type: 'task', task: selected.ref });
    });
    panel.mount(host);
    host.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
    const title = host.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    title.value = 'Unsaved task draft';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    state.batch(() => {
      state.set('taskStack', []);
      state.set('inspectorSelection', { type: 'project', path: 'Projects/Atlas.md' });
    });
    state.batch(() => {
      state.set('taskStack', [selected]);
      state.set('inspectorSelection', { type: 'task', task: selected.ref });
    });

    expect(host.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'Unsaved task draft',
    );
    panel.destroy();
  });

  it('preserves a dirty Task draft across an external Project publication refresh', () => {
    const state = new AppState();
    const host = freshContainer();
    const selected = task({ title: 'Published task' });
    const panel = new RightPanel(state, {} as never, testStatusRegistry());
    state.batch(() => {
      state.set('mode', 'projects');
      state.set('taskStack', [selected]);
      state.set('inspectorSelection', { type: 'task', task: selected.ref });
    });
    panel.mount(host);
    host.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
    const title = host.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    title.value = 'Unsaved across publication';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    panel.refresh();

    expect(host.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'Unsaved across publication',
    );
    panel.destroy();
  });

  it('cleans the previous narrow inspector document listener before replacing its shell', () => {
    const state = new AppState();
    const host = freshContainer();
    host.ownerDocument.body.append(host);
    let closeRequests = 0;
    const panel = new RightPanel(
      state,
      {} as never,
      testStatusRegistry(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (inspectorHost, selection) => {
        const shell = mountInspectorShell(inspectorHost, {
          label: `${selection.type} details`,
          narrow: true,
          onRequestClose: () => {
            closeRequests += 1;
          },
          render: (content) => content.createEl('input'),
        });
        return () => shell.close(false);
      },
    );
    state.set('mode', 'projects');
    state.set('inspectorSelection', { type: 'project', path: 'Projects/A.md' });
    panel.mount(host);
    state.set('inspectorSelection', { type: 'project', path: 'Projects/B.md' });

    host.ownerDocument.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

    expect(closeRequests).toBe(1);
    panel.destroy();
    host.remove();
  });
});
