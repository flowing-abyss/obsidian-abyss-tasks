import moment from 'moment';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  localDate,
  type TaskApplicationApi,
  type TaskIndexEvent,
  type TaskSnapshot,
} from '../src/tasks';
import { CalendarRenderer } from '../src/ui/CalendarRenderer';
import {
  calendarOccurrenceForTask,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarOccurrence,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import { MonthGridView } from '../src/views/MonthGridView';
import { layoutVisibleMonth, layoutVisibleMonthWithReplacement } from '../src/views/monthLayout';
import { MonthView } from '../src/views/MonthView';
import { layoutVisibleSpans, layoutVisibleSpansWithReplacement } from '../src/views/spanLayout';
import { layoutTimedDay, taskLayoutIdentity } from '../src/views/timegrid/layout';
import {
  createForecastContextMenuOwner,
  type ForecastContextMenuOwner,
} from '../src/views/timegrid/renderTaskMeta';
import { toTimedBlockInputs } from '../src/views/timegrid/renderTimedBlocks';
import { previewTimedPositionFor, TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { WeekView } from '../src/views/WeekView';
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
const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
const forecastMenuOwners: ForecastContextMenuOwner[] = [];

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

function declarationsForRuleContaining(...selectors: string[]): string {
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    if (selectors.every((selector) => (match[1] ?? '').includes(selector))) return match[2] ?? '';
  }
  return '';
}

interface StyleRuleLike {
  readonly selectorText: string;
  readonly style: CSSStyleDeclaration;
}

interface WinningDeclaration {
  readonly selector: string;
  readonly value: string;
  readonly specificity: readonly [number, number, number];
  readonly order: number;
}

function calendarStyleRules(style: HTMLStyleElement): readonly StyleRuleLike[] {
  const collected: StyleRuleLike[] = [];
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const candidate = rule as CSSRule & {
        readonly cssRules?: CSSRuleList;
        readonly selectorText?: string;
        readonly style?: CSSStyleDeclaration;
      };
      if (candidate.selectorText !== undefined && candidate.style !== undefined) {
        collected.push({ selectorText: candidate.selectorText, style: candidate.style });
      }
      if (candidate.cssRules !== undefined) visit(candidate.cssRules);
    }
  };
  if (style.sheet) visit(style.sheet.cssRules);
  return collected;
}

function selectorSpecificity(selector: string): readonly [number, number, number] {
  const withoutNot = selector.replace(/:not\(([^)]*)\)/gu, '$1');
  const ids = withoutNot.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = withoutNot.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/gu)?.length ?? 0;
  const types = withoutNot
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+(?:\([^)]*\))?/gu, ' ')
    .split(/[\s>+~]+/u)
    .filter((part) => part !== '' && part !== '*').length;
  return [ids, classes, types];
}

function compareSpecificity(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function winningDeclaration(
  style: HTMLStyleElement,
  element: HTMLElement,
  property: string,
  pseudo: 'none' | 'hover' | 'before' = 'none',
): WinningDeclaration | undefined {
  const matches: Array<WinningDeclaration & { readonly important: boolean }> = [];
  calendarStyleRules(style).forEach((rule, order) => {
    const value = rule.style.getPropertyValue(property).trim();
    if (value === '') return;
    for (const selector of rule.selectorText.split(',').map((part) => part.trim())) {
      const hasHover = selector.includes(':hover');
      const hasBefore = selector.includes('::before');
      if (pseudo === 'none' && (hasHover || hasBefore)) continue;
      if (pseudo === 'hover' && hasBefore) continue;
      if (pseudo === 'before' && !hasBefore) continue;
      const matchable = selector.replace(/:hover/gu, '').replace(/::before/gu, '');
      try {
        if (!element.matches(matchable)) continue;
      } catch {
        continue;
      }
      matches.push({
        selector,
        value,
        specificity: selectorSpecificity(selector),
        order,
        important: rule.style.getPropertyPriority(property) === 'important',
      });
    }
  });
  const winner = matches.sort(
    (left, right) =>
      Number(left.important) - Number(right.important) ||
      compareSpecificity(left.specificity, right.specificity) ||
      left.order - right.order,
  )[matches.length - 1];
  if (!winner) return undefined;
  return {
    selector: winner.selector,
    value: winner.value,
    specificity: winner.specificity,
    order: winner.order,
  };
}

function installCalendarStyles(): HTMLStyleElement {
  const style = activeDocument.createElement('style');
  style.dataset['tcCalendarContract'] = 'true';
  style.textContent = css;
  activeDocument.head.appendChild(style);
  return style;
}

interface ForecastFixture {
  readonly occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>;
  readonly task: TaskSnapshot;
}

function rootSource(options: {
  readonly title: string;
  readonly planning: TaskFixtureInput['planning'];
  readonly recurrence?: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly presentation?: TaskFixtureInput['presentation'];
}): CalendarTaskSource {
  const root = task({
    title: options.title,
    markdownTitle: options.title,
    recurrence: options.recurrence,
    planning: options.planning,
    source: { filePath: options.filePath ?? 'Recurring.md', line: options.line ?? 0 },
    presentation: options.presentation,
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

function nestedMaterializedPair(
  planning: TaskFixtureInput['planning'],
): readonly [ReturnType<typeof materialized>, ReturnType<typeof materialized>] {
  const root = task({
    title: 'Shared projected root',
    source: { filePath: 'Shared.md', line: 7 },
  });
  const first = subtask({
    title: 'First projected child',
    recurrence: 'every week',
    planning,
    ref: {
      parent: { type: 'task', ref: root.ref },
      relativeLine: 1,
      originalBlock: '  - [ ] First projected child',
    },
  });
  const second = subtask({
    title: 'Second projected child',
    recurrence: 'every week',
    planning,
    ref: {
      parent: { type: 'task', ref: root.ref },
      relativeLine: 2,
      originalBlock: '  - [ ] Second projected child',
    },
  });
  const rooted = task({ ...root, subtasks: [first, second] });
  const source = (node: typeof first): CalendarTaskSource => ({
    root: rooted,
    node,
    target: { type: 'subtask', ref: node.ref },
  });
  return [materialized(source(first)), materialized(source(second))];
}

function forecastCallbacks() {
  const forecastMenuOwner = createForecastContextMenuOwner(activeDocument);
  forecastMenuOwners.push(forecastMenuOwner);
  return {
    forecastMenuOwner,
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

interface LegacyVisualFixture {
  readonly root: HTMLElement;
  readonly style: HTMLStyleElement;
  readonly ordinary: HTMLElement;
  readonly recurring: HTMLElement;
  readonly forecast: HTMLElement;
}

function renderLegacyVisualFixture(view: 'week' | 'month'): LegacyVisualFixture {
  const visibleDate = localDate('2026-08-05');
  const ordinarySource = rootSource({
    title: 'Legacy ordinary',
    planning: { due: visibleDate },
    filePath: 'Ordinary.md',
    presentation: { noteColor: '#225588' },
  });
  const recurringSource = rootSource({
    title: 'Legacy materialized repeat',
    recurrence: 'every week',
    planning: { due: visibleDate },
    filePath: 'Materialized.md',
    presentation: { noteColor: '#884422' },
  });
  const forecastSource = rootSource({
    title: 'Legacy colored forecast',
    recurrence: 'every week',
    planning: { due: localDate('2026-07-29') },
    filePath: 'Forecast.md',
    presentation: { noteColor: '#336699', noteTextColor: '#f5f5f5' },
  });
  const ordinary = materialized(ordinarySource).task;
  const recurring = materialized(recurringSource).task;
  const forecast = forecasts(forecastSource, visibleDate, visibleDate)[0]!.task;
  const root = freshContainer();
  root.className = 'tasksCalendar';
  root.dataset['tcLegacyVisualFixture'] = 'true';
  root.setAttribute('view', view);
  activeDocument.body.appendChild(root);
  const style = installCalendarStyles();
  const tasks = [forecast, recurring, ordinary];
  if (view === 'week') {
    new WeekView(legacyCallbacks()).render(
      root,
      tasks,
      resolvedConfig({ startPosition: '2026-08-03', firstDayOfWeek: 1 }),
    );
  } else {
    new MonthView(legacyCallbacks()).render(
      root,
      tasks,
      resolvedConfig({ startPosition: '2026-08', firstDayOfWeek: 1 }),
    );
  }
  const card = (title: string): HTMLElement =>
    Array.from(root.querySelectorAll<HTMLElement>('.task')).find(
      (candidate) => candidate.dataset['taskText'] === title,
    )!;
  return {
    root,
    style,
    ordinary: card('Legacy ordinary'),
    recurring: card('Legacy materialized repeat'),
    forecast: card('Legacy colored forecast'),
  };
}

function expectLegacyVisualContract(fixture: LegacyVisualFixture): void {
  const { root, style, ordinary, recurring, forecast } = fixture;
  const host = getComputedStyle(root);
  for (const token of [
    '--tc-calendar-surface',
    '--tc-calendar-surface-forecast',
    '--tc-calendar-border',
    '--tc-calendar-border-forecast',
    '--tc-calendar-foreground',
    '--tc-calendar-now',
    '--tc-calendar-border-width',
  ]) {
    expect(host.getPropertyValue(token).trim(), `${token} on legacy host`).not.toBe('');
  }

  expect(forecast.style.getPropertyValue('--task-color')).toBe('#336699');
  const forecastStyle = getComputedStyle(forecast);
  expect(forecastStyle.getPropertyValue('--tc-tag-color')).toContain('--task-color');
  expect(forecastStyle.getPropertyValue('--tc-calendar-surface-forecast')).toContain('color-mix');
  expect(winningDeclaration(style, forecast, 'border-inline-start')?.value).toContain(
    '--tc-tag-color',
  );

  expect(forecast.dataset['controlSlot']).toBe('reserved');
  expect(forecast.querySelector('.tc-status-marker')).toBeNull();
  expect(forecast.querySelector('input[type="checkbox"]')).toBeNull();
  expect(forecast.querySelectorAll('.tc-recurrence-badge')).toHaveLength(1);
  const forecastInner = forecast.querySelector<HTMLElement>(':scope > .inner')!;
  expect(winningDeclaration(style, forecastInner, 'content', 'before')?.value).toBe('""');

  for (const materialized of [ordinary, recurring]) {
    expect(materialized.dataset['controlSlot']).toBe('occupied');
    expect(materialized.querySelectorAll('.tc-status-marker')).toHaveLength(1);
    const inner = materialized.querySelector<HTMLElement>(':scope > .inner')!;
    expect(winningDeclaration(style, inner, 'content', 'before')).toBeUndefined();
  }
  expect(recurring.querySelectorAll('.tc-recurrence-badge')).toHaveLength(1);

  const forecastBackground = winningDeclaration(style, forecast, 'background');
  expect(forecastBackground).toMatchObject({
    selector: ".tc-calendar-item[data-occurrence-state='forecast']",
    value: 'var(--tc-calendar-surface-forecast)',
    specificity: [0, 2, 0],
  });
  expect(winningDeclaration(style, forecast, 'background', 'hover')).toEqual(forecastBackground);
  expect(winningDeclaration(style, forecast, 'color')?.value).toBe('var(--tc-calendar-foreground)');
  expect(winningDeclaration(style, forecast, 'outline')?.value).toBe(
    'var(--tc-calendar-border-width) dotted var(--tc-calendar-border-forecast)',
  );
  expect(winningDeclaration(style, forecast, 'opacity')).toBeUndefined();
  expect(forecastStyle.opacity).not.toBe('0.8');

  for (const property of ['padding', 'border-radius', 'font-size', 'line-height']) {
    const values = [ordinary, recurring, forecast].map(
      (card) => winningDeclaration(style, card, property)?.value,
    );
    expect(new Set(values).size, `${property} geometry`).toBe(1);
    expect(values[0], `${property} geometry`).toBeTruthy();
  }
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
  forecastMenuOwners.splice(0).forEach((owner) => owner.dismiss({ restoreFocus: false }));
  activeDocument
    .querySelectorAll('.tc-forecast-context-menu')
    .forEach((element) => element.remove());
  activeDocument
    .querySelectorAll('[data-tc-calendar-contract], [data-tc-legacy-visual-fixture]')
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
      expect(block.classList.contains('tc-calendar-item')).toBe(true);
      const head = block.querySelector<HTMLElement>('.tc-calendar-leading-row')!;
      expect(head.dataset['controlSlot']).toBe('reserved');
      expect(head.dataset['recurrenceSlot']).toBe('occupied');
      expect(head.querySelector('.tc-status-marker')).toBeNull();
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
    for (const item of [body, deadline]) {
      expect(item.classList.contains('tc-calendar-leading-row')).toBe(true);
      expect(item.dataset['controlSlot']).toBe('reserved');
      expect(item.dataset['recurrenceSlot']).toBe('occupied');
      expect(item.querySelector('.tc-status-marker')).toBeNull();
    }
  });
});

describe('forecast visual system', () => {
  it('keeps legacy Week forecast cards on the complete shared DOM and winning cascade contract', () => {
    expectLegacyVisualContract(renderLegacyVisualFixture('week'));
  });

  it('keeps legacy Month forecast cards on the complete shared DOM and winning cascade contract', () => {
    expectLegacyVisualContract(renderLegacyVisualFixture('month'));
  });

  it('reserves one control and recurrence slot for ordinary, recurring, and forecast month items', () => {
    const ordinary = task({
      title: 'Ordinary item',
      planning: { due: '2026-08-09' },
      source: { filePath: 'Ordinary.md', line: 1 },
    });
    const recurringMaterialized = materialized(
      rootSource({
        title: 'Materialized repeat',
        recurrence: 'every week',
        planning: { due: '2026-08-09' },
        line: 2,
      }),
    ).task;
    const forecast = forecasts(
      rootSource({
        title: 'Forecast repeat',
        recurrence: 'every day',
        planning: { due: '2026-08-08' },
        line: 3,
      }),
      '2026-08-09',
      '2026-08-09',
    )[0]!.task;
    const container = freshContainer();

    new MonthGridView(monthCallbacks()).render(
      container,
      [forecast, ordinary, recurringMaterialized],
      resolvedConfig({ startPosition: '2026-08' }),
    );

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-mg-date="2026-08-09"] .tc-mg-plain'),
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.classList.contains('tc-calendar-item')).toBe(true);
      expect(item.classList.contains('tc-calendar-leading-row')).toBe(true);
      expect(item.dataset['controlSlot']).toMatch(/^(?:occupied|reserved)$/u);
      expect(item.dataset['recurrenceSlot']).toMatch(/^(?:occupied|reserved)$/u);
    }

    const ordinaryItem = items.find((item) => item.textContent?.includes('Ordinary item'))!;
    const materializedItem = items.find((item) =>
      item.textContent?.includes('Materialized repeat'),
    )!;
    const forecastItem = items.find((item) => item.textContent?.includes('Forecast repeat'))!;
    expect(ordinaryItem.dataset['controlSlot']).toBe('occupied');
    expect(ordinaryItem.dataset['recurrenceSlot']).toBe('reserved');
    expect(ordinaryItem.querySelector('.tc-status-marker')).not.toBeNull();
    expect(ordinaryItem.querySelector('.tc-recurrence-badge')).toBeNull();
    expect(materializedItem.dataset['controlSlot']).toBe('occupied');
    expect(materializedItem.dataset['recurrenceSlot']).toBe('occupied');
    expect(materializedItem.querySelector('.tc-status-marker')).not.toBeNull();
    expect(materializedItem.querySelectorAll('.tc-recurrence-badge')).toHaveLength(1);
    expect(forecastItem.dataset['controlSlot']).toBe('reserved');
    expect(forecastItem.dataset['recurrenceSlot']).toBe('occupied');
    expect(forecastItem.querySelector('.tc-status-marker')).toBeNull();
    expect(forecastItem.querySelectorAll('.tc-recurrence-badge')).toHaveLength(1);
  });

  it('keeps separate month forecasts compact and orders timed occurrences before untimed ones', () => {
    const timed = forecasts(
      rootSource({
        title: '09:00 forecast',
        recurrence: 'every week',
        planning: { due: '2026-08-02', time: '09:00' },
        line: 10,
      }),
      '2026-08-09',
      '2026-08-09',
    )[0]!;
    const untimed = forecasts(
      rootSource({
        title: 'Untimed forecast',
        recurrence: 'every week',
        planning: { due: '2026-08-02' },
        line: 11,
      }),
      '2026-08-09',
      '2026-08-09',
    )[0]!;
    const independent = forecasts(
      rootSource({
        title: 'Independent daily',
        recurrence: 'every day',
        planning: { due: '2026-08-07' },
        line: 12,
      }),
      '2026-08-08',
      '2026-08-10',
    );
    const container = freshContainer();

    new MonthGridView(monthCallbacks()).render(
      container,
      [untimed.task, timed.task, ...independent.map(({ task: forecastTask }) => forecastTask)],
      resolvedConfig({ startPosition: '2026-08' }),
    );

    const augustNinth = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-mg-date="2026-08-09"] .tc-mg-block-dot, [data-mg-date="2026-08-09"] .tc-mg-plain',
      ),
    ).sort((left, right) => Number(left.style.gridRow) - Number(right.style.gridRow));
    expect(augustNinth.slice(0, 2).map((item) => item.textContent)).toEqual([
      expect.stringContaining('09:00 forecast'),
      expect.stringContaining('Untimed forecast'),
    ]);
    const dailyItems = Array.from(
      container.querySelectorAll<HTMLElement>('.tc-mg-plain[data-occurrence-state="forecast"]'),
    ).filter((item) => item.textContent?.includes('Independent daily'));
    expect(dailyItems).toHaveLength(3);
    expect(new Set(dailyItems.map((item) => item.dataset['occurrenceKey'])).size).toBe(3);
    expect(
      container.querySelectorAll('.tc-mg-span-segment[data-occurrence-state="forecast"]'),
    ).toHaveLength(0);
  });

  it('derives forecast surfaces and current time from theme tokens without fading task text', () => {
    const lightTokens = declarationsFor('.tc-panel-view');
    const darkTokens = declarationsFor('.theme-dark .tc-panel-view');
    for (const token of [
      '--tc-calendar-surface',
      '--tc-calendar-surface-forecast',
      '--tc-calendar-border',
      '--tc-calendar-border-forecast',
      '--tc-calendar-foreground',
      '--tc-calendar-now',
    ]) {
      expect(lightTokens).toContain(token);
    }
    expect(darkTokens).toContain('--tc-calendar-forecast-fill-strength');
    const itemTokens = declarationsFor('.tc-calendar-item');
    expect(itemTokens).toMatch(
      /--tc-calendar-surface\s*:\s*color-mix\([\s\S]*var\(--tc-tag-color,\s*var\(--interactive-accent\)\)/u,
    );
    expect(itemTokens).toMatch(
      /--tc-calendar-surface-forecast\s*:\s*color-mix\([\s\S]*--tc-calendar-forecast-fill-strength/u,
    );
    expect(itemTokens).toContain('--tc-calendar-foreground: var(--tc-tag-text-color');

    const forecastAxis = declarationsForRuleContaining(
      ".tc-calendar-item[data-occurrence-state='forecast']",
    );
    expect(forecastAxis).toMatch(/background\s*:\s*var\(--tc-calendar-surface-forecast\)/u);
    expect(forecastAxis).toMatch(
      /outline\s*:\s*var\(--tc-calendar-border-width\) dotted var\(--tc-calendar-border-forecast\)/u,
    );
    expect(forecastAxis).not.toMatch(/opacity\s*:/u);

    const geometry = declarationsForRuleContaining(
      '.tc-tg-block.tc-calendar-item',
      '.tc-tg-body.tc-calendar-item',
      '.tc-mg-plain.tc-calendar-item',
    );
    expect(geometry).toMatch(/border-radius\s*:\s*var\(--tc-calendar-item-radius\)/u);
    expect(geometry).toMatch(/padding\s*:\s*2px var\(--tc-calendar-item-pad-inline\)/u);
    expect(geometry).toMatch(/font-size\s*:\s*var\(--tc-calendar-item-font-size\)/u);
    const materializedSurface = declarationsForRuleContaining(
      '.tc-tg-block',
      '.tc-tg-span-continuation',
      '.tc-mg-plain',
    );
    expect(materializedSurface).toMatch(/background\s*:\s*var\(--tc-calendar-surface\)/u);
    expect(materializedSurface).toMatch(
      /box-shadow\s*:\s*inset 0 0 0 1px var\(--tc-calendar-border\)/u,
    );
    expect(
      declarationsFor(
        ".tc-calendar-leading-row[data-control-slot='reserved'][data-recurrence-slot='reserved']::before",
      ),
    ).toMatch(/flex-basis\s*:\s*calc\(1\.6em \+ 0\.35em \+ 1rem\)/u);

    const nowLine = declarationsFor('.tc-tg-now-line');
    expect(nowLine).toMatch(/left\s*:\s*3\.5em/u);
    expect(nowLine).toMatch(/right\s*:\s*0/u);
    expect(nowLine).toMatch(/background\s*:\s*var\(--tc-calendar-now\)/u);
    expect(nowLine).toMatch(/z-index\s*:\s*0/u);
    expect(nowLine).not.toMatch(/opacity\s*:/u);
    expect(declarationsFor('.tc-tg-now-line-dot')).toMatch(
      /background\s*:\s*var\(--tc-calendar-now\)/u,
    );
  });

  it('renders the projection-limit diagnostic exactly once and politely in the modern calendar', () => {
    const sources = [
      task({
        title: 'Long monthly A',
        recurrence: 'every month',
        planning: { due: '1000-01-31' },
        source: { filePath: 'A.md', line: 0 },
      }),
      task({
        title: 'Long monthly B',
        recurrence: 'every month',
        planning: { due: '1000-01-31' },
        source: { filePath: 'B.md', line: 0 },
      }),
    ];
    const queries = queryApiForTasks(() => sources);
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
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('1400-08-01');
    state.set('mode', 'calendar');

    const diagnostics = root.querySelectorAll<HTMLElement>('.tc-calendar-projection-diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.textContent).toBe('More repeating occurrences are not shown');
    expect(diagnostics[0]?.getAttribute('aria-live')).toBe('polite');

    panel.destroy();
  });

  it('keeps one live-region node and announces only projection issue signature transitions', async () => {
    const limitSource = task({
      title: 'Stable diagnostic source',
      recurrence: 'every month',
      planning: { due: '1000-01-31' },
      source: { filePath: 'Stable.md', line: 0 },
    });
    let sources: TaskSnapshot[] = [limitSource];
    let notify: ((event: TaskIndexEvent) => void) | undefined;
    const queries = queryApiForTasks(
      () => sources,
      (listener) => {
        notify = listener;
        return () => {
          if (notify === listener) notify = undefined;
        };
      },
    );
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
      { queries, execute: vi.fn() },
    );
    const root = freshContainer();
    panel.mount(root);
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('1400-08-01');
    state.set('mode', 'calendar');
    const diagnostic = root.querySelector<HTMLElement>('.tc-calendar-projection-diagnostic')!;
    const announcements: MutationRecord[] = [];
    const observer = new MutationObserver((records) => announcements.push(...records));
    observer.observe(diagnostic, { childList: true, characterData: true, subtree: true });

    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(announcements).toHaveLength(0);

    sources = [];
    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(diagnostic.textContent).toBe('');

    sources = [limitSource];
    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(diagnostic.textContent).toBe('More repeating occurrences are not shown');
    expect(announcements).toHaveLength(2);

    observer.disconnect();
    panel.destroy();
    expect(diagnostic.isConnected).toBe(false);
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBeNull();
  });

  it('keeps the CalendarRenderer live region stable across query patches and tears it down', () => {
    const limitSource = task({
      title: 'Legacy stable diagnostic source',
      recurrence: 'every month',
      planning: { due: '1000-01-31' },
      source: { filePath: 'Legacy-stable.md', line: 0 },
    });
    let sources: TaskSnapshot[] = [limitSource];
    let notify: ((event: TaskIndexEvent) => void) | undefined;
    const queries = queryApiForTasks(
      () => sources,
      (listener) => {
        notify = listener;
        return () => {
          if (notify === listener) notify = undefined;
        };
      },
    );
    const root = freshContainer();
    const renderer = new CalendarRenderer(
      root,
      resolvedConfig({ defaultView: 'month', startPosition: '1400-08' }),
      fakeApp,
      queries,
      { queries, execute: vi.fn() },
      registry,
    );
    renderer.mount();
    const diagnostic = root.querySelector<HTMLElement>('.tc-calendar-projection-diagnostic')!;

    notify?.({ type: 'changed', files: ['Legacy-stable.md'] });
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBe(diagnostic);

    sources = [];
    notify?.({ type: 'changed', files: ['Legacy-stable.md'] });
    expect(root.querySelector('.tc-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(diagnostic.textContent).toBe('');

    renderer.destroy();
    expect(diagnostic.isConnected).toBe(false);
  });
});

describe('projected preview semantic identity', () => {
  const weekDates = [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-08',
    '2026-08-09',
  ];

  it('keeps a timed replacement preview in the same semantic lane as the committed projection', () => {
    const pair = nestedMaterializedPair({
      due: localDate('2026-08-05'),
      time: '09:00',
      duration: 60,
    });
    const tasks = pair.map(({ task: snapshot }) => snapshot);
    const source = pair[0].task;
    const sourceIdentity = pair[0].occurrence.key;
    const committed = layoutTimedDay(toTimedBlockInputs(tasks)).positioned.find(
      ({ task: positionedTask }) =>
        calendarOccurrenceForTask(positionedTask)?.key === sourceIdentity,
    );
    expect(committed).toMatchObject({ column: 0, columns: 2 });

    const preview = previewTimedPositionFor(tasks, source, { ...source.planning }, '2026-08-05');
    expect(preview).toBeDefined();
    expect(calendarOccurrenceForTask(preview!.task)?.key).toBe(sourceIdentity);
    expect(taskLayoutIdentity(preview!.task)).toBe(sourceIdentity);
    expect({ column: preview!.column, columns: preview!.columns }).toEqual({
      column: committed!.column,
      columns: committed!.columns,
    });
  });

  it('keeps Month replacement ordering and slots identical to the committed projection', () => {
    const pair = nestedMaterializedPair({ due: localDate('2026-08-05') });
    const tasks = pair.map(({ task: snapshot }) => snapshot);
    const source = pair[0].task;
    const expected = pair.map(({ occurrence }, slot) => ({ identity: occurrence.key, slot }));
    const entries = (layout: ReturnType<typeof layoutVisibleMonth>) =>
      (layout.rows[0]?.compactByDate.get('2026-08-05') ?? []).map((entry) => ({
        identity: calendarOccurrenceForTask(entry.task)?.key,
        slot: entry.slot,
      }));

    expect(entries(layoutVisibleMonth(tasks, weekDates))).toEqual(expected);
    expect(
      entries(layoutVisibleMonthWithReplacement(tasks, weekDates, source, { ...source.planning })),
    ).toEqual(expected);
  });

  it('keeps span replacement identities and lanes identical to the committed projection', () => {
    const pair = nestedMaterializedPair({
      start: localDate('2026-08-04'),
      due: localDate('2026-08-06'),
    });
    const tasks = pair.map(({ task: snapshot }) => snapshot);
    const source = pair[0].task;
    const expected = pair.map(({ occurrence }, lane) => ({ identity: occurrence.key, lane }));
    const entries = (layout: ReturnType<typeof layoutVisibleSpans>) =>
      (layout.rows[0]?.segments ?? [])
        .filter((segment) => segment.date === '2026-08-05')
        .map((segment) => ({ identity: segment.identity, lane: segment.lane }));

    expect(entries(layoutVisibleSpans(tasks, weekDates))).toEqual(expected);
    expect(
      entries(layoutVisibleSpansWithReplacement(tasks, weekDates, source, { ...source.planning })),
    ).toEqual(expected);
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

  it('owns one dismissible forecast menu and ignores callbacks from superseded handles', () => {
    const firstSource = rootSource({
      title: 'First forecast source',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-08') },
      line: 10,
    });
    const secondSource = rootSource({
      title: 'Second forecast source',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-08') },
      line: 11,
    });
    const first = forecasts(firstSource, '2026-08-09', '2026-08-09')[0]!;
    const second = forecasts(secondSource, '2026-08-09', '2026-08-09')[0]!;
    const callbacks = monthCallbacks();
    const container = freshContainer();
    const trigger = activeDocument.body.createEl('button', { text: 'Calendar trigger' });
    trigger.focus();
    new MonthGridView(callbacks).render(
      container,
      [first.task, second.task],
      resolvedConfig({ startPosition: '2026-08' }),
    );
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-mg-date="2026-08-09"] .tc-mg-plain[data-occurrence-state="forecast"]',
      ),
    );

    items[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const staleEdit = activeDocument.querySelector<HTMLButtonElement>(
      '.tc-forecast-context-menu-edit-repeat',
    )!;
    items[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(activeDocument.querySelectorAll('.tc-forecast-context-menu')).toHaveLength(1);

    staleEdit.click();
    expect(callbacks.onForecastContextMenu).not.toHaveBeenCalled();
    activeDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);

    items[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activeDocument.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);

    items[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    activeDocument.querySelector<HTMLElement>('.tc-forecast-context-menu-edit-repeat')!.click();
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledOnce();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledWith(
      secondSource,
      localDate('2026-08-09'),
    );
    trigger.remove();
  });

  it('CalendarRenderer patches and destroy close its owned forecast menu', () => {
    const sourceRoot = task({
      title: 'Legacy lifecycle source',
      recurrence: 'every day',
      planning: { due: '2026-08-08' },
      source: { filePath: 'Legacy.md', line: 4 },
    });
    let notify: ((event: TaskIndexEvent) => void) | undefined;
    const queries = queryApiForTasks(
      () => [sourceRoot],
      (listener) => {
        notify = listener;
        return () => {
          if (notify === listener) notify = undefined;
        };
      },
    );
    const root = freshContainer();
    const renderer = new CalendarRenderer(
      root,
      resolvedConfig({ defaultView: 'month', startPosition: '2026-08' }),
      fakeApp,
      queries,
      { queries, execute: vi.fn() },
      registry,
    );
    renderer.mount();
    const openMenu = (): void => {
      root
        .querySelector<HTMLElement>(
          '.task[data-occurrence-state="forecast"][data-due="2026-08-09"]',
        )!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    };

    openMenu();
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).not.toBeNull();
    notify?.({ type: 'changed', files: ['Legacy.md'] });
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();

    openMenu();
    renderer.destroy();
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();
  });

  it('CenterPanel patches and destroy close its owned forecast menu', () => {
    const sourceRoot = task({
      title: 'Modern lifecycle source',
      recurrence: 'every day',
      planning: { due: '2026-08-08' },
      source: { filePath: 'Modern.md', line: 5 },
    });
    let notify: ((event: TaskIndexEvent) => void) | undefined;
    const queries = queryApiForTasks(
      () => [sourceRoot],
      (listener) => {
        notify = listener;
        return () => {
          if (notify === listener) notify = undefined;
        };
      },
    );
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
      { queries, execute: vi.fn() },
    );
    const root = freshContainer();
    panel.mount(root);
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('2026-08-09');
    state.set('mode', 'calendar');
    const openMenu = (): void => {
      root
        .querySelector<HTMLElement>(
          '[data-mg-date="2026-08-09"] [data-occurrence-state="forecast"]',
        )!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    };

    openMenu();
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).not.toBeNull();
    notify?.({ type: 'changed', files: ['Modern.md'] });
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();

    openMenu();
    panel.destroy();
    expect(activeDocument.querySelector('.tc-forecast-context-menu')).toBeNull();
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
