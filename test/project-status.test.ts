import { describe, expect, it } from 'vitest';
import { orderedGroups, resolveStatus } from '../src/projects/status';
import type { Project } from '../src/projects/types';
import type { ProjectStatus } from '../src/settings/types';

const S: ProjectStatus[] = [
  {
    id: 'a',
    label: 'Active',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'property', property: 'status', value: 'active' },
  },
  {
    id: 'w',
    label: 'WIP',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'tag', tag: 'wip' },
  },
  {
    id: 'd',
    label: 'Done',
    behavior: 'completed',
    onLeftPanel: false,
    match: { kind: 'property', property: 'status', value: 'done' },
  },
];

function proj(over: Partial<Project>): Project {
  return {
    path: 'P.md',
    name: 'P',
    frontmatter: {},
    tags: [],
    statusId: null,
    rawStatus: null,
    range: {},
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    ...over,
  };
}

describe('resolveStatus', () => {
  it('resolves a property status', () => {
    expect(resolveStatus(S, [], { status: 'active' })).toEqual({ statusId: 'a', rawStatus: null });
  });
  it('resolves a tag status (case-insensitive)', () => {
    expect(resolveStatus(S, ['#WIP'], {})).toEqual({ statusId: 'w', rawStatus: null });
  });
  it('first-in-order wins on ambiguity', () => {
    // both active (property) and wip (tag) present → property 'a' is earlier
    expect(resolveStatus(S, ['#wip'], { status: 'active' })).toEqual({
      statusId: 'a',
      rawStatus: null,
    });
  });
  it('surfaces a discovered status under a known status property', () => {
    expect(resolveStatus(S, [], { status: 'archive' })).toEqual({
      statusId: null,
      rawStatus: 'archive',
    });
  });
  it('returns null/null when nothing matches', () => {
    expect(resolveStatus(S, [], {})).toEqual({ statusId: null, rawStatus: null });
  });
});

describe('orderedGroups', () => {
  it('defined order, then discovered, then No status', () => {
    const projects = [
      proj({ statusId: 'a' }),
      proj({ statusId: 'd' }),
      proj({ rawStatus: 'archive' }),
      proj({ statusId: null, rawStatus: null }),
    ];
    const keys = orderedGroups(S, projects).map((g) => g.label);
    expect(keys).toEqual(['Active', 'WIP', 'Done', 'archive', 'No status']);
  });
  it('omits empty defined groups? no — keeps all defined, drops empty discovered/none', () => {
    const groups = orderedGroups(S, [proj({ statusId: 'a' })]);
    expect(groups.map((g) => g.label)).toEqual(['Active', 'WIP', 'Done']);
  });
});
