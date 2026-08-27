import { describe, expect, it, vi } from 'vitest';
import { DependencyIndex } from '../../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../../src/projects/dependencies/DependencyPolicy';
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

const allowingValidation = { validateLink: () => ({ type: 'allowed' as const }) };

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
  const coordinator = new DependencyCommandCoordinator(
    queries,
    repository,
    dependencies,
    undefined,
    new DependencyPolicy(dependencies),
  );
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
      allowingValidation,
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
      allowingValidation,
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
      allowingValidation,
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
      undefined,
      undefined,
      allowingValidation,
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
      undefined,
      undefined,
      allowingValidation,
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

  it('rejects a proposed edge that would create a cycle before any repository write', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const repositoryEdit = vi.spyOn(stack.repository, 'edit');
    const dependencyEdit = vi.spyOn(stack.repository, 'editTaskDependencies');
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => stack.tasks()),
      stack.repository,
      stack.dependencies,
      undefined,
      new DependencyPolicy(stack.dependencies),
    );

    await expect(
      coordinator.setDependency({
        prerequisite: prerequisite.ref,
        dependent: dependent.ref,
        dependencyId: 'a',
        enabled: true,
      }),
    ).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [expect.objectContaining({ type: 'cycle' })] },
    });
    expect(repositoryEdit).not.toHaveBeenCalled();
    expect(dependencyEdit).not.toHaveBeenCalled();
  });

  it('rejects a proposed prerequisite ID collision before assigning the ID or edge', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] Existing 🆔 taken\n- [ ] Prerequisite\n- [ ] Dependent\n',
    });
    const [, prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const repositoryEdit = vi.spyOn(stack.repository, 'edit');
    const dependencyEdit = vi.spyOn(stack.repository, 'editTaskDependencies');
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => stack.tasks()),
      stack.repository,
      stack.dependencies,
      undefined,
      new DependencyPolicy(stack.dependencies),
    );

    await expect(
      coordinator.setDependency({
        prerequisite: prerequisite.ref,
        dependent: dependent.ref,
        dependencyId: 'taken',
        enabled: true,
      }),
    ).resolves.toMatchObject({
      type: 'invalid',
      dependency: {
        diagnostics: [expect.objectContaining({ type: 'duplicate-id', id: 'taken' })],
      },
    });
    expect(repositoryEdit).not.toHaveBeenCalled();
    expect(dependencyEdit).not.toHaveBeenCalled();
  });

  it('clears an unresolved carrier without resolving a prerequisite snapshot', async () => {
    const stack = await inMemoryStack({
      'Ship.md': '- [ ] Ship ⛔ missing\n',
    });
    const dependent = stack.tasks()[0]!;
    const resolve = vi.fn(exactQueries(() => stack.tasks()).resolve);
    const coordinator = new DependencyCommandCoordinator(
      { ...exactQueries(() => stack.tasks()), resolve },
      stack.repository,
      stack.dependencies,
    );

    await expect(
      coordinator.clearDependency({ dependent: dependent.ref, dependencyId: 'missing' }),
    ).resolves.toMatchObject({ type: 'ok', changed: true });

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(dependent.ref);
    expect(stack.repository.content('Ship.md')).toBe('- [ ] Ship\n');
  });

  it.each([
    ['duplicate', '- [ ] A 🆔 same\n- [ ] B 🆔 same\n- [ ] Ship ⛔ same\n', 'same'],
    ['cycle edge', '- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b ⛔ a\n', 'b'],
  ] as const)(
    'clears one %s carrier edge while the graph is invalid',
    async (_label, source, id) => {
      const stack = await inMemoryStack({ 'Tasks.md': source });
      const dependent = stack.tasks().find(({ dependency }) => dependency?.dependsOn.includes(id));
      if (!dependent) throw new Error('missing dependent');

      await expect(
        stack.coordinator.clearDependency({ dependent: dependent.ref, dependencyId: id }),
      ).resolves.toMatchObject({ type: 'ok', changed: true });

      expect(stack.repository.content('Tasks.md')).not.toContain(`⛔ ${id}`);
    },
  );

  it('removes only the requested ID and preserves unrelated task bytes', async () => {
    const stack = await inMemoryStack({
      'Ship.md': '- [ ] Ship 🧭 keep ⛔ first, second, third ^ship\r\n',
    });
    const dependent = stack.tasks()[0]!;

    await expect(
      stack.coordinator.clearDependency({ dependent: dependent.ref, dependencyId: 'second' }),
    ).resolves.toMatchObject({ type: 'ok', changed: true });

    expect(stack.repository.content('Ship.md')).toBe(
      '- [ ] Ship 🧭 keep ⛔ first, third ^ship\r\n',
    );
  });

  it('performs zero writes when the dependent resolution is ambiguous', async () => {
    const candidate = (await inMemoryStack({ 'Ship.md': '- [ ] Ship ⛔ prep\n' })).tasks()[0]!;
    const repository: TaskRepository = {
      edit: vi.fn(),
      editTaskDependencies: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    };
    const coordinator = new DependencyCommandCoordinator(
      {
        resolve: () => ({
          type: 'ambiguous',
          ref: candidate.ref,
          candidates: [
            { root: candidate, target: { type: 'task', ref: candidate.ref }, node: candidate },
          ],
        }),
      },
      repository,
    );

    await expect(
      coordinator.clearDependency({ dependent: candidate.ref, dependencyId: 'prep' }),
    ).resolves.toMatchObject({ type: 'ambiguous' });
    expect(repository.edit).not.toHaveBeenCalled();
    expect(repository.editTaskDependencies).not.toHaveBeenCalled();
  });

  it('returns a typed unknown I/O result when clear-by-ID repository write throws', async () => {
    const dependent = (await inMemoryStack({ 'Ship.md': '- [ ] Ship ⛔ prep\n' })).tasks()[0]!;
    const repository: TaskRepository = {
      edit: vi.fn().mockRejectedValue(new Error('write failed')),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
    };
    const coordinator = new DependencyCommandCoordinator(
      exactQueries(() => [dependent]),
      repository,
    );

    await expect(
      coordinator.clearDependency({ dependent: dependent.ref, dependencyId: 'prep' }),
    ).resolves.toMatchObject({ type: 'io-error', contentState: 'unknown' });
  });

  it('serializes reciprocal concurrent links so only the first validated edge writes', async () => {
    const stack = await inMemoryStack({
      'A.md': '- [ ] A 🆔 a\n',
      'B.md': '- [ ] B 🆔 b\n',
    });
    const [a, b] = stack.tasks();
    if (!a || !b) throw new Error('missing roots');
    const original = stack.repository.edit.bind(stack.repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const writes = vi.spyOn(stack.repository, 'edit').mockImplementationOnce(async (request) => {
      await gate;
      return original(request);
    });

    const first = stack.coordinator.setDependency({
      prerequisite: a.ref,
      dependent: b.ref,
      dependencyId: 'a',
      enabled: true,
    });
    const second = stack.coordinator.setDependency({
      prerequisite: b.ref,
      dependent: a.ref,
      dependencyId: 'b',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveBeenCalledOnce();
    release();

    await expect(first).resolves.toMatchObject({ type: 'ok' });
    await expect(second).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [expect.objectContaining({ type: 'cycle' })] },
    });
    expect(writes).toHaveBeenCalledOnce();
  });

  it('fails closed a queued enable after an earlier dependency outcome becomes unknown', async () => {
    const stack = await inMemoryStack({
      'A.md': '- [ ] A 🆔 a\n',
      'B.md': '- [ ] B 🆔 b\n',
    });
    const [a, b] = stack.tasks();
    if (!a || !b) throw new Error('missing roots');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const edit = vi.spyOn(stack.repository, 'edit').mockImplementationOnce(async () => {
      await gate;
      return {
        type: 'io-error',
        cause: 'write-interrupted',
        path: 'B.md',
        contentState: 'unknown',
      };
    });
    const first = stack.coordinator.setDependency({
      prerequisite: a.ref,
      dependent: b.ref,
      dependencyId: 'a',
      enabled: true,
    });
    const reciprocal = stack.coordinator.setDependency({
      prerequisite: b.ref,
      dependent: a.ref,
      dependencyId: 'b',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(edit).toHaveBeenCalledOnce();
    release();

    await expect(first).resolves.toMatchObject({ type: 'io-error', contentState: 'unknown' });
    await expect(reciprocal).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [{ type: 'unresolved-projection' }] },
    });
    expect(edit).toHaveBeenCalledOnce();
  });

  it('allows a later explicit enable after the unknown predecessor queue has drained', async () => {
    const stack = await inMemoryStack({
      'A.md': '- [ ] A 🆔 a\n',
      'B.md': '- [ ] B 🆔 b\n',
    });
    const [a, b] = stack.tasks();
    if (!a || !b) throw new Error('missing roots');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const edit = vi.spyOn(stack.repository, 'edit').mockImplementationOnce(async () => {
      await gate;
      return {
        type: 'io-error',
        cause: 'write-interrupted',
        path: 'B.md',
        contentState: 'unknown',
      };
    });
    const unknown = stack.coordinator.setDependency({
      prerequisite: a.ref,
      dependent: b.ref,
      dependencyId: 'a',
      enabled: true,
    });
    const alreadyQueued = stack.coordinator.setDependency({
      prerequisite: b.ref,
      dependent: a.ref,
      dependencyId: 'b',
      enabled: true,
    });
    release();

    await expect(unknown).resolves.toMatchObject({ type: 'io-error', contentState: 'unknown' });
    await expect(alreadyQueued).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [{ type: 'unresolved-projection' }] },
    });
    await expect(
      stack.coordinator.setDependency({
        prerequisite: b.ref,
        dependent: a.ref,
        dependencyId: 'b',
        enabled: true,
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent proposed IDs so one owner wins and the loser performs zero write', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] First\n- [ ] First dependent\n- [ ] Second\n- [ ] Second dependent\n',
    });
    const [firstPrerequisite, firstDependent, secondPrerequisite, secondDependent] = stack.tasks();
    if (!firstPrerequisite || !firstDependent || !secondPrerequisite || !secondDependent) {
      throw new Error('missing roots');
    }
    const original = stack.repository.editTaskDependencies!.bind(stack.repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const writes = vi
      .spyOn(stack.repository, 'editTaskDependencies')
      .mockImplementationOnce(async (request) => {
        await gate;
        return original(request);
      });
    const first = stack.coordinator.setDependency({
      prerequisite: firstPrerequisite.ref,
      dependent: firstDependent.ref,
      dependencyId: 'shared',
      enabled: true,
    });
    const second = stack.coordinator.setDependency({
      prerequisite: secondPrerequisite.ref,
      dependent: secondDependent.ref,
      dependencyId: 'shared',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveBeenCalledOnce();
    release();

    await expect(first).resolves.toMatchObject({ type: 'ok' });
    await expect(second).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [expect.objectContaining({ type: 'duplicate-id' })] },
    });
    expect(writes).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'throws'] as const)(
    'fails closed with zero writes when prospective validation %s',
    async (mode) => {
      const stack = await inMemoryStack({ 'Tasks.md': '- [ ] P\n- [ ] D\n' });
      const [prerequisite, dependent] = stack.tasks();
      if (!prerequisite || !dependent) throw new Error('missing roots');
      const edit = vi.spyOn(stack.repository, 'edit');
      const multi = vi.spyOn(stack.repository, 'editTaskDependencies');
      const coordinator = new DependencyCommandCoordinator(
        exactQueries(() => stack.tasks()),
        stack.repository,
        stack.dependencies,
        undefined,
        mode === 'throws'
          ? {
              validateLink: () => {
                throw new Error('projection unavailable');
              },
            }
          : undefined,
      );

      await expect(
        coordinator.setDependency(intent(prerequisite.ref, dependent.ref)),
      ).resolves.toMatchObject({
        type: 'invalid',
        dependency: {
          diagnostics: [{ type: 'unresolved-projection' }],
        },
      });
      expect(edit).not.toHaveBeenCalled();
      expect(multi).not.toHaveBeenCalled();
    },
  );

  it('rejects assigning an ID when it activates a latent cycle in existing missing-ID consumers', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] P ⛔ q\n- [ ] Q 🆔 q ⛔ p\n- [ ] D\n',
    });
    const [prerequisite, , dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const edit = vi.spyOn(stack.repository, 'edit');
    const multi = vi.spyOn(stack.repository, 'editTaskDependencies');

    await expect(
      stack.coordinator.setDependency({
        prerequisite: prerequisite.ref,
        dependent: dependent.ref,
        dependencyId: 'p',
        enabled: true,
      }),
    ).resolves.toMatchObject({
      type: 'invalid',
      dependency: { diagnostics: [expect.objectContaining({ type: 'cycle' })] },
    });
    expect(edit).not.toHaveBeenCalled();
    expect(multi).not.toHaveBeenCalled();
  });

  it('allows assigning the exact missing ID when that operation safely repairs the dependent', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] Prerequisite\n- [ ] Dependent ⛔ wanted\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');

    await expect(
      stack.coordinator.setDependency({
        prerequisite: prerequisite.ref,
        dependent: dependent.ref,
        dependencyId: 'wanted',
        enabled: true,
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(stack.repository.content('Tasks.md')).toBe(
      '- [ ] Prerequisite 🆔 wanted\n- [ ] Dependent ⛔ wanted\n',
    );
  });

  it('does not treat an unrelated missing relation as repaired by a new link', async () => {
    const stack = await inMemoryStack({
      'Tasks.md': '- [ ] Prerequisite\n- [ ] Dependent ⛔ other\n',
    });
    const [prerequisite, dependent] = stack.tasks();
    if (!prerequisite || !dependent) throw new Error('missing roots');
    const edit = vi.spyOn(stack.repository, 'edit');
    const multi = vi.spyOn(stack.repository, 'editTaskDependencies');

    await expect(
      stack.coordinator.setDependency({
        prerequisite: prerequisite.ref,
        dependent: dependent.ref,
        dependencyId: 'wanted',
        enabled: true,
      }),
    ).resolves.toMatchObject({
      type: 'invalid',
      dependency: {
        diagnostics: [expect.objectContaining({ type: 'missing-prerequisite', id: 'other' })],
      },
    });
    expect(edit).not.toHaveBeenCalled();
    expect(multi).not.toHaveBeenCalled();
  });
});
