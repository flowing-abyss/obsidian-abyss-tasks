import { atomDateTime, type AtomDateTime } from './commentTimestamp';
import type { LocalDate } from './types';
import { localDate } from './validation';

export interface ClockReading {
  readonly localDate: LocalDate;
  readonly epochMs: number;
  readonly offsetMinutes: number;
  readonly atom: AtomDateTime;
}

export interface Clock {
  read(): ClockReading;
}

type InstantSource = () => number;
type OffsetSource = (epochMs: number) => number;

function pad(value: number, length = 2): string {
  return Math.abs(value).toString().padStart(length, '0');
}

// Howard Hinnant's civil_from_days algorithm, with day zero at 1970-01-01.
function civilFromDays(daysSinceEpoch: number): readonly [number, number, number] {
  const z = daysSinceEpoch + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return [year, month, day];
}

function reading(epochMs: number, offsetMinutes: number): ClockReading {
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs)) throw new Error('invalid-instant');
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) {
    throw new Error('invalid-offset');
  }
  const localSeconds = Math.floor(epochMs / 1000) + offsetMinutes * 60;
  const days = Math.floor(localSeconds / 86_400);
  const secondsOfDay = localSeconds - days * 86_400;
  const [year, month, day] = civilFromDays(days);
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const offset = Math.abs(offsetMinutes);
  const atom = `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
  return {
    localDate: localDate(date),
    epochMs,
    offsetMinutes,
    atom: atomDateTime(atom),
  };
}

export function clockFrom(epochMs: number, offsetMinutes: number): Clock {
  return { read: () => reading(epochMs, offsetMinutes) };
}

/** Ambient sources are injected by composition code so one read is atomic and testable. */
export function systemClock(instantSource: InstantSource, offsetSource: OffsetSource): Clock {
  return {
    read(): ClockReading {
      const epochMs = instantSource();
      return reading(epochMs, offsetSource(epochMs));
    },
  };
}
