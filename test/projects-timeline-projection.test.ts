import { describe, expect, it } from 'vitest';
import {
  portfolioTimelineEntries,
  projectTimelineEntry,
  projectTimelineItem,
  projectTimelineItems,
  taskTimelineEntry,
  taskTimelineItem,
  workNoteTimelineEntry,
  workNoteTimelineItem,
} from '../src/panels/projects/timelineProjection';
import { parseProjectRange } from '../src/projects/projectDates';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { task } from './helpers';

function project(
  range: Project['range'],
  path = 'Projects/A.md',
): ProjectWorkspaceSnapshot['project'] {
  return {
    path,
    name: path.replace(/^.*\//u, '').replace(/\.md$/u, ''),
    frontmatter: {},
    tags: [],
    statusId: null,
    rawStatus: null,
    range,
    stats: {
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      open: 0,
      progress: null,
    },
  };
}

function workNote(over: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  return {
    path: 'Work Notes/A.md',
    presetRevision: 1,
    presetFingerprint: 'fingerprint',
    kind: 'ordinary',
    projectPath: 'Projects/A.md',
    statusId: null,
    rawStatus: null,
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...over,
  };
}

function workspaceSnapshot(
  projectValue: ProjectWorkspaceSnapshot['project'],
  input: {
    readonly workNotes?: readonly WorkNoteSnapshot[];
    readonly milestones?: readonly WorkNoteSnapshot[];
  } = {},
): ProjectWorkspaceSnapshot {
  return {
    project: projectValue,
    tasks: [],
    workNotes: input.workNotes ?? [],
    milestones: input.milestones ?? [],
    taskRollup: projectValue.stats,
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
  };
}

describe('Timeline projections', () => {
  it('projects Project and Task ranges without losing their stable keys', () => {
    expect(projectTimelineItem(project(parseProjectRange('2026-08-20', '2026-08-24')))).toEqual({
      kind: 'range',
      key: 'project:Projects/A.md',
      startMs: Date.UTC(2026, 7, 20),
      endMs: Date.UTC(2026, 7, 24),
    });
    expect(
      taskTimelineItem(
        task({
          planning: { start: '2026-08-21', due: '2026-08-25' },
          source: { filePath: 'Projects/A.md', line: 7 },
        }),
      ),
    ).toMatchObject({ kind: 'range', key: 'task:Projects/A.md:7' });
  });

  it.each([
    [
      'project-start',
      projectTimelineItem(project(parseProjectRange('2026-08-20', undefined))),
      'start',
    ],
    [
      'project-end',
      projectTimelineItem(project(parseProjectRange(undefined, '2026-08-24'))),
      'end',
    ],
    [
      'work-note-milestone-fallback',
      workNoteTimelineItem(workNote({ kind: 'milestone', updated: '2026-08-26' })),
      'milestone',
    ],
    [
      'task-scheduled-and-due',
      taskTimelineItem(task({ planning: { scheduled: '2026-08-22', due: '2026-08-24' } })),
      'scheduled',
    ],
    ['task-due', taskTimelineItem(task({ planning: { due: '2026-08-24' } })), 'due'],
  ] as const)('retains point source role for %s', (_fixture, item, role) => {
    expect(item).toMatchObject({ kind: 'point', role });
  });

  it('keeps undated and invalid Projects outside the dated projection', () => {
    const items = projectTimelineItems([
      project(parseProjectRange('2026-08-20', '2026-08-24'), 'Projects/Range.md'),
      project({}, 'Projects/Undated.md'),
      project(parseProjectRange('2026-08-30', '2026-08-20'), 'Projects/Reversed.md'),
    ]);

    expect(items.map(({ kind }) => kind)).toEqual(['range', 'undated', 'invalid']);
    expect(items[2]).toMatchObject({ kind: 'invalid', reason: 'reversed' });
  });

  it('does not turn a start-only Task or malformed milestone fallback into a dated point', () => {
    expect(taskTimelineItem(task({ planning: { start: '2026-08-24' } }))).toMatchObject({
      kind: 'undated',
    });
    expect(
      workNoteTimelineItem(workNote({ kind: 'milestone', updated: 'August 26' })),
    ).toMatchObject({ kind: 'invalid', reason: 'invalid-milestone' });
  });

  it('keeps exact raw endpoint values in separate Project, Work Note, and Task adapters', () => {
    const projectValue = project(parseProjectRange('2026-08-26T14:30:00+07:00', '2026-08-30'));
    const note = workNote({ range: parseProjectRange(undefined, '2026-09-01T09:00:00-04:00') });
    const taskValue = task({ planning: { scheduled: '2026-09-02', due: '2026-09-03' } });

    expect(projectTimelineEntry(projectValue).dateByRole).toEqual({
      start: '2026-08-26T14:30:00+07:00',
      end: '2026-08-30',
    });
    expect(workNoteTimelineEntry(note).dateByRole).toEqual({
      end: '2026-09-01T09:00:00-04:00',
    });
    expect(taskTimelineEntry(taskValue).dateByRole).toEqual({
      scheduled: '2026-09-02',
      due: '2026-09-03',
    });
  });

  it('projects only Projects and their typed milestones from joined portfolio snapshots', () => {
    const projectValue = project(parseProjectRange('2026-08-20', '2026-08-24'));
    const ordinary = workNote({
      path: 'Work Notes/Ordinary.md',
      range: parseProjectRange('2026-08-21', undefined),
    });
    const milestone = workNote({
      path: 'Work Notes/Launch milestone.md',
      kind: 'milestone',
      updated: '2026-08-23',
    });
    const entries = portfolioTimelineEntries([
      workspaceSnapshot(projectValue, { workNotes: [ordinary], milestones: [milestone] }),
    ]);

    expect(entries.map(({ item }) => item.key)).toEqual([
      'project:Projects/A.md',
      'work-note:Work Notes/Launch milestone.md',
    ]);
    expect(entries.map(({ value }) => value.kind)).toEqual(['project', 'milestone']);
    expect(entries[0]).not.toHaveProperty('detail');
    expect(entries[1]).toMatchObject({
      label: 'Launch milestone',
      detail: 'Milestone · A',
      value: { kind: 'milestone', projectPath: 'Projects/A.md', note: milestone },
    });
    expect(entries.some(({ item }) => item.key.startsWith('task:'))).toBe(false);
    expect(entries.some(({ item }) => item.key.includes('Ordinary'))).toBe(false);
  });
});
