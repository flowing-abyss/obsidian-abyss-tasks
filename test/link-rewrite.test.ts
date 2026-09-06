import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi } from '../src/tasks';
import type { TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import {
  createAppWithFiles,
  expectDefined,
  task,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

function call<T>(owner: object, method: string, ...args: unknown[]): T {
  const name = method === 'updateTaskTitle' ? method : `${method}_abyssPrivate`;
  const fn = expectDefined((owner as Record<string, (...values: unknown[]) => T>)[name]);
  return fn.call(owner, ...args);
}

function taskApi(ref: TaskRef) {
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'not-found',
    target: { type: 'task', ref },
  });
  return {
    execute,
    tasks: {
      queries: taskQueryApi(),
      execute,
    },
  };
}

function saveImmediately(replacement: string) {
  return vi.spyOn(LinkEditModal.prototype, 'open').mockImplementation(function (
    this: LinkEditModal,
  ) {
    (this as unknown as { onSave_abyssPrivate: (raw: string) => void }).onSave_abyssPrivate(
      replacement,
    );
  });
}

describe('task link rewrite delegation', () => {
  it('owns a link editor once per open and releases it idempotently on close', async () => {
    const app = await createAppWithFiles({});
    const release = vi.fn();
    const interactionOwnership = { acquire: vi.fn(() => ({ release })) };
    const modal = new LinkEditModal(
      app,
      {
        raw: '[Old](https://example.com)',
        type: 'md',
        target: 'https://example.com',
        display: 'Old',
        index: 0,
      },
      vi.fn(),
      '',
      interactionOwnership,
    );

    modal.onOpen();
    expect(interactionOwnership.acquire).toHaveBeenCalledOnce();
    expect(interactionOwnership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
    modal.onClose();
    modal.onClose();
    expect(release).toHaveBeenCalledOnce();
  });

  it('routes a RightPanel title link edit through the typed target', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] [[Old]]\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const { tasks, execute } = taskApi(ref);
    const panel = new RightPanel(
      new AppState(),
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const current = Object.assign(
      task({ markdownTitle: '[[Old]]', source: { filePath: 't.md' } }),
      { ref },
    );
    saveImmediately('[[Changed]]');

    call<void>(panel, 'editLink', current, 0, {
      raw: '[[Old]]',
      type: 'wiki',
      target: 'Old',
      display: 'Old',
      index: 0,
    });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledWith({
      type: 'edit-link',
      target: { type: 'title', target: { type: 'task', ref } },
      occurrence: 0,
      replacement: '[[Changed]]',
    });
  });

  it('routes a CenterPanel card title link edit through the same API', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] [[Old]]\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const { tasks, execute } = taskApi(ref);
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      tasks.queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      tasks,
    );
    const current = Object.assign(
      task({ markdownTitle: '[[Old]]', source: { filePath: 't.md' } }),
      { ref },
    );
    saveImmediately('[[Changed]]');

    call<void>(panel, 'editTaskLink', current, 0, {
      raw: '[[Old]]',
      type: 'wiki',
      target: 'Old',
      display: 'Old',
      index: 0,
    });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledWith({
      type: 'edit-link',
      target: { type: 'title', target: { type: 'task', ref } },
      occurrence: 0,
      replacement: '[[Changed]]',
    });
  });

  it('routes description and revisioned comment link edits through their exact targets', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] root\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const commentRef = {
      parent: { type: 'task' as const, ref },
      relativeLine: 1,
      originalMarkdown: '  - 2026-07-14: [[Old]]',
    };
    const { tasks, execute } = taskApi(ref);
    const panel = new RightPanel(
      new AppState(),
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const token = {
      raw: '[[Old]]',
      type: 'wiki' as const,
      target: 'Old',
      display: 'Old',
      index: 0,
    };
    saveImmediately('[[Changed]]');

    call<void>(
      panel,
      'editLinkInString',
      { type: 'description', target: { type: 'task', ref } },
      1,
      token,
      't.md',
    );
    call<void>(panel, 'editLinkInString', { type: 'comment', ref: commentRef }, 0, token, 't.md');
    await Promise.resolve();

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'edit-link',
        target: { type: 'description', target: { type: 'task', ref } },
        occurrence: 1,
        replacement: '[[Changed]]',
      },
      {
        type: 'edit-link',
        target: { type: 'comment', ref: commentRef },
        occurrence: 0,
        replacement: '[[Changed]]',
      },
    ]);
  });

  it('converges the selected stack and acknowledgement callback on the returned fresh revision', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] Old\n' });
    const staleRef: TaskRef = { filePath: 't.md', line: 0, revision: 'stale' };
    const freshRef: TaskRef = { ...staleRef, revision: 'fresh' };
    const fresh: TaskSnapshot = {
      ref: freshRef,
      title: 'New',
      markdownTitle: 'New',
      status: 'open',
      statusSymbol: ' ',
      priority: 'D',
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      dependsOn: [],
      subtasks: [],
      comments: [],
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] New',
        originalBlock: '- [ ] New',
      },
      presentation: { linkCount: 0 },
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const tasks: TaskApplicationApi = { ...taskApi(staleRef).tasks, execute };
    const state = new AppState();
    state.set('taskStack', [
      Object.assign(task({ title: 'Old', source: { filePath: 't.md' } }), { ref: staleRef }),
    ]);
    const acknowledged = vi.fn();
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      acknowledged,
      tasks,
    );

    await call<Promise<void>>(
      panel,
      'updateTaskTitle',
      expectDefined(state.get('taskStack')[0]),
      'New',
    );

    expect(state.get('taskStack')[0]).toMatchObject({ ref: freshRef, markdownTitle: 'New' });
    expect(acknowledged).toHaveBeenCalledWith(freshRef);
  });
});
