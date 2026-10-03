import type { DurationMinutes, LocalTime } from './types';
import { durationMinutes } from './validation';

/** The effective duration of a timed task within its starting calendar day. */
export function clampDurationToDay(time: LocalTime, duration: DurationMinutes): DurationMinutes {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return durationMinutes(Math.min(duration, 1440 - hours * 60 - minutes));
}
