import { describe, expect, it, vi } from 'vitest';
import type { TaskQueryApi } from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type {
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import { prepareRetry, type PreparedMutation } from '../../src/tasks/application/taskRetryPolicy';
import { clockFrom } from '../../src/tasks/domain/clock';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';

function snapshot(markdownTitle = 'Task', revision = 'old'): TaskSnapshot {
  return {
    ref: { filePath: 'tasks.md', line: 0, revision },
    title: markdownTitle,
    markdownTitle,
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep',
    onCompletionExplicit: false,
    planning: { due: localDate('2026-08-11') },
    tags: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: `- [ ] ${markdownTitle} 📅 2026-08-11`,
      originalBlock: `- [ ] ${markdownTitle} 📅 2026-08-11`,
    },
    presentation: { linkCount: 0 },
  };
}

function prepared(
  command: TaskEditRequest['command'],
  retry: PreparedMutation['retry'],
): PreparedMutation {
  const base = snapshot();
  return {
    publicCommand: command,
    repositoryRequest: {
      command,
      baseRoot: base,
      baseTarget: { type: 'task', ref: base.ref },
      reconciliation: { observed: base },
    },
    base,
    targetBase: { type: 'task', ref: base.ref },
    clock: clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0).read(),
    settings: {
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
    },
    retry,
  };
}

describe('prepareRetry', () => {
  it('recomputes an add-tag intent against an authority-proven current root', () => {
    const base = snapshot();
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref: base.ref },
      patch: { tags: { add: ['#work'] } },
    };
    const current = { ...snapshot('Task', 'new'), tags: ['#external'] };

    expect(
      prepareRetry(prepared(command, 'commutative'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      }),
    ).toMatchObject({
      type: 'edit',
      request: {
        command: {
          type: 'patch',
          target: { type: 'task', ref: current.ref },
          patch: { tags: { add: ['#work'] } },
        },
        baseRoot: current,
      },
    });
  });

  it('does not retry a field replacement when that field changed', () => {
    const base = snapshot();
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref: base.ref },
      patch: { markdownTitle: { type: 'set' as const, value: 'Requested' } },
    };

    expect(
      prepareRetry(prepared(command, 'field-compare'), {
        type: 'rebased',
        previous: base,
        current: snapshot('External', 'new'),
        evidence: 'authority-transition',
      }),
    ).toEqual({ type: 'unsafe' });
  });

  it('retries whole-task delete only after byte-identical relocation', () => {
    const base = snapshot();
    const command = { type: 'delete' as const, ref: base.ref };
    const current = {
      ...base,
      ref: { ...base.ref, line: 4, revision: 'moved' },
      source: { ...base.source, line: 4 },
    };

    expect(
      prepareRetry(prepared(command, 'relocation-only'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'byte-identical-relocation',
      }),
    ).toMatchObject({
      type: 'edit',
      request: { command: { type: 'delete', ref: current.ref } },
    });
    expect(
      prepareRetry(prepared(command, 'relocation-only'), {
        type: 'rebased',
        previous: base,
        current: snapshot('Task', 'changed'),
        evidence: 'authority-transition',
      }),
    ).toEqual({ type: 'unsafe' });
  });
});

const statuses = new StatusCatalog([
  { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
  { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
]);

function query(resolution: ReturnType<TaskQueryApi['resolve']>): TaskQueryApi {
  return {
    list: () => [],
    forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
    resolve: () => resolution,
    subscribe: () => () => undefined,
  };
}

function repositoryWith(
  edit: TaskRepository['edit'],
  overrides: Partial<TaskRepository> = {},
): TaskRepository {
  return {
    supportsRevisionPreconditions: true,
    edit,
    completeRecurrence: vi.fn(),
    create: vi.fn(),
    move: vi.fn(),
    ...overrides,
  };
}

function committed(task = snapshot()): TaskRepositoryResult {
  return { type: 'committed', outcome: { type: 'task', task }, changed: true };
}

describe('TaskApplicationService one-shot retry', () => {
  it('retries add-comment once against the repository-proven parent', async () => {
    const base = snapshot();
    const current = {
      ...snapshot('Task #external', 'new'),
      tags: ['#external'],
    };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce(committed(current));
    const clock = { read: vi.fn(() => clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0).read()) };
    const settings = vi.fn(() => ({
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before' as const, removeScheduledDate: false },
    }));
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clock,
      undefined,
      settings,
    );

    await expect(
      service.execute({
        type: 'add-comment',
        parent: { type: 'task', ref: base.ref },
        text: 'Keep this text',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({
      command: { type: 'add-comment', stamp: localDate('2026-08-11') },
      baseRoot: base,
    });
    expect(edit.mock.calls[1]?.[0]).toMatchObject({
      command: { type: 'add-comment', stamp: localDate('2026-08-11') },
      baseRoot: current,
    });
    expect(clock.read).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
  });

  it('never performs a third write after a second repository race', async () => {
    const base = snapshot();
    const current = snapshot('Task #one', 'one');
    const latest = snapshot('Task #one #two', 'two');
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: current,
        current: latest,
        evidence: 'authority-transition',
      });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'add-comment',
        parent: { type: 'task', ref: base.ref },
        text: 'Only once',
      }),
    ).resolves.toEqual({ type: 'conflict', current: latest });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a description replacement after that description changed', async () => {
    const base = { ...snapshot(), description: 'Old' };
    const current = { ...snapshot('Task', 'new'), description: 'External' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValueOnce({
      type: 'rebased',
      previous: base,
      current,
      evidence: 'authority-transition',
    });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-description',
        target: { type: 'task', ref: base.ref },
        text: 'Requested',
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(edit).toHaveBeenCalledOnce();
  });

  it('routes an eligible recurrence retry only through completeRecurrence', async () => {
    const base = { ...snapshot(), recurrence: 'every day' };
    const current = { ...base, ref: { ...base.ref, revision: 'new' }, tags: ['#external'] };
    const completeRecurrence = vi
      .fn<TaskRepository['completeRecurrence']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce(committed(current));
    const edit = vi.fn<TaskRepository['edit']>();
    const move = vi.fn<TaskRepository['move']>();
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit, { completeRecurrence, move }),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: base.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(completeRecurrence).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('does not retry recurrence after its owned descendants changed', async () => {
    const base = {
      ...snapshot(),
      recurrence: 'every day',
      source: {
        ...snapshot().source,
        originalBlock: '- [ ] Task 🔁 every day\n  - comment',
      },
    };
    const current = {
      ...base,
      ref: { ...base.ref, revision: 'new' },
      source: {
        ...base.source,
        originalBlock: '- [ ] Task 🔁 every day\n  - edited comment',
      },
    };
    const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>().mockResolvedValueOnce({
      type: 'rebased',
      previous: base,
      current,
      evidence: 'authority-transition',
    });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(vi.fn(), { completeRecurrence }),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: base.ref },
        symbol: 'x',
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(completeRecurrence).toHaveBeenCalledOnce();
  });

  it.each(['edit', 'move', 'recurrence'] as const)(
    'performs zero repository writes for a visual-only %s preflight',
    async (kind) => {
      const base = { ...snapshot(), recurrence: 'every day' };
      const visual = snapshot('Replacement', 'replacement');
      const edit = vi.fn<TaskRepository['edit']>();
      const move = vi.fn<TaskRepository['move']>();
      const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>();
      const service = new TaskApplicationService(
        query({ type: 'visual', stale: base.ref, current: visual, evidence: 'same-line' }),
        repositoryWith(edit, { move, completeRecurrence }),
        statuses,
        clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
      );
      const command =
        kind === 'move'
          ? ({
              type: 'move' as const,
              ref: base.ref,
              destination: { filePath: 'archive.md', insertion: { type: 'append' as const } },
            } as const)
          : kind === 'recurrence'
            ? ({
                type: 'set-status' as const,
                target: { type: 'task' as const, ref: base.ref },
                symbol: 'x',
              } as const)
            : ({
                type: 'patch' as const,
                target: { type: 'task' as const, ref: base.ref },
                patch: { tags: { add: ['#work'] } },
              } as const);

      await service.execute(command);
      expect(edit).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(completeRecurrence).not.toHaveBeenCalled();
    },
  );
});
