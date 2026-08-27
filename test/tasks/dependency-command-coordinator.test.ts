import { describe, expect, it, vi } from 'vitest';
import { DependencyIndex } from '../../src/projects/dependencies/DependencyIndex';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import {
  DependencyCommandCoordinator,
  type DependencyCommandIntent,
} from '../../src/tasks/application/DependencyCommandCoordinator';
import type { TaskQueryApi } from '../../src/tasks/application/TaskApplicationApi';
import type {
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { createAppWithFiles } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

function exactQueries(tasks: () => readonly TaskSnapshot[]): TaskQueryApi {
  return {
    list: (query) =>
      query?.filePath ? tasks().filter((task) => task.ref.filePath === query.filePath) : tasks(),
    forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
    resolve: (ref) => {
      const task = tasks().find(
        (candidate) =>
          candidate.ref.filePath === ref.filePath &&
          candidate.ref.line === ref.line &&
          candidate.ref.revision === ref.revision,
      );
      return task ? { type: 'exact', task, basis: { observed: task } } : { type: 'not-found', ref };
    },
    subscribe: () => () => undefined,
  };
}

async function inMemoryStack(files: Record<string, string>) {
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const editor = new TaskBlockEditor();
  const repository = new InMemoryTaskRepository({
    files,
    codec: new TaskMarkdownCodec(statusCatalog),
    editor,
    locator: new TaskLocator(),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
  });
  const tasks = Object.entries(files).flatMap(([path, content]) =>
    index.snapshotsFromContent(path, content),
  );
  const queries = exactQueries(() => tasks);
  const dependencies = new DependencyIndex();
  dependencies.replace(tasks);
  const coordinator = new DependencyCommandCoordinator(queries, repository, dependencies);
  return {
    coordinator,
    dependencies,
    repository,
    tasks: () => tasks,
  };
}

function intent(
  prerequisite: TaskRef,
  dependent: TaskRef,
  enabled = true,
): DependencyCommandIntent {
  return { prerequisite, dependent, dependencyId: 'prep-1', enabled };
}

describe('DependencyCommandCoordinator', () => {
  it('rejects two rebased refs that converge on the same canonical root', async () => {
    const current = (await inMemoryStack({ 'Tasks.md': '- [ ] one task\n' })).tasks()[0]!;
    const stalePrerequisite = { ...current.ref, line: 4, revision: 'stale-prerequisite' };
    const staleDependent = { ...current.ref, line: 8, revision: 'stale-dependent' };
    const repository: TaskRepository = {
      edit: vi.fn(),
      editTaskDependencies: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    };
    const queries: TaskQueryApi = {
      ...exactQueries(() => [current]),
      resolve: (ref) => ({
        type: 'rebased',
        previous: { ...current, ref },
        current,
        evidence: 'byte-identical-relocation',
        basis: { observed: { ...current, ref } },
      }),
    };
    const coordinator = new DependencyCommandCoordinator(queries, repository);

    await expect(
      coordinator.setDependency(intent(stalePrerequisite, staleDependent)),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'dependency' }],
    });
    expect(repository.editTaskDependencies).not.toHaveBeenCalled();
    expect(repository.edit).not.toHaveBeenCalled();
  });

  it('maps an unexpected resolution failure to a typed unchanged I/O result', async () => {
    const repository: TaskRepository = {
      edit: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    };
    const coordinator = new DependencyCommandCoordinator(
      {
        resolve: () => {
          throw new Error('index unavailable');
        },
      },
      repository,
    );
    const prerequisite = { filePath: 'Prep.md', line: 0, revision: 'prep' };
    const dependent = { filePath: 'Ship.md', line: 0, revision: 'ship' };

    await expect(coordinator.setDependency(intent(prerequisite, dependent))).resolves.toEqual({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unchanged',
    });
    expect(repository.edit).not.toHaveBeenCalled();
  });

  it('commits same-file ID assignment and edge as one root transaction', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] prerequisite\r\n- [ ] dependent 🧭 keep ^dependent\r\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');

    const result = await stack.coordinator.setDependency(intent(prerequisite.ref, dependent.ref));

    expect(result).toMatchObject({
      type: 'ok',
      changed: true,
      outcome: {
        type: 'task',
        task: { markdownTitle: 'dependent 🧭 keep', dependency: { dependsOn: ['prep-1'] } },
      },
    });
    expect(stack.repository.dependencyMultiRootCommits).toHaveLength(1);
    expect(stack.repository.content('Tasks.md')).toBe(
      '- [ ] prerequisite 🆔 prep-1\r\n- [ ] dependent 🧭 keep ⛔ prep-1 ^dependent\r\n',
    );
  });

  it('returns a committed same-file result and remembers every root when projection throws', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] prerequisite\n- [ ] dependent\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const projection = {
      acceptCommittedRoots: vi.fn((_roots: readonly TaskSnapshot[]) => {
        throw new Error('subscriber failed');
      }),
    };
    const remembered = vi.fn();
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => stack.tasks()),
      stack.repository,
      projection,
      remembered,
    );

    await expect(
      coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toMatchObject({ type: 'ok', changed: true });
    expect(projection.acceptCommittedRoots).toHaveBeenCalledOnce();
    expect(projection.acceptCommittedRoots.mock.calls[0]?.[0]).toHaveLength(2);
    expect(remembered).toHaveBeenCalledTimes(2);
  });

  it('finishes both cross-file writes before one coherent best-effort publication', async () => {
    const stack = await inMemoryStack({
      'Prep.md': '- [ ] prerequisite\n',
      'Ship.md': '- [ ] dependent\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const projection = {
      acceptCommittedRoots: vi.fn((_roots: readonly TaskSnapshot[]) => {
        throw new Error('subscriber failed');
      }),
    };
    const remembered = vi.fn();
    const edit = vi.spyOn(stack.repository, 'edit');
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => stack.tasks()),
      stack.repository,
      projection,
      remembered,
    );

    await expect(
      coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toMatchObject({ type: 'ok', changed: true });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(projection.acceptCommittedRoots).toHaveBeenCalledOnce();
    expect(projection.acceptCommittedRoots.mock.calls[0]?.[0]).toHaveLength(2);
    expect(projection.acceptCommittedRoots.mock.invocationCallOrder[0]).toBeGreaterThan(
      edit.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(remembered).toHaveBeenCalledTimes(2);
  });

  it('returns a dependency partial after an orphan ID commit and never rolls it back', async () => {
    const prerequisite = (await inMemoryStack({ 'Prep.md': '- [ ] prerequisite\n' })).tasks()[0]!;
    const dependent = (await inMemoryStack({ 'Ship.md': '- [ ] dependent\n' })).tasks()[0]!;
    const committedPrerequisite = {
      ...prerequisite,
      ref: { ...prerequisite.ref, revision: 'committed-prep' },
      dependency: { id: 'prep-1', dependsOn: [] },
      source: {
        ...prerequisite.source,
        originalMarkdown: '- [ ] prerequisite 🆔 prep-1',
        originalBlock: '- [ ] prerequisite 🆔 prep-1',
      },
    } satisfies TaskSnapshot;
    const externallyEditedDependent = {
      ...dependent,
      ref: { ...dependent.ref, revision: 'externally-edited-dependent' },
      title: 'dependent changed externally',
      markdownTitle: 'dependent changed externally',
    } satisfies TaskSnapshot;
    const calls: string[] = [];
    const repository: TaskRepository = {
      supportsRevisionPreconditions: true,
      edit: vi.fn(async (request: TaskEditRequest['command'] | TaskEditRequest) => {
        const command = 'command' in request ? request.command : request;
        calls.push(command.type);
        if (command.type === 'set-task-id') {
          return {
            type: 'committed',
            outcome: { type: 'task', task: committedPrerequisite },
            changed: true,
          } satisfies TaskRepositoryResult;
        }
        return {
          type: 'conflict',
          current: externallyEditedDependent,
        } satisfies TaskRepositoryResult;
      }),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
      editTaskDependencies: vi.fn(),
    };
    const projection = {
      acceptCommittedRoots: vi.fn((_roots: readonly TaskSnapshot[]) => {
        calls.push('publish');
        throw new Error('subscriber failed');
      }),
    };
    const remembered = vi.fn();
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => [prerequisite, dependent]),
      repository,
      projection,
      remembered,
    );

    await expect(
      coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toEqual({
      type: 'partial',
      operation: 'dependency',
      recovery: {
        state: 'prerequisite-id-committed-dependent-edge-remains',
        prerequisite: committedPrerequisite,
        dependent: externallyEditedDependent,
        dependencyId: 'prep-1',
        enabled: true,
        cause: 'conflict',
      },
    });
    expect(calls).toEqual(['set-task-id', 'set-task-dependency', 'publish']);
    expect(projection.acceptCommittedRoots).toHaveBeenCalledOnce();
    expect(projection.acceptCommittedRoots).toHaveBeenCalledWith([committedPrerequisite]);
    expect(remembered).toHaveBeenCalledOnce();
    expect(remembered).toHaveBeenCalledWith(committedPrerequisite);
  });

  it('returns the second write failure directly when no prerequisite ID was created', async () => {
    const stack = await inMemoryStack({
      'Prep.md': '- [ ] prerequisite 🆔 prep-1\n',
      'Ship.md': '- [ ] dependent\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const repository: TaskRepository = {
      supportsRevisionPreconditions: true,
      edit: vi.fn().mockResolvedValue({ type: 'conflict', current: dependent }),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
      editTaskDependencies: vi.fn(),
    };
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => [prerequisite, dependent]),
      repository,
    );

    await expect(
      coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toEqual({ type: 'conflict', current: dependent });
    expect(repository.edit).toHaveBeenCalledOnce();
  });

  it('uses an existing prerequisite ID without rewriting it or trusting a proposed replacement', async () => {
    const stack = await inMemoryStack({
      'Prep.md': '- [ ] prerequisite 🆔 canonical\n',
      'Ship.md': '- [ ] dependent\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const edit = vi.spyOn(stack.repository, 'edit');

    const result = await stack.coordinator.setDependency({
      prerequisite: prerequisite.ref,
      dependent: dependent.ref,
      dependencyId: 'proposed',
      enabled: true,
    });

    expect(result).toMatchObject({
      type: 'ok',
      outcome: { type: 'task', task: { dependency: { dependsOn: ['canonical'] } } },
    });
    expect(edit).toHaveBeenCalledOnce();
    const request = edit.mock.calls[0]?.[0];
    const command = request && 'command' in request ? request.command : request;
    expect(command).toMatchObject({
      type: 'set-task-dependency',
      dependencyId: 'canonical',
    });
    expect(stack.repository.content('Prep.md')).toBe('- [ ] prerequisite 🆔 canonical\n');
  });

  it('removes an edge without assigning an ID to an un-identified prerequisite', async () => {
    const stack = await inMemoryStack({
      'Prep.md': '- [ ] prerequisite\n',
      'Ship.md': '- [ ] dependent ⛔ prep-1\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const edit = vi.spyOn(stack.repository, 'edit');

    await expect(
      stack.coordinator.setDependency(intent(prerequisite.ref, dependent.ref, false)),
    ).resolves.toMatchObject({ type: 'ok', changed: true });
    expect(edit).toHaveBeenCalledOnce();
    expect(stack.repository.content('Prep.md')).toBe('- [ ] prerequisite\n');
    expect(stack.repository.content('Ship.md')).toBe('- [ ] dependent\n');
  });

  it('returns an unknown-edge partial when the second repository write throws', async () => {
    const prerequisite = (await inMemoryStack({ 'Prep.md': '- [ ] prerequisite\n' })).tasks()[0]!;
    const dependent = (await inMemoryStack({ 'Ship.md': '- [ ] dependent\n' })).tasks()[0]!;
    const committedPrerequisite = {
      ...prerequisite,
      dependency: { id: 'prep-1', dependsOn: [] },
    } satisfies TaskSnapshot;
    let calls = 0;
    const repository: TaskRepository = {
      supportsRevisionPreconditions: true,
      edit: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            type: 'committed',
            outcome: { type: 'task', task: committedPrerequisite },
            changed: true,
          } satisfies TaskRepositoryResult;
        }
        throw new Error('write interrupted');
      }),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    };
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => [prerequisite, dependent]),
      repository,
    );

    await expect(
      coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toMatchObject({
      type: 'partial',
      operation: 'dependency',
      recovery: {
        state: 'prerequisite-id-committed-dependent-edge-unknown',
        prerequisite: committedPrerequisite,
        dependent,
        cause: 'io-error',
      },
    });
  });

  it('updates DependencyIndex synchronously and suppresses duplicate eventual publication', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] prerequisite\n- [ ] dependent\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const published: TaskRef[][] = [];
    stack.dependencies.subscribe((refs) => published.push([...refs]));

    const result = await stack.coordinator.setDependency(intent(prerequisite.ref, dependent.ref));
    if (result.type !== 'ok' || result.outcome.type !== 'task') throw new Error('not committed');
    expect(stack.dependencies.get(result.outcome.task.ref)).toMatchObject({
      type: 'blocked',
      prerequisites: [expect.objectContaining({ filePath: 'Tasks.md', line: 0 })],
    });
    expect(published).toHaveLength(1);
    const committedRoots = stack.repository.lastDependencyRoots;
    expect(committedRoots).toHaveLength(2);
    stack.dependencies.replace(committedRoots);
    expect(published).toHaveLength(1);
  });

  it('fails closed on a same-file revision conflict without falling back to two writes', async () => {
    const stack = await inMemoryStack({ 'Tasks.md': '- [ ] prerequisite\n- [ ] dependent\n' });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const edit = vi.spyOn(stack.repository, 'edit');
    const multi = vi
      .spyOn(stack.repository, 'editTaskDependencies')
      .mockResolvedValue({ type: 'conflict', current: dependent });

    await expect(
      stack.coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
    ).resolves.toEqual({ type: 'conflict', current: dependent });
    expect(multi).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    expect(stack.repository.content('Tasks.md')).toBe('- [ ] prerequisite\n- [ ] dependent\n');
  });
});
