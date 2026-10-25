import {
  planProjectTimelineEdit,
  type ProjectTimelineEditIntent,
} from '../projects/projectTimelineEdits';
import type { ProjectTimelineRange } from '../projects/projectTimelineModel';
import { localDate, type TaskPatch, type TaskPlanning } from '../tasks';

export interface TaskTimelineDates {
  readonly range: ProjectTimelineRange;
  readonly scheduled?: string;
}
function taskRange({ start, due }: TaskPlanning): ProjectTimelineRange {
  if (start !== undefined && due !== undefined) {
    if (start > due) return { kind: 'malformed', start, end: due };
    return { kind: 'closed', startDay: start, endDay: due };
  }
  if (start !== undefined) return { kind: 'open-end', startDay: start };
  if (due !== undefined) return { kind: 'open-start', endDay: due };
  return { kind: 'unscheduled' };
}
export function taskTimelineDates(planning: TaskPlanning): TaskTimelineDates {
  return {
    range: taskRange(planning),
    ...(planning.scheduled === undefined ? {} : { scheduled: planning.scheduled }),
  };
}
export type TaskTimelineEditPlan =
  | { readonly kind: 'ready'; readonly range: ProjectTimelineRange; readonly patch: TaskPatch }
  | { readonly kind: 'rejected'; readonly reason: string };

function plannedPatch(
  before: TaskPlanning,
  after: TaskPlanning,
  part: 'range' | 'scheduled',
): TaskPatch {
  if (part === 'scheduled')
    return after.start === undefined || after.start === before.scheduled
      ? {}
      : { scheduled: { type: 'set', value: after.start } };
  return {
    ...(after.start === undefined || after.start === before.start
      ? {}
      : { start: { type: 'set', value: after.start } }),
    ...(after.due === undefined || after.due === before.due
      ? {}
      : { due: { type: 'set', value: after.due } }),
  };
}
function sourceRange(planning: TaskPlanning, part: 'range' | 'scheduled'): ProjectTimelineRange {
  if (part === 'range') return taskRange(planning);
  return planning.scheduled === undefined
    ? { kind: 'unscheduled' }
    : { kind: 'open-end', startDay: planning.scheduled };
}
/** The same endpoint policy as Projects, with only canonical task date fields in its patch. */
export function planTaskTimelineEdit(
  planning: TaskPlanning,
  intent: ProjectTimelineEditIntent,
  part: 'range' | 'scheduled' = 'range',
): TaskTimelineEditPlan {
  const source = sourceRange(planning, part);
  if (source.kind === 'malformed')
    return {
      kind: 'rejected',
      reason: 'Start is after Due. Edit the task dates before moving this interval.',
    };
  if (part === 'scheduled' && (intent.type !== 'move' || planning.scheduled === undefined))
    return { kind: 'rejected', reason: 'Choose a Scheduled date before moving its marker.' };
  const plan = planProjectTimelineEdit(source, intent);
  if (plan.kind === 'rejected') return plan;
  const after: TaskPlanning = {
    ...(plan.startDay === undefined ? {} : { start: localDate(plan.startDay) }),
    ...(plan.endDay === undefined ? {} : { due: localDate(plan.endDay) }),
  };
  return { kind: 'ready', range: taskRange(after), patch: plannedPatch(planning, after, part) };
}
