import { describe, expect, it } from 'vitest';
import type { ProjectField, ProjectTableSettings } from '../src/projects/projectFields';
import {
  applyProjectPathOrder,
  buildProjectKanbanModel,
  reorderProjectPaths,
} from '../src/projects/projectKanbanModel';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import type { Project } from '../src/projects/types';
import type { ProjectStatus } from '../src/settings/types';

const statuses: ProjectStatus[] = [
  { id: 'planned', name: 'Planned', onLeftPanel: true },
  { id: 'active', name: 'Active', onLeftPanel: true },
  { id: 'done', name: 'Done', onLeftPanel: false },
];

const fields: ProjectField[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'start', property: 'start', label: 'Start', type: 'date' },
  { id: 'end', property: 'end', label: 'End', type: 'date' },
  { id: 'property:budget', property: 'budget', label: 'Budget', type: 'number' },
  { id: 'property:owners', property: 'owners', label: 'Owners', type: 'list' },
];

function project(name: string, overrides: Partial<Project> = {}): Project {
  return {
    path: `Projects/${name}.md`,
    name,
    frontmatter: {},
    tags: [],
    statusId: 'active',
    rawStatus: null,
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
    ...overrides,
  };
}

function table(): ProjectTableSettings {
  return {
    columns: fields.map(({ id }) => ({ id, visible: true })),
    showDescription: true,
    groupBy: 'status',
    sortBy: { field: 'start', dir: 'asc' },
    hiddenStatuses: [],
  };
}

describe('buildProjectKanbanModel', () => {
  it('keeps configured statuses in order, including empty columns, without nested status groups', () => {
    const settings = buildDefaultProjectKanbanSettings(table());
    settings.groupBy = 'status';
    const result = buildProjectKanbanModel({
      projects: [
        project('Planned project', { statusId: 'planned' }),
        project('Active project'),
        project('Done project', { statusId: 'done' }),
      ],
      fields,
      statuses,
      settings,
    });

    expect(result.columns.map(({ status }) => status.key)).toEqual([
      'id:planned',
      'id:active',
      'id:done',
    ]);
    expect(result.columns.every(({ groups }) => groups.length <= 1)).toBe(true);
    expect(result.uniqueVisibleCount).toBe(3);

    const withoutDone = buildProjectKanbanModel({
      projects: [project('Active project')],
      fields,
      statuses,
      settings,
    });
    expect(withoutDone.columns.map(({ status }) => status.key)).toEqual([
      'id:planned',
      'id:active',
      'id:done',
    ]);
    expect(
      withoutDone.columns.find(({ status }) => status.key === 'id:done')?.uniqueVisibleCount,
    ).toBe(0);
  });

  it('adds raw and no-status columns only when the source has matching projects', () => {
    const settings = buildDefaultProjectKanbanSettings(table());
    const result = buildProjectKanbanModel({
      projects: [
        project('Visible'),
        project('Unknown', { statusId: null, rawStatus: 'Waiting' }),
        project('Unset', { statusId: null, rawStatus: null }),
      ],
      fields,
      statuses,
      settings,
      search: 'Visible',
    });

    expect(result.availableStatusGroups.map(({ key }) => key)).toEqual([
      'id:planned',
      'id:active',
      'id:done',
      'raw:Waiting',
      'none',
    ]);
    expect(result.columns.map(({ status }) => status.key)).toEqual([
      'id:planned',
      'id:active',
      'id:done',
      'raw:Waiting',
      'none',
    ]);
    expect(
      result.columns.find(({ status }) => status.key === 'raw:Waiting')?.uniqueVisibleCount,
    ).toBe(0);
  });

  it('applies hidden-status filters and search independently within status columns', () => {
    const settings = buildDefaultProjectKanbanSettings(table());
    settings.hiddenStatuses = ['id:done', 'none'];
    const result = buildProjectKanbanModel({
      projects: [
        project('Visible match'),
        project('Filtered by search'),
        project('Done match', { statusId: 'done' }),
        project('Unset match', { statusId: null, rawStatus: null }),
      ],
      fields,
      statuses,
      settings,
      search: 'match',
    });

    expect(result.columns.map(({ status }) => status.key)).toEqual(['id:planned', 'id:active']);
    expect(
      result.columns.find(({ status }) => status.key === 'id:active')?.uniqueVisibleCount,
    ).toBe(1);
    expect(result.uniqueVisibleCount).toBe(1);
  });

  it('reuses multi-value grouping while counting each project once per status column', () => {
    const settings = buildDefaultProjectKanbanSettings(table());
    settings.groupBy = 'property:owners';
    settings.sortBy = { field: 'name', dir: 'asc' };
    const result = buildProjectKanbanModel({
      projects: [
        project('Shared', { frontmatter: { owners: ['Ada', 'Lin', 'Ada'] } }),
        project('Solo', { frontmatter: { owners: ['Lin'] } }),
      ],
      fields,
      statuses,
      settings,
    });
    const active = result.columns.find(({ status }) => status.key === 'id:active');

    expect(
      active?.groups.map(({ label, projects }) => [label, projects.map(({ name }) => name)]),
    ).toEqual([
      ['Ada', ['Shared']],
      ['Lin', ['Shared', 'Solo']],
    ]);
    expect(active?.uniqueVisibleCount).toBe(2);
    expect(result.uniqueVisibleCount).toBe(2);
  });

  it('keeps typed sorting stable inside every column and applies saved manual order', () => {
    const projects = [
      project('Ten', { frontmatter: { budget: 10 } }),
      project('Two B', { frontmatter: { budget: 2 } }),
      project('Two A', { frontmatter: { budget: 2 } }),
    ];
    const settings = buildDefaultProjectKanbanSettings(table());
    settings.groupBy = 'none';
    settings.sortBy = { field: 'property:budget', dir: 'asc' };
    const sorted = buildProjectKanbanModel({ projects, fields, statuses, settings });

    expect(sorted.columns[1]?.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Two A',
      'Two B',
      'Ten',
    ]);

    settings.sortBy = { field: 'none', dir: 'asc' };
    settings.manualOrder = {
      'id:active': ['Projects/Two B.md', 'Projects/Ten.md'],
    };
    const manual = buildProjectKanbanModel({ projects, fields, statuses, settings });
    expect(manual.columns[1]?.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Two B',
      'Ten',
      'Two A',
    ]);
  });

  it('does not mutate projects, fields, statuses, or settings', () => {
    const projects = [project('A'), project('B', { statusId: null, rawStatus: 'Waiting' })];
    const settings = buildDefaultProjectKanbanSettings(table());
    settings.groupBy = 'property:owners';
    const before = structuredClone({ projects, fields, statuses, settings });

    buildProjectKanbanModel({ projects, fields, statuses, settings });

    expect({ projects, fields, statuses, settings }).toEqual(before);
  });
});

describe('project path ordering', () => {
  it('reorders around visible targets without removing hidden paths', () => {
    expect(reorderProjectPaths(['hidden.md', 'a.md', 'b.md'], 'b.md', 'a.md')).toEqual([
      'hidden.md',
      'b.md',
      'a.md',
    ]);
    expect(reorderProjectPaths(['a.md', 'a.md', 'b.md'], 'c.md')).toEqual(['a.md', 'b.md', 'c.md']);
    expect(reorderProjectPaths(['a.md', 'b.md'], 'a.md', 'a.md')).toEqual(['b.md', 'a.md']);
  });

  it('applies saved ranks and appends incoming projects deterministically', () => {
    const projects = [project('New B'), project('Saved B'), project('New A'), project('Saved A')];
    const ordered = applyProjectPathOrder(projects, [
      'Projects/Hidden.md',
      'Projects/Saved A.md',
      'Projects/Saved B.md',
    ]);

    expect(ordered.map(({ name }) => name)).toEqual(['Saved A', 'Saved B', 'New B', 'New A']);
    expect(projects.map(({ name }) => name)).toEqual(['New B', 'Saved B', 'New A', 'Saved A']);
  });
});
