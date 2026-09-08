import { describe, expect, it } from 'vitest';
import type { ProjectField, ProjectTableSettings } from '../src/projects/projectFields';
import { buildProjectTableModel, projectProgress } from '../src/projects/projectTableModel';
import type { Project } from '../src/projects/types';
import type { ProjectStatus } from '../src/settings/types';

const statuses: ProjectStatus[] = [
  {
    id: 'planned',
    label: 'Planned',
    onLeftPanel: true,
    match: { kind: 'property', property: 'status', value: 'planned' },
  },
  {
    id: 'active',
    label: 'Active',
    onLeftPanel: true,
    match: { kind: 'property', property: 'status', value: 'active' },
  },
  {
    id: 'done',
    label: 'Done',
    onLeftPanel: false,
    match: { kind: 'property', property: 'status', value: 'done' },
  },
];

const fields: ProjectField[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'progress', label: 'Progress', type: 'progress' },
  { id: 'start', property: 'start', label: 'Start', type: 'date' },
  { id: 'end', property: 'end', label: 'End', type: 'date' },
  { id: 'property:budget', property: 'budget', label: 'Budget', type: 'number' },
  { id: 'property:owners', property: 'owners', label: 'Owners', type: 'list' },
  { id: 'property:approved', property: 'approved', label: 'Approved', type: 'checkbox' },
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

function table(overrides: Partial<ProjectTableSettings> = {}): ProjectTableSettings {
  return {
    columns: fields.map(({ id }) => ({ id, visible: true })),
    groupBy: 'none',
    sortBy: { field: 'end', dir: 'asc' },
    hiddenStatuses: [],
    ...overrides,
  };
}

function model(
  projects: readonly Project[],
  settings: ProjectTableSettings = table(),
  search = '',
) {
  return buildProjectTableModel({ projects, fields, statuses, settings, search });
}

describe('buildProjectTableModel', () => {
  it('sorts by end ascending with empty values last', () => {
    const result = model([
      project('No end'),
      project('Later', { frontmatter: { end: '2026-10-02' } }),
      project('Earlier', { frontmatter: { end: '2026-09-01' } }),
    ]);

    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Earlier',
      'Later',
      'No end',
    ]);
  });

  it('keeps empty values last when sorting descending', () => {
    const result = model(
      [
        project('No end'),
        project('Later', { frontmatter: { end: '2026-10-02' } }),
        project('Earlier', { frontmatter: { end: '2026-09-01' } }),
      ],
      table({ sortBy: { field: 'end', dir: 'desc' } }),
    );

    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Later',
      'Earlier',
      'No end',
    ]);
  });

  it('orders number properties numerically', () => {
    const result = model(
      [
        project('Ten', { frontmatter: { budget: 10 } }),
        project('Two', { frontmatter: { budget: 2 } }),
      ],
      table({ sortBy: { field: 'property:budget', dir: 'asc' } }),
    );

    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual(['Two', 'Ten']);
  });

  it('resolves grouping and sorting fields independently of column visibility', () => {
    const settings = table({
      columns: fields.map(({ id }) => ({ id, visible: id !== 'property:budget' })),
      groupBy: 'property:owners',
      sortBy: { field: 'property:budget', dir: 'asc' },
    });
    const result = model(
      [
        project('Ten', { frontmatter: { budget: 10, owners: ['Team'] } }),
        project('Two', { frontmatter: { budget: 2, owners: ['Team'] } }),
      ],
      settings,
    );

    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual(['Two', 'Ten']);
  });

  it('uses configured status order for status grouping', () => {
    const result = model(
      [
        project('Done project', { statusId: 'done' }),
        project('Active project', { statusId: 'active' }),
        project('Planned project', { statusId: 'planned' }),
      ],
      table({ groupBy: 'status' }),
    );

    expect(result.groups.map(({ label }) => label)).toEqual(['Planned', 'Active', 'Done']);
  });

  it('repeats list-valued projects across groups while counting unique projects once', () => {
    const result = model(
      [
        project('Shared', { frontmatter: { owners: ['Ada', 'Lin', 'Ada'] } }),
        project('Solo', { frontmatter: { owners: ['Lin'] } }),
      ],
      table({ groupBy: 'property:owners', sortBy: { field: 'name', dir: 'asc' } }),
    );

    expect(
      result.groups.map(({ label, projects }) => [label, projects.map(({ name }) => name)]),
    ).toEqual([
      ['Ada', ['Shared']],
      ['Lin', ['Shared', 'Solo']],
    ]);
    expect(result.uniqueVisibleCount).toBe(2);
  });

  it('sorts list values as a deduplicated display set without changing source order', () => {
    const repeated = project('Zulu repeated', { frontmatter: { owners: ['Ada', 'Ada'] } });
    const single = project('Alpha single', { frontmatter: { owners: ['Ada'] } });
    const result = model(
      [repeated, single],
      table({ sortBy: { field: 'property:owners', dir: 'desc' } }),
    );

    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Alpha single',
      'Zulu repeated',
    ]);
    expect(repeated.frontmatter['owners']).toEqual(['Ada', 'Ada']);
  });

  it('searches names and visible field values', () => {
    const projects = [
      project('Alpha', { frontmatter: { owners: ['Ada Lovelace'] } }),
      project('Beta', { frontmatter: { owners: ['Grace Hopper'] } }),
    ];

    expect(model(projects, table(), 'alpha').uniqueVisibleCount).toBe(1);
    expect(model(projects, table(), 'hopper').groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Beta',
    ]);
  });

  it('searches the complete displayed checkbox and progress values', () => {
    const projects = [
      project('Approved', {
        frontmatter: { approved: true },
        stats: { total: 10, done: 6, cancelled: 0, inProgress: 1 },
      }),
      project('Rejected', {
        frontmatter: { approved: false },
        stats: { total: 4, done: 1, cancelled: 0, inProgress: 0 },
      }),
    ];

    expect(model(projects, table(), 'yes').groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Approved',
    ]);
    expect(model(projects, table(), 'no').groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Rejected',
    ]);
    expect(
      model(projects, table(), '60% (6/10)').groups[0]?.projects.map(({ name }) => name),
    ).toEqual(['Approved']);
    expect(model(projects, table(), 'true').uniqueVisibleCount).toBe(0);
  });

  it('groups equal displayed progress together and treats an empty denominator as missing', () => {
    const result = model(
      [
        project('Open remainder', {
          stats: { total: 2, done: 1, cancelled: 0, inProgress: 0 },
        }),
        project('In-progress remainder', {
          stats: { total: 3, done: 1, cancelled: 1, inProgress: 1 },
        }),
        project('No included tasks', {
          stats: { total: 2, done: 0, cancelled: 2, inProgress: 0 },
        }),
      ],
      table({ groupBy: 'progress' }),
    );

    expect(
      result.groups.map(({ key, label, projects }) => [
        key,
        label,
        projects.map(({ name }) => name),
      ]),
    ).toEqual([
      ['value:50% (1/2)', '50% (1/2)', ['In-progress remainder', 'Open remainder']],
      ['empty', 'No value', ['No included tasks']],
    ]);
  });

  it('keeps unavailable and no-status badges discoverable before status filtering', () => {
    const result = model(
      [
        project('Unknown', { statusId: null, rawStatus: 'blocked' }),
        project('None', { statusId: null, rawStatus: null }),
      ],
      table({ groupBy: 'status', hiddenStatuses: ['raw:blocked', 'none'] }),
    );

    expect(result.uniqueVisibleCount).toBe(0);
    expect(result.availableStatusGroups.map(({ key }) => key)).toEqual([
      'id:planned',
      'id:active',
      'id:done',
      'raw:blocked',
      'none',
    ]);
  });
});

describe('projectProgress', () => {
  it('excludes cancelled tasks from the denominator', () => {
    expect(projectProgress({ total: 12, done: 6, cancelled: 2, inProgress: 1 })).toEqual({
      done: 6,
      total: 10,
      percent: 60,
    });
  });

  it('uses a neutral percentage when no non-cancelled tasks exist', () => {
    expect(projectProgress({ total: 2, done: 0, cancelled: 2, inProgress: 0 })).toEqual({
      done: 0,
      total: 0,
      percent: null,
    });
  });
});
