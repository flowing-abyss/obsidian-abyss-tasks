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
import { buildWorkNoteRelationProjections } from './work-notes/WorkNoteRelationProjection';
import {
  computeMilestoneRollups,
  computeWorkNoteRollup,
  workNoteLifecycleBehavior,
} from './work-notes/rollups';
import type { WorkNoteSnapshot } from './work-notes/types';

interface ProjectWorkspaceProjectSource {
  list(): readonly Project[];
}

interface ProjectWorkspaceWorkNoteSource {
  list(): readonly WorkNoteSnapshot[];
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

export class ProjectWorkspaceReadModel {
  private byProjectPath = new Map<string, ProjectWorkspaceSnapshot>();

  constructor(private readonly options: ProjectWorkspaceReadModelOptions) {}

  rebuild(): readonly ProjectWorkspaceSnapshot[] {
    const projects = this.options.projects.list();
    const workNotes = this.options.workNotes.list();
    const tasks = this.options.tasks.list();
    const statuses = this.options.statuses();
    const notesByProject = new Map<string, WorkNoteSnapshot[]>();
    for (const note of workNotes) {
      const bucket = notesByProject.get(note.projectPath) ?? [];
      bucket.push(note);
      notesByProject.set(note.projectPath, bucket);
    }
    const tasksByPath = new Map<string, TaskSnapshot[]>();
    for (const task of tasks) {
      const bucket = tasksByPath.get(task.source.filePath) ?? [];
      bucket.push(task);
      tasksByPath.set(task.source.filePath, bucket);
    }
    const next = new Map<string, ProjectWorkspaceSnapshot>();
    for (const project of projects) {
      const projectNotes = [...(notesByProject.get(project.path) ?? [])].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
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
      for (const task of tasksByPath.get(project.path) ?? []) {
        append(task, { type: 'project', path: project.path });
      }
      for (const note of projectNotes) {
        for (const task of tasksByPath.get(note.path) ?? []) {
          append(task, { type: 'work-note', path: note.path });
        }
      }
      projectActions.sort(taskOrder);
      const relations = buildWorkNoteRelationProjections(
        workNotes,
        statuses,
        new Set(projectNotes.map(({ path }) => path)),
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
      const now = this.options.now?.() ?? Date.now();
      const today = this.options.today?.() ?? new Date(now).toISOString().slice(0, 10);
      const ordinary = projectNotes.filter(({ kind }) => kind === 'ordinary');
      const milestones = projectNotes.filter(({ kind }) => kind === 'milestone');
      const snapshotTasks = projectActions.map(({ task }) => task);
      const actionableDependencies = projectActions.filter(
        ({ task }) => task.status !== 'done' && task.status !== 'cancelled',
      );
      const invalidDependencies = actionableDependencies.filter(
        ({ dependency }) => dependency.type === 'invalid',
      );
      next.set(project.path, {
        project,
        tasks: projectActions,
        workNotes: ordinary,
        milestones,
        taskRollup: computeTaskRollup(snapshotTasks),
        workNoteRollup: computeWorkNoteRollup(projectNotes, statuses),
        milestoneRollups: computeMilestoneRollups(projectNotes, statuses),
        workNoteRelations: relations,
        overdue: {
          tasks: snapshotTasks.filter((task) => taskIsOverdue(task, today)).length,
          workNotes: ordinary.filter(
            (note) =>
              workNoteLifecycleBehavior(note, statuses) === 'regular' &&
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
      });
    }
    this.byProjectPath = next;
    return this.list();
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
