import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import {
  describeTaskCreationResult,
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

function secondaryDocument(): {
  readonly frame: HTMLIFrameElement;
  readonly ownerDocument: Document;
} {
  const frame = activeDocument.createElement('iframe');
  activeDocument.body.append(frame);
  const ownerDocument = frame.contentDocument;
  if (!ownerDocument?.defaultView) throw new Error('secondary document unavailable');
  for (const method of ['createDiv', 'createEl'] as const) {
    Object.defineProperty(ownerDocument.defaultView.HTMLElement.prototype, method, {
      configurable: true,
      value: HTMLElement.prototype[method],
    });
  }
  return { frame, ownerDocument };
}

const invalidDeleteTask = {
  status: 'open',
  recurrence: 'tomorrow',
  onCompletion: 'delete',
} as const;

function ownershipHarness(): {
  readonly port: InteractionOwnershipPort;
  readonly acquire: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const acquire = vi.fn(() => ({ release }));
  return { port: { acquire }, acquire, release };
}

describe('task command result presentation', () => {
  beforeEach(() => {
    (Notice as unknown as { mock: { calls: unknown[][] } }).mock.calls = [];
  });

  afterEach(() => {
    activeDocument
      .querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm button')
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

      const surface = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
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
      expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
    },
  );

  it.each(['Cancel', 'Escape', 'backdrop'] as const)(
    'owns the invalid Delete alertdialog until %s and releases exactly once',
    async (dismissal) => {
      const ownership = ownershipHarness();
      const completion = requestTaskCompletion(invalidDeleteTask, vi.fn(), ownership.port);
      const surface = activeDocument.querySelector<HTMLElement>(
        '.abyss-recurrence-delete-confirm',
      )!;
      const cancel = Array.from(surface.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent === 'Cancel',
      )!;

      expect(ownership.acquire).toHaveBeenCalledOnce();
      expect(ownership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
      expect(ownership.release).not.toHaveBeenCalled();

      if (dismissal === 'Cancel') {
        cancel.click();
      } else if (dismissal === 'Escape') {
        activeDocument.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      } else {
        surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      await completion;

      cancel.click();
      activeDocument.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(ownership.release).toHaveBeenCalledOnce();
    },
  );

  it('releases the alertdialog owner once before a confirmed mutation settles', async () => {
    const ownership = ownershipHarness();
    const pending = deferred();
    const mutation = vi.fn().mockReturnValue(pending.promise);
    const completion = requestTaskCompletion(invalidDeleteTask, mutation, ownership.port);
    const confirm = activeDocument.querySelector<HTMLButtonElement>(
      '.abyss-recurrence-delete-confirm-button',
    )!;

    confirm.click();
    confirm.click();
    await Promise.resolve();

    expect(ownership.release).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
    pending.resolve();
    await completion;
    expect(ownership.release).toHaveBeenCalledOnce();
  });

  it('releases the previous owner when a newer alertdialog replaces it', async () => {
    const firstOwnership = ownershipHarness();
    const secondOwnership = ownershipHarness();
    const first = requestTaskCompletion(invalidDeleteTask, vi.fn(), firstOwnership.port);
    const second = requestTaskCompletion(invalidDeleteTask, vi.fn(), secondOwnership.port);

    await first;
    expect(firstOwnership.release).toHaveBeenCalledOnce();
    expect(secondOwnership.acquire).toHaveBeenCalledOnce();
    expect(secondOwnership.release).not.toHaveBeenCalled();

    activeDocument
      .querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm button')
      ?.click();
    await second;
    expect(secondOwnership.release).toHaveBeenCalledOnce();
  });

  it('does not dismiss a live alertdialog for an already-aborted replacement request', async () => {
    const liveOwnership = ownershipHarness();
    const staleOwnership = ownershipHarness();
    const live = requestTaskCompletion(invalidDeleteTask, vi.fn(), liveOwnership.port);
    const liveSurface = activeDocument.querySelector<HTMLElement>(
      '.abyss-recurrence-delete-confirm',
    )!;
    const staleController = new AbortController();
    staleController.abort();

    await requestTaskCompletion(
      invalidDeleteTask,
      vi.fn(),
      staleOwnership.port,
      staleController.signal,
    );

    expect(liveSurface.isConnected).toBe(true);
    expect(liveOwnership.release).not.toHaveBeenCalled();
    expect(staleOwnership.acquire).not.toHaveBeenCalled();
    liveSurface.querySelector<HTMLButtonElement>('button')?.click();
    await live;
    expect(liveOwnership.release).toHaveBeenCalledOnce();
  });

  it('cleans up in the opening document realm after activeDocument changes', async () => {
    const originalActiveDocument = activeDocument;
    const { frame, ownerDocument } = secondaryDocument();
    const ownerWindow = ownerDocument.defaultView!;
    const ownership = ownershipHarness();
    try {
      vi.stubGlobal('activeDocument', ownerDocument);
      const trigger = ownerDocument.createElement('button');
      ownerDocument.body.append(trigger);
      trigger.focus();
      const completion = requestTaskCompletion(invalidDeleteTask, vi.fn(), ownership.port);
      const surface = ownerDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm')!;
      vi.stubGlobal('activeDocument', originalActiveDocument);

      ownerDocument.dispatchEvent(
        new ownerWindow.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await completion;

      expect(surface.isConnected).toBe(false);
      expect(ownerDocument.activeElement).toBe(trigger);
      expect(ownership.release).toHaveBeenCalledOnce();
      const afterCleanup = new ownerWindow.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      ownerDocument.dispatchEvent(afterCleanup);
      expect(afterCleanup.defaultPrevented).toBe(false);
    } finally {
      vi.stubGlobal('activeDocument', originalActiveDocument);
      frame.remove();
    }
  });

  it('removes the old document listener when a second-document alertdialog replaces it', async () => {
    const originalActiveDocument = activeDocument;
    const { frame, ownerDocument } = secondaryDocument();
    const ownerWindow = ownerDocument.defaultView!;
    try {
      vi.stubGlobal('activeDocument', ownerDocument);
      const first = requestTaskCompletion(invalidDeleteTask, vi.fn());
      vi.stubGlobal('activeDocument', originalActiveDocument);

      const second = requestTaskCompletion(invalidDeleteTask, vi.fn());
      await first;
      activeDocument
        .querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm button')
        ?.click();
      await second;

      const afterReplacement = new ownerWindow.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      ownerDocument.dispatchEvent(afterReplacement);
      expect(afterReplacement.defaultPrevented).toBe(false);
    } finally {
      vi.stubGlobal('activeDocument', originalActiveDocument);
      frame.remove();
    }
  });

  it('removes and releases an alertdialog idempotently on external teardown', async () => {
    const ownership = ownershipHarness();
    const controller = new AbortController();
    const mutation = vi.fn();
    const completion = requestTaskCompletion(
      invalidDeleteTask,
      mutation,
      ownership.port,
      controller.signal,
    );
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    controller.abort();
    controller.abort();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(mutation).not.toHaveBeenCalled();
    expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
    expect(ownership.release).toHaveBeenCalledOnce();
  });

  it('does not acquire an owner when no confirmation surface is needed', async () => {
    const ownership = ownershipHarness();
    const mutation = vi.fn();

    await requestTaskCompletion({ status: 'open', onCompletion: 'keep' }, mutation, ownership.port);

    expect(mutation).toHaveBeenCalledOnce();
    expect(ownership.acquire).not.toHaveBeenCalled();
    expect(ownership.release).not.toHaveBeenCalled();
  });

  it('contains bidirectional Tab focus and restores the trigger on Escape', async () => {
    const trigger = activeDocument.body.createEl('button', { text: 'Complete task' });
    trigger.focus();
    const completion = requestTaskCompletion(invalidDeleteTask, vi.fn());
    const surface = activeDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm')!;
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
      .querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm-button')
      ?.click();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(mutation).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
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

  describe('describeTaskCreationResult', () => {
    const createdTask = { source: { filePath: 'daily/2026-07-14.md' } } as TaskSnapshot;

    it.each([
      [
        'ok',
        {
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: createdTask },
        },
        {
          kind: 'success',
          message: 'Task added to 2026-07-14.md',
          ariaLive: 'polite',
          task: createdTask,
          requiresRecovery: false,
        },
      ],
      [
        'invalid title',
        { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] },
        {
          kind: 'error',
          message: 'The new task is invalid and was not created.',
          ariaLive: 'assertive',
          requiresRecovery: false,
        },
      ],
      [
        'unavailable destination',
        {
          type: 'invalid',
          issues: [{ code: 'destination-unavailable', field: 'destination' }],
        },
        {
          kind: 'error',
          message: 'No target file found for task.',
          ariaLive: 'assertive',
          requiresRecovery: true,
        },
      ],
      [
        'conflict',
        { type: 'conflict', current: {} },
        {
          kind: 'error',
          message: 'This task changed before the update could be applied.',
          ariaLive: 'assertive',
          requiresRecovery: true,
        },
      ],
      [
        'ambiguous',
        { type: 'ambiguous', candidates: [] },
        {
          kind: 'error',
          message: 'Multiple matching tasks were found. Reopen the task and try again.',
          ariaLive: 'assertive',
          requiresRecovery: true,
        },
      ],
      [
        'not-found',
        { type: 'not-found', target: {} },
        {
          kind: 'error',
          message: 'This task no longer exists.',
          ariaLive: 'assertive',
          requiresRecovery: true,
        },
      ],
      [
        'I/O failure',
        { type: 'io-error', cause: 'process-error', contentState: 'unknown' },
        {
          kind: 'error',
          message: 'Failed to create task. Please try again.',
          ariaLive: 'assertive',
          requiresRecovery: true,
        },
      ],
    ] as const)('describes %s without presentation side effects', (_name, result, expected) => {
      expect(describeTaskCreationResult(result as TaskCommandResult)).toEqual(expected);
      expect(noticeCalls()).toHaveLength(0);
    });
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
