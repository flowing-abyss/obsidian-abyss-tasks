import { taskOccupiedDates, type TaskPlanning, type TaskSnapshot } from '../tasks';
import {
  calendarTaskWithPlanning,
  taskSnapshotForCalendarOccurrence,
  type CalendarOccurrence,
} from '../views/calendarOccurrences';
import { taskNodeRef, taskSelectionRefPath, type TaskSelectionNode } from './taskSelection';

function withCanonicalTiming(projected: TaskPlanning, canonical: TaskPlanning): TaskPlanning {
  const dates = { ...projected };
  delete dates.time;
  delete dates.duration;
  return {
    ...dates,
    ...(canonical.time !== undefined && { time: canonical.time }),
    ...(canonical.duration !== undefined && { duration: canonical.duration }),
  };
}

/** Retain the caller's occurrence/date roles while adopting a proved canonical node. */
export function calendarTaskWithOwnedNode(
  occurrence: CalendarOccurrence,
  current: TaskSnapshot,
  node: TaskSelectionNode,
  promote = false,
): TaskSnapshot {
  const planning =
    occurrence.kind === 'forecast'
      ? withCanonicalTiming(occurrence.planning, node.planning)
      : node.planning;
  const display = taskSnapshotForCalendarOccurrence({
    ...occurrence,
    source: { root: current, node, target: taskNodeRef(node) },
    planning,
  });
  return calendarTaskWithPlanning(display, planning, promote ? 'create-span' : undefined);
}

/** Each accepted patch preserves child order and ancestry under the whole-tree proof. */
export function calendarTaskWithOwnedRoot(
  occurrence: CalendarOccurrence,
  owned: { readonly before: TaskSnapshot; readonly current: TaskSnapshot },
): TaskSnapshot | undefined {
  const path = taskSelectionRefPath(owned.before, occurrence.source.target);
  if (path === undefined) return undefined;
  let node: TaskSelectionNode | undefined = owned.current;
  for (let index = 1; index < path.length; index += 1) {
    const parent = path[index - 1];
    const child = path[index];
    if (parent === undefined || child === undefined) return undefined;
    node = node?.subtasks[parent.subtasks.findIndex((candidate) => candidate === child)];
  }
  return node === undefined
    ? undefined
    : calendarTaskWithOwnedNode(
        occurrence,
        owned.current,
        node,
        occurrence.kind === 'materialized' &&
          taskOccupiedDates(occurrence.source.node.planning).kind !== 'interval' &&
          taskOccupiedDates(node.planning).kind === 'interval',
      );
}
