import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskApplicationApi, TaskCommandResult, TaskResolution } from '../src/tasks';
import type { MoveRecovery } from '../src/tasks/domain/commands';
import type { TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { TaskMoveRecoveryModal } from '../src/ui/TaskMoveRecoveryModal';
import { moveTaskToProjectWithRecovery } from '../src/ui/moveTaskToProject';
import { presentTaskMoveResult } from '../src/ui/taskCommandResult';
import { createAppWithFiles, flushMicrotasks, taskQueryApi } from './helpers';

const source: TaskRef = { filePath: 'source.md', line: 2, revision: 'old-revision' };

function snapshot(ref: TaskRef, originalBlock = '- [ ] task'): TaskSnapshot {
  return {
    ref,
    title: 'task',
    markdownTitle: 'task',
    status: 'open',
    statusSymbol: ' ',
    priority: 'C',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: ref.filePath,
      line: ref.line,
      originalMarkdown: '- [ ] task',
      originalBlock,
    },
    presentation: { linkCount: 0 },
  };
}

const recovery: MoveRecovery = {
  source,
  targetPath: 'Projects/P.md',
  copiedTask: snapshot({ filePath: 'Projects/P.md', line: 4, revision: 'copy-revision' }),
  state: 'target-copied-source-remains',
  cause: 'conflict',
};

function partial(): TaskCommandResult {
  return { type: 'partial', operation: 'move', recovery };
}

function taskApi(
  resolveResult: TaskResolution,
  executeResult: TaskCommandResult = {
    type: 'ok',
    changed: true,
    outcome: { type: 'deleted', ref: source },
  },
): TaskApplicationApi & {
  queries: TaskApplicationApi['queries'] & { resolve: ReturnType<typeof vi.fn> };
  execute: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn().mockReturnValue(resolveResult);
  const execute = vi.fn().mockResolvedValue(executeResult);
  return {
    queries: taskQueryApi({ resolve }),
    execute,
  } as never;
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${label}`);
  return found;
}

afterEach(() => vi.restoreAllMocks());

function openRecovery(
  app: Awaited<ReturnType<typeof createAppWithFiles>>,
  tasks: TaskApplicationApi,
): TaskMoveRecoveryModal {
  const modal = new TaskMoveRecoveryModal(app, tasks, recovery);
  modal.onOpen();
  return modal;
}

describe('partial move recovery presentation', () => {
  it('routes a project drop through ProjectManager and opens recovery for its partial result', async () => {
    const app = await createAppWithFiles({});
    const tasks = taskApi({ type: 'exact', task: snapshot(source) });
    const manager = { moveTaskToProject: vi.fn().mockResolvedValue(partial()) };
    const open = vi.spyOn(TaskMoveRecoveryModal.prototype, 'open').mockImplementation(() => {});

    await moveTaskToProjectWithRecovery(app, tasks, manager as never, source, 'Projects/P.md');

    expect(manager.moveTaskToProject).toHaveBeenCalledWith(source, 'Projects/P.md');
    expect(open).toHaveBeenCalledOnce();
  });

  it('opens the recovery UI for a partial result instead of treating it as success', async () => {
    const app = await createAppWithFiles({});
    const tasks = taskApi({ type: 'exact', task: snapshot(source) });
    const open = vi.spyOn(TaskMoveRecoveryModal.prototype, 'open').mockImplementation(() => {});

    presentTaskMoveResult(app, tasks, partial());

    expect(open).toHaveBeenCalledOnce();
  });

  it('shows that both copies exist and offers explicit keep-both/remove-original choices', async () => {
    const app = await createAppWithFiles({});
    const tasks = taskApi({ type: 'exact', task: snapshot(source) });

    const modal = openRecovery(app, tasks);

    expect(modal.contentEl.textContent).toContain('Projects/P.md');
    expect(modal.contentEl.textContent).toContain('source.md');
    expect(button(modal.contentEl, 'Keep both')).toBeDefined();
    expect(button(modal.contentEl, 'Remove original')).toBeDefined();
    expect(tasks.queries.resolve).not.toHaveBeenCalled();
    expect(tasks.execute).not.toHaveBeenCalled();

    button(modal.contentEl, 'Keep both').click();
    expect(modal.contentEl.textContent).not.toContain('Remove original');
    expect(tasks.execute).not.toHaveBeenCalled();
  });

  it('resolves immediately before deleting an exact original ref', async () => {
    const app = await createAppWithFiles({});
    const exact = snapshot(source);
    const tasks = taskApi({ type: 'exact', task: exact });
    const modal = openRecovery(app, tasks);

    button(modal.contentEl, 'Remove original').click();
    await flushMicrotasks();

    expect(tasks.queries.resolve).toHaveBeenCalledOnce();
    expect(tasks.queries.resolve).toHaveBeenCalledWith(source);
    expect(tasks.execute).toHaveBeenCalledOnce();
    expect(tasks.execute).toHaveBeenCalledWith({ type: 'delete', ref: exact.ref });
  });

  it('requires a second explicit acceptance before deleting a conflicting newer revision', async () => {
    const app = await createAppWithFiles({});
    const changedBlock = [
      '- [ ] task',
      '  - > description changed after copy',
      '  - 2026-07-14: newer comment',
      '  - [ ] newer child',
    ].join('\n');
    const changed = snapshot({ ...source, revision: 'new-revision' }, changedBlock);
    const tasks = taskApi({ type: 'conflict', current: changed });
    const modal = openRecovery(app, tasks);

    button(modal.contentEl, 'Remove original').click();
    await flushMicrotasks();

    expect(tasks.execute).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('changed since the move');
    expect(modal.contentEl.querySelector('pre')?.textContent).toBe(changedBlock);

    button(modal.contentEl, 'Remove changed original').click();
    await flushMicrotasks();

    expect(tasks.execute).toHaveBeenCalledOnce();
    expect(tasks.execute).toHaveBeenCalledWith({ type: 'delete', ref: changed.ref });
  });

  it('does not claim both copies remain when original removal commit state is unknown', async () => {
    const app = await createAppWithFiles({});
    const exact = snapshot(source);
    const tasks = taskApi(
      { type: 'exact', task: exact },
      {
        type: 'io-error',
        cause: 'process-error',
        path: 'source.md',
        contentState: 'unknown',
      },
    );
    const modal = openRecovery(app, tasks);

    button(modal.contentEl, 'Remove original').click();
    await flushMicrotasks();

    expect(modal.contentEl.querySelector('h3')?.textContent).toBe(
      'Original removal state is unknown',
    );
    expect(modal.contentEl.querySelector('p')?.textContent).toBe(
      'Could not confirm whether the original in source.md was removed. Rescan and inspect source.md and Projects/P.md before taking any action. Do not repeat removal until the vault state is confirmed.',
    );
    expect(modal.contentEl.textContent).not.toContain('Both copies were kept');
  });

  it('keeps the confirmed-unchanged removal failure wording', async () => {
    const app = await createAppWithFiles({});
    const exact = snapshot(source);
    const tasks = taskApi(
      { type: 'exact', task: exact },
      {
        type: 'io-error',
        cause: 'read-error',
        path: 'source.md',
        contentState: 'unchanged',
      },
    );
    const modal = openRecovery(app, tasks);

    button(modal.contentEl, 'Remove original').click();
    await flushMicrotasks();

    expect(modal.contentEl.querySelector('p')?.textContent).toBe(
      'The original could not be removed safely. Both copies were kept.',
    );
  });

  it.each([
    {
      name: 'missing',
      resolution: { type: 'not-found', ref: source } as TaskResolution,
      message: 'could not be found',
    },
    {
      name: 'ambiguous',
      resolution: { type: 'ambiguous', candidates: [] } as TaskResolution,
      message: 'Multiple possible originals',
    },
  ])(
    'stops $name recovery without guessing or issuing a delete',
    async ({ resolution, message }) => {
      const app = await createAppWithFiles({});
      const tasks = taskApi(resolution);
      const modal = openRecovery(app, tasks);

      button(modal.contentEl, 'Remove original').click();
      await flushMicrotasks();

      expect(tasks.execute).not.toHaveBeenCalled();
      expect(modal.contentEl.textContent).toContain(message);
    },
  );
});
