import { describe, expect, it } from 'vitest';
import { projectCalendarDayOrdinal } from '../src/projects/projectDateValue';
import {
  PROJECT_TIMELINE_MAX_TRACK_WIDTH,
  projectTimelineAxisLayout,
  projectTimelineTrackWidth,
} from '../src/projects/projectTimelineAxis';
import { projectTimelineWindowForRange } from '../src/projects/projectTimelineModel';

function ordinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}

describe('project Timeline calendar axis', () => {
  it('keeps consecutive day cells contiguous across a month boundary', () => {
    const window = projectTimelineWindowForRange('2024-01-31', '2024-02-01', 'day');

    const layout = projectTimelineAxisLayout(window, {
      visibleStartDay: '2024-01-31',
      visibleEndDay: '2024-02-01',
    });

    expect(
      layout.cells.map(({ startDay, endDay, label, secondaryLabel }) => ({
        startDay,
        endDay,
        label,
        secondaryLabel,
      })),
    ).toEqual([
      { startDay: '2024-01-31', endDay: '2024-01-31', label: 'Wed', secondaryLabel: '31' },
      { startDay: '2024-02-01', endDay: '2024-02-01', label: 'Thu', secondaryLabel: '1' },
    ]);
    expect(layout.cells[0]?.rightPercent).toBe(layout.cells[1]?.leftPercent);
    expect(
      layout.hierarchyCells.map(({ label, secondaryLabel }) => [label, secondaryLabel]),
    ).toEqual([
      ['Jan', '2024'],
      ['Feb', '2024'],
    ]);
  });

  it('includes leap day with exact ordinal boundaries', () => {
    const window = projectTimelineWindowForRange('2024-02-28', '2024-03-01', 'day');

    const layout = projectTimelineAxisLayout(window, {
      visibleStartDay: '2024-02-28',
      visibleEndDay: '2024-03-01',
    });

    expect(layout.cells.map(({ startDay }) => startDay)).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
    expect(layout.cells[1]).toMatchObject({
      label: 'Thu',
      secondaryLabel: '29',
      startOrdinal: ordinal('2024-02-29'),
    });
    expect(layout.gridBoundaries.find(({ day }) => day === '2024-03-01')).toMatchObject({
      ordinal: ordinal('2024-03-01'),
      weight: 'major',
      leftPercent: (2 / 3) * 100,
    });
  });

  it('labels ISO weeks across the 2020 to 2021 transition', () => {
    const window = projectTimelineWindowForRange('2020-12-28', '2021-01-10', 'week');

    const layout = projectTimelineAxisLayout(window, {
      visibleStartDay: window.startDay,
      visibleEndDay: window.endDay,
    });

    expect(layout.cells.map(({ label }) => label)).toEqual(['W53', 'W01']);
    expect(layout.cells.map(({ startDay, endDay }) => [startDay, endDay])).toEqual([
      ['2020-12-28', '2021-01-03'],
      ['2021-01-04', '2021-01-10'],
    ]);
  });

  it.each([
    {
      scale: 'month',
      startDay: '2024-01-01',
      endDay: '2024-06-30',
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
      hierarchy: [
        ['Q1', '2024'],
        ['Q2', '2024'],
      ],
    },
    {
      scale: 'quarter',
      startDay: '2023-10-01',
      endDay: '2024-06-30',
      labels: ['Q4', 'Q1', 'Q2'],
      hierarchy: [
        ['2023', undefined],
        ['2024', undefined],
      ],
    },
    {
      scale: 'year',
      startDay: '2023-01-01',
      endDay: '2025-12-31',
      labels: ['2023', '2024', '2025'],
      hierarchy: [],
    },
  ] as const)(
    'builds bounded $scale cells and their calendar hierarchy',
    ({ scale, startDay, endDay, labels, hierarchy }) => {
      const window = projectTimelineWindowForRange(startDay, endDay, scale);

      const layout = projectTimelineAxisLayout(window, {
        visibleStartDay: startDay,
        visibleEndDay: endDay,
      });

      expect(layout.cells.map(({ label }) => label)).toEqual(labels);
      expect(
        layout.hierarchyCells.map(({ label, secondaryLabel }) => [label, secondaryLabel]),
      ).toEqual(hierarchy);
      expect(layout.cells[0]?.startOrdinal).toBe(ordinal(startDay));
      expect(layout.cells[layout.cells.length - 1]?.endOrdinal).toBe(ordinal(endDay));
    },
  );

  it('uses subtle quarter grid boundaries within the Year scale', () => {
    const window = projectTimelineWindowForRange('2024-01-01', '2024-12-31', 'year');

    const layout = projectTimelineAxisLayout(window, {
      visibleStartDay: window.startDay,
      visibleEndDay: window.endDay,
    });

    expect(layout.gridBoundaries.map(({ day, weight }) => [day, weight])).toEqual([
      ['2024-01-01', 'major'],
      ['2024-04-01', 'minor'],
      ['2024-07-01', 'minor'],
      ['2024-10-01', 'minor'],
    ]);
  });

  it('keeps a multi-year Day layout viewport-bounded and caps pathological physical width', () => {
    const window = projectTimelineWindowForRange('0100-01-01', '9999-12-31', 'day');

    const layout = projectTimelineAxisLayout(window, {
      visibleStartDay: '2024-02-01',
      visibleEndDay: '2024-02-29',
      overscanCells: 1,
    });

    expect(layout.cells).toHaveLength(31);
    expect(layout.cells[0]?.startDay).toBe('2024-01-31');
    expect(layout.cells[layout.cells.length - 1]?.endDay).toBe('2024-03-01');
    expect(layout.gridBoundaries.length).toBeLessThanOrEqual(33);
    expect(projectTimelineTrackWidth(window, 700)).toBe(PROJECT_TIMELINE_MAX_TRACK_WIDTH);
    expect(Number.isFinite(projectTimelineTrackWidth(window, 700))).toBe(true);
  });

  it('honors each scale density and expands short ranges to the visible track', () => {
    const day = projectTimelineWindowForRange('2024-01-01', '2024-01-14', 'day');
    const week = projectTimelineWindowForRange('2024-01-01', '2024-03-24', 'week');
    const month = projectTimelineWindowForRange('2024-01-01', '2024-12-31', 'month');
    const quarter = projectTimelineWindowForRange('2024-01-01', '2024-12-31', 'quarter');
    const year = projectTimelineWindowForRange('2024-01-01', '2024-12-31', 'year');

    expect(projectTimelineTrackWidth(day, 0)).toBe(14 * 32);
    expect(projectTimelineTrackWidth(day, 700)).toBe(700);
    expect(projectTimelineTrackWidth(week, 0)).toBe(84 * 12);
    expect(projectTimelineTrackWidth(month, 0)).toBeGreaterThanOrEqual(12 * 120);
    expect(projectTimelineTrackWidth(quarter, 0)).toBeGreaterThanOrEqual(4 * 144);
    expect(projectTimelineTrackWidth(year, 0)).toBeGreaterThanOrEqual(200);
    expect(projectTimelineTrackWidth(day, 900)).toBe(900);
  });
});
