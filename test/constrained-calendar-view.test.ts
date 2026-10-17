import { MarkdownRenderer, type App } from 'obsidian';
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
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  task,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import { calendarAgendaHarness } from './support/calendarAgendaHarness';

useRealMoment();
const views: ConstrainedCalendarView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => {
    view.destroy();
  });
  document.body.empty();
  vi.restoreAllMocks();
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

/** Models native clamping while the real renderer commits asynchronously prepared rich text. */
function pendingAgendaRefresh(count = 1) {
  const h = mount(project([task({ title: 'Original', planning: { due: date } })]));
  const originalList = expectDefined(
    h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list'),
  );
  originalList.scrollTop = 480;
  const renders: Array<ReturnType<typeof deferred<Error | undefined>>> = [];
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _text, container) => {
    const pending = deferred<Error | undefined>();
    renders.push(pending);
    const failure = await pending.promise;
    if (failure !== undefined) throw failure;
    container.createEl('strong', { text: 'Settled title' });
  });
  const originalMount = h.callbacks.mountAgendaEntry;
  const mounts: Array<ReturnType<typeof originalMount>> = [];
  vi.spyOn(h.callbacks, 'mountAgendaEntry').mockImplementation((...args) => {
    const list = args[0];
    if (Object.getOwnPropertyDescriptor(list, 'scrollTop') === undefined) {
      let offset = 0;
      const limit = () => (list.querySelector('strong') === null ? 300 : 600);
      Object.defineProperty(list, 'scrollTop', {
        get: () => (offset = Math.min(offset, limit())),
        set: (requested: number) => {
          offset = Math.min(requested, limit());
        },
      });
    }
    const card = originalMount(...args);
    mounts.push(card);
    return card;
  });
  const tasks = project(
    Array.from({ length: count }, (_, line) =>
      task({ title: '**Rich title**', source: { line }, planning: { due: date } }),
    ),
  );
  h.view.patch(h.container, tasks, config);
  const list = expectDefined(h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list'));
  return { ...h, tasks, list, renders, mounts };
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

  it('preserves same-day scroll before card removal clamps the old scroll range', () => {
    const tasks = project(
      Array.from({ length: 20 }, (_, line) =>
        task({ source: { line }, title: `Title ${line}`, planning: { due: date } }),
      ),
    );
    const h = mount(tasks);
    const list = expectDefined(
      h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list'),
    );
    const retired = Array.from(list.querySelectorAll('.abyss-task-card'));
    // jsdom has no layout: model a 200px viewport with 40px cards, whose removal
    // clamps the scroll range. Keep the actual card mounts and their disposal.
    Object.defineProperty(list, 'scrollTop', {
      get: () =>
        Math.min(480, Math.max(0, list.querySelectorAll('.abyss-task-card').length * 40 - 200)),
    });
    h.view.patch(h.container, tasks, config);
    const rebuilt = expectDefined(
      h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list'),
    );
    expect(rebuilt.scrollTop).toBe(480);
    expect(retired.every((row) => !row.isConnected)).toBe(true);
    h.view.selectDate(localDate('2026-10-17'));
    expect(h.container.querySelector('.abyss-calendar-agenda-list')?.scrollTop).toBe(0);
  });

  it('restores a same-day offset after rich text expands the initially clamped list', async () => {
    const h = pendingAgendaRefresh();
    expect(h.list.scrollTop).toBe(300);
    // The native event for the initial programmatic restore does not revoke ownership.
    h.list.dispatchEvent(new Event('scroll'));
    expectDefined(h.renders[0]).resolve(undefined);
    await flushMicrotasks();
    expect(h.list.querySelector('strong')?.textContent).toBe('Settled title');
    expect(h.list.scrollTop).toBe(480);
    expect(document.activeElement).toBe(document.body);
  });

  it('waits for every current card before restoring the full scroll range', async () => {
    const h = pendingAgendaRefresh(2);
    expectDefined(h.renders[0]).resolve(undefined);
    await flushMicrotasks();
    expect(h.list.querySelector('strong')).not.toBeNull();
    expect(h.list.scrollTop).toBe(300);
    expectDefined(h.renders[1]).resolve(undefined);
    await flushMicrotasks();
    expect(h.list.scrollTop).toBe(480);
  });

  it('carries a user scroll into another same-day replacement while rendering is pending', async () => {
    const h = pendingAgendaRefresh();
    h.list.scrollTop = 120;
    h.list.dispatchEvent(new Event('scroll'));
    h.view.patch(h.container, h.tasks, config);
    const current = expectDefined(
      h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list'),
    );
    expect(current.scrollTop).toBe(120);
    expectDefined(h.renders[1]).resolve(undefined);
    expectDefined(h.renders[0]).resolve(undefined);
    await flushMicrotasks();
    expect(current.scrollTop).toBe(120);
  });

  it.each([true, false])(
    'keeps a user scroll while rich text is pending (event=%s)',
    async (event) => {
      const h = pendingAgendaRefresh();
      h.list.scrollTop = 120;
      if (event) {
        h.list.dispatchEvent(new Event('scroll'));
        // Moving back must not restore the old pending target either.
        h.list.scrollTop = 300;
        h.list.dispatchEvent(new Event('scroll'));
      }
      expectDefined(h.renders[0]).resolve(undefined);
      await flushMicrotasks();
      expect(h.list.scrollTop).toBe(event ? 300 : 120);
    },
  );

  it.each([
    ['date', 0],
    ['dispose', 300],
    ['render', 0],
    ['replacement', 480],
  ] as const)('rejects pending scroll restoration after %s', async (change, expectedScroll) => {
    const h = pendingAgendaRefresh();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (change === 'date') h.view.selectDate(localDate('2026-10-17'));
    else if (change === 'dispose') h.view.destroy();
    else if (change === 'render') h.view.render(h.container, h.tasks, config);
    else h.view.patch(h.container, h.tasks, config);
    const current = h.container.querySelector<HTMLElement>('.abyss-calendar-agenda-list');
    if (change === 'replacement') {
      expectDefined(h.renders[1]).resolve(undefined);
      await flushMicrotasks();
      expect(current?.scrollTop).toBe(480);
    }
    expectDefined(h.renders[0]).resolve(undefined);
    if (change === 'render') expectDefined(h.renders[1]).resolve(undefined);
    await flushMicrotasks();
    expect(h.list.scrollTop).toBe(300);
    expect(current?.scrollTop).toBe(expectedScroll);
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not restore after a failed card and keeps its existing single failure report', async () => {
    const h = pendingAgendaRefresh(2);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expectDefined(h.renders[0]).resolve(undefined);
    await flushMicrotasks();
    const failure = new Error('Markdown failed');
    expectDefined(h.renders[1]).resolve(failure);
    await flushMicrotasks();
    expect(h.list.scrollTop).toBe(300);
    expect(errors).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not render task list', {
      kind: 'Error',
    });
  });

  it('does not restore if a current card is cancelled while another card is ready', async () => {
    const h = pendingAgendaRefresh(2);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expectDefined(h.renders[0]).resolve(undefined);
    await flushMicrotasks();
    expectDefined(h.mounts[1]).destroy();
    await flushMicrotasks();
    expect(h.list.querySelector('strong')).not.toBeNull();
    expect(h.list.scrollTop).toBe(300);
    expectDefined(h.renders[1]).resolve(undefined);
    await flushMicrotasks();
    expect(h.list.scrollTop).toBe(300);
    expect(errors).not.toHaveBeenCalled();
  });

  it('ignores a late failed render after disposal without adding errors', async () => {
    const h = pendingAgendaRefresh();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.view.destroy();
    expectDefined(h.renders[0]).resolve(new Error('Obsolete Markdown failed'));
    await flushMicrotasks();
    expect(h.list.scrollTop).toBe(300);
    expect(errors).not.toHaveBeenCalled();
  });

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
