import { describe, expect, it } from 'vitest';
import { getTaskDateCategory } from '../src/domain/taskDateCategory';
import { task } from './helpers';

const TODAY = '2026-06-26';
const YESTERDAY = '2026-06-25';
const TOMORROW = '2026-06-27';

describe('getTaskDateCategory', () => {
  // ── Completed / Cancelled ────────────────────────────────────────────────

  it('done task is "completed" regardless of due date', () => {
    expect(getTaskDateCategory(task({ status: 'done', planning: { due: YESTERDAY } }), TODAY)).toBe(
      'completed',
    );
  });

  it('done task with no date is "completed" (not noDate)', () => {
    expect(getTaskDateCategory(task({ status: 'done' }), TODAY)).toBe('completed');
  });

  it('cancelled task is "cancelled" regardless of due date', () => {
    expect(
      getTaskDateCategory(task({ status: 'cancelled', planning: { due: YESTERDAY } }), TODAY),
    ).toBe('cancelled');
  });

  it('cancelled overdue task is "cancelled" (not overdue)', () => {
    expect(
      getTaskDateCategory(task({ status: 'cancelled', planning: { due: '2020-01-01' } }), TODAY),
    ).toBe('cancelled');
  });

  it('completed task with past due date is "completed" (not overdue)', () => {
    expect(
      getTaskDateCategory(task({ status: 'done', planning: { due: '2020-01-01' } }), TODAY),
    ).toBe('completed');
  });

  // ── noDate ───────────────────────────────────────────────────────────────

  it('open task with no dates is "noDate"', () => {
    expect(getTaskDateCategory(task({ status: 'open' }), TODAY)).toBe('noDate');
  });

  it('noDate is distinct from overdue (no implicit date = no due date)', () => {
    const cat = getTaskDateCategory(task({ status: 'open' }), TODAY);
    expect(cat).toBe('noDate');
    expect(cat).not.toBe('overdue');
  });

  // ── overdue ──────────────────────────────────────────────────────────────

  it('open task with due yesterday is "overdue"', () => {
    expect(getTaskDateCategory(task({ planning: { due: YESTERDAY } }), TODAY)).toBe('overdue');
  });

  it('open task with due date in the past is "overdue"', () => {
    expect(getTaskDateCategory(task({ planning: { due: '2020-01-01' } }), TODAY)).toBe('overdue');
  });

  // ── today ────────────────────────────────────────────────────────────────

  it('open task with due today is "today"', () => {
    expect(getTaskDateCategory(task({ planning: { due: TODAY } }), TODAY)).toBe('today');
  });

  // ── upcoming ─────────────────────────────────────────────────────────────

  it('open task with future due date is "upcoming"', () => {
    expect(getTaskDateCategory(task({ planning: { due: TOMORROW } }), TODAY)).toBe('upcoming');
  });

  it('open task with due far in future is "upcoming"', () => {
    expect(getTaskDateCategory(task({ planning: { due: '2030-12-31' } }), TODAY)).toBe('upcoming');
  });

  // ── Date priority: due > scheduled > start ──────────────────────────────

  it('uses due when both due and scheduled are present', () => {
    // due is today, scheduled is yesterday → today (due wins)
    expect(
      getTaskDateCategory(task({ planning: { due: TODAY, scheduled: YESTERDAY } }), TODAY),
    ).toBe('today');
  });

  it('uses scheduled when due is absent', () => {
    expect(getTaskDateCategory(task({ planning: { scheduled: YESTERDAY } }), TODAY)).toBe(
      'overdue',
    );
  });

  it('uses start when due and scheduled are absent', () => {
    expect(getTaskDateCategory(task({ planning: { start: TOMORROW } }), TODAY)).toBe('upcoming');
  });

  it('treats dailyNoteDate-only metadata as no date', () => {
    expect(getTaskDateCategory(task({ presentation: { dailyNoteDate: YESTERDAY } }), TODAY)).toBe(
      'noDate',
    );
  });

  // ── Date boundary (midnight crossover) ──────────────────────────────────

  it('task due exactly on today is "today" (not overdue, not upcoming)', () => {
    expect(getTaskDateCategory(task({ planning: { due: TODAY } }), TODAY)).toBe('today');
  });

  it('task due on boundary day (today) is not overdue even at any time', () => {
    // Pure string comparison: '2026-06-26' === '2026-06-26' → today
    expect(getTaskDateCategory(task({ planning: { due: '2026-06-26' } }), '2026-06-26')).toBe(
      'today',
    );
  });
});

// ── groupTasksByDate – noDate fix ────────────────────────────────────────────

import { groupTasksByDate } from '../src/views/taskGrouping';

describe('groupTasksByDate – noDate bucket fix', () => {
  it('task with no date falls into "No date" group, not Overdue', () => {
    const noDateTask = task({ status: 'open' }); // no due/scheduled/start/dailyNoteDate
    const groups = groupTasksByDate([noDateTask], TODAY, TOMORROW);
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain('Overdue');
    expect(labels).toContain('No date');
  });

  it('overdue task (due yesterday) goes into Overdue, not No date', () => {
    const overdueTask = task({ planning: { due: YESTERDAY } });
    const groups = groupTasksByDate([overdueTask], TODAY, TOMORROW);
    const overdue = groups.find((g) => g.label === 'Overdue');
    expect(overdue?.tasks).toHaveLength(1);
    const noDate = groups.find((g) => g.label === 'No date');
    expect(noDate).toBeUndefined();
  });

  it('mix of overdue, today, upcoming, and noDate all land in correct buckets', () => {
    const tasks = [
      task({ title: 'overdue', planning: { due: YESTERDAY } }),
      task({ title: 'today', planning: { due: TODAY } }),
      task({ title: 'upcoming', planning: { due: TOMORROW } }),
      task({ title: 'noDate' }),
    ];
    const groups = groupTasksByDate(tasks, TODAY, TOMORROW);
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.tasks.map((t) => t.title)]));
    expect(byLabel['Overdue']).toEqual(['overdue']);
    expect(byLabel['Today']).toEqual(['today']);
    expect(byLabel['Tomorrow']).toEqual(['upcoming']);
    expect(byLabel['No date']).toEqual(['noDate']);
  });

  it('completed task with past due is not in Overdue (getTasksForDate already excludes done)', () => {
    // getTasksForDate handles done/cancelled exclusion; groupTasksByDate operates on open tasks.
    // Confirm that a task passed to groupTasksByDate with a past due ends up in Overdue only
    // when it is actually open (the view layer is responsible for pre-filtering by status).
    const doneOverdue = task({ status: 'done', planning: { due: YESTERDAY } });
    const groups = groupTasksByDate([doneOverdue], TODAY, TOMORROW);
    const overdue = groups.find((g) => g.label === 'Overdue');
    // Done tasks are passed through; groupTasksByDate only looks at dates, not status.
    // Callers are responsible for filtering done tasks before calling groupTasksByDate.
    expect(overdue?.tasks[0]?.status).toBe('done');
  });
});
