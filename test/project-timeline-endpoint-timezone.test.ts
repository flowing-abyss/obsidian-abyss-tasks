import { describe, expect, it } from 'vitest';
import { parseProjectDate, projectCalendarDay } from '../src/projects/projectDateValue';
import { planProjectTimelineEndpointEdit } from '../src/projects/projectTimelineEndpointEdits';

function move(value: string, startDay: string, deltaDays: number) {
  return planProjectTimelineEndpointEdit(
    { kind: 'open-end', startDay },
    { start: { exists: true, value }, end: { exists: false, value: undefined } },
    { type: 'move', deltaDays },
  );
}
function expectMove(value: string, day: string, target: string, expected: string) {
  const result = move(value, day, 1);
  expect(result).toEqual({
    kind: 'ready',
    range: { kind: 'open-end', startDay: target },
    start: { exists: true, value: expected },
    end: { exists: false, value: undefined },
  });
  if (result.kind === 'ready') expect(projectCalendarDay(result.start.value)).toBe(target);
}

describe('Timeline endpoint process timezone', () => {
  it('retains exact local precision in every process timezone', () => {
    expectMove('2026-09-03T09:30:15.120', '2026-09-03', '2026-09-04', '2026-09-04T09:30:15.120');
  });
  if (process.env['TZ'] === 'America/New_York') {
    it.each([
      ['2026-03-07T14:30Z', '2026-03-07', '2026-03-08', '2026-03-08T13:30Z'],
      ['2026-03-07T16:30:15.12+02:00', '2026-03-07', '2026-03-08', '2026-03-08T15:30:15.12+02:00'],
      ['2026-10-31T01:30', '2026-10-31', '2026-11-01', '2026-11-01T01:30'],
    ])('retains displayed clock for %s across DST', (value, day, target, expected) => {
      expectMove(value, day, target, expected);
    });
    it('rejects a nonexistent clock rather than normalizing or skipping a day', () => {
      expect(move('2026-03-07T02:30', '2026-03-07', 1)).toMatchObject({
        kind: 'rejected',
        reason: expect.stringMatching(/does not exist/u) as unknown,
      });
    });
    it('chooses the earlier repeated clock but retains an untouched later occurrence', () => {
      const result = move('2026-10-31T01:30', '2026-10-31', 1);
      expect(result.kind).toBe('ready');
      if (result.kind === 'ready')
        expect(parseProjectDate(result.start.value)?.value.toISOString()).toBe(
          '2026-11-01T05:30:00.000Z',
        );
      expect(move('2026-11-01T01:30:00-05:00', '2026-11-01', 0)).toMatchObject({
        kind: 'ready',
        start: { value: '2026-11-01T01:30:00-05:00' },
      });
    });
    it('rejects a whole move whose retained clocks reverse after a repeated hour', () => {
      const result = planProjectTimelineEndpointEdit(
        { kind: 'closed', startDay: '2026-11-01', endDay: '2026-11-01' },
        {
          start: { exists: true, value: '2026-11-01T01:45-04:00' },
          end: { exists: true, value: '2026-11-01T01:30-05:00' },
        },
        { type: 'move', deltaDays: 1 },
      );
      expect(result).toMatchObject({
        kind: 'rejected',
        reason: expect.stringMatching(/reverse/u) as unknown,
      });
    });
    it('adds seconds when historical offset precision requires them', () => {
      const result = planProjectTimelineEndpointEdit(
        { kind: 'open-end', startDay: '1900-01-01' },
        {
          start: { exists: true, value: '1900-01-01T14:30Z' },
          end: { exists: false, value: undefined },
        },
        { type: 'setStart', day: '1800-01-01' },
      );
      expect(result).toMatchObject({
        kind: 'ready',
        range: { kind: 'open-end', startDay: '1800-01-01' },
        start: { value: '1800-01-01T14:26:02Z' },
      });
    });
  }
  if (process.env['TZ'] === 'Asia/Novosibirsk') {
    it('moves by displayed day across UTC midnight', () => {
      expectMove('2026-09-03T23:30Z', '2026-09-04', '2026-09-05', '2026-09-04T23:30Z');
    });
  }
  if (process.env['TZ'] === 'UTC') {
    it('retains explicit zero offset and fraction precision', () => {
      expectMove(
        '2026-09-03T23:30:15.12+00:00',
        '2026-09-03',
        '2026-09-04',
        '2026-09-04T23:30:15.12+00:00',
      );
    });
  }
  if (process.env['TZ'] === 'Asia/Kathmandu') {
    it('retains fractional numeric offsets', () => {
      expectMove(
        '2026-09-03T23:30:15.12+05:45',
        '2026-09-03',
        '2026-09-04',
        '2026-09-04T23:30:15.12+05:45',
      );
    });
  }
});
