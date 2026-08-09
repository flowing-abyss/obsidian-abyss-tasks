import { describe, expect, it } from 'vitest';
import { localDate } from '../src/tasks';
import {
  buildRecurrenceRule,
  recurrencePresetRule,
  type MonthlyChoice,
  type Weekday,
  type YearlyChoice,
} from '../src/ui/recurrence/recurrenceEditorModel';

const sameDate = { type: 'same-date' } as const;

function build(
  overrides: Partial<{
    interval: number;
    unit: 'days' | 'weeks' | 'months' | 'years';
    weekdays: readonly Weekday[];
    monthly: MonthlyChoice;
    yearly: YearlyChoice;
    whenDone: boolean;
  }> = {},
) {
  return buildRecurrenceRule({
    interval: 1,
    unit: 'days',
    weekdays: [],
    monthly: sameDate,
    yearly: sameDate,
    whenDone: false,
    ...overrides,
  });
}

describe('recurrencePresetRule', () => {
  it.each([
    ['daily', 'every day'],
    ['weekdays', 'every weekday'],
    ['weekly', 'every week on Sunday'],
    ['monthly', 'every month'],
    ['yearly', 'every year'],
  ] as const)('serializes the %s preset exactly', (preset, expected) => {
    expect(recurrencePresetRule(preset, localDate('2026-08-09'))).toBe(expected);
  });

  it('derives weekly preset weekdays from the supplied local date without ambient timezone input', () => {
    expect(recurrencePresetRule('weekly', localDate('2026-08-10'))).toBe('every week on Monday');
  });
});

describe('buildRecurrenceRule', () => {
  it.each([
    [{ interval: 1, unit: 'days' as const }, 'every day'],
    [{ interval: 3, unit: 'days' as const }, 'every 3 days'],
    [{ interval: 1, unit: 'weeks' as const }, 'every week'],
    [{ interval: 2, unit: 'weeks' as const }, 'every 2 weeks'],
    [{ interval: 1, unit: 'months' as const }, 'every month'],
    [{ interval: 4, unit: 'months' as const }, 'every 4 months'],
    [{ interval: 1, unit: 'years' as const }, 'every year'],
    [{ interval: 5, unit: 'years' as const }, 'every 5 years'],
  ])('serializes positive numeric unit input %#', (input, raw) => {
    expect(build(input)).toMatchObject({ type: 'valid', raw, canonical: raw });
  });

  it('orders weekly choices Monday through Sunday and ignores duplicates', () => {
    expect(
      build({
        interval: 2,
        unit: 'weeks',
        weekdays: ['Sunday', 'Thursday', 'Monday', 'Thursday'],
      }),
    ).toMatchObject({
      type: 'valid',
      raw: 'every 2 weeks on Monday, Thursday and Sunday',
      canonical: 'every 2 weeks on Monday, Thursday, Sunday',
    });
  });

  it('does not leak hidden controls after the unit changes', () => {
    expect(
      build({
        interval: 3,
        unit: 'days',
        weekdays: ['Monday'],
        monthly: { type: 'weekday', ordinal: -2, weekday: 'Friday' },
        yearly: { type: 'date', month: 12, day: 31 },
      }),
    ).toMatchObject({ type: 'valid', raw: 'every 3 days' });
  });

  it.each([
    [{ type: 'day', day: 21 } as const, 'every month on the 21st'],
    [{ type: 'edge', edge: 'first' } as const, 'every month on the first'],
    [{ type: 'edge', edge: 'last' } as const, 'every month on the last'],
    [
      { type: 'weekday', ordinal: 2, weekday: 'Tuesday' } as const,
      'every month on the 2nd Tuesday',
    ],
    [
      { type: 'weekday', ordinal: -1, weekday: 'Friday' } as const,
      'every month on the last Friday',
    ],
    [
      { type: 'weekday', ordinal: -2, weekday: 'Monday' } as const,
      'every month on the 2nd last Monday',
    ],
  ])('serializes supported monthly choices %#', (monthly, raw) => {
    expect(build({ unit: 'months', monthly })).toMatchObject({ type: 'valid', raw });
  });

  it('serializes an explicit yearly calendar date', () => {
    expect(build({ unit: 'years', yearly: { type: 'date', month: 3, day: 14 } })).toMatchObject({
      type: 'valid',
      raw: 'every March on the 14th',
      canonical: 'every March on the 14th',
    });
  });

  it('returns the production parser validation result for unsupported advanced combinations', () => {
    expect(
      build({ interval: 2, unit: 'years', yearly: { type: 'date', month: 2, day: 29 } }),
    ).toEqual({ type: 'invalid', code: 'unparseable-rule' });
  });

  it('appends when done before delegating to the production parser', () => {
    expect(
      build({ interval: 2, unit: 'weeks', weekdays: ['Wednesday'], whenDone: true }),
    ).toMatchObject({
      type: 'valid',
      raw: 'every 2 weeks on Wednesday when done',
      canonical: 'every 2 weeks on Wednesday',
      whenDone: true,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects non-positive or non-integral interval %s',
    (interval) => {
      expect(build({ interval })).toEqual({ type: 'invalid', code: 'unparseable-rule' });
    },
  );
});
