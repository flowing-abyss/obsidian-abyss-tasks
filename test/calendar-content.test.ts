import { assert, describe, expect, it, vi } from 'vitest';
import { moment } from '../src/obsidianMoment';
import { calendarContent } from '../src/panels/calendar/calendarContent';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskQueryApi } from '../src/tasks';
import * as calendarOccurrences from '../src/views/calendarOccurrences';
import { task, taskQueryApi, useRealMoment } from './helpers';

useRealMoment();

function source(root: ReturnType<typeof task>): {
  root: ReturnType<typeof task>;
  target: { type: 'task'; ref: ReturnType<typeof task>['ref'] };
  node: ReturnType<typeof task>;
} {
  return { root, target: { type: 'task', ref: root.ref }, node: root };
}

describe('calendarContent', () => {
  const settings = { firstDayOfWeek: 1 as const, recurrence: DEFAULT_SETTINGS.recurrence };

  it('builds the week config from the first visible week date', () => {
    const queries = taskQueryApi();
    const content = calendarContent({
      queries,
      settings,
      view: 'week',
      date: moment('2026-09-23'),
    });
    expect(content.config).toEqual({ firstDayOfWeek: 1, startPosition: '2026-09-21' });
  });

  it('builds the day config from the exact date and the month config from the month', () => {
    const queries = taskQueryApi();
    expect(
      calendarContent({ queries, settings, view: 'today', date: moment('2026-09-23') }).config
        .startPosition,
    ).toBe('2026-09-23');
    expect(
      calendarContent({ queries, settings, view: 'month', date: moment('2026-09-23') }).config
        .startPosition,
    ).toBe('2026-09');
  });

  it('asks the projection for exactly the visible dates', () => {
    const forCalendarProjection = vi.fn<TaskQueryApi['forCalendarProjection']>(() => ({
      materialized: [],
      recurringSources: [],
    }));
    const queries = taskQueryApi({ forCalendarProjection });
    calendarContent({ queries, settings, view: 'week', date: moment('2026-09-23') });
    const dates = forCalendarProjection.mock.calls[0]?.[0] ?? [];
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-09-21');
    expect(dates[6]).toBe('2026-09-27');
  });

  it('projects materialized sources into canonical occurrences inside the visible range', () => {
    const inside = task({ title: 'inside', planning: { due: '2026-09-24' } });
    const outside = task({
      title: 'outside',
      planning: { due: '2026-10-24' },
      source: { filePath: 'other.md', line: 3 },
    });
    const queries = taskQueryApi({
      forCalendarProjection: () => ({
        materialized: [source(inside), source(outside)],
        recurringSources: [],
      }),
    });
    const content = calendarContent({
      queries,
      settings,
      view: 'week',
      date: moment('2026-09-23'),
    });
    expect(content.occurrences.map((entry) => entry.source.node.title)).toEqual(['inside']);
    expect(content.occurrences[0]?.source).toEqual(source(inside));
    expect(content.issues).toEqual([]);
  });

  it('retains the exact sorted projection array and issues without adapting display snapshots', () => {
    const project = vi.spyOn(calendarOccurrences, 'projectCalendarOccurrences');
    const adapt = vi.spyOn(calendarOccurrences, 'taskSnapshotForCalendarOccurrence');
    const later = task({ title: 'Later', planning: { due: '2026-09-25' } });
    const earlier = task({
      title: 'Earlier',
      source: { line: 1 },
      planning: { due: '2026-09-22' },
    });
    const forCalendarProjection = vi.fn(() => ({
      materialized: [source(later), source(earlier)],
      recurringSources: [],
    }));
    const content = calendarContent({
      queries: taskQueryApi({ forCalendarProjection }),
      settings,
      view: 'week',
      date: moment('2026-09-23'),
    });
    expect(forCalendarProjection).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledOnce();
    const result = project.mock.results[0];
    assert(result?.type === 'return');
    expect(content.occurrences).toBe(result.value.occurrences);
    expect(content.issues).toBe(result.value.issues);
    expect(content.occurrences.map((entry) => entry.source.node.title)).toEqual([
      'Earlier',
      'Later',
    ]);
    expect(adapt).not.toHaveBeenCalled();
  });

  it('forwards the recurrence policy to the projection', () => {
    const recurring = task({
      title: 'daily',
      recurrence: 'every day',
      planning: { due: '2026-09-21', scheduled: '2026-09-21' },
    });
    const queries = taskQueryApi({
      forCalendarProjection: () => ({ materialized: [], recurringSources: [source(recurring)] }),
    });
    const keep = calendarContent({
      queries,
      settings: {
        firstDayOfWeek: 1,
        recurrence: { ...DEFAULT_SETTINGS.recurrence, removeScheduledDate: false },
      },
      view: 'week',
      date: moment('2026-09-23'),
    });
    const drop = calendarContent({
      queries,
      settings: {
        firstDayOfWeek: 1,
        recurrence: { ...DEFAULT_SETTINGS.recurrence, removeScheduledDate: true },
      },
      view: 'week',
      date: moment('2026-09-23'),
    });
    expect(keep.occurrences.length).toBeGreaterThan(0);
    expect(keep.occurrences.every((entry) => entry.planning.scheduled !== undefined)).toBe(true);
    expect(drop.occurrences.every((entry) => entry.planning.scheduled === undefined)).toBe(true);
  });
});
