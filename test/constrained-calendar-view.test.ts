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
import { calendarAgendaHarness } from './support/calendarAgendaHarness';

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
  const cards = calendarAgendaHarness();
  const callbacks: ConstrainedCalendarViewCallbacks = {
    app: {} as App,
    mountAgendaEntry: cards.mountAgendaEntry,
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
  return { view, callbacks, container, cards };
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
      expect(h.container.querySelectorAll('.abyss-calendar-agenda .abyss-task-card')).toHaveLength(
        count,
      );
      expect(h.container.querySelectorAll('.abyss-calendar-date .abyss-task-card')).toHaveLength(0);
      expect(h.container.querySelector('.abyss-add-task-trigger')).not.toBeNull();
      expect(h.container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    },
  );

  it('activates materialized rows explicitly, with focus and control/link exclusions', () => {
    const tasks = project([task({ planning: { due: date } })]);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-task-card'));
    row.focus();
    expect(h.callbacks.onTaskSelect).not.toHaveBeenCalled();
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
    expect(row.querySelector('.abyss-calendar-details')).toBeNull();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.callbacks.onTaskClick).toHaveBeenCalledTimes(3);
    expect(h.cards.toggleTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: tasks[0]?.title }),
      { kind: 'allowed' },
    );
  });

  it('allows details but blocks quick completion on a continuation until its terminal date', () => {
    const tasks = project([task({ title: 'Span', planning: { start: date, due: '2026-10-17' } })]);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-task-card'));
    row.click();
    expect(h.callbacks.onTaskClick).toHaveBeenCalledWith(tasks[0]);
    expectDefined(row.querySelector<HTMLElement>('[role="checkbox"]')).click();
    expect(h.cards.toggleTask).not.toHaveBeenCalled();
    expectDefined(
      h.container.querySelector<HTMLButtonElement>('button[data-calendar-date="2026-10-17"]'),
    ).click();
    expectDefined(
      h.container.querySelector<HTMLElement>('.abyss-calendar-agenda [role="checkbox"]'),
    ).click();
    expect(h.cards.toggleTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: tasks[0]?.title }),
      { kind: 'allowed' },
    );
  });

  it('opens a forecast through its source and exact reference date, without completion', () => {
    const root = task({ recurrence: 'every day', planning: { due: '2026-10-15' } });
    const tasks = project([root], true);
    const h = mount(tasks);
    const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-task-card'));
    row.click();
    expect(h.callbacks.onForecastClick).toHaveBeenCalledOnce();
    expect(h.callbacks.onForecastClick).toHaveBeenCalledWith(
      { root, node: root, target: { type: 'task', ref: root.ref } },
      date,
    );
    expect(row.querySelector('.abyss-status-marker')).toBeNull();
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
  });
});

it('uses actual focus without promoting checkbox focus into retained inspector selection', () => {
  const source = task({ title: 'Span', planning: { start: date, due: '2026-10-17' } });
  const h = mount(project([source]));
  h.cards.state.set('taskStack', [source]);
  h.cards.panel['el'] = h.container;
  const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-task-card'));
  expectDefined(row.querySelector<HTMLElement>('[role="checkbox"]')).focus();
  h.cards.panel['updateTaskStackSelection_abyssPrivate']();
  expect(row.classList.contains('is-selected')).toBe(false);
  const outside = document.body.createEl('button');
  outside.focus();
  h.view.selectDate(localDate('2026-10-17'));
  h.cards.panel['updateTaskStackSelection_abyssPrivate']();
  expect(h.container.querySelector('.is-selected')).toBeNull();
  expect(h.cards.state.get('taskStack')).toEqual([source]);
  expect(h.callbacks.onTaskSelect).not.toHaveBeenCalled();
  expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
  row.click();
  expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
});

it('suppresses scroll compatibility clicks and composing keyboard events on canonical rows', () => {
  const h = mount(project([task({ planning: { due: date } })]));
  const row = expectDefined(h.container.querySelector<HTMLElement>('.abyss-task-card'));
  row.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
  row.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 40, bubbles: true }));
  row.dispatchEvent(new Event('pointerup', { bubbles: true }));
  row.click();
  row.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
  );
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
  expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
  row.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
  row.click();
  expect(h.callbacks.onTaskClick).toHaveBeenCalledOnce();
});

it('disposes already mounted rows when a later entry fails to render', () => {
  const h = mount([]);
  const original = h.callbacks.mountAgendaEntry;
  let retired: HTMLElement | undefined;
  vi.spyOn(h.callbacks, 'mountAgendaEntry')
    .mockImplementationOnce((...args) => {
      const mount = original(...args);
      retired = mount.element;
      return mount;
    })
    .mockImplementationOnce(() => {
      throw new Error('Render failed');
    });
  expect(() => {
    h.view.patch(
      h.container,
      project([
        task({ title: 'First', planning: { due: date } }),
        task({ title: 'Second', source: { line: 3 }, planning: { due: date } }),
      ]),
      config,
    );
  }).toThrow('Render failed');
  expect(retired?.isConnected).toBe(false);
  retired?.click();
  expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
});
