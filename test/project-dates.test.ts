import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  moveProjectDateByCivilDays,
  parseProjectDate,
  parseProjectRange,
  projectDateOnLocalDate,
} from '../src/projects/projectDates';

describe('parseProjectDate', () => {
  it.each([
    ['2026-08-26', 'date'],
    ['2026-08-26T14:30:00+07:00', 'datetime'],
  ] as const)('parses %s without losing precision', (raw, precision) => {
    expect(parseProjectDate(raw)).toMatchObject({ raw, precision });
  });

  it('preserves an Atom offset and its represented instant', () => {
    expect(parseProjectDate('2026-08-26T14:30:00+07:00')).toEqual({
      raw: '2026-08-26T14:30:00+07:00',
      precision: 'datetime',
      instantMs: Date.parse('2026-08-26T07:30:00.000Z'),
      offsetMinutes: 420,
    });
  });

  it.each([
    ['2026-08-26T14:30:00+15:00', 900],
    ['2026-08-26T14:30:00+23:59', 1439],
  ] as const)(
    'accepts RFC3339 numeric offset %s through the 23:59 boundary',
    (raw, offsetMinutes) => {
      expect(parseProjectDate(raw)).toMatchObject({ raw, precision: 'datetime', offsetMinutes });
    },
  );

  it.each([
    '2026-02-30',
    '2026-08-26T14:30:00',
    '2026-08-26T25:00:00+07:00',
    '2026-08-26T14:30:00+24:00',
    '2026-08-26T14:30:00+23:60',
    '2026-08-26T14:30:00+1500',
    '2026-08-26T14:30:00-00:00',
    'August 26, 2026',
  ])('rejects invalid or imprecise value %s', (raw) => {
    expect(parseProjectDate(raw)).toBeUndefined();
  });
});

describe('parseProjectRange', () => {
  it('reports the endpoint that is invalid without repairing either raw value', () => {
    expect(parseProjectRange('not-a-date', '2026-08-30')).toEqual({
      end: {
        raw: '2026-08-30',
        precision: 'date',
        instantMs: Date.UTC(2026, 7, 30),
      },
      issue: 'invalid-start',
    });
    expect(parseProjectRange('2026-08-20', 'not-a-date')).toMatchObject({
      start: { raw: '2026-08-20' },
      issue: 'invalid-end',
    });
  });

  it('keeps a reversed range diagnostic instead of reordering endpoints', () => {
    const range = parseProjectRange('2026-08-30', '2026-08-20');

    expect(range).toMatchObject({
      start: { raw: '2026-08-30' },
      end: { raw: '2026-08-20' },
      issue: 'reversed',
    });
  });
});

describe('projectDateOnLocalDate', () => {
  it('moves a datetime endpoint to another civil date without changing its time or offset text', () => {
    const observed = parseProjectDate('2026-08-26T14:30:00.125+07:00')!;

    expect(projectDateOnLocalDate(observed, '2026-09-01')).toEqual({
      raw: '2026-09-01T14:30:00.125+07:00',
      precision: 'datetime',
      instantMs: Date.parse('2026-09-01T07:30:00.125Z'),
      offsetMinutes: 420,
    });
  });

  it('keeps a date endpoint at date precision and rejects an invalid destination', () => {
    const observed = parseProjectDate('2026-08-26')!;

    expect(projectDateOnLocalDate(observed, '2026-09-01')).toMatchObject({
      raw: '2026-09-01',
      precision: 'date',
    });
    expect(projectDateOnLocalDate(observed, '2026-09-31')).toBeUndefined();
  });
});

describe('civil-day movement', () => {
  it('uses Gregorian calendar boundaries instead of local elapsed milliseconds', () => {
    expect(addCivilDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCivilDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addCivilDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('keeps date precision and the complete Atom suffix when moving an endpoint', () => {
    expect(moveProjectDateByCivilDays(parseProjectDate('2026-03-07')!, 1)?.raw).toBe('2026-03-08');
    expect(
      moveProjectDateByCivilDays(parseProjectDate('2026-11-01T01:30:00.123456-04:00')!, 1)?.raw,
    ).toBe('2026-11-02T01:30:00.123456-04:00');
  });
});
