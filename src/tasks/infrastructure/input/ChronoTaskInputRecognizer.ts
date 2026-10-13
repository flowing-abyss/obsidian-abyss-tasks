import * as en from 'chrono-node/en';
import * as ru from 'chrono-node/ru';
import type {
  TaskInputRecognizer,
  TaskInputRecognizerRequest,
} from '../../application/TaskInputRecognizer';
import { epochDayForLocalDate } from '../../domain/commentTimestamp';
import { shiftLocalDate } from '../../domain/localDateMath';
import {
  inputRangesOverlap,
  inputTextBarriers,
  maskInputRanges,
} from '../../domain/taskInputGuards';
import { inspectTaskInput } from '../../domain/taskInputInspection';
import type {
  TaskInputCandidate,
  TaskInputRange,
  TaskInputReference,
} from '../../domain/taskInputTypes';
import type { LocalDate } from '../../domain/types';
import { localDate, localTime } from '../../domain/validation';

const CLOCK = /\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s?[ap]m/giu;
const NUMERIC = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/gu;
function validatedDate(year: number, month: number, day: number): LocalDate | undefined {
  try {
    return localDate(
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    );
  } catch {
    return undefined;
  }
}
function nearestDate(
  month: number,
  day: number,
  reference: TaskInputReference,
): LocalDate | undefined {
  const first = Number(reference.localDate.slice(0, 4));
  for (let year = first; year <= first + 8; year++) {
    const date = validatedDate(year, month, day);
    if (date !== undefined && date >= reference.localDate) return date;
  }
  return undefined;
}
function ownedCue(text: string, range: TaskInputRange): TaskInputRange {
  const preceding = text.slice(0, range.from);
  const cue = /(?:^|\s)(?:on|at|на|к|до|в) $/iu.exec(preceding);
  return cue === null ? range : { from: range.from - cue[0].trimStart().length, to: range.to };
}
function sameRanges(a: readonly TaskInputRange[], b: readonly TaskInputRange[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function candidate(range: TaskInputRange, fields: Partial<TaskInputCandidate>): TaskInputCandidate {
  return {
    kind: 'date-time',
    status: 'point',
    ranges: [range],
    dateRanges: [],
    timeRanges: [],
    ...fields,
  };
}
type LocaleResult = ReturnType<typeof en.parse>[number];
interface Recognition {
  readonly text: string;
  readonly reference: TaskInputReference;
  readonly barriers: TaskInputRange[];
  readonly excluded: TaskInputCandidate[];
}
function parseLocales(text: string, reference: TaskInputReference): LocaleResult[] {
  const ref = { instant: new Date(reference.epochMs), timezone: reference.offsetMinutes };
  return [
    ...ru.parse(text, ref, { forwardDate: false }),
    ...en.parse(text, ref, { forwardDate: false }),
  ];
}
function timeExclusion(text: string): TaskInputCandidate['reason'] | undefined {
  for (const match of text.matchAll(/[0-9:]+/gu)) {
    if (match[0].includes(':') && /\d/u.test(match[0]) && !exactClock(match[0]))
      return 'invalid-time';
  }
  if (/(?:about|around|approximately|примерно|около)\s+(?:at\s+)?\d/iu.test(text))
    return 'vague-time';
  if (
    /\b(?:in|within)\s+\d+\s+(?:hours?|minutes?)\b/iu.test(text) ||
    /через\s+\d+\s+(?:час\p{L}*|минут\p{L}*)/iu.test(text)
  )
    return 'vague-time';
  if (
    /\d{1,2}:\d{2}\s*(?:до|to|until|-|–)\s*\d/iu.test(text) ||
    /(?:from|с)\s+\d{1,2}(?::\d{2})?\s+(?:до|to)/iu.test(text)
  )
    return 'range';
  return undefined;
}
function exclusion(text: string): TaskInputCandidate['reason'] | undefined {
  if (/(?:кажд\p{L}*|every\b|daily\b|weekly\b)/iu.test(text)) return 'recurrence';
  if (
    /(?:^|\s)(?:не|not|never|no)\s+(?:завтра|сегодня|послезавтра|tomorrow|today|next|on|at)/iu.test(
      text,
    )
  )
    return 'negation';
  if (/\b(?:UTC|GMT|CET|CEST|PST|PDT|EST|EDT|JST|MSK)\b|[+-]\d{2}:?\d{2}/u.test(text))
    return 'timezone';
  return timeExclusion(text);
}
function excludeExpressions(context: Recognition): void {
  const masked = maskInputRanges(context.text, context.barriers);
  for (const match of masked.matchAll(/[^!?;\n]+/gu)) {
    const reason = exclusion(match[0]);
    if (reason === undefined) continue;
    const range = { from: match.index, to: match.index + match[0].length };
    context.excluded.push(
      candidate(range, { status: reason === 'range' ? 'range' : 'unsupported', reason }),
    );
    context.barriers.push(range);
  }
}
function excludeRanges(context: Recognition): void {
  const masked = maskInputRanges(context.text, context.barriers);
  for (const result of parseLocales(masked, context.reference)) {
    if (result.end == null) continue;
    const range = { from: result.index, to: result.index + result.text.length };
    context.excluded.push(candidate(range, { status: 'range', reason: 'range' }));
    context.barriers.push(range);
  }
}
function exactClock(source: string): boolean {
  const withoutCue = source.replace(/^(?:at|в)\s+/iu, '');
  return (
    /^(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(withoutCue) ||
    /^(?:0?[1-9]|1[0-2])\s?[ap]m$/iu.test(withoutCue)
  );
}
function clockWordEdge(text: string, range: TaskInputRange): boolean {
  return (
    /[\p{L}\p{N}_:]/u.test(text[range.from - 1] ?? '') ||
    /[\p{L}\p{N}_:]/u.test(text[range.to] ?? '')
  );
}
function recognizedClock(context: Recognition, range: TaskInputRange): TaskInputCandidate {
  if (clockWordEdge(context.text, range))
    return candidate(range, { status: 'unsupported', reason: 'content' });
  const source = context.text.slice(range.from, range.to);
  const value = parseLocales(source, context.reference).find((result) =>
    result.start.isCertain('hour'),
  );
  const hour = value?.start.get('hour'),
    minute = value?.start.get('minute');
  if (!exactClock(source) || hour == null || minute == null)
    return candidate(range, { status: 'unsupported', reason: 'invalid-time' });
  const time = localTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  return candidate(range, { time, timeRanges: [range] });
}
function recognizeClocks(context: Recognition): TaskInputCandidate[] {
  const masked = maskInputRanges(context.text, context.barriers),
    clocks: TaskInputCandidate[] = [];
  for (const match of masked.matchAll(CLOCK)) {
    const range = ownedCue(context.text, { from: match.index, to: match.index + match[0].length });
    const result = recognizedClock(context, range);
    if (result.status === 'point') clocks.push(result);
    else {
      context.excluded.push(result);
      context.barriers.push(range);
    }
  }
  return clocks;
}
function numericDate(
  context: Recognition,
  range: TaskInputRange,
): { date?: LocalDate | undefined; yearExplicit: boolean } {
  const raw = context.text.slice(range.from, range.to),
    iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw),
    dot = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/u.exec(raw);
  if (iso !== null)
    return {
      date: validatedDate(Number(iso[1]), Number(iso[2]), Number(iso[3])),
      yearExplicit: true,
    };
  if (dot === null) return { yearExplicit: false };
  if (dot[3] !== undefined)
    return {
      date: validatedDate(Number(dot[3]), Number(dot[2]), Number(dot[1])),
      yearExplicit: true,
    };
  if (!/(?:^|\s)(?:на|к|до) $/iu.test(context.text.slice(0, range.from)))
    return { yearExplicit: false };
  return {
    date: nearestDate(Number(dot[2]), Number(dot[1]), context.reference),
    yearExplicit: false,
  };
}
function recognizedNumeric(context: Recognition, range: TaskInputRange): TaskInputCandidate {
  const { date, yearExplicit } = numericDate(context, range);
  const badEdge =
    /[\p{L}\p{N}./-]/u.test(context.text[range.from - 1] ?? '') ||
    /[\p{L}\p{N}./-]/u.test(context.text[range.to] ?? '');
  if (date === undefined || badEdge)
    return candidate(range, { status: 'unsupported', reason: 'numeric' });
  const owned = ownedCue(context.text, range);
  return candidate(owned, { date, dateRanges: [owned], yearExplicit, dateOrigin: 'named' });
}
function recognizeNumeric(context: Recognition): TaskInputCandidate[] {
  const masked = maskInputRanges(context.text, context.barriers),
    numeric: TaskInputCandidate[] = [];
  for (const match of masked.matchAll(NUMERIC)) {
    const result = recognizedNumeric(context, {
      from: match.index,
      to: match.index + match[0].length,
    });
    if (result.status === 'point') numeric.push(result);
    else context.excluded.push(result);
    context.barriers.push(...result.ranges);
  }
  return numeric;
}
function leapResults(text: string, reference: TaskInputReference): LocaleResult[] {
  // Chrono drops an annual February 29 in non-leap reference years. Only an uncertain-year
  // February 29 can use this second locale pass; all actual values use the frozen civil reference.
  const leapReference = {
    ...reference,
    epochMs: Date.UTC(2028, 1, 29) - reference.offsetMinutes * 60_000,
  };
  return parseLocales(text, leapReference).filter(
    (result) =>
      !result.start.isCertain('year') &&
      result.start.get('month') === 2 &&
      result.start.get('day') === 29 &&
      result.end == null,
  );
}
function dateResults(text: string, reference: TaskInputReference): LocaleResult[] {
  const results = parseLocales(text, reference);
  for (const result of leapResults(text, reference))
    if (!results.some((old) => old.index === result.index && old.text === result.text))
      results.push(result);
  return results;
}
function contentDate(text: string, range: TaskInputRange): boolean {
  return (
    /(?:за|от|report for|dated)\s*$/iu.test(text.slice(0, range.from)) ||
    /^today['’]s\b/iu.test(text.slice(range.from, range.to)) ||
    /^['’]s\s+report\b/iu.test(text.slice(range.to))
  );
}
function weekdayDelta(slice: string, today: number, target: number): number {
  if (/next|следующ/iu.test(slice)) return 7 - today + target;
  if (/last|прошл/iu.test(slice)) return target - today - 7;
  return (target - today + 7) % 7;
}
function weekdayDate(
  slice: string,
  weekday: number,
  reference: TaskInputReference,
): LocalDate | undefined {
  if (/[а-яё]/iu.test(slice) && !/(?:^|\s)(?:в|к|до|следующ\p{L}*|прошл\p{L}*)\s/iu.test(slice))
    return undefined;
  const today = (((epochDayForLocalDate(reference.localDate) + 3) % 7) + 7) % 7,
    target = (weekday + 6) % 7;
  return shiftLocalDate(reference.localDate, weekdayDelta(slice, today, target));
}
function dateValue(
  result: LocaleResult,
  slice: string,
  reference: TaskInputReference,
): { date?: LocalDate | undefined; origin: NonNullable<TaskInputCandidate['dateOrigin']> } {
  const start = result.start,
    weekday = start.get('weekday');
  if (start.isCertain('weekday') && !start.isCertain('day') && weekday !== null)
    return { date: weekdayDate(slice, weekday, reference), origin: 'weekday' };
  const year = start.get('year'),
    month = start.get('month'),
    day = start.get('day');
  if (year === null || month === null || day === null) return { origin: 'named' };
  const relative = /tomorrow|today|yesterday|ago|from now|завтра|сегодня|вчера|через|назад/iu.test(
    slice,
  );
  return {
    date:
      relative || start.isCertain('year')
        ? validatedDate(year, month, day)
        : nearestDate(month, day, reference),
    origin: relative ? 'relative' : 'named',
  };
}
function vagueDay(
  context: Recognition,
  result: LocaleResult,
  range: TaskInputRange,
  value: { date: LocalDate; origin: NonNullable<TaskInputCandidate['dateOrigin']> },
): TaskInputCandidate {
  const tail = /^\s+(?:утром|вечером|днём|ночью|morning|evening|afternoon|night)(?:\s|$)/iu.exec(
    context.text.slice(range.to),
  );
  const vague =
    tail !== null ||
    /(?:утром|вечером|днём|ночью|morning|evening|afternoon|night)/iu.test(
      context.text.slice(range.from, range.to),
    );
  const owned =
    tail === null ? range : { from: range.from, to: range.to + tail[0].trimEnd().length };
  return candidate(owned, {
    date: value.date,
    dateRanges: [owned],
    dateOrigin: value.origin,
    yearExplicit: value.origin === 'named' && result.start.isCertain('year'),
    status: vague ? 'partial' : 'point',
    ...(vague ? { reason: 'vague-time' as const } : {}),
  });
}
function unsupportedShortYear(result: LocaleResult, slice: string): boolean {
  const numbers = slice.match(/\d+/gu) ?? [];
  return (
    result.start.isCertain('year') &&
    numbers.length > 1 &&
    numbers[numbers.length - 1]?.length === 2
  );
}
function recognizedDay(context: Recognition, result: LocaleResult): TaskInputCandidate | undefined {
  if (!result.start.isCertain('day') && !result.start.isCertain('weekday')) return undefined;
  const leading = result.text.length - result.text.trimStart().length,
    trailing = result.text.length - result.text.trimEnd().length;
  const range = ownedCue(context.text, {
    from: result.index + leading,
    to: result.index + result.text.length - trailing,
  });
  if (context.barriers.some((barrier) => inputRangesOverlap(range, barrier))) return undefined;
  if (unsupportedShortYear(result, context.text.slice(range.from, range.to)))
    return candidate(range, { status: 'unsupported', reason: 'numeric' });
  if (contentDate(context.text, range))
    return candidate(range, { status: 'unsupported', reason: 'content' });
  const { date, origin } = dateValue(
    result,
    context.text.slice(range.from, range.to),
    context.reference,
  );
  return date === undefined ? undefined : vagueDay(context, result, range, { date, origin });
}
function recognizeDays(
  context: Recognition,
  clocks: readonly TaskInputCandidate[],
): TaskInputCandidate[] {
  const text = maskInputRanges(context.text, [
      ...context.barriers,
      ...clocks.flatMap((clock) => clock.ranges),
    ]),
    dates: TaskInputCandidate[] = [];
  for (const result of dateResults(text, context.reference)) {
    const day = recognizedDay(context, result);
    if (day === undefined) continue;
    if (day.status === 'unsupported') {
      context.excluded.push(day);
      continue;
    }
    if (
      !dates.some(
        (existing) => sameRanges(existing.ranges, day.ranges) && existing.date === day.date,
      )
    )
      dates.push(day);
  }
  return dates;
}
function mergePair(
  context: Recognition,
  day: TaskInputCandidate,
  clock: TaskInputCandidate,
): TaskInputCandidate | undefined {
  const spans = [...day.ranges, ...clock.ranges].sort((a, b) => a.from - b.from),
    left = spans[0],
    right = spans[spans.length - 1];
  if (
    left === undefined ||
    right === undefined ||
    clock.time === undefined ||
    /[.!?;\n]/u.test(context.text.slice(left.to, right.from))
  )
    return undefined;
  const tags = inspectTaskInput(context.text).tags.map((tag) => tag.range);
  const isTag = (range: TaskInputRange): boolean =>
    tags.some((tag) => tag.from === range.from && tag.to === range.to);
  if (
    context.barriers.some((range) => !isTag(range) && range.from < right.from && range.to > left.to)
  )
    return undefined;
  return { ...day, time: clock.time, ranges: spans, timeRanges: clock.timeRanges };
}
function mergedCandidates(
  context: Recognition,
  days: readonly TaskInputCandidate[],
  clocks: readonly TaskInputCandidate[],
): TaskInputCandidate[] {
  const day = days[0],
    clock = clocks[0];
  if (days.length !== 1 || clocks.length !== 1 || day === undefined || clock === undefined)
    return [...days, ...clocks, ...context.excluded];
  const joined = mergePair(context, day, clock);
  if (joined !== undefined) return [joined, ...context.excluded];
  return [
    ...[...days, ...clocks].map((point) => ({ ...point, reason: 'multiple' as const })),
    ...context.excluded,
  ];
}
/** Offline locale adapter. Library objects never cross the application port. */
export class ChronoTaskInputRecognizer implements TaskInputRecognizer {
  recognize(request: TaskInputRecognizerRequest): readonly TaskInputCandidate[] {
    const context: Recognition = {
      text: request.text,
      reference: request.reference,
      barriers: inputTextBarriers(request.text, request.protectedRanges),
      excluded: [],
    };
    excludeExpressions(context);
    excludeRanges(context);
    const clocks = recognizeClocks(context),
      numeric = recognizeNumeric(context);
    const days = [...recognizeDays(context, clocks), ...numeric];
    return mergedCandidates(context, days, clocks).sort(
      (a, b) => (a.ranges[0]?.from ?? 0) - (b.ranges[0]?.from ?? 0),
    );
  }
}
