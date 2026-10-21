// @vitest-environment node
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
import { expectDefined } from './helpers';

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
  it.each([-5, 5])('moves by a five-minute step of %i minutes', (delta) => {
    expect(resolveTimedDragTarget(origin, { clientX: 150, clientY: 670 + delta }, columns)).toEqual(
      {
        date: localDate('2026-07-20'),
        startMinutes: 540 + delta,
        dayDelta: 0,
        destination: 'time-grid',
      },
    );
  });

  it('accepts fractional rendered height without changing semantic duration', () => {
    expect(
      resolveTimedDragTarget(
        { ...origin, durationMinutes: 110, renderedHeightMinutes: 109.98046875 },
        { clientX: 150, clientY: 697 },
        columns,
      ),
    ).toEqual({
      date: localDate('2026-07-20'),
      startMinutes: 565,
      dayDelta: 0,
      destination: 'time-grid',
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10])(
    'rejects an invalid or out-of-grab rendered height of %s',
    (renderedHeightMinutes) => {
      expect(
        resolveTimedDragTarget(
          { ...origin, renderedHeightMinutes },
          { clientX: 150, clientY: 697 },
          columns,
        ),
      ).toBeUndefined();
    },
  );

  it('preserves the grab offset and snaps the target start to 5 minutes', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 150, clientY: 697 }, columns)).toEqual({
      date: localDate('2026-07-20'),
      startMinutes: 565,
      dayDelta: 0,
      destination: 'time-grid',
    });
  });

  it('resolves a cross-day move with the same snapped start', () => {
    expect(resolveTimedDragTarget(origin, { clientX: 250, clientY: 677 }, columns)).toEqual({
      date: localDate('2026-07-21'),
      startMinutes: 545,
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

  it('clamps the snapped start to the final valid 5-minute slot', () => {
    expect(
      resolveTimedDragTarget(
        { ...origin, grabOffsetMinutes: 0 },
        { clientX: 150, clientY: 1539 },
        columns,
      ),
    ).toMatchObject({ startMinutes: 1435, destination: 'time-grid' });
  });

  it.each([
    ['outside every column', { clientX: 50, clientY: 500 }, columns],
    ['between all-day and time-grid', { clientX: 150, clientY: 80 }, columns],
    ['non-finite pointer', { clientX: Number.NaN, clientY: 500 }, columns],
    [
      'invalid column geometry',
      { clientX: 150, clientY: 500 },
      [{ ...expectDefined(columns[0]), timeGridBottom: 100 }],
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

  it.each([
    { edge: 'start', startMinutes: 545, durationMinutes: 55, endMinutes: 600 },
    { edge: 'end', startMinutes: 540, durationMinutes: 65, endMinutes: 605 },
  ] as const)('resizes the $edge edge by five minutes', (expected) => {
    expect(
      resolveTimedVerticalResizeTarget({ ...endOrigin, edge: expected.edge }, { clientY: 104 }),
    ).toEqual(expected);
  });

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
    [100 + 60 * 0.8, 595],
    [100 + 300 * 0.8, 595],
  ])(
    'clamps a start-edge pointer at y=%i to the minimum duration without moving the end',
    (clientY, startMinutes) => {
      expect(
        resolveTimedVerticalResizeTarget({ ...endOrigin, edge: 'start' }, { clientY }),
      ).toEqual({
        edge: 'start',
        startMinutes,
        durationMinutes: 5,
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
    [-100, 5, 545],
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
        { ...expectDefined(boundaryColumns[0]), right: expectDefined(boundaryColumns[0]).left },
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

describe('bounded timed target preference', () => {
  it.each([
    { edge: 'start' as const, start: 0, duration: 1, delta: -5, wantStart: 0, wantDuration: 1 },
    { edge: 'start' as const, start: 1, duration: 1, delta: 5, wantStart: 0, wantDuration: 2 },
  ])('keeps authored short starts within midnight: $start/$duration', (row) => {
    expect(
      resolveTimedVerticalResizeTarget(
        {
          edge: row.edge,
          startMinutes: row.start,
          durationMinutes: row.duration,
          grabClientY: 100,
          pixelsPerMinute: 0.8,
        },
        { clientY: 100 + row.delta * 0.8 },
      ),
    ).toEqual({
      edge: row.edge,
      startMinutes: row.wantStart,
      durationMinutes: row.wantDuration,
      endMinutes: row.wantStart + row.wantDuration,
    });
  });

  it.each([
    {
      edge: 'end' as const,
      start: 1438,
      duration: 1,
      delta: -2.4,
      priorStart: 1438,
      priorDuration: 2,
    },
    {
      edge: 'end' as const,
      start: 1435,
      duration: 1,
      delta: 2.4,
      priorStart: 1435,
      priorDuration: 5,
    },
    { edge: 'start' as const, start: 1, duration: 1, delta: -2.4, priorStart: 0, priorDuration: 2 },
    { edge: 'start' as const, start: 1, duration: 1, delta: 2.4, priorStart: 0, priorDuration: 2 },
  ])('retains short-block $edge jitter at a single legal day boundary: $delta', (row) => {
    const input = {
      edge: row.edge,
      startMinutes: row.start,
      durationMinutes: row.duration,
      grabClientY: 100,
      pixelsPerMinute: 0.8,
    };
    const previous = {
      edge: row.edge,
      startMinutes: row.priorStart,
      durationMinutes: row.priorDuration,
      endMinutes: row.priorStart + row.priorDuration,
    };
    expect(
      resolveTimedVerticalResizeTarget(input, { clientY: 100 + row.delta * 0.8 }, previous),
    ).toEqual(previous);
    expect(resolveTimedVerticalResizeTarget(input, { clientY: 100 }, previous)).toEqual({
      edge: row.edge,
      startMinutes: row.start,
      durationMinutes: row.duration,
      endMinutes: row.start + row.duration,
    });
  });

  const previousMove = {
    date: localDate('2026-07-20'),
    startMinutes: 550,
    dayDelta: 0,
    destination: 'time-grid' as const,
  };

  it.each([677.4, 677, 676.3])(
    'retains the current time across nearby snap-boundary tremor at %s',
    (clientY) => {
      expect(
        resolveTimedDragTarget(origin, { clientX: 150, clientY }, columns, previousMove),
      ).toEqual(previousMove);
    },
  );

  it.each([535, 545, 550, 555, 600])(
    'reaches a clear five-minute center at %s despite the previous target',
    (startMinutes) => {
      expect(
        resolveTimedDragTarget(
          origin,
          { clientX: 150, clientY: 130 + startMinutes },
          columns,
          previousMove,
        ),
      ).toMatchObject({ startMinutes });
    },
  );

  it.each([541, 542])('returns exactly to the authored off-grid origin %s', (startMinutes) => {
    expect(
      resolveTimedDragTarget(
        { ...origin, startMinutes },
        { clientX: 150, clientY: 130 + startMinutes },
        columns,
        { ...previousMove, startMinutes: 540 },
      ),
    ).toBeUndefined();
  });

  it.each([
    { clientX: 99.5, clientY: 680 },
    { clientX: 300.5, clientY: 680 },
    { clientX: 150, clientY: 80 },
  ])('rejects an invalid final region even with a previous target: %o', (pointer) => {
    expect(resolveTimedDragTarget(origin, pointer, columns, previousMove)).toBeUndefined();
  });

  it('lets the all-day region replace a timed preview', () => {
    expect(
      resolveTimedDragTarget(origin, { clientX: 150, clientY: 40 }, columns, previousMove),
    ).toEqual({ ...previousMove, startMinutes: 540, destination: 'all-day' });
  });

  const boundaryOrigin: SpanBoundaryOrigin = {
    boundary: 'due',
    start: localDate('2026-07-20'),
    due: localDate('2026-07-20'),
  };
  const previousBoundary = { boundary: 'due' as const, date: localDate('2026-07-21'), dayDelta: 1 };
  it.each([199.9, 198.5, 192])(
    'keeps the preview date in the narrow seam band at %s',
    (clientX) => {
      expect(resolveBoundaryTarget(boundaryOrigin, { clientX }, columns, previousBoundary)).toEqual(
        previousBoundary,
      );
    },
  );

  it('keeps the date and time decisions independent', () => {
    expect(
      resolveTimedDragTarget(origin, { clientX: 198.5, clientY: 730 }, columns, {
        ...previousMove,
        date: localDate('2026-07-21'),
        dayDelta: 1,
      }),
    ).toEqual({ ...previousMove, date: localDate('2026-07-21'), dayDelta: 1, startMinutes: 600 });
  });

  it('lets a clear source interior cancel a date change', () => {
    expect(
      resolveBoundaryTarget(boundaryOrigin, { clientX: 191 }, columns, previousBoundary),
    ).toBeUndefined();
  });

  it('does not let a wide prior column consume a narrow neighbor', () => {
    const narrow = [
      { ...expectDefined(columns[0]), right: 298 },
      { ...expectDefined(columns[1]), left: 298 },
    ];
    expect(
      resolveBoundaryTarget(
        { ...boundaryOrigin, due: localDate('2026-07-21') },
        { clientX: 299 },
        narrow,
        { date: localDate('2026-07-20') },
      ),
    ).toBeUndefined();
  });

  it.each([
    { label: 'outside', pointer: 300.5, grid: columns },
    {
      label: 'overlap',
      pointer: 199.9,
      grid: [expectDefined(columns[0]), { ...expectDefined(columns[1]), left: 190 }],
    },
    {
      label: 'gap',
      pointer: 199.9,
      grid: [{ ...expectDefined(columns[0]), right: 199 }, expectDefined(columns[1])],
    },
  ])('does not use history to repair $label hit geometry', ({ pointer, grid }) => {
    expect(
      resolveBoundaryTarget(boundaryOrigin, { clientX: pointer }, grid, previousBoundary),
    ).toBeUndefined();
  });

  it('uses current column rectangles instead of an old date area', () => {
    const shifted = columns.map((column) => ({
      ...column,
      left: column.left + 20,
      right: column.right + 20,
    }));
    expect(
      resolveBoundaryTarget(boundaryOrigin, { clientX: 199.9 }, shifted, previousBoundary),
    ).toBeUndefined();
  });

  it.each([
    {
      edge: 'start' as const,
      start: 540,
      duration: 60,
      priorStart: 550,
      priorDuration: 50,
      pointerDelta: 7.4,
      wantStart: 550,
      wantDuration: 50,
    },
    {
      edge: 'end' as const,
      start: 540,
      duration: 60,
      priorStart: 540,
      priorDuration: 70,
      pointerDelta: 7.4,
      wantStart: 540,
      wantDuration: 70,
    },
    {
      edge: 'end' as const,
      start: 540,
      duration: 59,
      priorStart: 540,
      priorDuration: 900,
      pointerDelta: 840,
      wantStart: 540,
      wantDuration: 899,
    },
    {
      edge: 'start' as const,
      start: 541,
      duration: 60,
      priorStart: 0,
      priorDuration: 601,
      pointerDelta: -540,
      wantStart: 1,
      wantDuration: 600,
    },
    {
      edge: 'end' as const,
      start: 540,
      duration: 7,
      priorStart: 540,
      priorDuration: 5,
      pointerDelta: 0,
      wantStart: 540,
      wantDuration: 7,
    },
    {
      edge: 'start' as const,
      start: 540,
      duration: 7,
      priorStart: 542,
      priorDuration: 5,
      pointerDelta: 0,
      wantStart: 540,
      wantDuration: 7,
    },
    {
      edge: 'start' as const,
      start: 1439,
      duration: 1,
      priorStart: 1435,
      priorDuration: 5,
      pointerDelta: 2.4,
      wantStart: 1435,
      wantDuration: 5,
    },
    {
      edge: 'end' as const,
      start: 540,
      duration: 1,
      priorStart: 540,
      priorDuration: 5,
      pointerDelta: -2.4,
      wantStart: 540,
      wantDuration: 5,
    },
  ])(
    'retains resize intent without swallowing reachable endpoints: $edge $start/$duration delta$pointerDelta',
    (row) => {
      const result = resolveTimedVerticalResizeTarget(
        {
          edge: row.edge,
          startMinutes: row.start,
          durationMinutes: row.duration,
          grabClientY: 100,
          pixelsPerMinute: 0.8,
        },
        { clientY: 100 + row.pointerDelta * 0.8 },
        {
          edge: row.edge,
          startMinutes: row.priorStart,
          durationMinutes: row.priorDuration,
          endMinutes: row.priorStart + row.priorDuration,
        },
      );
      expect(result).toEqual({
        edge: row.edge,
        startMinutes: row.wantStart,
        durationMinutes: row.wantDuration,
        endMinutes: row.wantStart + row.wantDuration,
      });
    },
  );
});
