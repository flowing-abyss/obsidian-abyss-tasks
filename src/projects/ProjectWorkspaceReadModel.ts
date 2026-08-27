import { getTaskDateCategory } from '../domain/taskDateCategory';
import type { ProjectStatus } from '../settings/types';
import type { TaskQueryApi, TaskSnapshot } from '../tasks';
import type { DependencyProjectionPort } from '../tasks/application/DependencyPolicyPort';
import { computeTaskRollup } from './ProjectStore';
import type {
  Project,
  ProjectAction,
  ProjectWorkspaceDiagnostic,
  ProjectWorkspaceSnapshot,
} from './types';
import { buildWorkNoteRelationProjectionsFromIndex } from './work-notes/WorkNoteRelationProjection';
import {
  computeMilestoneRollup,
  computeMilestoneRollups,
  computeWorkNoteRollup,
  type MilestoneRollup,
  workNoteLifecycleBehavior,
} from './work-notes/rollups';
import type { WorkNoteSnapshot } from './work-notes/types';

interface ProjectWorkspaceProjectSource {
  list(): readonly Project[];
  get(path: string): Project | undefined;
}

interface ProjectWorkspaceWorkNoteSource {
  list(): readonly WorkNoteSnapshot[];
  get(path: string): WorkNoteSnapshot | undefined;
  diagnosticsFor(path: string): readonly WorkNoteSnapshot['diagnostics'][number][];
}

export interface ProjectWorkspaceReadModelOptions {
  readonly projects: ProjectWorkspaceProjectSource;
  readonly tasks: Pick<TaskQueryApi, 'list'>;
  readonly workNotes: ProjectWorkspaceWorkNoteSource;
  readonly statuses: () => readonly ProjectStatus[];
  readonly now?: () => number;
  readonly today?: () => string;
  readonly dependencies?: Pick<DependencyProjectionPort, 'evaluateCompletion'>;
}

export interface ProjectWorkspaceOwnership {
  readonly projectPath: string;
  readonly kind: WorkNoteSnapshot['kind'];
  readonly milestonePath: string | null;
}

export interface ProjectWorkspaceBucketDelta {
  readonly projectPaths?: readonly string[];
  readonly workNotes?: readonly {
    readonly path: string;
    readonly before: ProjectWorkspaceOwnership | null;
    readonly after: ProjectWorkspaceOwnership | null;
  }[];
  readonly taskSources?: readonly {
    readonly path: string;
    readonly beforeProjectPaths: readonly string[];
    readonly afterProjectPaths: readonly string[];
  }[];
  readonly dependencyProjectPaths?: readonly string[];
}

export interface ProjectWorkspaceBucketResult {
  readonly snapshots: readonly ProjectWorkspaceSnapshot[];
  readonly evaluatedProjectPaths: readonly string[];
  readonly changedProjectPaths: readonly string[];
  readonly evaluatedMilestonePaths: readonly string[];
}

interface ReadContext {
  readonly projectsByPath: ReadonlyMap<string, Project>;
  readonly workNotesByPath: ReadonlyMap<string, WorkNoteSnapshot>;
  readonly notePathsByProject: ReadonlyMap<string, ReadonlySet<string>>;
  readonly tasksByPath: ReadonlyMap<string, readonly TaskSnapshot[]>;
  readonly statuses: readonly ProjectStatus[];
  readonly now: number;
  readonly today: string;
}

interface AffectedBuckets {
  readonly projects: ReadonlySet<string>;
  readonly milestones: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
}

function taskIdentity(task: TaskSnapshot): string {
  return `${task.ref.filePath}\u0000${String(task.ref.line)}\u0000${task.ref.revision}`;
}

function taskOrder(left: ProjectAction, right: ProjectAction): number {
  if (left.owner.type !== right.owner.type) return left.owner.type === 'project' ? -1 : 1;
  return (
    left.task.source.filePath.localeCompare(right.task.source.filePath) ||
    left.task.source.line - right.task.source.line
  );
}

function localDateEndMs(raw: string): number {
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}

function projectRangeIsOverdue(range: Project['range'], now: number): boolean {
  if (!range.end || range.issue === 'invalid-end' || range.issue === 'reversed') return false;
  const boundary =
    range.end.precision === 'date' ? localDateEndMs(range.end.raw) : range.end.instantMs;
  return now > boundary;
}

function taskIsOverdue(task: TaskSnapshot, today: string): boolean {
  return getTaskDateCategory(task, today) === 'overdue';
}

function snapshotSignature(snapshot: ProjectWorkspaceSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    milestoneRollups: [...snapshot.milestoneRollups.entries()],
  });
}

function sameMilestoneRollup(left: MilestoneRollup | undefined, right: MilestoneRollup): boolean {
  return (
    left?.active === right.active &&
    left.completed === right.completed &&
    left.dropped === right.dropped &&
    left.progress === right.progress
  );
}

export class ProjectWorkspaceReadModel {
  private byProjectPath = new Map<string, ProjectWorkspaceSnapshot>();
  private inputSignatures = new Map<string, string>();
  private projectsByPath = new Map<string, Project>();
  private workNotesByPath = new Map<string, WorkNoteSnapshot>();
  private notePathsByProject = new Map<string, Set<string>>();
  private tasksByPath = new Map<string, readonly TaskSnapshot[]>();
  private relationTargetsBySource = new Map<string, ReadonlySet<string>>();
  private relationSourcesByTarget = new Map<string, Set<string>>();
  private milestoneRollups = new Map<
    string,
    ProjectWorkspaceSnapshot['milestoneRollups'] extends ReadonlyMap<string, infer Rollup>
      ? Rollup
      : never
  >();

  constructor(private readonly options: ProjectWorkspaceReadModelOptions) {}

  rebuild(): readonly ProjectWorkspaceSnapshot[] {
    this.rebuildSourceIndexes();
    const context = this.cachedContext();
    const next = new Map<string, ProjectWorkspaceSnapshot>();
    const signatures = new Map<string, string>();
    this.milestoneRollups.clear();
    for (const project of context.projectsByPath.values()) {
      const notes = this.projectNotes(project.path, context);
      for (const [path, rollup] of computeMilestoneRollups(notes, context.statuses)) {
        this.milestoneRollups.set(path, rollup);
      }
    }
    for (const project of context.projectsByPath.values()) {
      next.set(project.path, this.buildSnapshot(project, context));
      signatures.set(project.path, this.inputSignature(project.path, context));
    }
    this.byProjectPath = next;
    this.inputSignatures = signatures;
    return this.list();
  }

  rebuildBuckets(delta: ProjectWorkspaceBucketDelta): ProjectWorkspaceBucketResult {
    const affected = this.affectedBuckets(delta);
    this.refreshSourceBuckets(delta, affected.projects);
    const context = this.cachedContext();
    const projectsToEvaluate = this.projectsNeedingEvaluation(affected, context);
    const evaluatedMilestonePaths = this.evaluatedMilestones(
      affected.milestones,
      new Set(projectsToEvaluate),
      delta,
      context,
    );
    this.refreshMilestoneBuckets(new Set(evaluatedMilestonePaths), context);
    const evaluated = this.evaluateProjectBuckets(projectsToEvaluate, context);
    return {
      snapshots: this.list(),
      ...evaluated,
      evaluatedMilestonePaths,
    };
  }

  private affectedBuckets(delta: ProjectWorkspaceBucketDelta): AffectedBuckets {
    const projects = new Set(delta.projectPaths ?? []);
    const milestoneCandidates = new Set<string>();
    for (const change of delta.workNotes ?? []) {
      for (const sourcePath of this.relationSourcesByTarget.get(change.path) ?? []) {
        const source = this.workNotesByPath.get(sourcePath);
        if (source) projects.add(source.projectPath);
      }
      if (change.before) {
        projects.add(change.before.projectPath);
        if (change.before.milestonePath) milestoneCandidates.add(change.before.milestonePath);
        if (change.before.kind === 'milestone') milestoneCandidates.add(change.path);
      }
      if (change.after) {
        projects.add(change.after.projectPath);
        if (change.after.milestonePath) milestoneCandidates.add(change.after.milestonePath);
        if (change.after.kind === 'milestone') milestoneCandidates.add(change.path);
      }
    }
    for (const change of delta.taskSources ?? []) {
      for (const path of change.beforeProjectPaths) projects.add(path);
      for (const path of change.afterProjectPaths) projects.add(path);
    }
    const dependencyPaths = new Set(delta.dependencyProjectPaths ?? []);
    for (const path of dependencyPaths) projects.add(path);
    return { projects, milestones: milestoneCandidates, dependencies: dependencyPaths };
  }

  private refreshMilestoneBuckets(paths: ReadonlySet<string>, context: ReadContext): void {
    for (const path of paths) {
      const milestone = context.workNotesByPath.get(path);
      if (!milestone || milestone.kind !== 'milestone') {
        this.milestoneRollups.delete(path);
        continue;
      }
      const next = computeMilestoneRollup(
        milestone,
        this.projectNotes(milestone.projectPath, context),
        context.statuses,
      );
      if (!sameMilestoneRollup(this.milestoneRollups.get(path), next)) {
        this.milestoneRollups.set(path, next);
      }
    }
  }

  private evaluateProjectBuckets(
    projectPaths: readonly string[],
    context: ReadContext,
  ): Pick<ProjectWorkspaceBucketResult, 'evaluatedProjectPaths' | 'changedProjectPaths'> {
    const evaluatedProjectPaths = [...projectPaths];
    const changedProjectPaths: string[] = [];
    for (const path of projectPaths) {
      const project = context.projectsByPath.get(path);
      const nextInput = project ? this.inputSignature(path, context) : null;
      const previous = this.byProjectPath.get(path);
      if (!project) {
        if (previous) {
          this.byProjectPath.delete(path);
          this.inputSignatures.delete(path);
          changedProjectPaths.push(path);
        }
        continue;
      }
      const next = this.buildSnapshot(project, context);
      this.inputSignatures.set(path, nextInput!);
      if (previous && snapshotSignature(previous) === snapshotSignature(next)) continue;
      this.byProjectPath.set(path, next);
      changedProjectPaths.push(path);
    }
    return { evaluatedProjectPaths, changedProjectPaths };
  }

  private projectsNeedingEvaluation(
    affected: AffectedBuckets,
    context: ReadContext,
  ): readonly string[] {
    return [...affected.projects]
      .filter((path) => {
        if (affected.dependencies.has(path)) return true;
        const project = context.projectsByPath.get(path);
        const nextInput = project ? this.inputSignature(path, context) : null;
        return nextInput !== (this.inputSignatures.get(path) ?? null);
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private evaluatedMilestones(
    candidates: ReadonlySet<string>,
    evaluatedProjects: ReadonlySet<string>,
    delta: ProjectWorkspaceBucketDelta,
    context: ReadContext,
  ): readonly string[] {
    return [...candidates]
      .filter((path) => {
        const note = context.workNotesByPath.get(path);
        if (note && evaluatedProjects.has(note.projectPath)) return true;
        return (delta.workNotes ?? []).some(
          (change) =>
            (change.before?.milestonePath === path ||
              (change.before?.kind === 'milestone' && change.path === path)) &&
            evaluatedProjects.has(change.before.projectPath),
        );
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private rebuildSourceIndexes(): void {
    const projects = this.options.projects.list();
    const workNotes = this.options.workNotes.list();
    const tasks = this.options.tasks.list();
    this.projectsByPath = new Map(projects.map((project) => [project.path, project] as const));
    this.workNotesByPath = new Map(workNotes.map((note) => [note.path, note] as const));
    this.notePathsByProject = new Map();
    for (const note of workNotes) {
      const bucket = this.notePathsByProject.get(note.projectPath) ?? new Set<string>();
      bucket.add(note.path);
      this.notePathsByProject.set(note.projectPath, bucket);
    }
    this.relationTargetsBySource.clear();
    this.relationSourcesByTarget.clear();
    for (const note of workNotes) this.indexRelations(note);
    const tasksByPath = new Map<string, TaskSnapshot[]>();
    for (const task of tasks) {
      const bucket = tasksByPath.get(task.source.filePath) ?? [];
      bucket.push(task);
      tasksByPath.set(task.source.filePath, bucket);
    }
    this.tasksByPath = tasksByPath;
  }

  private refreshSourceBuckets(
    delta: ProjectWorkspaceBucketDelta,
    projectPaths: ReadonlySet<string>,
  ): void {
    for (const projectPath of projectPaths) {
      const project = this.options.projects.get(projectPath);
      if (project) this.projectsByPath.set(projectPath, project);
      else this.projectsByPath.delete(projectPath);
    }
    for (const change of delta.workNotes ?? []) {
      const previous = this.workNotesByPath.get(change.path);
      if (previous) {
        this.notePathsByProject.get(previous.projectPath)?.delete(change.path);
        this.removeRelations(previous);
      }
      const current = this.options.workNotes.get(change.path);
      if (!current) {
        this.workNotesByPath.delete(change.path);
        continue;
      }
      this.workNotesByPath.set(change.path, current);
      this.indexRelations(current);
      const bucket = this.notePathsByProject.get(current.projectPath) ?? new Set<string>();
      bucket.add(current.path);
      this.notePathsByProject.set(current.projectPath, bucket);
    }
    for (const source of delta.taskSources ?? []) {
      const tasks = this.options.tasks
        .list({ filePath: source.path })
        .filter((task) => task.source.filePath === source.path);
      if (tasks.length === 0) this.tasksByPath.delete(source.path);
      else this.tasksByPath.set(source.path, tasks);
    }
  }

  private relationTargets(note: WorkNoteSnapshot): ReadonlySet<string> {
    return new Set(
      [note.milestonePath, ...note.blockedByPaths, ...note.relatedPaths].filter(
        (path): path is string => path !== undefined,
      ),
    );
  }

  private indexRelations(note: WorkNoteSnapshot): void {
    const targets = this.relationTargets(note);
    this.relationTargetsBySource.set(note.path, targets);
    for (const target of targets) {
      const sources = this.relationSourcesByTarget.get(target) ?? new Set<string>();
      sources.add(note.path);
      this.relationSourcesByTarget.set(target, sources);
    }
  }

  private removeRelations(note: WorkNoteSnapshot): void {
    for (const target of this.relationTargetsBySource.get(note.path) ?? []) {
      const sources = this.relationSourcesByTarget.get(target);
      sources?.delete(note.path);
      if (sources?.size === 0) this.relationSourcesByTarget.delete(target);
    }
    this.relationTargetsBySource.delete(note.path);
  }

  private cachedContext(): ReadContext {
    const statuses = this.options.statuses();
    const now = this.options.now?.() ?? Date.now();
    return {
      projectsByPath: this.projectsByPath,
      workNotesByPath: this.workNotesByPath,
      notePathsByProject: this.notePathsByProject,
      tasksByPath: this.tasksByPath,
      statuses,
      now,
      today: this.options.today?.() ?? new Date(now).toISOString().slice(0, 10),
    };
  }

  private inputSignature(projectPath: string, context: ReadContext): string {
    const notes = this.projectNotes(projectPath, context);
    return JSON.stringify({
      project: context.projectsByPath.get(projectPath),
      notes,
      relationTargets: notes.flatMap((note) =>
        [...this.relationTargets(note)].map((path) => [path, context.workNotesByPath.get(path)]),
      ),
      tasks: [
        ...(context.tasksByPath.get(projectPath) ?? []),
        ...notes.flatMap((note) => context.tasksByPath.get(note.path) ?? []),
      ],
      statuses: context.statuses,
      today: context.today,
      overdueNotes: notes.map((note) => [
        note.path,
        workNoteLifecycleBehavior(note, context.statuses) === 'regular' &&
          projectRangeIsOverdue(note.range, context.now),
      ]),
    });
  }

  private projectNotes(projectPath: string, context: ReadContext): WorkNoteSnapshot[] {
    return [...(context.notePathsByProject.get(projectPath) ?? [])]
      .map((path) => context.workNotesByPath.get(path))
      .filter((note): note is WorkNoteSnapshot => note !== undefined)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private buildSnapshot(project: Project, context: ReadContext): ProjectWorkspaceSnapshot {
    const projectNotes = this.projectNotes(project.path, context);
    const projectActions: ProjectAction[] = [];
    const seen = new Set<string>();
    const append = (task: TaskSnapshot, owner: ProjectAction['owner']): void => {
      const key = taskIdentity(task);
      if (seen.has(key)) return;
      seen.add(key);
      projectActions.push({
        task,
        projectPath: project.path,
        owner,
        dependency: this.options.dependencies?.evaluateCompletion(task) ?? { type: 'allowed' },
      });
    };
    for (const task of context.tasksByPath.get(project.path) ?? []) {
      append(task, { type: 'project', path: project.path });
    }
    for (const note of projectNotes) {
      for (const task of context.tasksByPath.get(note.path) ?? []) {
        append(task, { type: 'work-note', path: note.path });
      }
    }
    projectActions.sort(taskOrder);
    const relations = buildWorkNoteRelationProjectionsFromIndex(
      context.workNotesByPath,
      projectNotes,
      context.statuses,
    );
    const diagnostics: ProjectWorkspaceDiagnostic[] = projectNotes.flatMap((note) =>
      note.diagnostics.map((diagnostic) => ({
        type: 'work-note' as const,
        path: note.path,
        diagnostic,
      })),
    );
    diagnostics.push(
      ...relations
        .filter((relation) => relation.type === 'invalid')
        .map((relation) => ({ type: 'relation' as const, path: relation.sourcePath, relation })),
    );
    const now = context.now;
    const today = context.today;
    const ordinary = projectNotes.filter(({ kind }) => kind === 'ordinary');
    const milestones = projectNotes.filter(({ kind }) => kind === 'milestone');
    const milestoneRollups = new Map(
      milestones.flatMap((milestone) => {
        const rollup = this.milestoneRollups.get(milestone.path);
        return rollup ? [[milestone.path, rollup] as const] : [];
      }),
    );
    const snapshotTasks = projectActions.map(({ task }) => task);
    const actionableDependencies = projectActions.filter(
      ({ task }) => task.status !== 'done' && task.status !== 'cancelled',
    );
    const invalidDependencies = actionableDependencies.filter(
      ({ dependency }) => dependency.type === 'invalid',
    );
    return {
      project,
      tasks: projectActions,
      workNotes: ordinary,
      milestones,
      taskRollup: computeTaskRollup(snapshotTasks),
      workNoteRollup: computeWorkNoteRollup(projectNotes, context.statuses),
      milestoneRollups,
      workNoteRelations: relations,
      overdue: {
        tasks: snapshotTasks.filter((task) => taskIsOverdue(task, today)).length,
        workNotes: ordinary.filter(
          (note) =>
            workNoteLifecycleBehavior(note, context.statuses) === 'regular' &&
            projectRangeIsOverdue(note.range, now),
        ).length,
      },
      dependencies: {
        blocked: actionableDependencies.filter(({ dependency }) => dependency.type === 'blocked')
          .length,
        invalid: invalidDependencies.length,
        diagnostics: invalidDependencies.map(({ task, dependency }) => ({
          ref: { ...task.ref },
          diagnostics:
            dependency.type === 'invalid'
              ? dependency.diagnostics.map((diagnostic) =>
                  diagnostic.type === 'duplicate-id'
                    ? {
                        ...diagnostic,
                        candidates: diagnostic.candidates.map((candidate) => ({ ...candidate })),
                      }
                    : { ...diagnostic },
                )
              : [],
        })),
      },
      diagnostics,
    };
  }

  list(): readonly ProjectWorkspaceSnapshot[] {
    return [...this.byProjectPath.values()].sort((left, right) =>
      left.project.name.localeCompare(right.project.name),
    );
  }

  get(projectPath: string): ProjectWorkspaceSnapshot | undefined {
    return this.byProjectPath.get(projectPath);
  }
}
