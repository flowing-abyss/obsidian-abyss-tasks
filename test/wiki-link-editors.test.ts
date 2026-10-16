import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommandResult } from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { QuickCaptureCoordinator } from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { appWithFiles, expectDefined, flushMicrotasks, task, useRealMoment } from './helpers';
import { inspectorCleanups, inspectorHarness } from './support/inspectorHarness';

useRealMoment();
vi.mock('../src/ui/textFieldAnchor', () => ({
  textFieldAnchor: () => new DOMRect(100, 100, 1, 20),
  textFieldViewport: () => new DOMRect(0, 0, 1000, 800),
}));
afterEach(() => {
  for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  document.body.empty();
});
const notes = { 'Alpha.md': '', 'Alpine.md': '' };
function key(input: HTMLElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
async function complete(
  input: HTMLInputElement | HTMLTextAreaElement,
  pointer: boolean,
): Promise<void> {
  input.focus();
  input.value = 'Draft [[Al';
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.abyss-link-suggest-option')).toHaveLength(2);
  });
  if (pointer) {
    const option = expectDefined(
      document.querySelectorAll<HTMLElement>('.abyss-link-suggest-option')[1],
    );
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    option.click();
  } else {
    key(input, 'ArrowDown');
    key(input, 'Enter');
  }
  expect(input.value).toBe('Draft [[Alpine]]');
  expect(input.selectionStart).toBe(input.value.length);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(document.activeElement).toBe(input);
}

describe('wiki links across task owners', () => {
  it.each([false, true])(
    'Q completion edits only the draft, including portal ownership (pointer=%s)',
    async (pointer) => {
      const app = appWithFiles(notes);
      vi.spyOn(app.fileManager, 'generateMarkdownLink').mockImplementation(
        (file) => `[[${file.basename}]]`,
      );
      const execute = vi.fn((): Promise<TaskCommandResult> =>
        Promise.resolve({
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: task({ title: 'Captured' }) },
        }),
      );
      const coordinator = new QuickCaptureCoordinator({
        app,
        host: document.body.createDiv(),
        context: () => ({ type: 'list', selection: 'inbox' }),
        interactionOwnership: noInteractionOwnership,
        resolveTarget: () =>
          Promise.resolve({
            context: { type: 'list', selection: 'inbox' },
            label: 'Inbox',
            markdownPrefix: '',
            markdownSuffixes: [],
            session: {
              type: 'ready',
              destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
              preview: () => ({ type: 'unavailable', cause: 'preview-capability' }),
              execute,
            },
          }),
      });
      try {
        coordinator.openOrFocus();
        await flushMicrotasks();
        const input = expectDefined(
          document.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
        );
        await complete(input, pointer);
        expect(execute).not.toHaveBeenCalled();
        expect(coordinator.phase).toBe('open');
        key(input, 'Enter');
        await vi.waitFor(() => {
          expect(execute).toHaveBeenCalledOnce();
        });
      } finally {
        coordinator.destroy();
      }
    },
  );

  const fields = [
    ['title', '.abyss-right-title-view', '.abyss-right-title-edit'],
    ['description', '.abyss-right-desc-view', '.abyss-right-desc-edit'],
    ['new subtask', '.abyss-subtask-add-row', '.abyss-subtask-new-input'],
    ['new comment', '', '.abyss-comment-input'],
    ['edited comment', '.abyss-comment-text', '.abyss-comment-edit-input'],
    ['existing subtask', '.abyss-right-title-view', '.abyss-right-title-edit'],
  ] as const;
  it.each(fields)(
    'selects a link in %s and saves only on the following Enter',
    async (name, open, selector) => {
      const h = await inspectorHarness(
        '- [ ] Current\n  Description before\n  - [ ] Existing child\n  - 2026-07-13: Old comment',
        name === 'existing subtask' ? 'Existing child' : 'Current',
        notes,
      );
      vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockImplementation(
        (file) => `[[${file.basename}]]`,
      );
      const before = await h.read();
      if (open !== '') expectDefined(h.el.querySelector<HTMLElement>(open)).click();
      await flushMicrotasks();
      const input = expectDefined(
        h.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector),
      );
      await complete(input, name.includes('comment') || name === 'new subtask');
      expect(await h.read()).toBe(before);
      key(input, 'Enter');
      await vi.waitFor(async () => {
        expect(await h.read()).toContain('Draft [[Alpine]]');
      });
    },
  );
});
