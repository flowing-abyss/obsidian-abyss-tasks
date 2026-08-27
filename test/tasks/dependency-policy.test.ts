import { describe, expect, it, vi } from 'vitest';
import { DependencyIndex } from '../../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../../src/projects/dependencies/DependencyPolicy';
import type { DependencyPolicyPort } from '../../src/tasks/application/DependencyPolicyPort';
import type { TaskQueryApi } from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskRepository } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, taskQueryApi } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

function task(
  line: number,
  dependency: Partial<NonNullable<TaskSnapshot['dependency']>> = {},
  status: TaskSnapshot['status'] = 'open',
): TaskSnapshot {
  const originalMarkdown = `- [${status === 'done' ? 'x' : ' '}] Task ${String(line)}`;
  return {
    ref: { filePath: 'Tasks.md', line, revision: `r-${String(line)}-${status}` },
    title: `Task ${String(line)}`,
    markdownTitle: `Task ${String(line)}`,
    status,
    statusSymbol: status === 'done' ? 'x' : status === 'cancelled' ? '-' : ' ',
    priority: 'D',
    planning: {},
    tags: [],
    onCompletion: 'keep',
    onCompletionExplicit: false,
    subtasks: [],
    comments: [],
    dependency: { dependsOn: [], ...dependency },
    source: { filePath: 'Tasks.md', line, originalMarkdown, originalBlock: originalMarkdown },
    presentation: { linkCount: 0 },
  };
}

const statuses = new StatusCatalog([
  { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
  { id: 'doing', symbol: '/', type: 'in-progress', defaultForType: true },
  { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
  { id: 'cancelled', symbol: '-', type: 'cancelled', defaultForType: true },
]);

const allowedPolicyMethods = {
  inspect: () => ({ decision: { type: 'allowed' as const }, relations: [] }),
  validateLink: () => ({ type: 'allowed' as const }),
};

function exactQueries(tasks: readonly TaskSnapshot[]): TaskQueryApi {
  return taskQueryApi({
    list: () => tasks,
    resolve: (ref) => {
      const current = tasks.find(
        (candidate) =>
          candidate.ref.filePath === ref.filePath &&
          candidate.ref.line === ref.line &&
          candidate.ref.revision === ref.revision,
      );
      return current
        ? { type: 'exact', task: current, basis: { observed: current } }
        : { type: 'not-found', ref };
    },
  });
}

function application(
  tasks: readonly TaskSnapshot[],
  repository: Pick<TaskRepository, 'edit'> &
    Partial<Pick<TaskRepository, 'completeRecurrence' | 'create' | 'move'>>,
  policy: DependencyPolicyPort,
): TaskApplicationService {
  return new TaskApplicationService(
    exactQueries(tasks),
    {
      edit: repository.edit,
      completeRecurrence: repository.completeRecurrence ?? vi.fn(),
      create: repository.create ?? vi.fn(),
      move: repository.move ?? vi.fn(),
    },
    statuses,
    { today: () => localDate('2026-08-28') },
    undefined,
    undefined,
    undefined,
    policy,
  );
}

describe('DependencyPolicy', () => {
  it('allows a dependent only after every prerequisite is complete', () => {
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { id: 'ship', dependsOn: ['prep'] });
    const index = new DependencyIndex();
    const policy = new DependencyPolicy(index);
    index.replace([prerequisite, dependent]);

    expect(policy.evaluateCompletion(dependent)).toEqual({
      type: 'blocked',
      prerequisites: [prerequisite.ref],
    });

    const donePrerequisite = task(1, { id: 'prep' }, 'done');
    policy.acceptCommittedDelta({ replaced: [prerequisite], roots: [donePrerequisite] });

    expect(policy.evaluateCompletion(dependent)).toEqual({ type: 'allowed' });
  });

  it.each([
    [
      'missing',
      [task(1, { id: 'subject', dependsOn: ['gone'] })],
      task(1, { id: 'subject', dependsOn: ['gone'] }),
      'missing-prerequisite',
    ],
    [
      'duplicate',
      [task(1, { id: 'same' }), task(2, { id: 'same' }), task(3, { dependsOn: ['same'] })],
      task(3, { dependsOn: ['same'] }),
      'duplicate-id',
    ],
    [
      'self',
      [task(1, { id: 'self', dependsOn: ['self'] })],
      task(1, { id: 'self', dependsOn: ['self'] }),
      'self-edge',
    ],
    [
      'cycle',
      [task(1, { id: 'a', dependsOn: ['b'] }), task(2, { id: 'b', dependsOn: ['a'] })],
      task(1, { id: 'a', dependsOn: ['b'] }),
      'cycle',
    ],
  ] as const)('returns an invalid decision for a %s projection', (_name, tasks, subject, type) => {
    const index = new DependencyIndex();
    index.replace(tasks);

    expect(new DependencyPolicy(index).evaluateCompletion(subject)).toMatchObject({
      type: 'invalid',
      diagnostics: [expect.objectContaining({ type })],
    });
  });

  it('fails closed when a dependent has not settled into the graph', () => {
    const dependent = task(2, { dependsOn: ['prep'] });

    expect(new DependencyPolicy(new DependencyIndex()).evaluateCompletion(dependent)).toEqual({
      type: 'invalid',
      diagnostics: [{ type: 'unresolved-projection' }],
    });
  });
});

describe('TaskApplicationService dependency completion gate', () => {
  it.each([
    ['checkbox', { type: 'toggle-completion' as const }],
    ['status menu', { type: 'set-status' as const, symbol: 'x' }],
    ['bulk status', { type: 'set-status' as const, symbol: 'x' }],
    ['calendar', { type: 'toggle-completion' as const }],
    ['command or hotkey', { type: 'set-status' as const, symbol: 'x' }],
  ])('blocks the %s Done intent before repository access', async (_surface, statusIntent) => {
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { dependsOn: ['prep'] });
    const index = new DependencyIndex();
    index.replace([prerequisite, dependent]);
    const edit = vi.fn<TaskRepository['edit']>();
    const service = application([prerequisite, dependent], { edit }, new DependencyPolicy(index));

    await expect(
      service.execute({
        ...statusIntent,
        target: { type: 'task', ref: dependent.ref },
      }),
    ).resolves.toEqual({
      type: 'blocked',
      operation: 'completion',
      dependency: { type: 'blocked', prerequisites: [prerequisite.ref] },
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unresolved',
      [] as readonly TaskSnapshot[],
      task(1, { dependsOn: ['prep'] }),
      'unresolved-projection',
    ],
    [
      'missing',
      [task(1, { dependsOn: ['missing'] })],
      task(1, { dependsOn: ['missing'] }),
      'missing-prerequisite',
    ],
    [
      'duplicate',
      [task(1, { id: 'same' }), task(2, { id: 'same' }), task(3, { dependsOn: ['same'] })],
      task(3, { dependsOn: ['same'] }),
      'duplicate-id',
    ],
    [
      'self edge',
      [task(1, { id: 'self', dependsOn: ['self'] })],
      task(1, { id: 'self', dependsOn: ['self'] }),
      'self-edge',
    ],
    [
      'cycle',
      [task(1, { id: 'a', dependsOn: ['b'] }), task(2, { id: 'b', dependsOn: ['a'] })],
      task(1, { id: 'a', dependsOn: ['b'] }),
      'cycle',
    ],
  ] as const)(
    'blocks an %s dependency projection before repository access',
    async (_name, indexed, subject, diagnosticType) => {
      const index = new DependencyIndex();
      index.replace(indexed);
      const edit = vi.fn<TaskRepository['edit']>();

      await expect(
        application([subject], { edit }, new DependencyPolicy(index)).execute({
          type: 'set-status',
          target: { type: 'task', ref: subject.ref },
          symbol: 'x',
        }),
      ).resolves.toMatchObject({
        type: 'blocked',
        operation: 'completion',
        dependency: {
          type: 'invalid',
          diagnostics: [expect.objectContaining({ type: diagnosticType })],
        },
      });
      expect(edit).not.toHaveBeenCalled();
    },
  );

  it('allows cancellation and other non-Done status transitions while dependencies are blocked', async () => {
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { dependsOn: ['prep'] });
    const cancelled = { ...dependent, status: 'cancelled' as const, statusSymbol: '-' };
    const inProgress = { ...dependent, status: 'in-progress' as const, statusSymbol: '/' };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: cancelled },
        changed: true,
      })
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: inProgress },
        changed: true,
      });
    const index = new DependencyIndex();
    index.replace([prerequisite, dependent]);
    const service = application([prerequisite, dependent], { edit }, new DependencyPolicy(index));

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: dependent.ref },
        symbol: '-',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: cancelled.ref },
        symbol: '/',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('allows a dependent immediately after an ordinary prerequisite completion commits', async () => {
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { dependsOn: ['prep'] });
    const completedPrerequisite = task(1, { id: 'prep' }, 'done');
    const completedDependent = task(2, { dependsOn: ['prep'] }, 'done');
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: completedPrerequisite },
        changed: true,
      })
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: completedDependent },
        changed: true,
      });
    const index = new DependencyIndex();
    index.replace([prerequisite, dependent]);
    const service = application([prerequisite, dependent], { edit }, new DependencyPolicy(index));

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: prerequisite.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: dependent.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('blocks recurrence completion before the recurrence repository path runs', async () => {
    const prerequisite = task(1, { id: 'prep' });
    const recurringDependent = {
      ...task(2, { dependsOn: ['prep'] }),
      recurrence: 'every day',
      planning: { due: localDate('2026-08-28') },
    } satisfies TaskSnapshot;
    const index = new DependencyIndex();
    index.replace([prerequisite, recurringDependent]);
    const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>();
    const edit = vi.fn<TaskRepository['edit']>();

    await expect(
      application(
        [prerequisite, recurringDependent],
        { edit, completeRecurrence },
        new DependencyPolicy(index),
      ).execute({
        type: 'set-status',
        target: { type: 'task', ref: recurringDependent.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({
      type: 'blocked',
      operation: 'completion',
      dependency: { type: 'blocked' },
    });
    expect(completeRecurrence).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it('does not apply a root dependency gate to a subtask completion', async () => {
    const prerequisite = task(1, { id: 'prep' });
    const child = {
      ref: {
        parent: { type: 'task' as const, ref: task(2).ref },
        relativeLine: 1,
        originalBlock: '  - [ ] Child',
      },
      title: 'Child',
      markdownTitle: 'Child',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      planning: {},
      tags: [],
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      subtasks: [],
      comments: [],
    };
    const root = { ...task(2, { dependsOn: ['prep'] }), subtasks: [child] };
    const completedRoot = {
      ...root,
      subtasks: [{ ...child, status: 'done' as const, statusSymbol: 'x' }],
    };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: completedRoot },
      changed: true,
    });
    const index = new DependencyIndex();
    index.replace([prerequisite, root]);

    await expect(
      application([prerequisite, root], { edit }, new DependencyPolicy(index)).execute({
        type: 'toggle-completion',
        target: { type: 'subtask', ref: child.ref },
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledOnce();
  });

  it.each(['before', 'after'] as const)(
    'makes a %s-placed recurring prerequisite completion visible without replacing an adjacent dependent',
    async (placement) => {
      const prerequisite = {
        ...task(1, { id: 'prep' }),
        recurrence: 'every day',
        planning: { due: localDate('2026-08-28') },
      } satisfies TaskSnapshot;
      const dependent = task(2, { dependsOn: ['prep'] });
      const active = {
        ...task(placement === 'before' ? 1 : 2),
        ref: {
          ...prerequisite.ref,
          line: placement === 'before' ? 1 : 2,
          revision: 'active-next',
        },
        recurrence: 'every day',
        planning: { due: localDate('2026-08-29') },
      } satisfies TaskSnapshot;
      const completed = {
        ...task(placement === 'before' ? 2 : 1, { id: 'prep' }, 'done'),
        recurrence: 'every day',
        planning: {
          due: localDate('2026-08-28'),
          completion: localDate('2026-08-28'),
        },
      } satisfies TaskSnapshot;
      const completedDependent = task(2, { dependsOn: ['prep'] }, 'done');
      const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>().mockResolvedValue({
        type: 'committed',
        outcome: {
          type: 'recurrence',
          active: { root: active, target: { type: 'task', ref: active.ref } },
          completed: { root: completed, target: { type: 'task', ref: completed.ref } },
        },
        changed: true,
      });
      const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: completedDependent },
        changed: true,
      });
      const index = new DependencyIndex();
      index.replace([prerequisite, dependent]);
      const service = application(
        [prerequisite, dependent],
        { edit, completeRecurrence },
        new DependencyPolicy(index),
      );

      const first = await service.execute({
        type: 'set-status',
        target: { type: 'task', ref: prerequisite.ref },
        symbol: 'x',
      });
      expect(first).toMatchObject({ type: 'ok', outcome: { type: 'recurrence' } });

      await expect(
        service.execute({
          type: 'set-status',
          target: { type: 'task', ref: dependent.ref },
          symbol: 'x',
        }),
      ).resolves.toMatchObject({ type: 'ok' });
      expect(completeRecurrence).toHaveBeenCalledOnce();
      expect(edit).toHaveBeenCalledOnce();
    },
  );

  it.each(['before', 'after'] as const)(
    'preserves an adjacent dependent across a real %s recurrence repository rewrite',
    async (placement) => {
      const path = 'Tasks.md';
      const source =
        '- [ ] Recurring 🔁 every day 📅 2026-08-28 🆔 prep\n' +
        '- [ ] Dependent ⛔ prep 🆔 ship\n' +
        '- [ ] Downstream ⛔ ship\n';
      const app = await createAppWithFiles({ [path]: source });
      const authority = new TaskRefAuthority(`dependency-recurrence-${placement}`);
      const taskIndex = new TaskIndex(app, {
        statusCatalog: statuses,
        dailyNoteFormat: 'YYYY-MM-DD',
        refAuthority: authority,
      });
      await taskIndex.initialize();
      taskIndex.installCommittedContent(path, source);
      const roots = taskIndex.previewContent(path, source);
      const prerequisite = roots.find(({ title }) => title === 'Recurring')!;
      const dependent = roots.find(({ title }) => title === 'Dependent')!;
      expect(prerequisite.dependency).toEqual({ id: 'prep', dependsOn: [] });
      expect(dependent.dependency).toEqual({ id: 'ship', dependsOn: ['prep'] });
      const graph = new DependencyIndex();
      graph.replace(roots);
      const policy = new DependencyPolicy(graph);
      const repository = new InMemoryTaskRepository({
        files: { [path]: source },
        codec: new TaskMarkdownCodec(statuses),
        snapshotsFromContent: (filePath, content) => taskIndex.previewContent(filePath, content),
        snapshotState: taskIndex,
        refAuthority: authority,
        locator: new TaskLocator(authority),
      });
      const service = new TaskApplicationService(
        taskIndex,
        repository,
        statuses,
        { today: () => localDate('2026-08-28') },
        undefined,
        () => ({
          taskLifecycle: { addCreatedDate: false, addCompletionDate: true },
          recurrence: { newOccurrencePlacement: placement, removeScheduledDate: false },
        }),
        graph,
        policy,
      );

      const recurrenceResult = await service.execute({
        type: 'set-status',
        target: { type: 'task', ref: prerequisite.ref },
        symbol: 'x',
      });
      expect(recurrenceResult).toMatchObject({ type: 'ok', outcome: { type: 'recurrence' } });
      const canonicalDependent = taskIndex.list().find(({ title }) => title === 'Dependent')!;
      expect(canonicalDependent.ref).not.toEqual(dependent.ref);
      expect(policy.evaluateCompletion(canonicalDependent)).toEqual({ type: 'allowed' });
      await expect(
        service.execute({
          type: 'set-status',
          target: { type: 'task', ref: canonicalDependent.ref },
          symbol: 'x',
        }),
      ).resolves.toMatchObject({ type: 'ok' });
      const canonicalDownstream = taskIndex.list().find(({ title }) => title === 'Downstream')!;
      expect(policy.evaluateCompletion(canonicalDownstream)).toEqual({ type: 'allowed' });
      await expect(
        service.execute({
          type: 'set-status',
          target: { type: 'task', ref: canonicalDownstream.ref },
          symbol: 'x',
        }),
      ).resolves.toMatchObject({ type: 'ok' });
      taskIndex.destroy();
    },
  );

  it.each(['create', 'move'] as const)(
    'keeps an existing destination root when a committed %s is inserted at its stale line',
    async (kind) => {
      const source = {
        ...task(4),
        ref: { filePath: 'Source.md', line: 0, revision: 'source' },
        source: {
          filePath: 'Source.md',
          line: 0,
          originalMarkdown: '- [ ] Source',
          originalBlock: '- [ ] Source',
        },
      } satisfies TaskSnapshot;
      const existing = {
        ...task(0, { id: 'existing' }),
        ref: { filePath: 'Target.md', line: 0, revision: 'existing' },
        source: {
          filePath: 'Target.md',
          line: 0,
          originalMarkdown: '- [ ] Existing 🆔 existing',
          originalBlock: '- [ ] Existing 🆔 existing',
        },
      } satisfies TaskSnapshot;
      const inserted = {
        ...task(0),
        ref: { filePath: 'Target.md', line: 0, revision: 'inserted' },
        source: {
          filePath: 'Target.md',
          line: 0,
          originalMarkdown: '- [ ] Inserted',
          originalBlock: '- [ ] Inserted',
        },
      } satisfies TaskSnapshot;
      const index = new DependencyIndex();
      index.replace([source, existing]);
      const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: inserted },
        changed: true,
      });
      const move = vi.fn<TaskRepository['move']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: inserted },
        changed: true,
      });
      const service = application(
        [source, existing],
        { edit: vi.fn(), create, move },
        new DependencyPolicy(index),
      );

      await expect(
        kind === 'create'
          ? service.execute({
              type: 'create',
              markdownBody: 'Inserted',
              destination: {
                type: 'explicit',
                destination: { filePath: 'Target.md', insertion: { type: 'append' } },
              },
            })
          : service.execute({
              type: 'move',
              ref: source.ref,
              destination: { filePath: 'Target.md', insertion: { type: 'append' } },
            }),
      ).resolves.toMatchObject({ type: 'ok' });
      expect(index.get(existing.ref)).toMatchObject({ type: 'ready', ref: existing.ref });
    },
  );

  it('makes a deleted prerequisite an invalid missing edge before index events', async () => {
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { dependsOn: ['prep'] });
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValueOnce({
      type: 'committed',
      outcome: { type: 'deleted', ref: prerequisite.ref },
      changed: true,
    });
    const index = new DependencyIndex();
    index.replace([prerequisite, dependent]);
    const service = application([prerequisite, dependent], { edit }, new DependencyPolicy(index));

    await service.execute({ type: 'delete', ref: prerequisite.ref });

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: dependent.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({
      type: 'blocked',
      dependency: {
        type: 'invalid',
        diagnostics: [expect.objectContaining({ type: 'missing-prerequisite', id: 'prep' })],
      },
    });
    expect(edit).toHaveBeenCalledOnce();
  });

  it('keeps committed outcomes authoritative when dependency projection delivery throws', async () => {
    const original = task(1);
    const firstCommitted = { ...original, ref: { ...original.ref, revision: 'first-commit' } };
    const secondCommitted = {
      ...firstCommitted,
      ref: { ...firstCommitted.ref, revision: 'second-commit' },
    };
    const throwingPolicy: DependencyPolicyPort = {
      ...allowedPolicyMethods,
      evaluateCompletion: () => ({ type: 'allowed' }),
      subscribe: () => () => {},
      acceptCommittedDelta: () => {
        throw new Error('projection failed');
      },
    };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: firstCommitted },
        changed: true,
      })
      .mockResolvedValueOnce({
        type: 'committed',
        outcome: { type: 'task', task: secondCommitted },
        changed: true,
      });
    const service = application([original], { edit }, throwingPolicy);

    const first = await service.execute({
      type: 'patch',
      target: { type: 'task', ref: original.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    expect(first).toMatchObject({ type: 'ok', outcome: { type: 'task', task: firstCommitted } });

    await expect(
      service.execute({
        type: 'patch',
        target: { type: 'task', ref: firstCommitted.ref },
        patch: { priority: { type: 'set', value: 'B' } },
      }),
    ).resolves.toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: secondCommitted },
    });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it.each(['recurrence', 'delete', 'move', 'create'] as const)(
    'contains throwing dependency projection after a committed %s result',
    async (kind) => {
      const original = {
        ...task(1),
        ...(kind === 'recurrence' && {
          recurrence: 'every day',
          planning: { due: localDate('2026-08-28') },
        }),
      } satisfies TaskSnapshot;
      const active = { ...task(1), ref: { ...original.ref, revision: 'active' } };
      const completed = task(2, {}, 'done');
      const created = { ...task(3), ref: { ...task(3).ref, revision: 'created' } };
      const moved = {
        ...task(1),
        ref: { filePath: 'Moved.md', line: 0, revision: 'moved' },
        source: {
          filePath: 'Moved.md',
          line: 0,
          originalMarkdown: '- [ ] Task 1',
          originalBlock: '- [ ] Task 1',
        },
      };
      const throwingPolicy: DependencyPolicyPort = {
        ...allowedPolicyMethods,
        evaluateCompletion: () => ({ type: 'allowed' }),
        subscribe: () => () => {},
        acceptCommittedDelta: () => {
          throw new Error('projection failed');
        },
      };
      const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
        type: 'committed',
        outcome:
          kind === 'delete'
            ? { type: 'deleted', ref: original.ref }
            : { type: 'task', task: original },
        changed: true,
      });
      const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>().mockResolvedValue({
        type: 'committed',
        outcome: {
          type: 'recurrence',
          active: { root: active, target: { type: 'task', ref: active.ref } },
          completed: { root: completed, target: { type: 'task', ref: completed.ref } },
        },
        changed: true,
      });
      const move = vi.fn<TaskRepository['move']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: moved },
        changed: true,
      });
      const create = vi.fn<TaskRepository['create']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: created },
        changed: true,
      });
      const service = application(
        [original],
        { edit, completeRecurrence, move, create },
        throwingPolicy,
      );
      const command =
        kind === 'recurrence'
          ? ({
              type: 'set-status',
              target: { type: 'task', ref: original.ref },
              symbol: 'x',
            } as const)
          : kind === 'delete'
            ? ({ type: 'delete', ref: original.ref } as const)
            : kind === 'move'
              ? ({
                  type: 'move',
                  ref: original.ref,
                  destination: { filePath: 'Moved.md', insertion: { type: 'append' } },
                } as const)
              : ({
                  type: 'create',
                  markdownBody: 'Created',
                  destination: {
                    type: 'explicit',
                    destination: { filePath: 'Tasks.md', insertion: { type: 'append' } },
                  },
                } as const);

      await expect(service.execute(command)).resolves.toMatchObject({ type: 'ok' });
    },
  );

  it.each(['delete', 'move'] as const)(
    'forgets the consumed recent source before policy synchronization after %s',
    async (kind) => {
      const original = task(1);
      const current = { ...original, ref: { ...original.ref, revision: 'current' } };
      const moved = {
        ...current,
        ref: { filePath: 'Moved.md', line: 0, revision: 'moved' },
        source: { ...current.source, filePath: 'Moved.md', line: 0 },
      } satisfies TaskSnapshot;
      const throwingPolicy: DependencyPolicyPort = {
        ...allowedPolicyMethods,
        evaluateCompletion: () => ({ type: 'allowed' }),
        subscribe: () => () => {},
        acceptCommittedDelta: () => {
          throw new Error('projection failed');
        },
      };
      const edit = vi
        .fn<TaskRepository['edit']>()
        .mockResolvedValueOnce({
          type: 'committed',
          outcome: { type: 'task', task: current },
          changed: true,
        })
        .mockResolvedValueOnce({
          type: 'committed',
          outcome: { type: 'deleted', ref: current.ref },
          changed: true,
        });
      const move = vi.fn<TaskRepository['move']>().mockResolvedValue({
        type: 'committed',
        outcome: { type: 'task', task: moved },
        changed: true,
      });
      const service = application([original], { edit, move }, throwingPolicy);
      await service.execute({
        type: 'patch',
        target: { type: 'task', ref: original.ref },
        patch: { priority: { type: 'set', value: 'A' } },
      });

      await expect(
        kind === 'delete'
          ? service.execute({ type: 'delete', ref: current.ref })
          : service.execute({
              type: 'move',
              ref: current.ref,
              destination: { filePath: 'Moved.md', insertion: { type: 'append' } },
            }),
      ).resolves.toMatchObject({ type: 'ok' });
      await expect(
        service.execute({
          type: 'patch',
          target: { type: 'task', ref: current.ref },
          patch: { priority: { type: 'set', value: 'B' } },
        }),
      ).resolves.toMatchObject({ type: 'not-found' });
      expect(edit).toHaveBeenCalledTimes(kind === 'delete' ? 2 : 1);
    },
  );

  it('removes the canonical rebased move source without touching its stale public ref', async () => {
    const stale = task(1, { id: 'stable' });
    const current = {
      ...stale,
      ref: { ...stale.ref, revision: 'current-before-move' },
    } satisfies TaskSnapshot;
    const moved = {
      ...current,
      ref: { filePath: 'Moved.md', line: 0, revision: 'moved' },
      source: { ...current.source, filePath: 'Moved.md', line: 0 },
    } satisfies TaskSnapshot;
    const deletedRefs: TaskSnapshot['ref'][][] = [];
    const policy: DependencyPolicyPort = {
      ...allowedPolicyMethods,
      evaluateCompletion: () => ({ type: 'allowed' }),
      subscribe: () => () => {},
      acceptCommittedDelta: ({ replaced }) =>
        deletedRefs.push(replaced.map(({ ref }) => ({ ...ref }))),
    };
    const queries = taskQueryApi({
      resolve: () => ({
        type: 'rebased',
        previous: stale,
        current,
        evidence: 'authority-transition',
        basis: { observed: stale },
      }),
    });
    const move = vi.fn<TaskRepository['move']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: moved },
      changed: true,
    });
    const service = new TaskApplicationService(
      queries,
      { edit: vi.fn(), completeRecurrence: vi.fn(), create: vi.fn(), move },
      statuses,
      { today: () => localDate('2026-08-28') },
      undefined,
      undefined,
      undefined,
      policy,
    );

    await expect(
      service.execute({
        type: 'move',
        ref: stale.ref,
        destination: { filePath: 'Moved.md', insertion: { type: 'append' } },
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(deletedRefs).toEqual([[current.ref]]);
  });

  it('removes the canonical rebased delete source without trusting a stale repository ref', async () => {
    const stale = task(1, { id: 'stable' });
    const current = {
      ...stale,
      ref: { ...stale.ref, revision: 'current-before-delete' },
    } satisfies TaskSnapshot;
    const deletedRefs: TaskSnapshot['ref'][][] = [];
    const policy: DependencyPolicyPort = {
      ...allowedPolicyMethods,
      evaluateCompletion: () => ({ type: 'allowed' }),
      subscribe: () => () => {},
      acceptCommittedDelta: ({ replaced }) =>
        deletedRefs.push(replaced.map(({ ref }) => ({ ...ref }))),
    };
    const queries = taskQueryApi({
      resolve: () => ({
        type: 'rebased',
        previous: stale,
        current,
        evidence: 'authority-transition',
        basis: { observed: stale },
      }),
    });
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'deleted', ref: stale.ref },
      changed: true,
    });
    const service = new TaskApplicationService(
      queries,
      { edit, completeRecurrence: vi.fn(), create: vi.fn(), move: vi.fn() },
      statuses,
      { today: () => localDate('2026-08-28') },
      undefined,
      undefined,
      undefined,
      policy,
    );

    await expect(service.execute({ type: 'delete', ref: stale.ref })).resolves.toMatchObject({
      type: 'ok',
    });
    expect(deletedRefs).toEqual([[current.ref]]);
  });

  it('fails closed without a write when dependency policy evaluation throws', async () => {
    const dependent = task(1, { dependsOn: ['prep'] });
    const edit = vi.fn<TaskRepository['edit']>();
    const policy: DependencyPolicyPort = {
      ...allowedPolicyMethods,
      evaluateCompletion: () => {
        throw new Error('projection unavailable');
      },
      subscribe: () => () => {},
      acceptCommittedDelta: () => {},
    };

    await expect(
      application([dependent], { edit }, policy).execute({
        type: 'set-status',
        target: { type: 'task', ref: dependent.ref },
        symbol: 'x',
      }),
    ).resolves.toEqual({
      type: 'blocked',
      operation: 'completion',
      dependency: { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] },
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([
    ['dependent edge', task(1, { dependsOn: ['prep'] })],
    ['ID-only duplicate participant', task(1, { id: 'possibly-duplicate' })],
  ] as const)(
    'fails closed for an %s when composition omits the policy',
    async (_name, subject) => {
      const edit = vi.fn<TaskRepository['edit']>();
      const service = new TaskApplicationService(
        exactQueries([subject]),
        { edit, completeRecurrence: vi.fn(), create: vi.fn(), move: vi.fn() },
        statuses,
        { today: () => localDate('2026-08-28') },
      );

      await expect(
        service.execute({
          type: 'set-status',
          target: { type: 'task', ref: subject.ref },
          symbol: 'x',
        }),
      ).resolves.toEqual({
        type: 'blocked',
        operation: 'completion',
        dependency: { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] },
      });
      expect(edit).not.toHaveBeenCalled();
    },
  );
});
