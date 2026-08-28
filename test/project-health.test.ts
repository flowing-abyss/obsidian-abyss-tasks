import { describe, expect, it } from 'vitest';
import { NEXT_ACTION_TAG } from '../src/projects/NextActionService';
import {
  projectHealthProjection,
  type ProjectHealthProjection,
} from '../src/projects/ProjectHealthProjection';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../src/projects/types';
import { localDate } from '../src/tasks/domain/validation';
import { task } from './helpers';

const projectPath = 'Projects/Launch.md';
const today = '2026-08-26';

function action(
  line: number,
  overrides: Partial<ProjectAction['task']> = {},
  dependency: ProjectAction['dependency'] = { type: 'allowed' },
  owner: ProjectAction['owner'] = { type: 'project', path: projectPath },
): ProjectAction {
  const snapshot = task({
    ref: { filePath: owner.path, line, revision: `${owner.path}:${String(line)}` },
    source: { filePath: owner.path, line },
    status: 'open',
    planning: {},
    ...overrides,
  });
  return { task: snapshot, projectPath, dependency, owner };
}

function workspace(
  tasks: readonly ProjectAction[] = [],
  overrides: Partial<ProjectWorkspaceSnapshot> = {},
): ProjectWorkspaceSnapshot {
  return {
    project: {
      path: projectPath,
      name: 'Launch',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: 'Active',
      range: {},
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    },
    tasks,
    workNotes: [],
    milestones: [],
    taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
    ...overrides,
  };
}

function health(snapshot: ProjectWorkspaceSnapshot, day = today): ProjectHealthProjection {
  return projectHealthProjection(snapshot, { today: day });
}

describe('projectHealthProjection', () => {
  it('applies off-track, at-risk, on-track, then unknown precedence', () => {
    const next = action(1, { tags: [NEXT_ACTION_TAG], planning: { due: localDate('2026-08-25') } });
    const blocked = action(2, {}, { type: 'blocked', prerequisites: [] });
    const result = health(workspace([next, blocked]));

    expect(result.severity).toBe('off-track');
    expect(result.reason.type).toBe('overdue-next-action');

    expect(health(workspace([blocked])).severity).toBe('off-track');
    expect(
      health(workspace([action(3, { planning: { due: localDate('2026-08-25') } })])).severity,
    ).toBe('at-risk');
    expect(health(workspace([action(4, { tags: [NEXT_ACTION_TAG] })])).severity).toBe('on-track');
    expect(health(workspace()).severity).toBe('unknown');
  });

  it('marks an overdue actionable Next Action off-track with its task date', () => {
    const next = action(4, { tags: [NEXT_ACTION_TAG], planning: { due: localDate('2026-08-25') } });

    expect(health(workspace([next]))).toMatchObject({
      severity: 'off-track',
      reason: { type: 'overdue-next-action', task: next.task.ref },
      date: { type: 'overdue-actionable-task', value: '2026-08-25', task: next.task.ref },
    });
  });

  it('marks a blocked critical path off-track and a blocked selected Next Action at-risk', () => {
    const blocked = action(1, {}, { type: 'blocked', prerequisites: [] });
    const selectedBlocked = action(
      2,
      { tags: [NEXT_ACTION_TAG] },
      { type: 'blocked', prerequisites: [] },
    );

    expect(health(workspace([blocked]))).toMatchObject({
      severity: 'off-track',
      reason: { type: 'blocked-critical-path', task: blocked.task.ref },
    });
    expect(health(workspace([selectedBlocked]))).toMatchObject({
      severity: 'at-risk',
      reason: { type: 'blocked-next-action', task: selectedBlocked.task.ref },
    });
  });

  it('marks other overdue actionable work at-risk while retaining an unblocked Next Action', () => {
    const next = action(1, { tags: [NEXT_ACTION_TAG], planning: { due: localDate('2026-09-01') } });
    const overdue = action(2, { planning: { scheduled: localDate('2026-08-25') } });

    expect(health(workspace([next, overdue]))).toMatchObject({
      severity: 'at-risk',
      reason: { type: 'overdue-actionable-work', task: overdue.task.ref },
      selectedNextAction: next,
    });
  });

  it('is on-track only for an actionable unblocked Next Action and unknown without actionable work', () => {
    const selected = action(1, { tags: [NEXT_ACTION_TAG] });
    const completed = action(2, { status: 'done', tags: [NEXT_ACTION_TAG] });

    expect(health(workspace([selected]))).toMatchObject({
      severity: 'on-track',
      reason: { type: 'unblocked-next-action', task: selected.task.ref },
    });
    expect(health(workspace([completed]))).toMatchObject({
      severity: 'unknown',
      reason: { type: 'insufficient-actionable-evidence' },
      flags: expect.objectContaining({ noNextAction: true, malformedNextAction: true }),
    });
  });

  it('keeps Next Action, dependency, and range diagnostics as independent flags', () => {
    const first = action(2, { tags: [NEXT_ACTION_TAG] });
    const second = action(1, { tags: [NEXT_ACTION_TAG] });
    const snapshot = workspace([first, second], {
      project: {
        ...workspace().project,
        range: { issue: 'reversed' },
      },
      dependencies: {
        blocked: 0,
        invalid: 1,
        diagnostics: [
          { ref: first.task.ref, diagnostics: [{ type: 'missing-prerequisite', id: 'x' }] },
        ],
      },
    });

    expect(health(snapshot)).toMatchObject({
      severity: 'on-track',
      selectedNextAction: second,
      flags: {
        noNextAction: false,
        duplicateNextAction: true,
        malformedNextAction: false,
        dependencyDiagnostics: true,
        rangeIssue: 'reversed',
      },
    });
  });

  it('uses canonical actionable dates and deterministic tie-breaking for the one date signal', () => {
    const later = action(5, { planning: { due: localDate('2026-08-24') } });
    const earlier = action(4, { planning: { scheduled: localDate('2026-08-23') } });
    const futureDue = action(3, { planning: { due: localDate('2026-09-02') } });
    const futureScheduled = action(2, { planning: { scheduled: localDate('2026-09-01') } });

    expect(health(workspace([later, earlier])).date).toMatchObject({
      type: 'overdue-actionable-task',
      value: '2026-08-23',
      task: earlier.task.ref,
    });
    expect(health(workspace([futureDue, futureScheduled])).date).toMatchObject({
      type: 'future-actionable-task',
      value: '2026-09-01',
      task: futureScheduled.task.ref,
    });
    expect(
      health(
        workspace([], {
          project: {
            ...workspace().project,
            range: {
              start: { raw: '2026-09-04', precision: 'date', instantMs: 0 },
              end: { raw: '2026-09-05', precision: 'date', instantMs: 0 },
            },
          },
        }),
      ).date,
    ).toEqual({ type: 'project-range-end', value: '2026-09-05' });
  });

  it('does not manufacture a date from missing or reversed Project ranges', () => {
    expect(health(workspace()).date).toBeUndefined();
    expect(
      health(
        workspace([], {
          project: { ...workspace().project, range: { issue: 'reversed' } },
        }),
      ).date,
    ).toBeUndefined();
  });

  it('uses the injected today boundary without mutating the joined snapshot', () => {
    const selected = action(1, {
      tags: [NEXT_ACTION_TAG],
      planning: { due: localDate('2026-08-26') },
    });
    const snapshot = workspace([selected]);
    const before = structuredClone(snapshot);

    expect(health(snapshot, '2026-08-26').severity).toBe('on-track');
    expect(health(snapshot, '2026-08-27').severity).toBe('off-track');
    expect(snapshot).toEqual(before);
  });
});
