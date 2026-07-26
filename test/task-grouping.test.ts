import { describe, expect, it, vi } from 'vitest';
import type { TaskSnapshot as Task } from '../src/tasks';
import {
  getTasksForDate,
  groupTasksByDate,
  groupTasksByPriority,
  groupTasksByTag,
  renderTaskGroup,
  sortTasks,
  sortTasksByDateTime,
  sortTasksByField,
} from '../src/views/taskGrouping';
import { task, useRealMoment } from './helpers';

useRealMoment();

describe('sortTasks', () => {
  it('returns an empty array for empty input', () => {
    expect(sortTasks([])).toEqual([]);
  });

  it('returns a new array (does not mutate input)', () => {
    const input: Task[] = [task({ title: 'a' })];
    const out = sortTasks(input);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(1);
  });

  it('orders by priority ascending A..F', () => {
    const out = sortTasks([
      task({ title: 'low', priority: 'F' }),
      task({ title: 'high', priority: 'A' }),
      task({ title: 'mid', priority: 'C' }),
    ]);
    expect(out.map((t) => t.priority)).toEqual(['A', 'C', 'F']);
  });

  it('within same priority, timed tasks come before untimed', () => {
    const out = sortTasks([
      task({ title: 'noTime', priority: 'D' }),
      task({ title: 'timed', priority: 'D', planning: { time: '09:00' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['timed', 'noTime']);
  });

  it('within same priority and both timed, orders lex by time (zero-padded = numerically correct)', () => {
    const out = sortTasks([
      task({ title: 'b', priority: 'D', planning: { time: '10:00' } }),
      task({ title: 'a', priority: 'D', planning: { time: '09:00' } }),
    ]);
    expect(out.map((t) => t.planning.time)).toEqual(['09:00', '10:00']);
  });

  it('within same priority and both timed, lex compare mis-sorts unpadded hours (CURRENT BEHAVIOR, follow-up FU-8)', () => {
    const out = sortTasks([
      task({ title: 'a', priority: 'D', planning: { time: '10:00' } }),
      task({ title: 'b', priority: 'D', planning: { time: '9:30' } }),
    ]);
    // "9:30" > "10:00" lexically ("9" > "1"), so 9:30 sorts AFTER 10:00
    expect(out.map((t) => t.planning.time)).toEqual(['10:00', '9:30']);
  });

  it('within same priority and neither timed, orders by text.localeCompare', () => {
    const out = sortTasks([
      task({ title: 'zeta', priority: 'D' }),
      task({ title: 'alpha', priority: 'D' }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['alpha', 'zeta']);
  });

  it('ignores status (no status-based ordering)', () => {
    const out = sortTasks([
      task({ title: 'done', priority: 'D', status: 'done' }),
      task({ title: 'open', priority: 'D', status: 'open' }),
    ]);
    // both priority D, no time → text.localeCompare: 'done' < 'open'
    expect(out.map((t) => t.title)).toEqual(['done', 'open']);
  });
});

describe('getTasksForDate', () => {
  const DATE = '2026-06-24';
  const TODAY = '2026-06-24';

  it('places an open non-recurring task due on date into due', () => {
    const g = getTasksForDate([task({ planning: { due: DATE } })], DATE, TODAY);
    expect(g.due).toHaveLength(1);
    expect(g.recurrence).toHaveLength(0);
  });

  it('places an open recurring task due on date into recurrence (not due)', () => {
    const g = getTasksForDate(
      [task({ recurrence: 'every week', planning: { due: DATE } })],
      DATE,
      TODAY,
    );
    expect(g.recurrence).toHaveLength(1);
    expect(g.due).toHaveLength(0);
  });

  it('places an open task due before today into overdue (regardless of date)', () => {
    const g = getTasksForDate([task({ planning: { due: '2026-06-20' } })], DATE, TODAY);
    expect(g.overdue).toHaveLength(1);
  });

  it('places an open recurring task due before today into overdue (no !recurrence guard)', () => {
    const g = getTasksForDate(
      [task({ recurrence: 'every week', planning: { due: '2026-06-20' } })],
      DATE,
      TODAY,
    );
    expect(g.overdue).toHaveLength(1);
    expect(g.recurrence).toHaveLength(0);
  });

  it('places an open task with start on date and due not on date into start', () => {
    const g = getTasksForDate(
      [task({ planning: { start: DATE, due: '2026-06-28' } })],
      DATE,
      TODAY,
    );
    expect(g.start).toHaveLength(1);
  });

  it('places an open task scheduled on date into scheduled', () => {
    const g = getTasksForDate([task({ planning: { scheduled: DATE } })], DATE, TODAY);
    expect(g.scheduled).toHaveLength(1);
  });

  it('places an open task with due after date and start before today into process', () => {
    const g = getTasksForDate(
      [task({ planning: { due: '2026-06-28', start: '2026-06-20' } })],
      DATE,
      TODAY,
    );
    expect(g.inProcess).toHaveLength(1);
  });

  it('places an open task with dailyNoteDate on date into dailyNote', () => {
    const g = getTasksForDate([task({ presentation: { dailyNoteDate: DATE } })], DATE, TODAY);
    expect(g.dailyNote).toHaveLength(1);
  });

  it('places a done task due on date into allDone', () => {
    const g = getTasksForDate([task({ status: 'done', planning: { due: DATE } })], DATE, TODAY);
    expect(g.allDone).toHaveLength(1);
    expect(g.due).toHaveLength(0);
  });

  it('places a done task with no due but completion on date into allDone', () => {
    const g = getTasksForDate(
      [task({ status: 'done', planning: { completion: DATE } })],
      DATE,
      TODAY,
    );
    expect(g.allDone).toHaveLength(1);
  });

  it('places a cancelled task due on date into cancelled', () => {
    const g = getTasksForDate(
      [task({ status: 'cancelled', planning: { due: DATE } })],
      DATE,
      TODAY,
    );
    expect(g.cancelled).toHaveLength(1);
    expect(g.due).toHaveLength(0);
  });

  it('excludes closed tasks from due/overdue/start/scheduled/process/dailyNote', () => {
    const done = task({ status: 'done', planning: { due: DATE } });
    const cancelled = task({ status: 'cancelled', planning: { due: DATE } });
    const g = getTasksForDate([done, cancelled], DATE, TODAY);
    expect(g.due).toHaveLength(0);
    expect(g.overdue).toHaveLength(0);
    expect(g.start).toHaveLength(0);
    expect(g.scheduled).toHaveLength(0);
    expect(g.inProcess).toHaveLength(0);
    expect(g.dailyNote).toHaveLength(0);
  });

  it('places a task with no dates into no group', () => {
    const g = getTasksForDate([task()], DATE, TODAY);
    expect(g.due).toHaveLength(0);
    expect(g.overdue).toHaveLength(0);
    expect(g.start).toHaveLength(0);
    expect(g.scheduled).toHaveLength(0);
    expect(g.dailyNote).toHaveLength(0);
  });

  it('a task can appear in multiple groups (no de-duplication): overdue + start', () => {
    // due < today (overdue) AND start == date == today (start)
    const g = getTasksForDate(
      [task({ planning: { due: '2026-06-20', start: DATE } })],
      DATE,
      TODAY,
    );
    expect(g.overdue).toHaveLength(1);
    expect(g.start).toHaveLength(1);
  });
});

describe('sortTasksByDateTime', () => {
  it('returns empty array for empty input', () => {
    expect(sortTasksByDateTime([])).toEqual([]);
  });

  it('returns a new array (does not mutate input)', () => {
    const input: Task[] = [task({ title: 'a', planning: { due: '2026-06-25' } })];
    const out = sortTasksByDateTime(input);
    expect(out).not.toBe(input);
  });

  it('sorts by date ascending when dates differ', () => {
    const out = sortTasksByDateTime([
      task({ title: 'later', planning: { due: '2026-06-26' } }),
      task({ title: 'earlier', planning: { due: '2026-06-25' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['earlier', 'later']);
  });

  it('within same date, timed tasks come before untimed', () => {
    const out = sortTasksByDateTime([
      task({ title: 'noTime', planning: { due: '2026-06-25' } }),
      task({ title: 'timed', planning: { due: '2026-06-25', time: '08:00' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['timed', 'noTime']);
  });

  it('within same date, timed tasks sort chronologically', () => {
    const out = sortTasksByDateTime([
      task({ title: 'afternoon', planning: { due: '2026-06-25', time: '15:00' } }),
      task({ title: 'morning', planning: { due: '2026-06-25', time: '08:00' } }),
      task({ title: 'evening', planning: { due: '2026-06-25', time: '20:00' } }),
    ]);
    expect(out.map((t) => t.planning.time)).toEqual(['08:00', '15:00', '20:00']);
  });

  it('date ordering is not broken by time — later-date timed task stays after earlier-date untimed', () => {
    // Bug scenario from Upcoming view: Fri 26 Jun 20:00 was sorting before Tue 30 Jun (no time)
    const out = sortTasksByDateTime([
      task({ title: 'laterDateTimed', planning: { due: '2026-06-30', time: '18:00' } }),
      task({ title: 'earlyDateNoTime', planning: { due: '2026-06-26' } }),
      task({ title: 'earlyDateTimed', planning: { due: '2026-06-26', time: '20:00' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual([
      'earlyDateTimed',
      'earlyDateNoTime',
      'laterDateTimed',
    ]);
  });

  it('uses scheduled as fallback date when due is absent', () => {
    const out = sortTasksByDateTime([
      task({ title: 'b', planning: { scheduled: '2026-06-26' } }),
      task({ title: 'a', planning: { scheduled: '2026-06-25' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['a', 'b']);
  });

  it('keeps daily-note-only tasks with undated tasks when sorting', () => {
    const out = sortTasksByDateTime([
      task({ title: 'b', presentation: { dailyNoteDate: '2026-06-26' } }),
      task({ title: 'a', presentation: { dailyNoteDate: '2026-06-25' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['b', 'a']);
  });

  it('tasks with no date sort to end', () => {
    const out = sortTasksByDateTime([
      task({ title: 'noDate' }),
      task({ title: 'dated', planning: { due: '2026-06-25' } }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['dated', 'noDate']);
  });
});

describe('sortTasksByField', () => {
  it('date asc: nearest first (no date sorts last)', () => {
    const t1 = task({ planning: { due: '2026-07-01' } });
    const t2 = task({ planning: { due: '2026-06-28' } });
    const t3 = task({});
    const out = sortTasksByField([t1, t3, t2], 'date', 'asc');
    expect(out.map((t) => t.planning.due)).toEqual(['2026-06-28', '2026-07-01', undefined]);
  });

  it('date desc: furthest first, no-date last', () => {
    const t1 = task({ planning: { due: '2026-07-01' } });
    const t2 = task({ planning: { due: '2026-06-28' } });
    const out = sortTasksByField([t2, t1], 'date', 'desc');
    expect(out[0]?.planning.due).toBe('2026-07-01');
  });

  it('priority asc: A before F', () => {
    const out = sortTasksByField(
      [task({ priority: 'F' }), task({ priority: 'A' })],
      'priority',
      'asc',
    );
    expect(out[0]?.priority).toBe('A');
  });

  it('priority desc: F before A', () => {
    const out = sortTasksByField(
      [task({ priority: 'A' }), task({ priority: 'F' })],
      'priority',
      'desc',
    );
    expect(out[0]?.priority).toBe('F');
  });

  it('title asc: alphabetical', () => {
    const out = sortTasksByField(
      [task({ title: 'zebra' }), task({ title: 'apple' })],
      'title',
      'asc',
    );
    expect(out[0]?.title).toBe('apple');
  });

  it('tag asc: first tag alphabetical, untagged last', () => {
    const t1 = task({
      tags: ['#work'],
      source: { originalMarkdown: '- [ ] task #work', originalBlock: '- [ ] task #work' },
    });
    const t2 = task({
      tags: ['#art'],
      source: { originalMarkdown: '- [ ] task #art', originalBlock: '- [ ] task #art' },
    });
    const t3 = task({
      source: { originalMarkdown: '- [ ] task no tag', originalBlock: '- [ ] task no tag' },
    });
    const out = sortTasksByField([t1, t3, t2], 'tag', 'asc');
    expect((out[0]?.source.originalMarkdown.match(/#[\w/-]+/u) ?? [])[0]).toBe('#art');
    expect(out[2]?.source.originalMarkdown).toContain('no tag');
  });
});

describe('groupTasksByPriority', () => {
  it('returns groups for present priorities only', () => {
    const tasks = [
      task({ priority: 'A', title: 'high' }),
      task({ priority: 'D', title: 'normal' }),
    ];
    const groups = groupTasksByPriority(tasks);
    expect(groups.map((g) => g.label)).toContain('🔺 Highest');
    expect(groups.map((g) => g.label)).toContain('Normal');
    expect(groups.map((g) => g.label)).not.toContain('⏬ Lowest');
  });

  it('tasks with priority A appear in Highest group', () => {
    const t = task({ priority: 'A', title: 'urgent' });
    const groups = groupTasksByPriority([t]);
    const highest = groups.find((g) => g.label === '🔺 Highest');
    expect(highest?.tasks[0]?.title).toBe('urgent');
  });
});

describe('groupTasksByTag', () => {
  it('groups by first tag; untagged go to "No tag"', () => {
    const t1 = task({
      tags: ['#work'],
      source: { originalMarkdown: '- [ ] a #work', originalBlock: '- [ ] a #work' },
    });
    const t2 = task({
      tags: ['#personal'],
      source: { originalMarkdown: '- [ ] b #personal', originalBlock: '- [ ] b #personal' },
    });
    const t3 = task({
      source: { originalMarkdown: '- [ ] c no tag', originalBlock: '- [ ] c no tag' },
    });
    const groups = groupTasksByTag([t1, t2, t3]);
    expect(groups.map((g) => g.label)).toContain('#work');
    expect(groups.map((g) => g.label)).toContain('#personal');
    expect(groups.map((g) => g.label)).toContain('No tag');
  });
});

describe('groupTasksByDate', () => {
  it('places a daily-note-only task in No date while retaining explicit due dates', () => {
    const groups = groupTasksByDate(
      [
        task({ title: 'daily-only', presentation: { dailyNoteDate: '2026-06-26' } }),
        task({ title: 'due', planning: { due: '2026-06-26' } }),
      ],
      '2026-06-26',
      '2026-06-27',
    );
    expect(
      groups.find((group) => group.label === 'No date')?.tasks.map((task) => task.title),
    ).toEqual(['daily-only']);
    expect(
      groups.find((group) => group.label === 'Today')?.tasks.map((task) => task.title),
    ).toEqual(['due']);
  });

  it('returns Overdue group for tasks with past due date', () => {
    const t = task({ planning: { due: '2020-01-01' } });
    const groups = groupTasksByDate([t], '2026-06-26', '2026-06-27');
    expect(groups[0]?.label).toBe('Overdue');
    expect(groups[0]?.tasks).toHaveLength(1);
  });
});

describe('renderTaskGroup', () => {
  it('appends nothing for all-empty groups', () => {
    const container = activeDocument.createElement('div');
    const g = getTasksForDate([], '2026-06-24', '2026-06-24');
    renderTaskGroup(container, g, '2026-06-24', '2026-06-24', (_t) =>
      activeDocument.createElement('span'),
    );
    expect(container.children).toHaveLength(0);
  });

  it('renders overdue first when date === today, then due', () => {
    const container = activeDocument.createElement('div');
    const g = getTasksForDate(
      [
        task({ title: 'overdue', planning: { due: '2026-06-20' } }),
        task({ title: 'due', planning: { due: '2026-06-24' } }),
      ],
      '2026-06-24',
      '2026-06-24',
    );
    const spy = vi.fn((_t: Task, cls: string) => {
      const el = activeDocument.createElement('div');
      el.className = cls;
      el.textContent = _t.title;
      return el;
    });
    renderTaskGroup(container, g, '2026-06-24', '2026-06-24', spy);
    // overdue first, then due
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['overdue', 'due']);
    expect(container.children[0]?.className).toBe('overdue');
    expect(container.children[1]?.className).toBe('due');
  });

  it('does not render overdue when date !== today', () => {
    const container = activeDocument.createElement('div');
    const g = getTasksForDate(
      [task({ title: 'overdue', planning: { due: '2026-06-20' } })],
      '2026-06-25',
      '2026-06-24',
    );
    const spy = vi.fn((_t: Task, _cls: string) => activeDocument.createElement('div'));
    renderTaskGroup(container, g, '2026-06-25', '2026-06-24', spy);
    expect(spy).not.toHaveBeenCalled();
    expect(container.children).toHaveLength(0);
  });

  it('renders groups in canonical order with exact cls strings', () => {
    const container = activeDocument.createElement('div');
    const g = {
      due: [task({ title: 'd' })],
      recurrence: [task({ title: 'r', recurrence: 'every week', planning: { due: '2026-06-24' } })],
      overdue: [],
      start: [task({ title: 's', planning: { start: '2026-06-24', due: '2026-06-28' } })],
      scheduled: [task({ title: 'sc', planning: { scheduled: '2026-06-24' } })],
      inProcess: [],
      dailyNote: [task({ title: 'dn', presentation: { dailyNoteDate: '2026-06-24' } })],
      allDone: [task({ title: 'ad', status: 'done', planning: { due: '2026-06-24' } })],
      cancelled: [task({ title: 'ca', status: 'cancelled', planning: { due: '2026-06-24' } })],
    };
    const classes: string[] = [];
    renderTaskGroup(container, g, '2026-06-25', '2026-06-25', (t, cls) => {
      classes.push(cls);
      return activeDocument.createElement('div');
    });
    // date !== today → no overdue; order: due, recurrence, start, scheduled, dailyNote, allDone(cls:'done'), cancelled
    expect(classes).toEqual([
      'due',
      'recurrence',
      'start',
      'scheduled',
      'dailyNote',
      'done',
      'cancelled',
    ]);
  });

  it('sorts tasks within a group via sortTasks', () => {
    const container = activeDocument.createElement('div');
    const g = {
      due: [task({ title: 'b', priority: 'D' }), task({ title: 'a', priority: 'A' })],
      recurrence: [],
      overdue: [],
      start: [],
      scheduled: [],
      inProcess: [],
      dailyNote: [],
      allDone: [],
      cancelled: [],
    };
    const texts: string[] = [];
    renderTaskGroup(container, g, '2026-06-24', '2026-06-24', (t) => {
      texts.push(t.title);
      return activeDocument.createElement('div');
    });
    // priority A before D → 'a' then 'b'
    expect(texts).toEqual(['a', 'b']);
  });
});
