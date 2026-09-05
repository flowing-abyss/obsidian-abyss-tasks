import type * as ObsidianModule from 'obsidian';
import { Notice, requireApiVersion, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskApplicationApi, TaskCommandResult } from '../src/tasks';
import * as resultPresenter from '../src/ui/taskCommandResult';
import { presentTaskMutationResult, presentTaskUndoNotice } from '../src/ui/taskUndoNotice';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  taskQueryApi,
} from './helpers';

const compatibility = vi.hoisted(() => ({ hasContainer: true }));

// The upstream test mock clones fragments and never hides a Notice. This boundary
// double models native attachment/dismissal while retaining our actual button logic.
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return {
    ...actual,
    requireApiVersion: vi.fn(() => compatibility.hasContainer),
    Notice: vi.fn(
      class {
        private readonly element = activeDocument.body.createDiv({ cls: 'test-undo-notice' });
        get containerEl(): HTMLElement {
          if (!compatibility.hasContainer) throw new Error('containerEl is unavailable');
          return this.element;
        }
        readonly messageEl = this.element.createDiv();
        private readonly timer: number | undefined;
        constructor(message: string | DocumentFragment, duration?: number) {
          this.messageEl.append(message);
          if (duration !== undefined && duration > 0)
            this.timer = window.setTimeout(() => {
              this.hide();
            }, duration);
        }
        hide(): void {
          this.element.remove();
          if (this.timer !== undefined) window.clearTimeout(this.timer);
        }
        setMessage(message: string | DocumentFragment): this {
          this.messageEl.replaceChildren(message);
          return this;
        }
      },
    ),
  };
});

afterEach(() => {
  activeDocument.querySelectorAll('.test-undo-notice, .undo-focus-fixture').forEach((node) => {
    node.remove();
  });
  compatibility.hasContainer = true;
  vi.useRealTimers();
});

const ref = { filePath: 'tasks.md', line: 0, revision: 'committed' };
const success: TaskCommandResult = { type: 'ok', changed: true, outcome: { type: 'deleted', ref } };

function noticeContainer(notice: Notice): HTMLElement {
  if (requireApiVersion('1.8.7')) return notice.containerEl;
  throw new Error('This assertion requires a current Notice');
}

function undoButton(notice: Notice): HTMLButtonElement {
  return expectDefined(noticeContainer(notice).querySelector<HTMLButtonElement>('button'));
}

describe('task Undo Notice', () => {
  it('keeps Undo working on older supported Obsidian without accessing newer Notice properties', async () => {
    compatibility.hasContainer = false;
    const execute = vi.fn(async () => success);
    presentTaskUndoNotice({ message: 'Sub-task deleted.', execute });
    const button = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.test-undo-notice button'),
    );
    button.focus();
    expect(activeDocument.activeElement).toBe(button);
    button.click();
    expect(button.disabled).toBe(true);
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledOnce();
    expect(activeDocument.querySelector('.test-undo-notice')).toBeNull();
  });

  it('offers one native focusable Undo action, guards in-flight clicks, and restores invoking row focus', async () => {
    const row = activeDocument.body.createDiv({
      cls: 'abyss-subtask-row undo-focus-fixture',
      attr: { tabindex: '0' },
    });
    const invoking = row.createEl('button');
    invoking.focus();
    const pending = deferred<TaskCommandResult>();
    const execute = vi.fn(() => pending.promise);
    const notice = presentTaskUndoNotice({ message: 'Sub-task deleted.', execute });
    expect(Notice).toHaveBeenCalledOnce();
    expect(vi.mocked(Notice).mock.calls[0]?.[0]).toBeInstanceOf(DocumentFragment);
    expect(noticeContainer(notice).textContent).toContain('Sub-task deleted.');
    const button = undoButton(notice);
    expect(button.textContent).toBe('Undo');
    expect(noticeContainer(notice).querySelectorAll('button')).toHaveLength(1);
    expect(button.tabIndex).toBe(0);
    expect(button.classList.contains('mod-cta')).toBe(true);
    button.focus();
    expect(activeDocument.activeElement).toBe(button);
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(button.disabled).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    pending.resolve(success);
    await flushMicrotasks();
    expect(noticeContainer(notice).isConnected).toBe(false);
    expect(activeDocument.activeElement).toBe(row);
    expect(Notice).toHaveBeenCalledOnce();
  });

  it('leaves the committed mutation intact when its Notice times out', async () => {
    vi.useFakeTimers();
    let committed = true;
    const notice = presentTaskUndoNotice({
      message: 'Dependency removed.',
      execute: async () => {
        committed = false;
        return success;
      },
    });
    expect(vi.mocked(Notice).mock.calls[0]?.[1]).toBeGreaterThan(0);
    await vi.runAllTimersAsync();
    expect(noticeContainer(notice).isConnected).toBe(false);
    expect(committed).toBe(true);
  });

  it('hides the success Notice and presents a failed inverse exactly once through the existing boundary', async () => {
    const failed: TaskCommandResult = { type: 'not-found', target: { type: 'task', ref } };
    const present = vi.spyOn(resultPresenter, 'presentTaskCommandResult');
    const pending = deferred<TaskCommandResult>();
    const execute = vi.fn(() => pending.promise);
    const notice = presentTaskUndoNotice({
      message: 'Dependency removed.',
      execute,
    });
    const button = undoButton(notice);
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    pending.resolve(failed);
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledExactlyOnceWith(failed);
    expect(noticeContainer(notice).isConnected).toBe(false);
    expect(Notice).toHaveBeenCalledTimes(2);
    expect(activeDocument.querySelectorAll('.test-undo-notice')).toHaveLength(1);
    expect(activeDocument.querySelector('.test-undo-notice')?.textContent).toBe(
      'This task no longer exists.',
    );
  });

  it.each(['throw', 'reject'] as const)(
    'logs one unexpected %s and emits one established error Notice after duplicate clicks',
    async (kind) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const present = vi.spyOn(resultPresenter, 'presentTaskCommandResult');
      const failure = new Error('unexpected failure');
      const pending = deferred<void>();
      const execute = vi.fn(() => {
        if (kind === 'throw') throw failure;
        return pending.promise.then(() => {
          throw failure;
        });
      });
      const notice = presentTaskUndoNotice({
        message: 'Sub-task deleted.',
        execute,
      });
      const button = undoButton(notice);
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (kind === 'reject') pending.resolve();
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Undo failed', {
        operation: 'undo',
        cause: failure,
      });
      expect(present).toHaveBeenCalledExactlyOnceWith({
        type: 'io-error',
        cause: 'undo-error',
        contentState: 'unknown',
      });
      expect(noticeContainer(notice).isConnected).toBe(false);
      expect(Notice).toHaveBeenCalledTimes(2);
      expect(activeDocument.querySelectorAll('.test-undo-notice')).toHaveLength(1);
      expect(activeDocument.querySelector('.test-undo-notice')?.textContent).toBe(
        'Failed to update task. Please try again.',
      );
    },
  );

  it('does not focus an invoking row that was removed before Undo finishes', async () => {
    const row = activeDocument.body.createDiv({
      cls: 'abyss-subtask-row undo-focus-fixture',
      attr: { tabindex: '0' },
    });
    row.focus();
    const focus = vi.spyOn(row, 'focus');
    const notice = presentTaskUndoNotice({
      message: 'Sub-task deleted.',
      execute: async () => success,
    });
    row.remove();
    undoButton(notice).click();
    await flushMicrotasks();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('committed mutation inverses', () => {
  it('undoes an added dependency using the fresh dependent reference and retains its lazily allocated ID', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '\n- [ ] Blocker\n- [ ] Dependent\n' });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const nodes = h.index.listNodes();
      const result = await h.tasks.execute({
        type: 'add-dependency',
        blocker: expectDefined(nodes[0]).target,
        dependent: expectDefined(nodes[1]).target,
      });
      if (result.type !== 'ok' || result.outcome.type !== 'dependency')
        throw new Error('add failed');
      const execute = vi.spyOn(h.tasks, 'execute');
      presentTaskMutationResult(h.tasks, result);
      expectDefined(
        activeDocument.querySelector<HTMLButtonElement>('.test-undo-notice button'),
      ).click();
      await flushMicrotasks(20);
      expect(execute).toHaveBeenCalledExactlyOnceWith({
        type: 'remove-dependency',
        dependent: result.outcome.dependent.target,
        dependencyId: result.outcome.dependencyId,
      });
      const blocker = expectDefined(
        h.index.listNodes().find(({ node }) => node.title === 'Blocker'),
      );
      expect(blocker.node.dependencyId).toBe(result.outcome.dependencyId);
      expect(
        h.index.listNodes().find(({ node }) => node.title === 'Dependent')?.node.dependsOn,
      ).toEqual([]);
      expect(Notice).toHaveBeenCalledOnce();
    } finally {
      h.index.destroy();
    }
  });

  it.each(['missing', 'ambiguous'] as const)(
    'restores an authored %s ID with its exact order and duplicates without blocker resolution',
    async (kind) => {
      const blockers = kind === 'ambiguous' ? '- [ ] First 🆔 raw\n- [ ] Second 🆔 raw\n' : '';
      const app = await createAppWithFiles({
        'tasks.md': `\n${blockers}- [ ] Dependent ⛔ first, raw, raw, last\n`,
      });
      const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await h.index.initialize();
      try {
        const dependent = expectDefined(
          h.index.listNodes().find(({ node }) => node.title === 'Dependent'),
        );
        const result = await h.tasks.execute({
          type: 'remove-dependency',
          dependent: dependent.target,
          dependencyId: 'raw',
        });
        if (result.type !== 'ok' || result.outcome.type !== 'dependency')
          throw new Error('remove failed');
        expect(result.outcome.blocker).toBeUndefined();
        const execute = vi.spyOn(h.tasks, 'execute');
        presentTaskMutationResult(h.tasks, result);
        expectDefined(
          activeDocument.querySelector<HTMLButtonElement>('.test-undo-notice button'),
        ).click();
        await flushMicrotasks(20);
        expect(execute).toHaveBeenCalledExactlyOnceWith({
          type: 'restore-dependency',
          dependent: result.outcome.dependent.target,
          recovery: {
            dependencyId: 'raw',
            beforeIds: ['first', 'raw', 'raw', 'last'],
            afterIds: ['first', 'last'],
            source: {
              before: '- [ ] Dependent ⛔ first, raw, raw, last',
              after: '- [ ] Dependent ⛔ first, last',
            },
          },
        });
        const file = app.vault.getAbstractFileByPath('tasks.md');
        if (!(file instanceof TFile)) throw new Error('missing fixture');
        expect(await app.vault.read(file)).toBe(
          `\n${blockers}- [ ] Dependent ⛔ first, raw, raw, last\n`,
        );
        expect(Notice).toHaveBeenCalledOnce();
      } finally {
        h.index.destroy();
      }
    },
  );

  it('does not offer an inverse for a no-op or an unsupported root deletion', () => {
    const tasks: TaskApplicationApi = { queries: taskQueryApi(), execute: async () => success };
    presentTaskMutationResult(tasks, { ...success, changed: false });
    presentTaskMutationResult(tasks, success);
    expect(Notice).not.toHaveBeenCalled();
  });
});
