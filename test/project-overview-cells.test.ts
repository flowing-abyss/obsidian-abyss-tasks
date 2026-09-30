// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { projectKanbanOccurrenceId } from '../src/panels/projects/projectKanbanCards';
import {
  NO_PROJECT_OVERVIEW_CELLS,
  projectKanbanCells,
  projectTableCells,
  projectTableOccurrenceId,
  projectTimelineCells,
  visibleProjectColumns,
  type ProjectOverviewCells,
  type ProjectOverviewFieldResolver,
} from '../src/panels/projects/projectOverviewCells';
import { createOwnedInferredPropertyClear } from '../src/projects/projectEdits';
import type { ProjectColumn, ProjectFieldCatalogItem } from '../src/projects/projectFields';
import type { ProjectKanbanColumn, ProjectKanbanModel } from '../src/projects/projectKanbanModel';
import type { ProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import type { ProjectTableGroup, ProjectTableModel } from '../src/projects/projectTableModel';
import type { ProjectTimelineModel } from '../src/projects/projectTimelineModel';
import type { ProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { expectDefined } from './helpers';

const fields: ProjectFieldCatalogItem[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'progress', label: 'Progress', type: 'progress' },
  { id: 'start', property: 'start', label: 'Start', type: 'date' },
  { id: 'end', property: 'end', label: 'End', type: 'date' },
  { id: 'description', property: 'description', label: 'Description', type: 'text' },
  { id: 'property:Budget', property: 'Budget', label: 'Budget', type: 'number' },
];

const asIs: ProjectOverviewFieldResolver = (_project, field) => ({ field });

function project(name: string, overrides: Partial<Project> = {}): Project {
  return {
    path: `Projects/${name}.md`,
    name,
    frontmatter: { start: '2026-09-01', end: '2026-09-30', description: `About ${name}` },
    tags: [],
    statusId: 'active',
    rawStatus: null,
    stats: {
      total: 4,
      done: 1,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    ...overrides,
  };
}

function group(key: string, projects: Project[]): ProjectTableGroup {
  return { key, label: key, value: key, projects };
}

/** Each cell as `occurrence|column`, in the order selection walks them. */
function order(cells: ProjectOverviewCells): string[] {
  return cells.cells.map(({ identity }) => `${identity.occurrenceId}|${identity.columnId}`);
}

describe('visibleProjectColumns', () => {
  it('keeps visible columns whose field exists, in saved order', () => {
    const columns: ProjectColumn[] = [
      { id: 'name', visible: true },
      { id: 'status', visible: false },
      { id: 'missing', visible: true },
      { id: 'property:budget', visible: true },
      { id: 'start', visible: true },
    ];

    expect(
      visibleProjectColumns(columns, fields).map(({ column, field }) => [column.id, field.id]),
    ).toEqual([
      ['name', 'name'],
      ['property:budget', 'property:Budget'],
      ['start', 'start'],
    ]);
  });
});

describe('projectTableCells', () => {
  const a = project('A');
  const b = project('B');
  const c = project('C');
  const columns = visibleProjectColumns(
    [
      { id: 'name', visible: true },
      { id: 'property:budget', visible: true },
    ],
    fields,
  );

  function model(groups: ProjectTableGroup[]): ProjectTableModel {
    return { groups, uniqueVisibleCount: 0, availableStatusGroups: [] };
  }

  function tableCells(
    groups: ProjectTableGroup[],
    grouped: boolean,
    collapsedGroups: ReadonlySet<string> = new Set(),
  ) {
    return projectTableCells({
      model: model(groups),
      grouped,
      columns,
      collapsedGroups,
      effectiveField: asIs,
    });
  }

  it('lists a cell per visible column in every row, with header rows only when grouped', () => {
    const groups = [group('g1', [a, b]), group('g2', [c])];
    const occurrence = (groupKey: string, item: Project) =>
      projectTableOccurrenceId(groupKey, item.path);

    const grouped = tableCells(groups, true);
    expect(grouped.rows.map(({ key }) => key)).toEqual([
      'group:g1',
      occurrence('g1', a),
      occurrence('g1', b),
      'group:g2',
      occurrence('g2', c),
    ]);
    expect(order(grouped.cells)).toEqual([
      `${occurrence('g1', a)}|name`,
      `${occurrence('g1', a)}|property:budget`,
      `${occurrence('g1', b)}|name`,
      `${occurrence('g1', b)}|property:budget`,
      `${occurrence('g2', c)}|name`,
      `${occurrence('g2', c)}|property:budget`,
    ]);
    expect(grouped.cells.cells[1]).toEqual({
      identity: {
        occurrenceId: occurrence('g1', a),
        projectPath: a.path,
        groupKey: 'g1',
        columnId: 'property:budget',
      },
      project: a,
      field: fields[6],
      ownedClear: undefined,
    });
    expect(grouped.cells.identities).toEqual(grouped.cells.cells.map(({ identity }) => identity));
    expect(grouped.cells.rowIds).toEqual([
      occurrence('g1', a),
      occurrence('g1', b),
      occurrence('g2', c),
    ]);
    expect(grouped.cells.columnIds).toEqual(['name', 'property:budget']);

    const flat = tableCells([group('all', [a, b])], false);
    expect(flat.rows.map(({ key }) => key)).toEqual([occurrence('all', a), occurrence('all', b)]);
    expect(flat.rows.every(({ project: item }) => item !== undefined)).toBe(true);
  });

  it('leaves out a collapsed group only when the saved grouping groups', () => {
    const groups = [group('g1', [a, b]), group('g2', [c])];
    const collapsed = new Set(['g1']);

    const grouped = tableCells(groups, true, collapsed);
    expect(grouped.rows.map(({ key }) => key)).toEqual([
      'group:g1',
      'group:g2',
      projectTableOccurrenceId('g2', c.path),
    ]);
    expect(grouped.cells.rowIds).toEqual([projectTableOccurrenceId('g2', c.path)]);

    const flat = tableCells(groups, false, collapsed);
    expect(flat.cells.rowIds).toEqual([
      projectTableOccurrenceId('g1', a.path),
      projectTableOccurrenceId('g1', b.path),
      projectTableOccurrenceId('g2', c.path),
    ]);
  });

  it('encodes occurrence ids and keeps a project listed in two groups apart', () => {
    const shared = project('Shared: one');
    const first = projectTableOccurrenceId('value:a/b', shared.path);
    const second = projectTableOccurrenceId('value:c d', shared.path);
    expect(first).toBe('value%3Aa%2Fb:Projects%2FShared%3A%20one.md');
    expect(second).toBe('value%3Ac%20d:Projects%2FShared%3A%20one.md');

    const { cells } = tableCells(
      [group('value:a/b', [shared]), group('value:c d', [shared])],
      true,
    );
    expect(cells.rowIds).toEqual([first, second]);
    expect(cells.cell(first, 'name')?.identity.groupKey).toBe('value:a/b');
    expect(cells.cell(second, 'name')?.identity.groupKey).toBe('value:c d');
    expect(cells.cell(second, 'name')?.project).toBe(shared);
  });

  it('keeps the visible columns when no row is listed', () => {
    const { rows, cells } = tableCells([], true);

    expect(rows).toEqual([]);
    expect(cells.cells).toEqual([]);
    expect(cells.rowIds).toEqual([]);
    expect(cells.columnIds).toEqual(['name', 'property:budget']);
  });
});

describe('projectKanbanCells', () => {
  function settings(overrides: Partial<ProjectKanbanSettings> = {}): ProjectKanbanSettings {
    return {
      fields: [
        { id: 'start', visible: true },
        { id: 'end', visible: true },
      ],
      showEmptyFields: true,
      descriptionLines: 1,
      progress: 'full',
      showEmptyProgress: false,
      emptyColumns: 'compact',
      groupBy: 'none',
      sortBy: { field: 'none', dir: 'asc' },
      hiddenStatuses: [],
      collapsedColumns: [],
      manualOrder: {},
      ...overrides,
    };
  }

  function column(key: string, groups: ProjectTableGroup[], count?: number): ProjectKanbanColumn {
    const paths = new Set(groups.flatMap(({ projects }) => projects.map(({ path }) => path)));
    return {
      status: { key, label: key, statusId: key },
      groups,
      uniqueVisibleCount: count ?? paths.size,
    };
  }

  function kanbanCells(
    columns: ProjectKanbanColumn[],
    options: {
      readonly settings?: ProjectKanbanSettings;
      readonly collapsedGroups?: ReadonlySet<string>;
      readonly effectiveField?: ProjectOverviewFieldResolver;
    } = {},
  ): ProjectOverviewCells {
    const model: ProjectKanbanModel = {
      columns,
      availableStatusGroups: columns.map(({ status }) => status),
      uniqueVisibleCount: 0,
    };
    return projectKanbanCells({
      model,
      settings: options.settings ?? settings(),
      fields,
      collapsedGroups: options.collapsedGroups ?? new Set(),
      effectiveField: options.effectiveField ?? asIs,
    });
  }

  function card(statusKey: string, groupKey: string, item: Project): string {
    return projectKanbanOccurrenceId(statusKey, groupKey, item.path);
  }

  it('lists each card top to bottom: Name, Description, card fields, then Progress', () => {
    const a = project('A');
    const cells = kanbanCells([column('id:active', [group('all', [a])])]);
    const occurrenceId = card('id:active', 'all', a);

    expect(order(cells)).toEqual([
      `${occurrenceId}|name`,
      `${occurrenceId}|description`,
      `${occurrenceId}|start`,
      `${occurrenceId}|end`,
      `${occurrenceId}|progress`,
    ]);
    expect(cells.cells[0]?.identity).toEqual({
      occurrenceId,
      projectPath: a.path,
      groupKey: 'all',
      columnId: 'name',
    });
  });

  it('lists Description only when its lines are not 0 and the project has one', () => {
    const described = project('A');
    const bare = project('B', { frontmatter: { start: '2026-09-01' } });
    const columns = [column('id:active', [group('all', [described, bare])])];
    const descriptions = (cells: ProjectOverviewCells) =>
      cells.cells.flatMap(({ identity, project: item }) =>
        identity.columnId === 'description' ? [item.path] : [],
      );

    expect(
      descriptions(kanbanCells(columns, { settings: settings({ descriptionLines: 2 }) })),
    ).toEqual([described.path]);
    expect(
      descriptions(kanbanCells(columns, { settings: settings({ descriptionLines: 0 }) })),
    ).toEqual([]);
  });

  it('leaves out empty card fields when empty fields are hidden', () => {
    const a = project('A', { frontmatter: { start: '2026-09-01' } });
    const columns = [column('id:active', [group('all', [a])])];

    expect(kanbanCells(columns).columnIds).toContain('end');
    expect(
      kanbanCells(columns, { settings: settings({ showEmptyFields: false }) }).columnIds,
    ).not.toContain('end');
  });

  it('lists Progress when it has a percent or empty progress shows, and never when hidden', () => {
    const started = project('A');
    const empty = project('B', {
      stats: {
        total: 0,
        done: 0,
        cancelled: 0,
        inProgress: 0,
        tracked: { closedMs: 0, openStartsMs: [] },
      },
    });
    const columns = [column('id:active', [group('all', [started, empty])])];
    const progress = (cells: ProjectOverviewCells) =>
      cells.cells.flatMap(({ identity, project: item }) =>
        identity.columnId === 'progress' ? [item.path] : [],
      );

    expect(progress(kanbanCells(columns))).toEqual([started.path]);
    expect(
      progress(kanbanCells(columns, { settings: settings({ showEmptyProgress: true }) })),
    ).toEqual([started.path, empty.path]);
    expect(
      progress(
        kanbanCells(columns, {
          settings: settings({ progress: 'hidden', showEmptyProgress: true }),
        }),
      ),
    ).toEqual([]);
  });

  it('leaves out collapsed columns and compact empty columns', () => {
    const a = project('A');
    const b = project('B');
    const c = project('C');
    const columns = [
      column('id:planned', [group('all', [a])]),
      column('id:active', [group('all', [b])]),
      column('id:done', [group('all', [c])], 0),
    ];
    const rows = (cells: ProjectOverviewCells) => cells.rowIds;

    expect(
      rows(kanbanCells(columns, { settings: settings({ collapsedColumns: ['id:planned'] }) })),
    ).toEqual([card('id:active', 'all', b)]);
    expect(
      rows(kanbanCells(columns, { settings: settings({ emptyColumns: 'expanded' }) })),
    ).toEqual([
      card('id:planned', 'all', a),
      card('id:active', 'all', b),
      card('id:done', 'all', c),
    ]);
  });

  it('leaves out a collapsed group by its status and group key, grouped or not', () => {
    const a = project('A');
    const b = project('B');
    const c = project('C');
    const columns = [
      column('id:planned', [group('all', [a])]),
      column('id:active', [group('value:x', [b]), group('value:y', [c])]),
    ];

    expect(
      kanbanCells(columns, { collapsedGroups: new Set(['id:planned\u0000all']) }).rowIds,
    ).toEqual([card('id:active', 'value:x', b), card('id:active', 'value:y', c)]);
    expect(
      kanbanCells(columns, {
        settings: settings({ groupBy: 'end' }),
        collapsedGroups: new Set(['id:active\u0000value:x', 'value:y']),
      }).rowIds,
    ).toEqual([card('id:planned', 'all', a), card('id:active', 'value:y', c)]);
  });

  it('orders rows and columns by first sight and finds each cell', () => {
    const a = project('A', { frontmatter: { end: '2026-09-30' } });
    const b = project('B');
    const cells = kanbanCells([column('id:active', [group('all', [a, b])])], {
      settings: settings({ showEmptyFields: false }),
    });
    const first = card('id:active', 'all', a);
    const second = card('id:active', 'all', b);

    expect(cells.rowIds).toEqual([first, second]);
    expect(cells.columnIds).toEqual(['name', 'end', 'progress', 'description', 'start']);
    expect(cells.cell(second, 'start')?.project).toBe(b);
    expect(cells.cell(first, 'start')).toBeUndefined();
  });

  it('takes the field and its owned clear from the resolver, keeping the field id', () => {
    const a = project('A', { frontmatter: {} });
    const ownedClear = createOwnedInferredPropertyClear({
      path: a.path,
      fieldId: 'end',
      sourceProperty: 'end',
      sourceKey: 'end',
      type: 'text',
    });
    const effectiveField: ProjectOverviewFieldResolver = (_project, field) =>
      field.id === 'end' ? { field: { ...field, type: 'text' }, ownedClear } : { field };
    const cells = kanbanCells([column('id:active', [group('all', [a])])], { effectiveField });
    const end = expectDefined(cells.cell(card('id:active', 'all', a), 'end'));

    expect(end.field).toEqual({ id: 'end', property: 'end', label: 'End', type: 'text' });
    expect(end.ownedClear).toBe(ownedClear);
    expect(cells.cell(card('id:active', 'all', a), 'name')?.ownedClear).toBeUndefined();
  });
});

describe('projectTimelineCells', () => {
  function settings(overrides: Partial<ProjectTimelineSettings> = {}): ProjectTimelineSettings {
    return {
      groupBy: 'none',
      sortBy: { field: 'start', dir: 'asc' },
      hiddenStatuses: [],
      scale: 'month',
      fields: [
        { id: 'status', visible: true },
        { id: 'start', visible: true },
        { id: 'end', visible: true },
      ],
      showEmptyFields: true,
      descriptionLines: 0,
      showMetadata: true,
      progress: 'full',
      showUnscheduled: true,
      ...overrides,
    };
  }

  function timelineCells(
    groups: ReadonlyArray<{ readonly key: string; readonly projects: readonly Project[] }>,
    overrides: Partial<ProjectTimelineSettings> = {},
    collapsedGroups: ReadonlySet<string> = new Set(),
  ): ProjectOverviewCells {
    const model: ProjectTimelineModel = {
      groups: groups.map(({ key, projects }) => ({
        key,
        label: key,
        value: key,
        rows: projects.map((item) => ({
          occurrenceId: `${key}|${item.path}`,
          project: item,
          range: { kind: 'unscheduled' },
        })),
      })),
      uniqueVisibleCount: 0,
      availableStatusGroups: [],
    };
    return projectTimelineCells({
      model,
      settings: settings(overrides),
      fields,
      collapsedGroups,
      effectiveField: asIs,
    });
  }

  it('lists each row left to right: Name, the metadata fields, then Progress', () => {
    const a = project('A');
    const cells = timelineCells([{ key: 'all', projects: [a] }]);

    expect(order(cells)).toEqual([
      `all|${a.path}|name`,
      `all|${a.path}|status`,
      `all|${a.path}|start`,
      `all|${a.path}|end`,
      `all|${a.path}|progress`,
    ]);
    expect(cells.cells[0]?.identity).toEqual({
      occurrenceId: `all|${a.path}`,
      projectPath: a.path,
      groupKey: 'all',
      columnId: 'name',
    });
  });

  it('lists metadata only when it shows, and Progress unless it is hidden', () => {
    const empty = project('A', {
      stats: {
        total: 0,
        done: 0,
        cancelled: 0,
        inProgress: 0,
        tracked: { closedMs: 0, openStartsMs: [] },
      },
    });
    const groups = [{ key: 'all', projects: [empty] }];

    expect(timelineCells(groups, { showMetadata: false }).columnIds).toEqual(['name', 'progress']);
    expect(timelineCells(groups, { progress: 'hidden' }).columnIds).toEqual([
      'name',
      'status',
      'start',
      'end',
    ]);
  });

  it('leaves out a collapsed group, grouped or not, and keeps a project in two groups apart', () => {
    const a = project('A');
    const b = project('B');
    const groups = [
      { key: 'g1', projects: [a] },
      { key: 'g2', projects: [a, b] },
    ];

    expect(timelineCells(groups).rowIds).toEqual([`g1|${a.path}`, `g2|${a.path}`, `g2|${b.path}`]);
    expect(timelineCells(groups, {}, new Set(['g1'])).rowIds).toEqual([
      `g2|${a.path}`,
      `g2|${b.path}`,
    ]);
    expect(
      timelineCells(groups, { groupBy: 'status' }, new Set(['g2'])).cell(`g1|${a.path}`, 'end')
        ?.identity.groupKey,
    ).toBe('g1');
  });
});

describe('NO_PROJECT_OVERVIEW_CELLS', () => {
  it('lists nothing and finds nothing', () => {
    expect(NO_PROJECT_OVERVIEW_CELLS.cells).toEqual([]);
    expect(NO_PROJECT_OVERVIEW_CELLS.identities).toEqual([]);
    expect(NO_PROJECT_OVERVIEW_CELLS.rowIds).toEqual([]);
    expect(NO_PROJECT_OVERVIEW_CELLS.columnIds).toEqual([]);
    expect(NO_PROJECT_OVERVIEW_CELLS.cell('any', 'name')).toBeUndefined();
  });
});
