import { RRule, type Options } from 'rrule';
import { daysBetweenLocalDates, shiftLocalDate } from './localDateMath';
import type { LocalDate, TaskPlanning } from './types';
import { localDate } from './validation';

export type RecurrenceIssueCode =
  | 'must-start-with-every'
  | 'unsupported-recurrence-count'
  | 'unsupported-recurrence-until'
  | 'invalid-when-done'
  | 'unparseable-rule'
  | 'recurrence-date-required'
  | 'nested-recurrence-conflict'
  | 'invalid-descendant-date'
  | 'forecast-limit-reached';

export type RecurrenceParseResult =
  | {
      readonly type: 'valid';
      readonly raw: string;
      readonly canonical: string;
      readonly whenDone: boolean;
    }
  | { readonly type: 'invalid'; readonly code: RecurrenceIssueCode };

export interface RecurrencePolicy {
  readonly removeScheduledDate: boolean;
}

interface NextOccurrenceInput {
  readonly rule: string;
  readonly planning: TaskPlanning;
  readonly completedOn: LocalDate;
  readonly policy: RecurrencePolicy;
}

type NextOccurrenceResult =
  | { readonly type: 'next'; readonly planning: TaskPlanning; readonly dayDelta: number }
  | { readonly type: 'invalid'; readonly code: RecurrenceIssueCode };

interface ExpandRecurrenceInput {
  readonly rule: string;
  readonly planning: TaskPlanning;
  readonly visible: { readonly from: LocalDate; readonly to: LocalDate };
  readonly policy: RecurrencePolicy;
  readonly maxVisible: 512;
  readonly maxSequentialSteps: 4096;
}

type RecurrenceExpansionResult =
  | { readonly type: 'expanded'; readonly dates: readonly LocalDate[] }
  | { readonly type: 'invalid'; readonly code: RecurrenceIssueCode }
  | {
      readonly type: 'limited';
      readonly dates: readonly LocalDate[];
      readonly phase: 'visible-occurrences' | 'sequential-seek';
      readonly limit: 512 | 4096;
    };

const compiledRules = new Map<string, RRule>();
const DATE_FIELDS = ['start', 'scheduled', 'due'] as const;

function normalizedRuleText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function hasOnlySupportedOptions(options: Partial<Options>): boolean {
  const common = ['freq', 'interval'] as const satisfies readonly (keyof Options)[];
  let allowed: ReadonlySet<keyof Options>;
  if (options.freq === RRule.DAILY) {
    allowed = new Set(common);
  } else if (options.freq === RRule.WEEKLY) {
    allowed = new Set([...common, 'byweekday']);
  } else if (options.freq === RRule.MONTHLY) {
    allowed = new Set([...common, 'bymonthday', 'byweekday']);
  } else if (options.freq === RRule.YEARLY) {
    allowed = new Set([...common, 'bymonth', 'bymonthday', 'byweekday']);
  } else {
    return false;
  }
  return Object.entries(options).every(
    ([key, value]) => value == null || allowed.has(key as keyof Options),
  );
}

export function parseRecurrenceRule(raw: string): RecurrenceParseResult {
  const normalized = normalizedRuleText(raw);
  if (!/^every\b/iu.test(normalized)) {
    return { type: 'invalid', code: 'must-start-with-every' };
  }
  if (/\bfor\s+\d+\s+times?\b/iu.test(normalized)) {
    return { type: 'invalid', code: 'unsupported-recurrence-count' };
  }
  if (/\buntil\b/iu.test(normalized)) {
    return { type: 'invalid', code: 'unsupported-recurrence-until' };
  }

  const whenDoneMatches = normalized.match(/\bwhen\s+done\b/giu) ?? [];
  if (
    whenDoneMatches.length > 1 ||
    (whenDoneMatches.length === 1 && !/\bwhen\s+done$/iu.test(normalized))
  ) {
    return { type: 'invalid', code: 'invalid-when-done' };
  }
  const whenDone = whenDoneMatches.length === 1;
  const ruleText = whenDone
    ? normalized.slice(0, normalized.length - ' when done'.length)
    : normalized;

  try {
    const options = RRule.parseText(ruleText);
    if (!hasOnlySupportedOptions(options)) {
      return { type: 'invalid', code: 'unparseable-rule' };
    }
    const compiled = new RRule({ ...options, dtstart: utcDate(localDate('2000-01-01')) });
    const canonical = compiled.toText();
    compiledRules.set(canonical, compiled);
    return { type: 'valid', raw, canonical, whenDone };
  } catch {
    return { type: 'invalid', code: 'unparseable-rule' };
  }
}

function recurrenceReference(
  planning: TaskPlanning,
  policy: RecurrencePolicy,
): LocalDate | undefined {
  if (policy.removeScheduledDate) return planning.due ?? planning.start ?? planning.scheduled;
  return planning.due ?? planning.scheduled ?? planning.start;
}

function utcDate(value: LocalDate): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(0, month - 1, day));
  result.setUTCFullYear(year, month - 1, day);
  return result;
}

function localDateFromUtc(value: Date): LocalDate {
  return localDate(
    `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`,
  );
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function clampedMonthStep(value: LocalDate, months: number): LocalDate | undefined {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const zeroBasedMonth = month - 1 + months;
  const nextYear = year + Math.floor(zeroBasedMonth / 12);
  const nextMonth = (((zeroBasedMonth % 12) + 12) % 12) + 1;
  if (nextYear < 0 || nextYear > 9999) return undefined;
  return localDate(
    `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(
      Math.min(day, daysInMonth(nextYear, nextMonth)),
    ).padStart(2, '0')}`,
  );
}

function clampedYearStep(value: LocalDate, years: number): LocalDate | undefined {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const nextYear = year + years;
  if (nextYear < 0 || nextYear > 9999) return undefined;
  return localDate(
    `${String(nextYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
      Math.min(day, daysInMonth(nextYear, month)),
    ).padStart(2, '0')}`,
  );
}

function isImplicitMonth(rule: RRule): boolean {
  return (
    rule.options.freq === RRule.MONTHLY &&
    rule.origOptions.bymonthday == null &&
    rule.origOptions.byweekday == null
  );
}

function isImplicitYear(rule: RRule): boolean {
  return (
    rule.options.freq === RRule.YEARLY &&
    rule.origOptions.bymonth == null &&
    rule.origOptions.bymonthday == null &&
    rule.origOptions.byweekday == null
  );
}

function nextRuleDate(rule: RRule, anchor: LocalDate): LocalDate | undefined {
  if (isImplicitMonth(rule)) {
    return clampedMonthStep(anchor, rule.options.interval);
  }
  if (isImplicitYear(rule)) {
    return clampedYearStep(anchor, rule.options.interval);
  }

  const anchorDate = utcDate(anchor);
  const anchoredRule = new RRule({ ...rule.origOptions, dtstart: anchorDate }, true);
  const next = anchoredRule.after(anchorDate, false);
  return next ? localDateFromUtc(next) : undefined;
}

function parsedRule(raw: string):
  | {
      readonly type: 'valid';
      readonly parsed: Extract<RecurrenceParseResult, { type: 'valid' }>;
      readonly rule: RRule;
    }
  | { readonly type: 'invalid'; readonly code: RecurrenceIssueCode } {
  const parsed = parseRecurrenceRule(raw);
  if (parsed.type === 'invalid') return parsed;
  const rule = compiledRules.get(parsed.canonical);
  if (!rule) return { type: 'invalid', code: 'unparseable-rule' };
  return { type: 'valid', parsed, rule };
}

function shiftedPlanning(
  planning: TaskPlanning,
  dayDelta: number,
  policy: RecurrencePolicy,
): TaskPlanning | undefined {
  const shifted: {
    due?: LocalDate;
    scheduled?: LocalDate;
    start?: LocalDate;
  } = {};
  for (const field of DATE_FIELDS) {
    if (field === 'scheduled' && policy.removeScheduledDate) continue;
    const value = planning[field];
    if (!value) continue;
    const next = shiftLocalDate(value, dayDelta);
    if (!next) return undefined;
    shifted[field] = next;
  }
  return {
    ...shifted,
    ...(planning.time !== undefined && { time: planning.time }),
    ...(planning.duration !== undefined && { duration: planning.duration }),
  };
}

export function nextOccurrencePlanning(input: NextOccurrenceInput): NextOccurrenceResult {
  const validated = parsedRule(input.rule);
  if (validated.type === 'invalid') return validated;
  const reference = recurrenceReference(input.planning, input.policy);
  if (!reference) return { type: 'next', planning: input.planning, dayDelta: 0 };
  const anchor = validated.parsed.whenDone ? input.completedOn : reference;
  const next = nextRuleDate(validated.rule, anchor);
  if (!next) return { type: 'invalid', code: 'forecast-limit-reached' };
  const dayDelta = daysBetweenLocalDates(reference, next);
  const planning = shiftedPlanning(input.planning, dayDelta, input.policy);
  if (!planning) return { type: 'invalid', code: 'invalid-descendant-date' };
  return { type: 'next', planning, dayDelta };
}

function directExpansion(
  rule: RRule,
  reference: LocalDate,
  visible: ExpandRecurrenceInput['visible'],
  maxVisible: 512,
): RecurrenceExpansionResult {
  const firstDay = shiftLocalDate(reference, 1);
  if (!firstDay || visible.from > visible.to) {
    return { type: 'invalid', code: 'invalid-descendant-date' };
  }
  const from = visible.from > firstDay ? visible.from : firstDay;
  if (from > visible.to) return { type: 'expanded', dates: [] };

  const anchoredRule = new RRule({ ...rule.origOptions, dtstart: utcDate(reference) }, true);
  const occurrences = anchoredRule.between(
    utcDate(from),
    utcDate(visible.to),
    true,
    (_date, length) => length <= maxVisible,
  );
  const dates = occurrences.slice(0, maxVisible).map(localDateFromUtc);
  return occurrences.length > maxVisible
    ? { type: 'limited', dates, phase: 'visible-occurrences', limit: maxVisible }
    : { type: 'expanded', dates };
}

function sequentialExpansion(
  rule: RRule,
  reference: LocalDate,
  visible: ExpandRecurrenceInput['visible'],
  maxVisible: 512,
  maxSequentialSteps: 4096,
): RecurrenceExpansionResult {
  if (visible.from > visible.to) return { type: 'invalid', code: 'invalid-descendant-date' };
  const dates: LocalDate[] = [];
  let current = reference;
  for (let step = 0; step < maxSequentialSteps; step++) {
    const next = nextRuleDate(rule, current);
    if (!next) return { type: 'invalid', code: 'forecast-limit-reached' };
    if (next > visible.to) return { type: 'expanded', dates };
    if (next >= visible.from) {
      if (dates.length === maxVisible) {
        return { type: 'limited', dates, phase: 'visible-occurrences', limit: maxVisible };
      }
      dates.push(next);
    }
    if (next === visible.to) return { type: 'expanded', dates };
    current = next;
  }
  return { type: 'limited', dates, phase: 'sequential-seek', limit: maxSequentialSteps };
}

export function expandRecurrenceReferences(
  input: ExpandRecurrenceInput,
): RecurrenceExpansionResult {
  const validated = parsedRule(input.rule);
  if (validated.type === 'invalid') return validated;
  const reference = recurrenceReference(input.planning, input.policy);
  if (!reference) return { type: 'invalid', code: 'recurrence-date-required' };
  if (isImplicitMonth(validated.rule) || isImplicitYear(validated.rule)) {
    return sequentialExpansion(
      validated.rule,
      reference,
      input.visible,
      input.maxVisible,
      input.maxSequentialSteps,
    );
  }
  return directExpansion(validated.rule, reference, input.visible, input.maxVisible);
}
