import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  expandRecurrenceReferences,
  nextOccurrencePlanning,
  parseRecurrenceRule,
} from '../../src/tasks/domain/recurrence';
import type { LocalDate, TaskPlanning } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';

const keepScheduled = { removeScheduledDate: false } as const;

function next(rule: string, planning: TaskPlanning, completedOn = '2040-01-01') {
  return nextOccurrencePlanning({
    rule,
    planning,
    completedOn: localDate(completedOn),
    policy: keepScheduled,
  });
}

function expandResult(rule: string, reference: string, from: string, to: string) {
  return expandRecurrenceReferences({
    rule,
    planning: { due: localDate(reference) },
    visible: { from: localDate(from), to: localDate(to) },
    policy: keepScheduled,
    maxVisible: 512,
    maxSequentialSteps: 4096,
  });
}

function expandedDates(
  rule: string,
  reference: string,
  from: string,
  to: string,
): readonly LocalDate[] {
  const result = expandResult(rule, reference, from, to);
  expect(result.type).toBe('expanded');
  return result.type === 'expanded' ? result.dates : [];
}

describe('parseRecurrenceRule', () => {
  it.each([
    ['every day', 'every day', false],
    ['every 2 weeks on Tuesday, Friday', 'every 2 weeks on Tuesday, Friday', false],
    ['every month on the last Friday when done', 'every month on the last Friday', true],
  ] as const)('parses %s', (raw, canonical, whenDone) => {
    expect(parseRecurrenceRule(raw)).toMatchObject({ type: 'valid', canonical, whenDone });
  });

  it.each([
    ['every week on Tuesday and Friday', 'every week on Tuesday, Friday'],
    ['every month on the second Tuesday', 'every month on the 2nd Tuesday'],
    ['every 1 day', 'every day'],
  ] as const)('canonicalizes %s without replacing raw input', (raw, canonical) => {
    expect(parseRecurrenceRule(raw)).toEqual({
      type: 'valid',
      raw,
      canonical,
      whenDone: false,
    });
  });

  it.each([
    ['case and whitespace', '  EVERY   WEEK  ', 'every week'],
    ['optional the', 'every month on last Friday', 'every month on the last Friday'],
    ['Oxford list', 'every week on Tuesday, and Friday', 'every week on Tuesday, Friday'],
    ['fourth ordinal', 'every month on the fourth Tuesday', 'every month on the 4th Tuesday'],
    ['fifth ordinal', 'every month on the fifth Tuesday', 'every month on the 5th Tuesday'],
    ['interval-one plural', 'every 1 days', 'every day'],
  ] as const)('accepts the supported %s alias', (_name, raw, canonical) => {
    expect(parseRecurrenceRule(raw)).toMatchObject({ type: 'valid', raw, canonical });
  });

  it.each([
    ['daily', 'every day', 'every day', false],
    ['numeric interval', 'every 2 days', 'every 2 days', false],
    ['weekday', 'every weekday', 'every weekday', false],
    [
      'weekly multi-day',
      'every week on Tuesday and Friday',
      'every week on Tuesday, Friday',
      false,
    ],
    ['implicit month', 'every month', 'every month', false],
    ['explicit month day', 'every month on the 31st', 'every month on the 31st', false],
    [
      'last monthly weekday',
      'every month on the last Friday',
      'every month on the last Friday',
      false,
    ],
    [
      'nth monthly weekday',
      'every month on the second Tuesday',
      'every month on the 2nd Tuesday',
      false,
    ],
    [
      '2nd-last monthly weekday',
      'every month on the 2nd last Friday',
      'every month on the 2nd last Friday',
      false,
    ],
    [
      'multiple month dates',
      'every month on the 1st and 15th',
      'every month on the 1st and 15th',
      false,
    ],
    ['yearly', 'every year', 'every year', false],
    ['leap date', 'every February on the 29th', 'every February on the 29th', false],
    ['when done', 'every week when done', 'every week', true],
  ] as const)('keeps documented %s grammar valid', (_name, raw, canonical, whenDone) => {
    expect(parseRecurrenceRule(raw)).toMatchObject({ type: 'valid', raw, canonical, whenDone });
  });

  it.each([
    ['weekly', 'must-start-with-every'],
    ['every day for 4 times', 'unsupported-recurrence-count'],
    ['every day until 2026-09-01', 'unsupported-recurrence-until'],
    ['every day when done trailing', 'invalid-when-done'],
    ['every hour when done', 'unparseable-rule'],
    ['every 2 months in January', 'unparseable-rule'],
    ['every day trailing', 'unparseable-rule'],
    ['every week on Funday', 'unparseable-rule'],
    ['every day on Monday', 'unparseable-rule'],
    ['every day the', 'unparseable-rule'],
    ['every week the', 'unparseable-rule'],
    ['every month on the 1nd Tuesday', 'unparseable-rule'],
    ['every month on the 2st Tuesday', 'unparseable-rule'],
    ['every month on the 11st Tuesday', 'unparseable-rule'],
    ['every week on Tuesday and and Friday', 'unparseable-rule'],
    ['every week on Tuesday,, Friday', 'unparseable-rule'],
    ['every week on Tuesday and, Friday', 'unparseable-rule'],
    ['every month on the 1st and and 15th', 'unparseable-rule'],
  ] as const)('rejects %s', (raw, code) => {
    expect(parseRecurrenceRule(raw)).toEqual({ type: 'invalid', code });
  });
});

describe('nextOccurrencePlanning', () => {
  it('does not inherit ambient rrule dtstart', () => {
    const input = {
      rule: 'every week on Monday',
      planning: { due: localDate('2026-08-03') },
      completedOn: localDate('2040-01-01'),
      policy: { removeScheduledDate: false },
    };

    expect(nextOccurrencePlanning(input)).toMatchObject({
      type: 'next',
      planning: { due: '2026-08-10' },
      dayDelta: 7,
    });
  });

  it.each([
    ['daily', 'every day', '2026-08-01', '2026-08-02', 1],
    ['weekdays across a weekend', 'every weekday', '2026-08-07', '2026-08-10', 3],
    ['numeric daily intervals', 'every 3 days', '2026-08-01', '2026-08-04', 3],
    ['multiple weekly weekdays', 'every week on Tuesday, Friday', '2026-08-04', '2026-08-07', 3],
    ['explicit month dates', 'every month on the 31st', '2026-01-31', '2026-03-31', 59],
    ['nth weekdays', 'every month on the 2nd Tuesday', '2026-01-13', '2026-02-10', 28],
    ['last weekdays', 'every month on the last Friday', '2026-01-30', '2026-02-27', 28],
    ['explicit leap dates', 'every February on the 29th', '2024-02-29', '2028-02-29', 1461],
  ] as const)('advances %s', (_name, rule, reference, expected, dayDelta) => {
    expect(next(rule, { due: localDate(reference) })).toEqual({
      type: 'next',
      planning: { due: expected },
      dayDelta,
    });
  });

  it('clamps an implicit month to the last valid day', () => {
    expect(next('every month', { due: localDate('2022-01-31') })).toEqual({
      type: 'next',
      planning: { due: '2022-02-28' },
      dayDelta: 28,
    });
  });

  it('clamps an implicit leap-year anniversary one step at a time', () => {
    expect(next('every year', { due: localDate('2024-02-29') })).toEqual({
      type: 'next',
      planning: { due: '2025-02-28' },
      dayDelta: 365,
    });
  });

  it('uses the reference date when completed early without when done', () => {
    expect(next('every week', { due: localDate('2026-08-10') }, '2026-08-05')).toEqual({
      type: 'next',
      planning: { due: '2026-08-17' },
      dayDelta: 7,
    });
  });

  it.each([
    ['early', '2026-08-05', '2026-08-12', 2],
    ['late', '2026-08-20', '2026-08-27', 17],
  ] as const)(
    'anchors an %s completion for terminal when done',
    (_name, completedOn, due, dayDelta) => {
      expect(next('every week when done', { due: localDate('2026-08-10') }, completedOn)).toEqual({
        type: 'next',
        planning: { due },
        dayDelta,
      });
    },
  );

  it('preserves an undated planning subtree without inventing a shift', () => {
    expect(next('every day', {}, '2026-08-01')).toEqual({
      type: 'next',
      planning: {},
      dayDelta: 0,
    });
  });

  it('shifts relative planning offsets from the due-date reference', () => {
    expect(
      next('every week', {
        start: localDate('2026-08-01'),
        scheduled: localDate('2026-08-02'),
        due: localDate('2026-08-03'),
      }),
    ).toEqual({
      type: 'next',
      planning: {
        start: '2026-08-08',
        scheduled: '2026-08-09',
        due: '2026-08-10',
      },
      dayDelta: 7,
    });
  });

  it('removes the scheduled date under policy while retaining other offsets', () => {
    expect(
      nextOccurrencePlanning({
        rule: 'every day',
        planning: {
          scheduled: localDate('2026-08-02'),
          due: localDate('2026-08-03'),
        },
        completedOn: localDate('2026-08-03'),
        policy: { removeScheduledDate: true },
      }),
    ).toEqual({
      type: 'next',
      planning: { due: '2026-08-04' },
      dayDelta: 1,
    });
  });

  it('uses start before scheduled as the reference when scheduled is removed', () => {
    expect(
      nextOccurrencePlanning({
        rule: 'every week on Tuesday',
        planning: {
          start: localDate('2026-08-01'),
          scheduled: localDate('2026-08-03'),
        },
        completedOn: localDate('2026-08-03'),
        policy: { removeScheduledDate: true },
      }),
    ).toEqual({
      type: 'next',
      planning: { start: '2026-08-04' },
      dayDelta: 3,
    });
  });

  it('returns a structured invalid result for an invalid rule', () => {
    expect(next('weekly', { due: localDate('2026-08-03') })).toEqual({
      type: 'invalid',
      code: 'must-start-with-every',
    });
  });
});

describe('expandRecurrenceReferences', () => {
  it('projects implicit month recurrence by repeated one-step clamping', () => {
    expect(expandedDates('every month', '2022-01-31', '2022-02-01', '2022-04-30')).toEqual([
      '2022-02-28',
      '2022-03-28',
      '2022-04-28',
    ]);
  });

  it('skips invalid dates for an explicit 31st rule', () => {
    expect(
      expandedDates('every month on the 31st', '2022-01-31', '2022-02-01', '2022-05-31'),
    ).toEqual(['2022-03-31', '2022-05-31']);
  });

  it('expands direct weekly occurrences inside inclusive visible bounds', () => {
    expect(
      expandedDates('every week on Tuesday, Friday', '2026-08-04', '2026-08-07', '2026-08-18'),
    ).toEqual(['2026-08-07', '2026-08-11', '2026-08-14', '2026-08-18']);
  });

  it('requires a recurrence date for forecasting an undated rule', () => {
    expect(
      expandRecurrenceReferences({
        rule: 'every day',
        planning: {},
        visible: { from: localDate('2026-08-01'), to: localDate('2026-08-31') },
        policy: keepScheduled,
        maxVisible: 512,
        maxSequentialSteps: 4096,
      }),
    ).toEqual({ type: 'invalid', code: 'recurrence-date-required' });
  });

  it('reports the visible occurrence cap instead of silently truncating', () => {
    const result = expandResult('every day', '2026-01-01', '2026-01-02', '2027-12-31');
    expect(result).toMatchObject({
      type: 'limited',
      phase: 'visible-occurrences',
      limit: 512,
    });
    expect(result.type === 'limited' ? result.dates : []).toHaveLength(512);
  });

  it('expands when the 4096th sequential step reaches the visible endpoint', () => {
    expect(expandResult('every month', '1000-01-31', '1341-05-28', '1341-05-28')).toEqual({
      type: 'expanded',
      dates: ['1341-05-28'],
    });
  });

  it('still reports the sequential seek cap when the range is unreachable', () => {
    expect(expandResult('every month', '1000-01-31', '1400-01-01', '1400-12-31')).toEqual({
      type: 'limited',
      dates: [],
      phase: 'sequential-seek',
      limit: 4096,
    });
  });

  it('is timezone independent in spawned Vitest processes', () => {
    if (process.env.RECURRENCE_TZ_CHILD === '1') {
      expect(next('every weekday', { due: localDate('2026-08-07') })).toMatchObject({
        type: 'next',
        planning: { due: '2026-08-10' },
      });
      expect(expandedDates('every month', '2022-01-31', '2022-02-01', '2022-04-30')).toEqual([
        '2022-02-28',
        '2022-03-28',
        '2022-04-28',
      ]);
      return;
    }

    for (const timezone of ['UTC', 'America/Los_Angeles']) {
      execFileSync(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          'test/tasks/recurrence.test.ts',
          '-t',
          'timezone independent',
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: timezone, RECURRENCE_TZ_CHILD: '1' },
          stdio: 'pipe',
        },
      );
    }
  });
});
