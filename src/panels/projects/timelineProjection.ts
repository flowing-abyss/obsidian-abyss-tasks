import { parseProjectDate } from '../../projects/projectDates';
import type { Project, ProjectWorkspaceSnapshot } from '../../projects/types';
import type { WorkNoteSnapshot } from '../../projects/work-notes/types';
import type { TaskSnapshot } from '../../tasks';

export type TimelinePointRole = 'start' | 'end' | 'scheduled' | 'due' | 'milestone';

export type TimelineItem =
  | {
      readonly kind: 'range';
      readonly key: string;
      readonly startMs: number;
      readonly endMs: number;
    }
  | {
      readonly kind: 'point';
      readonly key: string;
      readonly atMs: number;
      readonly role: TimelinePointRole;
    }
  | { readonly kind: 'undated'; readonly key: string }
  | { readonly kind: 'invalid'; readonly key: string; readonly reason: string };

export interface TimelineProjection<T> {
  readonly value: T;
  readonly label: string;
  readonly detail?: string;
  readonly item: TimelineItem;
  readonly dateByRole: Readonly<Partial<Record<TimelinePointRole, string>>>;
}

export type PortfolioTimelineValue =
  | {
      readonly kind: 'project';
      readonly project: Project;
      readonly snapshot?: ProjectWorkspaceSnapshot;
    }
  | {
      readonly kind: 'milestone';
      readonly note: WorkNoteSnapshot;
      readonly projectPath: string;
      readonly projectName: string;
    };

function projectKey(project: Project): string {
  return `project:${project.path}`;
}

export function projectTimelineItem(project: Project): TimelineItem {
  const key = projectKey(project);
  if (project.range.issue) return { kind: 'invalid', key, reason: project.range.issue };
  const { start, end } = project.range;
  if (start && end) return { kind: 'range', key, startMs: start.instantMs, endMs: end.instantMs };
  if (start) return { kind: 'point', key, atMs: start.instantMs, role: 'start' };
  if (end) return { kind: 'point', key, atMs: end.instantMs, role: 'end' };
  return { kind: 'undated', key };
}

export function projectTimelineItems(projects: readonly Project[]): readonly TimelineItem[] {
  return projects.map(projectTimelineItem);
}

export function projectTimelineEntry(project: Project): TimelineProjection<Project> {
  return {
    value: project,
    label: project.name,
    item: projectTimelineItem(project),
    dateByRole: {
      ...(project.range.start && { start: project.range.start.raw }),
      ...(project.range.end && { end: project.range.end.raw }),
    },
  };
}

/** Projects plus their joined typed milestones; ordinary Work Notes and Tasks never enter it. */
export function portfolioTimelineEntries(
  snapshots: readonly ProjectWorkspaceSnapshot[],
): readonly TimelineProjection<PortfolioTimelineValue>[] {
  return snapshots.flatMap((snapshot) => {
    const projectEntry = projectTimelineEntry(snapshot.project);
    const project: TimelineProjection<PortfolioTimelineValue> = {
      ...projectEntry,
      value: { kind: 'project', project: snapshot.project, snapshot },
    };
    const milestones = snapshot.milestones.map((note) => {
      const entry = workNoteTimelineEntry(note);
      return {
        ...entry,
        value: {
          kind: 'milestone' as const,
          note,
          projectPath: snapshot.project.path,
          projectName: snapshot.project.name,
        },
        detail: `Milestone · ${snapshot.project.name}`,
      } satisfies TimelineProjection<PortfolioTimelineValue>;
    });
    return [project, ...milestones];
  });
}

export function workNoteTimelineItem(note: WorkNoteSnapshot): TimelineItem {
  const key = `work-note:${note.path}`;
  if (note.range.issue) return { kind: 'invalid', key, reason: note.range.issue };
  const { start, end } = note.range;
  if (start && end) return { kind: 'range', key, startMs: start.instantMs, endMs: end.instantMs };
  if (start) return { kind: 'point', key, atMs: start.instantMs, role: 'start' };
  if (end) return { kind: 'point', key, atMs: end.instantMs, role: 'end' };
  if (note.kind === 'milestone' && note.updated !== undefined) {
    const milestone = parseProjectDate(note.updated);
    return milestone
      ? { kind: 'point', key, atMs: milestone.instantMs, role: 'milestone' }
      : { kind: 'invalid', key, reason: 'invalid-milestone' };
  }
  return { kind: 'undated', key };
}

export function workNoteTimelineEntry(
  note: WorkNoteSnapshot,
): TimelineProjection<WorkNoteSnapshot> {
  return {
    value: note,
    label: (note.path.split('/').pop() ?? note.path).replace(/\.md$/u, ''),
    detail: note.kind === 'milestone' ? 'Milestone' : 'Work Note',
    item: workNoteTimelineItem(note),
    dateByRole: {
      ...(note.range.start && { start: note.range.start.raw }),
      ...(note.range.end && { end: note.range.end.raw }),
      ...(note.kind === 'milestone' && note.updated && { milestone: note.updated }),
    },
  };
}

function parsedTaskDate(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseProjectDate(value)?.instantMs;
}

export function taskTimelineItem(task: TaskSnapshot): TimelineItem {
  const key = `task:${task.source.filePath}:${String(task.source.line)}`;
  const { start, scheduled, due } = task.planning;
  if (start !== undefined && due !== undefined) {
    const startMs = parsedTaskDate(start);
    const endMs = parsedTaskDate(due);
    if (startMs === undefined) return { kind: 'invalid', key, reason: 'invalid-start' };
    if (endMs === undefined) return { kind: 'invalid', key, reason: 'invalid-due' };
    if (startMs > endMs) return { kind: 'invalid', key, reason: 'reversed' };
    return { kind: 'range', key, startMs, endMs };
  }
  if (scheduled !== undefined) {
    const atMs = parsedTaskDate(scheduled);
    return atMs === undefined
      ? { kind: 'invalid', key, reason: 'invalid-scheduled' }
      : { kind: 'point', key, atMs, role: 'scheduled' };
  }
  if (due !== undefined) {
    const atMs = parsedTaskDate(due);
    return atMs === undefined
      ? { kind: 'invalid', key, reason: 'invalid-due' }
      : { kind: 'point', key, atMs, role: 'due' };
  }
  if (start !== undefined && parsedTaskDate(start) === undefined) {
    return { kind: 'invalid', key, reason: 'invalid-start' };
  }
  return { kind: 'undated', key };
}

export function taskTimelineEntry(task: TaskSnapshot): TimelineProjection<TaskSnapshot> {
  return {
    value: task,
    label: task.title,
    detail: task.source.filePath,
    item: taskTimelineItem(task),
    dateByRole: {
      ...(task.planning.start && { start: task.planning.start }),
      ...(task.planning.scheduled && { scheduled: task.planning.scheduled }),
      ...(task.planning.due && { due: task.planning.due }),
      ...(task.planning.due && task.planning.start && { end: task.planning.due }),
    },
  };
}
