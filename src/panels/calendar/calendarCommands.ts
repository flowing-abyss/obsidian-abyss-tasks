import type { TaskNodeDragPayload } from '../../app/AppState';
import {
  daysBetweenLocalDates,
  durationMinutes,
  localDate,
  localTime,
  type LocalDate,
  type TaskApplicationApi,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../../tasks';
import { presentTaskCommandResult } from '../../ui/taskCommandResult';
import { calendarTaskFromNativeDrag, isCalendarNativeDrag } from '../../views/calendarNativeDrag';
import {
  calendarOccurrenceForRender,
  calendarPatchCommand,
  calendarPointPatchCommand,
  calendarRootTaskRef,
  calendarShiftScheduleCommand,
  calendarSpanBoundaryCommand,
} from '../../views/calendarOccurrences';
import type { SpanMoveTarget } from '../../views/spanInteractions';
import type { TimedDragTarget, TimedVerticalResizeTarget } from '../../views/timegrid/dragGeometry';
import { minutesToTimeString } from '../../views/timegrid/layout';
import type { TimedBoundaryTarget } from '../../views/timegrid/timedInteractions';

export interface CalendarCommandsDependencies {
  readonly tasks: TaskApplicationApi | undefined;
  readonly nativeDrag?: (() => TaskNodeDragPayload | null) | undefined;
  readonly queries: Pick<TaskQueryApi, 'list'>;
}

type ExecutableCommand = Parameters<TaskApplicationApi['execute']>[0];

function taskFromDragData(
  deps: CalendarCommandsDependencies,
  dragData: string,
): TaskSnapshot | undefined {
  if (isCalendarNativeDrag(dragData))
    return calendarTaskFromNativeDrag(dragData, deps.nativeDrag?.() ?? null);
  const [filePath, lineText] = dragData.split(':::');
  const line = Number.parseInt(lineText ?? '', 10);
  if (filePath === undefined || filePath === '' || !Number.isInteger(line)) return undefined;
  return [...deps.queries.list({ filePath })].find((task) => task.source.line === line);
}

function rescheduleCommand(task: TaskSnapshot, date: LocalDate): ExecutableCommand | undefined {
  const point = calendarPointPatchCommand(
    task,
    date,
    task.planning.time === undefined ? undefined : { type: 'clear' },
  );
  if (point !== undefined) return clearPointDurationForAllDay(task, point);
  if (calendarRootTaskRef(task) === undefined)
    return childNativeIntervalCommand(task, date, { type: 'clear' });
  if (task.planning.time == null) return { type: 'reschedule', ref: task.ref, date };
  const anchor =
    task.planning.start != null && task.planning.due != null
      ? task.planning.due
      : (task.planning.scheduled ?? task.planning.due);
  if (anchor == null) return { type: 'convert-to-all-day', ref: task.ref, date };
  return { type: 'move-to-all-day', ref: task.ref, days: daysBetweenLocalDates(anchor, date) };
}

function timeDropCommand(
  task: TaskSnapshot,
  date: LocalDate,
  time: ReturnType<typeof localTime>,
): ExecutableCommand | undefined {
  const point = calendarPointPatchCommand(task, date, { type: 'set', value: time });
  if (point !== undefined) return point;
  if (calendarRootTaskRef(task) === undefined)
    return childNativeIntervalCommand(task, date, { type: 'set', value: time });
  if (task.planning.start != null && task.planning.due != null) {
    return {
      type: 'move-time-slot',
      ref: task.ref,
      days: daysBetweenLocalDates(task.planning.due, date),
      time,
    };
  }
  return { type: 'set-time-slot', ref: task.ref, date, time };
}

function timedMoveCommand(
  task: TaskSnapshot,
  target: TimedDragTarget,
): ExecutableCommand | undefined {
  const occurrence = calendarOccurrenceForRender(task);
  if (occurrence.kind === 'forecast' || !Number.isSafeInteger(target.dayDelta)) return undefined;
  const time =
    target.destination === 'all-day'
      ? { type: 'clear' as const }
      : { type: 'set' as const, value: localTime(minutesToTimeString(target.startMinutes)) };
  if (occurrence.occupied.kind === 'point') {
    const command = calendarPointPatchCommand(task, target.date, time);
    return time.type === 'clear' ? clearPointDurationForAllDay(task, command) : command;
  }
  const ref = calendarRootTaskRef(task);
  if (ref !== undefined)
    return time.type === 'clear'
      ? { type: 'move-to-all-day', ref, days: target.dayDelta }
      : { type: 'move-time-slot', ref, days: target.dayDelta, time: time.value };
  return childTimedMoveCommand(task, target.dayDelta, time);
}

function clearPointDurationForAllDay(
  task: TaskSnapshot,
  command: ExecutableCommand | undefined,
): ExecutableCommand | undefined {
  if (task.planning.time === undefined || command?.type !== 'patch') return command;
  return { ...command, patch: { ...command.patch, duration: { type: 'clear' } } };
}

function childTimedMoveCommand(
  task: TaskSnapshot,
  days: number,
  time: NonNullable<Extract<ExecutableCommand, { type: 'patch' }>['patch']['time']>,
): ExecutableCommand | undefined {
  const shifted = calendarShiftScheduleCommand(task, days);
  if (days !== 0 && shifted?.type !== 'patch') return undefined;
  return calendarPatchCommand(task, {
    ...(shifted?.type === 'patch' ? shifted.patch : {}),
    time,
    ...(time.type === 'clear' &&
      task.planning.time !== undefined && { duration: { type: 'clear' } }),
  });
}

function childNativeIntervalCommand(
  task: TaskSnapshot,
  date: LocalDate,
  time: NonNullable<Extract<ExecutableCommand, { type: 'patch' }>['patch']['time']>,
): ExecutableCommand | undefined {
  const occurrence = calendarOccurrenceForRender(task);
  if (occurrence.kind !== 'materialized' || occurrence.occupied.kind !== 'interval')
    return undefined;
  return childTimedMoveCommand(task, daysBetweenLocalDates(occurrence.occupied.due, date), time);
}

/** Turns calendar drag payloads and gestures into task commands. Malformed input is a no-op. */
export class CalendarCommands {
  constructor(private readonly deps_abyssPrivate: CalendarCommandsDependencies) {}

  private async execute_abyssPrivate(build: () => ExecutableCommand | undefined): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks === undefined) return;
    let command: ExecutableCommand | undefined;
    try {
      command = build();
    } catch (error) {
      if (
        error instanceof Error &&
        ['invalid-date', 'invalid-time', 'invalid-duration'].includes(error.message)
      )
        return;
      throw error;
    }
    if (command !== undefined) presentTaskCommandResult(await tasks.execute(command));
  }

  async rescheduleFromDrag(dragData: string, targetDate: string): Promise<void> {
    const task = taskFromDragData(this.deps_abyssPrivate, dragData);
    if (task !== undefined)
      await this.execute_abyssPrivate(() => rescheduleCommand(task, localDate(targetDate)));
  }

  async setTimeFromDrag(dragData: string, date: string, time: string): Promise<void> {
    const task = taskFromDragData(this.deps_abyssPrivate, dragData);
    if (task !== undefined)
      await this.execute_abyssPrivate(() =>
        timeDropCommand(task, localDate(date), localTime(time)),
      );
  }

  async commitTimedMove(task: TaskSnapshot, target: TimedDragTarget): Promise<void> {
    await this.execute_abyssPrivate(() => timedMoveCommand(task, target));
  }

  async commitTimedDuration(task: TaskSnapshot, target: TimedVerticalResizeTarget): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(target.startMinutes)) },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      }),
    );
  }

  async commitSpanMove(task: TaskSnapshot, target: SpanMoveTarget): Promise<void> {
    await this.execute_abyssPrivate(() => calendarShiftScheduleCommand(task, target.days));
  }

  async commitTimedBoundary(task: TaskSnapshot, target: TimedBoundaryTarget): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarSpanBoundaryCommand(task, target.boundary, localDate(target.date)),
    );
  }

  async setTime(task: TaskSnapshot, startMinutes: number): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(startMinutes)) },
      }),
    );
  }

  async setDuration(task: TaskSnapshot, minutes: number): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(minutes) },
      }),
    );
  }

  async setStart(task: TaskSnapshot, start: string): Promise<void> {
    await this.setSpanBoundary_abyssPrivate(task, 'start', start);
  }

  async setDue(task: TaskSnapshot, due: string): Promise<void> {
    await this.setSpanBoundary_abyssPrivate(task, 'due', due);
  }

  private async setSpanBoundary_abyssPrivate(
    task: TaskSnapshot,
    boundary: 'start' | 'due',
    value: string,
  ): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarSpanBoundaryCommand(task, boundary, localDate(value)),
    );
  }

  // Root commands and child patches preserve the same anchor and validate the final span atomically.
  async extendToSpan(task: TaskSnapshot, due: string): Promise<void> {
    await this.execute_abyssPrivate(() =>
      calendarSpanBoundaryCommand(task, 'create-span', localDate(due)),
    );
  }
}
