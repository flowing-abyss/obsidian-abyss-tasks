import type { LocalDate } from './types';
import { localDate } from './validation';

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function shiftLocalDate(value: LocalDate, days: -1 | 1): LocalDate | undefined {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  let nextYear = year;
  let nextMonth = month;
  let nextDay = day + days;
  if (nextDay === 0) {
    if (month === 1 && year === 0) return undefined;
    nextMonth = month === 1 ? 12 : month - 1;
    nextYear = month === 1 ? year - 1 : year;
    nextDay = daysInMonth(nextYear, nextMonth);
  } else if (nextDay > daysInMonth(year, month)) {
    if (month === 12 && year === 9999) return undefined;
    nextMonth = month === 12 ? 1 : month + 1;
    nextYear = month === 12 ? year + 1 : year;
    nextDay = 1;
  }
  return localDate(
    `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`,
  );
}
