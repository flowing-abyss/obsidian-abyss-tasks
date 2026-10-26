// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { projectCalendarDayOrdinal } from '../src/projects/projectDateValue';
import type { ProjectTimelineScale } from '../src/projects/projectTimelineSettings';
import {
  projectTimelineDayWidth,
  rebaseTimelineViewport,
  timelineViewportAt,
  timelineViewportCenter,
  type TimelineViewport,
} from '../src/projects/projectTimelineViewport';

const scales: readonly ProjectTimelineScale[] = ['day', 'week', 'month', 'quarter', 'year'];
const densities = [32, 12, 120 / 28, 1.6, 200 / 365];
function ordinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}
function screenX(viewport: TimelineViewport, left: number, day: number): number {
  return (day - ordinal(viewport.window.startDay)) * viewport.dayWidth - left;
}

describe.each(scales)('moving Timeline viewport: %s', (scale) => {
  it('centers continuous calendar coordinates with exact scale density and integral days', () => {
    const center = ordinal('2024-02-29') + 0.5;
    const { viewport, left } = timelineViewportAt(center, scale, 900);
    expect(viewport.dayWidth).toBe(densities[scales.indexOf(scale)]);
    expect(projectTimelineDayWidth(scale)).toBe(viewport.dayWidth);
    expect(timelineViewportCenter(viewport, left, 900)).toBeCloseTo(center, 9);
    expect(screenX(viewport, left, center)).toBeCloseTo(450, 7);
    expect(viewport.trackWidth).toBe(viewport.window.dayCount * viewport.dayWidth);
    expect(viewport.trackWidth).toBeGreaterThanOrEqual(32768);
    expect(ordinal(viewport.window.endDay) - ordinal(viewport.window.startDay) + 1).toBe(
      viewport.window.dayCount,
    );
  });

  it('keeps fractional native offsets unchanged away from edges', () => {
    const position = timelineViewportAt(ordinal('2024-02-29') + 0.5, scale, 900);
    const left = position.left + 0.375;
    const next = rebaseTimelineViewport(position.viewport, left, 900);
    expect(next.viewport).toBe(position.viewport);
    expect(next.left).toBe(left);
    expect(timelineViewportCenter(next.viewport, next.left, 900)).toBeCloseTo(
      ordinal('2024-02-29') + 0.5 + 0.375 / position.viewport.dayWidth,
      9,
    );
  });

  it.each(['left', 'right'])('rebases near the %s edge without moving calendar pixels', (edge) => {
    const { viewport } = timelineViewportAt(ordinal('5000-06-15') + 0.5, scale, 900);
    const left = edge === 'left' ? 1799.375 : viewport.trackWidth - 2699.375;
    const date = ordinal('5000-06-15') + 0.25;
    const next = rebaseTimelineViewport(viewport, left, 900);
    expect(next.viewport.window.startDay).not.toBe(viewport.window.startDay);
    expect(screenX(next.viewport, next.left, date)).toBeCloseTo(screenX(viewport, left, date), 7);
    expect(next.viewport.trackWidth).toBe(viewport.trackWidth);
  });

  it('stays bounded through four thousand consecutive non-clamped rebases', () => {
    let position = timelineViewportAt(ordinal('5000-06-15') + 0.5, scale, 900);
    const width = position.viewport.trackWidth;
    for (let index = 0; index < 4000; index += 1) {
      const left = index % 2 === 0 ? 1000.125 : width - 1900.375;
      const date = timelineViewportCenter(position.viewport, left, 900);
      const before = screenX(position.viewport, left, date);
      const previousStart = position.viewport.window.startDay;
      position = rebaseTimelineViewport(position.viewport, left, 900);
      expect(position.viewport.window.startDay).not.toBe(previousStart);
      expect(screenX(position.viewport, position.left, date)).toBeCloseTo(before, 7);
      expect(position.viewport.trackWidth).toBe(width);
    }
  });

  it('retains the leap-day midpoint across resize and scale rebuilds', () => {
    const original = timelineViewportAt(ordinal('2024-02-29') + 0.5, scale, 900);
    const center = timelineViewportCenter(original.viewport, original.left, 900);
    for (const nextScale of scales) {
      const resized = timelineViewportAt(center, nextScale, 5000);
      expect(screenX(resized.viewport, resized.left, ordinal('2024-02-29') + 0.5)).toBeCloseTo(
        2500,
        7,
      );
      expect(resized.viewport.trackWidth).toBeGreaterThanOrEqual(45000);
    }
  });

  it('clamps at edit-domain limits and never extends beyond them', () => {
    const first = timelineViewportAt(ordinal('0100-01-01') - 1000, scale, 900);
    expect(first.viewport.window.startDay).toBe('0100-01-01');
    expect(first.left).toBe(0);
    expect(rebaseTimelineViewport(first.viewport, 0, 900).viewport.window.startDay).toBe(
      '0100-01-01',
    );
    const last = timelineViewportAt(ordinal('9999-12-31') + 1000, scale, 900);
    expect(last.viewport.window.endDay).toBe('9999-12-31');
    expect(last.left).toBe(last.viewport.trackWidth - 900);
    expect(rebaseTimelineViewport(last.viewport, last.left, 900).viewport.window.endDay).toBe(
      '9999-12-31',
    );
  });
});

it.each([NaN, Infinity, -Infinity, -1, 0])(
  'normalizes unusable geometry %s without NaN',
  (value) => {
    const position = timelineViewportAt(value, 'month', value);
    const next = rebaseTimelineViewport(position.viewport, value, value);
    expect(Number.isFinite(next.left)).toBe(true);
    expect(Number.isFinite(next.viewport.trackWidth)).toBe(true);
    expect(Number.isFinite(timelineViewportCenter(next.viewport, next.left, value))).toBe(true);
  },
);
