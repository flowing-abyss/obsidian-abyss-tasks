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
import {
  calendarPatchCommand,
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
  readonly queries: Pick<TaskQueryApi, 'list'>;
}

type ExecutableCommand = Parameters<TaskApplicationApi['execute']>[0];

function taskFromDragData(
  queries: Pick<TaskQueryApi, 'list'>,
  dragData: string,
): TaskSnapshot | undefined {
  const [filePath, lineText] = dragData.split(':::');
  const line = Number.parseInt(lineText ?? '', 10);
  if (filePath === undefined || filePath === '' || !Number.isInteger(line)) return undefined;
  return [...queries.list({ filePath })].find((task) => task.source.line === line);
}

function rescheduleCommand(task: TaskSnapshot, date: LocalDate): ExecutableCommand {
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
): ExecutableCommand {
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

/** Turns calendar drag payloads and gestures into task commands. Malformed input is a no-op. */
export class CalendarCommands {
  constructor(private readonly deps_abyssPrivate: CalendarCommandsDependencies) {}

  async rescheduleFromDrag(dragData: string, targetDate: string): Promise<void> {
    const task = taskFromDragData(this.deps_abyssPrivate.queries, dragData);
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null || task == null) return;
    try {
      const date = localDate(targetDate);
      presentTaskCommandResult(await tasks.execute(rescheduleCommand(task, date)));
    } catch {
      // Calendar controls supply the date; malformed gesture input remains a no-op.
    }
  }

  async setTimeFromDrag(dragData: string, date: string, time: string): Promise<void> {
    const task = taskFromDragData(this.deps_abyssPrivate.queries, dragData);
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null || task == null) return;
    try {
      const targetDate = localDate(date);
      const targetTime = localTime(time);
      presentTaskCommandResult(await tasks.execute(timeDropCommand(task, targetDate, targetTime)));
    } catch {
      // A malformed drag payload is ignored without touching the task.
    }
  }

  async commitTimedMove(task: TaskSnapshot, target: TimedDragTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null || ref == null) return;
    try {
      const command: ExecutableCommand =
        target.destination === 'all-day'
          ? { type: 'move-to-all-day', ref, days: target.dayDelta }
          : {
              type: 'move-time-slot',
              ref,
              days: target.dayDelta,
              time: localTime(minutesToTimeString(target.startMinutes)),
            };
      presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Geometry and command validation share the same target; malformed values remain no-ops.
    }
  }

  async commitTimedDuration(task: TaskSnapshot, target: TimedVerticalResizeTarget): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(target.startMinutes)) },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Keep the previous duration if a forged target fails validation.
    }
  }

  async commitSpanMove(task: TaskSnapshot, target: SpanMoveTarget): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarShiftScheduleCommand(task, target.days);
      if (command != null) presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Calendar geometry supplies the target; malformed gesture input remains a no-op.
    }
  }

  async commitTimedBoundary(task: TaskSnapshot, target: TimedBoundaryTarget): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarSpanBoundaryCommand(task, target.boundary, localDate(target.date));
      if (command != null) presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Calendar geometry supplies the target; malformed gesture input remains a no-op.
    }
  }

  async setTime(task: TaskSnapshot, startMinutes: number): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(startMinutes)) },
      });
      if (command == null) return;
      presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Keep the previous valid time when gesture arithmetic is out of range.
    }
  }

  async setDuration(task: TaskSnapshot, minutes: number): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(minutes) },
      });
      if (command == null) return;
      presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Keep the previous valid duration when gesture arithmetic is invalid.
    }
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
    const ref = calendarRootTaskRef(task);
    const tasks = this.deps_abyssPrivate.tasks;
    if (ref == null || tasks == null) return;
    try {
      presentTaskCommandResult(
        await tasks.execute({ type: 'set-span-boundary', ref, boundary, date: localDate(value) }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  // Root commands and child patches preserve the same anchor and validate the final span atomically.
  async extendToSpan(task: TaskSnapshot, due: string): Promise<void> {
    const tasks = this.deps_abyssPrivate.tasks;
    if (tasks == null) return;
    try {
      const command = calendarSpanBoundaryCommand(task, 'create-span', localDate(due));
      if (command != null) presentTaskCommandResult(await tasks.execute(command));
    } catch {
      // Calendar geometry supplies the target; malformed gesture input remains a no-op.
    }
  }
}
