import { Scope } from 'obsidian';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskApplicationApi,
  TaskCommand,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSnapshot,
} from '../src/tasks';
import { TaskModal } from '../src/ui/TaskModal';
import {
  createAppWithFiles,
  dropFocusFromDisabledButton,
  expectDefined,
  flushMicrotasks,
  methodOf,
  task,
  taskComment,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
  type TestTaskQueries,
} from './helpers';
import { scopeKeyboardEvent } from './support/scopeKeyboardEvent';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

import { inspectorCleanups, inspectorHarness } from './support/inspectorHarness';
useRealMoment();

function queryEvents(): {
  subscribe: TaskQueryApi['subscribe'];
  publish: (event: TaskIndexEvent) => void;
} {
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function fieldDescription(field: string, observed: TaskSnapshot): Partial<TaskSnapshot> {
  if (field === 'description') return { description: 'submitted description' };
  return observed.description === undefined ? {} : { description: observed.description };
}

function fieldRecurrence(field: string, observed: TaskSnapshot): Partial<TaskSnapshot> {
  if (field === 'recurrence') return { recurrence: 'every day' };
  return observed.recurrence === undefined ? {} : { recurrence: observed.recurrence };
}

function statusAfterCommand(command: TaskCommand, current: TaskSnapshot): TaskSnapshot['status'] {
  if (command.type === 'toggle-completion') return 'done';
  if (command.type === 'set-status') return 'in-progress';
  return current.status;
}

function statusSymbolAfterCommand(command: TaskCommand, current: TaskSnapshot): string {
  if (command.type === 'toggle-completion') return 'x';
  if (command.type === 'set-status') return command.symbol;
  return current.statusSymbol;
}

/**
 * Opens a modal on a dated task whose next write is held. The held write drops focus from the
 * disabled Save the way Chromium does. `transition` publishes the early owned transition that
 * consumes the submitted repeat editor, and `fail` settles the write as a conflict.
 */
async function openHeldRepeatSave(): Promise<{
  readonly modal: TaskModal;
  readonly execute: Mock<TaskApplicationApi['execute']>;
  readonly transition: () => void;
  readonly fail: () => void;
}> {
  const app = await createAppWithFiles({ 'f.md': '- [ ] observed 📅 2026-08-13\n' });
  const observed = task({
    title: 'observed',
    planning: { due: '2026-08-13' },
    ref: { filePath: 'f.md', line: 0, revision: 'old' },
    source: {
      filePath: 'f.md',
      line: 0,
      originalMarkdown: '- [ ] observed 📅 2026-08-13',
      originalBlock: '- [ ] observed 📅 2026-08-13',
    },
  });
  const candidate = task({
    ...observed,
    recurrence: 'every day',
    ref: { filePath: 'f.md', line: 0, revision: 'candidate' },
    source: {
      ...observed.source,
      originalMarkdown: '- [ ] observed 🔁 every day 📅 2026-08-13',
      originalBlock: '- [ ] observed 🔁 every day 📅 2026-08-13',
    },
  });
  const events = queryEvents();
  let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
  let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
  const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
    () =>
      new Promise((resolvePromise) => {
        dropFocusFromDisabledButton();
        finish = resolvePromise;
      }),
  );
  const queries = taskQueryApi({
    resolve: () => resolution,
    subscribe: events.subscribe,
  });
  const modal = new TaskModal({
    app,
    statusRegistry: testStatusRegistry(),
    settings: DEFAULT_SETTINGS,
    queries,
    tasks: {
      queries,
      execute,
    },
  });
  modal.open(observed);
  return {
    modal,
    execute,
    transition: () => {
      resolution = {
        type: 'rebased',
        previous: observed,
        current: candidate,
        evidence: 'authority-transition',
        basis: { observed },
      };
      events.publish({ type: 'changed', files: ['f.md'] });
    },
    fail: () => {
      finish({ type: 'conflict', current: observed });
    },
  };
}

/**
 * Opens the modal's repeat editor from its chip, lets its deferred focus land, chooses Daily, and
 * submits it from Save.
 */
async function submitDailyRepeat(): Promise<HTMLButtonElement> {
  const chip = expectDefined(
    activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-repeat-chip'),
  );
  chip.focus();
  click(chip);
  await flushMicrotasks();
  const daily = expectDefined(
    activeDocument.querySelector<HTMLButtonElement>(
      '.abyss-modal [data-recurrence-preset="daily"]',
    ),
  );
  daily.focus();
  click(daily);
  const save = expectDefined(
    activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-recurrence-save'),
  );
  save.focus();
  click(save);
  return save;
}

function pressedDailyPreset(): string | null | undefined {
  return activeDocument
    .querySelector('.abyss-modal .abyss-recurrence-editor [data-recurrence-preset="daily"]')
    ?.getAttribute('aria-pressed');
}

describe('TaskModal with real RightPanel', () => {
  let modal: TaskModal | undefined;

  afterEach(() => {
    modal?.close();
    activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
      element.remove();
    });
  });

  it('keeps the original nested modal entry connected through repeated real-index insertions', async () => {
    const h = await inspectorHarness('- [ ] Root\n  - [ ] Owner\n    - [ ] Existing', 'Owner');
    modal = new TaskModal({
      app: h.app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries: h.index,
      tasks: h.api,
    });
    modal.open(h.node('Root').root);
    try {
      expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-subtask-label'),
      ).click();
      const root = expectDefined(activeDocument.querySelector('.abyss-modal'));
      expectDefined(root.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
      const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-subtask-new-input'));
      const header = expectDefined(root.querySelector('.abyss-right-header'));
      for (const title of ['First', 'Second', 'Third']) {
        input.value = title;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => {
          expect(h.node('Owner').node.subtasks.some((child) => child.title === title)).toBe(true);
        });
        await flushMicrotasks(20);
        expect(input.isConnected).toBe(true);
        expect(root.querySelector('.abyss-subtask-new-input')).toBe(input);
        expect(activeDocument.activeElement).toBe(input);
        expect(root.querySelector('.abyss-right-header')).toBe(header);
      }
    } finally {
      modal.close();
      for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    }
  });

  it('retains the inspector DOM, focus, caret and scroll when another root changes', async () => {
    const h = await createCanonicalSearchHarness(
      { 'tasks.md': '- [ ] Selected\n- [ ] Other' },
      DEFAULT_SETTINGS,
    );
    modal = new TaskModal({
      app: h.app,
      statusRegistry: h.statusRegistry,
      settings: DEFAULT_SETTINGS,
      queries: h.index,
      tasks: h.tasks,
    });
    try {
      modal.open(expectDefined(h.index.list()[0]));
      const state = (modal as unknown as { innerState_abyssPrivate: AppState })
        .innerState_abyssPrivate;
      const header = expectDefined(
        activeDocument.querySelector('.abyss-modal .abyss-right-header'),
      );
      const input = expectDefined(
        activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
      );
      const scroll = expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right'),
      );
      input.value = 'Unsubmitted comment';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(3, 8);
      scroll.scrollTop = 137;
      const stack = state.get('taskStack');
      const other = expectDefined(h.index.list()[1]);
      const result = await h.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: other.ref },
        patch: { markdownTitle: { type: 'set', value: 'Changed other' } },
      });
      expect(result.type).toBe('ok');
      await vi.waitFor(() => {
        expect(h.index.list()[1]?.title).toBe('Changed other');
      });
      expect(state.get('taskStack')).toBe(stack);
      expect(activeDocument.querySelector('.abyss-modal .abyss-right-header')).toBe(header);
      expect(activeDocument.querySelector('.abyss-modal .abyss-comment-input')).toBe(input);
      expect(input.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
      expect(scroll.scrollTop).toBe(137);
    } finally {
      modal.close();
      h.close();
    }
  });

  it('refreshes same-ref custom status semantics through the actual modal reconciliation', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '- [?] Custom' });
    const observed = task({ title: 'Custom', statusSymbol: '?' });
    const events = queryEvents();
    let current = observed;
    const queries = taskQueryApi({
      resolve: () => ({ type: 'exact', task: current, basis: { observed } }),
      subscribe: events.subscribe,
    });
    modal = new TaskModal({ app, statusRegistry: testStatusRegistry(), queries });
    modal.open(observed);
    const header = expectDefined(activeDocument.querySelector('.abyss-modal .abyss-right-header'));
    current = { ...observed, status: 'cancelled' };
    events.publish({ type: 'changed', files: [observed.ref.filePath] });
    const state = (modal as unknown as { innerState_abyssPrivate: AppState })
      .innerState_abyssPrivate;
    expect(state.get('taskStack')[0]?.ref).toEqual(observed.ref);
    expect(state.get('taskStack')[0]?.status).toBe('cancelled');
    expect(activeDocument.querySelector('.abyss-modal .abyss-right-header')).not.toBe(header);
  });

  it('keeps unsaved Weekly inline after current modal chips through a same-file line shift', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed 📅 2031-10-02\n' });
    const observed = task({
      title: 'observed',
      planning: { due: '2031-10-02' },
      ref: { filePath: 'f.md', line: 0, revision: 'same' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed 📅 2031-10-02',
        originalBlock: '- [ ] observed 📅 2031-10-02',
      },
    });
    const current = task({
      ...observed,
      ref: { ...observed.ref, line: 1 },
      source: { ...observed.source, line: 1 },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({ resolve: () => resolution, subscribe: events.subscribe });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: { queries, execute },
    });
    modal.open(observed);
    click(
      expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-repeat-chip')),
    );
    click(
      expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-modal [data-recurrence-preset="weekly"]'),
      ),
    );
    const first = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-recurrence-popover'),
    );
    const chips = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-chips-row'),
    );
    expect(chips.nextElementSibling).toBe(first);
    expect(first.classList.contains('abyss-recurrence-popover-inline')).toBe(true);
    expect(first.classList.contains('abyss-popover-anchored')).toBe(false);
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };
    events.publish({ type: 'changed', files: ['f.md'] });
    const replacement = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-recurrence-popover'),
    );
    expect(first.isConnected).toBe(false);
    expect(replacement).not.toBe(first);
    expect(
      expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-chips-row'))
        .nextElementSibling,
    ).toBe(replacement);
    expect(replacement.classList.contains('abyss-recurrence-popover-inline')).toBe(true);
    expect(replacement.classList.contains('abyss-popover-anchored')).toBe(false);
    expect(
      replacement.querySelector('[data-recurrence-preset="weekly"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(execute).not.toHaveBeenCalled();
    replacement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(replacement.isConnected).toBe(false);
    modal.close();
    expect(activeDocument.querySelector('.abyss-modal')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves a dirty focused title through a proven silent refresh', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      title: 'external',
      markdownTitle: 'external',
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] external',
        originalBlock: '- [ ] external',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    click(
      expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right-title-view'),
      ),
    );
    const edit = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-right-title-edit'),
    );
    edit.value = 'local unsaved';
    edit.focus();
    edit.setSelectionRange(3, 8);
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };

    events.publish({ type: 'changed', files: ['f.md'] });

    const restored = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-right-title-edit'),
    );
    expect(restored.value).toBe('local unsaved');
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
    expect(activeDocument.activeElement).toBe(restored);
    expect(activeDocument.querySelector('.abyss-task-selection-message')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not recapture a submitted comment when its owned index event arrives before execute resolves', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      ...observed,
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      comments: [taskComment({ text: 'submitted once' })],
      source: {
        ...observed.source,
        originalBlock: '- [ ] observed\n  - submitted once',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      resolution = {
        type: 'rebased',
        previous: observed,
        current,
        evidence: 'authority-transition',
        basis: { observed },
      };
      events.publish({ type: 'changed', files: ['f.md'] });
      await blocked;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'submitted once';
    input.focus();

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    release();
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(activeDocument.querySelectorAll('.abyss-modal .abyss-comment-row')).toHaveLength(1);
    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('');
    expect(activeDocument.querySelector('.abyss-modal .abyss-detached-draft')).toBeNull();
    expect(activeDocument.querySelector('.abyss-task-selection-message')).toBeNull();
  });

  it('preserves a newer same-key comment typed after submit across the owned transition', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      ...observed,
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      comments: [taskComment({ text: 'submitted first' })],
      source: { ...observed.source, originalBlock: '- [ ] observed\n  - submitted first' },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'submitted first';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    input.value = 'next local draft';
    input.setSelectionRange(4, 9);
    input.focus();
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };

    events.publish({ type: 'changed', files: ['f.md'] });

    const restored = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    expect(restored.value).toBe('next local draft');
    expect(restored.selectionStart).toBe(4);
    expect(restored.selectionEnd).toBe(9);
    finish({ type: 'ok', changed: true, outcome: { type: 'task', task: current } });
    await flushMicrotasks();
    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('next local draft');
  });

  it('does not resurrect committed text when only comment focus and caret changed', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      ...observed,
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      comments: [taskComment({ text: 'submitted' })],
      source: { ...observed.source, originalBlock: '- [ ] observed\n  - submitted' },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'submitted';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    input.focus();
    input.setSelectionRange(2, 7);
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };

    events.publish({ type: 'changed', files: ['f.md'] });
    finish({ type: 'ok', changed: true, outcome: { type: 'task', task: current } });
    await flushMicrotasks();

    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('');
  });

  it('preserves the other inline comment editor across an early exact-target submission refresh', async () => {
    const app = await createAppWithFiles({
      'f.md': '- [ ] observed\n  - first comment\n  - second comment\n',
    });
    const observedRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'old' };
    const observedParent = { type: 'task' as const, ref: observedRef };
    const observed = task({
      title: 'observed',
      ref: observedRef,
      comments: [
        taskComment({
          text: 'first comment',
          ref: { parent: observedParent, relativeLine: 1, originalMarkdown: '  - first comment' },
        }),
        taskComment({
          text: 'second comment',
          ref: { parent: observedParent, relativeLine: 2, originalMarkdown: '  - second comment' },
        }),
      ],
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed\n  - first comment\n  - second comment',
      },
    });
    const currentRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'new' };
    const currentParent = { type: 'task' as const, ref: currentRef };
    const current = task({
      ...observed,
      ref: currentRef,
      comments: [
        taskComment({
          text: 'first submitted',
          ref: { parent: currentParent, relativeLine: 1, originalMarkdown: '  - first submitted' },
        }),
        taskComment({
          text: 'second comment',
          ref: { parent: currentParent, relativeLine: 2, originalMarkdown: '  - second comment' },
        }),
      ],
      source: {
        ...observed.source,
        originalBlock: '- [ ] observed\n  - first submitted\n  - second comment',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      expect(command).toMatchObject({
        type: 'update-comment',
        comment: { originalMarkdown: '  - first comment' },
        text: 'first submitted',
      });
      resolution = {
        type: 'rebased',
        previous: observed,
        current,
        evidence: 'authority-transition',
        basis: { observed },
      };
      events.publish({ type: 'changed', files: ['f.md'] });
      await blocked;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const texts = [
      ...activeDocument.querySelectorAll<HTMLElement>('.abyss-modal .abyss-comment-text'),
    ];
    click(expectDefined(texts[0]));
    const first = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-edit-input'),
    );
    first.value = 'first submitted';
    click(expectDefined(texts[1]));
    const editors = [
      ...activeDocument.querySelectorAll<HTMLTextAreaElement>(
        '.abyss-modal .abyss-comment-edit-input',
      ),
    ];
    expect(editors).toHaveLength(2);
    const second = expectDefined(editors[1]);
    second.value = 'second local draft';
    second.focus();

    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 175));
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    const restoredEditors = [
      ...activeDocument.querySelectorAll<HTMLTextAreaElement>(
        '.abyss-modal .abyss-comment-edit-input',
      ),
    ];
    expect(restoredEditors).toHaveLength(1);
    expect(restoredEditors[0]?.value).toBe('second local draft');
    release();
    await flushMicrotasks();
    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-edit-input')
        ?.value,
    ).toBe('second local draft');
  });

  it('recovers submitted escrow when an early owned transition later conflicts', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const candidate = task({
      ...observed,
      ref: { filePath: 'f.md', line: 0, revision: 'candidate' },
      comments: [taskComment({ text: 'rollback me' })],
      source: { ...observed.source, originalBlock: '- [ ] observed\n  - rollback me' },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'rollback me';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    resolution = {
      type: 'rebased',
      previous: observed,
      current: candidate,
      evidence: 'authority-transition',
      basis: { observed },
    };
    events.publish({ type: 'changed', files: ['f.md'] });

    finish({ type: 'conflict', current: observed });
    await flushMicrotasks();

    const recoveredInput = activeDocument.querySelector<HTMLTextAreaElement>(
      '.abyss-modal .abyss-comment-input',
    );
    const recoveredTray = activeDocument.querySelector('.abyss-modal .abyss-detached-draft');
    expect(`${recoveredInput?.value ?? ''}${recoveredTray?.textContent ?? ''}`).toContain(
      'rollback me',
    );
  });

  it('keeps moved focus on an outside button when it recovers a consumed repeat draft', async () => {
    const held = await openHeldRepeatSave();
    modal = held.modal;
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    try {
      const save = await submitDailyRepeat();
      await flushMicrotasks();
      held.transition();
      expect(held.execute).toHaveBeenCalledOnce();
      expect(save.isConnected).toBe(false);
      expect(activeDocument.querySelector('.abyss-modal .abyss-recurrence-editor')).toBeNull();
      outside.focus();

      held.fail();
      await flushMicrotasks();

      expect(pressedDailyPreset()).toBe('true');
      // Restoring the submit-time focus wherever focus is now would move it to the reopened Save.
      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('focuses the reopened Save when it recovers a consumed repeat draft with focus on body', async () => {
    const held = await openHeldRepeatSave();
    modal = held.modal;
    const save = await submitDailyRepeat();
    await flushMicrotasks();
    held.transition();
    expect(held.execute).toHaveBeenCalledOnce();
    expect(save.isConnected).toBe(false);
    expect(activeDocument.querySelector('.abyss-modal .abyss-recurrence-editor')).toBeNull();
    expect(activeDocument.activeElement).toBe(activeDocument.body);

    held.fail();
    await flushMicrotasks();

    expect(pressedDailyPreset()).toBe('true');
    const reopenedSave = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-recurrence-save'),
    );
    // A recovery that always drops the draft's focus lets the resolver focus the rebuilt chip.
    expect(activeDocument.activeElement).toBe(reopenedSave);
  });

  it('serializes overlapping same-root submissions and retains the second draft', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      ...observed,
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      comments: [taskComment({ text: 'first submission' })],
      source: { ...observed.source, originalBlock: '- [ ] observed\n  - first submission' },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const finishes: Array<(result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void> =
      [];
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          finishes.push(resolvePromise);
        }),
    );
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'first submission';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };
    events.publish({ type: 'changed', files: ['f.md'] });
    const successorInput = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    successorInput.value = 'second submission';
    successorInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('second submission');
    finishes[0]?.({ type: 'ok', changed: true, outcome: { type: 'task', task: current } });
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('second submission');
  });

  it('keeps the title editor open with its value when save fails without an index event', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const queries = taskQueryApi({
      resolve: () => ({ type: 'exact', task: observed, basis: { observed } }),
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
          type: 'conflict',
          current: observed,
        }),
      },
    });
    modal.open(observed);
    click(
      expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right-title-view'),
      ),
    );
    const edit = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-right-title-edit'),
    );
    edit.value = 'failed title';

    edit.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    const retained = activeDocument.querySelector<HTMLTextAreaElement>(
      '.abyss-modal .abyss-right-title-edit',
    );
    expect(retained?.value).toBe('failed title');
  });

  it.each([
    {
      field: 'title',
      submit: () => {
        click(
          expectDefined(
            activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right-title-view'),
          ),
        );
        const edit = expectDefined(
          activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-right-title-edit'),
        );
        edit.value = 'submitted title';
        edit.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      },
      assertClosed: () => {
        expect(activeDocument.querySelector('.abyss-modal .abyss-right-title-edit')).toBeNull();
      },
    },
    {
      field: 'description',
      submit: () => {
        click(
          expectDefined(
            activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right-desc-view'),
          ),
        );
        const edit = expectDefined(
          activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-right-desc-edit'),
        );
        edit.value = 'submitted description';
        edit.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      },
      assertClosed: () => {
        expect(activeDocument.querySelector('.abyss-modal .abyss-right-desc-edit')).toBeNull();
      },
    },
    {
      field: 'subtask',
      submit: () => {
        click(
          expectDefined(
            activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-subtask-add-row'),
          ),
        );
        const edit = expectDefined(
          activeDocument.querySelector<HTMLInputElement>('.abyss-modal .abyss-subtask-new-input'),
        );
        edit.value = 'submitted subtask';
        edit.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      },
      assertClosed: () => {
        expect(activeDocument.querySelector('.abyss-modal .abyss-subtask-new-input')).toBeNull();
      },
    },
    {
      field: 'recurrence',
      submit: () => {
        click(
          expectDefined(
            activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-repeat-chip'),
          ),
        );
        click(
          expectDefined(
            activeDocument.querySelector<HTMLButtonElement>(
              '.abyss-modal [data-recurrence-preset="daily"]',
            ),
          ),
        );
        click(
          expectDefined(
            activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-recurrence-save'),
          ),
        );
      },
      assertClosed: () => {
        expect(activeDocument.querySelector('.abyss-modal .abyss-recurrence-popover')).toBeNull();
      },
    },
  ])(
    'does not recapture a submitted $field draft during an early owned index event',
    async ({ field, submit, assertClosed }) => {
      const app = await createAppWithFiles({ 'f.md': '- [ ] observed 📅 2026-08-13\n' });
      const observed = task({
        title: 'observed',
        markdownTitle: 'observed',
        ...(field === 'description' ? { description: 'old description' } : {}),
        planning: { due: '2026-08-13' },
        ref: { filePath: 'f.md', line: 0, revision: 'old' },
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] observed 📅 2026-08-13',
          originalBlock: '- [ ] observed 📅 2026-08-13',
        },
      });
      const current = task({
        ...observed,
        title: field === 'title' ? 'submitted title' : observed.title,
        markdownTitle: field === 'title' ? 'submitted title' : observed.markdownTitle,
        ...fieldDescription(field, observed),
        ...fieldRecurrence(field, observed),
        ref: { filePath: 'f.md', line: 0, revision: 'new' },
        source: { ...observed.source, originalBlock: '- [ ] current' },
      });
      const events = queryEvents();
      let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
      let release!: () => void;
      const blocked = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      const queries = taskQueryApi({
        resolve: () => resolution,
        subscribe: events.subscribe,
      });
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
        resolution = {
          type: 'rebased',
          previous: observed,
          current,
          evidence: 'authority-transition',
          basis: { observed },
        };
        events.publish({ type: 'changed', files: ['f.md'] });
        await blocked;
        return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
      });
      modal = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
        settings: DEFAULT_SETTINGS,
        queries,
        tasks: {
          queries,
          execute,
        },
      });
      modal.open(observed);

      submit();
      await flushMicrotasks();
      release();
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledTimes(1);
      assertClosed();
      expect(activeDocument.querySelector('.abyss-modal .abyss-detached-draft')).toBeNull();
      expect(activeDocument.querySelector('.abyss-task-selection-message')).toBeNull();
    },
  );

  it('bridges a selected task and its dirty draft directly across a rename event', async () => {
    const app = await createAppWithFiles({ 'old.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'old.md', line: 0, revision: 'old' },
      source: {
        filePath: 'old.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const renamed = task({
      ...observed,
      ref: { filePath: 'renamed.md', line: 0, revision: 'fresh' },
      source: { ...observed.source, filePath: 'renamed.md' },
    });
    const events = queryEvents();
    const queries = taskQueryApi({
      list: (query) => (query?.filePath === 'renamed.md' ? [renamed] : []),
      resolve: () => ({ type: 'not-found', ref: observed.ref }),
      subscribe: events.subscribe,
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    });
    modal.open(observed);
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'rename-safe draft';
    comment.focus();

    events.publish({ type: 'renamed', oldPath: 'old.md', newPath: 'renamed.md' });

    const title = activeDocument.querySelector('.abyss-modal .abyss-right-title');
    expect(title).not.toBeNull();
    expect(expectDefined(title).textContent).toContain('observed');
    expect(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input')?.value,
    ).toBe('rename-safe draft');
    expect(activeDocument.activeElement).toBe(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    expect(activeDocument.querySelector('.abyss-modal .abyss-detached-draft')).toBeNull();
  });

  it('shows fresh visual content while detaching every stale dirty draft silently', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      title: 'visual current',
      markdownTitle: 'visual current',
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] visual current',
        originalBlock: '- [ ] visual current',
      },
    });
    const events = queryEvents();
    const queries = taskQueryApi({
      resolve: () => ({
        type: 'visual',
        stale: observed.ref,
        current,
        evidence: 'same-line',
      }),
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'stale modal draft';

    events.publish({ type: 'changed', files: ['f.md'] });

    expect(activeDocument.querySelector('.abyss-modal .abyss-right-title')?.textContent).toContain(
      'visual current',
    );
    expect(
      activeDocument.querySelector('.abyss-modal .abyss-detached-draft')?.textContent,
    ).toContain('stale modal draft');
    expect(activeDocument.querySelector('.abyss-task-selection-message')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a missing modal open only to expose its detached dirty draft', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      markdownTitle: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    const push = vi.spyOn(app.keymap, 'pushScope');
    const pop = vi.spyOn(app.keymap, 'popScope');
    modal.open(observed);
    expect(push).toHaveBeenCalledOnce();
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'local unsaved';
    comment.focus();
    resolution = { type: 'not-found', ref: observed.ref };

    events.publish({ type: 'changed', files: ['f.md'] });

    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(
      activeDocument.querySelector('.abyss-modal .abyss-detached-draft')?.textContent,
    ).toContain('local unsaved');
    expect(execute).not.toHaveBeenCalled();
    expect(pop).not.toHaveBeenCalled();
    expectDefined(document.querySelector<HTMLElement>('.abyss-modal-backdrop')).click();
    expect(pop).toHaveBeenCalledExactlyOnceWith(push.mock.calls[0]?.[0]);
    expect(document.querySelector('.abyss-modal')).toBeNull();
  });

  describe('its own removal of the task', () => {
    async function openRemovable(): Promise<{
      readonly execute: Mock<TaskApplicationApi['execute']>;
      readonly titles: string[];
    }> {
      const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n- [ ] next\n' });
      const observed = task({
        title: 'observed',
        markdownTitle: 'observed',
        ref: { filePath: 'f.md', line: 0, revision: 'old' },
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] observed',
          originalBlock: '- [ ] observed',
        },
      });
      const next = task({
        title: 'next',
        markdownTitle: 'next',
        ref: { filePath: 'f.md', line: 0, revision: 'next' },
        source: {
          filePath: 'f.md',
          line: 0,
          originalMarkdown: '- [ ] next',
          originalBlock: '- [ ] next',
        },
      });
      const events = queryEvents();
      let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
      const queries = taskQueryApi({ resolve: () => resolution, subscribe: events.subscribe });
      // The index publishes the note's update during the write, before the command returns.
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation((command) => {
        resolution = { type: 'visual', stale: observed.ref, current: next, evidence: 'same-line' };
        events.publish({ type: 'changed', files: ['f.md'] });
        return Promise.resolve({
          type: 'ok',
          changed: true,
          outcome:
            command.type === 'archive'
              ? { type: 'archived', ref: observed.ref, filePath: 'archive.md' }
              : { type: 'deleted', ref: observed.ref },
        });
      });
      modal = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
        settings: DEFAULT_SETTINGS,
        queries,
        tasks: {
          queries,
          execute,
        },
      });
      modal.open(observed);
      const titles: string[] = [];
      const inner = (modal as unknown as { innerState_abyssPrivate: AppState })
        .innerState_abyssPrivate;
      inner.on('taskStack', (stack) => {
        titles.push(...stack.map((node) => node.title));
      });
      return { execute, titles };
    }

    function chooseAction(label: 'Delete task' | 'Archive'): void {
      click(
        expectDefined(
          activeDocument.querySelector<HTMLElement>(
            '.abyss-modal .abyss-right-action-btn[aria-label="More actions"]',
          ),
        ),
      );
      click(
        expectDefined(
          [
            ...activeDocument.querySelectorAll<HTMLElement>(
              '.abyss-modal .abyss-task-context-menu .abyss-context-item',
            ),
          ].find((item) => item.textContent === label),
        ),
      );
    }

    it.each(['Delete task', 'Archive'] as const)(
      'closes after its %s when the index moves the next task onto the line first',
      async (label) => {
        const { execute, titles } = await openRemovable();

        chooseAction(label);
        await flushMicrotasks();

        expect(execute).toHaveBeenCalledOnce();
        expect(titles).not.toContain('next');
        expect(activeDocument.querySelector('.abyss-modal-backdrop')).toBeNull();
      },
    );

    it('keeps an unsaved draft open without showing the next task', async () => {
      const { titles } = await openRemovable();
      const comment = expectDefined(
        activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
      );
      comment.value = 'unsaved note';

      chooseAction('Delete task');
      await flushMicrotasks();

      expect(titles).not.toContain('next');
      expect(activeDocument.querySelector('.abyss-modal .abyss-right-title')).toBeNull();
      expect(
        activeDocument.querySelector('.abyss-modal .abyss-detached-draft')?.textContent,
      ).toContain('unsaved note');
    });
  });

  it('shares the header status control, rebuilds command results, and owns its refresh', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [w] Modal task\n' });
    const registry = testStatusRegistry();
    registry.replace([
      ...registry.all(),
      {
        id: 'status-waiting',
        symbol: 'w',
        name: 'Waiting',
        type: 'in-progress',
        icon: 'pause',
        core: false,
      },
    ]);
    const initialRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'revision-0' };
    let current = task({
      title: 'Modal task',
      status: 'in-progress',
      statusSymbol: 'w',
      priority: 'F',
      ref: initialRef,
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [w] Modal task',
        originalBlock: '- [w] Modal task',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: current, basis: { observed: current } };
    const queries: TestTaskQueries = taskQueryApi({
      list: () => [current],
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    let revision = 0;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      revision += 1;
      const nextRef: TaskRef = { ...current.ref, revision: `revision-${revision}` };
      const next: TaskSnapshot = task({
        ...current,
        ref: nextRef,
        status: statusAfterCommand(command, current),
        statusSymbol: statusSymbolAfterCommand(command, current),
        priority:
          command.type === 'patch' && command.patch.priority?.type === 'set'
            ? command.patch.priority.value
            : current.priority,
      });
      current = next;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: next } };
    });
    const tasks: TaskApplicationApi = { queries, execute };
    modal = new TaskModal({
      app,
      statusRegistry: registry,
      settings: DEFAULT_SETTINGS,
      queries,
      tasks,
    });

    modal.open(current);

    const header = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-right-header'),
    );
    const initialMarker = expectDefined(
      header.querySelector<HTMLElement>(':scope > .abyss-status-marker'),
    );
    expect(initialMarker).not.toBeNull();
    expect(initialMarker.nextElementSibling).toBe(
      header.querySelector(':scope > .abyss-right-title'),
    );
    expect(initialMarker.getAttribute('data-status')).toBe('status-waiting');
    expect(initialMarker.getAttribute('data-priority')).toBe('F');

    click(initialMarker);
    await flushMicrotasks();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: 'toggle-completion' });
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.abyss-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.abyss-modal .abyss-right-header > .abyss-status-marker')
        ?.getAttribute('data-status'),
    ).toBe('status-3');

    expectDefined(
      activeDocument.querySelector<HTMLElement>(
        '.abyss-modal .abyss-right-header > .abyss-status-marker',
      ),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const waiting = expectDefined(
      Array.from(activeDocument.querySelectorAll<HTMLElement>('.abyss-status-popover-row')).find(
        (row) => row.textContent.includes('Waiting'),
      ),
    );
    click(waiting);
    await flushMicrotasks();
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: 'set-status', symbol: 'w' });
    expect(activeDocument.querySelector('.abyss-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.abyss-modal .abyss-right-header > .abyss-status-marker')
        ?.getAttribute('data-status'),
    ).toBe('status-waiting');

    expectDefined(
      activeDocument.querySelector<HTMLElement>(
        '.abyss-modal .abyss-right-header > .abyss-status-marker',
      ),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    click(
      expectDefined(
        activeDocument.querySelector<HTMLElement>(
          ".abyss-status-popover-flag[data-abyss-priority='A']",
        ),
      ),
    );
    await flushMicrotasks();
    expect(execute.mock.calls[2]?.[0]).toMatchObject({
      type: 'patch',
      patch: { priority: { type: 'set', value: 'A' } },
    });
    expect(activeDocument.querySelector('.abyss-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.abyss-modal .abyss-right-header > .abyss-status-marker')
        ?.getAttribute('data-priority'),
    ).toBe('A');

    const refreshed = task({
      ...current,
      status: 'cancelled',
      statusSymbol: '-',
      priority: 'B',
    });
    resolution = {
      type: 'rebased',
      previous: current,
      current: refreshed,
      evidence: 'authority-transition',
      basis: { observed: current },
    };
    events.publish({ type: 'changed', files: ['f.md'] });

    const refreshedMarker = activeDocument.querySelector<HTMLElement>(
      '.abyss-modal .abyss-right-header > .abyss-status-marker',
    );
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.abyss-task-selection-stale')).toBeNull();
    expect(refreshedMarker?.getAttribute('data-status')).toBe('status-4');
    expect(refreshedMarker?.getAttribute('data-priority')).toBe('B');
    const closeButton = activeDocument.querySelector<HTMLElement>('.abyss-modal-close-btn');
    expect(closeButton).not.toBeNull();
    click(expectDefined(closeButton));
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).toBeNull();
  });

  it('inherits the one shared recurrence editor through RightPanel reuse', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal repeat 📅 2026-08-09\n' });
    const current = task({
      title: 'Modal repeat',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal repeat 📅 2026-08-09',
        originalBlock: '- [ ] Modal repeat 📅 2026-08-09',
      },
    });
    const queries: TestTaskQueries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: current },
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(current);

    const repeatChip = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-repeat-chip'),
    );
    click(repeatChip);

    expect(activeDocument.querySelectorAll('.abyss-recurrence-editor')).toHaveLength(1);
    expect(activeDocument.querySelectorAll('.abyss-modal .abyss-recurrence-editor')).toHaveLength(
      1,
    );
    expect(activeDocument.querySelector('.abyss-modal .abyss-recurrence-popover')).not.toBeNull();

    expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-modal .abyss-recurrence-editor'),
    ).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.abyss-modal .abyss-recurrence-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(repeatChip);
  });

  it('keeps the modal open when Escape dismisses its status menu', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal status\n' });
    const current = task({
      title: 'Modal status',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal status',
        originalBlock: '- [ ] Modal status',
      },
    });
    const queries: TestTaskQueries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    });
    modal.open(current);
    const marker = expectDefined(
      activeDocument.querySelector<HTMLElement>(
        '.abyss-modal .abyss-right-header > .abyss-status-marker',
      ),
    );

    marker.focus();
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-status-popover-flag'),
    ).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(marker);
  });

  it('keeps the modal open when Escape dismisses its focused priority popover', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal priority ⏬\n' });
    const current = task({
      title: 'Modal priority',
      priority: 'F',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal priority ⏬',
        originalBlock: '- [ ] Modal priority ⏬',
      },
    });
    const queries: TestTaskQueries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    });
    modal.open(current);
    const chip = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-priority-chip'),
    );

    chip.focus();
    click(chip);
    const selected = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>(
        '.abyss-modal .abyss-priority-option.is-active',
      ),
    );
    expect(activeDocument.activeElement).toBe(selected);

    selected.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(activeDocument.querySelector('.abyss-modal .abyss-priority-popover')).toBeNull();
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(chip);
  });

  it('anchors modal task popovers to their containing block and repositions on scroll and resize', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal position ⏫\n' });
    const current = task({
      title: 'Modal position',
      priority: 'B',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal position ⏫',
        originalBlock: '- [ ] Modal position ⏫',
      },
    });
    const queries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    });
    modal.open(current);
    const modalEl = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal'));
    const panelEl = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal-body'));
    const chip = expectDefined(panelEl.querySelector<HTMLElement>('.abyss-priority-chip'));
    let containingLeft = 30;
    let scrollLeft = 17;
    let scrollTop = 19;
    const containingTop = 20;
    const panelContentLeft = 80;
    const panelContentTop = 45;
    const anchorContentLeft = 180;
    const anchorContentTop = 95;
    Object.defineProperties(panelEl, {
      clientLeft: { configurable: true, value: 3 },
      clientTop: { configurable: true, value: 5 },
      scrollLeft: { configurable: true, value: 11 },
      scrollTop: { configurable: true, value: 13 },
    });
    Object.defineProperty(panelEl, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        rect(
          containingLeft + modalEl.clientLeft + panelContentLeft - scrollLeft,
          containingTop + modalEl.clientTop + panelContentTop - scrollTop,
          300,
          240,
        ),
    });
    Object.defineProperties(modalEl, {
      clientLeft: { configurable: true, value: 7 },
      clientTop: { configurable: true, value: 4 },
      scrollLeft: { configurable: true, get: () => scrollLeft },
      scrollTop: { configurable: true, get: () => scrollTop },
    });
    Object.defineProperty(modalEl, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(containingLeft, containingTop, 500, 400),
    });
    const anchorRect = vi.fn(() =>
      rect(
        containingLeft + modalEl.clientLeft + anchorContentLeft - scrollLeft,
        containingTop + modalEl.clientTop + anchorContentTop - scrollTop,
        20,
        20,
      ),
    );
    Object.defineProperty(chip, 'getBoundingClientRect', {
      configurable: true,
      value: anchorRect,
    });
    const realRect = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches('.abyss-priority-popover')) return rect(0, 0, 120, 80);
        return realRect.call(this);
      });
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches('.abyss-priority-popover')) return modalEl;
        return null;
      });

    try {
      click(chip);
      const popover = expectDefined(panelEl.querySelector<HTMLElement>('.abyss-priority-popover'));
      expect(popover.offsetParent).toBe(modalEl);
      expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('180px');
      expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('119px');
      expect(anchorRect).toHaveBeenCalledTimes(1);

      scrollLeft = 31;
      scrollTop = 29;
      const scrollEvent = new Event('scroll', { bubbles: false });
      modalEl.dispatchEvent(scrollEvent);
      expect(scrollEvent.bubbles).toBe(false);
      expect(anchorRect).toHaveBeenCalledTimes(2);
      const scrolledAnchor = chip.getBoundingClientRect();
      const scrolledViewportLeft =
        Number.parseFloat(popover.style.getPropertyValue('--abyss-pop-left')) +
        containingLeft +
        modalEl.clientLeft -
        scrollLeft;
      const scrolledViewportTop =
        Number.parseFloat(popover.style.getPropertyValue('--abyss-pop-top')) +
        containingTop +
        modalEl.clientTop -
        scrollTop;
      expect(scrolledViewportLeft).toBe(scrolledAnchor.left);
      expect(scrolledViewportTop).toBe(114);
      expect(scrolledViewportTop - scrolledAnchor.bottom).toBe(4);

      containingLeft = 40;
      expectDefined(activeDocument.defaultView).dispatchEvent(new Event('resize'));
      expect(anchorRect).toHaveBeenCalledTimes(4);
      expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('180px');
      const resizedViewportLeft =
        Number.parseFloat(popover.style.getPropertyValue('--abyss-pop-left')) +
        containingLeft +
        modalEl.clientLeft -
        scrollLeft;
      expect(resizedViewportLeft).toBe(196);
    } finally {
      offsetParent.mockRestore();
      measure.mockRestore();
    }
  });

  it.each([
    {
      surface: 'title editor',
      openSelector: '.abyss-right-title-view',
      ownedSelector: '.abyss-right-title-edit',
    },
    {
      surface: 'description editor',
      openSelector: '.abyss-right-desc-view',
      ownedSelector: '.abyss-right-desc-edit',
    },
    {
      surface: 'add-subtask editor',
      openSelector: '.abyss-subtask-add-row',
      ownedSelector: '.abyss-subtask-new-input',
    },
    {
      surface: 'inline comment editor',
      openSelector: '.abyss-comment-text',
      ownedSelector: '.abyss-comment-edit-input',
    },
    {
      surface: 'inline tag dropdown',
      openSelector: '+ tag',
      ownedSelector: '.abyss-tag-input',
    },
  ])('keeps the modal open when Escape cancels its $surface', async (entry) => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Nested Escape\n' });
    const current = task({
      title: 'Nested Escape',
      comments: [taskComment({ text: 'Nested comment' })],
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Nested Escape',
        originalBlock: '- [ ] Nested Escape',
      },
    });
    const queries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    Object.defineProperty(app.metadataCache, 'getTags', {
      configurable: true,
      value: () => ({ '#alpha': 1 }),
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    });
    const register = vi.spyOn(Scope.prototype, 'register');
    modal.open(current);
    const modalEscape = expectDefined(register.mock.calls.find((call) => call[1] === 'Escape'))[2];

    const opener = entry.openSelector.startsWith('.')
      ? activeDocument.querySelector<HTMLElement>(`.abyss-modal ${entry.openSelector}`)
      : Array.from(
          activeDocument.querySelectorAll<HTMLElement>('.abyss-modal .abyss-chip-add'),
        ).find((candidate) => candidate.textContent === entry.openSelector);
    click(expectDefined(opener));
    const owned = expectDefined(
      activeDocument.querySelector<HTMLElement>(`.abyss-modal ${entry.ownedSelector}`),
    );
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    owned.focus();
    expect(modalEscape(escape, { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBeUndefined();
    owned.dispatchEvent(escape);
    await flushMicrotasks();

    expect(escape.defaultPrevented).toBe(true);
    expect(activeDocument.querySelector(`.abyss-modal ${entry.ownedSelector}`)).toBeNull();
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
  });

  it('returns focus to the rebuilt priority chip after an owned priority change', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] observed\n' });
    const observed = task({
      title: 'observed',
      ref: { filePath: 'f.md', line: 0, revision: 'old' },
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] observed',
        originalBlock: '- [ ] observed',
      },
    });
    const current = task({
      ...observed,
      priority: 'A',
      ref: { filePath: 'f.md', line: 0, revision: 'new' },
      source: {
        ...observed.source,
        originalMarkdown: '- [ ] observed 🔺',
        originalBlock: '- [ ] observed 🔺',
      },
    });
    const events = queryEvents();
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: events.subscribe,
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      resolution = {
        type: 'rebased',
        previous: observed,
        current,
        evidence: 'authority-transition',
        basis: { observed },
      };
      events.publish({ type: 'changed', files: ['f.md'] });
      return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
    });
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      queries,
      tasks: {
        queries,
        execute,
      },
    });
    modal.open(observed);
    const chip = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-priority-chip'),
    );

    chip.focus();
    click(chip);
    click(
      expectDefined(
        activeDocument.querySelector<HTMLButtonElement>(
          '.abyss-modal .abyss-priority-option[data-priority="A"]',
        ),
      ),
    );
    await flushMicrotasks();

    const rebuilt = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-modal .abyss-priority-chip'),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(rebuilt).not.toBe(chip);
    expect(rebuilt.getAttribute('data-priority')).toBe('A');
    expect(activeDocument.activeElement).toBe(rebuilt);
  });
});

it('routes the real modal picker before its parent and releases child scopes first across close/reopen', async () => {
  const h = await createCanonicalSearchHarness(
    { 'scope.md': '- [ ] Current 🆔 current\n- [ ] Candidate 🆔 candidate' },
    DEFAULT_SETTINGS,
  );
  const push = vi.spyOn(h.app.keymap, 'pushScope');
  const pop = vi.spyOn(h.app.keymap, 'popScope');
  const register = vi.spyOn(Scope.prototype, 'register');
  const modal = new TaskModal({
    app: h.app,
    statusRegistry: testStatusRegistry(),
    settings: DEFAULT_SETTINGS,
    queries: h.index,
    tasks: h.tasks,
    search: h.search,
  });
  const current = expectDefined(h.index.list()[0]);
  const hostFrame = document.body.createEl('iframe');
  const hostWindow = expectDefined(hostFrame.contentWindow);
  try {
    modal.open(current);
    const parent = expectDefined(push.mock.calls[0])[0];
    const parentEscape = expectDefined(register.mock.calls.find((call) => call[1] === 'Escape'))[2];
    const badge = expectDefined(
      document.querySelector<HTMLButtonElement>('.abyss-modal .abyss-dep-badge-body'),
    );
    badge.click();
    const picker = expectDefined(
      document.querySelector<HTMLElement>('.abyss-modal .abyss-dep-search'),
    );
    const input = expectDefined(picker.querySelector('input'));
    input.value = 'retained';
    expect(push).toHaveBeenCalledTimes(2);
    const child = expectDefined(push.mock.calls[1])[0];
    const childEscape = expectDefined(register.mock.calls[register.mock.calls.length - 1])[2];
    const event = () =>
      scopeKeyboardEvent(expectDefined(document.activeElement), { key: 'Escape' }, [hostWindow]);
    const context = { key: 'Escape', vkey: 'Escape', modifiers: '' };
    const first = event();
    expect(first.target).toBe(input);
    expect(first.composedPath()[0]).not.toBe(first.target);
    expect(first.composedPath()[0]).not.toBe(input.ownerDocument.defaultView);
    expect(first.view?.document).toBe(input.ownerDocument);
    expect(childEscape(first, context)).toBe(false);
    expect(parentEscape(first, context)).toBeUndefined();
    expect(input.value).toBe('retained');
    expect(document.activeElement).toBe(picker);
    const second = event();
    expect(childEscape(second, context)).toBe(false);
    expect(parentEscape(second, context)).toBeUndefined();
    expect(document.activeElement).toBe(badge);
    expect(document.querySelector('.abyss-modal')).not.toBeNull();
    expect(pop.mock.calls.map(([scope]) => scope)).toEqual([child]);
    badge.click();
    const secondChild = expectDefined(push.mock.calls[2])[0];
    modal.close();
    modal.close();
    expect(pop.mock.calls.map(([scope]) => scope)).toEqual([child, secondChild, parent]);
    modal.open(current);
    expect(parentEscape(event(), context)).toBeUndefined();
    expect(document.querySelector('.abyss-modal')).not.toBeNull();
    const newEscape = expectDefined(register.mock.calls[register.mock.calls.length - 1])[2];
    expectDefined(document.querySelector<HTMLButtonElement>('.abyss-modal-close-btn')).focus();
    const final = event();
    expect(newEscape(final, context)).toBe(false);
    document.dispatchEvent(final);
    expect(pop).toHaveBeenCalledTimes(4);
  } finally {
    modal.close();
    h.close();
    hostFrame.remove();
    vi.restoreAllMocks();
  }
});

it('uses multiline comment disclosure and description keyboard submission in the real modal', async () => {
  const h = await createCanonicalSearchHarness(
    { 'modal.md': '- [ ] Owner\n  - > old description\n  - first\n    second' },
    DEFAULT_SETTINGS,
  );
  const modal = new TaskModal({
    app: h.app,
    statusRegistry: testStatusRegistry(),
    settings: DEFAULT_SETTINGS,
    queries: h.index,
    tasks: h.tasks,
    search: h.search,
  });
  try {
    modal.open(expectDefined(h.index.list()[0]));
    const root = expectDefined(document.querySelector('.abyss-modal'));
    expect(root.querySelector('.abyss-comment-text')?.textContent).toBe('first');
    const disclosure = expectDefined(
      root.querySelector<HTMLButtonElement>('.abyss-comment-disclosure'),
    );
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    disclosure.click();
    expect(root.querySelector('.abyss-comment-edit-input')).toBeNull();
    expectDefined(root.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const comment = expectDefined(
      root.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    expect(comment.value).toBe('first\nsecond');
    comment.value = 'edited first\nedited second';
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    await flushMicrotasks();
    expect(h.index.list()[0]?.comments[0]?.text).toBe('first\nsecond');
    comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.comments[0]?.text).toBe('edited first\nedited second');
    });
    expectDefined(root.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
    const description = expectDefined(
      root.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
    );
    description.value = 'one\ntwo';
    description.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    description.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.description).toBe('one\ntwo');
    });
    expect(root.querySelector('.abyss-right-desc-edit')).toBeNull();
  } finally {
    modal.close();
    h.close();
    vi.restoreAllMocks();
  }
});

it.each([false, true])(
  'modal offers task-list navigation only with a real outer capability: %s',
  async (enabled) => {
    const app = await createAppWithFiles({});
    const callback = vi.fn<
      NonNullable<ConstructorParameters<typeof TaskModal>[0]['onShowInTaskList']>
    >(async () => {});
    const modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
      ...(enabled ? { onShowInTaskList: callback } : {}),
    });
    const snapshot = task();
    try {
      modal.open(snapshot);
      click(
        expectDefined(
          activeDocument.querySelector<HTMLElement>('.abyss-modal [aria-label="More actions"]'),
        ),
      );
      const action = [
        ...activeDocument.querySelectorAll<HTMLElement>('.abyss-modal .abyss-context-item'),
      ].find((item) => item.textContent === 'Show in task list');
      expect(action !== undefined).toBe(enabled);
      if (action !== undefined) {
        click(action);
        expect(callback).toHaveBeenCalledWith(
          { type: 'task', ref: snapshot.ref },
          expect.anything(),
        );
        expect(expectDefined(callback.mock.calls[0]?.[1]).isCurrent()).toBe(true);
      }
    } finally {
      modal.close();
    }
  },
);
