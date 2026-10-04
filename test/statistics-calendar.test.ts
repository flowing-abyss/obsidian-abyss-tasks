import { describe, expect, it } from 'vitest';
import { prepareCalendar } from '../src/statistics/statisticsCalendar';
import { prepareStatisticsDataset } from '../src/statistics/statisticsDataset';
import { required } from '../src/statistics/statisticsWork';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
describe('Statistics calendar', () => {
  it.each([
    ['today', '2026-10-04'],
    ['week', '2026-09-28'],
    ['7d', '2026-09-28'],
    ['month', '2026-10-01'],
    ['30d', '2026-09-05'],
    ['90d', '2026-07-07'],
    ['year', '2026-01-01'],
    ['6m', '2026-04-05'],
    ['12m', '2025-10-05'],
  ] as const)('ends %s on the observed day', async (period, start) => {
    const dataset = await prepareStatisticsDataset(source([]), [], work);
    const calendar = await prepareCalendar(required(dataset), request({ period }), work);
    expect(calendar?.fromDate).toBe(start);
    expect(calendar?.toDate).toBe('2026-10-05');
    expect(calendar?.endMs).toBe(Date.parse('2026-10-04T12:00Z'));
  });
  it('retains century-wide intervals and bounds buckets', async () => {
    const dataset = await prepareStatisticsDataset(
      source([task('century', { timeEntries: [closed('1900-01-01', '2000-01-01')] })]),
      [],
      work,
    );
    const calendar = await prepareCalendar(
      required(dataset),
      request({ period: 'all', calendarTransitions: [] }),
      work,
    );
    expect(calendar?.fromDate).toBe('1900-01-01');
    expect(required(calendar).buckets.length).toBeLessThanOrEqual(240);
  });
  it('honors custom week starts and exact repeated transitions in one grid cell', async () => {
    const transitions = [Date.parse('2026-10-04T01:00Z'), Date.parse('2026-10-04T02:00Z')];
    const offsetAt = (ms: number): number =>
      ms >= required(transitions[0]) && ms < required(transitions[1]) ? 60 : 0;
    const dataset = await prepareStatisticsDataset(source([]), [], work);
    const calendar = await prepareCalendar(
      required(dataset),
      request({ period: 'week', firstDayOfWeek: 0, offsetAt, calendarTransitions: transitions }),
      work,
    );
    expect(calendar?.fromDate).toBe(date('2026-10-04'));
    expect(calendar?.segments.map((s) => s.offsetMinutes)).toEqual([0, 60, 0]);
    await expect(
      prepareCalendar(required(dataset), request({ calendarTransitions: [2, 1] }), work),
    ).rejects.toThrow();
  });
  it('cancels during calendar discovery', async () => {
    const dataset = await prepareStatisticsDataset(
      source([task('old', { planning: { created: date('1900-01-01') } })]),
      [],
      work,
    );
    let cancelled = false;
    const calendar = await prepareCalendar(required(dataset), request({ period: 'all' }), {
      yieldControl: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    expect(calendar).toBeUndefined();
  });
});
it('clamps a rolling month endpoint to the destination month length', async () => {
  const dataset = required(await prepareStatisticsDataset(source([]), [], work));
  const calendar = required(
    await prepareCalendar(
      dataset,
      request({ period: '6m', nowMs: Date.parse('2026-08-30T12:00Z') }),
      work,
    ),
  );
  expect(calendar.fromDate).toBe('2026-02-28');
  expect(calendar.toDate).toBe('2026-08-31');
});
