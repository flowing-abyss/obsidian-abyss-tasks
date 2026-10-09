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

  it('classifies completed tasks without filtering status', () => {
    expect(
      todayTaskCategory(task({ status: 'done', planning: { due: '2026-10-03' } }), today),
    ).toBe('today');
    expect(
      todayTaskCategory(task({ status: 'cancelled', planning: { due: '2026-10-02' } }), today),
    ).toBe('overdue');
  });
});
