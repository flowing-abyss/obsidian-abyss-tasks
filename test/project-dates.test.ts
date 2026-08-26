import { describe, expect, it } from 'vitest';
import { parseProjectDate, parseProjectRange } from '../src/projects/projectDates';

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
