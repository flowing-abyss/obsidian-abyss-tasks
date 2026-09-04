import { RRule, type Options } from 'rrule';
import { daysBetweenLocalDates, shiftLocalDate } from './localDateMath';
import type { LocalDate, TaskPlanning } from './types';
import { localDate } from './valueObjects';

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

interface CompiledRuleEntry {
  readonly canonical: string;
  readonly whenDone: boolean;
  readonly rule: RRule;
}

const MAX_COMPILED_RULES = 256;
const compiledRulesByRaw = new Map<string, CompiledRuleEntry>();
const DATE_FIELDS = ['start', 'scheduled', 'due'] as const;

function normalizedRuleText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function compiledRule(raw: string): CompiledRuleEntry | undefined {
  const key = normalizedRuleText(raw);
  const cached = compiledRulesByRaw.get(key);
  if (cached == null) return undefined;
  compiledRulesByRaw.delete(key);
  compiledRulesByRaw.set(key, cached);
  return cached;
}

function cacheCompiledRule(raw: string, entry: CompiledRuleEntry): void {
  const key = normalizedRuleText(raw);
  compiledRulesByRaw.set(key, entry);
  while (compiledRulesByRaw.size > MAX_COMPILED_RULES) {
    const oldest = compiledRulesByRaw.keys().next().value;
    if (oldest === undefined) break;
    compiledRulesByRaw.delete(oldest);
  }
}

const WORD_ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

const PARSER_WORD_ORDINALS: Readonly<Record<string, string>> = {
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
};

function parserGrammarText(value: string): string {
  return value.replace(
    /\b(first|second|third|fourth|fifth)\b/giu,
    (word) => PARSER_WORD_ORDINALS[word.toLowerCase()] ?? word,
  );
}

const WEEKDAYS = new Map([
  ['monday', 'mo'],
  ['tuesday', 'tu'],
  ['wednesday', 'we'],
  ['thursday', 'th'],
  ['friday', 'fr'],
  ['saturday', 'sa'],
  ['sunday', 'su'],
]);

const MONTHS = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
]);

function ordinalSuffix(value: number): 'st' | 'nd' | 'rd' | 'th' {
  const lastTwoDigits = value % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return 'th';
  if (value % 10 === 1) return 'st';
  if (value % 10 === 2) return 'nd';
  if (value % 10 === 3) return 'rd';
  return 'th';
}

function grammarOrdinal(value: string, maximum: number): number | undefined {
  const wordOrdinal = WORD_ORDINALS[value];
  if (wordOrdinal !== undefined) return wordOrdinal <= maximum ? wordOrdinal : undefined;

  const numericOrdinal = /^(\d+)(st|nd|rd|th)$/u.exec(value);
  if (numericOrdinal === null) return undefined;
  const ordinal = Number(numericOrdinal[1]);
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > maximum ||
    numericOrdinal[2] !== ordinalSuffix(ordinal)
  ) {
    return undefined;
  }
  return ordinal;
}

function grammarItems(value: string): string[] | undefined {
  const conjunctions = [...value.matchAll(/\band\b/gu)];
  if (conjunctions.length > 1) return undefined;
  if (conjunctions.length === 0) return value.split(',');
  const conjunction = conjunctions[0];
  if (conjunction === undefined) return undefined;
  let before = value.slice(0, conjunction.index).trimEnd();
  const after = value.slice(conjunction.index + 'and'.length).trimStart();
  if (before.endsWith(',')) before = before.slice(0, -1).trimEnd();
  const items = [...before.split(','), after];
  return items.length < 2 ? undefined : items;
}

function grammarList<T>(
  value: string,
  parseItem: (item: string) => T | undefined,
): readonly T[] | undefined {
  const items = grammarItems(value);
  if (items === undefined) return undefined;
  const parsed: T[] = [];
  const seen = new Set<T>();
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length === 0) return undefined;
    const parsedItem = parseItem(trimmed);
    if (parsedItem === undefined || seen.has(parsedItem)) return undefined;
    seen.add(parsedItem);
    parsed.push(parsedItem);
  }
  return parsed;
}

function unorderedListKey(values: ReadonlyArray<number | string>): string {
  return values
    .map(String)
    .sort((left, right) => left.localeCompare(right))
    .join(',');
}

function optionalLeadingThe(value: string): string | undefined {
  if (!value.startsWith('the ')) return value;
  const withoutThe = value.slice('the '.length);
  return withoutThe.startsWith('the ') ? undefined : withoutThe;
}

function monthlyWeekdayClause(tokens: readonly string[], weekday: string): string | undefined {
  if (tokens.length === 2 && tokens[0] === 'last') return `weekday:-1:${weekday}`;
  if (tokens.length === 2) {
    const ordinal = grammarOrdinal(tokens[0] ?? '', 5);
    return ordinal === undefined ? undefined : `weekday:${ordinal}:${weekday}`;
  }
  if (tokens.length !== 3 || tokens[1] !== 'last') return undefined;
  const ordinal = grammarOrdinal(tokens[0] ?? '', 5);
  return ordinal === undefined ? undefined : `weekday:-${ordinal}:${weekday}`;
}

function monthlyClauseKey(value: string): string | undefined {
  const clause = optionalLeadingThe(value);
  if (clause === undefined) return undefined;
  if (clause === 'last') return 'dates:-1';

  const tokens = clause.split(' ');
  const weekday = WEEKDAYS.get(tokens[tokens.length - 1] ?? '');
  if (weekday !== undefined) return monthlyWeekdayClause(tokens, weekday);

  const dates = grammarList(clause, (item) => grammarOrdinal(item, 31));
  return dates === undefined ? undefined : `dates:${unorderedListKey(dates)}`;
}

function annualDateClause(value: string): readonly number[] | undefined {
  const clause = optionalLeadingThe(value);
  if (clause === undefined) return undefined;
  if (clause === 'last') return [-1];
  return grammarList(clause, (item) => grammarOrdinal(item, 31));
}

function intervalKey(
  rawInterval: string | undefined,
  unit: string,
  singular: string,
): number | undefined {
  const interval = rawInterval === undefined ? 1 : Number(rawInterval);
  if (!Number.isSafeInteger(interval) || interval < 1) return undefined;
  const expectedUnit = interval === 1 ? singular : `${singular}s`;
  if (unit !== expectedUnit && !(interval === 1 && unit === `${singular}s`)) return undefined;
  return interval;
}

interface SupportedGrammar {
  readonly key: string;
  readonly yearlyDates?: {
    readonly months: readonly number[];
    readonly monthDays: readonly number[];
  };
}

function authoredAnnualGrammar(match: RegExpExecArray): SupportedGrammar | undefined {
  const unit = match[2];
  const monthName = match[3];
  const dateClause = match[4];
  if (unit === undefined || monthName === undefined || dateClause === undefined) return undefined;
  const interval = intervalKey(match[1], unit, 'year');
  const month = MONTHS.get(monthName);
  const monthDays = annualDateClause(dateClause);
  if (interval === undefined || month === undefined || monthDays === undefined) return undefined;
  return {
    key: `annual:${interval}:${month}:${unorderedListKey(monthDays)}`,
    yearlyDates: { months: [month], monthDays },
  };
}

function canonicalAnnualGrammar(match: RegExpExecArray): SupportedGrammar | undefined {
  const unit = match[2];
  const monthClause = match[3];
  const dateClause = match[4];
  if (unit === undefined || monthClause === undefined || dateClause === undefined) return undefined;
  const interval = intervalKey(match[1], unit, 'year');
  const months = grammarList(monthClause, (item) => MONTHS.get(item));
  const monthDays = annualDateClause(dateClause);
  if (interval === undefined || months === undefined || monthDays === undefined) return undefined;
  return {
    key: `annual:${interval}:${unorderedListKey(months)}:${unorderedListKey(monthDays)}`,
    yearlyDates: { months, monthDays },
  };
}

function namedMonthAnnualGrammar(match: RegExpExecArray): SupportedGrammar | undefined {
  const monthClause = match[1];
  const dateClause = match[2];
  if (monthClause === undefined || dateClause === undefined) return undefined;
  const months = grammarList(monthClause, (item) => MONTHS.get(item));
  const monthDays = annualDateClause(dateClause);
  if (months === undefined || monthDays === undefined) return undefined;
  return {
    key: `annual:1:${unorderedListKey(months)}:${unorderedListKey(monthDays)}`,
    yearlyDates: { months, monthDays },
  };
}

function annualGrammar(body: string): SupportedGrammar | undefined {
  const authoredInterval = /^(?:(\d+) )?(year|years) on (\w+) (.+)$/u.exec(body);
  if (authoredInterval !== null) return authoredAnnualGrammar(authoredInterval);

  const canonicalInterval = /^(?:(\d+) )?(year|years) (.+) on (.+)$/u.exec(body);
  if (canonicalInterval !== null) return canonicalAnnualGrammar(canonicalInterval);

  const namedMonths = /^(.+) on (.+)$/u.exec(body);
  return namedMonths === null ? undefined : namedMonthAnnualGrammar(namedMonths);
}

function weeklyGrammar(interval: number, clause: string | undefined): SupportedGrammar | undefined {
  if (clause === undefined) return { key: `week:${interval}` };
  const weekdays = grammarList(clause, (item) => WEEKDAYS.get(item));
  return weekdays === undefined
    ? undefined
    : { key: `week:${interval}:${unorderedListKey(weekdays)}` };
}

function monthlyGrammar(
  interval: number,
  clause: string | undefined,
): SupportedGrammar | undefined {
  if (clause === undefined) return { key: `month:${interval}` };
  const monthlyClause = monthlyClauseKey(clause);
  return monthlyClause === undefined ? undefined : { key: `month:${interval}:${monthlyClause}` };
}

function unitGrammar(match: RegExpExecArray): SupportedGrammar | undefined {
  const [, rawInterval, unit, clause] = match;
  if (unit === undefined) return undefined;
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  const interval = intervalKey(rawInterval, unit, singular);
  if (interval === undefined) return undefined;
  if (singular === 'day' || singular === 'weekday' || singular === 'year') {
    return clause === undefined ? { key: `${singular}:${interval}` } : undefined;
  }
  if (singular === 'week') return weeklyGrammar(interval, clause);
  if (singular === 'month') return monthlyGrammar(interval, clause);
  return undefined;
}

function supportedGrammar(value: string): SupportedGrammar | undefined {
  const text = normalizedRuleText(value).toLowerCase();
  if (!text.startsWith('every ')) return undefined;
  const body = text.slice('every '.length);

  const annual = annualGrammar(body);
  if (annual !== undefined) return annual;

  const unitRule =
    /^(?:(\d+) )?(day|days|weekday|weekdays|week|weeks|month|months|year|years)(?: on (.+))?$/u.exec(
      body,
    );
  return unitRule === null ? undefined : unitGrammar(unitRule);
}

function hasOnlySupportedOptions(options: Partial<Options>): boolean {
  const common = ['freq', 'interval'] as const satisfies ReadonlyArray<keyof Options>;
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

function preliminaryRecurrenceIssue(normalized: string): RecurrenceIssueCode | undefined {
  if (!/^every\b/iu.test(normalized)) return 'must-start-with-every';
  if (/\bfor\s+\d+\s+times?\b/iu.test(normalized)) return 'unsupported-recurrence-count';
  return /\buntil\b/iu.test(normalized) ? 'unsupported-recurrence-until' : undefined;
}

type WhenDoneParseResult =
  | { readonly type: 'valid'; readonly whenDone: boolean; readonly ruleText: string }
  | { readonly type: 'invalid'; readonly code: 'invalid-when-done' };

function parseWhenDone(normalized: string): WhenDoneParseResult {
  const matches = normalized.match(/\bwhen\s+done\b/giu) ?? [];
  if (matches.length > 1 || (matches.length === 1 && !/\bwhen\s+done$/iu.test(normalized))) {
    return { type: 'invalid', code: 'invalid-when-done' };
  }
  const whenDone = matches.length === 1;
  const ruleText = whenDone
    ? normalized.slice(0, normalized.length - ' when done'.length)
    : normalized;
  return { type: 'valid', whenDone, ruleText };
}

interface CompileRecurrenceContext {
  readonly raw: string;
  readonly normalized: string;
  readonly grammar: SupportedGrammar;
  readonly whenDone: boolean;
  readonly ruleText: string;
}

function compileRecurrence(context: CompileRecurrenceContext): RecurrenceParseResult {
  try {
    const options = RRule.parseText(parserGrammarText(context.ruleText));
    if (context.grammar.yearlyDates !== undefined) {
      options.bymonth = [...context.grammar.yearlyDates.months];
      options.bymonthday = [...context.grammar.yearlyDates.monthDays];
    }
    if (!hasOnlySupportedOptions(options)) return { type: 'invalid', code: 'unparseable-rule' };
    const compiled = new RRule({ ...options, dtstart: utcDate(localDate('2000-01-01')) });
    const canonical = compiled.toText();
    if (supportedGrammar(canonical)?.key !== context.grammar.key) {
      return { type: 'invalid', code: 'unparseable-rule' };
    }
    cacheCompiledRule(context.normalized, {
      canonical,
      whenDone: context.whenDone,
      rule: compiled,
    });
    return { type: 'valid', raw: context.raw, canonical, whenDone: context.whenDone };
  } catch {
    return { type: 'invalid', code: 'unparseable-rule' };
  }
}

export function parseRecurrenceRule(raw: string): RecurrenceParseResult {
  const normalized = normalizedRuleText(raw);
  const cached = compiledRule(normalized);
  if (cached !== undefined) {
    return {
      type: 'valid',
      raw,
      canonical: cached.canonical,
      whenDone: cached.whenDone,
    };
  }
  const preliminaryIssue = preliminaryRecurrenceIssue(normalized);
  if (preliminaryIssue !== undefined) return { type: 'invalid', code: preliminaryIssue };
  const whenDone = parseWhenDone(normalized);
  if (whenDone.type === 'invalid') return whenDone;
  const inputGrammar = supportedGrammar(whenDone.ruleText);
  if (inputGrammar === undefined) {
    return { type: 'invalid', code: 'unparseable-rule' };
  }
  return compileRecurrence({
    raw,
    normalized,
    grammar: inputGrammar,
    whenDone: whenDone.whenDone,
    ruleText: whenDone.ruleText,
  });
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
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined) throw new RangeError(`Invalid month: ${month}`);
  return days;
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
  return next != null ? localDateFromUtc(next) : undefined;
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
  const rule = compiledRule(raw)?.rule;
  if (rule == null) return { type: 'invalid', code: 'unparseable-rule' };
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
    if (value == null) continue;
    const next = shiftLocalDate(value, dayDelta);
    if (next == null) return undefined;
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
  if (reference == null) return { type: 'next', planning: input.planning, dayDelta: 0 };
  const anchor = validated.parsed.whenDone ? input.completedOn : reference;
  const next = nextRuleDate(validated.rule, anchor);
  if (next == null) return { type: 'invalid', code: 'forecast-limit-reached' };
  const dayDelta = daysBetweenLocalDates(reference, next);
  const planning = shiftedPlanning(input.planning, dayDelta, input.policy);
  if (planning == null) return { type: 'invalid', code: 'invalid-descendant-date' };
  return { type: 'next', planning, dayDelta };
}

function directExpansion(
  rule: RRule,
  reference: LocalDate,
  visible: ExpandRecurrenceInput['visible'],
  maxVisible: 512,
): RecurrenceExpansionResult {
  const firstDay = shiftLocalDate(reference, 1);
  if (firstDay == null || visible.from > visible.to) {
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

interface SequentialExpansionInput {
  readonly rule: RRule;
  readonly reference: LocalDate;
  readonly visible: ExpandRecurrenceInput['visible'];
  readonly maxVisible: 512;
  readonly maxSequentialSteps: 4096;
}

function sequentialVisibleResult(
  next: LocalDate,
  context: SequentialExpansionInput,
  dates: LocalDate[],
): RecurrenceExpansionResult | undefined {
  if (next > context.visible.to) return { type: 'expanded', dates };
  if (next >= context.visible.from) {
    if (dates.length === context.maxVisible) {
      return {
        type: 'limited',
        dates,
        phase: 'visible-occurrences',
        limit: context.maxVisible,
      };
    }
    dates.push(next);
  }
  return next === context.visible.to ? { type: 'expanded', dates } : undefined;
}

function sequentialExpansion(context: SequentialExpansionInput): RecurrenceExpansionResult {
  const { rule, reference, visible, maxSequentialSteps } = context;
  if (visible.from > visible.to) return { type: 'invalid', code: 'invalid-descendant-date' };
  const dates: LocalDate[] = [];
  let current = reference;
  for (let step = 0; step < maxSequentialSteps; step++) {
    const next = nextRuleDate(rule, current);
    if (next == null) return { type: 'invalid', code: 'forecast-limit-reached' };
    const result = sequentialVisibleResult(next, context, dates);
    if (result !== undefined) return result;
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
  if (reference == null) return { type: 'invalid', code: 'recurrence-date-required' };
  if (isImplicitMonth(validated.rule) || isImplicitYear(validated.rule)) {
    return sequentialExpansion({
      rule: validated.rule,
      reference,
      visible: input.visible,
      maxVisible: input.maxVisible,
      maxSequentialSteps: input.maxSequentialSteps,
    });
  }
  return directExpansion(validated.rule, reference, input.visible, input.maxVisible);
}
