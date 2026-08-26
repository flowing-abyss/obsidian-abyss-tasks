import { describe, expect, it } from 'vitest';
import {
  inferLifecycleBehavior,
  projectBoardMutationEnabled,
  resolveProjectLifecycle,
  validateLifecycleConfiguration,
} from '../src/projects/lifecycle';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import type { ProjectStatus } from '../src/settings/types';

const statuses: ProjectStatus[] = [
  {
    id: 'wip',
    label: 'WIP',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'property', property: 'status', value: 'wip' },
  },
  {
    id: 'dropped',
    label: 'Dropped',
    behavior: 'dropped',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/drop' },
  },
  {
    id: 'published',
    label: 'Published',
    behavior: 'published',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/published' },
  },
];

describe('project lifecycle semantics', () => {
  it('infers behavior after stripping leading emoji', () => {
    expect(inferLifecycleBehavior('✅ Done')).toBe('completed');
    expect(inferLifecycleBehavior('🗑 Drop')).toBe('dropped');
    expect(inferLifecycleBehavior('🚀 Published')).toBe('published');
  });

  it('does not infer terminal behavior from a label that merely contains a keyword', () => {
    expect(inferLifecycleBehavior('Ready to publish')).toBe('regular');
    expect(inferLifecycleBehavior('Done someday')).toBe('regular');
  });

  it('marks the default Done status as completed', () => {
    const done = buildDefaultProjectsSettings().statuses.find((status) => status.label === 'Done');

    expect(done?.behavior).toBe('completed');
  });

  it('prefers canonical frontmatter over a legacy body tag', () => {
    expect(resolveProjectLifecycle(statuses, ['#project/drop'], { status: 'wip' }).statusId).toBe(
      'wip',
    );
  });

  it('prefers canonical frontmatter tags over legacy body tags', () => {
    expect(
      resolveProjectLifecycle(statuses, ['#project/drop', '#project/published'], {
        tags: ['project/published'],
      }),
    ).toMatchObject({
      statusId: 'published',
      ownedField: {
        kind: 'frontmatter-tags',
        canonicalLifecycleTags: ['project/published'],
      },
    });
  });

  it('treats a hierarchical frontmatter status tag as canonical over a body tag', () => {
    expect(
      resolveProjectLifecycle(statuses, ['#project/drop'], {
        tags: ['project/published/release'],
      }),
    ).toMatchObject({
      statusId: 'published',
      ownedField: {
        kind: 'frontmatter-tags',
        canonicalLifecycleTags: ['project/published/release'],
      },
    });
  });

  it('rejects duplicate dropped or published behaviors and disables board mutation', () => {
    const duplicateTerminalStatuses: ProjectStatus[] = [
      ...statuses,
      {
        id: 'abandoned',
        label: 'Abandoned',
        behavior: 'dropped',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'abandoned' },
      },
    ];

    expect(validateLifecycleConfiguration(duplicateTerminalStatuses).valid).toBe(false);
    expect(projectBoardMutationEnabled(duplicateTerminalStatuses)).toBe(false);
  });
});
