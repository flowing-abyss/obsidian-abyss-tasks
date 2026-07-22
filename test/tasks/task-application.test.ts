import { describe, expect, it, vi } from 'vitest';
import type { TaskQueryApi } from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type {
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';

const ref: TaskRef = { filePath: 'tasks.md', line: 0, revision: 'block:test' };

function snapshot(): TaskSnapshot {
  return {
    ref,
    title: 'task',
    markdownTitle: 'task',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    planning: { due: localDate('2026-07-20') },
    tags: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: '- [ ] task 📅 2026-07-20',
      originalBlock: '- [ ] task 📅 2026-07-20',
    },
    presentation: { linkCount: 0 },
  };
}

function queries(): TaskQueryApi {
  return {
    list: () => [],
    forCalendarDates: () => [],
    resolve: (target) => ({ type: 'not-found', ref: target }),
    subscribe: () => () => {},
  };
}

const statuses = new StatusCatalog([
  { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
  { id: 'doing', symbol: '/', type: 'in-progress', defaultForType: true },
  { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
  { id: 'done-alt', symbol: 'd', type: 'done', defaultForType: false },
  { id: 'cancelled', symbol: '-', type: 'cancelled', defaultForType: true },
  { id: 'cancelled-alt', symbol: 'k', type: 'cancelled', defaultForType: false },
]);

const clock = { today: vi.fn(() => localDate('2026-07-14')) };

function service(
  repository: Pick<TaskRepository, 'edit'> & Partial<Pick<TaskRepository, 'create'>>,
  taskQueries: TaskQueryApi = queries(),
) {
  return new TaskApplicationService(
    taskQueries,
    { create: vi.fn(), move: vi.fn(), ...repository },
    statuses,
    clock,
  );
}

describe('TaskApplicationService planning commands', () => {
  it.each([
    ['zero shift', { type: 'shift-schedule' as const, ref, days: 0 }],
    ['unsafe shift', { type: 'shift-schedule' as const, ref, days: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'fractional timed move',
      { type: 'move-time-slot' as const, ref, days: 1.5, time: localTime('09:15') },
    ],
    [
      'unsafe timed move',
      {
        type: 'move-time-slot' as const,
        ref,
        days: Number.MAX_SAFE_INTEGER + 1,
        time: localTime('09:15'),
      },
    ],
    ['fractional all-day move', { type: 'move-to-all-day' as const, ref, days: -0.5 }],
  ])('rejects a $name day delta before repository access', async (_name, command) => {
    const edit = vi.fn<TaskRepository['edit']>();

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'days' }],
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'shift-schedule' as const, ref, days: -2 },
    { type: 'move-time-slot' as const, ref, days: 0, time: localTime('14:45') },
    { type: 'move-to-all-day' as const, ref, days: 0 },
  ])('delegates one atomic arbitrary-day $type command unchanged', async (command) => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(command);
  });

  it('executes a zero-day all-day conversion through exactly one repository write', async () => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);
    const command = { type: 'move-to-all-day' as const, ref, days: 0 };

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(command);
  });

  it('rejects an empty create body before destination resolution or repository access', async () => {
    const edit = vi.fn<TaskRepository['edit']>();
    const create = vi.fn<TaskRepository['create']>();

    await expect(
      service({ edit, create }).execute({
        type: 'create',
        markdownBody: '   ',
        destination: {
          type: 'explicit',
          destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
        },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-title', field: 'title' }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a bare carriage return in description text before repository access', async () => {
    const edit = vi.fn<TaskRepository['edit']>();

    await expect(
      service({ edit }).execute({
        type: 'set-description',
        target: { type: 'task', ref },
        text: 'first\rsecond',
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'description' }],
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('stamps add-comment with the injected local day before repository delegation', async () => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);
    clock.today.mockClear();

    await expect(
      service({ edit }).execute({
        type: 'add-comment',
        parent: { type: 'task', ref },
        text: 'from the injected clock',
      }),
    ).resolves.toEqual({ type: 'ok', outcome: committed.outcome, changed: true });

    expect(clock.today).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith({
      type: 'add-comment',
      parent: { type: 'task', ref },
      text: 'from the injected clock',
      stamp: localDate('2026-07-14'),
    });
  });

  it('normalizes an empty description to the explicit clear command', async () => {
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    });

    await service({ edit }).execute({
      type: 'set-description',
      target: { type: 'task', ref },
      text: ' \t ',
    });

    expect(edit).toHaveBeenCalledWith({
      type: 'set-description',
      target: { type: 'task', ref },
      text: null,
    });
  });

  it('delegates nested structural commands without weakening their references', async () => {
    const parent = { type: 'task' as const, ref };
    const first = { parent, relativeLine: 1, originalBlock: '  - [ ] first' };
    const second = { parent, relativeLine: 2, originalBlock: '  - [ ] second' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    });
    const application = service({ edit });

    await application.execute({ type: 'add-subtask', parent, text: 'new child' });
    await application.execute({ type: 'delete-subtask', subtask: first });
    await application.execute({
      type: 'reorder-subtask',
      subtask: first,
      target: second,
      placement: 'after',
    });

    expect(edit.mock.calls.map(([command]) => command)).toEqual([
      { type: 'add-subtask', parent, text: 'new child' },
      { type: 'delete-subtask', subtask: first },
      {
        type: 'reorder-subtask',
        subtask: first,
        target: second,
        placement: 'after',
      },
    ]);
  });

  it.each(['', '   ', 'line one\nline two', 'line one\rline two'])(
    'rejects invalid add-subtask text %j before the repository',
    async (text) => {
      const edit = vi.fn<TaskRepository['edit']>();

      await expect(
        service({ edit }).execute({ type: 'add-subtask', parent: { type: 'task', ref }, text }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      });
      expect(edit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { type: 'add-comment' as const, parent: { type: 'task' as const, ref }, text: '' },
    {
      type: 'update-comment' as const,
      comment: {
        parent: { type: 'task' as const, ref },
        relativeLine: 1,
        originalMarkdown: '  - old',
      },
      text: 'line one\nline two',
    },
  ])('rejects invalid $type text before the repository or Clock', async (command) => {
    const edit = vi.fn<TaskRepository['edit']>();
    clock.today.mockClear();

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'comment' }],
    });
    expect(edit).not.toHaveBeenCalled();
    expect(clock.today).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: 'patch' as const,
      target: { type: 'task' as const, ref },
      patch: { markdownTitle: { type: 'set' as const, value: 'New [[Title]]' } },
    },
    {
      type: 'append-title' as const,
      target: { type: 'task' as const, ref },
      markdown: '[[Attachment.png|image]]',
    },
    {
      type: 'edit-link' as const,
      target: { type: 'title' as const, target: { type: 'task' as const, ref } },
      occurrence: 0,
      replacement: '[[Changed]]',
    },
  ])('delegates the source-aware $type command unchanged', async (command) => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledWith(command);
  });

  it.each([
    {
      command: {
        type: 'patch' as const,
        target: { type: 'task' as const, ref },
        patch: { markdownTitle: { type: 'set' as const, value: 'changed\n- [ ] injected' } },
      },
      field: 'title',
    },
    {
      command: {
        type: 'append-title' as const,
        target: { type: 'task' as const, ref },
        markdown: 'later\rinjected',
      },
      field: 'title',
    },
    {
      command: {
        type: 'edit-link' as const,
        target: { type: 'title' as const, target: { type: 'task' as const, ref } },
        occurrence: 0,
        replacement: '[[Changed]]\n- [ ] injected',
      },
      field: 'link',
    },
  ])(
    'rejects multiline $command.type input before touching the repository',
    async ({ command, field }) => {
      const edit = vi.fn<TaskRepository['edit']>();

      await expect(service({ edit }).execute(command)).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field }],
      });
      expect(edit).not.toHaveBeenCalled();
    },
  );

  it('normalizes task tag patches once at the application boundary with removal winning', async () => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);

    await service({ edit }).execute({
      type: 'patch',
      target: { type: 'task', ref },
      patch: {
        tags: {
          add: ['work', '#deep/nested', '#work', 'later', '#deep/nested'],
          remove: ['#old', 'work', '#old', 'later'],
        },
      },
    });

    expect(edit).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: {
        tags: {
          add: ['#deep/nested'],
          remove: ['#old', '#work', '#later'],
        },
      },
    });
  });

  it('normalizes nested-task tag patches without changing the target reference', async () => {
    const childRef = {
      parent: { type: 'task' as const, ref },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    });

    await service({ edit }).execute({
      type: 'patch',
      target: { type: 'subtask', ref: childRef },
      patch: { tags: { add: ['child/next'], remove: [] } },
    });

    expect(edit).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'subtask', ref: childRef },
      patch: { tags: { add: ['#child/next'], remove: [] } },
    });
  });

  it.each(['', '#', 'two words', '##double', '#bad!', '#bad\\tag'])(
    'rejects invalid tag %j before touching the repository',
    async (tag) => {
      const edit = vi.fn<TaskRepository['edit']>();

      await expect(
        service({ edit }).execute({
          type: 'patch',
          target: { type: 'task', ref },
          patch: { tags: { add: [tag] } },
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'tags' }],
      });
      expect(edit).not.toHaveBeenCalled();
    },
  );

  it('delegates a typed planning patch and maps a committed result', async () => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);
    const service = new TaskApplicationService(
      queries(),
      { edit, create: vi.fn(), move: vi.fn() },
      statuses,
      clock,
    );
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref },
      patch: { due: { type: 'set' as const, value: localDate('2026-07-20') } },
    };

    await expect(service.execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledWith(command);
  });

  it.each<TaskRepositoryResult>([
    { type: 'conflict', current: snapshot() },
    { type: 'not-found', target: { type: 'task', ref } },
    { type: 'ambiguous', candidates: [{ root: snapshot(), target: { type: 'task', ref } }] },
    { type: 'invalid', issues: [{ code: 'inverted-span', field: 'start,due' }] },
    {
      type: 'io-error',
      cause: 'disk unavailable',
      path: 'tasks.md',
      contentState: 'unknown',
    },
  ])('preserves the structured repository result $type', async (result) => {
    const repository: TaskRepository = {
      edit: vi.fn().mockResolvedValue(result),
      create: vi.fn(),
      move: vi.fn(),
    };
    const service = new TaskApplicationService(queries(), repository, statuses, clock);

    await expect(
      service.execute({ type: 'reschedule', ref, date: localDate('2026-07-21') }),
    ).resolves.toEqual(result);
  });

  it('maps an unexpected adapter rejection without leaking task Markdown', async () => {
    const repository: TaskRepository = {
      edit: vi.fn().mockRejectedValue(new Error('- [ ] secret task')),
      create: vi.fn(),
      move: vi.fn(),
    };
    const service = new TaskApplicationService(queries(), repository, statuses, clock);

    await expect(
      service.execute({ type: 'reschedule', ref, date: localDate('2026-07-21') }),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    });
  });

  it.each([
    {
      type: 'set-time-slot' as const,
      ref,
      date: localDate('2026-07-21'),
      time: localTime('09:30'),
      duration: durationMinutes(90),
    },
    { type: 'convert-to-all-day' as const, ref, date: localDate('2026-07-21') },
    {
      type: 'set-span-boundary' as const,
      ref,
      boundary: 'start' as const,
      date: localDate('2026-07-19'),
    },
    { type: 'extend-span' as const, ref, due: localDate('2026-07-22') },
  ])('delegates the semantic $type command unchanged', async (command) => {
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);
    const service = new TaskApplicationService(
      queries(),
      { edit, create: vi.fn(), move: vi.fn() },
      statuses,
      clock,
    );

    await expect(service.execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(command);
  });

  it('delegates one atomic span shift and returns its updated snapshot', async () => {
    const updated = {
      ...snapshot(),
      ref: { ...ref, revision: 'shifted' },
      planning: { start: localDate('2026-07-19'), due: localDate('2026-07-21') },
    };
    const committed: TaskRepositoryResult = {
      type: 'committed',
      outcome: { type: 'task', task: updated },
      changed: true,
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(committed);
    const command = { type: 'shift-schedule' as const, ref, days: 1 as const };

    await expect(service({ edit }).execute(command)).resolves.toEqual({
      type: 'ok',
      outcome: committed.outcome,
      changed: true,
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(command);
  });

  it.each<TaskRepositoryResult>([
    { type: 'conflict', current: snapshot() },
    { type: 'not-found', target: { type: 'task', ref } },
    { type: 'ambiguous', candidates: [{ root: snapshot(), target: { type: 'task', ref } }] },
    { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] },
  ])('preserves the $type result of a schedule shift', async (result) => {
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue(result);

    await expect(
      service({ edit }).execute({ type: 'shift-schedule', ref, days: 1 }),
    ).resolves.toEqual(result);
    expect(edit).toHaveBeenCalledOnce();
  });

  it('maps a schedule-shift repository rejection to a structured io error', async () => {
    const edit = vi.fn<TaskRepository['edit']>().mockRejectedValue(new Error('disk unavailable'));

    await expect(
      service({ edit }).execute({ type: 'shift-schedule', ref, days: 1 }),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    });
    expect(edit).toHaveBeenCalledOnce();
  });

  it('normalizes uppercase X and stamps a genuine transition with the injected local day', async () => {
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: snapshot() }),
    };
    clock.today.mockClear();

    await service({ edit }, exactQueries).execute({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'X',
    });

    expect(clock.today).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'x',
      stamp: localDate('2026-07-14'),
    });
  });

  it('rejects unknown status symbols before touching the repository or Clock', async () => {
    const edit = vi.fn<TaskRepository['edit']>();
    clock.today.mockClear();

    await expect(
      service({ edit }).execute({
        type: 'set-status',
        target: { type: 'task', ref },
        symbol: '?',
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-status', field: 'status' }],
    });
    expect(edit).not.toHaveBeenCalled();
    expect(clock.today).not.toHaveBeenCalled();
  });

  it('toggles done to the configured todo without reading Clock', async () => {
    const done = { ...snapshot(), status: 'done' as const, statusSymbol: 'x' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: snapshot() },
      changed: true,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: done }),
    };
    clock.today.mockClear();

    await service({ edit }, exactQueries).execute({
      type: 'toggle-completion',
      target: { type: 'task', ref },
    });

    expect(clock.today).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: ' ',
    });
  });

  it('treats an existing uppercase X as the normalized done status without restamping', async () => {
    const uppercaseDone = { ...snapshot(), status: 'done' as const, statusSymbol: 'X' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: uppercaseDone },
      changed: false,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: uppercaseDone }),
    };
    clock.today.mockClear();

    await service({ edit }, exactQueries).execute({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'X',
    });

    expect(clock.today).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'X',
    });
  });

  it('changes between configured done symbols without reading Clock or restamping', async () => {
    const done = {
      ...snapshot(),
      status: 'done' as const,
      statusSymbol: 'x',
      planning: { ...snapshot().planning, completion: localDate('2026-07-01') },
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: done },
      changed: true,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: done }),
    };
    clock.today.mockClear();

    await service({ edit }, exactQueries).execute({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'd',
    });

    expect(clock.today).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'd',
    });
  });

  it('changes between configured cancelled symbols without reading Clock or restamping', async () => {
    const cancelled = {
      ...snapshot(),
      status: 'cancelled' as const,
      statusSymbol: '-',
      planning: { ...snapshot().planning, cancelled: localDate('2026-07-01') },
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: cancelled },
      changed: true,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: cancelled }),
    };
    clock.today.mockClear();

    await service({ edit }, exactQueries).execute({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'k',
    });

    expect(clock.today).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'k',
    });
  });

  it('accepts an immediately returned fresh ref before the query index catches up', async () => {
    const fresh = { ...snapshot(), ref: { ...ref, revision: 'fresh' } };
    const afterToggle = {
      ...fresh,
      ref: { ...ref, revision: 'after-toggle' },
      status: 'done' as const,
      statusSymbol: 'x',
    };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: fresh },
        changed: true,
      })
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: afterToggle },
        changed: true,
      });
    const laggingQueries: TaskQueryApi = {
      ...queries(),
      resolve: (target) =>
        target.revision === ref.revision
          ? { type: 'exact', task: snapshot() }
          : { type: 'conflict', current: snapshot() },
    };
    const application = service({ edit }, laggingQueries);
    const first = await application.execute({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (first.type !== 'ok' || first.outcome.type !== 'task') throw new Error('missing outcome');
    const mutableOutcome = first.outcome.task as { status: 'done'; statusSymbol: string };
    mutableOutcome.status = 'done';
    mutableOutcome.statusSymbol = 'x';

    await expect(
      application.execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: first.outcome.task.ref },
      }),
    ).resolves.toMatchObject({ type: 'ok', outcome: { task: { ref: afterToggle.ref } } });
    expect(edit).toHaveBeenLastCalledWith({
      type: 'set-status',
      target: { type: 'task', ref: fresh.ref },
      symbol: 'x',
      stamp: localDate('2026-07-14'),
    });
  });

  it('accepts an immediately returned fresh nested ref before the query index catches up', async () => {
    const initialRoot = snapshot();
    const initialNode = { type: 'task' as const, ref: initialRoot.ref };
    const initialChild = {
      ref: {
        parent: initialNode,
        relativeLine: 1,
        originalBlock: '  - [ ] child',
      },
      title: 'child',
      markdownTitle: 'child',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      planning: {},
      tags: [],
      subtasks: [],
      comments: [],
    };
    const rootWithChild = { ...initialRoot, subtasks: [initialChild] };
    const freshRef = { ...ref, revision: 'fresh-nested' };
    const freshNode = { type: 'task' as const, ref: freshRef };
    const freshChild = {
      ...initialChild,
      ref: {
        ...initialChild.ref,
        parent: freshNode,
        originalBlock: '  - [ ] child ⏫',
      },
      priority: 'A' as const,
    };
    const freshRoot = { ...rootWithChild, ref: freshRef, subtasks: [freshChild] };
    const doneRef = { ...ref, revision: 'done-nested' };
    const doneRoot = {
      ...freshRoot,
      ref: doneRef,
      subtasks: [
        {
          ...freshChild,
          ref: {
            ...freshChild.ref,
            parent: { type: 'task' as const, ref: doneRef },
            originalBlock: '  - [x] child ⏫ ✅ 2026-07-14',
          },
          status: 'done' as const,
          statusSymbol: 'x',
        },
      ],
    };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: freshRoot },
        changed: true,
      })
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: doneRoot },
        changed: true,
      });
    const laggingQueries: TaskQueryApi = {
      ...queries(),
      resolve: (target) =>
        target.revision === ref.revision
          ? { type: 'exact', task: rootWithChild }
          : { type: 'conflict', current: rootWithChild },
    };
    const application = service({ edit }, laggingQueries);
    const first = await application.execute({
      type: 'patch',
      target: { type: 'subtask', ref: initialChild.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (first.type !== 'ok' || first.outcome.type !== 'task') throw new Error('missing outcome');
    const returnedChild = first.outcome.task.subtasks[0]!;
    const mutableChild = returnedChild as { status: 'done'; statusSymbol: string };
    mutableChild.status = 'done';
    mutableChild.statusSymbol = 'x';

    await expect(
      application.execute({
        type: 'toggle-completion',
        target: { type: 'subtask', ref: returnedChild.ref },
      }),
    ).resolves.toMatchObject({ type: 'ok', outcome: { task: { ref: doneRef } } });
    expect(edit).toHaveBeenLastCalledWith({
      type: 'set-status',
      target: { type: 'subtask', ref: freshChild.ref },
      symbol: 'x',
      stamp: localDate('2026-07-14'),
    });
  });

  it('lets the repository reject an externally stale ref even when its prior outcome is cached', async () => {
    const fresh = { ...snapshot(), ref: { ...ref, revision: 'fresh-before-external-edit' } };
    const external = { ...snapshot(), ref: { ...ref, revision: 'external-edit' } };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: fresh },
        changed: true,
      })
      .mockResolvedValueOnce({ type: 'conflict', current: external });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: snapshot() }),
    };
    const application = service({ edit }, exactQueries);
    const first = await application.execute({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (first.type !== 'ok' || first.outcome.type !== 'task') throw new Error('missing outcome');

    await expect(
      application.execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: first.outcome.task.ref },
      }),
    ).resolves.toEqual({ type: 'conflict', current: external });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('bounds recent outcome refs and falls back to query resolution after eviction', async () => {
    let revision = 0;
    const edit = vi.fn<TaskRepository['edit']>().mockImplementation(async () => ({
      type: 'committed' as const,
      outcome: {
        type: 'task' as const,
        task: { ...snapshot(), ref: { ...ref, revision: `outcome-${revision++}` } },
      },
      changed: true,
    }));
    const current = { ...snapshot(), ref: { ...ref, revision: 'current-index-revision' } };
    const laggingQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'conflict', current }),
    };
    const application = service({ edit }, laggingQueries);
    let firstReturned: TaskSnapshot | undefined;
    for (let index = 0; index < 65; index++) {
      const result = await application.execute({
        type: 'patch',
        target: { type: 'task', ref: { ...ref, revision: `input-${index}` } },
        patch: { priority: { type: 'set', value: 'A' } },
      });
      if (result.type !== 'ok' || result.outcome.type !== 'task')
        throw new Error('missing outcome');
      firstReturned ??= result.outcome.task;
    }
    if (!firstReturned) throw new Error('missing first outcome');

    await expect(
      application.execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: firstReturned.ref },
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(edit).toHaveBeenCalledTimes(65);
  });

  it('returns a stale conflict before toggling and does not read Clock', async () => {
    const current = { ...snapshot(), ref: { ...ref, revision: 'new' } };
    const edit = vi.fn<TaskRepository['edit']>();
    const staleQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'conflict', current }),
    };
    clock.today.mockClear();

    await expect(
      service({ edit }, staleQueries).execute({
        type: 'toggle-completion',
        target: { type: 'task', ref },
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(edit).not.toHaveBeenCalled();
    expect(clock.today).not.toHaveBeenCalled();
  });

  it('toggles an unknown checkbox through the configured custom done default', async () => {
    const custom = new StatusCatalog([
      { id: 'todo', symbol: 'o', type: 'todo', defaultForType: true },
      { id: 'done', symbol: 'd', type: 'done', defaultForType: true },
    ]);
    const unknown = { ...snapshot(), status: 'open' as const, statusSymbol: '?' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: unknown },
      changed: true,
    });
    const exactQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({ type: 'exact', task: unknown }),
    };
    clock.today.mockClear();
    const application = new TaskApplicationService(
      exactQueries,
      { edit, create: vi.fn(), move: vi.fn() },
      custom,
      clock,
    );

    await application.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref },
    });

    expect(edit).toHaveBeenCalledWith({
      type: 'set-status',
      target: { type: 'task', ref },
      symbol: 'd',
      stamp: localDate('2026-07-14'),
    });
  });

  it('rebases an ambiguous nested target onto every current candidate root', async () => {
    const childRef = {
      parent: { type: 'task' as const, ref },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const candidate = {
      ...snapshot(),
      ref: { ...ref, line: 4, revision: 'candidate' },
      source: { ...snapshot().source, line: 4 },
    };
    const ambiguousQueries: TaskQueryApi = {
      ...queries(),
      resolve: () => ({
        type: 'ambiguous',
        candidates: [{ root: candidate, target: { type: 'task', ref: candidate.ref } }],
      }),
    };
    const edit = vi.fn<TaskRepository['edit']>();

    await expect(
      service({ edit }, ambiguousQueries).execute({
        type: 'set-status',
        target: { type: 'subtask', ref: childRef },
        symbol: '/',
      }),
    ).resolves.toEqual({
      type: 'ambiguous',
      candidates: [
        {
          root: candidate,
          target: {
            type: 'subtask',
            ref: {
              ...childRef,
              parent: { type: 'task', ref: candidate.ref },
            },
          },
        },
      ],
    });
    expect(edit).not.toHaveBeenCalled();
  });
});
