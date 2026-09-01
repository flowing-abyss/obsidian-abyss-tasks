import { describe, expect, it } from 'vitest';
import {
  buildMilestoneProjection,
  selectMilestoneProjections,
} from '../src/projects/work-notes/MilestoneProjection';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';

function milestone(path: string, over: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'preset',
    kind: 'milestone',
    projectPath: 'Projects/P.md',
    statusId: 'active',
    rawStatus: 'Active',
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...over,
  };
}

describe('MilestoneProjection', () => {
  it('keeps point dates and ranges distinct and renders plain undated/invalid states', () => {
    const point = buildMilestoneProjection(
      milestone('Work/Point.md', {
        range: {
          start: { raw: '2026-09-10', precision: 'date', instantMs: 0 },
        },
      }),
      { active: 1, completed: 1, dropped: 0, progress: 0.5 },
    );
    const range = buildMilestoneProjection(
      milestone('Work/Range.md', {
        range: {
          start: { raw: '2026-09-10', precision: 'date', instantMs: 0 },
          end: { raw: '2026-09-12', precision: 'date', instantMs: 0 },
        },
      }),
      { active: 0, completed: 0, dropped: 0, progress: null },
    );
    const undated = buildMilestoneProjection(milestone('Work/Undated.md'));
    const invalid = buildMilestoneProjection(
      milestone('Work/Invalid.md', { range: { issue: 'invalid-start' } }),
    );

    expect(point.date).toEqual({ type: 'point', value: point.note.range.start });
    expect(range.date).toEqual({
      type: 'range',
      start: range.note.range.start,
      end: range.note.range.end,
    });
    expect(undated.state).toEqual({ type: 'undated', label: 'No date set' });
    expect(invalid.state).toEqual({ type: 'invalid', label: 'Date needs attention' });
  });

  it('filters, groups, and stably sorts first-class Milestone projections', () => {
    const projections = [
      buildMilestoneProjection(
        milestone('Work/Later.md', {
          statusId: 'planned',
          range: { start: { raw: '2026-10-01', precision: 'date', instantMs: 2 } },
        }),
      ),
      buildMilestoneProjection(
        milestone('Work/Earlier B.md', {
          range: { start: { raw: '2026-09-01', precision: 'date', instantMs: 1 } },
        }),
      ),
      buildMilestoneProjection(
        milestone('Work/Earlier A.md', {
          range: { start: { raw: '2026-09-01', precision: 'date', instantMs: 1 } },
        }),
      ),
    ];

    const selected = selectMilestoneProjections(projections, {
      query: 'earlier',
      statusIds: ['active'],
      groupBy: 'status',
      sortBy: 'date',
      direction: 'asc',
    });
    expect(selected.map(({ title, group }) => ({ title, group }))).toEqual([
      { title: 'Earlier A', group: 'active' },
      { title: 'Earlier B', group: 'active' },
    ]);
  });
});
