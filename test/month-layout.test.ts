import { describe, expect, it } from 'vitest';
import { localTime, type TaskSnapshot } from '../src/tasks';
import {
  layoutVisibleMonth,
  layoutVisibleMonthWithReplacement,
  type MonthVisibleLayout,
} from '../src/views/monthLayout';
import { layoutVisibleSpans } from '../src/views/spanLayout';
import { expectDefined, task, useRealMoment } from './helpers';

useRealMoment();

const dates = [
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
  '2026-08-02',
];

function fixture(): TaskSnapshot[] {
  return [
    task({
      title: '15 span',
      planning: { start: '2026-07-30', due: '2026-07-31', time: '15:00' },
      source: { filePath: '15.md', line: 15 },
    }),
    task({
      title: 'Deadline marker',
      planning: { scheduled: '2026-07-29', due: '2026-07-30' },
      source: { filePath: 'deadline.md', line: 5 },
    }),
    task({
      title: 'Untimed span',
      planning: { start: '2026-07-30', due: '2026-07-31' },
      source: { filePath: 'untimed.md', line: 1 },
    }),
    task({
      title: '20 compact',
      planning: { scheduled: '2026-07-30', time: '20:00' },
      source: { filePath: 'compact.md', line: 20 },
    }),
    task({
      title: '09 span',
      planning: { start: '2026-07-29', due: '2026-07-30', time: '09:00' },
      source: { filePath: '09.md', line: 9 },
    }),
  ];
}

function dayEntries(
  layout: MonthVisibleLayout,
  date: string,
): Array<[kind: string, title: string, slot: number]> {
  const row = layout.rows.find(({ spanRow }) =>
    spanRow.segments.some((segment) => segment.date === date),
  );
  if (row == null) throw new Error(`Expected row containing ${date}`);

  return [
    ...row.spanRow.segments
      .filter((segment) => segment.date === date)
      .map(
        (segment) =>
          ['span', segment.task.title, segment.lane] as [kind: string, title: string, slot: number],
      ),
    ...(row.compactByDate.get(date) ?? []).map(
      ({ kind, task: compactTask, slot }) =>
        [kind, compactTask.title, slot] as [kind: string, title: string, slot: number],
    ),
  ].sort((left, right) => left[2] - right[2]);
}

const expectedEntries: Array<[kind: string, title: string, slot: number]> = [
  ['span', '09 span', 0],
  ['span', '15 span', 1],
  ['timed', '20 compact', 2],
  ['span', 'Untimed span', 3],
  ['deadline', 'Deadline marker', 4],
];

describe('layoutVisibleMonth', () => {
  it('places chronological timed items before untimed items and deadline markers independent of input order', () => {
    const scrambled = fixture();
    const sharedLayout = layoutVisibleSpans(scrambled, dates);
    const sharedBefore = sharedLayout.rows.map((row) => ({
      laneCount: row.laneCount,
      segments: row.segments.map(({ identity, date, lane }) => ({ identity, date, lane })),
    }));
    const layout = layoutVisibleMonth(scrambled, dates);

    expect(dayEntries(layout, '2026-07-30')).toEqual(expectedEntries);
    expect(dayEntries(layoutVisibleMonth([...scrambled].reverse(), dates), '2026-07-30')).toEqual(
      expectedEntries,
    );
    expect(dayEntries(layout, '2026-07-31')).toEqual([
      ['span', '15 span', 1],
      ['span', 'Untimed span', 3],
    ]);
    expect(layout.rows[0]?.slotCount).toBe(5);
    expect(layout.rows[0]?.spanRow.laneCount).toBe(5);
    expect(
      sharedLayout.rows[0]?.segments
        .filter((segment) => segment.date === '2026-07-30')
        .map((segment) => [segment.task.title, segment.lane]),
    ).toEqual([
      ['09 span', 0],
      ['15 span', 1],
      ['Untimed span', 2],
    ]);
    expect(
      sharedLayout.rows.map((row) => ({
        laneCount: row.laneCount,
        segments: row.segments.map(({ identity, date, lane }) => ({ identity, date, lane })),
      })),
    ).toEqual(sharedBefore);
  });

  it('keeps a multi-day task in one row lane when an earlier local task exists on only one day', () => {
    const tasks = [
      task({
        title: 'Conference talk',
        planning: { start: '2026-07-29', due: '2026-07-31', time: '15:00' },
        source: { filePath: 'conference.md', line: 10 },
      }),
      task({
        title: 'Local morning task',
        planning: { scheduled: '2026-07-30', time: '09:00' },
        source: { filePath: 'local.md', line: 20 },
      }),
    ];

    const layout = layoutVisibleMonth(tasks, dates);

    expect(dayEntries(layout, '2026-07-29')).toEqual([['span', 'Conference talk', 1]]);
    expect(dayEntries(layout, '2026-07-30')).toEqual([
      ['timed', 'Local morning task', 0],
      ['span', 'Conference talk', 1],
    ]);
    expect(dayEntries(layout, '2026-07-31')).toEqual([['span', 'Conference talk', 1]]);
  });

  it('uses the same Month slot allocator for replacement previews', () => {
    const tasks = fixture();
    const source = expectDefined(tasks.find((candidate) => candidate.title === '20 compact'));
    const layout = layoutVisibleMonthWithReplacement(tasks, dates, source, {
      ...source.planning,
      time: localTime('08:00'),
    });

    expect(dayEntries(layout, '2026-07-30')).toEqual([
      ['timed', '20 compact', 0],
      ['span', '09 span', 1],
      ['span', '15 span', 2],
      ['span', 'Untimed span', 3],
      ['deadline', 'Deadline marker', 4],
    ]);
    expect(source.planning.time).toBe('20:00');
  });
});
