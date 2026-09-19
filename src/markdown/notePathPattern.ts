import { moment } from 'obsidian';

export interface NotePathPattern {
  resolve(date: string): string;
  matches(filePath: string): boolean;
}

interface Marker {
  readonly format: string;
  readonly matcher: string;
  readonly parts: readonly FormatPart[];
  readonly valueMatcher: RegExp;
}

interface FormatPart {
  readonly token: DateToken | undefined;
  readonly matcher: RegExp;
}

type DateToken = (typeof FORMAT_TOKENS)[number];

interface PatternSegment {
  readonly literal: string;
  readonly marker: Marker | undefined;
  readonly next: number;
}

const FORMAT_TOKENS = [
  'GGGG',
  'YYYY',
  'DDDD',
  'DDD',
  'YY',
  'MM',
  'DD',
  'WW',
  'M',
  'D',
  'Q',
  'W',
] as const;

const TOKEN_MATCHERS: Readonly<Record<(typeof FORMAT_TOKENS)[number], string>> = {
  GGGG: '\\d{4}',
  YYYY: '\\d{4}',
  DDDD: '(?:00[1-9]|0[1-9]\\d|[12]\\d{2}|3[0-5]\\d|36[0-6])',
  DDD: '(?:[1-9]|[1-9]\\d|[12]\\d{2}|3[0-5]\\d|36[0-6])',
  YY: '\\d{2}',
  MM: '(?:0[1-9]|1[0-2])',
  DD: '(?:0[1-9]|[12]\\d|3[01])',
  WW: '(?:0[1-9]|[1-4]\\d|5[0-3])',
  M: '(?:[1-9]|1[0-2])',
  D: '(?:[1-9]|[12]\\d|3[01])',
  Q: '[1-4]',
  W: '(?:[1-9]|[1-4]\\d|5[0-3])',
};

const TOKEN_MAX_WIDTH: Readonly<Record<DateToken, number>> = {
  GGGG: 4,
  YYYY: 4,
  DDDD: 3,
  DDD: 3,
  YY: 2,
  MM: 2,
  DD: 2,
  WW: 2,
  M: 2,
  D: 2,
  Q: 1,
  W: 2,
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function throwMalformedBraces(condition: boolean): void {
  if (condition) throw new Error('Malformed braces in note path pattern.');
}

function tokenAt(
  format: string,
  cursor: number,
): { readonly run: string; readonly end: number } | undefined {
  const character = format[cursor];
  if (character === undefined || !/[A-Za-z]/u.test(character)) return undefined;
  let end = cursor + 1;
  while (format[end] === character) end += 1;
  return { run: format.slice(cursor, end), end };
}

function bracketLiteral(
  format: string,
  cursor: number,
): { readonly matcher: string; readonly next: number } {
  const close = format.indexOf(']', cursor + 1);
  if (close < 0) throw new Error('Note path date format has an unclosed bracket literal.');
  return { matcher: escapeRegex(format.slice(cursor + 1, close)), next: close + 1 };
}

function compiledFormatPart(
  format: string,
  cursor: number,
): { readonly matcher: string; readonly next: number; readonly token: DateToken | undefined } {
  const character = format[cursor];
  if (character === '[') {
    const literal = bracketLiteral(format, cursor);
    return { matcher: literal.matcher, next: literal.next, token: undefined };
  }
  if (character === ']') throw new Error('Note path date format has an unmatched bracket.');
  const tokenRun = tokenAt(format, cursor);
  if (tokenRun === undefined) {
    return { matcher: escapeRegex(character ?? ''), next: cursor + 1, token: undefined };
  }
  const token = FORMAT_TOKENS.find((candidate) => candidate === tokenRun.run);
  if (token === undefined)
    throw new Error(`Unsupported date token in note path format: ${tokenRun.run}`);
  return { matcher: TOKEN_MATCHERS[token], next: tokenRun.end, token };
}

function compileFormat(format: string): Marker {
  if (format.length === 0) throw new Error('Note path date format cannot be empty.');
  let matcher = '';
  let cursor = 0;
  let hasToken = false;
  const parts: FormatPart[] = [];
  while (cursor < format.length) {
    const part = compiledFormatPart(format, cursor);
    matcher += part.matcher;
    if (part.token !== undefined) hasToken = true;
    parts.push({
      token: part.token,
      matcher: new RegExp(`^(?:${part.matcher})$`, 'iu'),
    });
    cursor = part.next;
  }
  if (!hasToken) {
    throw new Error('Note path date format must contain a supported date token.');
  }
  return {
    format,
    matcher,
    parts,
    valueMatcher: new RegExp(`^(?:${matcher})$`, 'iu'),
  };
}

function normalizedPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) throw new Error('Task file path cannot be empty.');
  if (/^(?:\/|\\|[A-Za-z]:[\\/])/u.test(trimmed)) {
    throw new Error('Task file path must be relative to the vault.');
  }
  if (trimmed.includes('\\')) throw new Error('Task file path must use forward slashes.');
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Task file path cannot traverse outside the vault.');
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('Task file path cannot contain empty folders.');
  }
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function remainingPatternSegment(
  source: string,
  cursor: number,
  strayClosing: number,
): PatternSegment {
  const literal = source.slice(cursor);
  throwMalformedBraces(strayClosing >= 0 || /[{}]/u.test(literal));
  return { literal, marker: undefined, next: source.length };
}

function markedPatternSegment(
  source: string,
  cursor: number,
  opening: number,
  strayClosing: number,
): PatternSegment {
  throwMalformedBraces(strayClosing >= 0 && strayClosing < opening);
  const literal = source.slice(cursor, opening);
  throwMalformedBraces(/[{}]/u.test(literal));
  const closing = source.indexOf('}}', opening + 2);
  throwMalformedBraces(closing < 0);
  const body = source.slice(opening + 2, closing);
  throwMalformedBraces(body.includes('{') || body.includes('}'));
  const format = body.startsWith('DATE:') ? body.slice('DATE:'.length) : body;
  return { literal, marker: compileFormat(format), next: closing + 2 };
}

function nextPatternSegment(source: string, cursor: number): PatternSegment {
  const opening = source.indexOf('{{', cursor);
  const strayClosing = source.indexOf('}}', cursor);
  return opening < 0
    ? remainingPatternSegment(source, cursor, strayClosing)
    : markedPatternSegment(source, cursor, opening, strayClosing);
}

function matcherPart(literal: string, marker: Marker | undefined): string {
  if (marker === undefined) return escapeRegex(literal);
  return `${escapeRegex(literal)}(${marker.matcher})`;
}

interface DateFields {
  readonly calendarYears: readonly number[];
  readonly twoDigitYears: readonly number[];
  readonly isoYears: readonly number[];
  readonly months: readonly number[];
  readonly days: readonly number[];
  readonly ordinals: readonly number[];
  readonly quarters: readonly number[];
  readonly isoWeeks: readonly number[];
}

const FIELD_FOR_TOKEN: Readonly<Record<DateToken, keyof DateFields>> = {
  GGGG: 'isoYears',
  YYYY: 'calendarYears',
  YY: 'twoDigitYears',
  M: 'months',
  MM: 'months',
  D: 'days',
  DD: 'days',
  DDD: 'ordinals',
  DDDD: 'ordinals',
  Q: 'quarters',
  W: 'isoWeeks',
  WW: 'isoWeeks',
};

function captureMarkerFields(
  marker: Marker,
  value: string,
  fields: Record<keyof DateFields, number[]>,
): void {
  const matchingPartEnds = (part: FormatPart, cursor: number): readonly number[] => {
    const lastEnd =
      part.token === undefined
        ? value.length
        : Math.min(value.length, cursor + TOKEN_MAX_WIDTH[part.token]);
    const ends: number[] = [];
    for (let end = cursor; end <= lastEnd; end += 1) {
      if (part.matcher.test(value.slice(cursor, end))) ends.push(end);
    }
    return ends;
  };
  const memo = new Map<string, boolean>();
  const canFinish = (partIndex: number, cursor: number): boolean => {
    const key = `${partIndex}:${cursor}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (partIndex === marker.parts.length) {
      const complete = cursor === value.length;
      memo.set(key, complete);
      return complete;
    }
    const part = marker.parts[partIndex];
    if (part === undefined) return false;
    for (const end of matchingPartEnds(part, cursor)) {
      if (!canFinish(partIndex + 1, end)) continue;
      memo.set(key, true);
      return true;
    }
    memo.set(key, false);
    return false;
  };
  const visited = new Set<string>();
  const collect = (partIndex: number, cursor: number): void => {
    const key = `${partIndex}:${cursor}`;
    if (visited.has(key)) return;
    visited.add(key);
    const part = marker.parts[partIndex];
    if (part === undefined) return;
    for (const end of matchingPartEnds(part, cursor)) {
      const candidate = value.slice(cursor, end);
      if (!canFinish(partIndex + 1, end)) continue;
      if (part.token !== undefined) fields[FIELD_FOR_TOKEN[part.token]].push(Number(candidate));
      collect(partIndex + 1, end);
    }
  };
  if (canFinish(0, 0)) collect(0, 0);
}

function capturedFields(
  markers: readonly Marker[],
  valuesByMarker: ReadonlyArray<readonly string[]>,
): DateFields {
  const fields: Record<keyof DateFields, number[]> = {
    calendarYears: [],
    twoDigitYears: [],
    isoYears: [],
    months: [],
    days: [],
    ordinals: [],
    quarters: [],
    isoWeeks: [],
  };
  for (const [index, marker] of markers.entries()) {
    for (const value of valuesByMarker[index] ?? []) captureMarkerFields(marker, value, fields);
  }
  return fields;
}

function matchingLiteralEnd(
  filePath: string,
  cursor: number,
  markerIndex: number,
  literalMatchers: readonly RegExp[],
): number | undefined {
  const matcher = literalMatchers[markerIndex];
  if (matcher === undefined) return undefined;
  const match = matcher.exec(filePath.slice(cursor));
  return match === null ? undefined : cursor + match[0].length;
}

function matchingMarkerEnds(
  filePath: string,
  valueStart: number,
  marker: Marker,
): readonly number[] {
  const ends: number[] = [];
  for (let valueEnd = valueStart + 1; valueEnd <= filePath.length; valueEnd += 1) {
    if (marker.valueMatcher.test(filePath.slice(valueStart, valueEnd))) ends.push(valueEnd);
  }
  return ends;
}

function markerValuesByPosition(
  filePath: string,
  literals: readonly string[],
  markers: readonly Marker[],
): ReadonlyArray<readonly string[]> {
  const literalMatchers = literals.map(
    (literal) => new RegExp(`^(?:${escapeRegex(literal)})`, 'iu'),
  );
  const memo = new Map<string, boolean>();
  const canFinish = (markerIndex: number, cursor: number): boolean => {
    const key = `${markerIndex}:${cursor}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const valueStart = matchingLiteralEnd(filePath, cursor, markerIndex, literalMatchers);
    if (valueStart === undefined) {
      memo.set(key, false);
      return false;
    }
    if (markerIndex === markers.length) {
      const complete = valueStart === filePath.length;
      memo.set(key, complete);
      return complete;
    }
    const marker = markers[markerIndex];
    if (marker === undefined) return false;
    for (const valueEnd of matchingMarkerEnds(filePath, valueStart, marker)) {
      if (!canFinish(markerIndex + 1, valueEnd)) continue;
      memo.set(key, true);
      return true;
    }
    memo.set(key, false);
    return false;
  };
  const values = markers.map(() => new Set<string>());
  const visited = new Set<string>();
  const collect = (markerIndex: number, cursor: number): void => {
    const key = `${markerIndex}:${cursor}`;
    if (visited.has(key)) return;
    visited.add(key);
    const valueStart = matchingLiteralEnd(filePath, cursor, markerIndex, literalMatchers);
    if (valueStart === undefined) return;
    const marker = markers[markerIndex];
    const captured = values[markerIndex];
    if (marker === undefined || captured === undefined) return;
    for (const valueEnd of matchingMarkerEnds(filePath, valueStart, marker)) {
      if (!canFinish(markerIndex + 1, valueEnd)) continue;
      captured.add(filePath.slice(valueStart, valueEnd));
      collect(markerIndex + 1, valueEnd);
    }
  };
  if (canFinish(0, 0)) collect(0, 0);
  return values.map((captured) => [...captured]);
}

function consecutiveDates(
  first: ReturnType<typeof moment>,
  count: number,
): ReadonlyArray<ReturnType<typeof moment>> {
  return Array.from({ length: count }, (_value, index) => first.clone().add(index, 'day'));
}

function datesForMonth(
  year: number,
  month: number,
  searchForIsoYear: boolean,
): ReadonlyArray<ReturnType<typeof moment>> {
  const first = moment([year, month - 1, 1]);
  return searchForIsoYear ? consecutiveDates(first, first.daysInMonth()) : [first];
}

function datesForQuarter(
  year: number,
  quarter: number,
  day: number | undefined,
  searchForIsoYear: boolean,
): ReadonlyArray<ReturnType<typeof moment>> {
  if (day !== undefined) {
    return Array.from({ length: 3 }, (_value, index) =>
      moment([year, (quarter - 1) * 3 + index, day]),
    );
  }
  const first = moment([year, (quarter - 1) * 3, 1]);
  return searchForIsoYear
    ? consecutiveDates(first, first.clone().add(3, 'months').diff(first, 'days'))
    : [first];
}

function datesForUnspecifiedCalendar(
  year: number,
  searchForIsoYear: boolean,
): ReadonlyArray<ReturnType<typeof moment>> {
  const first = moment([year, 0, 1]);
  if (!searchForIsoYear) return [first];
  const days = first.isLeapYear() ? 366 : 365;
  return consecutiveDates(first, days);
}

function unique(values: readonly number[]): readonly number[] {
  return [...new Set(values)];
}

function datesForCalendarYear(
  year: number,
  fields: DateFields,
  searchForIsoYear: boolean,
): ReadonlyArray<ReturnType<typeof moment>> {
  const months = unique(fields.months);
  const days = unique(fields.days);
  const ordinals = unique(fields.ordinals);
  const quarters = unique(fields.quarters);
  if (ordinals.length > 0) {
    return ordinals.map((ordinal) => moment([year, 0, 1]).dayOfYear(ordinal));
  }
  if (months.length > 0 && days.length > 0) {
    return months.flatMap((month) => days.map((day) => moment([year, month - 1, day])));
  }
  if (months.length > 0) {
    return months.flatMap((month) => datesForMonth(year, month, searchForIsoYear));
  }
  if (quarters.length > 0) {
    const candidateDays = days.length > 0 ? days : [undefined];
    return quarters.flatMap((quarter) =>
      candidateDays.flatMap((day) => datesForQuarter(year, quarter, day, searchForIsoYear)),
    );
  }
  if (days.length > 0) {
    return days.flatMap((day) =>
      Array.from({ length: 12 }, (_value, index) => moment([year, index, day])),
    );
  }
  return datesForUnspecifiedCalendar(year, searchForIsoYear);
}

function isoCandidateYears(fields: DateFields): readonly number[] {
  if (fields.isoYears.length > 0) return unique(fields.isoYears);
  const calendarYears = unique(fields.calendarYears);
  if (calendarYears.length > 0) {
    return unique(calendarYears.flatMap((year) => [year - 1, year, year + 1]));
  }
  return Array.from({ length: 400 }, (_value, index) => 2000 + index);
}

function calendarCandidateYears(fields: DateFields): readonly number[] {
  const calendarYears = unique(fields.calendarYears);
  if (calendarYears.length > 0) return calendarYears;
  if (fields.isoYears.length > 0) {
    return unique(fields.isoYears.flatMap((year) => [year - 1, year, year + 1]));
  }
  if (fields.twoDigitYears.length > 0) {
    return Array.from({ length: 400 }, (_value, index) => 2000 + index);
  }
  return [2000, 2001];
}

function candidateDates(fields: DateFields): ReadonlyArray<ReturnType<typeof moment>> {
  if (fields.isoWeeks.length > 0) {
    const years = isoCandidateYears(fields);
    return years.flatMap((year) =>
      fields.isoWeeks.flatMap((week) =>
        Array.from({ length: 7 }, (_value, index) =>
          moment()
            .isoWeekYear(year)
            .isoWeek(week)
            .isoWeekday(index + 1)
            .startOf('day'),
        ),
      ),
    );
  }
  const years = calendarCandidateYears(fields);
  return years.flatMap((year) => datesForCalendarYear(year, fields, fields.isoYears.length > 0));
}

function hasMatchingDate(
  markers: readonly Marker[],
  valuesByMarker: ReadonlyArray<readonly string[]>,
  matchesResolvedPath: (candidate: ReturnType<typeof moment>) => boolean,
): boolean {
  const fields = capturedFields(markers, valuesByMarker);
  return candidateDates(fields).some(matchesResolvedPath);
}

export function compileNotePathPattern(pattern: string): NotePathPattern {
  const source = normalizedPattern(pattern);
  const literals: string[] = [];
  const markers: Marker[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const segment = nextPatternSegment(source, cursor);
    literals.push(segment.literal);
    if (segment.marker !== undefined) markers.push(segment.marker);
    cursor = segment.next;
  }
  if (literals.length === markers.length) literals.push('');

  const matcherSource = literals
    .map((literal, index) => matcherPart(literal, markers[index]))
    .join('');
  const matcher = new RegExp(`^${matcherSource}$`, 'iu');

  return {
    resolve(date: string): string {
      const parsed = moment(date, 'YYYY-MM-DD', true);
      if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== date) {
        throw new Error(`Invalid local date: ${date}`);
      }
      let resolved = literals[0] ?? '';
      for (const [index, marker] of markers.entries()) {
        resolved += parsed.format(marker.format) + (literals[index + 1] ?? '');
      }
      return resolved;
    },
    matches(filePath: string): boolean {
      const match = matcher.exec(filePath);
      if (match === null) return false;
      if (markers.length === 0) return true;
      const valuesByMarker = markerValuesByPosition(filePath, literals, markers);
      return hasMatchingDate(markers, valuesByMarker, (candidate) => {
        let resolved = literals[0] ?? '';
        for (const [index, marker] of markers.entries()) {
          resolved += candidate.format(marker.format) + (literals[index + 1] ?? '');
        }
        return resolved.toLocaleLowerCase() === filePath.toLocaleLowerCase();
      });
    },
  };
}
