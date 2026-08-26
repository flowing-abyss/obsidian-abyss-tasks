import type { ProjectDateValue, ProjectRange } from './types';

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ATOM_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parseProjectDate(raw: unknown): ProjectDateValue | undefined {
  if (typeof raw !== 'string') return undefined;
  const local = LOCAL_DATE_RE.exec(raw);
  if (local) {
    const year = Number(local[1]);
    const month = Number(local[2]);
    const day = Number(local[3]);
    if (!validDate(year, month, day)) return undefined;
    return {
      raw,
      precision: 'date',
      instantMs: Date.parse(`${raw}T00:00:00.000Z`),
    };
  }

  const atom = ATOM_DATETIME_RE.exec(raw);
  if (!atom) return undefined;
  const year = Number(atom[1]);
  const month = Number(atom[2]);
  const day = Number(atom[3]);
  const hour = Number(atom[4]);
  const minute = Number(atom[5]);
  const second = Number(atom[6]);
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }

  let offsetMinutes = 0;
  if (atom[7] !== 'Z') {
    const offsetHour = Number(atom[9]);
    const offsetMinute = Number(atom[10]);
    if (
      offsetHour > 23 ||
      offsetMinute > 59 ||
      (atom[8] === '-' && offsetHour === 0 && offsetMinute === 0)
    ) {
      return undefined;
    }
    offsetMinutes = (atom[8] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const instantMs = Date.parse(raw);
  if (!Number.isFinite(instantMs)) return undefined;
  return { raw, precision: 'datetime', instantMs, offsetMinutes };
}

function missingEndpoint(raw: unknown): boolean {
  return raw === undefined || raw === null;
}

export function parseProjectRange(startRaw: unknown, endRaw: unknown): ProjectRange {
  const startMissing = missingEndpoint(startRaw);
  const endMissing = missingEndpoint(endRaw);
  const start = startMissing ? undefined : parseProjectDate(startRaw);
  const end = endMissing ? undefined : parseProjectDate(endRaw);

  if (!startMissing && !start) return { ...(end && { end }), issue: 'invalid-start' };
  if (!endMissing && !end) return { ...(start && { start }), issue: 'invalid-end' };
  if (start && end && start.instantMs > end.instantMs) {
    return { start, end, issue: 'reversed' };
  }
  return { ...(start && { start }), ...(end && { end }) };
}
