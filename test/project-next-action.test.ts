import { describe, expect, it, vi } from 'vitest';
import { NextActionService } from '../src/projects/NextActionService';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskApplicationApi } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import type { TaskRepository } from '../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { localDate } from '../src/tasks/domain/validation';
import { task, taskQueryApi } from './helpers';

describe('Project Next Action', () => {
  it('moves Next Action between two Work Notes joined to the same Project', async () => {
    const previous = task({
      title: 'Work Note A task',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Work A.md', line: 1 },
    });
    const target = task({
      title: 'Work Note B task',
      source: { filePath: 'Notes/Work B.md', line: 2 },
    });
    const applyRootTagChanges = vi.fn().mockResolvedValue({
      type: 'ok',
      outcome: { type: 'task', task: target },
      changed: true,
    });
    const application = {
      queries: taskQueryApi({ list: () => [previous, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const joined = [previous, target];
    const membership = (_projectPath: string, candidate: typeof target): boolean =>
      joined.some(
        (action) =>
          action.ref.filePath === candidate.ref.filePath && action.ref.line === candidate.ref.line,
      );

    await expect(
      new NextActionService(application, membership).set('Projects/A.md', target),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(applyRootTagChanges).toHaveBeenCalledWith({
      primary: target.ref,
      changes: [
        { task: target, tags: { add: ['#task/next_action'] } },
        { task: previous, tags: { remove: ['#task/next_action'] } },
      ],
    });
  });

  it('keeps one genuinely external Next Action untouched with joined membership', async () => {
    const external = task({
      title: 'External',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Elsewhere.md', line: 1 },
    });
    const target = task({
      title: 'Joined target',
      source: { filePath: 'Notes/Work B.md', line: 2 },
    });
    const applyRootTagChanges = vi.fn();
    const application = {
      queries: taskQueryApi({ list: () => [external, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const membership = (_projectPath: string, candidate: typeof target): boolean =>
      candidate.ref.filePath === target.ref.filePath && candidate.ref.line === target.ref.line;

    await expect(
      new NextActionService(application, membership).set('Projects/A.md', target),
    ).resolves.toMatchObject({ type: 'integrity-conflict', tasks: [external] });
    expect(applyRootTagChanges).not.toHaveBeenCalled();
  });

  it('does not delete duplicate external next-action tags', async () => {
    const first = task({
      title: 'First external',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/Other.md', line: 1 },
    });
    const second = task({
      title: 'Second external',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Elsewhere.md', line: 2 },
    });
    const target = task({
      title: 'Wanted',
      source: { filePath: 'Projects/A.md', line: 3 },
    });
    const applyRootTagChanges = vi.fn();
    const application = {
      queries: taskQueryApi({ list: () => [first, second, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;

    await expect(
      new NextActionService(application).set('Projects/A.md', target),
    ).resolves.toMatchObject({ type: 'integrity-conflict' });
    expect(applyRootTagChanges).not.toHaveBeenCalled();
  });

  it('moves a same-file tag through one neutral multi-root application intent', async () => {
    const previous = task({
      title: 'Previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const target = task({
      title: 'Wanted',
      source: { filePath: 'Projects/A.md', line: 4 },
    });
    const result = {
      type: 'ok' as const,
      outcome: { type: 'task' as const, task: target },
      changed: true,
    };
    const applyRootTagChanges = vi.fn().mockResolvedValue(result);
    const application = {
      queries: taskQueryApi({ list: () => [previous, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;

    await expect(new NextActionService(application).set('Projects/A.md', target)).resolves.toBe(
      result,
    );
    expect(applyRootTagChanges).toHaveBeenCalledOnce();
    expect(applyRootTagChanges).toHaveBeenCalledWith({
      primary: target.ref,
      changes: [
        { task: target, tags: { add: ['#task/next_action'] } },
        { task: previous, tags: { remove: ['#task/next_action'] } },
      ],
    });
    expect(application.execute).not.toHaveBeenCalled();
  });

  it('treats stale and current revisions of one logical task as the same Next Action', async () => {
    const stale = task({ title: 'Wanted', source: { filePath: 'Projects/A.md', line: 4 } });
    const current = {
      ...stale,
      ref: { ...stale.ref, revision: `${stale.ref.revision}-current` },
      tags: ['#task/next_action'],
    };
    const queries = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current, basis: { observed: current } }),
    });
    const editRootTags = vi.fn().mockResolvedValue({
      type: 'committed' as const,
      outcome: { type: 'task' as const, task: current },
      roots: [current],
      changed: false,
    });
    const repository = {
      supportsRevisionPreconditions: true,
      editRootTags,
      edit: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    } satisfies TaskRepository;
    const application = new TaskApplicationService(
      queries,
      repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-08-26') },
    );

    await new NextActionService(application).set('Projects/A.md', stale);

    expect(editRootTags).toHaveBeenCalledWith({
      filePath: current.ref.filePath,
      primary: current.ref,
      changes: [
        {
          baseRoot: current,
          baseTarget: { type: 'task', ref: current.ref },
          reconciliation: { observed: current },
          tags: { add: ['#task/next_action'] },
        },
      ],
    });
  });

  it('resolves same-file roots in the application and delegates one repository request', async () => {
    const previous = task({
      title: 'Previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const target = task({
      title: 'Wanted',
      source: { filePath: 'Projects/A.md', line: 4 },
    });
    const updatedPrevious = { ...previous, tags: [] };
    const updatedTarget = { ...target, tags: ['#task/next_action'] };
    const queries = taskQueryApi({
      list: () => [previous, target],
      resolve: (ref) => {
        const found = [previous, target].find(
          (candidate) => candidate.ref.filePath === ref.filePath && candidate.ref.line === ref.line,
        );
        return found
          ? { type: 'exact' as const, task: found, basis: { observed: found } }
          : { type: 'not-found' as const, ref };
      },
    });
    const editRootTags = vi.fn().mockResolvedValue({
      type: 'committed' as const,
      outcome: { type: 'task' as const, task: updatedTarget },
      roots: [updatedTarget, updatedPrevious],
      changed: true,
    });
    const repository = {
      supportsRevisionPreconditions: true,
      editRootTags,
      edit: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    } satisfies TaskRepository;
    const application = new TaskApplicationService(
      queries,
      repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-08-26') },
    );
    const intent = {
      primary: target.ref,
      changes: [
        { task: target, tags: { add: ['#task/next_action'] } },
        { task: previous, tags: { remove: ['#task/next_action'] } },
      ],
    };

    await expect(
      Promise.resolve().then(() => application.applyRootTagChanges?.(intent)),
    ).resolves.toMatchObject({ type: 'ok', changed: true });
    expect(editRootTags).toHaveBeenCalledOnce();
    expect(editRootTags).toHaveBeenCalledWith({
      filePath: 'Projects/A.md',
      primary: target.ref,
      changes: [
        {
          baseRoot: target,
          baseTarget: { type: 'task', ref: target.ref },
          reconciliation: { observed: target },
          tags: { add: ['#task/next_action'] },
        },
        {
          baseRoot: previous,
          baseTarget: { type: 'task', ref: previous.ref },
          reconciliation: { observed: previous },
          tags: { remove: ['#task/next_action'] },
        },
      ],
    });
    expect(repository.edit).not.toHaveBeenCalled();

    editRootTags.mockClear();
    editRootTags.mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: updatedPrevious },
      roots: [updatedPrevious],
      changed: true,
    });
    await application.applyRootTagChanges({
      primary: previous.ref,
      changes: [{ task: previous, tags: { add: ['#review'] } }],
    });
    expect(editRootTags.mock.calls[0]?.[0]).toMatchObject({
      changes: [{ baseRoot: updatedPrevious, tags: { add: ['#review'] } }],
    });
  });

  it('adds cross-file new tags first and returns a typed safe partial when old-tag removal conflicts', async () => {
    const previous = task({
      title: 'Previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const target = task({
      title: 'Wanted',
      source: { filePath: 'Notes/Work.md', line: 4 },
    });
    const taggedTarget = { ...target, tags: ['#task/next_action'] };
    const queries = taskQueryApi({
      list: () => [previous, target],
      resolve: (ref) => {
        const found = [previous, target].find(
          (candidate) => candidate.ref.filePath === ref.filePath && candidate.ref.line === ref.line,
        );
        return found
          ? { type: 'exact' as const, task: found, basis: { observed: found } }
          : { type: 'not-found' as const, ref };
      },
    });
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: taggedTarget },
        changed: true,
      })
      .mockResolvedValueOnce({ type: 'conflict', current: previous });
    const repository = {
      supportsRevisionPreconditions: true,
      editRootTags: vi.fn(),
      edit,
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    } satisfies TaskRepository;
    const application = new TaskApplicationService(
      queries,
      repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-08-26') },
    );

    await expect(
      application.applyRootTagChanges({
        primary: target.ref,
        changes: [
          { task: previous, tags: { remove: ['#task/next_action'] } },
          { task: target, tags: { add: ['#task/next_action'] } },
        ],
      }),
    ).resolves.toEqual({
      type: 'partial',
      operation: 'root-tags',
      recovery: {
        state: 'new-tags-committed-old-tags-remain',
        appliedTask: taggedTarget,
        remainingTasks: [previous],
        cause: 'conflict',
      },
    });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(
      edit.mock.calls.map(([request]) => ('command' in request ? request.command : request)),
    ).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: target.ref },
        patch: { tags: { add: ['#task/next_action'] } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: previous.ref },
        patch: { tags: { remove: ['#task/next_action'] } },
      },
    ]);
    expect(repository.editRootTags).not.toHaveBeenCalled();
  });
});
