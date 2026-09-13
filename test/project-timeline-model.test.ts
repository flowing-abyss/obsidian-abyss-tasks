import { describe, expect, it } from 'vitest';
import { projectCalendarDay } from '../src/projects/projectDateValue';
import type { ProjectFieldCatalogItem } from '../src/projects/projectFields';
import { buildDefaultProjectTableSettings } from '../src/projects/projectTableSettings';
import {
  buildProjectTimelineModel,
  projectTimelineBarGeometry,
  projectTimelineWindow,
} from '../src/projects/projectTimelineModel';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

const fields: ProjectFieldCatalogItem[] = [
  { id: 'name', label: 'Project', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'start', label: 'Start', type: 'date', property: 'start' },
  { id: 'end', label: 'End', type: 'date', property: 'end' },
  { id: 'property:Teams', label: 'Teams', type: 'list', property: 'Teams' },
];

function project(path: string, frontmatter: Record<string, unknown>): Project {
  return {
    path,
    name: path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
    frontmatter,
    tags: [],
    statusId: DEFAULT_SETTINGS.projects.statuses[0]?.id ?? null,
    rawStatus: null,
    stats: { total: 4, done: 2, cancelled: 0, inProgress: 1 },
  };
}

function input(projects: Project[]) {
  const table = buildDefaultProjectTableSettings();
  return {
    projects,
    fields,
    statuses: DEFAULT_SETTINGS.projects.statuses,
    propertyDefinitions: {},
    settings: buildDefaultProjectTimelineSettings(table),
  };
}

describe('project Timeline model', () => {
  it('keeps malformed, open, and unscheduled dates visibly distinct', () => {
    const model = buildProjectTimelineModel(
      input([
        project('Projects/Closed.md', { start: '2026-09-01', end: '2026-09-03' }),
        project('Projects/Open end.md', { start: '2026-09-04' }),
        project('Projects/Open start.md', { end: '2026-09-05' }),
        project('Projects/Unscheduled.md', {}),
        project('Projects/Malformed.md', { start: 'September', end: '2026-09-02' }),
        project('Projects/Reversed.md', { start: '2026-09-08', end: '2026-09-07' }),
      ]),
    );
    const ranges = Object.fromEntries(
      model.groups.flatMap((group) => group.rows.map((row) => [row.project.path, row.range.kind])),
    );

    expect(ranges).toEqual({
      'Projects/Closed.md': 'closed',
      'Projects/Open end.md': 'open-end',
      'Projects/Open start.md': 'open-start',
      'Projects/Unscheduled.md': 'unscheduled',
      'Projects/Malformed.md': 'malformed',
      'Projects/Reversed.md': 'malformed',
    });
    expect(model.uniqueVisibleCount).toBe(6);
  });

  it('counts a project once when a multi-value group creates occurrences', () => {
    const configured = input([project('Projects/A.md', { Teams: ['One', 'Two'] })]);
    configured.settings.groupBy = 'property:Teams';

    const model = buildProjectTimelineModel(configured);

    expect(model.groups.map((group) => group.rows.length)).toEqual([1, 1]);
    expect(model.uniqueVisibleCount).toBe(1);
  });

  it('removes only unscheduled projects when that presentation is disabled', () => {
    const configured = input([
      project('Projects/Scheduled.md', { start: '2026-09-01' }),
      project('Projects/Unscheduled.md', {}),
      project('Projects/Malformed.md', { start: 'later' }),
    ]);
    configured.settings.showUnscheduled = false;

    const model = buildProjectTimelineModel(configured);

    expect(model.groups.flatMap(({ rows }) => rows.map(({ project }) => project.path))).toEqual([
      'Projects/Scheduled.md',
      'Projects/Malformed.md',
    ]);
    expect(model.uniqueVisibleCount).toBe(2);
  });

  it('uses inclusive calendar days across leap days and DST-sized local intervals', () => {
    const window = projectTimelineWindow(new Date(2024, 1, 29), 'day');
    const geometry = projectTimelineBarGeometry(
      { kind: 'closed', startDay: '2024-02-29', endDay: '2024-03-02' },
      window,
    );

    expect(window.startDay).toBe('2024-02-26');
    expect(window.endDay).toBe('2024-03-10');
    expect(window.dayCount).toBe(14);
    expect(geometry).toEqual({ leftPercent: 21.428571428571427, widthPercent: 21.428571428571427 });
  });

  it.each([
    {
      scale: 'day',
      window: { startDay: '2028-06-05', endDay: '2028-06-18', dayCount: 14 },
      firstLabels: ['Mon 5', 'Tue 6'],
    },
    {
      scale: 'week',
      window: { startDay: '2028-05-01', endDay: '2028-07-23', dayCount: 84 },
      firstLabels: ['May 1', 'May 8'],
    },
    {
      scale: 'month',
      window: { startDay: '2028-01-01', endDay: '2028-12-31', dayCount: 366 },
      firstLabels: ['Jan', 'Feb'],
    },
    {
      scale: 'quarter',
      window: { startDay: '2027-01-01', endDay: '2029-12-31', dayCount: 1096 },
      firstLabels: ['Q1 2027', 'Q2 2027'],
    },
    {
      scale: 'year',
      window: { startDay: '2026-01-01', endDay: '2030-12-31', dayCount: 1826 },
      firstLabels: ['2026', '2027'],
    },
  ] as const)(
    'uses a useful $scale viewport with readable major labels',
    ({ scale, window: expected, firstLabels }) => {
      const window = projectTimelineWindow(new Date(2028, 5, 10), scale);

      expect(window).toMatchObject({ ...expected, scale });
      expect(window.ticks.slice(0, 2).map(({ label }) => label)).toEqual(firstLabels);
      expect(window.ticks.length).toBeLessThanOrEqual(14);
    },
  );

  it('marks reversed same-day local and offset datetimes malformed before day projection', () => {
    const model = buildProjectTimelineModel(
      input([
        project('Projects/Reversed local.md', {
          start: '2026-09-13T18:00',
          end: '2026-09-13T09:00',
        }),
        project('Projects/Valid local.md', {
          start: '2026-09-13T09:00',
          end: '2026-09-13T18:00',
        }),
        project('Projects/Reversed offset.md', {
          start: '2026-09-13T12:00:00Z',
          end: '2026-09-13T11:00:00Z',
        }),
      ]),
    );

    expect(
      Object.fromEntries(
        model.groups.flatMap(({ rows }) =>
          rows.map(({ project: item, range }) => [item.path, range.kind]),
        ),
      ),
    ).toEqual({
      'Projects/Reversed local.md': 'malformed',
      'Projects/Valid local.md': 'closed',
      'Projects/Reversed offset.md': 'malformed',
    });
  });

  it('keeps projected year edges and a week crossing year 10000 round-trippable', () => {
    const anchor = new Date(0);
    anchor.setFullYear(9999, 11, 31);
    anchor.setHours(12, 0, 0, 0);
    const window = projectTimelineWindow(anchor, 'week');

    expect(window).toMatchObject({
      startDay: '9999-11-22',
      endDay: '10000-02-13',
      dayCount: 84,
    });
    expect(
      projectTimelineBarGeometry(
        { kind: 'closed', startDay: '9999-12-31', endDay: '10000-01-01' },
        window,
      ),
    ).toEqual({ leftPercent: 46.42857142857143, widthPercent: 2.380952380952381 });
    expect(projectCalendarDay('0100-01-01T00:00:00+14:00')).toBe('0099-12-31');
  });

  it.each([
    {
      scale: 'week',
      startDay: '0099-11-23',
      endDay: '0100-02-14',
      dayCount: 84,
      dayOffset: 38,
      visibleDays: 2,
    },
    {
      scale: 'month',
      startDay: '0099-01-01',
      endDay: '0099-12-31',
      dayCount: 365,
      dayOffset: 364,
      visibleDays: 1,
    },
    {
      scale: 'quarter',
      startDay: '0098-01-01',
      endDay: '0100-12-31',
      dayCount: 1095,
      dayOffset: 729,
      visibleDays: 2,
    },
    {
      scale: 'year',
      startDay: '0097-01-01',
      endDay: '0101-12-31',
      dayCount: 1825,
      dayOffset: 1094,
      visibleDays: 2,
    },
  ] as const)(
    'preserves projected years below 100 for the $scale window',
    ({ scale, startDay, endDay, dayCount, dayOffset, visibleDays }) => {
      const anchor = new Date(0);
      anchor.setFullYear(99, 11, 31);
      anchor.setHours(12, 0, 0, 0);
      const window = projectTimelineWindow(anchor, scale);

      expect(window).toMatchObject({ startDay, endDay, dayCount });
      expect(
        projectTimelineBarGeometry(
          { kind: 'closed', startDay: '0099-12-31', endDay: '0100-01-01' },
          window,
        ),
      ).toEqual({
        leftPercent: (dayOffset / dayCount) * 100,
        widthPercent: (visibleDays / dayCount) * 100,
      });
    },
  );
});
