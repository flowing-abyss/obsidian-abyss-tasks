/** A validated Atom/RFC3339 timestamp produced by the application clock. */
export type AtomDateTime = string & { readonly __atomDateTime: unique symbol };

import type { ClockReading } from './clock';
import type { LocalDate } from './types';
import { localDate } from './validation';

export type CommentTimestamp =
  | { readonly precision: 'day'; readonly value: LocalDate; readonly raw: string }
  | {
      readonly precision: 'instant';
      readonly atom: AtomDateTime;
      readonly epochMs: number;
      readonly raw: string;
    };

export interface ParsedCommentTimestampPrefix {
  readonly prefix: string;
  readonly timestamp?: CommentTimestamp;
  readonly text: string;
}

const LIST_PREFIX_RE = /^([\s>]*- )(.+)$/u;
// Fixed-width date prefix is bounded; the lint heuristic cannot infer that here.
// eslint-disable-next-line sonarjs/super-linear-regex
const DAY_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}):([ \t]*)(.*)$/u;
const INSTANT_PREFIX_RE =
  // Fixed-width timestamp grammar is bounded; the lint heuristic cannot infer that here.
  // eslint-disable-next-line sonarjs/super-linear-regex
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-]\d{2}:\d{2}):([ \t]*)(.*)$/u;

export function atomDateTime(value: string): AtomDateTime {
  return value as AtomDateTime;
}

/** Proleptic-Gregorian civil date to days since 1970-01-01, inverse of clock.ts. */
export function epochDayForLocalDate(value: LocalDate): number {
  const [rawYear, month, day] = value.split('-').map(Number) as [number, number, number];
  const year = rawYear - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function epochForInstant(match: RegExpExecArray): number | undefined {
  const dateRaw = match[1];
  const hourRaw = match[2];
  const minuteRaw = match[3];
  const secondRaw = match[4];
  const fractionRaw = match[5];
  const offsetRaw = match[6];
  if (!dateRaw || !hourRaw || !minuteRaw || !secondRaw || !offsetRaw) return undefined;

  let date: LocalDate;
  try {
    date = localDate(dateRaw);
  } catch {
    return undefined;
  }

  let offsetMinutes = 0;
  if (offsetRaw !== 'Z') {
    const sign = offsetRaw[0] === '-' ? -1 : 1;
    const offsetHour = Number(offsetRaw.slice(1, 3));
    const offsetMinute = Number(offsetRaw.slice(4, 6));
    if (
      offsetMinute > 59 ||
      offsetHour > 14 ||
      (offsetHour === 14 && offsetMinute !== 0) ||
      (sign < 0 && offsetHour === 0 && offsetMinute === 0)
    ) {
      return undefined;
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const milliseconds = fractionRaw ? Number((fractionRaw.slice(1) + '000').slice(0, 3)) : 0;
  const epochMs =
    epochDayForLocalDate(date) * 86_400_000 +
    Number(hourRaw) * 3_600_000 +
    Number(minuteRaw) * 60_000 +
    Number(secondRaw) * 1000 +
    milliseconds -
    offsetMinutes * 60_000;
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

/** Parse one Markdown comment line while preserving its exact timestamp prefix for later edits. */
export function parseCommentTimestampPrefix(
  line: string,
): ParsedCommentTimestampPrefix | undefined {
  const source = line.endsWith('\r') ? line.slice(0, -1) : line;
  const list = LIST_PREFIX_RE.exec(source);
  if (!list) return undefined;
  const listPrefix = list[1]!;
  const body = list[2]!;

  const instant = INSTANT_PREFIX_RE.exec(body);
  if (instant) {
    const epochMs = epochForInstant(instant);
    if (epochMs !== undefined) {
      const raw = body.slice(0, body.length - instant[8]!.length - instant[7]!.length - 1);
      return {
        prefix: `${listPrefix}${raw}:${instant[7]}`,
        timestamp: { precision: 'instant', atom: atomDateTime(raw), epochMs, raw },
        text: instant[8]!,
      };
    }
  }

  const day = DAY_PREFIX_RE.exec(body);
  if (day) {
    try {
      const value = localDate(day[1]!);
      return {
        prefix: `${listPrefix}${day[1]}:${day[2]}`,
        timestamp: { precision: 'day', value, raw: day[1]! },
        text: day[3]!,
      };
    } catch {
      // Timestamp-shaped invalid input is an undated comment, preserving every character.
    }
  }

  return { prefix: listPrefix, timestamp: undefined, text: body };
}

export function formatNewCommentTimestamp(reading: ClockReading): AtomDateTime {
  return reading.atom;
}
