import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import {
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

function snapshot(revision: string, description = 'old description'): TaskSnapshot {
  const ref: TaskRef = { filePath: 'tasks.md', line: 0, revision };
  const parent = { type: 'task' as const, ref };
  return {
    ref,
    title: 'root',
    markdownTitle: 'root',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [
      {
        ref: {
          parent,
          relativeLine: 2,
          originalMarkdown: '  - 2026-07-13: old comment',
        },
        timestamp: {
          precision: 'day',
          value: '2026-07-13' as never,
          raw: '2026-07-13',
        },
        text: 'old comment',
      },
    ],
    description,
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: '- [ ] root',
      originalBlock: '- [ ] root',
    },
    presentation: { linkCount: 0 },
  };
}

function snapshotWithChildren(revision: string, titles: readonly string[]): TaskSnapshot {
  const root = { ...snapshot(revision), comments: [] };
  delete root.description;
  const parent = { type: 'task' as const, ref: root.ref };
  return {
    ...root,
    subtasks: titles.map((title, index) => ({
      ref: {
        parent,
        relativeLine: index + 1,
        originalBlock: `  - [ ] ${title}`,
      },
      title,
      markdownTitle: title,
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      subtasks: [],
      comments: [],
    })),
  };
}

function snapshotWithNestedChildren(revision: string): TaskSnapshot {
  const root = snapshotWithChildren(revision, ['branch', 'sibling']);
  const rootNode = { type: 'task' as const, ref: root.ref };
  const branchRef = {
    parent: rootNode,
    relativeLine: 1,
    originalBlock: '  - [ ] branch\n    - [ ] nested one\n    - [ ] nested two',
  };
  const branchNode = { type: 'subtask' as const, ref: branchRef };
  const nested = ['nested one', 'nested two'].map((title, index) => ({
    ref: {
      parent: branchNode,
      relativeLine: index + 1,
      originalBlock: `    - [ ] ${title}`,
    },
    title,
    markdownTitle: title,
    status: 'open' as const,
    statusSymbol: ' ',
    priority: 'D' as const,
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [],
  }));
  return {
    ...root,
    subtasks: [
      { ...expectDefined(root.subtasks[0]), ref: branchRef, subtasks: nested },
      {
        ...expectDefined(root.subtasks[1]),
        ref: { ...expectDefined(root.subtasks[1]).ref, parent: rootNode, relativeLine: 4 },
      },
    ],
  };
}

function api(execute: TaskApplicationApi['execute']): TaskApplicationApi {
  return {
    queries: taskQueryApi(),
    execute,
  };
}

function call<T>(panel: RightPanel, method: string, ...args: unknown[]): T {
  const fn = expectDefined(
    (panel as unknown as Record<string, (...values: unknown[]) => T>)[method],
  );
  return fn.call(panel, ...args);
}

async function panelWith(
  initial: TaskSnapshot,
  execute: TaskApplicationApi['execute'],
  acknowledge?: (ref?: TaskRef) => void,
) {
  const app = await createAppWithFiles({ 'tasks.md': '- [ ] root\n' });
  const state = new AppState();
  state.set('taskStack', [initial]);
  const panel = new RightPanel(
    state,
    app,
    testStatusRegistry(),
    DEFAULT_SETTINGS,
    acknowledge,
    api(execute),
  );
  return { app, state, panel };
}

describe('RightPanel block editing', () => {
  it('preserves the full DOM draft bundle when an add-comment command is a no-op', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: initial },
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
      await flushMicrotasks();
      const title = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      title.value = 'unsaved title';
      title.focus();
      title.setSelectionRange(2, 7);
      const comment = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      comment.value = 'already present';
      comment.setSelectionRange(3, 10);

      comment.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks(20);

      const restoredTitle = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      const restoredComment = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      expect(restoredTitle.value).toBe('unsaved title');
      expect(restoredTitle.selectionStart).toBe(2);
      expect(restoredTitle.selectionEnd).toBe(7);
      expect(restoredComment.value).toBe('already present');
      expect(restoredComment.selectionStart).toBe(3);
      expect(restoredComment.selectionEnd).toBe(10);
      expect(activeDocument.activeElement).toBe(restoredTitle);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      panel.destroy();
    }
  });

  it('preserves simultaneous dirty title and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
    await flushMicrotasks();
    const title = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    comment.focus();
    title.value = 'local title draft';
    comment.value = 'local comment draft';

    const drafts = panel.captureDraftState();
    title.remove();
    const current = {
      ...snapshot('current'),
      title: 'external title',
      markdownTitle: 'external title',
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'local title draft',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('captures every dirty editor plus the focused clean editor in one bundle', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
    await flushMicrotasks();
    const title = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    title.value = 'dirty title';
    comment.focus();

    const bundle = panel.captureDraftState();
    title.remove();

    expect(bundle?.entries).toHaveLength(2);
    expect(
      bundle?.entries.map((entry) => [
        entry.kind,
        'dirty' in entry ? entry.dirty : entry.editor.dirty,
      ]),
    ).toEqual([
      ['title', true],
      ['new-comment', false],
    ]);
    const current = { ...snapshot('current'), title: 'external', markdownTitle: 'external' };
    state.set('taskStack', [current]);
    panel.restoreDraftState(bundle, current);
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'dirty title',
    );
    expect(activeDocument.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    panel.destroy();
  });

  it('preserves simultaneous dirty recurrence and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    comment.value = 'local comment draft';
    expectDefined(container.querySelector<HTMLElement>('.abyss-repeat-chip')).click();
    const interval = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
    );
    interval.value = '7';
    interval.dispatchEvent(new Event('input', { bubbles: true }));
    interval.focus();

    const drafts = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')?.value).toBe(
      '7',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it.each([
    {
      kind: 'title',
      open: '.abyss-right-title-view',
      edit: '.abyss-right-title-edit',
    },
    {
      kind: 'description',
      open: '.abyss-right-desc-view',
      edit: '.abyss-right-desc-edit',
    },
    {
      kind: 'existing-comment',
      open: '.abyss-comment-text',
      edit: '.abyss-comment-edit-input',
    },
    {
      kind: 'new-subtask',
      open: '.abyss-subtask-add-row',
      edit: '.abyss-subtask-new-input',
    },
  ] as const)(
    'retains dirty $kind text, focus, and selection across a proven refresh',
    async (entry) => {
      const initial = snapshot('old');
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const { panel, state } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      expectDefined(container.querySelector<HTMLElement>(entry.open)).click();
      await flushMicrotasks();
      const edit = expectDefined(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit),
      );
      edit.value = 'local unsaved';
      edit.focus();
      edit.setSelectionRange(3, 8);

      const draft = panel.captureDraftState();
      const current = {
        ...snapshot('current'),
        title: 'external title',
        markdownTitle: 'external title',
      };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);

      const restored = expectDefined(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit),
      );
      expect(restored).not.toBeNull();
      expect(restored.value).toBe('local unsaved');
      expect(restored.selectionStart).toBe(3);
      expect(restored.selectionEnd).toBe(8);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
      panel.destroy();
    },
  );

  it('retains a dirty new-comment draft across a proven refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    edit.value = 'local unsaved';
    edit.focus();
    edit.setSelectionRange(3, 8);

    const draft = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const restored = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    expect(restored.value).toBe('local unsaved');
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
    expect(activeDocument.activeElement).toBe(restored);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('detaches a dirty draft when its target disappears', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'local unsaved';
    edit.focus();

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const detached = expectDefined(container.querySelector<HTMLElement>('.abyss-detached-draft'));
    const copy = expectDefined(
      container.querySelector<HTMLButtonElement>('.abyss-detached-draft-copy'),
    );
    expect(detached.textContent).toContain('local unsaved');
    expect(detached.getAttribute('aria-label')).toContain('root');
    expect(detached.getAttribute('aria-label')).toContain('existing comment');
    expect(detached.getAttribute('role')).toBe('group');
    expect(copy).not.toBeNull();
    expect(copy.getAttribute('aria-label')).toContain('root');
    expect(copy.getAttribute('aria-label')).toContain('existing comment');
    expect(
      container
        .querySelector<HTMLButtonElement>('.abyss-detached-draft-discard')
        ?.getAttribute('aria-label'),
    ).toContain('root');
    expect(container.querySelector('.abyss-detached-draft-discard')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
      'Draft preserved',
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(activeDocument.activeElement).toBe(copy);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('upserts the newest value when the same draft detaches again', async () => {
    const initial = snapshot('old');
    const { panel, state } = await panelWith(initial, vi.fn<TaskApplicationApi['execute']>());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const input = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    input.value = 'first value';
    const first = expectDefined(panel.captureDraftState());
    panel.detachDraftState(first);
    input.value = 'newest value';
    const newest = expectDefined(panel.captureDraftState());
    panel.detachDraftState(newest);

    const detached = container.querySelectorAll<HTMLElement>('.abyss-detached-draft');
    expect(detached).toHaveLength(1);
    expect(detached[0]?.textContent).toContain('newest value');
    expect(detached[0]?.textContent).not.toContain('first value');
    state.set('taskStack', []);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain('newest value');
    panel.destroy();
  });

  it('keeps a detached draft visible across subsequent panel renders', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'persistent detached draft';

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );

    state.set('taskStack', [{ ...current, presentation: { linkCount: 1 } }]);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('keeps an append-once tray whose copy is non-destructive and discard removes one entry', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const existing = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    existing.value = 'existing comment draft';
    const existingBundle = panel.captureDraftState();
    const withoutComment = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [withoutComment]);
    panel.restoreDraftState(existingBundle, withoutComment);
    panel.detachDraftState(existingBundle);

    const newComment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    newComment.value = 'new comment draft';
    const newBundle = panel.captureDraftState();
    panel.detachDraftState(newBundle);

    expect(container.querySelectorAll('.abyss-detached-drafts-title')).toHaveLength(1);
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    const entries = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(entries[0]?.textContent).toContain('existing comment draft');
    expect(entries[1]?.textContent).toContain('new comment draft');

    Object.defineProperty(
      expectDefined(container.ownerDocument.defaultView).navigator,
      'clipboard',
      {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      },
    );
    const copy = expectDefined(
      expectDefined(entries[1]).querySelector<HTMLButtonElement>('.abyss-detached-draft-copy'),
    );
    copy.click();
    await flushMicrotasks();
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    expect(entries[1]?.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Could not copy',
    );
    expect(activeDocument.activeElement).toBe(copy);

    expectDefined(
      expectDefined(entries[0]).querySelector<HTMLButtonElement>('.abyss-detached-draft-discard'),
    ).click();
    const remaining = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('new comment draft');
    panel.destroy();
  });

  it('detaches instead of attaching a comment draft to a duplicate at the stale line', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'local duplicate-sensitive draft';

    const draft = panel.captureDraftState();
    const original = expectDefined(initial.comments[0]);
    const current = {
      ...snapshot('current'),
      comments: [original, { ...original, ref: { ...original.ref, relativeLine: 4 } }],
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'local duplicate-sensitive draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('retains a structured recurrence draft focus after deferred popover autofocus', async () => {
    const initial = { ...snapshot('old'), recurrence: 'every day' };
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-repeat-chip')).click();
      expectDefined(
        container.querySelector<HTMLButtonElement>('[data-recurrence-preset="daily"]'),
      ).click();
      const interval = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      interval.value = '12345';
      interval.dispatchEvent(new Event('input', { bubbles: true }));
      interval.focus();
      interval.setSelectionRange(2, 5);

      const draft = panel.captureDraftState();
      const current = { ...snapshot('current'), recurrence: 'every day' };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);
      await new Promise<void>((resolve) => {
        activeDocument.defaultView?.setTimeout(resolve, 0);
      });

      const restored = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      expect(restored.value).toBe('12345');
      expect(restored.selectionStart).toBe(2);
      expect(restored.selectionEnd).toBe(5);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      panel.destroy();
    }
  });

  it('deletes a root through the API and preserves newer navigation on a late result', async () => {
    const initial = snapshot('old');
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockImplementation(() => new Promise<TaskCommandResult>((done) => (resolve = done)));
    const { panel, state, app } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const process = vi.spyOn(app.vault, 'process');

    const pending = call<Promise<void>>(panel, 'deleteTask', root);
    expect(execute).toHaveBeenCalledWith({ type: 'delete', ref: initial.ref });
    const newer = snapshot('newer');
    state.set('taskStack', [newer]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: initial.ref },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([newer]);
    expect(process).not.toHaveBeenCalled();
  });

  it('delegates all description/comment intents with their exact revisioned targets', async () => {
    const initial = snapshot('old');
    const fresh = snapshot('fresh', 'new description');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const comment = expectDefined(root.comments[0]);

    await call<Promise<boolean>>(panel, 'updateDescription', root, 'new description');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'new description',
    });
    expect(state.get('taskStack')[0]).toMatchObject({
      ref: fresh.ref,
      description: 'new description',
    });

    execute.mockClear();
    const current = expectDefined(state.get('taskStack')[0]);
    const currentComment = expectDefined(current.comments[0]);
    const input = freshContainer().createEl('textarea');
    input.value = 'draft';
    await call<Promise<boolean>>(panel, 'addComment', current, 'added', freshContainer(), input);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-comment',
      parent: { type: 'task', ref: fresh.ref },
      text: 'added',
    });

    await call<Promise<boolean>>(panel, 'updateComment', current, currentComment, 'updated');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'update-comment',
      comment: expectDefined(fresh.comments[0]).ref,
      text: 'updated',
    });

    await call<Promise<boolean>>(panel, 'deleteComment', root, comment);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'delete-comment',
      comment: expectDefined(initial.comments[0]).ref,
    });
  });

  it('keeps add-comment input and DOM unchanged on a structured conflict', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel, state } = await panelWith(initial, execute);
    const input = freshContainer().createEl('textarea');
    const list = freshContainer();
    input.value = 'draft';

    await call<Promise<boolean>>(
      panel,
      'addComment',
      expectDefined(state.get('taskStack')[0]),
      'draft',
      list,
      input,
    );

    expect(input.value).toBe('draft');
    expect(list.querySelectorAll('.abyss-comment-row')).toHaveLength(0);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: initial.ref });
  });

  it.each([
    {
      label: 'conflict',
      result: { type: 'conflict', current: snapshot('external') },
    },
    {
      label: 'not-found',
      result: {
        type: 'not-found',
        target: { type: 'task', ref: snapshot('old').ref },
      },
    },
    {
      label: 'ambiguous',
      result: {
        type: 'ambiguous',
        candidates: [
          {
            root: snapshot('candidate'),
            target: { type: 'task', ref: snapshot('candidate').ref },
          },
        ],
      },
    },
    {
      label: 'invalid',
      result: {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      },
    },
    {
      label: 'io-error',
      result: {
        type: 'io-error',
        cause: 'process-error',
        contentState: 'unknown',
      },
    },
  ])('keeps the add-subtask editor and exact draft open on $label', async ({ result }) => {
    const initial = snapshot('old');
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValue(result as TaskCommandResult);
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
    );
    input.value = 'keep this draft';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'keep this draft',
    });
    expect(container.querySelector('.abyss-subtask-new-input')).toBe(input);
    expect(input.value).toBe('keep this draft');
    expect(
      container.querySelector('.abyss-subtask-add-row')?.hasClass('abyss-subtask-add-row--hidden'),
    ).toBe(true);
    panel.destroy();
  });

  it('keeps the description textarea open when its save conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
    const textarea = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
    );
    textarea.value = 'attempted change';
    textarea.dispatchEvent(new FocusEvent('blur'));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'attempted change',
    });
    expect(container.querySelector('.abyss-right-desc-edit')).toBe(textarea);
    panel.destroy();
  });

  it('keeps a comment textarea open when its exact comment ref conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    vi.useFakeTimers();
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const textarea = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
      );
      textarea.value = 'attempted comment';
      textarea.dispatchEvent(new FocusEvent('blur'));
      await vi.advanceTimersByTimeAsync(151);

      expect(execute).toHaveBeenCalledWith({
        type: 'update-comment',
        comment: expectDefined(initial.comments[0]).ref,
        text: 'attempted comment',
      });
      expect(container.querySelector('.abyss-comment-edit-input')).toBe(textarea);
    } finally {
      vi.useRealTimers();
      panel.destroy();
    }
  });

  it('does not restore a selection replaced while a structural result was in flight', async () => {
    const initial = snapshot('old');
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const acknowledge = vi.fn<(ref?: TaskRef) => void>();
    const { panel, state } = await panelWith(initial, execute, acknowledge);
    const pending = call<Promise<boolean>>(
      panel,
      'updateDescription',
      expectDefined(state.get('taskStack')[0]),
      'new description',
    );
    state.set('taskStack', [other]);
    const fresh = snapshot('fresh', 'new description');
    resolve({ type: 'ok', changed: true, outcome: { type: 'task', task: fresh } });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
    expect(acknowledge).toHaveBeenCalledWith(fresh.ref);
  });

  it('delegates add and sibling reorder through revisioned structural commands', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const afterAdd = snapshotWithChildren('after-add', ['first', 'second', 'new child']);
    const afterReorder = snapshotWithChildren('after-reorder', ['second', 'first', 'new child']);
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterAdd },
      })
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterReorder },
      });
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);

    await call<Promise<void>>(panel, 'addSubTask', root, 'new child');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'new child',
    });

    const current = expectDefined(state.get('taskStack')[0]);
    await call<Promise<void>>(
      panel,
      'reorderSubTask',
      current,
      expectDefined(current.subtasks[0]),
      expectDefined(current.subtasks[1]),
      'after',
    );
    expect(execute).toHaveBeenLastCalledWith({
      type: 'reorder-subtask',
      subtask: expectDefined(afterAdd.subtasks[0]).ref,
      target: expectDefined(afterAdd.subtasks[1]).ref,
      placement: 'after',
    });
    expect(expectDefined(state.get('taskStack')[0]).subtasks.map((child) => child.title)).toEqual([
      'second',
      'first',
      'new child',
    ]);
  });

  it('deletes the selected nested task through the menu and converges selection to its parent', async () => {
    const initial = snapshotWithChildren('old', ['selected', 'sibling']);
    const afterDelete = snapshotWithChildren('fresh', ['sibling']);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: afterDelete },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = initial;
    state.set('taskStack', [root, expectDefined(root.subtasks[0])]);
    const container = freshContainer();
    panel.mount(container);

    expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="More actions"]'),
    ).click();
    const deleteItem = expectDefined(container.querySelector<HTMLElement>('.abyss-context-danger'));
    expect(deleteItem.textContent).toBe('Delete sub-task');
    deleteItem.click();
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'delete-subtask',
      subtask: expectDefined(initial.subtasks[0]).ref,
    });
    expect(state.get('taskStack')).toHaveLength(1);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: afterDelete.ref, title: 'root' });
    panel.destroy();
  });

  it('does not overwrite a newer selection when a late reorder result arrives', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      expectDefined(root.subtasks[0]),
      expectDefined(root.subtasks[1]),
      'after',
    );
    state.set('taskStack', [other]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
  });

  it('does not overwrite newer navigation within the same root when a reorder resolves late', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      expectDefined(root.subtasks[0]),
      expectDefined(root.subtasks[1]),
      'after',
    );
    const selectedChild = expectDefined(root.subtasks[1]);
    state.set('taskStack', [root, selectedChild]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([root, selectedChild]);
  });

  it.each(['add', 'delete', 'reorder'] as const)(
    'keeps a newer sibling selection when a deferred nested %s completes',
    async (operation) => {
      const initial = snapshotWithNestedChildren('old');
      let resolve!: (result: TaskCommandResult) => void;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
        () =>
          new Promise<TaskCommandResult>((done) => {
            resolve = done;
          }),
      );
      const { panel, state } = await panelWith(initial, execute);
      const root = initial;
      const branch = expectDefined(root.subtasks[0]);
      const sibling = expectDefined(root.subtasks[1]);
      state.set('taskStack', [root, branch]);

      let pending: Promise<unknown>;
      if (operation === 'add') {
        pending = call<Promise<boolean>>(panel, 'addSubTask', branch, 'new nested child');
      } else if (operation === 'delete') {
        pending = call<Promise<void>>(panel, 'deleteTask', branch);
      } else {
        pending = call<Promise<void>>(
          panel,
          'reorderSubTask',
          branch,
          expectDefined(branch.subtasks[0]),
          expectDefined(branch.subtasks[1]),
          'after',
        );
      }

      state.set('taskStack', [root, sibling]);
      resolve({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: snapshotWithNestedChildren('fresh') },
      });
      await pending;

      expect(state.get('taskStack')).toEqual([root, sibling]);
    },
  );
});
