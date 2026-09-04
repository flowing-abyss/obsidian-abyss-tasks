import type { App } from 'obsidian';
import { addIcon } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { LinkToken } from '../src/parser/links';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate, type CalendarTaskSource, type TaskSnapshot as Task } from '../src/tasks';
import { projectCalendarOccurrences } from '../src/views/calendarOccurrences';
import { ListView } from '../src/views/ListView';
import {
  expectDefined,
  freshContainer,
  resolvedConfig,
  subtask,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();

const today = () => window.moment().format('YYYY-MM-DD');
const yesterday = () => window.moment().subtract(1, 'day').format('YYYY-MM-DD');

function fakeApp(): App {
  return {} as App;
}

function makeView(
  callbacks: Partial<{
    onToggle: (t: Task) => void;
    onDateClick: (d: string) => void;
    onTaskClick: (t: Task) => void;
    onEditLink: (t: Task, occ: number, token: LinkToken) => void;
    onContextMenu: (ev: MouseEvent, t: Task) => void;
    onTaskBodyContextMenu: (ev: MouseEvent, t: Task, anchor: HTMLElement) => void;
  }> = {},
  statusRegistry: StatusRegistry = new StatusRegistry(buildDefaultTaskStatuses()),
) {
  const spies = {
    app: fakeApp(),
    onToggle: vi.fn(callbacks.onToggle),
    onDateClick: vi.fn(callbacks.onDateClick),
    onTaskClick: vi.fn(callbacks.onTaskClick),
    onEditLink: vi.fn(callbacks.onEditLink),
    statusRegistry,
    onContextMenu: vi.fn(callbacks.onContextMenu),
    onTaskBodyContextMenu: vi.fn(callbacks.onTaskBodyContextMenu),
  };
  const view = new ListView(spies);
  return { view, spies };
}

describe('ListView', () => {
  describe('render contract', () => {
    it('empty tasks → only .abyss-list-view, no sections', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelector('.abyss-list-view')).not.toBeNull();
      expect(c.querySelectorAll('.abyss-list-section')).toHaveLength(0);
    });

    it('overdue task → one overdue section with count + one task row', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: yesterday() } });
      view.render(c, [t], resolvedConfig());
      const header = c.querySelector('.abyss-list-overdue-header');
      expect(header).not.toBeNull();
      expect(header?.querySelector('.abyss-list-date-count')?.textContent).toBe('1');
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(1);
    });

    it('overdue count span equals overdueTasks.length', () => {
      const { view } = makeView();
      const c = freshContainer();
      const tasks = [
        task({ title: 'a', status: 'open', planning: { due: '2020-01-01' } }),
        task({ title: 'b', status: 'open', planning: { due: '2020-01-02' } }),
      ];
      view.render(c, tasks, resolvedConfig());
      expect(
        c.querySelector('.abyss-list-overdue-header .abyss-list-date-count')?.textContent,
      ).toBe('2');
    });

    it('done task with due today → NOT shown (only open tasks)', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'done', planning: { due: today() } })], resolvedConfig());
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(0);
    });

    it('cancelled task → NOT shown', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'cancelled', planning: { due: today() } })], resolvedConfig());
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(0);
    });

    it('task due today → date label "Today"', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'open', planning: { due: today() } })], resolvedConfig());
      const labels = c.querySelectorAll('.abyss-list-date-label');
      const hasToday = Array.from(labels).some((l) => l.textContent === 'Today');
      expect(hasToday).toBe(true);
    });

    it('task due yesterday → date label "Yesterday"', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'open', planning: { due: yesterday() } })], resolvedConfig());
      // yesterday is overdue, so it goes to overdue section, not day section
      // CURRENT BEHAVIOR: overdue tasks are in "Overdue" section, not "Yesterday"
      expect(
        c.querySelector('.abyss-list-overdue-header .abyss-list-date-label')?.textContent,
      ).toBe('Overdue');
    });

    it('other date → label formatted ddd, D MMM', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
      try {
        const { view } = makeView();
        const c = freshContainer();
        // Pick a future date within the current month that isn't today/yesterday.
        // ListView only renders the current month, and past dates go to the Overdue
        // section (which uses the "Overdue" label, not the ddd, D MMM format).
        const m = window.moment().add(2, 'days');
        if (m.format('YYYY-MM-DD') === today()) m.add(1, 'day');
        const d = m.format('YYYY-MM-DD');
        view.render(c, [task({ status: 'open', planning: { due: d } })], resolvedConfig());
        const labels = c.querySelectorAll('.abyss-list-date-label');
        const label = Array.from(labels).find((l) => l.textContent !== 'Overdue');
        expect(label?.textContent ?? '').toMatch(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('dedup: task in multiple groups renders once', () => {
      const { view } = makeView();
      const c = freshContainer();
      const d = today();
      // due AND scheduled on same day → appears in both groups, deduped to one row
      const t = task({ status: 'open', planning: { due: d, scheduled: d } });
      view.render(c, [t], resolvedConfig());
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(1);
    });

    it('keeps persisted-list counts independent from the calendar forecast projection', () => {
      const persisted = task({
        title: 'Persisted daily repeat',
        recurrence: 'every day',
        planning: { due: today() },
        source: { filePath: 'persisted.md', line: 2 },
      });
      const source: CalendarTaskSource = {
        root: persisted,
        target: { type: 'task', ref: persisted.ref },
        node: persisted,
      };
      const end = window.moment(today()).add(2, 'days').format('YYYY-MM-DD');
      const projection = projectCalendarOccurrences(
        { materialized: [source], recurringSources: [source] },
        { from: localDate(today()), to: localDate(end) },
        { removeScheduledDate: false },
      );
      const { view } = makeView();
      const c = freshContainer();

      view.render(c, [persisted], resolvedConfig());

      expect(projection.occurrences).toHaveLength(3);
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(1);
      expect(c.querySelector('.abyss-list-date-count')?.textContent).toBe('1');
      expect(c.querySelector("[data-recurrence-forecast='true']")).toBeNull();
    });

    it('represents nested recurrence owners through one persisted root row', () => {
      const d = today();
      const rootSeed = task({
        title: 'Parent',
        source: { filePath: 'nested.md', line: 4 },
      });
      const first = subtask({
        title: 'First owner',
        recurrence: 'every week',
        planning: { due: d, time: '08:15' },
        ref: {
          parent: { type: 'task', ref: rootSeed.ref },
          relativeLine: 1,
        },
      });
      const second = subtask({
        title: 'Second owner',
        recurrence: 'every week',
        planning: { due: d, time: '09:45' },
        ref: {
          parent: { type: 'task', ref: rootSeed.ref },
          relativeLine: 2,
        },
      });
      const root = task({
        title: rootSeed.title,
        ref: rootSeed.ref,
        source: rootSeed.source,
        planning: { due: d },
        subtasks: [first, second],
      });
      const { view } = makeView();
      const c = freshContainer();

      view.render(c, [root], resolvedConfig());

      const todaySection = Array.from(c.querySelectorAll<HTMLElement>('.abyss-list-section')).find(
        (section) => section.querySelector('.abyss-list-date-label')?.textContent === 'Today',
      );
      expect(todaySection?.querySelectorAll('.abyss-list-task')).toHaveLength(1);
      expect(todaySection?.querySelector('.abyss-task-progress')?.textContent).toBe('0/2');
      expect(todaySection?.querySelectorAll('.abyss-task-time')).toHaveLength(0);
      expect(todaySection?.querySelector("[data-recurrence-forecast='true']")).toBeNull();
    });

    it('tasks sorted by priority then time then text', () => {
      const { view } = makeView();
      const c = freshContainer();
      const d = today();
      // Distinct filePath/line so dedup doesn't collapse rows (task() defaults to line 0).
      // Titles render via MarkdownRenderer (mocked as a noop in tests), so row order is
      // asserted via the plain-text time badge instead of the title's textContent.
      const tasks = [
        task({
          title: 'zzz',
          priority: 'D',
          status: 'open',
          planning: { due: d, time: '23:00' },
          source: { line: 1 },
        }),
        task({
          title: 'aaa',
          priority: 'A',
          status: 'open',
          planning: { due: d, time: '10:00' },
          source: { line: 2 },
        }),
        task({
          title: 'bbb',
          priority: 'A',
          status: 'open',
          planning: { due: d, time: '09:00' },
          source: { line: 3 },
        }),
      ];
      view.render(c, tasks, resolvedConfig());
      const times = Array.from(c.querySelectorAll('.abyss-task-time')).map((el) => el.textContent);
      expect(times).toEqual(['09:00', '10:00', '23:00']);
    });

    it('renders parser-invalid recurrence with the shared warning badge', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(
        c,
        [task({ status: 'open', recurrence: 'tomorrow', planning: { due: today() } })],
        resolvedConfig(),
      );

      const badge = c.querySelector<HTMLElement>('.abyss-recurrence-badge');
      expect(badge?.dataset['recurrenceValidity']).toBe('invalid');
      expect(badge?.getAttribute('title')).toBe(
        'Invalid repeat rule: Start the rule with “every”.',
      );
      expect(c.querySelectorAll('.abyss-recurrence-badge-icon')).toHaveLength(1);
    });
  });

  describe('interactions', () => {
    it('clicking date header invokes onDateClick(currentDate)', () => {
      const { view, spies } = makeView({ onDateClick: (d) => d });
      const c = freshContainer();
      const d = today();
      view.render(c, [task({ status: 'open', planning: { due: d } })], resolvedConfig());
      const header = c.querySelector('.abyss-list-date-header') as HTMLElement;
      header.click();
      expect(spies.onDateClick).toHaveBeenCalledWith(d);
    });

    it('clicking task row invokes onTaskClick', () => {
      const { view, spies } = makeView({ onTaskClick: (t) => t });
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: today() } });
      view.render(c, [t], resolvedConfig());
      const row = c.querySelector('.abyss-list-task') as HTMLElement;
      row.click();
      expect(spies.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('clicking the status marker invokes onToggle and does not also invoke onTaskClick', () => {
      const { view, spies } = makeView({ onToggle: (t) => t });
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: today() } });
      view.render(c, [t], resolvedConfig());
      const marker = c.querySelector('.abyss-status-marker') as HTMLElement;
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(spies.onToggle).toHaveBeenCalledWith(t);
      expect(spies.onTaskClick).not.toHaveBeenCalled();
    });

    it('clicking the marker icon (svg child) invokes onToggle and does not also invoke onTaskClick', () => {
      // Regression test: the marker for a status with an icon renders a child
      // <svg>. A click lands on that svg (e.target !== marker), so the row
      // click handler must use marker.contains(e.target), not marker === e.target,
      // or it double-fires (toggle AND open the task).
      addIcon('circle', '<svg><circle cx="12" cy="12" r="10"/></svg>');
      const registryWithIcon = new StatusRegistry([
        { id: 's1', symbol: ' ', name: 'To-do', type: 'todo', icon: 'circle', core: true },
        { id: 's2', symbol: '/', name: 'In progress', type: 'in-progress', icon: '', core: true },
        { id: 's3', symbol: 'x', name: 'Done', type: 'done', icon: 'check', core: true },
        { id: 's4', symbol: '-', name: 'Cancelled', type: 'cancelled', icon: 'x', core: true },
      ]);
      const { view, spies } = makeView({ onToggle: (t) => t }, registryWithIcon);
      const c = freshContainer();
      const t = task({ status: 'open', statusSymbol: ' ', planning: { due: today() } });
      view.render(c, [t], resolvedConfig());
      const marker = c.querySelector('.abyss-status-marker') as HTMLElement;
      const svg = marker.querySelector('svg') as unknown as HTMLElement;
      expect(svg).not.toBeNull();
      svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(spies.onToggle).toHaveBeenCalledWith(t);
      expect(spies.onTaskClick).not.toHaveBeenCalled();
    });

    it('right-clicking the status marker invokes onContextMenu with the task', () => {
      const { view, spies } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: today() } });
      view.render(c, [t], resolvedConfig());
      const marker = c.querySelector('.abyss-status-marker') as HTMLElement;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      marker.dispatchEvent(ev);
      expect(spies.onContextMenu).toHaveBeenCalledWith(ev, t);
    });

    it('routes a list-task body context interaction without invoking the marker menu', () => {
      const { view, spies } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: today() } });
      view.render(c, [t], resolvedConfig());
      const row = expectDefined(c.querySelector<HTMLElement>('.abyss-list-task'));
      const marker = expectDefined(row.querySelector<HTMLElement>('.abyss-status-marker'));
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

      row.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(spies.onTaskBodyContextMenu).toHaveBeenCalledWith(event, t, row);

      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(spies.onTaskBodyContextMenu).toHaveBeenCalledOnce();
      expect(spies.onContextMenu).toHaveBeenCalledWith(expect.any(MouseEvent), t);
    });

    it('status marker data-status-type reflects an open task', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'open', planning: { due: today() } })], resolvedConfig());
      const marker = c.querySelector('.abyss-status-marker') as HTMLElement;
      expect(marker.getAttribute('data-status-type')).toBe('todo');
    });

    it('is-done class on title when status done — N/A (done tasks filtered)', () => {
      // CURRENT BEHAVIOR: done tasks are never rendered in ListView, so is-done class
      // never appears. Pin the absence.
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'done', planning: { due: today() } })], resolvedConfig());
      expect(c.querySelectorAll('.is-done')).toHaveLength(0);
    });

    it('meta: abyss-task-time span shows task.time when present', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(
        c,
        [task({ status: 'open', planning: { due: today(), time: '14:30' } })],
        resolvedConfig(),
      );
      expect(c.querySelector('.abyss-task-time')?.textContent).toBe('14:30');
    });

    it('meta: no abyss-task-time span when time absent', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [task({ status: 'open', planning: { due: today() } })], resolvedConfig());
      expect(c.querySelector('.abyss-task-time')).toBeNull();
    });

    it('meta: first tag shown as abyss-task-tag', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(
        c,
        [
          task({
            status: 'open',
            tags: ['#work', '#urgent'],
            planning: { due: today() },
            source: {
              originalMarkdown: '- [ ] t #work #urgent',
              originalBlock: '- [ ] t #work #urgent',
            },
          }),
        ],
        resolvedConfig(),
      );
      expect(c.querySelector('.abyss-task-tag')?.textContent).toBe('#work');
    });

    it('meta: only first tag (slice 0,1)', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(
        c,
        [
          task({
            status: 'open',
            tags: ['#work', '#urgent'],
            planning: { due: today() },
            source: {
              originalMarkdown: '- [ ] t #work #urgent',
              originalBlock: '- [ ] t #work #urgent',
            },
          }),
        ],
        resolvedConfig(),
      );
      expect(c.querySelectorAll('.abyss-task-tag')).toHaveLength(1);
    });

    it('meta: subtask progress shown as done/total', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(
        c,
        [
          task({
            status: 'open',
            subtasks: [
              subtask({
                title: 'a',
                status: 'done',
                statusSymbol: 'x',
                ref: { relativeLine: 1, originalBlock: '  - [x] a' },
              }),
              subtask({ title: 'b', ref: { relativeLine: 2, originalBlock: '  - [ ] b' } }),
            ],
            planning: { due: today() },
          }),
        ],
        resolvedConfig(),
      );
      expect(c.querySelector('.abyss-task-progress')?.textContent).toBe('1/2');
    });

    it('destroy is a no-op (no throw)', () => {
      const { view } = makeView();
      expect(() => {
        view.destroy();
      }).not.toThrow();
    });
  });

  describe('source note chip', () => {
    it('sourceNoteDisplay never → no chip rendered', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'Projects/alpha.md' },
        presentation: {},
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'never' }));
      expect(c.querySelector('.abyss-task-source-note')).toBeNull();
    });

    it('sourceNoteDisplay always → chip shows filename without extension', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'Projects/alpha.md' },
        presentation: {},
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'always' }));
      const chip = c.querySelector('.abyss-task-source-note');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain('alpha');
    });

    it('sourceNoteDisplay always → chip shows for daily note too', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'periodic/daily/2026-06-25.md' },
        presentation: { dailyNoteDate: '2026-06-25' },
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'always' }));
      expect(c.querySelector('.abyss-task-source-note')).not.toBeNull();
    });

    it('sourceNoteDisplay non-default → no chip for daily note task', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'periodic/daily/2026-06-25.md' },
        presentation: { dailyNoteDate: '2026-06-25' },
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'non-default' }));
      expect(c.querySelector('.abyss-task-source-note')).toBeNull();
    });

    it('sourceNoteDisplay non-default → no chip when filePath matches customFilePath', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'Inbox/tasks.md' },
        presentation: {},
      });
      view.render(
        c,
        [t],
        resolvedConfig({ sourceNoteDisplay: 'non-default', customFilePath: 'Inbox/tasks.md' }),
      );
      expect(c.querySelector('.abyss-task-source-note')).toBeNull();
    });

    it('sourceNoteDisplay non-default → chip shown for non-default file', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'Projects/beta.md' },
        presentation: {},
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'non-default', customFilePath: '' }));
      const chip = c.querySelector('.abyss-task-source-note');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain('beta');
    });

    it('chip text is just the filename without path or extension', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: today() },
        source: { filePath: 'a/b/c/deep-note.md' },
        presentation: {},
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'always' }));
      const chip = c.querySelector('.abyss-task-source-note');
      expect(chip?.textContent).not.toContain('/');
      expect(chip?.textContent).not.toContain('.md');
      expect(chip?.textContent).toContain('deep-note');
    });

    it('chip appears before tag chip in the meta element', () => {
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        tags: ['#work'],
        planning: { due: today() },
        source: {
          filePath: 'Projects/alpha.md',
          originalMarkdown: '- [ ] task #work',
          originalBlock: '- [ ] task #work',
        },
        presentation: {},
      });
      view.render(c, [t], resolvedConfig({ sourceNoteDisplay: 'always' }));
      const meta = c.querySelector('.abyss-list-task-meta');
      expect(meta).not.toBeNull();
      const children = Array.from(expectDefined(meta).children);
      const noteIdx = children.findIndex((el) => el.classList.contains('abyss-task-source-note'));
      const tagIdx = children.findIndex((el) => el.classList.contains('abyss-task-tag'));
      expect(noteIdx).toBeGreaterThanOrEqual(0);
      expect(tagIdx).toBeGreaterThan(noteIdx);
    });
  });

  describe('edge cases', () => {
    it('startPosition YYYY-MM controls which month is rendered', () => {
      const { view } = makeView();
      const c = freshContainer();
      const nextMonth = window.moment().add(1, 'month').format('YYYY-MM');
      const todayStr = today();
      // a task due today (current month) should NOT appear when rendering next month
      view.render(
        c,
        [task({ status: 'open', planning: { due: todayStr } })],
        resolvedConfig({ startPosition: nextMonth }),
      );
      // today is not in next month → no day sections (overdue section may appear if due<today, but today is not <today)
      expect(c.querySelectorAll('.abyss-list-section')).toHaveLength(0);
    });

    it('past-due task in rendered month appears in overdue section only (not duplicated)', () => {
      const { view } = makeView();
      const c = freshContainer();
      // Use current month so the overdue task's date falls within the rendered month
      const pastDate = window.moment().subtract(5, 'days').format('YYYY-MM-DD');
      const t = task({ status: 'open', planning: { due: pastDate } });
      view.render(c, [t], resolvedConfig());
      expect(c.querySelectorAll('.abyss-list-task')).toHaveLength(1);
      expect(c.querySelector('.abyss-list-overdue-header')).not.toBeNull();
    });
  });
});
