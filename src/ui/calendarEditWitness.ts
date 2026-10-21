import { clampDurationToDay, type TaskCommand, type TaskSnapshot } from '../tasks';
import { calendarShiftPlanning } from '../views/calendarOccurrences';

function patchedValue<T>(
  current: T | undefined,
  update: { readonly type: 'set'; readonly value: T } | { readonly type: 'clear' } | undefined,
): T | undefined {
  if (update === undefined) return current;
  return update.type === 'set' ? update.value : undefined;
}

function timingWitness(
  task: TaskSnapshot,
  command: Extract<TaskCommand, { type: 'patch' }>,
): TaskCommand {
  const { time, duration } = command.patch;
  if (time === undefined && duration === undefined) return command;
  const nextTime = patchedValue(task.planning.time, time);
  const nextDuration = patchedValue(task.planning.duration, duration);
  if (nextDuration === undefined) return command;
  const bounded = clampDurationToDay(nextTime, nextDuration);
  return bounded === nextDuration
    ? command
    : { ...command, patch: { ...command.patch, duration: { type: 'set', value: bounded } } };
}

function shiftedWitness(
  task: TaskSnapshot,
  command: Extract<TaskCommand, { type: 'shift-schedule' }>,
): TaskCommand {
  const planning = calendarShiftPlanning(task.planning, command.days);
  if (planning === undefined) return command;
  const patch: Extract<TaskCommand, { type: 'patch' }>['patch'] = {};
  for (const field of ['start', 'scheduled', 'due'] as const) {
    const value = planning[field];
    if (value !== undefined && value !== task.planning[field])
      Object.assign(patch, { [field]: { type: 'set', value } });
  }
  return { type: 'patch', target: { type: 'task', ref: command.ref }, patch };
}

/** Expected public-command effects, including bounded timing; never inferred from a receipt diff. */
export function calendarEditWitness(task: TaskSnapshot, command: TaskCommand): TaskCommand {
  if (command.type === 'patch') return timingWitness(task, command);
  if (command.type === 'shift-schedule') return shiftedWitness(task, command);
  if (command.type === 'set-span-boundary') {
    return {
      type: 'patch',
      target: { type: 'task', ref: command.ref },
      patch: { [command.boundary]: { type: 'set', value: command.date } },
    };
  }
  if (command.type === 'extend-span') {
    const start = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
    if (start === undefined) return command;
    return {
      type: 'patch',
      target: { type: 'task', ref: command.ref },
      patch: { start: { type: 'set', value: start }, due: { type: 'set', value: command.due } },
    };
  }
  return command;
}
