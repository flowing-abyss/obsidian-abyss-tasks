import { describe, expect, it } from 'vitest';
import { layoutVisibleSpans } from '../src/views/spanLayout';
import { expectDefined, task } from './helpers';

const week1 = [
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  '2026-07-11',
  '2026-07-12',
] as const;
const week2 = [
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
] as const;

function span(title: string, start: string, due: string, line: number) {
  return task({
    title,
    planning: { start, due },
    source: { filePath: 'spans.md', line },
  });
}

describe('layoutVisibleSpans', () => {
  it('clips a span to visible dates without inventing boundary ownership', () => {
    const layout = layoutVisibleSpans([span('Outside', '2026-07-01', '2026-07-20', 1)], week1);

    expect(layout.rows).toHaveLength(1);
    expect(
      layout.rows[0]?.segments.map((segment) => ({
        date: segment.date,
        kind: segment.kind,
        start: segment.ownsStartBoundary,
        due: segment.ownsDueBoundary,
        continuesBefore: segment.continuesBefore,
        continuesAfter: segment.continuesAfter,
      })),
    ).toEqual([
      {
        date: '2026-07-06',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-07',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-08',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-09',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-10',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-11',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
      {
        date: '2026-07-12',
        kind: 'ghost',
        start: false,
        due: false,
        continuesBefore: true,
        continuesAfter: true,
      },
    ]);
  });

  it('emits one day-local segment for every visible date in a range', () => {
    const layout = layoutVisibleSpans([span('Trip', '2026-07-14', '2026-07-16', 2)], week2);
    const row = expectDefined(layout.rows[0]);

    expect(
      row.segments.map((segment) => ({
        date: segment.date,
        kind: segment.kind,
        lane: segment.lane,
        start: segment.ownsStartBoundary,
        due: segment.ownsDueBoundary,
      })),
    ).toEqual([
      { date: '2026-07-14', kind: 'ghost', lane: 0, start: true, due: false },
      { date: '2026-07-15', kind: 'ghost', lane: 0, start: false, due: false },
      { date: '2026-07-16', kind: 'terminal', lane: 0, start: false, due: true },
    ]);
  });

  it('splits at week rows and separates the final due terminal from its ghost body', () => {
    const layout = layoutVisibleSpans(
      [span('Cross-row', '2026-07-10', '2026-07-15', 2)],
      [...week1, ...week2],
    );

    expect(
      layout.rows.map((row) =>
        row.segments.map((segment) => ({
          kind: segment.kind,
          date: segment.date,
          lane: segment.lane,
        })),
      ),
    ).toEqual([
      [
        { kind: 'ghost', date: '2026-07-10', lane: 0 },
        { kind: 'ghost', date: '2026-07-11', lane: 0 },
        { kind: 'ghost', date: '2026-07-12', lane: 0 },
      ],
      [
        { kind: 'ghost', date: '2026-07-13', lane: 0 },
        { kind: 'ghost', date: '2026-07-14', lane: 0 },
        { kind: 'terminal', date: '2026-07-15', lane: 0 },
      ],
    ]);
  });

  it('assigns overlapping spans to different lanes', () => {
    const layout = layoutVisibleSpans(
      [span('Long', '2026-07-06', '2026-07-10', 1), span('Overlap', '2026-07-08', '2026-07-12', 2)],
      week1,
    );

    expect(layout.rows[0]?.laneCount).toBe(2);
    expect(
      layout.rows[0]?.segments
        .filter((segment) => segment.ownsStartBoundary)
        .map((segment) => [segment.task.title, segment.lane]),
    ).toEqual([
      ['Long', 0],
      ['Overlap', 1],
    ]);
  });

  it('reuses the first lane for non-overlapping intervals', () => {
    const layout = layoutVisibleSpans(
      [span('Early', '2026-07-06', '2026-07-07', 1), span('Late', '2026-07-09', '2026-07-10', 2)],
      week1,
    );

    expect(layout.rows[0]?.laneCount).toBe(1);
    expect(new Set(layout.rows[0]?.segments.map((segment) => segment.lane))).toEqual(new Set([0]));
  });

  it('uses stable tie-breaking independent of input order', () => {
    const first = span('First identity', '2026-07-07', '2026-07-10', 1);
    const second = span('Second identity', '2026-07-07', '2026-07-10', 2);
    const lanes = (input: Array<typeof first>) =>
      layoutVisibleSpans(input, week1)
        .rows[0]?.segments.filter((segment) => segment.ownsStartBoundary)
        .map((segment) => [segment.task.source.line, segment.lane]);

    expect(lanes([second, first])).toEqual(lanes([first, second]));
    expect(lanes([second, first])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('ignores single-day noise when assigning span lanes', () => {
    const long = span('Long', '2026-07-06', '2026-07-10', 1);
    const noise = task({
      title: 'Tuesday only',
      planning: { scheduled: '2026-07-07' },
      source: { filePath: 'noise.md', line: 9 },
    });

    expect(layoutVisibleSpans([noise, long], week1)).toEqual(layoutVisibleSpans([long], week1));
  });

  it('retains a continuing task previous-row lane even when a lower lane becomes free', () => {
    const blocker = span('Row-one blocker', '2026-07-06', '2026-07-12', 1);
    const continuing = span('Continuing', '2026-07-10', '2026-07-16', 2);
    const layout = layoutVisibleSpans([blocker, continuing], [...week1, ...week2]);

    expect(layout.rows[0]?.segments.find((segment) => segment.task === continuing)?.lane).toBe(1);
    expect(layout.rows[1]?.segments.find((segment) => segment.task === continuing)?.lane).toBe(1);
    expect(layout.rows[1]?.laneCount).toBe(2);
  });

  it('falls back to the first free lane when a continuing preferred lane is occupied', () => {
    const blocker = span('First-row blocker', '2026-07-06', '2026-07-12', 1);
    const continuing = span('Continuing', '2026-07-10', '2026-07-15', 2);
    const newLong = span('New long', '2026-07-13', '2026-07-19', 3);
    const newMedium = span('New medium', '2026-07-13', '2026-07-18', 4);
    const layout = layoutVisibleSpans(
      [blocker, continuing, newLong, newMedium],
      [...week1, ...week2],
    );
    const secondRow = expectDefined(layout.rows[1]);

    expect(layout.rows[0]?.segments.find((segment) => segment.task === continuing)?.lane).toBe(1);
    expect(secondRow.segments.find((segment) => segment.task === continuing)?.lane).not.toBe(
      layout.rows[0]?.segments.find((segment) => segment.task === continuing)?.lane,
    );
    expect(secondRow.segments.find((segment) => segment.task === continuing)?.lane).toBe(2);
  });
});
