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
    const window = projectTimelineWindow(new Date(2024, 1, 29), 'week');
    const geometry = projectTimelineBarGeometry(
      { kind: 'closed', startDay: '2024-02-29', endDay: '2024-03-02' },
      window,
    );

    expect(window.startDay).toBe('2024-02-26');
    expect(window.endDay).toBe('2024-03-03');
    expect(window.dayCount).toBe(7);
    expect(geometry).toEqual({ leftPercent: 42.857142857142854, widthPercent: 42.857142857142854 });
  });

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
      startDay: '9999-12-27',
      endDay: '10000-01-02',
      dayCount: 7,
    });
    expect(
      projectTimelineBarGeometry(
        { kind: 'closed', startDay: '9999-12-31', endDay: '10000-01-01' },
        window,
      ),
    ).toEqual({ leftPercent: 57.14285714285714, widthPercent: 28.57142857142857 });
    expect(projectCalendarDay('0100-01-01T00:00:00+14:00')).toBe('0099-12-31');
  });

  it.each([
    {
      scale: 'week',
      startDay: '0099-12-28',
      endDay: '0100-01-03',
      dayCount: 7,
      dayOffset: 3,
      visibleDays: 2,
    },
    {
      scale: 'month',
      startDay: '0099-12-01',
      endDay: '0099-12-31',
      dayCount: 31,
      dayOffset: 30,
      visibleDays: 1,
    },
    {
      scale: 'quarter',
      startDay: '0099-10-01',
      endDay: '0099-12-31',
      dayCount: 92,
      dayOffset: 91,
      visibleDays: 1,
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
