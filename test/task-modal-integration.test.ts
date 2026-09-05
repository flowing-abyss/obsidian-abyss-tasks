import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskApplicationApi,
  TaskCommand,
  TaskDependencyQueryApi,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSnapshot,
} from '../src/tasks';
import { TaskModal } from '../src/ui/TaskModal';
import {
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  methodOf,
  task,
  taskComment,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

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

describe('TaskModal with real RightPanel', () => {
  let modal: TaskModal | undefined;

  afterEach(() => {
    modal?.close();
    activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
      element.remove();
    });
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
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

    listener?.({ type: 'changed', files: ['f.md'] });

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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      resolution = {
        type: 'rebased',
        previous: observed,
        current,
        evidence: 'authority-transition',
        basis: { observed },
      };
      listener?.({ type: 'changed', files: ['f.md'] });
      await blocked;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
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
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'submitted first';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
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

    listener?.({ type: 'changed', files: ['f.md'] });

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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let finish!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'submitted';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    input.focus();
    input.setSelectionRange(2, 7);
    resolution = {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    };

    listener?.({ type: 'changed', files: ['f.md'] });
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
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
      listener?.({ type: 'changed', files: ['f.md'] });
      await blocked;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
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
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(observed);
    const input = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    input.value = 'rollback me';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    resolution = {
      type: 'rebased',
      previous: observed,
      current: candidate,
      evidence: 'authority-transition',
      basis: { observed },
    };
    listener?.({ type: 'changed', files: ['f.md'] });

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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
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
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
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
    listener?.({ type: 'changed', files: ['f.md'] });
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
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'conflict',
        current: observed,
      }),
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
      let listener: ((event: TaskIndexEvent) => void) | undefined;
      let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
      let release!: () => void;
      const blocked = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      const queries = taskQueryApi({
        resolve: () => resolution,
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      });
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
        resolution = {
          type: 'rebased',
          previous: observed,
          current,
          evidence: 'authority-transition',
          basis: { observed },
        };
        listener?.({ type: 'changed', files: ['f.md'] });
        await blocked;
        return { type: 'ok', changed: true, outcome: { type: 'task', task: current } };
      });
      modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
        queries,
        execute,
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    const queries = taskQueryApi({
      list: (query) => (query?.filePath === 'renamed.md' ? [renamed] : []),
      resolve: () => ({ type: 'not-found', ref: observed.ref }),
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
    });
    modal.open(observed);
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'rename-safe draft';
    comment.focus();

    listener?.({ type: 'renamed', oldPath: 'old.md', newPath: 'renamed.md' });

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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    const queries = taskQueryApi({
      resolve: () => ({
        type: 'visual',
        stale: observed.ref,
        current,
        evidence: 'same-line',
      }),
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(observed);
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'stale modal draft';

    listener?.({ type: 'changed', files: ['f.md'] });

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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: observed, basis: { observed } };
    const queries = taskQueryApi({
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(observed);
    const comment = expectDefined(
      activeDocument.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
    );
    comment.value = 'local unsaved';
    comment.focus();
    resolution = { type: 'not-found', ref: observed.ref };

    listener?.({ type: 'changed', files: ['f.md'] });

    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    expect(
      activeDocument.querySelector('.abyss-modal .abyss-detached-draft')?.textContent,
    ).toContain('local unsaved');
    expect(execute).not.toHaveBeenCalled();
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
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: current, basis: { observed: current } };
    const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
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
    modal = new TaskModal(app, registry, DEFAULT_SETTINGS, queries, tasks);

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
    listener?.({ type: 'changed', files: ['f.md'] });

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
    const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: current },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
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
    const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
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
    const queries: TaskQueryApi & TaskDependencyQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
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
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
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
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
    });
    modal.open(current);

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
    owned.dispatchEvent(escape);
    await flushMicrotasks();

    expect(escape.defaultPrevented).toBe(true);
    expect(activeDocument.querySelector(`.abyss-modal ${entry.ownedSelector}`)).toBeNull();
    expect(activeDocument.querySelector('.abyss-modal-backdrop')).not.toBeNull();
  });
});
