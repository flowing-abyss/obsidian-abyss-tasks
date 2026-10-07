import type { TaskNodeDragPayload } from '../app/AppState';
import type { SubtaskSnapshot, TaskSnapshot } from '../tasks';
import { taskSelectionPath } from '../ui/taskSelection';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarOccurrence,
} from './calendarOccurrences';

const CALENDAR_NATIVE_PREFIX = 'abyss-calendar:';
export type CalendarNativeDragStart = (
  task: TaskSnapshot,
  source: HTMLElement,
) => string | undefined;

type Materialized = Extract<CalendarOccurrence, { kind: 'materialized' }>;

function nativePayload(occurrence: Materialized): string {
  return (
    CALENDAR_NATIVE_PREFIX + JSON.stringify([occurrence.key, occurrence.source.root.ref.revision])
  );
}

export function isCalendarNativeDrag(serialized: string): boolean {
  return serialized.startsWith(CALENDAR_NATIVE_PREFIX);
}

/** Only the registered materialized occurrence can start a calendar-authoritative native drag. */
export function calendarNativeDragPayload(task: TaskSnapshot): TaskNodeDragPayload | undefined {
  const occurrence = calendarOccurrenceForTask(task);
  if (occurrence?.kind !== 'materialized') return undefined;
  const { root, node, target } = occurrence.source;
  const stack = taskSelectionPath(root, node);
  if (stack === undefined) return undefined;
  return {
    source: 'center-card',
    task: {
      root,
      node,
      target,
      path: stack.filter((item): item is SubtaskSnapshot => !('source' in item)),
    },
    calendar: { occupied: occurrence.occupied, nativePayload: nativePayload(occurrence) },
  };
}

function sameOccupied(left: Materialized['occupied'], right: Materialized['occupied']): boolean {
  if (left.kind === 'interval')
    return right.kind === 'interval' && left.start === right.start && left.due === right.due;
  return (
    right.kind === 'point' &&
    left.date === right.date &&
    left.roles.length === right.roles.length &&
    left.roles.every((role, index) => role === right.roles[index])
  );
}

/** Captured AppState authority is checked before any async work; marked retired drags never rebind. */
export function calendarTaskFromNativeDrag(
  serialized: string,
  payload: TaskNodeDragPayload | null,
): TaskSnapshot | undefined {
  if (payload?.source !== 'center-card' || payload.calendar?.nativePayload !== serialized)
    return undefined;
  const { occupied } = payload.calendar;
  const from = occupied.kind === 'point' ? occupied.date : occupied.start;
  const to = occupied.kind === 'point' ? occupied.date : occupied.due;
  const { root, node, target } = payload.task;
  const projection = projectCalendarOccurrences(
    { materialized: [{ root, node, target }], recurringSources: [] },
    { from, to },
    { removeScheduledDate: false },
  );
  const occurrence = projection.occurrences.find(
    (value) =>
      value.kind === 'materialized' &&
      nativePayload(value) === serialized &&
      sameOccupied(value.occupied, occupied),
  );
  return occurrence === undefined ? undefined : taskSnapshotForCalendarOccurrence(occurrence);
}

/** Existing native DOM owner; AppState lifecycle cleanup is installed by the controller callback. */
export function attachCalendarNativeDrag(
  source: HTMLElement,
  task: TaskSnapshot,
  onStart: CalendarNativeDragStart | undefined,
): void {
  const target = calendarMutationTarget(task);
  if (target === undefined || (target.type === 'subtask' && onStart === undefined)) return;
  source.setAttribute('draggable', 'true');
  source.addEventListener('dragstart', (event) => {
    const serialized =
      onStart === undefined
        ? `${task.source.filePath}:::${task.source.line}`
        : onStart(task, source);
    if (serialized === undefined) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('text/plain', serialized);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
    source.addClass('is-dragging');
  });
  source.addEventListener('dragend', () => {
    source.removeClass('is-dragging');
  });
}
