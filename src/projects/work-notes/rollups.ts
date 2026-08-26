import type { ProjectStatus } from '../../settings/types';
import type { ProjectLifecycleBehavior } from '../lifecycle';
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
  return (note.statusId && behaviorByStatusId(statuses).get(note.statusId)) || 'regular';
}

function countLifecycle(
  notes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
): WorkNoteRollup {
  const behaviors = behaviorByStatusId(statuses);
  let active = 0;
  let completed = 0;
  let dropped = 0;
  for (const note of notes) {
    const behavior = (note.statusId && behaviors.get(note.statusId)) || 'regular';
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
): ReadonlyMap<string, MilestoneRollup> {
  const milestones = notes.filter(({ kind }) => kind === 'milestone');
  const result = new Map<string, MilestoneRollup>();
  for (const milestone of milestones) {
    const members = notes.filter(
      (note) =>
        note.kind === 'ordinary' &&
        note.projectPath === milestone.projectPath &&
        note.milestonePath === milestone.path &&
        !note.diagnostics.some(({ type }) => type === 'multiple-milestones'),
    );
    const rollup = countLifecycle(members, statuses);
    const denominator = rollup.active + rollup.completed;
    result.set(milestone.path, {
      ...rollup,
      progress: denominator === 0 ? null : rollup.completed / denominator,
    });
  }
  return result;
}
