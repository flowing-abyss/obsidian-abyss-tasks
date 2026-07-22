import type { LocalDate } from './types';
import { localDate } from './validation';

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function daysBeforeYear(year: number): number {
  return (
    year * 365 +
    Math.floor((year + 3) / 4) -
    Math.floor((year + 99) / 100) +
    Math.floor((year + 399) / 400)
  );
}

function ordinal(value: LocalDate): number {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  let result = daysBeforeYear(year) + day - 1;
  for (let candidate = 1; candidate < month; candidate++) {
    result += daysInMonth(year, candidate);
  }
  return result;
}

function localDateFromOrdinal(value: number): LocalDate {
  let low = 0;
  let high = 10_000;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (daysBeforeYear(middle) <= value) low = middle;
    else high = middle;
  }

  const year = low;
  let dayOfYear = value - daysBeforeYear(year);
  let month = 1;
  while (dayOfYear >= daysInMonth(year, month)) {
    dayOfYear -= daysInMonth(year, month);
    month++;
  }
  const day = dayOfYear + 1;
  return localDate(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

export function shiftLocalDate(value: LocalDate, days: number): LocalDate | undefined {
  if (!Number.isSafeInteger(days)) return undefined;
  const shifted = ordinal(value) + days;
  if (shifted < 0 || shifted >= daysBeforeYear(10_000)) return undefined;
  return localDateFromOrdinal(shifted);
}

export function daysBetweenLocalDates(from: LocalDate, to: LocalDate): number {
  return ordinal(to) - ordinal(from);
}
