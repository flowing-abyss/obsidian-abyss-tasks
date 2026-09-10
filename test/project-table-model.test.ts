import { describe, expect, it } from 'vitest';
import { planProjectGroupDrop } from '../src/panels/projects/projectTableDrag';
import type {
  ProjectField,
  ProjectFieldCatalogItem,
  ProjectTableSettings,
} from '../src/projects/projectFields';
import type { ProjectPropertyDefinition } from '../src/projects/projectPropertyDefinitions';
import {
  buildProjectTableModel,
  projectProgress,
  projectTableDisplayValues,
  projectTableGroupLinkIdentity,
} from '../src/projects/projectTableModel';
import type { Project } from '../src/projects/types';
import type { ProjectStatus } from '../src/settings/types';
import { expectDefined } from './helpers';

const statuses: ProjectStatus[] = [
  {
    id: 'planned',
    name: 'Planned',
    onLeftPanel: true,
  },
  {
    id: 'active',
    name: 'Active',
    onLeftPanel: true,
  },
  {
    id: 'done',
    name: 'Done',
    onLeftPanel: false,
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
    showDescription: true,
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
  propertyDefinitions?: Readonly<Record<string, ProjectPropertyDefinition>>,
) {
  return buildProjectTableModel({
    projects,
    fields,
    statuses,
    settings,
    search,
    ...(propertyDefinitions === undefined ? {} : { propertyDefinitions }),
  });
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

  it('uses display aliases without changing raw status or property group identities', () => {
    const presentedStatuses = statuses.map((status) =>
      status.id === 'active' ? { ...status, displayName: 'In progress' } : status,
    );
    const activeProject = project('Active', {
      frontmatter: { owners: ['raw-team'] },
      statusId: 'active',
    });
    const statusModel = buildProjectTableModel({
      projects: [activeProject],
      fields,
      statuses: presentedStatuses,
      settings: table({ groupBy: 'status' }),
    });
    const ownerModel = model([activeProject], table({ groupBy: 'property:owners' }), '', {
      'property:owners': {
        type: 'list',
        presetsEnabled: true,
        presets: [
          { value: 'raw-team', displayName: 'Platform', color: '#123456', display: 'badge' },
        ],
      },
    });

    expect(statusModel.groups[0]).toMatchObject({ key: 'id:active', label: 'In progress' });
    expect(
      projectTableDisplayValues(activeProject, expectDefined(fields[1]), presentedStatuses),
    ).toEqual(['In progress']);
    expect(ownerModel.groups[0]).toMatchObject({
      key: 'value:raw-team',
      label: 'Platform',
      value: 'raw-team',
      presentation: { color: '#123456', display: 'badge' },
    });
  });

  it('keeps status labels and configured grouping when the status field is read-only', () => {
    const readOnlyStatus: ProjectFieldCatalogItem = {
      id: 'status',
      property: 'status',
      label: 'Status',
      type: null,
    };
    const readOnlyFields = fields.map((field) => (field.id === 'status' ? readOnlyStatus : field));
    const activeProject = project('Active project', {
      statusId: 'active',
      frontmatter: { status: 'active' },
    });
    const projects = [
      project('Done project', { statusId: 'done', frontmatter: { status: 'done' } }),
      activeProject,
    ];

    const result = buildProjectTableModel({
      projects,
      fields: readOnlyFields,
      statuses,
      settings: table({ groupBy: 'status', sortBy: { field: 'status', dir: 'asc' } }),
    });

    expect(result.groups.map(({ key, label }) => [key, label])).toEqual([
      ['id:active', 'Active'],
      ['id:done', 'Done'],
    ]);
    expect(projectTableDisplayValues(activeProject, readOnlyStatus, statuses)).toEqual(['Active']);
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

  it('groups link aliases by resolved target and retains the representative source context', () => {
    expect(
      projectTableGroupLinkIdentity(
        '[[People/Team|Platform]]',
        'Projects/Origin.md',
        () => 'People/Team.md',
      ),
    ).toBe('link:people/team.md');
    const projects = [
      project('Zulu', {
        path: 'Projects/Origin.md',
        frontmatter: { owners: '[[People/Team|Platform]]' },
      }),
      project('Alpha', {
        path: 'Projects/Sorted-first.md',
        frontmatter: { owners: '[Core team](../../People/Team.md)' },
      }),
    ];
    const result = buildProjectTableModel({
      projects,
      fields,
      statuses,
      settings: table({ groupBy: 'property:owners', sortBy: { field: 'name', dir: 'asc' } }),
      resolveLink: (target) =>
        target === 'People/Team' || target === '../../People/Team.md'
          ? 'People/Team.md'
          : undefined,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: 'link:people/team.md',
      label: 'Platform',
      value: '[[People/Team|Platform]]',
      sourcePath: 'Projects/Origin.md',
    });
    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual(['Alpha', 'Zulu']);
  });

  it('normalizes internal resolver inputs while preserving raw representative links', () => {
    const resolverInputs: Array<readonly [string, string]> = [];
    const result = buildProjectTableModel({
      projects: [
        project('Plain', { frontmatter: { owners: '[[../People/Anna Smith]]' } }),
        project('Encoded', {
          frontmatter: { owners: '[Anna](../People/Anna%20Smith.md#Details)' },
        }),
        project('Heading', {
          frontmatter: { owners: '[[../People/Anna Smith#Details|A. Smith]]' },
        }),
      ],
      fields,
      statuses,
      settings: table({ groupBy: 'property:owners' }),
      resolveLink: (target, sourcePath) => {
        resolverInputs.push([target, sourcePath]);
        return target === '../People/Anna Smith' || target === '../People/Anna Smith.md'
          ? 'People/Anna Smith.md'
          : undefined;
      },
    });

    expect(resolverInputs).toEqual([
      ['../People/Anna Smith', 'Projects/Plain.md'],
      ['../People/Anna Smith.md', 'Projects/Encoded.md'],
      ['../People/Anna Smith', 'Projects/Heading.md'],
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: 'link:people/anna smith.md',
      value: '[[../People/Anna Smith]]',
      sourcePath: 'Projects/Plain.md',
    });
    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual([
      'Encoded',
      'Heading',
      'Plain',
    ]);
  });

  it('groups identical absolute URLs independently of source path without folding URL case', () => {
    const url = 'https://Example.com/CaseSensitive?Token=AbC#Part';
    const result = buildProjectTableModel({
      projects: [
        project('One', { frontmatter: { owners: `[First](${url})` } }),
        project('Two', { frontmatter: { owners: `[Second](${url})` } }),
      ],
      fields,
      statuses,
      settings: table({ groupBy: 'property:owners' }),
      resolveLink: () => undefined,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe(`link:external:${url}`);
    expect(result.groups[0]?.projects.map(({ name }) => name)).toEqual(['One', 'Two']);
  });

  it('does not decode percent characters in wiki resolver paths', () => {
    let resolverTarget = '';
    expect(
      projectTableGroupLinkIdentity(
        '[[People/Literal%20Name#Details]]',
        'Projects/Source.md',
        (target) => {
          resolverTarget = target;
          return 'People/Literal%20Name.md';
        },
      ),
    ).toBe('link:people/literal%20name.md');
    expect(resolverTarget).toBe('People/Literal%20Name');
  });

  it('keeps identical relative link text separate when native resolution finds different notes', () => {
    const projects = [
      project('One', { path: 'Projects/One/Plan.md', frontmatter: { owners: '[[Team]]' } }),
      project('Two', { path: 'Projects/Two/Plan.md', frontmatter: { owners: '[[Team]]' } }),
    ];
    const result = buildProjectTableModel({
      projects,
      fields,
      statuses,
      settings: table({ groupBy: 'property:owners' }),
      resolveLink: (_target, sourcePath) =>
        sourcePath.includes('/One/') ? 'Projects/One/Team.md' : 'Projects/Two/Team.md',
    });

    expect(result.groups.map(({ key }) => key)).toEqual([
      'link:projects/one/team.md',
      'link:projects/two/team.md',
    ]);
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

  it('keeps an unknown raw status as the assignable value of its rendered group', () => {
    const result = model(
      [project('Known'), project('Unknown', { statusId: null, rawStatus: 'QA unknown status' })],
      table({ groupBy: 'status' }),
    );
    const source = expectDefined(result.groups.find(({ key }) => key === 'id:active'));
    const target = expectDefined(result.groups.find(({ key }) => key === 'raw:QA unknown status'));

    expect(target.value).toBe('QA unknown status');
    expect(
      planProjectGroupDrop({
        field: expectDefined(fields.find(({ id }) => id === 'status')),
        currentValue: 'Active',
        source,
        target,
        statuses,
      }),
    ).toBe('QA unknown status');
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
