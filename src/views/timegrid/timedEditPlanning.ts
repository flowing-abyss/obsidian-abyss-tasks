import {
  clampDurationToDay,
  daysBetweenLocalDates,
  durationMinutes,
  localDate,
  localTime,
  type TaskCommand,
  type TaskPatch,
  type TaskPlanning,
  type TaskSnapshot,
} from '../../tasks';
import {
  calendarOccurrenceForRender,
  calendarShiftPlanning,
  calendarSourcePatchCommand,
} from '../calendarOccurrences';
import type { TimedDragTarget, TimedVerticalResizeTarget } from './dragGeometry';
import { minutesToTimeString, timeStringToMinutes } from './layout';
import type { TimedBoundaryTarget } from './timedInteractions';

export type TimedCalendarEdit =
  | { readonly type: 'move'; readonly target: TimedDragTarget }
  | { readonly type: 'resize'; readonly target: TimedVerticalResizeTarget }
  | { readonly type: 'boundary'; readonly target: TimedBoundaryTarget };

function scheduleShift(previous: TaskSnapshot, current: TaskSnapshot): number {
  const before = calendarOccurrenceForRender(previous),
    after = calendarOccurrenceForRender(current);
  if (before.kind === 'forecast' || after.kind === 'forecast') return 0;
  return daysBetweenLocalDates(
    before.occupied.kind === 'point' ? before.occupied.date : before.occupied.start,
    after.occupied.kind === 'point' ? after.occupied.date : after.occupied.start,
  );
}

function movedPlanning(
  task: TaskSnapshot,
  target: TimedDragTarget,
  previous: TaskSnapshot,
): TaskPlanning | undefined {
  const occurrence = calendarOccurrenceForRender(task);
  if (!Number.isSafeInteger(target.dayDelta)) return undefined;
  let planning = task.planning;
  if (occurrence.kind === 'forecast') {
    if (target.dayDelta !== 0 || target.destination !== 'time-grid') return undefined;
  } else {
    const shifted = calendarShiftPlanning(
      planning,
      target.dayDelta - scheduleShift(previous, task),
      occurrence.occupied,
    );
    if (shifted === undefined) return undefined;
    planning = shifted;
  }
  const result = { ...planning };
  if (target.destination === 'all-day') {
    delete result.time;
    delete result.duration;
  } else result.time = localTime(minutesToTimeString(target.startMinutes));
  return result;
}

function resizedPlanning(task: TaskSnapshot, target: TimedVerticalResizeTarget): TaskPlanning {
  const currentStart = timeStringToMinutes(task.planning.time ?? '00:00');
  const currentEnd = Math.min(1440, currentStart + (task.planning.duration ?? 60));
  const start =
    target.edge === 'end'
      ? currentStart
      : Math.max(0, Math.min(target.startMinutes, currentEnd - 15));
  const end =
    target.edge === 'start' ? currentEnd : Math.min(1440, Math.max(target.endMinutes, start + 15));
  return {
    ...task.planning,
    time: localTime(minutesToTimeString(start)),
    duration: durationMinutes(end - start),
  };
}

function boundaryPlanning(
  task: TaskSnapshot,
  target: TimedBoundaryTarget,
): TaskPlanning | undefined {
  if (calendarOccurrenceForRender(task).kind === 'forecast') return undefined;
  const planning = task.planning;
  const date = localDate(target.date);
  if (target.boundary !== 'create-span') return { ...planning, [target.boundary]: date };
  const start = planning.start ?? planning.scheduled ?? planning.due;
  return start === undefined ? undefined : { ...planning, start, due: date };
}

export function timedEditPlanning(
  task: TaskSnapshot,
  edit: TimedCalendarEdit,
  previous = task,
): TaskPlanning | undefined {
  if (edit.type === 'boundary') return boundaryPlanning(task, edit.target);
  const planning =
    edit.type === 'move'
      ? movedPlanning(task, edit.target, previous)
      : resizedPlanning(task, edit.target);
  if (planning?.duration === undefined) return planning;
  return { ...planning, duration: clampDurationToDay(planning.time, planning.duration) };
}

/** Only planning fields changed by this gesture form its write/proof witness. */
export function timedEditCommand(
  task: TaskSnapshot,
  edit: TimedCalendarEdit,
  previous = task,
): TaskCommand | undefined {
  const planning = timedEditPlanning(task, edit, previous);
  if (planning === undefined) return undefined;
  const occurrence = calendarOccurrenceForRender(task);
  const patch: TaskPatch = {};
  for (const key of ['start', 'scheduled', 'due', 'time', 'duration'] as const) {
    if (planning[key] === task.planning[key]) continue;
    const value = planning[key];
    Object.assign(patch, {
      [key]: value === undefined ? { type: 'clear' } : { type: 'set', value },
    });
  }
  return calendarSourcePatchCommand(occurrence.source, patch);
}
