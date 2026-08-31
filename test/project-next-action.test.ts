import { describe, expect, it, vi } from 'vitest';
import { NextActionReplacementCoordinator } from '../src/projects/NextActionReplacementCoordinator';
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
  it('keeps target-file predecessors in the target add transaction before cross-file cleanup', async () => {
    const localPrevious = task({
      title: 'Local previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const externalPrevious = task({
      title: 'External previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Work.md', line: 1 },
    });
    const target = task({ title: 'Target', source: { filePath: 'Projects/A.md', line: 4 } });
    const application = {
      queries: taskQueryApi({ list: () => [localPrevious, externalPrevious, target] }),
      execute: vi.fn(),
      applyRootTagChanges: vi.fn().mockResolvedValue({
        type: 'ok',
        outcome: { type: 'task', task: target },
        changed: true,
      }),
    } as unknown as TaskApplicationApi;

    await new NextActionReplacementCoordinator(application).replace(target, [
      localPrevious,
      externalPrevious,
    ]);

    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(1, {
      primary: target.ref,
      changes: [
        { task: target, tags: { add: ['#task/next_action'] } },
        { task: localPrevious, tags: { remove: ['#task/next_action'] } },
      ],
    });
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: externalPrevious.ref,
      changes: [{ task: externalPrevious, tags: { remove: ['#task/next_action'] } }],
    });
  });

  it('restores every cleared predecessor when a later cross-file cleanup fails', async () => {
    const first = task({
      title: 'First',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/First.md', line: 1 },
    });
    const second = task({
      title: 'Second',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Second.md', line: 1 },
    });
    const target = task({ title: 'Target', source: { filePath: 'Projects/A.md', line: 2 } });
    const failure = { type: 'conflict' as const, current: second };
    const application = {
      queries: taskQueryApi({ list: () => [first, second, target] }),
      execute: vi.fn(),
      applyRootTagChanges: vi
        .fn()
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: target },
          changed: true,
        })
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: first },
          changed: true,
        })
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: target },
          changed: true,
        })
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: first },
          changed: true,
        }),
    } as unknown as TaskApplicationApi;

    await expect(
      new NextActionReplacementCoordinator(application).replace(target, [first, second]),
    ).resolves.toBe(failure);
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(4, {
      primary: target.ref,
      changes: [{ task: target, tags: { remove: ['#task/next_action'] } }],
    });
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(5, {
      primary: first.ref,
      changes: [{ task: first, tags: { add: ['#task/next_action'] } }],
    });
  });

  it('serializes competing Project selections and re-reads the settled prior action', async () => {
    const first = task({ title: 'First', source: { filePath: 'Projects/A.md', line: 1 } });
    const second = task({ title: 'Second', source: { filePath: 'Projects/A.md', line: 2 } });
    let releaseFirst!: () => void;
    const applyRootTagChanges = vi.fn().mockImplementation(
      async (intent: {
        readonly changes: readonly {
          readonly task: typeof first;
          readonly tags: {
            readonly add?: readonly string[];
            readonly remove?: readonly string[];
          };
        }[];
      }) => {
        if (applyRootTagChanges.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          type: 'ok' as const,
          outcome: { type: 'task' as const, task: first },
          changed: true,
        };
      },
    );
    const application = {
      // The TaskIndex has not yet published the first command when the second selection begins.
      queries: taskQueryApi({
        list: ({ tag } = {}) => (tag ? [] : [first, second]),
      }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const service = new NextActionService(application);

    const firstSet = service.set('Projects/A.md', first);
    const secondSet = service.set('Projects/A.md', second);
    await Promise.resolve();
    expect(applyRootTagChanges).toHaveBeenCalledOnce();
    releaseFirst();
    await Promise.all([firstSet, secondSet]);

    expect(applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: second.ref,
      changes: [
        { task: second, tags: { add: ['#task/next_action'] } },
        { task: first, tags: { remove: ['#task/next_action'] } },
      ],
    });
  });

  it('drops published local tag state before considering a later external edit', async () => {
    const first = task({
      title: 'First',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const second = task({ title: 'Second', source: { filePath: 'Projects/A.md', line: 2 } });
    const third = task({ title: 'Third', source: { filePath: 'Projects/A.md', line: 3 } });
    let indexed = [first, second, third];
    let publish!: () => void;
    const applyRootTagChanges = vi.fn().mockResolvedValue({
      type: 'ok',
      outcome: { type: 'task', task: second },
      changed: true,
    });
    const application = {
      queries: taskQueryApi({
        list: ({ tag } = {}) => (tag ? indexed.filter((item) => item.tags.includes(tag)) : indexed),
        subscribeSettled: (listener) => {
          publish = () =>
            listener({
              type: 'settled',
              reason: 'index',
              files: [{ path: 'Projects/A.md', generation: 1 }],
            });
          return () => undefined;
        },
      }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const service = new NextActionService(application);

    await service.set('Projects/A.md', second);
    indexed = [{ ...first, tags: [] }, { ...second, tags: ['#task/next_action'] }, third];
    publish();
    indexed = [
      { ...first, tags: ['#task/next_action'] },
      { ...second, tags: ['#task/next_action'] },
      third,
    ];

    await service.set('Projects/A.md', third);
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: third.ref,
      changes: [
        { task: third, tags: { add: ['#task/next_action'] } },
        { task: indexed[0], tags: { remove: ['#task/next_action'] } },
        { task: indexed[1], tags: { remove: ['#task/next_action'] } },
      ],
    });
  });

  it('drops committed state for a root removed by a settled file publication', async () => {
    const removed = task({ title: 'Removed', source: { filePath: 'Projects/A.md', line: 1 } });
    const target = task({ title: 'Target', source: { filePath: 'Projects/A.md', line: 2 } });
    let indexed = [removed, target];
    let publish!: () => void;
    const applyRootTagChanges = vi.fn().mockResolvedValue({
      type: 'ok',
      outcome: { type: 'task', task: target },
      changed: true,
    });
    const application = {
      queries: taskQueryApi({
        list: () => indexed,
        subscribeSettled: (listener) => {
          publish = () =>
            listener({
              type: 'settled',
              reason: 'index',
              files: [{ path: 'Projects/A.md', generation: 1 }],
            });
          return () => undefined;
        },
      }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const service = new NextActionService(application);

    await service.set('Projects/A.md', removed);
    indexed = [target];
    publish();

    await service.set('Projects/A.md', target);
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: target.ref,
      changes: [{ task: target, tags: { add: ['#task/next_action'] } }],
    });
  });

  it('compensates a cross-file add when removing the previous action fails', async () => {
    const previous = task({
      title: 'Previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Old.md', line: 1 },
    });
    const target = task({ title: 'Target', source: { filePath: 'Notes/New.md', line: 2 } });
    const cleanupFailure = { type: 'conflict' as const, current: previous };
    const application = {
      queries: taskQueryApi({ list: () => [previous, target] }),
      execute: vi.fn(),
      applyRootTagChanges: vi
        .fn()
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: target },
          changed: true,
        })
        .mockResolvedValueOnce(cleanupFailure)
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: target },
          changed: true,
        }),
    } as unknown as TaskApplicationApi;

    await expect(
      new NextActionReplacementCoordinator(application).replace(target, [previous]),
    ).resolves.toBe(cleanupFailure);
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(1, {
      primary: target.ref,
      changes: [{ task: target, tags: { add: ['#task/next_action'] } }],
    });
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: previous.ref,
      changes: [{ task: previous, tags: { remove: ['#task/next_action'] } }],
    });
    expect(application.applyRootTagChanges).toHaveBeenNthCalledWith(3, {
      primary: target.ref,
      changes: [{ task: target, tags: { remove: ['#task/next_action'] } }],
    });
  });

  it('reports an integrity conflict from an authoritative rescan when compensation cannot be proven', async () => {
    const previous = task({
      title: 'Previous',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Old.md', line: 1 },
    });
    const target = task({
      title: 'Target',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/New.md', line: 2 },
    });
    const application = {
      queries: taskQueryApi({ list: () => [previous, target] }),
      execute: vi.fn(),
      applyRootTagChanges: vi
        .fn()
        .mockResolvedValueOnce({
          type: 'ok',
          outcome: { type: 'task', task: target },
          changed: true,
        })
        .mockResolvedValueOnce({ type: 'conflict', current: previous })
        .mockResolvedValueOnce({ type: 'io-error', cause: 'unknown', contentState: 'unknown' }),
    } as unknown as TaskApplicationApi;

    await expect(
      new NextActionReplacementCoordinator(application).replace(
        target,
        [previous],
        'Projects/A.md',
      ),
    ).resolves.toEqual({
      type: 'integrity-conflict',
      projectPath: 'Projects/A.md',
      tag: '#task/next_action',
      tasks: [previous, target],
    });
  });

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
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(1, {
      primary: target.ref,
      changes: [{ task: target, tags: { add: ['#task/next_action'] } }],
    });
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: previous.ref,
      changes: [{ task: previous, tags: { remove: ['#task/next_action'] } }],
    });
  });

  it('moves a direct Project Task from an inherited Next Action without touching another Project', async () => {
    const inherited = task({
      title: 'Inherited Work Note task',
      tags: ['#task/next_action'],
      source: { filePath: 'Notes/Work A.md', line: 1 },
    });
    const external = task({
      title: 'Other Project task',
      tags: ['#task/next_action'],
      source: { filePath: 'Projects/B.md', line: 1 },
    });
    const target = task({
      title: 'Direct Project task',
      source: { filePath: 'Projects/A.md', line: 2 },
    });
    const result = {
      type: 'ok' as const,
      outcome: { type: 'task' as const, task: target },
      changed: true,
    };
    const applyRootTagChanges = vi.fn().mockResolvedValue(result);
    const application = {
      queries: taskQueryApi({ list: () => [inherited, external, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;
    const membership = (_projectPath: string, candidate: typeof target): boolean =>
      [inherited, target].some(
        (joined) =>
          joined.ref.filePath === candidate.ref.filePath && joined.ref.line === candidate.ref.line,
      );

    await expect(
      new NextActionService(application, membership).set('Projects/A.md', target),
    ).resolves.toBe(result);
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(1, {
      primary: target.ref,
      changes: [{ task: target, tags: { add: ['#task/next_action'] } }],
    });
    expect(applyRootTagChanges).toHaveBeenNthCalledWith(2, {
      primary: inherited.ref,
      changes: [{ task: inherited, tags: { remove: ['#task/next_action'] } }],
    });
  });

  it('adds a direct Project Next Action without changing duplicate markers in other Projects', async () => {
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
    const result = {
      type: 'ok' as const,
      outcome: { type: 'task' as const, task: target },
      changed: true,
    };
    const applyRootTagChanges = vi.fn().mockResolvedValue(result);
    const application = {
      queries: taskQueryApi({ list: () => [first, second, target] }),
      execute: vi.fn(),
      applyRootTagChanges,
    } as unknown as TaskApplicationApi;

    const membership = (_projectPath: string, candidate: typeof target): boolean =>
      candidate.ref.filePath === target.ref.filePath && candidate.ref.line === target.ref.line;

    await expect(
      new NextActionService(application, membership).set('Projects/A.md', target),
    ).resolves.toBe(result);
    expect(applyRootTagChanges).toHaveBeenCalledWith({
      primary: target.ref,
      changes: [{ task: target, tags: { add: ['#task/next_action'] } }],
    });
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
