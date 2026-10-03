import type { DurationMinutes, LocalTime } from './types';
import { durationMinutes } from './validation';

/** A task block fits one day, or the remaining day when its start is known. */
export function clampDurationToDay(
  time: LocalTime | undefined,
  duration: DurationMinutes,
): DurationMinutes {
  const [hours = 0, minutes = 0] = (time ?? '00:00').split(':').map(Number);
  return durationMinutes(Math.min(duration, 1440 - hours * 60 - minutes));
}
