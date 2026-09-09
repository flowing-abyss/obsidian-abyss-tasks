import { describe, expect, it } from 'vitest';
import { orderedGroups, resolveStatus } from '../src/projects/status';
import type { Project } from '../src/projects/types';
import type { ProjectStatus, ProjectsSettings } from '../src/settings/types';

const S: ProjectStatus[] = [
  { id: 'a', name: 'active', onLeftPanel: true },
  { id: 'w', name: 'working', onLeftPanel: true },
  { id: 'd', name: 'done', onLeftPanel: false },
];

const projectSettings = (
  statuses: ProjectStatus[] = S,
  statusProperty = 'status',
): Pick<ProjectsSettings, 'statusProperty' | 'statuses'> => ({ statusProperty, statuses });

function proj(over: Partial<Project>): Project {
  return {
    path: 'Projects/P.md',
    name: 'P',
    frontmatter: {},
    tags: [],
    statusId: null,
    rawStatus: null,
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
    ...over,
  };
}

describe('resolveStatus', () => {
  it('resolves one literal value through the configured global property', () => {
    expect(resolveStatus(projectSettings(), { status: 'active' })).toEqual({
      statusId: 'a',
      rawStatus: null,
    });
  });

  it('preserves a custom Cyrillic source key and value', () => {
    expect(
      resolveStatus(
        projectSettings([{ id: 'doing', name: 'в работе', onLeftPanel: true }], 'Статус'),
        { СТАТУС: 'в работе' },
      ),
    ).toEqual({ statusId: 'doing', rawStatus: null });
  });

  it('surfaces an unknown status even when the catalog is empty', () => {
    expect(resolveStatus(projectSettings([]), { status: 'archive' })).toEqual({
      statusId: null,
      rawStatus: 'archive',
    });
  });

  it('returns null/null for no configured property value', () => {
    expect(resolveStatus(projectSettings(), {})).toEqual({ statusId: null, rawStatus: null });
  });
});

describe('orderedGroups', () => {
  it('uses literal names in defined order, then discovered values, then No status', () => {
    const projects = [
      proj({ statusId: 'a' }),
      proj({ statusId: 'd' }),
      proj({ rawStatus: 'archive' }),
      proj({ statusId: null, rawStatus: null }),
    ];
    expect(orderedGroups(S, projects).map((group) => group.label)).toEqual([
      'active',
      'working',
      'done',
      'archive',
      'No status',
    ]);
  });

  it('keeps every configured definition when discovered and empty groups are absent', () => {
    expect(orderedGroups(S, [proj({ statusId: 'a' })]).map((group) => group.label)).toEqual([
      'active',
      'working',
      'done',
    ]);
  });
});
