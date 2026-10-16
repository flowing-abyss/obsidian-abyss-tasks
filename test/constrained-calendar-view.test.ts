import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moment } from '../src/obsidianMoment';
import { localDate, type TaskSnapshot } from '../src/tasks';
import {
  ConstrainedCalendarView,
  type ConstrainedCalendarViewCallbacks,
} from '../src/views/ConstrainedCalendarView';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import { expectDefined, task, testStatusRegistry, useRealMoment } from './helpers';

useRealMoment();
const views: ConstrainedCalendarView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => {
    view.destroy();
  });
  document.body.empty();
});
const date = localDate('2026-10-16');
const config = { firstDayOfWeek: 1, startPosition: '2026-10' } as const;
function project(roots: TaskSnapshot[], forecast = false): TaskSnapshot[] {
  const sources: CalendarTaskSource[] = roots.map((root) => ({
    root,
    node: root,
    target: { type: 'task', ref: root.ref },
  }));
  return projectCalendarOccurrences(
    { materialized: forecast ? [] : sources, recurringSources: forecast ? sources : [] },
    { from: date, to: localDate('2026-10-18') },
    { removeScheduledDate: false },
  ).occurrences.map(taskSnapshotForCalendarOccurrence);
}
function mount(tasks: TaskSnapshot[]) {
  let selected = date;
  const callbacks: ConstrainedCalendarViewCallbacks = {
    app: {} as App,
    view: 'month',
    dates: Array.from({ length: 42 }, (_, i) =>
      localDate(moment('2026-09-28').add(i, 'days').format('YYYY-MM-DD')),
    ),
    selectedDate: () => selected,
    onSelectDate: (next) => {
      selected = next;
      view.selectDate(next);
    },
    onCreateAtDate: vi.fn(),
    onTaskClick: vi.fn(),
    onTaskSelect: vi.fn(),
    onShowParent: vi.fn(),
    onForecastClick: vi.fn(),
    onForecastContextMenu: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    statusRegistry: testStatusRegistry(),
  };
  const view = new ConstrainedCalendarView(callbacks);
  views.push(view);
  const container = document.body.createDiv();
  view.render(container, tasks, config);
  return { view, callbacks, container };
}

describe('constrained calendar', () => {
  it.each([0, 1, 3, 4, 20])(
    'keeps all %i agenda rows and only bounded decorative marks',
    (count) => {
      const h = mount(
        project(
          Array.from({ length: count }, (_, line) =>
            task({ source: { line }, title: `Title ${line}`, planning: { due: date } }),
          ),
        ),
      );
      const button = expectDefined(
        h.container.querySelector<HTMLButtonElement>(`button[data-calendar-date="${date}"]`),
      );
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe(
        `Friday, October 16, 2026, ${count} ${count === 1 ? 'task' : 'tasks'}`,
      );
      expect(button.querySelectorAll('.abyss-calendar-dot')).toHaveLength(Math.min(count, 3));
      expect(button.querySelector('.abyss-calendar-overflow') !== null).toBe(count >= 4);
      expect(
        h.container.querySelectorAll('.abyss-calendar-agenda .abyss-calendar-item'),
      ).toHaveLength(count);
      expect(
        h.container.querySelectorAll('.abyss-calendar-date .abyss-calendar-item'),
      ).toHaveLength(0);
      expect(h.container.querySelector('.abyss-calendar-agenda-add')).not.toBeNull();
      expect(h.container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    },
  );

  it('activates materialized rows explicitly, with focus and control/link exclusions', () => {
    const tasks = project([task({ planning: { due: date } })]);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-calendar-item'));
    row.focus();
    expect(h.callbacks.onTaskSelect).toHaveBeenCalledWith(tasks[0]);
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
    row.click();
    expect(h.callbacks.onTaskClick).toHaveBeenCalledTimes(1);
    expectDefined(row.querySelector<HTMLElement>('.abyss-status-marker')).click();
    const link = row.createEl('a', { href: '#', text: 'Link' });
    link.click();
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.callbacks.onTaskClick).toHaveBeenCalledTimes(1);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(h.callbacks.onTaskClick).toHaveBeenCalledTimes(2);
    expectDefined(row.querySelector<HTMLButtonElement>('.abyss-calendar-details')).click();
    expect(h.callbacks.onTaskClick).toHaveBeenCalledTimes(3);
    expect(h.callbacks.onToggle).toHaveBeenCalledWith(tasks[0]);
  });

  it('allows details but blocks quick completion on a continuation until its terminal date', () => {
    const tasks = project([task({ title: 'Span', planning: { start: date, due: '2026-10-17' } })]);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-calendar-item'));
    row.click();
    expect(h.callbacks.onTaskClick).toHaveBeenCalledWith(tasks[0]);
    expectDefined(row.querySelector<HTMLElement>('[role="checkbox"]')).click();
    expect(h.callbacks.onToggle).not.toHaveBeenCalled();
    expectDefined(
      h.container.querySelector<HTMLButtonElement>('button[data-calendar-date="2026-10-17"]'),
    ).click();
    expectDefined(
      h.container.querySelector<HTMLElement>('.abyss-calendar-agenda [role="checkbox"]'),
    ).click();
    expect(h.callbacks.onToggle).toHaveBeenCalledWith(tasks[0]);
  });

  it('opens a forecast through its source and exact reference date, without completion', () => {
    const root = task({ recurrence: 'every day', planning: { due: '2026-10-15' } });
    const tasks = project([root], true);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-calendar-item'));
    expectDefined(row.querySelector<HTMLButtonElement>('.abyss-calendar-details')).click();
    expect(h.callbacks.onForecastClick).toHaveBeenCalledOnce();
    expect(h.callbacks.onForecastClick).toHaveBeenCalledWith(
      { root, node: root, target: { type: 'task', ref: root.ref } },
      date,
    );
    expect(row.querySelector('.abyss-status-marker')).toBeNull();
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
  });
});
