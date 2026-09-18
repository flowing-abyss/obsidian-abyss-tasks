import {
  epochDayForLocalDate,
  fractionMilliseconds,
  instantOffsetMinutes,
  localDateOrUndefined,
  type AtomDateTime,
} from './commentTimestamp';
import type { LocalDate } from './types';

/** Minutes east of UTC in force at an instant, same sign as `ClockReading.offsetMinutes`. */
export type OffsetAt = (epochMs: number) => number;

export type TimeEntryIssue = 'invalid-start' | 'invalid-end' | 'end-before-start';

export interface ParsedTimeEntry {
  readonly state: 'running' | 'closed' | 'broken';
  readonly startMs?: number;
  readonly endMs?: number;
  readonly tail?: string;
  readonly issue?: TimeEntryIssue;
}

const ARROW = '→';
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

const LIST_PREFIX_RE = /^[\s>]*- (.+)$/u;
const LEADING_BLANK_RE = /^[ \t]+/u;
const BLANK_ONLY_RE = /^[ \t]*$/u;
/** Groups: 1 date, 2 hour, 3 minute. The date is absent on a time-only end. */
const STAMP_CALENDAR_RE = /^(?:(\d{4}-\d{2}-\d{2})(?:T|[ \t]+))?(\d{1,2}):(\d{2})/u;
/** Groups: 1 second, 2 fraction. Absent on a stamp written to the minute. */
const STAMP_SECONDS_RE = /^:(\d{2})(\.\d+)?/u;
/** Group 1 offset. Absent on a stamp that leaves its zone to the reader. */
const STAMP_OFFSET_RE = /^(Z|[+-]\d{2}:\d{2})/u;
/** Text that opens like a stamp is a failed end rather than free tail text. */
const END_SHAPE_RE = /^(?:\d{1,2}:\d{2}|\d{4}-\d{2})/u;

const ZERO_OFFSET: OffsetAt = () => 0;

/** The written parts of one stamp, before any of them are checked against the calendar or clock. */
interface StampFields {
  readonly date: string | undefined;
  readonly hour: string | undefined;
  readonly minute: string | undefined;
  readonly second: string | undefined;
  readonly fraction: string | undefined;
  readonly offset: string | undefined;
}

interface StampMatch {
  readonly fields: StampFields;
  readonly length: number;
}

/** A stamp whose parts are all in range. The date is absent on a time-only end. */
interface Stamp {
  readonly date: LocalDate | undefined;
  readonly dayMs: number;
  readonly offsetMinutes: number | undefined;
}

interface StartStamp {
  readonly date: LocalDate;
  readonly dayMs: number;
  readonly offsetMinutes: number | undefined;
}

/** The start after offset resolution, so the end can inherit the written or the resolved offset. */
interface ResolvedStart {
  readonly date: LocalDate;
  readonly explicitOffsetMinutes: number | undefined;
  readonly offsetMinutes: number;
}

interface EntryShape {
  readonly start: StampFields;
  readonly rest: string;
}

type EndReading =
  | { readonly kind: 'none'; readonly tail: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'stamp'; readonly stamp: Stamp; readonly tail: string };

function stripLeadingBlanks(value: string): string {
  return value.replace(LEADING_BLANK_RE, '');
}

/**
 * Reads one stamp anchored at the start of `text`. The grammar holds no arrow, so a stamp can never
 * reach past the arrow that separates the start from the end.
 */
function matchStamp(text: string): StampMatch | undefined {
  const calendar = STAMP_CALENDAR_RE.exec(text);
  if (calendar === null) return undefined;
  // The optional precision is read one part at a time rather than as one all-optional pattern, so
  // every branch here is a stamp somebody can actually write instead of a match that cannot fail.
  let length = calendar[0].length;
  const seconds = STAMP_SECONDS_RE.exec(text.slice(length));
  if (seconds !== null) length += seconds[0].length;
  const offset = STAMP_OFFSET_RE.exec(text.slice(length));
  if (offset !== null) length += offset[0].length;
  return {
    fields: {
      date: calendar[1],
      hour: calendar[2],
      minute: calendar[3],
      second: seconds?.[1],
      fraction: seconds?.[2],
      offset: offset?.[1],
    },
    length,
  };
}

/** Milliseconds from local midnight, or undefined when a clock part is out of range. */
function dayMilliseconds(fields: StampFields): number | undefined {
  const { hour: hourRaw, minute: minuteRaw, second: secondRaw } = fields;
  if (hourRaw === undefined || minuteRaw === undefined) return undefined;
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = secondRaw === undefined ? 0 : Number(secondRaw);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return (
    hour * MS_PER_HOUR +
    minute * MS_PER_MINUTE +
    second * MS_PER_SECOND +
    fractionMilliseconds(fields.fraction)
  );
}

/** Undefined when the shape matched but a written part is not a real date, time, or offset. */
function readStamp(fields: StampFields): Stamp | undefined {
  const date = fields.date === undefined ? undefined : localDateOrUndefined(fields.date);
  if (fields.date !== undefined && date === undefined) return undefined;
  const offsetMinutes =
    fields.offset === undefined ? undefined : instantOffsetMinutes(fields.offset);
  if (fields.offset !== undefined && offsetMinutes === undefined) return undefined;
  const dayMs = dayMilliseconds(fields);
  return dayMs === undefined ? undefined : { date, dayMs, offsetMinutes };
}

function readStart(fields: StampFields): StartStamp | undefined {
  const stamp = readStamp(fields);
  if (stamp === undefined) return undefined;
  const date = stamp.date;
  if (date === undefined) return undefined;
  return { date, dayMs: stamp.dayMs, offsetMinutes: stamp.offsetMinutes };
}

/** An end stamp has to be followed by whitespace or the end of the line, so free text stays a tail. */
function endsAtBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const next = text[index];
  return next === ' ' || next === '\t';
}

function readEnd(rest: string): EndReading {
  const matched = matchStamp(rest);
  if (matched === undefined || !endsAtBoundary(rest, matched.length)) {
    return END_SHAPE_RE.test(rest) ? { kind: 'invalid' } : { kind: 'none', tail: rest.trim() };
  }
  const stamp = readStamp(matched.fields);
  if (stamp === undefined) return { kind: 'invalid' };
  return { kind: 'stamp', stamp, tail: rest.slice(matched.length).trim() };
}

/** Local wall clock read as if it were UTC, the common base for every offset decision. */
function wallEpochMs(date: LocalDate, dayMs: number): number {
  return epochDayForLocalDate(date) * MS_PER_DAY + dayMs;
}

/**
 * Two passes so a stamp written without an offset lands on the offset that was actually in force:
 * the first pass guesses an instant, the second asks for the offset at that guess.
 */
function resolvedOffsetMinutes(wallMs: number, offsetAt: OffsetAt): number {
  return offsetAt(wallMs - offsetAt(wallMs) * MS_PER_MINUTE);
}

function endEpochMs(start: ResolvedStart, stamp: Stamp, offsetAt: OffsetAt): number {
  if (stamp.date === undefined) {
    return wallEpochMs(start.date, stamp.dayMs) - start.offsetMinutes * MS_PER_MINUTE;
  }
  const wallMs = wallEpochMs(stamp.date, stamp.dayMs);
  const offsetMinutes =
    stamp.offsetMinutes ?? start.explicitOffsetMinutes ?? resolvedOffsetMinutes(wallMs, offsetAt);
  return wallMs - offsetMinutes * MS_PER_MINUTE;
}

function withTail(entry: ParsedTimeEntry, tail: string): ParsedTimeEntry {
  return tail.length === 0 ? entry : { ...entry, tail };
}

/** A broken entry reports only why it is broken, so every consumer treats it the same way. */
function entryFrom(start: StartStamp, end: EndReading, offsetAt: OffsetAt): ParsedTimeEntry {
  if (end.kind === 'invalid') return { state: 'broken', issue: 'invalid-end' };
  const startWallMs = wallEpochMs(start.date, start.dayMs);
  const inherited = end.kind === 'stamp' ? end.stamp.offsetMinutes : undefined;
  const offsetMinutes =
    start.offsetMinutes ?? inherited ?? resolvedOffsetMinutes(startWallMs, offsetAt);
  const startMs = startWallMs - offsetMinutes * MS_PER_MINUTE;
  if (end.kind === 'none') return withTail({ state: 'running', startMs }, end.tail);
  const resolved: ResolvedStart = {
    date: start.date,
    explicitOffsetMinutes: start.offsetMinutes,
    offsetMinutes,
  };
  const endMs = endEpochMs(resolved, end.stamp, offsetAt);
  if (endMs < startMs) return { state: 'broken', issue: 'end-before-start' };
  return withTail({ state: 'closed', startMs, endMs }, end.tail);
}

/** The list-item body, with the Markdown list prefix and any trailing carriage return removed. */
function entryBody(line: string): string | undefined {
  const source = line.endsWith('\r') ? line.slice(0, -1) : line;
  const match = LIST_PREFIX_RE.exec(source);
  return match === null ? undefined : match[1];
}

function bodyShape(body: string): EntryShape | undefined {
  const arrowIndex = body.indexOf(ARROW);
  if (arrowIndex < 0) return undefined;
  const matched = matchStamp(body);
  if (matched?.fields.date === undefined) return undefined;
  if (!BLANK_ONLY_RE.test(body.slice(matched.length, arrowIndex))) return undefined;
  return {
    start: matched.fields,
    rest: stripLeadingBlanks(body.slice(arrowIndex + ARROW.length)),
  };
}

function entryShape(line: string): EntryShape | undefined {
  if (!line.includes(ARROW)) return undefined;
  const body = entryBody(line);
  return body === undefined ? undefined : bodyShape(body);
}

/** True when the list-item body starts with a date, a time and an arrow, whatever the values are. */
export function isTimeEntryShape(line: string): boolean {
  return entryShape(line) !== undefined;
}

/** Undefined when the line is not a time entry, which leaves it to the comment path. */
export function parseTimeEntryLine(line: string, offsetAt: OffsetAt): ParsedTimeEntry | undefined {
  const shape = entryShape(line);
  if (shape === undefined) return undefined;
  const start = readStart(shape.start);
  if (start === undefined) return { state: 'broken', issue: 'invalid-start' };
  return entryFrom(start, readEnd(shape.rest), offsetAt);
}

/** The `- ` body of a newly opened entry. */
export function formatOpenEntry(stamp: AtomDateTime): string {
  return `${stamp} ${ARROW}`;
}

/**
 * Writes the canonical end right after the first arrow so a hand-written start and tail survive
 * byte for byte. Undefined when the line is not a running entry.
 */
export function closeEntryLine(line: string, end: AtomDateTime): string | undefined {
  const source = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (parseTimeEntryLine(source, ZERO_OFFSET)?.state !== 'running') return undefined;
  const arrowEnd = source.indexOf(ARROW) + ARROW.length;
  const tail = stripLeadingBlanks(source.slice(arrowEnd));
  const tailSuffix = tail.length === 0 ? '' : ` ${tail}`;
  const closed = `${source.slice(0, arrowEnd)} ${end}${tailSuffix}`;
  return source === line ? closed : `${closed}\r`;
}
