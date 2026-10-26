import { describe, expect, it } from 'vitest';
import { todayTaskCategory } from '../src/task-lists/todayTaskCategory';
import { localDate } from '../src/tasks';
import { task, type TaskFixtureInput } from './helpers';

const today = localDate('2026-10-03');

describe('todayTaskCategory', () => {
  it('gives overdue priority to a task also scheduled today', () => {
    const overlapping = task({ planning: { due: '2026-10-02', scheduled: '2026-10-03' } });
    expect(todayTaskCategory(overlapping, today)).toBe('overdue');
  });

  it.each([
    [{ due: '2026-10-02' }, 'overdue'],
    [{ due: '2026-10-03' }, 'today'],
    [{ scheduled: '2026-10-03' }, 'today'],
    [{ due: '2026-10-04', scheduled: '2026-10-03' }, 'today'],
    [{ due: '2026-10-03', scheduled: '2026-10-02' }, 'today'],
    [{ scheduled: '2026-10-02' }, undefined],
    [{ due: '2026-10-04' }, undefined],
    [{ scheduled: '2026-10-04' }, undefined],
    [{ start: '2026-10-03' }, 'today'],
    [{}, undefined],
  ] satisfies ReadonlyArray<[TaskFixtureInput['planning'], 'today' | 'overdue' | undefined]>)(
    'classifies planning %j as %s',
    (planning, expected) => {
      expect(todayTaskCategory(task({ planning }), today)).toBe(expected);
    },
  );

  it.each([
    ['done', { completion: '2026-10-03' }, 'today'],
    ['done', { completion: '2026-10-03', due: '2026-09-01' }, 'today'],
    ['done', { completion: '2026-10-03', due: '2026-10-05' }, 'today'],
    ['done', { completion: '2026-10-02', due: '2026-10-03' }, undefined],
    ['done', { due: '2026-10-03' }, undefined],
    ['done', { completion: '2026-10-04', due: '2026-10-02' }, undefined],
    ['cancelled', { cancelled: '2026-10-03' }, 'today'],
    ['cancelled', { cancelled: '2026-10-02', due: '2026-10-03' }, undefined],
    ['cancelled', { due: '2026-10-02', completion: '2026-10-03' }, undefined],
    ['open', { completion: '2026-10-03' }, undefined],
  ] satisfies ReadonlyArray<
    [NonNullable<TaskFixtureInput['status']>, TaskFixtureInput['planning'], 'today' | undefined]
  >)('uses %s lifecycle dates %j for Today: %s', (status, planning, expected) => {
    expect(todayTaskCategory(task({ status, planning }), today)).toBe(expected);
  });
});
