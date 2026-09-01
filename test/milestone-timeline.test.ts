import { describe, expect, it, vi } from 'vitest';
import {
  renderProjectsTimeline,
  renderWorkNotesTimeline,
} from '../src/panels/projects/ProjectsTimelineView';
import { workNoteTimelineEntry } from '../src/panels/projects/timelineProjection';
import { parseProjectRange } from '../src/projects/projectDates';
import type { Project } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { freshContainer } from './helpers';

function milestone(path: string, start?: string, end?: string): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 3,
    presetFingerprint: 'preset-3',
    kind: 'milestone',
    projectPath: 'Projects/P.md',
    statusId: 'active',
    rawStatus: 'Active',
    writableStatusShape: true,
    range: parseProjectRange(start, end),
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
  };
}

const project: Project = {
  path: 'Projects/P.md',
  name: 'P',
  frontmatter: {},
  tags: [],
  statusId: 'active',
  rawStatus: 'Active',
  range: {},
  stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
};

describe('Milestone Timeline', () => {
  it('projects one date as a diamond point and two dates as a true range carrier', () => {
    const point = workNoteTimelineEntry(milestone('Work/Point.md', '2026-09-10'));
    const range = workNoteTimelineEntry(milestone('Work/Range.md', '2026-09-10', '2026-09-12'));

    expect(point.item).toMatchObject({ kind: 'point', role: 'milestone' });
    expect(point.dateByRole).toEqual({ milestone: '2026-09-10' });
    expect(range.item).toMatchObject({ kind: 'range' });
    expect(range.dateByRole).toEqual({ start: '2026-09-10', end: '2026-09-12' });
  });

  it('uses the shared scale, Today, today-line, and range renderer for Milestones', () => {
    const root = freshContainer();
    renderWorkNotesTimeline(root, {
      notes: [
        milestone('Work/Point.md', '2026-09-10'),
        milestone('Work/Range.md', '2026-09-10', '2026-09-12'),
      ],
      commands: {
        observeRange: vi.fn().mockReturnValue(null),
      } as never,
      commandsEnabled: false,
      today: '2026-09-11',
      scale: 'month',
    });

    expect(
      [...root.querySelectorAll<HTMLElement>('[data-timeline-scale]')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['Day', 'Week', 'Month', 'Quarter', 'Year']);
    expect(root.querySelector('[data-timeline-today]')?.textContent).toBe('Today');
    expect(root.querySelector('[data-timeline-milestone="diamond"]')).not.toBeNull();
    expect(root.querySelector('[data-timeline-range]')).not.toBeNull();
    expect(root.querySelector('.abyss-timeline-today-line')).not.toBeNull();
  });

  it('routes point and range direct manipulation through the first-class Milestone adapter', async () => {
    const root = freshContainer();
    const point = milestone('Work/Point.md', '2026-09-10');
    const range = milestone('Work/Range.md', '2026-09-10', '2026-09-12');
    const setDates = vi.fn().mockResolvedValue({ type: 'ok', path: point.path });
    const observeDates = vi.fn((note: WorkNoteSnapshot) => ({
      observed: {
        path: note.path,
        presetRevision: note.presetRevision,
        presetFingerprint: note.presetFingerprint,
        projectPath: note.projectPath,
        kind: note.kind,
        fields: {},
      },
      start: note.range.start,
      end: note.range.end,
    }));
    renderProjectsTimeline(root, {
      projects: [project],
      snapshots: [
        {
          project,
          tasks: [],
          workNotes: [],
          milestones: [point, range],
          taskRollup: project.stats,
          workNoteRollup: { active: 0, completed: 0, dropped: 0 },
          milestoneRollups: new Map(),
          workNoteRelations: [],
          overdue: { tasks: 0, workNotes: 0 },
          dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
          diagnostics: [],
        },
      ],
      commands: { observeRange: vi.fn().mockReturnValue(null) } as never,
      milestoneAdapter: { observeDates, setDates } as never,
    });

    const pointEntry = workNoteTimelineEntry(point);
    const rangeEntry = workNoteTimelineEntry(range);
    const options = (root as HTMLElement & { __timelineOptions?: unknown }).__timelineOptions;
    // The renderer exposes no test-only mutation API; keyboard direct manipulation is the
    // consumer-visible path and the shared controller owns its event grammar.
    const pointHandle = root.querySelector<HTMLElement>(
      `[data-timeline-key="${pointEntry.item.key}"] [data-timeline-role="milestone"]`,
    )!;
    pointHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    pointHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const rangeHandle = root.querySelector<HTMLElement>(
      `[data-timeline-key="${rangeEntry.item.key}"] [data-timeline-range]`,
    )!;
    rangeHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    rangeHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(options).toBeUndefined();
    expect(observeDates).toHaveBeenCalledWith(point);
    expect(observeDates).toHaveBeenCalledWith(range);
    expect(setDates).toHaveBeenCalled();
  });

  it('preserves an end-only Milestone point carrier during direct manipulation', async () => {
    const root = freshContainer();
    const point = milestone('Work/End point.md', undefined, '2026-09-10');
    const setDates = vi.fn().mockResolvedValue({ type: 'ok', path: point.path });
    renderWorkNotesTimeline(root, {
      notes: [point],
      commands: { observeRange: vi.fn() } as never,
      milestoneAdapter: {
        observeDates: () => ({
          observed: {
            path: point.path,
            presetRevision: point.presetRevision,
            presetFingerprint: point.presetFingerprint,
            projectPath: point.projectPath,
            kind: point.kind,
            fields: {},
          },
          end: point.range.end,
        }),
        setDates,
      },
    });

    const handle = root.querySelector<HTMLElement>('[data-timeline-role="milestone"]')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(setDates).toHaveBeenCalledWith(
      point,
      expect.objectContaining({ end: expect.objectContaining({ raw: '2026-09-11' }) }),
    );
    expect(setDates.mock.calls[0]?.[1]).not.toHaveProperty('start');
  });
});
