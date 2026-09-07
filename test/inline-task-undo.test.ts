import { afterEach, expect, it, vi } from 'vitest';
import type { TaskCommandResult } from '../src/tasks';
import { createInlineTaskUndo } from '../src/ui/inlineTaskUndo';
import * as presenter from '../src/ui/taskCommandResult';
import { deferred, expectDefined, flushMicrotasks } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  activeDocument.body.empty();
});

it('renders a dependency Undo action with a separate muted five-second hint', () => {
  const container = activeDocument.body.createDiv();
  container.createDiv({ cls: 'abyss-dep-list' });
  const action = createInlineTaskUndo();
  action.show(container, { list: '.abyss-dep-list', index: 0, title: 'Removed' }, async () => ({
    type: 'io-error',
    cause: 'test',
    contentState: 'unchanged',
  }));

  const row = expectDefined(container.querySelector<HTMLElement>('.abyss-undo-row'));
  expect(row.textContent).toBe('Dependency removedUndo(5s)');
  expect(row.querySelector('button')?.textContent).toBe('Undo');
  const hint = expectDefined(row.querySelector<HTMLElement>('span'));
  expect(hint.textContent).toBe('(5s)');
  expect(hint.className).toBe('');
  expect(hint.matches('span')).toBe(true);
});

it('expires a fresh Undo exactly five seconds after showing it', async () => {
  vi.useFakeTimers();
  const container = activeDocument.body.createDiv();
  container.createDiv({ cls: 'list' });
  const action = createInlineTaskUndo();
  action.show(container, { list: '.list', index: 0, title: 'Removed' }, async () => ({
    type: 'io-error',
    cause: 'test',
    contentState: 'unchanged',
  }));

  const button = expectDefined(container.querySelector('button'));
  await vi.advanceTimersByTimeAsync(4_999);
  expect(button.isConnected).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(button.isConnected).toBe(false);
});

it('keeps a slow failed inverse actionable with a fresh lifetime and one error boundary', async () => {
  vi.useFakeTimers();
  const container = activeDocument.body.createDiv();
  container.createDiv({ cls: 'abyss-subtask-list' });
  const action = createInlineTaskUndo();
  const pending = deferred<TaskCommandResult>();
  const present = vi.spyOn(presenter, 'presentTaskCommandResult');
  action.show(
    container,
    { list: '.abyss-subtask-list', index: 0, title: 'Missing task' },
    () => pending.promise,
  );
  const button = expectDefined(container.querySelector('button'));
  button.click();
  await vi.advanceTimersByTimeAsync(9000);
  const failed: TaskCommandResult = {
    type: 'io-error',
    cause: 'repository-error',
    contentState: 'unknown',
  };
  pending.resolve(failed);
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector('button')).toBe(button);
  expect(button.disabled).toBe(false);
  expect(present).toHaveBeenCalledExactlyOnceWith(failed);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(button.isConnected).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(button.isConnected).toBe(false);
  action.clear();
});

it.each(['render', 'activation'] as const)(
  'revokes an invalid tombstone before %s',
  async (phase) => {
    const container = activeDocument.body.createDiv();
    container.createDiv({ cls: 'list' });
    const action = createInlineTaskUndo();
    let valid = true;
    const calls: string[] = [];
    action.show(
      container,
      { list: '.list', index: 0, title: 'Removed' },
      async () => {
        calls.push('restore');
        return { type: 'io-error', cause: 'test', contentState: 'unchanged' };
      },
      () => valid,
    );
    const button = expectDefined(container.querySelector('button'));
    valid = false;
    if (phase === 'render') action.render(container);
    button.click();
    await flushMicrotasks();
    expect(calls).toEqual([]);
    expect(button.isConnected).toBe(false);
    action.clear();
  },
);

it('revokes deferred execution when ownership changes before the microtask', async () => {
  const container = activeDocument.body.createDiv();
  container.createDiv({ cls: 'list' });
  const action = createInlineTaskUndo();
  const calls: string[] = [];
  action.show(container, { list: '.list', index: 0, title: 'Removed' }, async () => {
    calls.push('restore');
    return { type: 'io-error', cause: 'test', contentState: 'unchanged' };
  });
  expectDefined(container.querySelector('button')).click();
  action.clear();
  await flushMicrotasks();
  expect(calls).toEqual([]);
});

it('revokes a failed pending tombstone when its evidence changed', async () => {
  const container = activeDocument.body.createDiv();
  container.createDiv({ cls: 'list' });
  const action = createInlineTaskUndo();
  const pending = deferred<TaskCommandResult>();
  const present = vi.spyOn(presenter, 'presentTaskCommandResult');
  let valid = true;
  action.show(
    container,
    { list: '.list', index: 0, title: 'Removed' },
    () => pending.promise,
    () => valid,
  );
  const button = expectDefined(container.querySelector('button'));
  button.click();
  await flushMicrotasks();
  valid = false;
  action.render(container);
  expect(button.disabled).toBe(true);
  expect(button.isConnected).toBe(true);
  const result: TaskCommandResult = {
    type: 'io-error',
    cause: 'repository-error',
    contentState: 'unchanged',
  };
  pending.resolve(result);
  await flushMicrotasks();
  expect(button.isConnected).toBe(false);
  expect(present).toHaveBeenCalledExactlyOnceWith(result);
  action.clear();
});
