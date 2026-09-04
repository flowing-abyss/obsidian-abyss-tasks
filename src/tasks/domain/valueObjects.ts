import type { DurationMinutes, LocalDate, LocalTime } from './types';

export function localDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match == null) throw new Error('invalid-date');
  const [, years, months, days] = match;
  const year = Number(years);
  const month = Number(months);
  const day = Number(days);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (monthLengths[month - 1] ?? 0)) {
    throw new Error('invalid-date');
  }
  return value as LocalDate;
}

export function localTime(value: string): LocalTime {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new Error('invalid-time');
  return value as LocalTime;
}

export function durationMinutes(value: number): DurationMinutes {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error('invalid-duration');
  }
  return value as DurationMinutes;
}

export function formatDurationMinutes(value: DurationMinutes): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}
