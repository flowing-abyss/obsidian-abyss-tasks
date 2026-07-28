import { describe, expect, it } from 'vitest';
import { localDate } from '../src/tasks/domain/validation';
import {
  resolveBoundaryTarget,
  resolveTimedDragTarget,
  resolveTimedVerticalResizeTarget,
  type DragDateColumn,
  type SpanBoundaryOrigin,
  type TimedDragColumn,
  type TimedDragOrigin,
  type TimedVerticalResizeOrigin,
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

  it('preserves a visual min-height grab offset for short blocks without turning a click into a move', () => {
    const shortColumns: readonly TimedDragColumn[] = [
      {
        date: localDate('2026-07-20'),
        left: 100,
        right: 200,
        timeGridTop: 100,
        timeGridBottom: 1252,
      },
    ];
    const shortOrigin: TimedDragOrigin = {
      date: localDate('2026-07-20'),
      startMinutes: 540,
      durationMinutes: 5,
      renderedHeightMinutes: 30.6,
      grabOffsetMinutes: 17.5,
    };

    expect(
      resolveTimedDragTarget(shortOrigin, { clientX: 150, clientY: 546 }, shortColumns),
    ).toBeUndefined();
    expect(
      resolveTimedDragTarget(shortOrigin, { clientX: 150, clientY: 594 }, shortColumns),
    ).toEqual({
      date: localDate('2026-07-20'),
      startMinutes: 600,
      dayDelta: 0,
      destination: 'time-grid',
    });
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

describe('resolveTimedVerticalResizeTarget', () => {
  const endOrigin: TimedVerticalResizeOrigin = {
    edge: 'end',
    startMinutes: 9 * 60,
    durationMinutes: 60,
    grabClientY: 100,
    pixelsPerMinute: 0.8,
  };

  it('moves the start edge earlier while preserving the original end', () => {
    expect(
      resolveTimedVerticalResizeTarget(
        { ...endOrigin, edge: 'start' },
        { clientY: 100 - 30 * 0.8 },
      ),
    ).toEqual({
      edge: 'start',
      startMinutes: 510,
      durationMinutes: 90,
      endMinutes: 600,
    });
  });

  it.each([
    [100 + 60 * 0.8, 585],
    [100 + 300 * 0.8, 585],
  ])(
    'clamps a start-edge pointer at y=%i to the minimum duration without moving the end',
    (clientY, startMinutes) => {
      expect(
        resolveTimedVerticalResizeTarget({ ...endOrigin, edge: 'start' }, { clientY }),
      ).toEqual({
        edge: 'start',
        startMinutes,
        durationMinutes: 15,
        endMinutes: 600,
      });
    },
  );

  it('snaps the end edge while preserving the original start', () => {
    expect(resolveTimedVerticalResizeTarget(endOrigin, { clientY: 111 })).toEqual({
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 75,
      endMinutes: 615,
    });
  });

  it.each([
    [-100, 15, 555],
    [2_000, 900, 1_440],
  ])('clamps pointer y=%i to a %i-minute duration', (clientY, durationMinutes, endMinutes) => {
    expect(resolveTimedVerticalResizeTarget(endOrigin, { clientY })).toEqual({
      edge: 'end',
      startMinutes: 540,
      durationMinutes,
      endMinutes,
    });
  });

  it('returns the unchanged edge-specific target for a no-op pointer', () => {
    expect(resolveTimedVerticalResizeTarget(endOrigin, { clientY: 100 })).toEqual({
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 60,
      endMinutes: 600,
    });
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
