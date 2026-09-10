import { describe, expect, it } from 'vitest';
import { forecastProjectGroupDrop } from '../src/panels/projects/projectGroupDropPreview';
import {
  normalizeProjectCellAssignment,
  type ProjectCellChange,
} from '../src/projects/projectEdits';
import type { ProjectField, ProjectTableSettings } from '../src/projects/projectFields';
import type { ProjectTableModelInput } from '../src/projects/projectTableModel';
import type { Project } from '../src/projects/types';
import type { ProjectsSettings } from '../src/settings/types';

const owners: ProjectField = {
  id: 'property:owners',
  property: 'Owners',
  label: 'Owners',
  type: 'list',
};
const start: ProjectField = { id: 'start', property: 'start', label: 'Start', type: 'date' };
const table: ProjectTableSettings = {
  columns: [owners, start].map(({ id }) => ({ id, visible: true })),
  showDescription: true,
  groupBy: owners.id,
  sortBy: { field: start.id, dir: 'asc' },
  hiddenStatuses: [],
};
const projectsSettings: Pick<ProjectsSettings, 'statusProperty' | 'statuses' | 'membershipQuery'> =
  {
    statusProperty: 'status',
    statuses: [],
    membershipQuery: 'Projects/',
  };

function project(name: string, startValue: string, owner: string): Project {
  return {
    path: `Projects/${name}.md`,
    name,
    frontmatter: { Owners: [owner], start: startValue },
    tags: [],
    statusId: null,
    rawStatus: null,
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
  };
}

function input(dir: 'asc' | 'desc' = 'asc'): ProjectTableModelInput {
  return {
    projects: [
      project('A', '2026-09-25', 'A'),
      project('B', '2026-09-20', 'B'),
      project('C', '2026-09-30', 'B'),
    ],
    fields: [owners, start],
    statuses: [],
    settings: { ...table, sortBy: { ...table.sortBy, dir } },
  };
}

function change(): ProjectCellChange & { sourceProperty: string } {
  return {
    path: 'Projects/A.md',
    field: owners,
    value: ['B'],
    expectedValue: ['A'],
    expectedExists: true,
    sourceProperty: 'Owners',
    sourceKey: 'Owners',
  };
}

describe('project group drop forecast', () => {
  it('uses the shared table model for ascending and descending insertion without mutation', () => {
    const ascending = input();
    const source = ascending.projects[0];
    const before = structuredClone(source);
    expect(
      forecastProjectGroupDrop({
        model: ascending,
        change: change(),
        targetGroupKey: 'value:b',
        currentTargetPaths: ['Projects/B.md', 'Projects/C.md'],
        projectsSettings,
        tagsReliable: true,
      }),
    ).toEqual({ kind: 'before', projectPath: 'Projects/C.md' });
    expect(source).toEqual(before);

    const descending = input('desc');
    expect(
      forecastProjectGroupDrop({
        model: descending,
        change: change(),
        targetGroupKey: 'value:b',
        currentTargetPaths: ['Projects/C.md', 'Projects/B.md'],
        projectsSettings,
        tagsReliable: true,
      }),
    ).toEqual({ kind: 'before', projectPath: 'Projects/B.md' });
  });

  it('suppresses uncertain membership and already-present occurrences', () => {
    const model = input();
    expect(
      forecastProjectGroupDrop({
        model,
        change: change(),
        targetGroupKey: 'value:b',
        currentTargetPaths: ['Projects/A.md', 'Projects/B.md'],
        projectsSettings,
        tagsReliable: true,
      }),
    ).toEqual({ kind: 'none' });
    expect(
      forecastProjectGroupDrop({
        model,
        change: change(),
        targetGroupKey: 'value:b',
        currentTargetPaths: ['Projects/B.md'],
        projectsSettings: { ...projectsSettings, membershipQuery: '#project' },
        tagsReliable: false,
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('normalizeProjectCellAssignment', () => {
  it('keeps ordinary zero values and clears empty lists without treating missing provenance as clear', () => {
    expect(
      normalizeProjectCellAssignment({ field: { ...start, type: 'number' }, value: 0 }),
    ).toEqual({
      value: 0,
      exists: true,
    });
    expect(normalizeProjectCellAssignment({ field: owners, value: [] })).toEqual({
      value: undefined,
      exists: false,
    });
  });
});
