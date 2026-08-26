import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStoreEvent } from '../src/projects/ProjectStore';
import { ProjectWorkspaceCoordinator } from '../src/projects/ProjectWorkspaceCoordinator';
import { ProjectWorkspaceReadModel } from '../src/projects/ProjectWorkspaceReadModel';
import type { Project } from '../src/projects/types';
import { buildWorkNoteRelationProjections } from '../src/projects/work-notes/WorkNoteRelationProjection';
import type { WorkNoteIndexEvent, WorkNoteSnapshot } from '../src/projects/work-notes/types';
import type { ProjectStatus } from '../src/settings/types';
import type { TaskIndexEvent, TaskSnapshot } from '../src/tasks';
import { task } from './helpers';

const projectPath = 'Projects/A.md';
const statuses: readonly ProjectStatus[] = [
  {
    id: 'active',
    label: 'Active',
    onLeftPanel: true,
    behavior: 'regular',
    match: { kind: 'property', property: 'Status', value: 'Active' },
  },
  {
    id: 'done',
    label: 'Done',
    onLeftPanel: false,
    behavior: 'completed',
    match: { kind: 'property', property: 'Status', value: 'Done' },
  },
  {
    id: 'published',
    label: 'Published',
    onLeftPanel: false,
    behavior: 'published',
    match: { kind: 'property', property: 'Status', value: 'Published' },
  },
  {
    id: 'dropped',
    label: 'Dropped',
    onLeftPanel: false,
    behavior: 'dropped',
    match: { kind: 'property', property: 'Status', value: 'Dropped' },
  },
];

function project(path = projectPath): Project {
  return {
    path,
    name: path.split('/').pop()!.replace('.md', ''),
    frontmatter: {},
    tags: [],
    statusId: 'active',
    rawStatus: null,
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  };
}

function workNote(
  path: string,
  statusId: string | null = 'active',
  overrides: Partial<WorkNoteSnapshot> = {},
): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    kind: 'ordinary',
    projectPath,
    statusId,
    rawStatus: null,
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...overrides,
  };
}

function action(path: string, line: number, status: TaskSnapshot['status']): TaskSnapshot {
  return task({
    status,
    ref: { filePath: path, line, revision: `${path}:${String(line)}:${status}` },
    source: { filePath: path, line },
    planning: {},
  });
}

function modelFixture(
  tasks: readonly TaskSnapshot[],
  workNotes: readonly WorkNoteSnapshot[],
  now = Date.parse('2026-08-26T12:00:00.000Z'),
): ProjectWorkspaceReadModel {
  const model = new ProjectWorkspaceReadModel({
    projects: { list: () => [project()] },
    tasks: { list: () => tasks },
    workNotes: { list: () => workNotes, diagnosticsFor: () => [] },
    statuses: () => statuses,
    now: () => now,
    today: () => '2026-08-26',
  });
  model.rebuild();
  return model;
}

afterEach(() => vi.useRealTimers());

describe('ProjectWorkspaceReadModel', () => {
  it('inherits Tasks from an eligible Work Note exactly once', () => {
    const direct = action(projectPath, 1, 'open');
    const inherited = action('Work/A.md', 1, 'open');
    const readModel = modelFixture([direct, inherited, inherited], [workNote('Work/A.md')]);

    expect(readModel.get(projectPath)?.tasks.map(({ task: snapshot }) => snapshot.ref)).toEqual([
      direct.ref,
      inherited.ref,
    ]);
  });

  it('counts a Task even when its Work Note is dropped', () => {
    const readModel = modelFixture(
      [action('Work/Dropped.md', 1, 'open')],
      [workNote('Work/Dropped.md', 'dropped')],
    );
    expect(readModel.get(projectPath)?.taskRollup.open).toBe(1);
  });

  it('keeps Task progress and Work Note lifecycle separate', () => {
    const readModel = modelFixture(
      [action(projectPath, 1, 'open'), action('Work/Done.md', 1, 'done')],
      [
        workNote('Work/Active.md'),
        workNote('Work/Done.md', 'done'),
        workNote('Work/Dropped.md', 'dropped'),
      ],
    );
    const snapshot = readModel.get(projectPath)!;
    expect(snapshot.taskRollup.progress).toBe(0.5);
    expect(snapshot.workNoteRollup).toEqual({ active: 1, completed: 1, dropped: 1 });
  });

  it('rolls up same-Project milestone members independently of internal Tasks', () => {
    const milestonePath = 'Work/M.md';
    const multiTask = action('Work/Active.md', 2, 'open');
    const readModel = modelFixture(
      [multiTask, multiTask],
      [
        workNote(milestonePath, 'active', { kind: 'milestone' }),
        workNote('Work/Active.md', 'active', { milestonePath }),
        workNote('Work/Done.md', 'done', { milestonePath }),
        workNote('Work/Dropped.md', 'dropped', { milestonePath }),
      ],
    );
    const snapshot = readModel.get(projectPath)!;
    expect(snapshot.milestoneRollups.get(milestonePath)).toEqual({
      active: 1,
      completed: 1,
      dropped: 1,
      progress: 0.5,
    });
    expect(
      snapshot.tasks.filter(({ task: candidate }) => candidate.ref === multiTask.ref),
    ).toHaveLength(1);
  });

  it('uses task date rules and lifecycle-aware Work Note end boundaries for overdue counts', () => {
    const readModel = modelFixture(
      [
        action(projectPath, 1, 'open'),
        { ...action(projectPath, 2, 'open'), planning: { due: '2026-08-25' as never } },
        { ...action(projectPath, 3, 'done'), planning: { due: '2026-08-25' as never } },
      ],
      [
        workNote('Work/Past.md', 'active', {
          range: {
            end: {
              raw: '2026-08-25',
              precision: 'date',
              instantMs: Date.parse('2026-08-25T00:00:00Z'),
            },
          },
        }),
        workNote('Work/Today.md', 'active', {
          range: {
            end: {
              raw: '2026-08-26',
              precision: 'date',
              instantMs: Date.parse('2026-08-26T00:00:00Z'),
            },
          },
        }),
        workNote('Work/Dropped.md', 'dropped', {
          range: {
            end: {
              raw: '2026-08-25',
              precision: 'date',
              instantMs: Date.parse('2026-08-25T00:00:00Z'),
            },
          },
        }),
      ],
    );
    expect(readModel.get(projectPath)?.overdue).toEqual({ tasks: 1, workNotes: 1 });
  });

  it('reports an existing relation target in another Project as cross-project', () => {
    const readModel = modelFixture(
      [],
      [
        workNote('Work/A.md', 'active', { blockedByPaths: ['Work/B.md'] }),
        workNote('Work/B.md', 'active', { projectPath: 'Projects/B.md' }),
      ],
    );

    expect(readModel.get(projectPath)?.workNoteRelations).toContainEqual(
      expect.objectContaining({
        type: 'invalid',
        reason: 'cross-project',
        sourcePath: 'Work/A.md',
        targetPath: 'Work/B.md',
      }),
    );
  });
});

describe('Work Note relation projection', () => {
  it('does not traverse cross-Project blocked-by edges when detecting cycles', () => {
    const relations = buildWorkNoteRelationProjections(
      [
        workNote('Work/A.md', 'active', { blockedByPaths: ['Work/B.md'] }),
        workNote('Work/B.md', 'active', { blockedByPaths: ['Work/C.md'] }),
        workNote('Work/C.md', 'active', {
          projectPath: 'Projects/B.md',
          blockedByPaths: ['Work/A.md'],
        }),
      ],
      statuses,
      new Set(['Work/A.md', 'Work/B.md']),
    );

    expect(relations).toContainEqual(
      expect.objectContaining({
        type: 'blocked',
        sourcePath: 'Work/A.md',
        targetPath: 'Work/B.md',
      }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        type: 'invalid',
        reason: 'cross-project',
        sourcePath: 'Work/B.md',
        targetPath: 'Work/C.md',
      }),
    );
  });

  it.each([
    ['missing', workNote('Work/A.md', 'active', { blockedByPaths: ['Work/Missing.md'] })],
    [
      'ambiguous',
      workNote('Work/A.md', 'active', {
        diagnostics: [{ type: 'ambiguous-relation', field: 'blockedBy' }],
      }),
    ],
    [
      'multiple',
      workNote('Work/A.md', 'active', {
        diagnostics: [{ type: 'multiple-milestones', field: 'milestone' }],
      }),
    ],
    ['self', workNote('Work/A.md', 'active', { blockedByPaths: ['Work/A.md'] })],
    ['cross-project', workNote('Work/A.md', 'active', { blockedByPaths: ['Work/B.md'] })],
    ['cycle', workNote('Work/A.md', 'active', { blockedByPaths: ['Work/C.md'] })],
  ] as const)('keeps invalid Work Note relation %s diagnostic-only', (reason, subject) => {
    const others = [
      workNote('Work/B.md', 'active', { projectPath: 'Projects/B.md' }),
      workNote('Work/C.md', 'active', { blockedByPaths: ['Work/A.md'] }),
    ];
    const relations = buildWorkNoteRelationProjections([subject, ...others], statuses);
    expect(relations).toContainEqual(expect.objectContaining({ type: 'invalid', reason }));
  });

  it('marks regular and dropped prerequisites blocked while completed and published satisfy', () => {
    const subject = workNote('Work/Subject.md', 'active', {
      blockedByPaths: ['Work/Active.md', 'Work/Done.md', 'Work/Published.md', 'Work/Dropped.md'],
    });
    const relations = buildWorkNoteRelationProjections(
      [
        subject,
        workNote('Work/Active.md', 'active'),
        workNote('Work/Done.md', 'done'),
        workNote('Work/Published.md', 'published'),
        workNote('Work/Dropped.md', 'dropped'),
      ],
      statuses,
    );
    expect(
      relations.filter(({ type }) => type === 'blocked').map(({ targetPath }) => targetPath),
    ).toEqual(['Work/Active.md', 'Work/Dropped.md']);
    expect(
      relations.filter(({ type }) => type === 'satisfied').map(({ targetPath }) => targetPath),
    ).toEqual(['Work/Done.md', 'Work/Published.md']);
  });
});

describe('ProjectWorkspaceCoordinator convergence', () => {
  it('waits for the exact Task barrier when Work Note projection settles first', async () => {
    const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
    const workListeners: Array<(event: WorkNoteIndexEvent) => void> = [];
    const workSettled: Array<
      (event: { reason: 'index'; files: readonly { path: string; generation: number }[] }) => void
    > = [];
    let tasks: readonly TaskSnapshot[] = [action('Work/A.md', 1, 'open')];
    const coordinator = new ProjectWorkspaceCoordinator(
      { list: () => [project()], onUpdate: () => () => {} },
      {
        list: () => tasks,
        subscribe: () => () => {},
        subscribeSettled: (listener) => {
          taskSettled.push(listener);
          return () => {};
        },
      },
      {
        list: () => [workNote('Work/A.md')],
        diagnosticsFor: () => [],
        onUpdate: (listener) => {
          workListeners.push(listener);
          return () => {};
        },
        onSettled: (listener) => {
          workSettled.push(listener as never);
          return () => {};
        },
      },
      () => statuses,
    );
    coordinator.start();
    const publications: number[] = [];
    coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));
    tasks = [action('Work/A.md', 1, 'done')];

    workListeners.forEach((listener) =>
      listener({
        cause: 'index',
        changedPaths: ['Work/A.md'],
        invalidatedProjectPaths: [projectPath],
        taskBarriers: [{ path: 'Work/A.md', generation: 2 }],
      } as WorkNoteIndexEvent),
    );
    workSettled.forEach((listener) =>
      listener({ reason: 'index', files: [{ path: 'Work/A.md', generation: 2 }] }),
    );
    await Promise.resolve();
    expect(publications).toEqual([]);

    taskSettled.forEach((listener) =>
      listener({
        type: 'settled',
        reason: 'index',
        files: [{ path: 'Work/A.md', generation: 2 }],
      }),
    );
    await Promise.resolve();
    expect(publications).toEqual([1]);
    coordinator.destroy();
  });

  it('uses an already-observed exact Task barrier when the Work Note event arrives later', async () => {
    const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
    const workListeners: Array<(event: WorkNoteIndexEvent) => void> = [];
    const workSettled: Array<
      (event: { reason: 'index'; files: readonly { path: string; generation: number }[] }) => void
    > = [];
    let tasks: readonly TaskSnapshot[] = [action('Work/A.md', 1, 'open')];
    const coordinator = new ProjectWorkspaceCoordinator(
      { list: () => [project()], onUpdate: () => () => {} },
      {
        list: () => tasks,
        subscribe: () => () => {},
        subscribeSettled: (listener) => {
          taskSettled.push(listener);
          return () => {};
        },
      },
      {
        list: () => [workNote('Work/A.md')],
        diagnosticsFor: () => [],
        onUpdate: (listener) => {
          workListeners.push(listener);
          return () => {};
        },
        onSettled: (listener) => {
          workSettled.push(listener as never);
          return () => {};
        },
      },
      () => statuses,
    );
    coordinator.start();
    const publications: number[] = [];
    coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));
    tasks = [action('Work/A.md', 1, 'done')];

    taskSettled.forEach((listener) =>
      listener({
        type: 'settled',
        reason: 'index',
        files: [{ path: 'Work/A.md', generation: 9 }],
      }),
    );
    workListeners.forEach((listener) =>
      listener({
        cause: 'index',
        changedPaths: ['Work/A.md'],
        invalidatedProjectPaths: [projectPath],
        taskBarriers: [{ path: 'Work/A.md', generation: 9 }],
      } as WorkNoteIndexEvent),
    );
    workSettled.forEach((listener) =>
      listener({ reason: 'index', files: [{ path: 'Work/A.md', generation: 2 }] }),
    );
    await Promise.resolve();
    expect(publications).toEqual([1]);
    coordinator.destroy();
  });

  it('publishes one stable initial snapshot only after all sources initialize', async () => {
    const projectSettled: Array<(event: never) => void> = [];
    const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
    const workSettled: Array<(event: never) => void> = [];
    let tasks: readonly TaskSnapshot[] = [action(projectPath, 1, 'open')];
    let notes: readonly WorkNoteSnapshot[] = [];
    const projectSource = {
      isReady: () => false,
      list: () => [project()],
      onUpdate: () => () => {},
      onSettled: (listener: (event: never) => void) => {
        projectSettled.push(listener);
        return () => {};
      },
    };
    const taskSource = {
      isReady: () => false,
      list: () => tasks,
      subscribe: () => () => {},
      subscribeSettled: (
        listener: (event: Extract<TaskIndexEvent, { type: 'settled' }>) => void,
      ) => {
        taskSettled.push(listener);
        return () => {};
      },
    };
    const workSource = {
      isReady: () => false,
      list: () => notes,
      diagnosticsFor: () => [],
      onUpdate: () => () => {},
      onSettled: (listener: (event: never) => void) => {
        workSettled.push(listener);
        return () => {};
      },
    };
    const coordinator = new ProjectWorkspaceCoordinator(
      projectSource,
      taskSource,
      workSource,
      () => statuses,
    );
    coordinator.start();
    const publications: number[] = [];
    coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));
    expect(coordinator.list()).toEqual([]);

    tasks = [action(projectPath, 1, 'done')];
    notes = [workNote('Work/A.md')];
    workSettled.forEach((listener) =>
      listener({
        reason: 'initialization',
        files: [{ path: 'Work/A.md', generation: 1 }],
      } as never),
    );
    taskSettled.forEach((listener) =>
      listener({
        type: 'settled',
        reason: 'initialization',
        files: [{ path: projectPath, generation: 1 }],
      }),
    );
    await Promise.resolve();
    expect(publications).toEqual([]);
    expect(coordinator.list()).toEqual([]);

    projectSettled.forEach((listener) =>
      listener({
        reason: 'initialization',
        files: [{ path: projectPath, generation: 1 }],
      } as never),
    );
    await Promise.resolve();
    expect(publications).toEqual([1]);
    expect(coordinator.get(projectPath)?.workNotes.map(({ path }) => path)).toEqual(['Work/A.md']);
    coordinator.destroy();
  });

  it('does not publish an own Task commit before its Work Note source settles', async () => {
    const taskListeners: Array<(event: TaskIndexEvent) => void> = [];
    const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
    const workSettled: Array<
      (event: { reason: 'index'; files: readonly { path: string; generation: number }[] }) => void
    > = [];
    let tasks: readonly TaskSnapshot[] = [action('Work/A.md', 1, 'open')];
    const coordinator = new ProjectWorkspaceCoordinator(
      { list: () => [project()], onUpdate: () => () => {} },
      {
        list: () => tasks,
        subscribe: (listener) => {
          taskListeners.push(listener);
          return () => {};
        },
        subscribeSettled: (listener) => {
          taskSettled.push(listener);
          return () => {};
        },
      },
      {
        list: () => [workNote('Work/A.md')],
        diagnosticsFor: () => [],
        onUpdate: () => () => {},
        onSettled: (listener) => {
          workSettled.push(listener as never);
          return () => {};
        },
      },
      () => statuses,
    );
    coordinator.start();
    const publications: number[] = [];
    coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));
    tasks = [action('Work/A.md', 1, 'done')];
    taskListeners.forEach((listener) => listener({ type: 'changed', files: ['Work/A.md'] }));
    coordinator.absorbOwnCommit(['Work/A.md']);
    taskSettled.forEach((listener) =>
      listener({
        type: 'settled',
        reason: 'index',
        files: [{ path: 'Work/A.md', generation: 2 }],
      }),
    );
    await Promise.resolve();
    expect(publications).toEqual([]);

    workSettled.forEach((listener) =>
      listener({ reason: 'index', files: [{ path: 'Work/A.md', generation: 2 }] }),
    );
    await Promise.resolve();
    expect(publications).toEqual([1]);
    coordinator.destroy();
  });

  it.each(['metadata-first', 'task-index-first'] as const)(
    'settles %s event order once',
    async (order) => {
      vi.useFakeTimers();
      const projectListeners: Array<(event: ProjectStoreEvent) => void> = [];
      const taskListeners: Array<(event: TaskIndexEvent) => void> = [];
      const projectSettled: Array<
        (event: {
          reason: 'task-barrier';
          files: readonly { path: string; generation: number }[];
        }) => void
      > = [];
      const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
      let tasks: readonly TaskSnapshot[] = [action(projectPath, 1, 'open')];
      const coordinator = new ProjectWorkspaceCoordinator(
        {
          list: () => [project()],
          onUpdate: (listener) => {
            projectListeners.push(listener);
            return () => {};
          },
          onSettled: (listener) => {
            projectSettled.push(listener as never);
            return () => {};
          },
        },
        {
          list: () => tasks,
          subscribe: (listener) => {
            taskListeners.push(listener);
            return () => {};
          },
          subscribeSettled: (listener) => {
            taskSettled.push(listener);
            return () => {};
          },
        },
        { list: () => [], diagnosticsFor: () => [], onUpdate: () => () => {} },
        () => statuses,
      );
      coordinator.start();
      const publications: number[] = [];
      coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));
      tasks = [action(projectPath, 1, 'done')];
      const metadata = (): void =>
        projectListeners.forEach((listener) =>
          listener({
            changedPaths: [projectPath],
            invalidatedProjectPaths: [projectPath],
          }),
        );
      const taskIndexed = (): void => {
        taskListeners.forEach((listener) => listener({ type: 'changed', files: [projectPath] }));
        taskSettled.forEach((listener) =>
          listener({
            type: 'settled',
            reason: 'index',
            files: [{ path: projectPath, generation: 2 }],
          }),
        );
      };
      if (order === 'metadata-first') {
        metadata();
        taskIndexed();
      } else {
        taskIndexed();
        metadata();
      }
      projectSettled.forEach((listener) =>
        listener({
          reason: 'task-barrier',
          files: [{ path: projectPath, generation: 2 }],
        }),
      );
      vi.runAllTimers();
      await Promise.resolve();
      expect(publications).toEqual([1]);
      coordinator.destroy();
    },
  );

  it('converges repeated edits with independent source-local generations', async () => {
    const projectListeners: Array<(event: ProjectStoreEvent) => void> = [];
    const taskListeners: Array<(event: TaskIndexEvent) => void> = [];
    const projectSettled: Array<
      (event: {
        reason: 'task-barrier';
        files: readonly { path: string; generation: number }[];
      }) => void
    > = [];
    const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
    let tasks: readonly TaskSnapshot[] = [action(projectPath, 1, 'open')];
    const coordinator = new ProjectWorkspaceCoordinator(
      {
        list: () => [project()],
        onUpdate: (listener) => {
          projectListeners.push(listener);
          return () => {};
        },
        onSettled: (listener) => {
          projectSettled.push(listener as never);
          return () => {};
        },
      },
      {
        list: () => tasks,
        subscribe: (listener) => {
          taskListeners.push(listener);
          return () => {};
        },
        subscribeSettled: (listener) => {
          taskSettled.push(listener);
          return () => {};
        },
      },
      { list: () => [], diagnosticsFor: () => [], onUpdate: () => () => {} },
      () => statuses,
    );
    coordinator.start();
    const publications: number[] = [];
    coordinator.onUpdate((snapshots) => publications.push(snapshots[0]!.taskRollup.done));

    const settle = async (
      taskGeneration: number,
      projectGeneration: number,
      status: TaskSnapshot['status'],
    ): Promise<void> => {
      tasks = [action(projectPath, 1, status)];
      taskListeners.forEach((listener) => listener({ type: 'changed', files: [projectPath] }));
      taskSettled.forEach((listener) =>
        listener({
          type: 'settled',
          reason: 'index',
          files: [{ path: projectPath, generation: taskGeneration }],
        }),
      );
      projectListeners.forEach((listener) =>
        listener({ changedPaths: [projectPath], invalidatedProjectPaths: [projectPath] }),
      );
      projectSettled.forEach((listener) =>
        listener({
          reason: 'task-barrier',
          files: [{ path: projectPath, generation: projectGeneration }],
        }),
      );
      await Promise.resolve();
    };

    await settle(50, 2, 'done');
    await settle(51, 3, 'open');
    expect(publications).toEqual([1, 0]);
    coordinator.destroy();
  });

  it.each(['rename', 'delete', 'external-edit', 'own-commit'] as const)(
    'invalidates old/new membership and publishes one settled snapshot for %s',
    async (event) => {
      vi.useFakeTimers();
      const workNoteListeners: Array<(event: WorkNoteIndexEvent) => void> = [];
      const workNoteSettled: Array<
        (event: { reason: 'index'; files: readonly { path: string; generation: number }[] }) => void
      > = [];
      const taskSettled: Array<(event: Extract<TaskIndexEvent, { type: 'settled' }>) => void> = [];
      let notes: readonly WorkNoteSnapshot[] = [workNote('Work/Old.md')];
      const coordinator = new ProjectWorkspaceCoordinator(
        { list: () => [project()], onUpdate: () => () => {} },
        {
          list: () => [],
          subscribe: () => () => {},
          subscribeSettled: (listener) => {
            taskSettled.push(listener);
            return () => {};
          },
        },
        {
          list: () => notes,
          diagnosticsFor: () => [],
          onUpdate: (listener) => {
            workNoteListeners.push(listener);
            return () => {};
          },
          onSettled: (listener) => {
            workNoteSettled.push(listener as never);
            return () => {};
          },
        },
        () => statuses,
      );
      coordinator.start();
      const publications: string[][] = [];
      coordinator.onUpdate((snapshots) =>
        publications.push(snapshots[0]!.workNotes.map(({ path }) => path)),
      );
      notes = event === 'delete' ? [] : [workNote('Work/New.md')];
      if (event === 'own-commit') coordinator.absorbOwnCommit(['Work/Old.md', 'Work/New.md']);
      workNoteListeners.forEach((listener) =>
        listener({
          cause: 'index',
          changedPaths: ['Work/Old.md', 'Work/New.md'],
          invalidatedProjectPaths: [projectPath],
          taskBarriers: [],
        }),
      );
      taskSettled.forEach((listener) =>
        listener({
          type: 'settled',
          reason: 'index',
          files: [
            { path: 'Work/Old.md', generation: 2 },
            { path: 'Work/New.md', generation: 1 },
          ],
        }),
      );
      workNoteSettled.forEach((listener) =>
        listener({
          reason: 'index',
          files: [
            { path: 'Work/Old.md', generation: 2 },
            { path: 'Work/New.md', generation: 1 },
          ],
        }),
      );
      vi.runAllTimers();
      await Promise.resolve();
      expect(publications).toEqual([[...(event === 'delete' ? [] : ['Work/New.md'])]]);
      coordinator.destroy();
    },
  );
});
