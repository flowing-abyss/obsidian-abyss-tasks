import { describe, expect, it } from 'vitest';
import { computeMilestoneRollups, computeWorkNoteRollup } from '../src/projects/work-notes/rollups';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import type { ProjectStatus } from '../src/settings/types';

const statuses: readonly ProjectStatus[] = [
  {
    id: 'active',
    label: 'Active',
    onLeftPanel: true,
    behavior: 'regular',
    match: { kind: 'property', property: 'Status', value: 'Active' },
  },
  {
    id: 'done',
    label: 'Done',
    onLeftPanel: false,
    behavior: 'completed',
    match: { kind: 'property', property: 'Status', value: 'Done' },
  },
  {
    id: 'published',
    label: 'Published',
    onLeftPanel: false,
    behavior: 'published',
    match: { kind: 'property', property: 'Status', value: 'Published' },
  },
  {
    id: 'dropped',
    label: 'Dropped',
    onLeftPanel: false,
    behavior: 'dropped',
    match: { kind: 'property', property: 'Status', value: 'Dropped' },
  },
];

function note(
  path: string,
  statusId: string | null,
  overrides: Partial<WorkNoteSnapshot> = {},
): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'fixture-fingerprint',
    kind: 'ordinary',
    projectPath: 'Projects/A.md',
    statusId,
    rawStatus: null,
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('Work Note rollups', () => {
  it('keeps ordinary lifecycle counts separate and excludes milestone containers', () => {
    const result = computeWorkNoteRollup(
      [
        note('Work/A.md', 'active'),
        note('Work/B.md', 'done'),
        note('Work/C.md', 'dropped'),
        note('Work/M.md', 'active', { kind: 'milestone' }),
      ],
      statuses,
    );

    expect(result).toEqual({ active: 1, completed: 1, dropped: 1 });
  });

  it('counts completed and published milestone members as done and excludes dropped', () => {
    const milestone = note('Work/M.md', 'active', { kind: 'milestone' });
    const result = computeMilestoneRollups(
      [
        milestone,
        note('Work/A.md', 'active', { milestonePath: milestone.path }),
        note('Work/B.md', 'done', { milestonePath: milestone.path }),
        note('Work/C.md', 'published', { milestonePath: milestone.path }),
        note('Work/D.md', 'dropped', { milestonePath: milestone.path }),
      ],
      statuses,
    );

    expect(result.get(milestone.path)).toEqual({
      active: 1,
      completed: 2,
      dropped: 1,
      progress: 2 / 3,
    });
  });

  it('reports null progress for a milestone with zero members', () => {
    const milestone = note('Work/M.md', 'active', { kind: 'milestone' });
    expect(computeMilestoneRollups([milestone], statuses).get(milestone.path)).toEqual({
      active: 0,
      completed: 0,
      dropped: 0,
      progress: null,
    });
  });
});
