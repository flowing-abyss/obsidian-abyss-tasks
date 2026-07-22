import { describe, expect, it } from 'vitest';
import { localDate } from '../src/tasks/domain/validation';
import {
  resolveBoundaryTarget,
  resolveTimedDragTarget,
  resolveTimedDurationTarget,
  type DragDateColumn,
  type SpanBoundaryOrigin,
  type TimedDragColumn,
  type TimedDragOrigin,
  type TimedDurationOrigin,
} from '../src/views/timegrid/dragGeometry';

const origin: TimedDragOrigin = {
  date: localDate('2026-07-20'),
  startMinutes: 9 * 60,
  durationMinutes: 60,
  grabOffsetMinutes: 30,
};

const columns: readonly TimedDragColumn[] = [
  {
    date: localDate('2026-07-20'),
    left: 100,
    right: 200,
    allDayTop: 20,
    allDayBottom: 60,
    timeGridTop: 100,
    timeGridBottom: 1540,
  },
  {
    date: localDate('2026-07-21'),
    left: 200,
    right: 300,
    allDayTop: 20,
    allDayBottom: 60,
    timeGridTop: 100,
    timeGridBottom: 1540,
  },
];

describe('resolveTimedDragTarget', () => {
  it('preserves the grab offset and snaps the target start to 15 minutes', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 150, clientY: 697 }, columns)).toEqual({
      date: localDate('2026-07-20'),
      startMinutes: 570,
      dayDelta: 0,
      destination: 'time-grid',
    });
  });

  it('resolves a cross-day move with the same snapped start', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 250, clientY: 677 }, columns)).toEqual({
      date: localDate('2026-07-21'),
      startMinutes: 540,
      dayDelta: 1,
      destination: 'time-grid',
    });
  });

  it('resolves the all-day band without changing the captured time', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 250, clientY: 40 }, columns)).toEqual({
      date: localDate('2026-07-21'),
      startMinutes: 540,
      dayDelta: 1,
      destination: 'all-day',
    });
  });

  it.each([
    [101, 0],
    [1539, 1410],
  ])('clamps a target at pointer y=%i to %i minutes', (clientY, startMinutes) => {
    expect(resolveTimedDragTarget(origin, { clientX: 150, clientY }, columns)).toMatchObject({
      startMinutes,
      destination: 'time-grid',
    });
  });

  it('clamps the snapped start to the final valid 15-minute slot', () => {
    expect(
      resolveTimedDragTarget(
        { ...origin, grabOffsetMinutes: 0 },
        { clientX: 150, clientY: 1539 },
        columns,
      ),
    ).toMatchObject({ startMinutes: 1425, destination: 'time-grid' });
  });

  it.each([
    ['outside every column', { clientX: 50, clientY: 500 }, columns],
    ['between all-day and time-grid', { clientX: 150, clientY: 80 }, columns],
    ['non-finite pointer', { clientX: Number.NaN, clientY: 500 }, columns],
    [
      'invalid column geometry',
      { clientX: 150, clientY: 500 },
      [{ ...columns[0]!, timeGridBottom: 100 }],
    ],
    [
      'invalid origin duration',
      { clientX: 150, clientY: 500 },
      columns,
      { ...origin, durationMinutes: 0 },
    ],
  ])('returns undefined for %s', (_name, pointer, targetColumns, customOrigin = origin) => {
    expect(resolveTimedDragTarget(customOrigin, pointer, targetColumns)).toBeUndefined();
  });

  it('returns undefined when the resolved date and time are unchanged', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 150, clientY: 670 }, columns)).toBeUndefined();
  });

  it('does not move an off-grid start on release and accepts a duration crossing midnight', () => {
    expect(
      resolveTimedDragTarget(
        { ...origin, startMinutes: 550 },
        { clientX: 150, clientY: 680 },
        columns,
      ),
    ).toBeUndefined();
    expect(
      resolveTimedDragTarget(
        { ...origin, startMinutes: 1439 },
        { clientX: 150, clientY: 1539 },
        columns,
      ),
    ).toMatchObject({ startMinutes: 1410, destination: 'time-grid' });
  });
});

describe('resolveTimedDurationTarget', () => {
  const durationOrigin: TimedDurationOrigin = {
    startMinutes: 9 * 60,
    durationMinutes: 60,
    grabClientY: 100,
    pixelsPerMinute: 0.8,
  };

  it('snaps duration to 15 minutes and returns the exact end', () => {
    expect(resolveTimedDurationTarget(durationOrigin, { clientY: 111 })).toEqual({
      durationMinutes: 75,
      endMinutes: 615,
    });
  });

  it.each([
    [-100, 15, 555],
    [2_000, 1_440, 1_980],
  ])('clamps pointer y=%i to a %i-minute duration', (clientY, durationMinutes, endMinutes) => {
    expect(resolveTimedDurationTarget(durationOrigin, { clientY })).toEqual({
      durationMinutes,
      endMinutes,
    });
  });

  it('returns undefined for a no-op and invalid geometry', () => {
    expect(resolveTimedDurationTarget(durationOrigin, { clientY: 100 })).toBeUndefined();
    expect(
      resolveTimedDurationTarget({ ...durationOrigin, pixelsPerMinute: 0 }, { clientY: 120 }),
    ).toBeUndefined();
    expect(
      resolveTimedDurationTarget({ ...durationOrigin, startMinutes: 1_440 }, { clientY: 120 }),
    ).toBeUndefined();
  });

  it('preserves an off-grid duration on release and accepts an end after midnight', () => {
    expect(
      resolveTimedDurationTarget(
        { ...durationOrigin, durationMinutes: 10 },
        { clientY: durationOrigin.grabClientY },
      ),
    ).toBeUndefined();
    expect(
      resolveTimedDurationTarget({ ...durationOrigin, startMinutes: 1439 }, { clientY: 111 }),
    ).toEqual({ durationMinutes: 75, endMinutes: 1514 });
  });
});

describe('resolveBoundaryTarget', () => {
  const boundaryColumns: readonly DragDateColumn[] = Array.from({ length: 8 }, (_, index) => ({
    date: localDate(`2026-07-${String(18 + index).padStart(2, '0')}`),
    left: index * 100,
    right: (index + 1) * 100,
  }));
  const startOrigin: SpanBoundaryOrigin = {
    boundary: 'start',
    start: localDate('2026-07-20'),
    due: localDate('2026-07-22'),
  };

  it('resolves a start boundary and clamps it at due', () => {
    expect(resolveBoundaryTarget(startOrigin, { clientX: 350 }, boundaryColumns)).toEqual({
      boundary: 'start',
      date: localDate('2026-07-21'),
      dayDelta: 1,
    });
    expect(resolveBoundaryTarget(startOrigin, { clientX: 650 }, boundaryColumns)).toEqual({
      boundary: 'start',
      date: localDate('2026-07-22'),
      dayDelta: 2,
    });
  });

  it('resolves a due boundary and clamps it at start', () => {
    const dueOrigin: SpanBoundaryOrigin = { ...startOrigin, boundary: 'due' };

    expect(resolveBoundaryTarget(dueOrigin, { clientX: 550 }, boundaryColumns)).toEqual({
      boundary: 'due',
      date: localDate('2026-07-23'),
      dayDelta: 1,
    });
    expect(resolveBoundaryTarget(dueOrigin, { clientX: 50 }, boundaryColumns)).toEqual({
      boundary: 'due',
      date: localDate('2026-07-20'),
      dayDelta: -2,
    });
  });

  it('returns undefined for no-op, inverted origins, and invalid columns', () => {
    expect(resolveBoundaryTarget(startOrigin, { clientX: 250 }, boundaryColumns)).toBeUndefined();
    expect(
      resolveBoundaryTarget(
        { ...startOrigin, start: localDate('2026-07-23') },
        { clientX: 350 },
        boundaryColumns,
      ),
    ).toBeUndefined();
    expect(
      resolveBoundaryTarget(startOrigin, { clientX: 350 }, [
        { ...boundaryColumns[0]!, right: boundaryColumns[0]!.left },
      ]),
    ).toBeUndefined();
    expect(
      resolveBoundaryTarget(
        { ...startOrigin, boundary: 'end' as SpanBoundaryOrigin['boundary'] },
        { clientX: 350 },
        boundaryColumns,
      ),
    ).toBeUndefined();
  });
});
