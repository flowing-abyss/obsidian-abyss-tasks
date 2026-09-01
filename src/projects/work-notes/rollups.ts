import type { ProjectStatus } from '../../settings/types';
import type { TaskSnapshot } from '../../tasks';
import { resolveSemanticProjectStatus, type ProjectLifecycleBehavior } from '../lifecycle';
import type { WorkNoteSnapshot } from './types';

export interface WorkNoteRollup {
  readonly active: number;
  readonly completed: number;
  readonly dropped: number;
}

export interface MilestoneRollup extends WorkNoteRollup {
  readonly progress: number | null;
}

function behaviorByStatusId(
  statuses: readonly ProjectStatus[],
): ReadonlyMap<string, ProjectLifecycleBehavior> {
  return new Map(statuses.map(({ id, behavior }) => [id, behavior]));
}

export function workNoteLifecycleBehavior(
  note: WorkNoteSnapshot,
  statuses: readonly ProjectStatus[],
): ProjectLifecycleBehavior {
  const direct = note.statusId && behaviorByStatusId(statuses).get(note.statusId);
  if (direct) return direct;
  const semantic = note.rawStatus
    ? resolveSemanticProjectStatus(statuses, note.rawStatus)
    : { type: 'unmatched' as const };
  return semantic.type === 'unique' ? semantic.status.behavior : 'regular';
}

function countLifecycle(
  notes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
): WorkNoteRollup {
  let active = 0;
  let completed = 0;
  let dropped = 0;
  for (const note of notes) {
    const behavior = workNoteLifecycleBehavior(note, statuses);
    if (behavior === 'dropped') dropped += 1;
    else if (behavior === 'completed' || behavior === 'published') completed += 1;
    else active += 1;
  }
  return { active, completed, dropped };
}

export function computeWorkNoteRollup(
  notes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
): WorkNoteRollup {
  return countLifecycle(
    notes.filter(({ kind }) => kind === 'ordinary'),
    statuses,
  );
}

export function computeMilestoneRollups(
  notes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
  tasks: readonly TaskSnapshot[] = [],
): ReadonlyMap<string, MilestoneRollup> {
  const milestones = notes.filter(({ kind }) => kind === 'milestone');
  const result = new Map<string, MilestoneRollup>();
  for (const milestone of milestones) {
    result.set(milestone.path, computeMilestoneRollup(milestone, notes, statuses, tasks));
  }
  return result;
}

export function computeMilestoneRollup(
  milestone: WorkNoteSnapshot,
  projectNotes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
  tasks: readonly TaskSnapshot[] = [],
): MilestoneRollup {
  const members = projectNotes.filter(
    (note) =>
      note.kind === 'ordinary' &&
      note.projectPath === milestone.projectPath &&
      note.milestonePath === milestone.path &&
      !note.diagnostics.some(({ type }) => type === 'multiple-milestones'),
  );
  const rollup = countLifecycle(members, statuses);
  const memberPaths = new Set([milestone.path, ...members.map(({ path }) => path)]);
  const seenTasks = new Set<string>();
  let active = rollup.active;
  let completed = rollup.completed;
  let dropped = rollup.dropped;
  for (const task of tasks) {
    if (!memberPaths.has(task.ref.filePath)) continue;
    const key = `${task.ref.filePath}\u0000${task.ref.line}\u0000${task.ref.revision}`;
    if (seenTasks.has(key)) continue;
    seenTasks.add(key);
    if (task.status === 'done') completed += 1;
    else if (task.status === 'cancelled') dropped += 1;
    else active += 1;
  }
  const denominator = active + completed;
  return {
    active,
    completed,
    dropped,
    progress: denominator === 0 ? null : completed / denominator,
  };
}
