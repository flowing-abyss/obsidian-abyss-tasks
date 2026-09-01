import { describe, expect, it, vi } from 'vitest';
import type { ProjectStoreEvent, ProjectStoreSettledEvent } from '../src/projects/ProjectStore';
import { ProjectWorkspaceCoordinator } from '../src/projects/ProjectWorkspaceCoordinator';
import {
  ProjectWorkspaceReadModel,
  type ProjectWorkspaceBucketResult,
} from '../src/projects/ProjectWorkspaceReadModel';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../src/projects/dependencies/DependencyPolicy';
import type { Project } from '../src/projects/types';
import type {
  WorkNoteIndexEvent,
  WorkNoteIndexSettledEvent,
  WorkNoteSnapshot,
} from '../src/projects/work-notes/types';
import type { ProjectStatus } from '../src/settings/types';
import type { TaskIndexEvent, TaskIndexSettledEvent, TaskSnapshot } from '../src/tasks';
import { task } from './helpers';

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
];

function project(path: string): Project {
  return {
    path,
    name: path,
    frontmatter: {},
    tags: [],
    statusId: 'active',
    rawStatus: 'Active',
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
  };
}

function note(
  path: string,
  projectPath: string,
  options: {
    readonly kind?: WorkNoteSnapshot['kind'];
    readonly milestonePath?: string;
    readonly statusId?: string;
  } = {},
): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'partial-fixture',
    kind: options.kind ?? 'ordinary',
    projectPath,
    statusId: options.statusId ?? 'active',
    rawStatus: null,
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...(options.milestonePath && { milestonePath: options.milestonePath }),
  };
}

function root(
  path: string,
  line: number,
  status: TaskSnapshot['status'] = 'open',
  dependency?: TaskSnapshot['dependency'],
): TaskSnapshot {
  return task({
    status,
    statusSymbol: status === 'done' ? 'x' : ' ',
    ref: { filePath: path, line, revision: `${path}:${String(line)}:${status}` },
    source: { filePath: path, line, originalBlock: `- [ ] ${path} ${String(line)}` },
    ...(dependency && { dependency }),
  });
}

function ownership(snapshot: WorkNoteSnapshot | undefined) {
  return snapshot
    ? {
        projectPath: snapshot.projectPath,
        kind: snapshot.kind,
        milestonePath: snapshot.milestonePath ?? null,
      }
    : null;
}

describe('ProjectWorkspaceReadModel partial buckets', () => {
  it('rebuilds only a same-owner Project and affected milestone while preserving all other identities', () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    const milestoneA = note('Work/M-A.md', projectA.path, { kind: 'milestone' });
    const milestoneSibling = note('Work/M-Sibling.md', projectA.path, { kind: 'milestone' });
    let edited = note('Work/A.md', projectA.path, { milestonePath: milestoneA.path });
    let notes: readonly WorkNoteSnapshot[] = [milestoneA, milestoneSibling, edited];
    const projectList = vi.fn(() => [projectA, projectB]);
    const projectGet = vi.fn((path: string) =>
      [projectA, projectB].find((item) => item.path === path),
    );
    const taskList = vi.fn((): readonly TaskSnapshot[] => []);
    const workNoteList = vi.fn(() => notes);
    const workNoteGet = vi.fn((path: string) => notes.find((item) => item.path === path));
    const model = new ProjectWorkspaceReadModel({
      projects: { list: projectList, get: projectGet },
      tasks: { list: taskList },
      workNotes: { list: workNoteList, get: workNoteGet, diagnosticsFor: () => [] },
      statuses: () => statuses,
    });
    model.rebuild();
    projectList.mockClear();
    taskList.mockClear();
    workNoteList.mockClear();
    const beforeA = model.get(projectA.path)!;
    const beforeB = model.get(projectB.path)!;
    const beforeMilestone = beforeA.milestoneRollups.get(milestoneA.path);
    const beforeSibling = beforeA.milestoneRollups.get(milestoneSibling.path);

    const previous = edited;
    edited = { ...edited, statusId: 'done', presetRevision: 2 };
    notes = [milestoneA, milestoneSibling, edited];
    const result = model.rebuildBuckets({
      workNotes: [{ path: edited.path, before: ownership(previous), after: ownership(edited) }],
    });

    expect(result.evaluatedProjectPaths).toEqual([projectA.path]);
    expect(result.changedProjectPaths).toEqual([projectA.path]);
    expect(result.evaluatedMilestonePaths).toEqual([milestoneA.path]);
    expect(model.get(projectA.path)).not.toBe(beforeA);
    expect(model.get(projectB.path)).toBe(beforeB);
    expect(model.get(projectA.path)!.milestoneRollups.get(milestoneA.path)).not.toBe(
      beforeMilestone,
    );
    expect(model.get(projectA.path)!.milestoneRollups.get(milestoneSibling.path)).toBe(
      beforeSibling,
    );
    expect(projectList).not.toHaveBeenCalled();
    expect(workNoteList).not.toHaveBeenCalled();
    expect(taskList).not.toHaveBeenCalledWith();
    expect(projectGet).toHaveBeenCalledWith(projectA.path);
    expect(workNoteGet).toHaveBeenCalledWith(edited.path);
  });

  it('evaluates a milestone note itself across create, delete, and owner moves', () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    let notes: readonly WorkNoteSnapshot[] = [];
    const model = new ProjectWorkspaceReadModel({
      projects: {
        list: () => [projectA, projectB],
        get: (path) => [projectA, projectB].find((item) => item.path === path),
      },
      tasks: { list: () => [] },
      workNotes: {
        list: () => notes,
        get: (path) => notes.find((item) => item.path === path),
        diagnosticsFor: () => [],
      },
      statuses: () => statuses,
    });
    model.rebuild();
    let milestone = note('Work/New-Milestone.md', projectA.path, { kind: 'milestone' });
    notes = [milestone];
    const created = model.rebuildBuckets({
      workNotes: [{ path: milestone.path, before: null, after: ownership(milestone) }],
    });
    expect(created.evaluatedMilestonePaths).toEqual([milestone.path]);
    expect(model.get(projectA.path)!.milestoneRollups.has(milestone.path)).toBe(true);

    const beforeMove = milestone;
    milestone = { ...milestone, projectPath: projectB.path, presetRevision: 2 };
    notes = [milestone];
    const moved = model.rebuildBuckets({
      workNotes: [
        { path: milestone.path, before: ownership(beforeMove), after: ownership(milestone) },
      ],
    });
    expect(moved.evaluatedMilestonePaths).toEqual([milestone.path]);
    expect(model.get(projectA.path)!.milestoneRollups.has(milestone.path)).toBe(false);
    expect(model.get(projectB.path)!.milestoneRollups.has(milestone.path)).toBe(true);

    notes = [];
    const deleted = model.rebuildBuckets({
      workNotes: [{ path: milestone.path, before: ownership(milestone), after: null }],
    });
    expect(deleted.evaluatedMilestonePaths).toEqual([milestone.path]);
    expect(model.get(projectB.path)!.milestoneRollups.has(milestone.path)).toBe(false);
  });

  it('invalidates both owner and milestone sides of a move but skips a semantic no-op entirely', () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    const projectC = project('Projects/C.md');
    const milestoneA = note('Work/M-A.md', projectA.path, { kind: 'milestone' });
    const milestoneB = note('Work/M-B.md', projectB.path, { kind: 'milestone' });
    let moved = note('Work/Moved.md', projectA.path, { milestonePath: milestoneA.path });
    let notes: readonly WorkNoteSnapshot[] = [milestoneA, milestoneB, moved];
    let tasks: readonly TaskSnapshot[] = [];
    const model = new ProjectWorkspaceReadModel({
      projects: {
        list: () => [projectA, projectB, projectC],
        get: (path) => [projectA, projectB, projectC].find((item) => item.path === path),
      },
      tasks: {
        list: (query) =>
          query?.filePath
            ? tasks.filter((candidate) => candidate.source.filePath === query.filePath)
            : tasks,
      },
      workNotes: {
        list: () => notes,
        get: (path) => notes.find((item) => item.path === path),
        diagnosticsFor: () => [],
      },
      statuses: () => statuses,
    });
    model.rebuild();
    const untouched = model.get(projectC.path)!;
    const before = moved;
    moved = {
      ...moved,
      projectPath: projectB.path,
      milestonePath: milestoneB.path,
      presetRevision: 2,
    };
    notes = [milestoneA, milestoneB, moved];

    const movedResult = model.rebuildBuckets({
      workNotes: [{ path: moved.path, before: ownership(before), after: ownership(moved) }],
    });
    expect(movedResult.evaluatedProjectPaths).toEqual([projectA.path, projectB.path]);
    expect(movedResult.changedProjectPaths).toEqual([projectA.path, projectB.path]);
    expect(movedResult.evaluatedMilestonePaths).toEqual([milestoneA.path, milestoneB.path]);
    expect(model.get(projectC.path)).toBe(untouched);

    const identities = model.list();
    const retainedMilestone = model.get(projectB.path)!.milestoneRollups.get(milestoneB.path);
    notes = notes.map((candidate) => ({ ...candidate }));
    const noOp = model.rebuildBuckets({
      workNotes: [{ path: moved.path, before: ownership(moved), after: ownership(moved) }],
    });
    expect(noOp.evaluatedProjectPaths).toEqual([]);
    expect(noOp.evaluatedMilestonePaths).toEqual([]);
    expect(noOp.changedProjectPaths).toEqual([]);
    expect(model.list()).toEqual(identities);
    model.list().forEach((snapshot, index) => expect(snapshot).toBe(identities[index]));

    const previousMetadata = moved;
    moved = { ...moved, priority: 'A', presetRevision: 3 };
    notes = [milestoneA, milestoneB, moved];
    const equalRollup = model.rebuildBuckets({
      workNotes: [
        { path: moved.path, before: ownership(previousMetadata), after: ownership(moved) },
      ],
    });
    expect(equalRollup.evaluatedMilestonePaths).toEqual([milestoneB.path]);
    expect(model.get(projectB.path)!.milestoneRollups.get(milestoneB.path)).toBe(retainedMilestone);

    const inheritedTask = root(moved.path, 7);
    tasks = [inheritedTask];
    const taskRollup = model.rebuildBuckets({
      taskSources: [
        {
          path: moved.path,
          beforeProjectPaths: [projectB.path],
          afterProjectPaths: [projectB.path],
        },
      ],
    });
    expect(taskRollup.evaluatedMilestonePaths).toEqual([milestoneB.path]);
    expect(model.get(projectB.path)!.milestoneRollups.get(milestoneB.path)).toMatchObject({
      active: 2,
      progress: 0,
    });
    const taskInclusiveMilestone = model.get(projectB.path)!.milestoneRollups.get(milestoneB.path);

    tasks = [root(projectB.path, 4)];
    const rebuilt = model.rebuildBuckets({
      taskSources: [
        {
          path: projectB.path,
          beforeProjectPaths: [projectB.path],
          afterProjectPaths: [projectB.path],
        },
      ],
      projectPaths: [projectB.path],
    });
    expect(rebuilt.evaluatedMilestonePaths).toEqual([]);
    expect(model.get(projectB.path)!.milestoneRollups.get(milestoneB.path)).toBe(
      taskInclusiveMilestone,
    );
  });

  it('invalidates reverse cross-Project Work Note relation sources when a target disappears', () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    const target = note('Work/Target.md', projectB.path);
    const source = {
      ...note('Work/Source.md', projectA.path),
      relatedPaths: [target.path],
    } satisfies WorkNoteSnapshot;
    let notes: readonly WorkNoteSnapshot[] = [source, target];
    const model = new ProjectWorkspaceReadModel({
      projects: {
        list: () => [projectA, projectB],
        get: (path) => [projectA, projectB].find((item) => item.path === path),
      },
      tasks: { list: () => [] },
      workNotes: {
        list: () => notes,
        get: (path) => notes.find((item) => item.path === path),
        diagnosticsFor: () => [],
      },
      statuses: () => statuses,
    });
    model.rebuild();
    expect(model.get(projectA.path)!.workNoteRelations[0]).toMatchObject({
      type: 'invalid',
      reason: 'cross-project',
    });
    notes = [source];
    const result = model.rebuildBuckets({
      workNotes: [{ path: target.path, before: ownership(target), after: null }],
    });
    expect(result.evaluatedProjectPaths).toEqual([projectA.path, projectB.path]);
    expect(model.get(projectA.path)!.workNoteRelations[0]).toMatchObject({
      type: 'invalid',
      reason: 'missing',
    });
  });

  it('updates direct/inherited and cross-Project dependency buckets with exact identities and counters', () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    const projectC = project('Projects/C.md');
    const inheritedNote = note('Work/B.md', projectB.path);
    let prerequisite = root(projectA.path, 0, 'open', { id: 'prep', dependsOn: [] });
    const dependent = root(inheritedNote.path, 0, 'open', { dependsOn: ['prep'] });
    let tasks: readonly TaskSnapshot[] = [prerequisite, dependent];
    const dependencyIndex = new DependencyIndex();
    dependencyIndex.replace(tasks);
    const dependencyPolicy = new DependencyPolicy(dependencyIndex);
    const evaluateCompletion = vi.spyOn(dependencyPolicy, 'evaluateCompletion');
    const model = new ProjectWorkspaceReadModel({
      projects: {
        list: () => [projectA, projectB, projectC],
        get: (path) => [projectA, projectB, projectC].find((item) => item.path === path),
      },
      tasks: {
        list: (query) =>
          query?.filePath
            ? tasks.filter((candidate) => candidate.source.filePath === query.filePath)
            : tasks,
      },
      workNotes: {
        list: () => [inheritedNote],
        get: (path) => (path === inheritedNote.path ? inheritedNote : undefined),
        diagnosticsFor: () => [],
      },
      statuses: () => statuses,
      dependencies: dependencyPolicy,
    });
    model.rebuild();
    evaluateCompletion.mockClear();
    const untouched = model.get(projectC.path)!;
    expect(model.get(projectB.path)!.dependencies.blocked).toBe(1);

    prerequisite = root(projectA.path, 0, 'done', { id: 'prep', dependsOn: [] });
    tasks = [prerequisite, dependent];
    dependencyIndex.acceptCommittedRoots([prerequisite]);
    const result = model.rebuildBuckets({
      taskSources: [
        {
          path: projectA.path,
          beforeProjectPaths: [projectA.path],
          afterProjectPaths: [projectA.path],
        },
      ],
      dependencyProjectPaths: [projectA.path, projectB.path],
    });

    expect(result.evaluatedProjectPaths).toEqual([projectA.path, projectB.path]);
    expect(result.changedProjectPaths).toEqual([projectA.path, projectB.path]);
    expect(evaluateCompletion).toHaveBeenCalledTimes(2);
    expect(model.get(projectB.path)!.dependencies.blocked).toBe(0);
    expect(model.get(projectC.path)).toBe(untouched);

    const directNoOp = model.rebuildBuckets({
      taskSources: [
        {
          path: inheritedNote.path,
          beforeProjectPaths: [projectB.path],
          afterProjectPaths: [projectB.path],
        },
      ],
    });
    expect(directNoOp.evaluatedProjectPaths).toEqual([]);
    expect(directNoOp.changedProjectPaths).toEqual([]);
    expect(evaluateCompletion).toHaveBeenCalledTimes(2);
  });

  it('coalesces one ownership-aware coordinator bucket pass and publishes only a semantic change', async () => {
    const projectA = project('Projects/A.md');
    const projectB = project('Projects/B.md');
    let notes: readonly WorkNoteSnapshot[] = [note('Work/A.md', projectA.path)];
    const projectUpdates: Array<(event: ProjectStoreEvent) => void> = [];
    const projectSettled: Array<(event: ProjectStoreSettledEvent) => void> = [];
    const taskUpdates: Array<(event: TaskIndexEvent) => void> = [];
    const taskSettled: Array<(event: TaskIndexSettledEvent) => void> = [];
    const workNoteUpdates: Array<(event: WorkNoteIndexEvent) => void> = [];
    const workNoteSettled: Array<(event: WorkNoteIndexSettledEvent) => void> = [];
    const projectList = vi.fn(() => [projectA, projectB]);
    const projectGet = vi.fn((path: string) =>
      [projectA, projectB].find((item) => item.path === path),
    );
    const taskList = vi.fn((): readonly TaskSnapshot[] => []);
    const workNoteList = vi.fn(() => notes);
    const workNoteGet = vi.fn((path: string) => notes.find((item) => item.path === path));
    const coordinator = new ProjectWorkspaceCoordinator(
      {
        list: projectList,
        get: projectGet,
        onUpdate: (listener) => {
          projectUpdates.push(listener);
          return () => {};
        },
        onSettled: (listener) => {
          projectSettled.push(listener);
          return () => {};
        },
      },
      {
        list: taskList,
        subscribe: (listener) => {
          taskUpdates.push(listener);
          return () => {};
        },
        subscribeSettled: (listener) => {
          taskSettled.push(listener);
          return () => {};
        },
      },
      {
        list: workNoteList,
        get: workNoteGet,
        diagnosticsFor: () => [],
        onUpdate: (listener) => {
          workNoteUpdates.push(listener);
          return () => {};
        },
        onSettled: (listener) => {
          workNoteSettled.push(listener);
          return () => {};
        },
      },
      () => statuses,
      { now: () => 0, today: () => '2026-08-26' },
    );
    coordinator.start();
    projectList.mockClear();
    taskList.mockClear();
    workNoteList.mockClear();
    expect(
      [
        projectUpdates,
        projectSettled,
        taskUpdates,
        taskSettled,
        workNoteUpdates,
        workNoteSettled,
      ].map((listeners) => listeners.length),
    ).toEqual([1, 1, 1, 1, 1, 1]);
    const untouched = coordinator.get(projectB.path)!;
    const rebuildBuckets = vi.spyOn(coordinator.readModel, 'rebuildBuckets');
    const publications: string[][] = [];
    coordinator.onUpdate((_snapshots, event) => publications.push([...event.projectPaths]));

    notes = [{ ...notes[0]!, statusId: 'done', presetRevision: 2 }];
    const update: WorkNoteIndexEvent = {
      cause: 'index',
      changedPaths: ['Work/A.md'],
      invalidatedProjectPaths: [projectA.path],
      taskBarriers: [],
    };
    workNoteUpdates[0]!(update);
    workNoteUpdates[0]!(update);
    workNoteUpdates[0]!(update);
    workNoteSettled[0]!({
      reason: 'index',
      files: [{ path: 'Work/A.md', generation: 1 }],
    });
    await Promise.resolve();

    expect(rebuildBuckets).toHaveBeenCalledTimes(1);
    const firstResult = rebuildBuckets.mock.results[0]!.value as ProjectWorkspaceBucketResult;
    expect(firstResult.evaluatedProjectPaths).toEqual([projectA.path]);
    expect(firstResult.changedProjectPaths).toEqual([projectA.path]);
    expect(coordinator.get(projectB.path)).toBe(untouched);
    expect(publications).toEqual([[projectA.path]]);
    expect(projectList).not.toHaveBeenCalled();
    expect(workNoteList).not.toHaveBeenCalled();
    expect(taskList).not.toHaveBeenCalledWith();

    workNoteUpdates[0]!(update);
    workNoteUpdates[0]!(update);
    workNoteSettled[0]!({
      reason: 'index',
      files: [{ path: 'Work/A.md', generation: 2 }],
    });
    await Promise.resolve();
    expect(rebuildBuckets).toHaveBeenCalledTimes(2);
    const secondResult = rebuildBuckets.mock.results[1]!.value as ProjectWorkspaceBucketResult;
    expect(secondResult.evaluatedProjectPaths).toEqual([]);
    expect(publications).toEqual([[projectA.path]]);
    coordinator.destroy();
  });
});
