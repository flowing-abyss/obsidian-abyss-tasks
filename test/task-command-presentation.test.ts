import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskApplicationApi, TaskCommandResult } from '../src/tasks';
import {
  presentTaskCommandResult,
  presentTaskCreationResult,
  presentTaskMoveResult,
  requestTaskCompletion,
} from '../src/ui/taskCommandResult';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

function noticeCalls(): unknown[][] {
  return (Notice as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
}

const invalidDeleteTask = {
  status: 'open',
  recurrence: 'tomorrow',
  onCompletion: 'delete',
} as const;

describe('task command result presentation', () => {
  beforeEach(() => {
    (Notice as unknown as { mock: { calls: unknown[][] } }).mock.calls = [];
  });

  afterEach(() => {
    activeDocument
      .querySelector<HTMLButtonElement>('.tc-recurrence-delete-confirm button')
      ?.click();
  });

  it.each(['Cancel', 'Escape', 'backdrop'] as const)(
    'settles invalid Delete confirmation through %s without invoking the mutation',
    async (dismissal) => {
      const mutation = vi.fn().mockResolvedValue(undefined);
      const completion = requestTaskCompletion(invalidDeleteTask, mutation);
      let settled = false;
      void completion.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);

      const surface = activeDocument.querySelector<HTMLElement>('.tc-recurrence-delete-confirm')!;
      if (dismissal === 'Cancel') {
        Array.from(surface.querySelectorAll<HTMLButtonElement>('button'))
          .find((candidate) => candidate.textContent === 'Cancel')
          ?.click();
      } else if (dismissal === 'Escape') {
        activeDocument.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      } else {
        surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      await completion;
      expect(settled).toBe(true);
      expect(mutation).not.toHaveBeenCalled();
      expect(activeDocument.querySelector('.tc-recurrence-delete-confirm')).toBeNull();
    },
  );

  it('contains bidirectional Tab focus and restores the trigger on Escape', async () => {
    const trigger = activeDocument.body.createEl('button', { text: 'Complete task' });
    trigger.focus();
    const completion = requestTaskCompletion(invalidDeleteTask, vi.fn());
    const surface = activeDocument.querySelector<HTMLElement>('.tc-recurrence-delete-confirm')!;
    const [cancel, confirm] = Array.from(surface.querySelectorAll<HTMLButtonElement>('button'));

    expect(activeDocument.activeElement).toBe(cancel);
    cancel!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(activeDocument.activeElement).toBe(confirm);
    confirm!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(activeDocument.activeElement).toBe(cancel);

    activeDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await completion;
    expect(activeDocument.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('keeps an ordinary completion pending until its application command settles', async () => {
    const pending = deferred();
    const mutation = vi.fn().mockReturnValue(pending.promise);
    const completion = requestTaskCompletion({ status: 'open', onCompletion: 'keep' }, mutation);
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(mutation).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    pending.resolve();
    await completion;
    expect(settled).toBe(true);
  });

  it('keeps a confirmed invalid Delete completion pending until its application command settles', async () => {
    const pending = deferred();
    const mutation = vi.fn().mockReturnValue(pending.promise);
    const trigger = activeDocument.body.createEl('button', { text: 'Complete task' });
    trigger.focus();
    const completion = requestTaskCompletion(invalidDeleteTask, mutation);
    activeDocument
      .querySelector<HTMLButtonElement>('.tc-recurrence-delete-confirm-button')
      ?.click();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(mutation).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(activeDocument.querySelector('.tc-recurrence-delete-confirm')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);
    pending.resolve();
    await completion;
    expect(settled).toBe(true);
    trigger.remove();
  });

  it.each([
    ['conflict', { type: 'conflict', current: {} }],
    ['not-found', { type: 'not-found', target: {} }],
    ['ambiguous', { type: 'ambiguous', candidates: [] }],
    ['invalid', { type: 'invalid', issues: [] }],
    ['io-error', { type: 'io-error', cause: 'x', contentState: 'unknown' }],
  ] as const)('shows a presentation-owned Notice for %s', (_type, partial) => {
    presentTaskCommandResult(partial as TaskCommandResult);
    expect(noticeCalls()).toHaveLength(1);
  });

  it.each([
    { type: 'task', task: {} as never },
    { type: 'deleted', ref: {} as never },
    {
      type: 'recurrence',
      active: { root: {} as never, target: {} as never },
      completed: { root: {} as never, target: {} as never },
    },
  ] as const)('keeps a successful $type command silent', (outcome) => {
    presentTaskCommandResult({ type: 'ok', changed: false, outcome });
    expect(noticeCalls()).toHaveLength(0);
  });

  it('warns against retrying a move when the target commit state is unknown', () => {
    presentTaskMoveResult({} as App, {} as TaskApplicationApi, {
      type: 'io-error',
      cause: 'process-error',
      path: 'Projects/P.md',
      contentState: 'unknown',
    });

    expect(noticeCalls()).toEqual([
      [
        'Could not confirm whether the move to Projects/P.md was saved. Rescan and inspect the target and original task before taking any action. Do not retry the move.',
      ],
    ]);
  });

  it('preserves ordinary retry wording when a move failure is confirmed unchanged', () => {
    presentTaskMoveResult({} as App, {} as TaskApplicationApi, {
      type: 'io-error',
      cause: 'read-error',
      path: 'source.md',
      contentState: 'unchanged',
    });

    expect(noticeCalls()).toEqual([['Failed to update task. Please try again.']]);
  });

  it('announces a successful task creation with only its destination filename', () => {
    presentTaskCreationResult({
      type: 'ok',
      changed: true,
      outcome: {
        type: 'task',
        task: { source: { filePath: 'daily/2026-07-14.md' } } as never,
      },
    });
    expect(noticeCalls()).toEqual([['Task added to 2026-07-14.md']]);
  });

  it.each([
    [
      'an unavailable destination',
      {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      },
      'No target file found for task.',
    ],
    [
      'an I/O failure',
      { type: 'io-error', cause: 'process-error', contentState: 'unknown' },
      'Failed to create task. Please try again.',
    ],
    [
      'invalid task input',
      { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] },
      'The new task is invalid and was not created.',
    ],
  ] as const)('uses creation-specific language for %s', (_name, result, message) => {
    presentTaskCreationResult(result as TaskCommandResult);
    expect(noticeCalls()).toEqual([[message]]);
  });
});
