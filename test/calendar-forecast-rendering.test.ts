import moment from 'moment';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate, type TaskApplicationApi, type TaskSnapshot } from '../src/tasks';
import { CalendarRenderer } from '../src/ui/CalendarRenderer';
import { MonthGridView } from '../src/views/MonthGridView';
import { MonthView } from '../src/views/MonthView';
import { TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { WeekView } from '../src/views/WeekView';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarOccurrence,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import {
  createAppWithFiles,
  freshContainer,
  queryApiForTasks,
  resolvedConfig,
  subtask,
  task,
  useRealMoment,
  type TaskFixtureInput,
} from './helpers';

useRealMoment();

const fakeApp = {} as App;
const registry = new StatusRegistry(buildDefaultTaskStatuses());

interface ForecastFixture {
  readonly occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>;
  readonly task: TaskSnapshot;
}

function rootSource(options: {
  readonly title: string;
  readonly planning: TaskFixtureInput['planning'];
  readonly recurrence: string;
  readonly line?: number;
}): CalendarTaskSource {
  const root = task({
    title: options.title,
    markdownTitle: options.title,
    recurrence: options.recurrence,
    planning: options.planning,
    source: { filePath: 'Recurring.md', line: options.line ?? 0 },
  });
  return { root, node: root, target: { type: 'task', ref: root.ref } };
}

function nestedSource(): CalendarTaskSource {
  const root = task({
    title: 'Parent',
    source: { filePath: 'Nested.md', line: 4 },
  });
  const node = subtask({
    title: 'Nested forecast',
    recurrence: 'every day',
    planning: { due: '2026-08-08' },
    ref: {
      parent: { type: 'task', ref: root.ref },
      relativeLine: 2,
      originalBlock: '  - [ ] Nested forecast 🔁 every day 📅 2026-08-08',
    },
  });
  const rooted = task({ ...root, subtasks: [node] });
  return {
    root: rooted,
    node,
    target: { type: 'subtask', ref: node.ref },
  };
}

function forecasts(
  source: CalendarTaskSource,
  from: string,
  to: string,
): readonly ForecastFixture[] {
  const projection = projectCalendarOccurrences(
    { materialized: [], recurringSources: [source] },
    { from: localDate(from), to: localDate(to) },
    { removeScheduledDate: false },
  );
  return projection.occurrences.map((occurrence) => {
    if (occurrence.kind !== 'forecast') throw new Error('Expected a forecast occurrence');
    return { occurrence, task: taskSnapshotForCalendarOccurrence(occurrence) };
  });
}

function materialized(source: CalendarTaskSource): {
  readonly occurrence: Extract<CalendarOccurrence, { readonly kind: 'materialized' }>;
  readonly task: TaskSnapshot;
} {
  const date = source.node.planning.due ?? source.node.planning.scheduled;
  if (!date) throw new Error('Expected a materialized date');
  const projection = projectCalendarOccurrences(
    { materialized: [source], recurringSources: [] },
    { from: date, to: date },
    { removeScheduledDate: false },
  );
  const occurrence = projection.occurrences[0];
  if (occurrence?.kind !== 'materialized') throw new Error('Expected a materialized occurrence');
  return { occurrence, task: taskSnapshotForCalendarOccurrence(occurrence) };
}

function forecastCallbacks() {
  return {
    onForecastClick: vi.fn(),
    onForecastContextMenu: vi.fn(),
  };
}

function timeGridCallbacks() {
  return {
    app: fakeApp,
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onDropTime: vi.fn(),
    onCreateAtTime: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onStartChange: vi.fn(),
    onDueChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    statusRegistry: registry,
    ...forecastCallbacks(),
  };
}

function monthCallbacks() {
  return {
    app: fakeApp,
    onDayClick: vi.fn(),
    onCreateAtDate: vi.fn(),
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    onWeekClick: vi.fn(),
    statusRegistry: registry,
    ...forecastCallbacks(),
  };
}

function legacyCallbacks() {
  return {
    app: fakeApp,
    onToggle: vi.fn(),
    onCellClick: vi.fn(),
    onWeekClick: vi.fn(),
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onOpenNote: vi.fn(),
    onContextMenu: vi.fn(),
    statusRegistry: registry,
    ...forecastCallbacks(),
  };
}

function expectAxes(
  element: HTMLElement,
  state: 'materialized' | 'forecast',
  continuity: 'single' | 'continuation' | 'terminal',
  recurring: 'true' | 'false',
): void {
  expect(element.getAttribute('data-occurrence-state')).toBe(state);
  expect(element.getAttribute('data-continuity')).toBe(continuity);
  expect(element.getAttribute('data-recurring')).toBe(recurring);
}

function expectForecastInert(element: HTMLElement): void {
  expect(element.querySelector('.tc-status-marker')).toBeNull();
  expect(element.querySelector('[data-resize-edge]')).toBeNull();
  expect(element.getAttribute('draggable')).toBeNull();
  expect(element.getAttribute('tabindex')).toBeNull();
}

afterEach(() => {
  activeDocument
    .querySelectorAll('.tc-forecast-context-menu')
    .forEach((element) => element.remove());
});

describe('forecast rendering contract', () => {
  it('renders independent timed Day forecasts with repeated title/badge and orthogonal DOM axes', () => {
    const source = rootSource({
      title: 'Daily standup',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-07'), time: '09:00', duration: 30 as never },
    });
    const [first, second] = forecasts(source, '2026-08-08', '2026-08-09');
    const firstContainer = freshContainer();
    const secondContainer = freshContainer();

    new TodayView(timeGridCallbacks()).render(
      firstContainer,
      [first!.task],
      resolvedConfig({ startPosition: '2026-08-08' }),
      false,
    );
    new TodayView(timeGridCallbacks()).render(
      secondContainer,
      [second!.task],
      resolvedConfig({ startPosition: '2026-08-09' }),
      false,
    );

    for (const [container, fixture] of [
      [firstContainer, first!],
      [secondContainer, second!],
    ] as const) {
      const block = container.querySelector<HTMLElement>('.tc-tg-block')!;
      expect(block.textContent).toContain('Daily standup');
      expect(block.querySelector('[data-recurrence-forecast="true"]')).not.toBeNull();
      expectAxes(block, 'forecast', 'single', 'true');
      expect(block.getAttribute('data-occurrence-key')).toBe(fixture.occurrence.key);
      expectForecastInert(block);
    }
  });

  it('renders forecast rows in legacy Week and Month without materialized controls', () => {
    const source = rootSource({
      title: 'Legacy forecast',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-02') },
    });
    const weekForecasts = forecasts(source, '2026-08-03', '2026-08-09');
    const week = freshContainer();
    const month = freshContainer();

    new WeekView(legacyCallbacks()).render(
      week,
      weekForecasts.map(({ task: snapshot }) => snapshot),
      resolvedConfig({ startPosition: '2026-08-03', firstDayOfWeek: 1 }),
    );
    new MonthView(legacyCallbacks()).render(
      month,
      weekForecasts.map(({ task: snapshot }) => snapshot),
      resolvedConfig({ startPosition: '2026-08' }),
    );

    for (const root of [week, month]) {
      const cards = Array.from(root.querySelectorAll<HTMLElement>('.task'));
      expect(cards).toHaveLength(7);
      for (const card of cards) {
        expect(card.textContent).toContain('Legacy forecast');
        expect(card.querySelector('[data-recurrence-forecast="true"]')).not.toBeNull();
        expectAxes(card, 'forecast', 'single', 'true');
        expectForecastInert(card);
      }
    }
  });

  it('reports legacy multi-day forecast start and middle cards as continuations and the due card as terminal', () => {
    const source = rootSource({
      title: 'Legacy forecast range',
      recurrence: 'every week',
      planning: {
        start: localDate('2026-07-31'),
        due: localDate('2026-08-02'),
      },
    });
    const [forecast] = forecasts(source, '2026-08-07', '2026-08-09');
    expect(forecast!.task.planning).toEqual({
      start: localDate('2026-08-07'),
      due: localDate('2026-08-09'),
    });
    const week = freshContainer();
    const month = freshContainer();

    new WeekView(legacyCallbacks()).render(
      week,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08-03', firstDayOfWeek: 1 }),
    );
    new MonthView(legacyCallbacks()).render(
      month,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08', firstDayOfWeek: 1 }),
    );

    for (const root of [week, month]) {
      const start = root.querySelector<HTMLElement>(
        '.task.start[data-occurrence-state="forecast"]',
      );
      const continuations = Array.from(
        root.querySelectorAll<HTMLElement>('.task.process[data-occurrence-state="forecast"]'),
      );
      const terminal = root.querySelector<HTMLElement>(
        '.task.recurrence[data-occurrence-state="forecast"]',
      );

      expect(start?.getAttribute('data-continuity')).toBe('continuation');
      expect(continuations.length).toBeGreaterThan(0);
      expect(continuations.every((card) => card.dataset['continuity'] === 'continuation')).toBe(
        true,
      );
      expect(terminal?.getAttribute('data-continuity')).toBe('terminal');
      for (const card of [start!, ...continuations, terminal!]) {
        expect(card.getAttribute('data-occurrence-key')).toBe(forecast!.occurrence.key);
        expectForecastInert(card);
      }
    }
  });

  it('keeps multi-day forecast continuity and occurrence segment identity in modern Week and Month', () => {
    const source = rootSource({
      title: 'Forecast range',
      recurrence: 'every week',
      planning: {
        start: localDate('2026-08-03'),
        due: localDate('2026-08-05'),
      },
    });
    const [forecast] = forecasts(source, '2026-08-10', '2026-08-16');
    const week = freshContainer();
    const month = freshContainer();

    new WeekTimeGridView(timeGridCallbacks()).render(
      week,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );
    new MonthGridView(monthCallbacks()).render(
      month,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08' }),
    );

    for (const root of [week, month]) {
      const pieces = Array.from(
        root.querySelectorAll<HTMLElement>(
          '.tc-mg-span-segment, .tc-span-piece.tc-tg-span, .tc-span-piece.tc-tg-span-continuation',
        ),
      );
      expect(pieces).toHaveLength(3);
      expect(pieces.map((piece) => piece.getAttribute('data-continuity'))).toEqual([
        'continuation',
        'continuation',
        'terminal',
      ]);
      expect(pieces.map((piece) => piece.getAttribute('data-span-role'))).toEqual([
        'span-continuation:2026-08-10',
        'span-continuation:2026-08-11',
        'span-terminal:2026-08-12',
      ]);
      expect(new Set(pieces.map((piece) => piece.getAttribute('data-segment-identity'))).size).toBe(
        3,
      );
      for (const piece of pieces) {
        expectAxes(
          piece,
          'forecast',
          piece.classList.contains('tc-tg-span-continuation') ? 'continuation' : 'terminal',
          'true',
        );
        expect(piece.getAttribute('data-occurrence-key')).toBe(forecast!.occurrence.key);
        expect(piece.getAttribute('data-segment-identity')).toBe(
          `${forecast!.occurrence.key}:${piece.getAttribute('data-span-role')}`,
        );
        expectForecastInert(piece);
      }
    }
  });

  it('gives each modern timed forecast segment a stable day-local role under one occurrence key', () => {
    const source = rootSource({
      title: 'Timed forecast range',
      recurrence: 'every week',
      planning: {
        start: localDate('2026-08-03'),
        due: localDate('2026-08-05'),
        time: '09:00',
        duration: 60,
      },
    });
    const [forecast] = forecasts(source, '2026-08-10', '2026-08-16');
    const container = freshContainer();

    new WeekTimeGridView(timeGridCallbacks()).render(
      container,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );

    const blocks = Array.from(
      container.querySelectorAll<HTMLElement>('.tc-tg-block[data-occurrence-state="forecast"]'),
    ).sort((left, right) =>
      left.dataset['tgSegmentDate']!.localeCompare(right.dataset['tgSegmentDate']!),
    );
    expect(blocks.map((block) => block.dataset['tgSegmentDate'])).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
    ]);
    expect(blocks.map((block) => block.dataset['continuity'])).toEqual([
      'continuation',
      'continuation',
      'terminal',
    ]);
    expect(blocks.map((block) => block.dataset['spanRole'])).toEqual([
      'timed-continuation:2026-08-10',
      'timed-continuation:2026-08-11',
      'timed-terminal:2026-08-12',
    ]);
    expect(new Set(blocks.map((block) => block.dataset['segmentIdentity'])).size).toBe(3);
    for (const block of blocks) {
      expect(block.dataset['occurrenceKey']).toBe(forecast!.occurrence.key);
      expect(block.dataset['segmentIdentity']).toBe(
        `${forecast!.occurrence.key}:${block.dataset['spanRole']}`,
      );
      expectForecastInert(block);
    }
  });

  it('shares occurrence identity between a scheduled forecast body and its due deadline', () => {
    const source = rootSource({
      title: 'Scheduled forecast',
      recurrence: 'every week',
      planning: {
        scheduled: localDate('2026-08-03'),
        due: localDate('2026-08-05'),
      },
    });
    const [forecast] = forecasts(source, '2026-08-10', '2026-08-16');
    const container = freshContainer();

    new WeekTimeGridView(timeGridCallbacks()).render(
      container,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );

    const body = container.querySelector<HTMLElement>('[data-tg-date="2026-08-10"] .tc-tg-plain')!;
    const deadline = container.querySelector<HTMLElement>(
      '[data-tg-date="2026-08-12"] .tc-tg-deadline-marker',
    )!;
    expect(body.getAttribute('data-occurrence-key')).toBe(forecast!.occurrence.key);
    expect(deadline.getAttribute('data-occurrence-key')).toBe(forecast!.occurrence.key);
    expect(body.getAttribute('data-span-role')).toBe('scheduled-body');
    expect(deadline.getAttribute('data-span-role')).toBe('due-deadline');
    expect(body.getAttribute('data-segment-identity')).toBe(
      `${forecast!.occurrence.key}:scheduled-body`,
    );
    expect(deadline.getAttribute('data-segment-identity')).toBe(
      `${forecast!.occurrence.key}:due-deadline`,
    );
  });
});

describe('forecast interaction contract', () => {
  it('skips forecasts during timed Tab navigation and never emits forecast arrow intents', () => {
    const first = materialized(
      rootSource({
        title: 'First materialized',
        recurrence: 'every week',
        planning: { due: localDate('2026-08-08'), time: '08:00' },
        line: 1,
      }),
    );
    const forecast = forecasts(
      rootSource({
        title: 'Forecast between',
        recurrence: 'every day',
        planning: { due: localDate('2026-08-07'), time: '09:00' },
        line: 2,
      }),
      '2026-08-08',
      '2026-08-08',
    )[0]!;
    const last = materialized(
      rootSource({
        title: 'Last materialized',
        recurrence: 'every week',
        planning: { due: localDate('2026-08-08'), time: '10:00' },
        line: 3,
      }),
    );
    const callbacks = timeGridCallbacks();
    const container = freshContainer();
    activeDocument.body.appendChild(container);

    new TodayView(callbacks).render(
      container,
      [first.task, forecast.task, last.task],
      resolvedConfig({ startPosition: '2026-08-08' }),
      false,
    );

    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
    expect(blocks).toHaveLength(3);
    blocks[0]!.focus();
    blocks[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(activeDocument.activeElement).toBe(blocks[2]);
    blocks[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(callbacks.onKeyboardIntent).not.toHaveBeenCalledWith(forecast.task, expect.anything());
    container.remove();
  });

  it('ordinary forecast click opens the source root with the literal forecast-date context', () => {
    const source = nestedSource();
    const [forecast] = forecasts(source, '2026-08-09', '2026-08-09');
    const callbacks = timeGridCallbacks();
    const opened = vi.fn();
    callbacks.onForecastClick.mockImplementation((clickedSource, referenceDate) => {
      opened(clickedSource.root, `Forecast for ${referenceDate}`);
    });
    const container = freshContainer();

    new TodayView(callbacks).render(
      container,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08-09' }),
      false,
    );
    container.querySelector<HTMLElement>('.tc-tg-plain')!.click();

    expect(opened).toHaveBeenCalledWith(source.root, 'Forecast for 2026-08-09');
    expect(callbacks.onTaskClick).not.toHaveBeenCalled();
  });

  it('forecast right-click exposes only Edit repeat… and Open source task actions', () => {
    const source = nestedSource();
    const [forecast] = forecasts(source, '2026-08-09', '2026-08-09');
    const callbacks = monthCallbacks();
    const container = freshContainer();

    new MonthGridView(callbacks).render(
      container,
      [forecast!.task],
      resolvedConfig({ startPosition: '2026-08' }),
    );
    container
      .querySelector<HTMLElement>('[data-mg-date="2026-08-09"] .tc-mg-plain')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menu = activeDocument.querySelector<HTMLElement>('.tc-forecast-context-menu')!;
    const items = Array.from(menu.querySelectorAll<HTMLElement>('button'));
    expect(items.map((item) => item.textContent)).toEqual(['Edit repeat…', 'Open source task']);
    expect(menu.querySelector('.tc-status-marker')).toBeNull();

    items[0]!.click();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledWith(source, localDate('2026-08-09'));
    expect(callbacks.onForecastContextMenu.mock.calls[0]?.[0].target).toEqual(source.target);

    container
      .querySelector<HTMLElement>('[data-mg-date="2026-08-09"] .tc-mg-plain')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activeDocument.querySelectorAll<HTMLElement>('.tc-forecast-context-menu button')[1]!.click();
    expect(callbacks.onForecastClick).toHaveBeenCalledWith(source, localDate('2026-08-09'));
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onSetStatus).not.toHaveBeenCalled();
    expect(callbacks.onSetPriority).not.toHaveBeenCalled();
  });

  it.each(['month', 'week'] as const)(
    'opens a legacy %s forecast source modal with the visible literal date context',
    async (defaultView) => {
      const app = await createAppWithFiles({
        'Recurring.md': '- [ ] Daily source 🔁 every day 📅 2026-08-01',
      });
      const sourceRoot = task({
        title: 'Daily source',
        recurrence: 'every day',
        planning: { due: '2026-08-01' },
        source: { filePath: 'Recurring.md', line: 0 },
      });
      const queries = queryApiForTasks(() => [sourceRoot]);
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'invalid',
        issues: [{ code: 'invalid-target' }],
      });
      const root = freshContainer();
      const renderer = new CalendarRenderer(
        root,
        resolvedConfig({
          defaultView,
          startPosition: defaultView === 'month' ? '2026-08' : '2026-07-27',
          firstDayOfWeek: 1,
        }),
        app,
        queries,
        { queries, execute },
        registry,
      );
      renderer.mount();
      const forecast = root.querySelector<HTMLElement>(
        '.task[data-occurrence-state="forecast"][data-due="2026-08-02"]',
      )!;

      forecast.click();
      const sourceModal = activeDocument.querySelector<HTMLElement>('.tc-modal');
      expect(sourceModal?.textContent).toContain('Daily source');
      expect(sourceModal?.querySelector('.tc-forecast-source-context')?.textContent).toBe(
        'Forecast for 2026-08-02',
      );

      forecast.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      activeDocument.querySelector<HTMLElement>('.tc-forecast-context-menu-edit-repeat')!.click();
      expect(activeDocument.querySelector<HTMLInputElement>('.tc-recurrence-raw')?.value).toBe(
        'every day',
      );

      renderer.destroy();
      activeDocument.querySelector<HTMLElement>('.tc-modal-close-btn')?.click();
    },
  );

  it('opens the modern forecast source root with literal date context and edits its repeat owner', () => {
    const sourceRoot = task({
      title: 'Modern daily source',
      recurrence: 'every day',
      planning: { due: '2026-08-08' },
      source: { filePath: 'Modern.md', line: 3 },
    });
    const queries = queryApiForTasks(() => [sourceRoot]);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      fakeApp,
      DEFAULT_SETTINGS,
      queries,
      registry,
      undefined,
      null,
      null,
      { queries, execute },
    );
    const root = freshContainer();
    panel.mount(root);
    const openModal = vi.spyOn(
      (panel as unknown as { taskModal: { open(task: TaskSnapshot): void } }).taskModal,
      'open',
    );
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('2026-08-09');
    state.set('mode', 'calendar');
    const forecast = root.querySelector<HTMLElement>(
      '[data-mg-date="2026-08-09"] .tc-mg-plain[data-occurrence-state="forecast"]',
    )!;

    forecast.click();
    expect(openModal).toHaveBeenCalledWith(sourceRoot);
    expect(activeDocument.querySelector('.tc-forecast-source-context')?.textContent).toBe(
      'Forecast for 2026-08-09',
    );

    forecast.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activeDocument.querySelector<HTMLElement>('.tc-forecast-context-menu-edit-repeat')!.click();
    expect(activeDocument.querySelector<HTMLInputElement>('.tc-recurrence-raw')?.value).toBe(
      'every day',
    );

    panel.destroy();
  });
});
