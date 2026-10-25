import { describe, expect, it } from 'vitest';
import { taskCollectionListState } from '../src/task-lists/taskCollectionSettings';
import { planTaskTimelineEdit, taskTimelineDates } from '../src/task-lists/taskTimelineModel';
import {
  defaultTaskTimelineSettings,
  normalizeTaskTimelineSettings,
} from '../src/task-lists/taskTimelineSettings';
import { localDate, type TaskPlanning } from '../src/tasks';

const d = localDate;
const planning: TaskPlanning = {
  start: d('2026-10-24'),
  due: d('2026-10-26'),
  scheduled: d('2026-11-01'),
};

describe('Task Timeline dates', () => {
  it('keeps Scheduled independent of the inclusive Start–Due interval', () => {
    expect(taskTimelineDates(planning)).toEqual({
      range: { kind: 'closed', startDay: '2026-10-24', endDay: '2026-10-26' },
      scheduled: '2026-11-01',
    });
    expect(taskTimelineDates({ start: d('2026-10-24') })).toEqual({
      range: { kind: 'open-end', startDay: '2026-10-24' },
    });
    expect(taskTimelineDates({ due: d('2026-10-24') })).toEqual({
      range: { kind: 'open-start', endDay: '2026-10-24' },
    });
    expect(taskTimelineDates({})).toEqual({ range: { kind: 'unscheduled' } });
  });
  it('preserves invalid endpoint order without silently swapping it', () => {
    expect(taskTimelineDates({ start: d('2026-10-26'), due: d('2026-10-24') }).range).toEqual({
      kind: 'malformed',
      start: '2026-10-26',
      end: '2026-10-24',
    });
    expect(
      planTaskTimelineEdit(
        { start: d('2026-10-26'), due: d('2026-10-24') },
        { type: 'move', deltaDays: 1 },
      ),
    ).toMatchObject({ kind: 'rejected' });
  });
  it('moves civil dates through daylight-saving boundaries, preserving Scheduled and missing endpoints', () => {
    expect(planTaskTimelineEdit(planning, { type: 'move', deltaDays: 2 })).toMatchObject({
      kind: 'ready',
      patch: {
        start: { type: 'set', value: '2026-10-26' },
        due: { type: 'set', value: '2026-10-28' },
      },
    });
    expect(
      planTaskTimelineEdit({ due: d('2026-10-24') }, { type: 'move', deltaDays: 2 }),
    ).toMatchObject({ kind: 'ready', patch: { due: { type: 'set', value: '2026-10-26' } } });
    const result = planTaskTimelineEdit(planning, { type: 'move', deltaDays: 2 });
    expect(
      result.kind === 'ready' && Object.keys(result.patch).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['due', 'start']);
  });
  it('resizes only the chosen endpoint and prevents a reversed interval', () => {
    expect(
      planTaskTimelineEdit(planning, { type: 'resizeStart', day: '2026-11-01' }),
    ).toMatchObject({ kind: 'ready', patch: { start: { type: 'set', value: '2026-10-26' } } });
    expect(planTaskTimelineEdit(planning, { type: 'resizeEnd', day: '2026-10-25' })).toMatchObject({
      kind: 'ready',
      patch: { due: { type: 'set', value: '2026-10-25' } },
    });
  });
  it('moves only Scheduled and creates an undated interval in one patch', () => {
    expect(
      planTaskTimelineEdit(planning, { type: 'move', deltaDays: -2 }, 'scheduled'),
    ).toMatchObject({ kind: 'ready', patch: { scheduled: { type: 'set', value: '2026-10-30' } } });
    expect(
      planTaskTimelineEdit({}, { type: 'draw', startDay: '2026-10-26', endDay: '2026-10-24' }),
    ).toMatchObject({
      kind: 'ready',
      patch: {
        start: { type: 'set', value: '2026-10-24' },
        due: { type: 'set', value: '2026-10-26' },
      },
    });
    expect(planTaskTimelineEdit({}, { type: 'move', deltaDays: 1 }, 'scheduled')).toMatchObject({
      kind: 'rejected',
    });
    expect(planTaskTimelineEdit(planning, { type: 'resizeEnd', day: '2026-02-30' })).toMatchObject({
      kind: 'rejected',
    });
  });
  it('rejects fractional moves and dates beyond the supported calendar', () => {
    expect(planTaskTimelineEdit(planning, { type: 'move', deltaDays: 0.5 })).toMatchObject({
      kind: 'rejected',
    });
    expect(
      planTaskTimelineEdit({ due: d('9999-12-31') }, { type: 'move', deltaDays: 1 }),
    ).toMatchObject({ kind: 'rejected' });
    expect(planTaskTimelineEdit(planning, { type: 'move', deltaDays: 0 })).toMatchObject({
      kind: 'ready',
      patch: {},
    });
  });
  it('keeps independent organization and restores List preferences on switching back', () => {
    const list = {
      groupBy: 'tag',
      sortBy: { field: 'title', dir: 'desc' },
      filters: [],
      statusGroups: ['todo'],
    } as const;
    const view = {
      ...list,
      filters: [],
      statusGroups: ['todo' as const],
      view: 'timeline' as const,
      timeline: defaultTaskTimelineSettings(),
    };
    expect(taskCollectionListState(view)).toMatchObject({
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
    });
    expect(taskCollectionListState(view).statusGroups).toBeUndefined();
    expect(taskCollectionListState({ ...view, view: 'list' })).toMatchObject(list);
    expect(normalizeTaskTimelineSettings({ scale: 'invalid', showScheduled: false })).toMatchObject(
      { scale: 'month', showScheduled: false, showUnscheduled: true },
    );
  });
});
