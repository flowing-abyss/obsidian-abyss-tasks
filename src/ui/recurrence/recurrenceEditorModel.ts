import { type LocalDate, parseRecurrenceRule, type RecurrenceParseResult } from '../../tasks';

export type Weekday =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

export type MonthlyChoice =
  | { readonly type: 'same-date' }
  | { readonly type: 'day'; readonly day: number }
  | { readonly type: 'edge'; readonly edge: 'first' | 'last' }
  | {
      readonly type: 'weekday';
      readonly ordinal: 1 | 2 | 3 | 4 | -1 | -2;
      readonly weekday: Weekday;
    };

export type YearlyChoice =
  | { readonly type: 'same-date' }
  | {
      readonly type: 'date';
      readonly month: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
      readonly day: number;
    };

type RecurrenceUnit = 'days' | 'weeks' | 'months' | 'years';

const WEEKDAYS: readonly Weekday[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function weekdayFromLocalDate(value: LocalDate): Weekday {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAYS[(weekday + 6) % 7]!;
}

export function recurrencePresetRule(
  preset: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly',
  referenceDate: LocalDate,
): string {
  if (preset === 'daily') return 'every day';
  if (preset === 'weekdays') return 'every weekday';
  if (preset === 'weekly') return `every week on ${weekdayFromLocalDate(referenceDate)}`;
  if (preset === 'monthly') return 'every month';
  return 'every year';
}

function ordinal(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function unitRule(interval: number, unit: RecurrenceUnit): string {
  const singular = unit.slice(0, -1);
  return interval === 1 ? `every ${singular}` : `every ${String(interval)} ${unit}`;
}

function serializeControls(input: {
  readonly interval: number;
  readonly unit: RecurrenceUnit;
  readonly weekdays: readonly Weekday[];
  readonly monthly: MonthlyChoice;
  readonly yearly: YearlyChoice;
}): string {
  const base = unitRule(input.interval, input.unit);
  if (input.unit === 'days') return base;
  if (input.unit === 'weeks') {
    const selected = WEEKDAYS.filter((weekday) => input.weekdays.includes(weekday));
    return selected.length === 0 ? base : `${base} on ${naturalList(selected)}`;
  }
  if (input.unit === 'months') {
    if (input.monthly.type === 'same-date') return base;
    if (input.monthly.type === 'day') return `${base} on the ${ordinal(input.monthly.day)}`;
    if (input.monthly.type === 'edge') return `${base} on the ${input.monthly.edge}`;
    let ordinalText = ordinal(input.monthly.ordinal);
    if (input.monthly.ordinal === -1) ordinalText = 'last';
    if (input.monthly.ordinal === -2) ordinalText = '2nd last';
    return `${base} on the ${ordinalText} ${input.monthly.weekday}`;
  }
  if (input.yearly.type === 'same-date') return base;
  const month = MONTHS[input.yearly.month - 1];
  return input.interval === 1
    ? `every ${month} on the ${ordinal(input.yearly.day)}`
    : `${base} on ${month} ${ordinal(input.yearly.day)}`;
}

export function buildRecurrenceRule(input: {
  readonly interval: number;
  readonly unit: RecurrenceUnit;
  readonly weekdays: readonly Weekday[];
  readonly monthly: MonthlyChoice;
  readonly yearly: YearlyChoice;
  readonly whenDone: boolean;
}): RecurrenceParseResult {
  const raw = serializeControls(input);
  return parseRecurrenceRule(input.whenDone ? `${raw} when done` : raw);
}
