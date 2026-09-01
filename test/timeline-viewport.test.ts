import { describe, expect, it } from 'vitest';
import {
  civilDateToX,
  createTimelineViewport,
  geometryForTimelineItem,
  reframeTimelineViewport,
  timelineDateAtX,
  timelineVisibleWindow,
  todayCenteredTimelineViewport,
  type TimelineViewport,
} from '../src/panels/projects/TimelineViewport';
import {
  DEFAULT_TIMELINE_IDENTITY_WIDTH,
  reconcileTimelinePreference,
} from '../src/panels/projects/timelinePreferences';
import {
  addCivilDays,
  moveProjectDateByCivilDays,
  parseProjectDate,
} from '../src/projects/projectDates';

const invalidTaskYearViewport: TimelineViewport = {
  scope: 'tasks',
  // @ts-expect-error A Task viewport cannot carry an unsupported century scale.
  scale: 'century',
  focalDate: '2026-08-20',
  viewportWidth: 240,
  pixelsPerDay: 2,
};
void invalidTaskYearViewport;

const invalidPortfolioDayViewport: TimelineViewport = {
  scope: 'portfolio',
  // @ts-expect-error A Portfolio viewport cannot carry an unsupported century scale.
  scale: 'century',
  focalDate: '2026-08-20',
  viewportWidth: 240,
  pixelsPerDay: 64,
};
void invalidPortfolioDayViewport;

function reframeUnknownScope(viewport: TimelineViewport): void {
  // @ts-expect-error A union viewport must be narrowed before changing its scale.
  reframeTimelineViewport(viewport, { scale: 'year' });
  reframeTimelineViewport(viewport, { viewportWidth: 320 });
}
void reframeUnknownScope;

type ExtendedTaskViewport = TimelineViewport<'tasks'> & { readonly marker: 'kept' };

function expectFocalDateAtCenter(viewport: TimelineViewport, viewportWidth: number): void {
  expect(viewport.focalDate).toBe('2028-02-29');
  expect(civilDateToX(viewport, '2028-02-29')).toBe(viewportWidth / 2);
  expect(timelineDateAtX(viewport, viewportWidth / 2)).toBe('2028-02-29');
}

describe('timeline preference reconciliation', () => {
  it.each([
    ['portfolio', 'day'],
    ['portfolio', 'week'],
    ['portfolio', 'month'],
    ['portfolio', 'quarter'],
    ['portfolio', 'year'],
    ['tasks', 'day'],
    ['tasks', 'week'],
    ['tasks', 'month'],
    ['workNotes', 'day'],
    ['workNotes', 'week'],
    ['workNotes', 'month'],
    ['workNotes', 'quarter'],
    ['workNotes', 'year'],
  ] as const)('preserves the valid %s %s scale', (scope, scale) => {
    expect(reconcileTimelinePreference(scope, { version: 1, scale, identityWidth: 280 })).toEqual({
      version: 1,
      scale,
      identityWidth: 280,
    });
  });

  it.each([
    ['portfolio', 'century', 'quarter'],
    ['tasks', 'century', 'week'],
    ['workNotes', 'century', 'month'],
  ] as const)('recovers an invalid %s scale deterministically', (scope, scale, expected) => {
    expect(reconcileTimelinePreference(scope, { version: 99, scale, identityWidth: 240 })).toEqual({
      version: 1,
      scale: expected,
      identityWidth: 240,
    });
  });

  it('clamps finite widths and recovers invalid widths without mutating persisted input', () => {
    const persisted = Object.freeze({ version: 1, scale: 'month', identityWidth: 999 });

    expect(reconcileTimelinePreference('portfolio', persisted)).toEqual({
      version: 1,
      scale: 'month',
      identityWidth: 360,
    });
    expect(reconcileTimelinePreference('tasks', { identityWidth: 10 })).toMatchObject({
      identityWidth: 160,
    });
    expect(reconcileTimelinePreference('workNotes', { identityWidth: Number.NaN })).toMatchObject({
      identityWidth: DEFAULT_TIMELINE_IDENTITY_WIDTH,
    });
    expect(persisted).toEqual({ version: 1, scale: 'month', identityWidth: 999 });
  });
});

describe('continuous timeline viewport', () => {
  it('returns the scope-correlated base shape when resizing an extended viewport', () => {
    const extended: ExtendedTaskViewport = {
      ...createTimelineViewport({
        scope: 'tasks',
        scale: 'week',
        focalDate: '2026-08-20',
        viewportWidth: 240,
      }),
      marker: 'kept',
    };

    const resized = reframeTimelineViewport(extended, { viewportWidth: 320 });

    // @ts-expect-error Resizing reconstructs the base viewport and does not preserve extensions.
    resized.marker;
    expect(resized).toEqual({
      scope: 'tasks',
      scale: 'week',
      focalDate: '2026-08-20',
      viewportWidth: 320,
      pixelsPerDay: 28,
    });
    expect('marker' in resized).toBe(false);
  });

  it('maps 90 consecutive civil dates to distinct monotonic reachable positions', () => {
    const viewport = createTimelineViewport({
      scope: 'portfolio',
      scale: 'quarter',
      focalDate: '2026-02-15',
      viewportWidth: 900,
    });
    const dates = Array.from({ length: 90 }, (_, index) => addCivilDays('2026-01-01', index)!);
    const positions = dates.map((date) => civilDateToX(viewport, date));

    expect(new Set(positions).size).toBe(90);
    expect(
      positions.every((position, index) => index === 0 || position > positions[index - 1]!),
    ).toBe(true);
    expect(positions.every((position) => position >= 0 && position <= viewport.viewportWidth)).toBe(
      true,
    );
    expect(timelineVisibleWindow(viewport).dates.length).toBeGreaterThan(90);
  });

  it('preserves each scope focal date across every supported scale and width', () => {
    let portfolio = createTimelineViewport({
      scope: 'portfolio',
      scale: 'week',
      focalDate: '2028-02-29',
      viewportWidth: 641,
    });
    for (const [index, scale] of (['day', 'week', 'month', 'quarter', 'year'] as const).entries()) {
      const viewportWidth = 640 + index * 137;
      portfolio = reframeTimelineViewport(portfolio, { scale, viewportWidth });
      expectFocalDateAtCenter(portfolio, viewportWidth);
    }

    let tasks = createTimelineViewport({
      scope: 'tasks',
      scale: 'day',
      focalDate: '2028-02-29',
      viewportWidth: 641,
    });
    for (const [index, scale] of (['day', 'week', 'month', 'quarter', 'year'] as const).entries()) {
      const viewportWidth = 640 + index * 137;
      tasks = reframeTimelineViewport(tasks, { scale, viewportWidth });
      expectFocalDateAtCenter(tasks, viewportWidth);
    }

    let workNotes = createTimelineViewport({
      scope: 'workNotes',
      scale: 'day',
      focalDate: '2028-02-29',
      viewportWidth: 641,
    });
    for (const [index, scale] of (['day', 'week', 'month', 'quarter', 'year'] as const).entries()) {
      const viewportWidth = 640 + index * 137;
      workNotes = reframeTimelineViewport(workNotes, { scale, viewportWidth });
      expectFocalDateAtCenter(workNotes, viewportWidth);
    }
  });

  it('centers an injected Today without consulting ambient time', () => {
    const viewport = createTimelineViewport({
      scope: 'tasks',
      scale: 'week',
      focalDate: '1999-12-31',
      viewportWidth: 800,
    });

    const centered = todayCenteredTimelineViewport(viewport, '2040-07-04');

    expect(centered.focalDate).toBe('2040-07-04');
    expect(timelineDateAtX(centered, 400)).toBe('2040-07-04');
  });

  it('projects a complete visible civil-date window with reversible boundary coordinates', () => {
    const viewport = createTimelineViewport({
      scope: 'tasks',
      scale: 'month',
      focalDate: '2026-12-31',
      viewportWidth: 600,
    });
    const window = timelineVisibleWindow(viewport);

    expect(window.dates[0]).toBe(window.start);
    expect(window.dates[window.dates.length - 1]).toBe(window.end);
    expect(timelineDateAtX(viewport, civilDateToX(viewport, window.start))).toBe(window.start);
    expect(timelineDateAtX(viewport, civilDateToX(viewport, window.end))).toBe(window.end);
  });

  it.each([
    ['0000-01-01', '0000-01-01', undefined],
    ['9999-12-31', undefined, '9999-12-31'],
  ] as const)(
    'clamps a visible window centered at the supported boundary %s',
    (focal, start, end) => {
      const viewport = createTimelineViewport({
        scope: 'portfolio',
        scale: 'year',
        focalDate: focal,
        viewportWidth: 240,
      });

      const window = timelineVisibleWindow(viewport);

      if (start !== undefined) expect(window.start).toBe(start);
      if (end !== undefined) expect(window.end).toBe(end);
      expect(window.dates[0]).toBe(window.start);
      expect(window.dates[window.dates.length - 1]).toBe(window.end);
      expect(timelineDateAtX(viewport, start !== undefined ? 0 : viewport.viewportWidth)).toBe(
        focal,
      );
    },
  );
});

describe('civil-day endpoint movement', () => {
  it.each([
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
  ] as const)('moves %s by %i civil days to %s', (raw, delta, expected) => {
    expect(addCivilDays(raw, delta)).toBe(expected);
  });

  it.each([
    ['2026-03-07T01:30:00-05:00', 1, '2026-03-08T01:30:00-05:00'],
    ['2026-11-02T01:30:00-04:00', -1, '2026-11-01T01:30:00-04:00'],
    ['2026-08-26T14:30:00.125+07:00', 3, '2026-08-29T14:30:00.125+07:00'],
    ['2026-08-26T14:30:00.987-04:30', -2, '2026-08-24T14:30:00.987-04:30'],
    ['2026-08-26T14:30:00.000Z', 1, '2026-08-27T14:30:00.000Z'],
    ['2026-08-26', -1, '2026-08-25'],
  ] as const)('preserves the complete endpoint suffix while moving %s', (raw, delta, expected) => {
    const observed = parseProjectDate(raw)!;

    expect(moveProjectDateByCivilDays(observed, delta)?.raw).toBe(expected);
  });

  it('returns the exact observed endpoint for a zero delta and keeps invalid Atom semantics', () => {
    const observed = parseProjectDate('2026-08-26T14:30:00.123456+05:45')!;

    expect(moveProjectDateByCivilDays(observed, 0)).toBe(observed);
    expect(addCivilDays('2026-02-30', 1)).toBeUndefined();
    expect(parseProjectDate('2026-08-26T14:30:00-00:00')).toBeUndefined();
  });
});

describe('timeline item geometry', () => {
  const viewport = createTimelineViewport({
    scope: 'tasks',
    scale: 'month',
    focalDate: '2026-08-20',
    viewportWidth: 240,
  });

  it('gives a same-day range a minimum-width bar without rewriting either endpoint', () => {
    const input = Object.freeze({
      kind: 'range' as const,
      start: '2026-08-20T09:00:00.125+07:00',
      end: '2026-08-20T17:00:00.875+07:00',
    });

    const geometry = geometryForTimelineItem(viewport, input);

    expect(geometry).toMatchObject({ kind: 'range', visible: true });
    if (geometry.kind === 'range') expect(geometry.width).toBeGreaterThanOrEqual(6);
    expect(input).toEqual({
      kind: 'range',
      start: '2026-08-20T09:00:00.125+07:00',
      end: '2026-08-20T17:00:00.875+07:00',
    });
  });

  it('keeps upper-bound same-day range geometry finite without requiring day 10000', () => {
    const upperBoundViewport = createTimelineViewport({
      scope: 'portfolio',
      scale: 'year',
      focalDate: '9999-12-31',
      viewportWidth: 240,
    });

    const geometry = geometryForTimelineItem(upperBoundViewport, {
      kind: 'range',
      start: '9999-12-31',
      end: '9999-12-31',
    });

    expect(geometry).toMatchObject({
      kind: 'range',
      left: 118,
      width: 6,
      unclippedWidth: 6,
      visible: true,
    });
  });

  it('derives ordinary inclusive range geometry from civil boundaries', () => {
    const geometry = geometryForTimelineItem(viewport, {
      kind: 'range',
      start: '2026-08-18',
      end: '2026-08-22',
    });

    expect(geometry).toMatchObject({
      kind: 'range',
      visible: true,
      clippedStart: false,
      clippedEnd: false,
    });
    if (geometry.kind === 'range') expect(geometry.unclippedWidth).toBe(60);
  });

  it('rejects a same-civil-day range whose canonical end instant precedes its start', () => {
    expect(() =>
      geometryForTimelineItem(viewport, {
        kind: 'range',
        start: '2026-08-20T17:00:00+07:00',
        end: '2026-08-20T09:00:00+07:00',
      }),
    ).toThrow('Timeline range is reversed');
  });

  it('keeps an instant-valid opposite-offset range finite when its civil labels cross', () => {
    const geometry = geometryForTimelineItem(viewport, {
      kind: 'range',
      start: '2026-08-20T00:00:00+14:00',
      end: '2026-08-19T23:00:00-12:00',
    });

    expect(geometry).toMatchObject({
      kind: 'range',
      left: 108,
      width: 24,
      unclippedWidth: 24,
      visible: true,
    });
  });

  it('keeps point and milestone geometry as distinct stable contracts', () => {
    expect(geometryForTimelineItem(viewport, { kind: 'point', at: '2026-08-20' })).toEqual({
      kind: 'point',
      centerX: 126,
      size: 8,
      visible: true,
      clipped: false,
    });
    expect(geometryForTimelineItem(viewport, { kind: 'milestone', at: '2026-08-20' })).toEqual({
      kind: 'milestone',
      shape: 'diamond',
      centerX: 126,
      size: 10,
      visible: true,
      clipped: false,
    });
  });

  it('clips crossing and fully out-of-window ranges predictably with finite geometry', () => {
    const crossing = geometryForTimelineItem(viewport, {
      kind: 'range',
      start: '2025-01-01',
      end: '2026-08-20',
    });
    const outside = geometryForTimelineItem(viewport, {
      kind: 'range',
      start: '2030-01-01',
      end: '2030-01-02',
    });

    expect(crossing).toMatchObject({
      kind: 'range',
      left: 0,
      visible: true,
      clippedStart: true,
      clippedEnd: false,
    });
    expect(outside).toMatchObject({
      kind: 'range',
      left: 240,
      width: 0,
      visible: false,
      clippedStart: false,
      clippedEnd: true,
    });
    expect(
      Object.values(outside)
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);
  });
});
