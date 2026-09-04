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
// eslint-disable-next-line sonarjs/super-linear-regex -- fixed-width grammar has bounded backtracking
const DAY_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}):([ \t]*)(.*)$/u;
const INSTANT_PREFIX_RE =
  // Fixed-width timestamp grammar is bounded; the lint heuristic cannot infer that here.
  // eslint-disable-next-line sonarjs/super-linear-regex -- fixed-width grammar has bounded backtracking
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

interface InstantParts {
  readonly dateRaw: string;
  readonly hourRaw: string;
  readonly minuteRaw: string;
  readonly secondRaw: string;
  readonly fractionRaw?: string;
  readonly offsetRaw: string;
}

function requiredMatchValue(match: RegExpExecArray, index: number): string | undefined {
  const value = match[index];
  return value === undefined || value.length === 0 ? undefined : value;
}

function instantParts(match: RegExpExecArray): InstantParts | undefined {
  const dateRaw = match[1];
  const hourRaw = match[2];
  const minuteRaw = match[3];
  const secondRaw = match[4];
  const fractionRaw = match[5];
  const offsetRaw = match[6];
  if (requiredMatchValue(match, 1) === undefined) return undefined;
  if (requiredMatchValue(match, 2) === undefined) return undefined;
  if (requiredMatchValue(match, 3) === undefined) return undefined;
  if (requiredMatchValue(match, 4) === undefined) return undefined;
  if (requiredMatchValue(match, 6) === undefined) return undefined;
  return { dateRaw, hourRaw, minuteRaw, secondRaw, fractionRaw, offsetRaw } as InstantParts;
}

function parseInstantDate(value: string): LocalDate | undefined {
  let date: LocalDate;
  try {
    date = localDate(value);
  } catch {
    return undefined;
  }
  return date;
}

function instantOffsetMinutes(offsetRaw: string): number | undefined {
  if (offsetRaw === 'Z') return 0;
  const sign = offsetRaw[0] === '-' ? -1 : 1;
  const offsetHour = Number(offsetRaw.slice(1, 3));
  const offsetMinute = Number(offsetRaw.slice(4, 6));
  if (offsetMinute > 59 || offsetHour > 14) return undefined;
  if (offsetHour === 14 && offsetMinute !== 0) return undefined;
  if (sign < 0 && offsetHour === 0 && offsetMinute === 0) return undefined;
  return sign * (offsetHour * 60 + offsetMinute);
}

function epochForInstant(match: RegExpExecArray): number | undefined {
  const parts = instantParts(match);
  if (parts === undefined) return undefined;
  const date = parseInstantDate(parts.dateRaw);
  const offsetMinutes = instantOffsetMinutes(parts.offsetRaw);
  if (date === undefined || offsetMinutes === undefined) return undefined;

  const milliseconds =
    parts.fractionRaw === undefined || parts.fractionRaw.length === 0
      ? 0
      : Number(`${parts.fractionRaw.slice(1)}000`.slice(0, 3));
  const epochMs =
    epochDayForLocalDate(date) * 86_400_000 +
    Number(parts.hourRaw) * 3_600_000 +
    Number(parts.minuteRaw) * 60_000 +
    Number(parts.secondRaw) * 1000 +
    milliseconds -
    offsetMinutes * 60_000;
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function parseInstantPrefix(
  listPrefix: string,
  body: string,
): ParsedCommentTimestampPrefix | undefined {
  const instant = INSTANT_PREFIX_RE.exec(body);
  if (instant == null) return undefined;
  const epochMs = epochForInstant(instant);
  const whitespace = instant[7];
  const text = instant[8];
  if (epochMs === undefined || whitespace === undefined || text === undefined) return undefined;
  const raw = body.slice(0, body.length - text.length - whitespace.length - 1);
  return {
    prefix: `${listPrefix}${raw}:${whitespace}`,
    timestamp: { precision: 'instant', atom: atomDateTime(raw), epochMs, raw },
    text,
  };
}

function parseDayPrefix(
  listPrefix: string,
  body: string,
): ParsedCommentTimestampPrefix | undefined {
  const day = DAY_PREFIX_RE.exec(body);
  if (day == null) return undefined;
  const rawDate = day[1];
  const whitespace = day[2];
  const text = day[3];
  if (rawDate === undefined || whitespace === undefined || text === undefined) return undefined;
  try {
    const value = localDate(rawDate);
    return {
      prefix: `${listPrefix}${rawDate}:${whitespace}`,
      timestamp: { precision: 'day', value, raw: rawDate },
      text,
    };
  } catch {
    return undefined;
  }
}

/** Parse one Markdown comment line while preserving its exact timestamp prefix for later edits. */
export function parseCommentTimestampPrefix(
  line: string,
): ParsedCommentTimestampPrefix | undefined {
  const source = line.endsWith('\r') ? line.slice(0, -1) : line;
  const list = LIST_PREFIX_RE.exec(source);
  if (list == null) return undefined;
  const listPrefix = list[1];
  const body = list[2];
  if (listPrefix === undefined || body === undefined) return undefined;
  const timestamped = parseInstantPrefix(listPrefix, body) ?? parseDayPrefix(listPrefix, body);
  if (timestamped !== undefined) return timestamped;
  return { prefix: listPrefix, text: body };
}

export function formatNewCommentTimestamp(reading: ClockReading): AtomDateTime {
  return reading.atom;
}
