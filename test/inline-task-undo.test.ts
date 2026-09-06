import { afterEach, expect, it, vi } from 'vitest';
import type { TaskCommandResult } from '../src/tasks';
import { createInlineTaskUndo } from '../src/ui/inlineTaskUndo';
import * as presenter from '../src/ui/taskCommandResult';
import { deferred, expectDefined } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  activeDocument.body.empty();
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
  await vi.advanceTimersByTimeAsync(7999);
  expect(button.isConnected).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(button.isConnected).toBe(false);
  action.clear();
});
