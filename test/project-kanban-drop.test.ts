import { describe, expect, it } from 'vitest';
import type { ProjectKanbanDropInput } from '../src/panels/projects/projectKanbanDrop';
import {
  captureProjectKanbanDropSource,
  planProjectKanbanDrop,
} from '../src/panels/projects/projectKanbanDrop';
import type { ProjectFieldCatalogItem } from '../src/projects/projectFields';
import type { ProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import type { Project } from '../src/projects/types';

const statuses = [
  { id: 'planned', name: 'Planned', onLeftPanel: true },
  { id: 'active', name: 'Active', onLeftPanel: true },
];
const fields: ProjectFieldCatalogItem[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', property: 'status', label: 'Status', type: 'status' },
  { id: 'end', property: 'end', label: 'End', type: 'date' },
  { id: 'property:Owners', property: 'Owners', label: 'Owners', type: 'list' },
  { id: 'property:Priority', property: 'Priority', label: 'Priority', type: 'text' },
];

function project(path: string, status: string, end: string, owners: string[] = []): Project {
  return {
    path,
    name: path,
    frontmatter: { status, end, Owners: owners },
    tags: [],
    statusId: statuses.find(({ name }) => name === status)?.id ?? null,
    rawStatus: statuses.some(({ name }) => name === status) ? null : status,
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
  };
}

function settings(overrides: Partial<ProjectKanbanSettings> = {}): ProjectKanbanSettings {
  return {
    fields: [{ id: 'end', visible: true }],
    showEmptyFields: false,
    descriptionLines: 1,
    progress: 'full',
    showEmptyProgress: false,
    emptyColumns: 'compact',
    groupBy: 'status',
    sortBy: { field: 'none', dir: 'asc' },
    hiddenStatuses: [],
    collapsedColumns: [],
    manualOrder: {},
    ...overrides,
  };
}

function planInput(
  source: Project,
  all: readonly Project[],
  board = settings(),
): ProjectKanbanDropInput {
  return {
    project: source,
    projects: all,
    fields,
    statuses,
    settings: board,
    source: captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: source.statusId === null ? `raw:${source.rawStatus}` : `id:${source.statusId}`,
      group: { key: 'all', value: null, sourcePath: source.path },
    }),
    target: {
      status: { key: 'id:active', value: 'active' },
      group: { key: 'all', value: null },
    },
  };
}

describe('project Kanban drop planning', () => {
  it('combines guarded status and list-group changes and forecasts the sorted occurrence', () => {
    const a = project('Projects/A.md', 'Planned', '2026-09-30', ['A', 'C']);
    const b = project('Projects/B.md', 'Active', '2026-09-10', ['B']);
    const c = project('Projects/C.md', 'Active', '2026-09-20', ['B']);
    const board = settings({
      groupBy: 'property:Owners',
      sortBy: { field: 'end', dir: 'asc' },
    });
    const input = planInput(a, [a, b, c], board);
    input.source = captureProjectKanbanDropSource({
      project: a,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:a', value: 'A', sourcePath: a.path },
    });
    input.target.group = { key: 'value:b', value: 'B', sourcePath: b.path };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.changes.map(({ field, value }) => ({ id: field.id, value }))).toEqual([
      { id: 'status', value: 'Active' },
      { id: 'property:Owners', value: ['B', 'C'] },
    ]);
    expect(result.proposedProject.frontmatter).toEqual({
      status: 'Active',
      end: '2026-09-30',
      Owners: ['B', 'C'],
    });
    expect(result.insertion).toEqual({
      kind: 'after',
      groupKey: 'value:b',
      afterPath: 'Projects/C.md',
    });
  });

  it('allows a sorted list-group assignment within the same status column', () => {
    const moving = project('Projects/A.md', 'Planned', '2026-09-30', ['Anna', 'Maria']);
    const target = project('Projects/C.md', 'Planned', '2026-09-20', ['Boris']);
    const board = settings({
      groupBy: 'property:Owners',
      sortBy: { field: 'end', dir: 'asc' },
    });
    const input = planInput(moving, [moving, target], board);
    input.source = captureProjectKanbanDropSource({
      project: moving,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:anna', value: 'Anna', sourcePath: moving.path },
    });
    input.target.status = { key: 'id:planned', value: 'planned' };
    input.target.group = { key: 'value:boris', value: 'Boris', sourcePath: target.path };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.changes).toMatchObject([
      {
        field: { id: 'property:Owners' },
        expectedValue: ['Anna', 'Maria'],
        value: ['Boris', 'Maria'],
      },
    ]);
    expect(result.insertion).toEqual({
      kind: 'after',
      groupKey: 'value:boris',
      afterPath: 'Projects/C.md',
    });
  });

  it('seeds manual order with hidden and unranked destination paths before inserting', () => {
    const moving = project('Projects/A.md', 'Planned', '2026-09-30');
    const hidden = project('Projects/Hidden.md', 'Active', '2026-09-01');
    const before = project('Projects/B.md', 'Active', '2026-09-02');
    const board = settings({
      manualOrder: { 'id:active': ['Projects/SavedHidden.md'] },
    });
    const input = planInput(moving, [moving, hidden, before], board);
    input.target.beforePath = before.path;

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.manualOrder).toEqual({
      statusKey: 'id:active',
      paths: ['Projects/SavedHidden.md', 'Projects/Hidden.md', 'Projects/A.md', 'Projects/B.md'],
    });
  });

  it('rejects raw targets, read-only grouping, and sorted same-column no-ops', () => {
    const a = project('Projects/A.md', 'Planned', '2026-09-30');
    const raw = planInput(a, [a]);
    raw.target.status = { key: 'raw:Waiting', value: 'Waiting' };
    expect(planProjectKanbanDrop(raw)).toMatchObject({ allowed: false });

    const readonlyFields: ProjectFieldCatalogItem[] = fields.map((field) =>
      field.id === 'property:Owners'
        ? { id: field.id, property: 'Owners', label: field.label, type: null }
        : field,
    );
    const board = settings({ groupBy: 'property:Owners' });
    const readonly = planInput(a, [a], board);
    readonly.fields = readonlyFields;
    readonly.source = captureProjectKanbanDropSource({
      project: a,
      fields: readonlyFields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'empty', value: null, sourcePath: a.path },
    });
    readonly.target.status = { key: 'id:planned', value: 'planned' };
    readonly.target.group = { key: 'value:b', value: 'B' };
    const readonlyResult = planProjectKanbanDrop(readonly);
    expect(readonlyResult.allowed).toBe(false);
    expect(readonlyResult.message).toContain('read-only');

    delete readonly.target.group;
    const statusOnly = planProjectKanbanDrop(readonly);
    expect(statusOnly.allowed).toBe(true);

    const sorted = planInput(a, [a], settings({ sortBy: { field: 'end', dir: 'asc' } }));
    sorted.target.status = { key: 'id:planned', value: 'planned' };
    expect(planProjectKanbanDrop(sorted)).toMatchObject({ allowed: false });
  });

  it('rejects a stale captured source instead of recapturing expected guards', () => {
    const original = project('Projects/A.md', 'Planned', '2026-09-30', ['A']);
    const input = planInput(original, [original]);
    const changed = project('Projects/A.md', 'Active', '2026-09-30', ['A']);
    input.project = changed;
    input.projects = [changed];

    const result = planProjectKanbanDrop(input);
    expect(result.allowed).toBe(false);
    expect(result.message).toContain('changed');
  });

  it('snapshots captured list guards against in-place source mutation', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30', ['A']);
    const board = settings({ groupBy: 'property:Owners' });
    const input = planInput(source, [source], board);
    input.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:a', value: 'A', sourcePath: source.path },
    });
    const owners = source.frontmatter['Owners'] as string[];
    owners.push('External');
    input.target.group = { key: 'value:b', value: 'B' };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('changed');
  });

  it('rejects a grouping property rebind even when both source cells were absent', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30');
    const target = project('Projects/B.md', 'Active', '2026-09-20');
    target.frontmatter['Other'] = 'P2';
    const board = settings({ groupBy: 'property:Priority' });
    const input = planInput(source, [source, target], board);
    input.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'empty', value: undefined, sourcePath: source.path },
    });
    input.fields = fields.map((field) =>
      field.id === 'property:Priority'
        ? { id: field.id, property: 'Other', label: field.label, type: 'text' as const }
        : field,
    );
    input.target.group = { key: 'value:p2', value: 'P2', sourcePath: target.path };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('source changed');
  });

  it('rejects a grouping field type change after capturing its list capability', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30', ['A', 'B']);
    const target = project('Projects/B.md', 'Active', '2026-09-20', ['C']);
    const board = settings({ groupBy: 'property:Owners' });
    const input = planInput(source, [source, target], board);
    input.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:a', value: 'A', sourcePath: source.path },
    });
    input.fields = fields.map((field) =>
      field.id === 'property:Owners' ? { ...field, type: 'text' as const } : field,
    );
    input.target.group = { key: 'value:c', value: 'C', sourcePath: target.path };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(false);
    expect(result.message).toContain('capability changed');
  });

  it('supports manual same-column placement and clearing a grouped list value', () => {
    const a = project('Projects/A.md', 'Planned', '2026-09-30', ['A']);
    const b = project('Projects/B.md', 'Planned', '2026-09-20', ['B']);
    const manual = planInput(a, [a, b]);
    manual.target.status = { key: 'id:planned', value: 'planned' };
    manual.target.beforePath = b.path;
    const reordered = planProjectKanbanDrop(manual);
    expect(reordered.allowed).toBe(true);
    if (!reordered.allowed) return;
    expect(reordered.changes).toEqual([]);
    expect(reordered.manualOrder?.paths).toEqual(['Projects/A.md', 'Projects/B.md']);

    const groupedSettings = settings({ groupBy: 'property:Owners' });
    const empty = project('Projects/Empty.md', 'Planned', '2026-09-10');
    const grouped = planInput(a, [a, b, empty], groupedSettings);
    grouped.target.status = { key: 'id:planned', value: 'planned' };
    grouped.source = captureProjectKanbanDropSource({
      project: a,
      fields,
      settings: groupedSettings,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:a', value: 'A', sourcePath: a.path },
    });
    grouped.target.group = { key: 'empty', value: null, sourcePath: empty.path };
    const cleared = planProjectKanbanDrop(grouped);
    if (!cleared.allowed) throw new Error(cleared.message);
    expect(cleared.changes).toMatchObject([{ field: { id: 'property:Owners' }, value: [] }]);
    expect(cleared.proposedProject.frontmatter).not.toHaveProperty('Owners');
  });

  it('allows dragging out of an unknown status but never assigning one', () => {
    const raw = project('Projects/A.md', 'Waiting', '2026-09-30');
    const input = planInput(raw, [raw]);

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.changes).toMatchObject([{ field: { id: 'status' }, value: 'Active' }]);
  });

  it('replaces a scalar group assignment without changing status', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30');
    source.frontmatter['Priority'] = 'P1';
    const target = project('Projects/B.md', 'Planned', '2026-09-20');
    target.frontmatter['Priority'] = 'P2';
    const board = settings({ groupBy: 'property:Priority' });
    const input = planInput(source, [source, target], board);
    input.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:p1', value: 'P1', sourcePath: source.path },
    });
    input.target.status = { key: 'id:planned', value: 'planned' };
    input.target.group = { key: 'value:p2', value: 'P2', sourcePath: target.path };

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.changes).toMatchObject([
      { field: { id: 'property:Priority' }, value: 'P2', expectedValue: 'P1' },
    ]);
  });

  it('locates a newly created inner group for a whole-column status move', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30', ['P1']);
    const target = project('Projects/B.md', 'Active', '2026-09-20', ['P2']);
    const board = settings({ groupBy: 'property:Owners' });
    const input = planInput(source, [source, target], board);
    input.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:p1', value: 'P1', sourcePath: source.path },
    });
    delete input.target.group;

    const result = planProjectKanbanDrop(input);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.insertion).toEqual({
      kind: 'empty',
      groupKey: 'value:p1',
      beforeGroupKey: 'value:p2',
    });
    const active = result.model.columns.find(({ status }) => status.key === 'id:active');
    expect(active?.groups.map(({ key }) => key)).toEqual(['value:p1', 'value:p2']);
  });

  it('rejects stale targets and omits uncertain membership insertion', () => {
    const source = project('Projects/A.md', 'Planned', '2026-09-30', ['A']);
    const target = project('Projects/B.md', 'Active', '2026-09-20', ['B']);
    const hidden = planInput(source, [source, target], settings({ hiddenStatuses: ['id:active'] }));
    expect(planProjectKanbanDrop(hidden)).toMatchObject({ allowed: false });

    const board = settings({ groupBy: 'property:Owners' });
    const stale = planInput(source, [source, target], board);
    stale.source = captureProjectKanbanDropSource({
      project: source,
      fields,
      settings: board,
      statusProperty: 'status',
      statusKey: 'id:planned',
      group: { key: 'value:a', value: 'A', sourcePath: source.path },
    });
    stale.target.group = { key: 'value:b', value: 'B', sourcePath: target.path };
    target.frontmatter['Owners'] = ['C'];
    const staleResult = planProjectKanbanDrop(stale);
    expect(staleResult.allowed).toBe(false);
    expect(staleResult.message).toContain('target group');

    const uncertain = planInput(source, [source, target]);
    uncertain.membershipQuery = '#project';
    uncertain.tagsReliable = false;
    const uncertainResult = planProjectKanbanDrop(uncertain);
    expect(uncertainResult.allowed).toBe(true);
    if (!uncertainResult.allowed) return;
    expect(uncertainResult.insertion.kind).toBe('none');

    const filteredBoard = settings({ fields: [{ id: 'status', visible: true }] });
    const filtered = planInput(source, [source, target], filteredBoard);
    filtered.search = 'Planned';
    const filteredResult = planProjectKanbanDrop(filtered);
    expect(filteredResult.allowed).toBe(true);
    if (!filteredResult.allowed) return;
    expect(filteredResult.insertion.kind).toBe('none');
  });
});
