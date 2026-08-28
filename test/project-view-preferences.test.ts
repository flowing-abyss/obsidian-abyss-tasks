import { describe, expect, it } from 'vitest';
import {
  migrateProjectTimelinePreferences,
  reconcileProjectBoardPreference,
  resetProjectBoardStatusOrder,
} from '../src/panels/projects/projectViewPreferences';

describe('Project view preferences', () => {
  it('reconciles active board IDs in their stored order while preserving dormant IDs', () => {
    const preference = reconcileProjectBoardPreference(
      {
        version: 1,
        statusIds: ['planned', 'retired', 'planned', 'active'],
        dormantStatusIds: ['retired', 'legacy'],
      },
      ['active', 'planned', 'done'],
    );

    expect(preference).toEqual({
      version: 1,
      statusIds: ['planned', 'active', 'done'],
      dormantStatusIds: ['retired', 'legacy'],
    });
  });

  it('restores a dormant status when it becomes configured again', () => {
    const preference = reconcileProjectBoardPreference(
      {
        version: 1,
        statusIds: ['active'],
        dormantStatusIds: ['retired'],
      },
      ['active', 'retired'],
    );

    expect(preference).toEqual({
      version: 1,
      statusIds: ['active', 'retired'],
      dormantStatusIds: [],
    });
  });

  it('resets active IDs to the configured order without discarding dormant IDs', () => {
    expect(
      resetProjectBoardStatusOrder(
        {
          version: 1,
          statusIds: ['planned', 'active'],
          dormantStatusIds: ['retired', 'legacy'],
        },
        ['active', 'planned', 'retired', 'done'],
      ),
    ).toEqual({
      version: 1,
      statusIds: ['active', 'planned', 'retired', 'done'],
      dormantStatusIds: ['legacy'],
    });
  });

  it.each([
    ['portfolio week', { portfolio: { scale: 'week', identityWidth: 240 } }, 'portfolio', 'week'],
    [
      'portfolio month',
      { portfolio: { scale: 'month', identityWidth: 240 } },
      'portfolio',
      'month',
    ],
    [
      'portfolio quarter',
      { portfolio: { scale: 'quarter', identityWidth: 240 } },
      'portfolio',
      'quarter',
    ],
    ['portfolio year', { portfolio: { scale: 'year', identityWidth: 240 } }, 'portfolio', 'year'],
    ['task day', { tasks: { scale: 'day', identityWidth: 240 } }, 'tasks', 'day'],
    ['task week', { tasks: { scale: 'week', identityWidth: 240 } }, 'tasks', 'week'],
    ['task month', { tasks: { scale: 'month', identityWidth: 240 } }, 'tasks', 'month'],
    [
      'Work Notes day range',
      { workNotes: { dateRange: 'day', identityWidth: 240 } },
      'workNotes',
      'day',
    ],
    [
      'Work Notes week range',
      { workNotes: { dateRange: 'week', identityWidth: 240 } },
      'workNotes',
      'week',
    ],
    [
      'Work Notes month range',
      { workNotes: { dateRange: 'month', identityWidth: 240 } },
      'workNotes',
      'month',
    ],
    [
      'Work Notes quarter range',
      { workNotes: { dateRange: 'quarter', identityWidth: 240 } },
      'workNotes',
      'quarter',
    ],
    [
      'Work Notes year range',
      { workNotes: { dateRange: 'year', identityWidth: 240 } },
      'workNotes',
      'year',
    ],
  ] as const)('preserves the valid %s preference', (_name, input, scope, expected) => {
    const timeline = migrateProjectTimelinePreferences({ version: 1, ...input });

    if (scope === 'workNotes') expect(timeline.workNotes.dateRange).toBe(expected);
    else expect(timeline[scope].scale).toBe(expected);
  });

  it('falls back independently for invalid Task and Work Notes timeline preferences', () => {
    expect(
      migrateProjectTimelinePreferences({
        version: 1,
        tasks: { scale: 'quarter', identityWidth: 240 },
        workNotes: { dateRange: 'century', identityWidth: 240 },
      }),
    ).toMatchObject({
      tasks: { scale: 'week' },
      workNotes: { dateRange: 'month' },
    });
  });
});
