import { moment, Platform, type App } from 'obsidian';
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
  type ForecastInteractionCallbacks,
} from '../src/views/timegrid/renderTaskMeta';
import { toTimedBlockInputs } from '../src/views/timegrid/renderTimedBlocks';
import { previewTimedPositionFor, TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { WeekView } from '../src/views/WeekView';
import {
  createAppWithFiles,
  cssRuleParts,
  expectDefined,
  freshContainer,
  methodOf,
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
const css = await loadStyles();
const forecastMenuOwners: ForecastContextMenuOwner[] = [];

async function loadStyles(): Promise<string> {
  if (!Platform.isDesktop) return '';
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  return readFileSync(path.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

function declarationsForRuleContaining(...selectors: string[]): string {
  for (const rule of cssRuleParts(css)) {
    if (selectors.every((selector) => rule.selector.includes(selector))) return rule.declarations;
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
  if (style.sheet != null) visit(style.sheet.cssRules);
  return collected;
}

function selectorSpecificity(selector: string): readonly [number, number, number] {
  const count = (character: string): number => selector.split(character).length - 1;
  const ids = count('#');
  const pseudoClasses = count(':') - count('::') * 2 - count(':not(');
  const classes = count('.') + count('[') + pseudoClasses;
  const types = selector.split(/[\s>+~]+/u).filter((part) => /^[a-z][\w-]*/iu.test(part)).length;
  return [ids, classes, types];
}

function compareSpecificity(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return firstNonZero(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function firstNonZero(...values: readonly number[]): number {
  return values.find((value) => value !== 0) ?? 0;
}

function selectorTargetsPseudo(selector: string, pseudo: 'none' | 'hover' | 'before'): boolean {
  const hasHover = selector.includes(':hover');
  const hasBefore = selector.includes('::before');
  if (pseudo === 'none') return !hasHover && !hasBefore;
  if (pseudo === 'hover') return !hasBefore;
  return hasBefore;
}

function elementMatchesSelector(element: HTMLElement, selector: string): boolean {
  const matchable = selector.replace(/:hover/gu, '').replace(/::before/gu, '');
  try {
    return element.matches(matchable);
  } catch {
    return false;
  }
}

function winningDeclaration(
  style: HTMLStyleElement,
  element: HTMLElement,
  property: string,
  pseudo: 'none' | 'hover' | 'before' = 'none',
): WinningDeclaration | undefined {
  const matches: Array<WinningDeclaration & { readonly important: boolean }> = [];
  for (const [order, rule] of calendarStyleRules(style).entries()) {
    const value = rule.style.getPropertyValue(property).trim();
    if (value === '') continue;
    for (const selector of rule.selectorText.split(',').map((part) => part.trim())) {
      if (!selectorTargetsPseudo(selector, pseudo) || !elementMatchesSelector(element, selector)) {
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
  }
  const sortedMatches = [...matches];
  sortedMatches.sort((left, right) =>
    firstNonZero(
      Number(left.important) - Number(right.important),
      compareSpecificity(left.specificity, right.specificity),
      left.order - right.order,
    ),
  );
  const winner = sortedMatches[sortedMatches.length - 1];
  if (winner == null) return undefined;
  return {
    selector: winner.selector,
    value: winner.value,
    specificity: winner.specificity,
    order: winner.order,
  };
}

function installCalendarStyles(): HTMLStyleElement {
  const style = createFragment().createEl('style');
  style.dataset['abyssCalendarContract'] = 'true';
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
    ...(options.recurrence === undefined ? {} : { recurrence: options.recurrence }),
    ...(options.planning === undefined ? {} : { planning: options.planning }),
    source: { filePath: options.filePath ?? 'Recurring.md', line: options.line ?? 0 },
    ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
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
  if (date == null) throw new Error('Expected a materialized date');
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
    ...(planning === undefined ? {} : { planning }),
    ref: {
      parent: { type: 'task', ref: root.ref },
      relativeLine: 1,
      originalBlock: '  - [ ] First projected child',
    },
  });
  const second = subtask({
    title: 'Second projected child',
    recurrence: 'every week',
    ...(planning === undefined ? {} : { planning }),
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
    onForecastClick: vi.fn<NonNullable<ForecastInteractionCallbacks['onForecastClick']>>(),
    onForecastContextMenu:
      vi.fn<NonNullable<ForecastInteractionCallbacks['onForecastContextMenu']>>(),
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
  const forecast = expectDefined(forecasts(forecastSource, visibleDate, visibleDate)[0]).task;
  const root = freshContainer();
  root.className = 'tasksCalendar';
  root.dataset['abyssLegacyVisualFixture'] = 'true';
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
    expectDefined(
      Array.from(root.querySelectorAll<HTMLElement>('.task')).find(
        (candidate) => candidate.dataset['taskText'] === title,
      ),
    );
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
    '--abyss-calendar-surface',
    '--abyss-calendar-surface-forecast',
    '--abyss-calendar-border',
    '--abyss-calendar-border-forecast',
    '--abyss-calendar-foreground',
    '--abyss-calendar-now',
    '--abyss-calendar-border-width',
  ]) {
    expect(host.getPropertyValue(token).trim(), `${token} on legacy host`).not.toBe('');
  }

  expect(forecast.style.getPropertyValue('--task-color')).toBe('#336699');
  const forecastStyle = getComputedStyle(forecast);
  expect(forecastStyle.getPropertyValue('--abyss-tag-color')).toContain('--task-color');
  expect(forecastStyle.getPropertyValue('--abyss-calendar-surface-forecast')).toContain(
    'color-mix',
  );
  expect(winningDeclaration(style, forecast, 'border-inline-start')?.value).toContain(
    '--abyss-tag-color',
  );

  expect(forecast.dataset['controlSlot']).toBe('reserved');
  expect(forecast.querySelector('.abyss-status-marker')).toBeNull();
  expect(forecast.querySelector('input[type="checkbox"]')).toBeNull();
  expect(forecast.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(1);
  const forecastInner = expectDefined(forecast.querySelector<HTMLElement>(':scope > .inner'));
  expect(winningDeclaration(style, forecastInner, 'content', 'before')).toBeUndefined();

  for (const materialized of [ordinary, recurring]) {
    expect(materialized.dataset['controlSlot']).toBe('occupied');
    expect(materialized.querySelectorAll('.abyss-status-marker')).toHaveLength(1);
    const inner = expectDefined(materialized.querySelector<HTMLElement>(':scope > .inner'));
    expect(winningDeclaration(style, inner, 'content', 'before')).toBeUndefined();
  }
  expect(recurring.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(1);

  const forecastBackground = winningDeclaration(style, forecast, 'background');
  expect(forecastBackground).toMatchObject({
    selector: ".abyss-calendar-item[data-occurrence-state='forecast']",
    value: 'var(--abyss-calendar-surface-forecast)',
    specificity: [0, 2, 0],
  });
  expect(winningDeclaration(style, forecast, 'background', 'hover')).toEqual(forecastBackground);
  expect(winningDeclaration(style, forecast, 'color')?.value).toBe(
    'var(--abyss-calendar-foreground)',
  );
  expect(winningDeclaration(style, forecast, 'outline')?.value).toBe(
    'var(--abyss-calendar-border-width) dotted var(--abyss-calendar-border-forecast)',
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
  expect(element.querySelector('.abyss-status-marker')).toBeNull();
  expect(element.querySelector('[data-resize-edge]')).toBeNull();
  expect(element.getAttribute('draggable')).toBeNull();
  expect(element.getAttribute('tabindex')).toBeNull();
}

afterEach(() => {
  vi.restoreAllMocks();
  forecastMenuOwners.splice(0).forEach((owner) => {
    owner.dismiss({ restoreFocus: false });
  });
  activeDocument.querySelectorAll('.abyss-forecast-context-menu').forEach((element) => {
    element.remove();
  });
  activeDocument
    .querySelectorAll('[data-abyss-calendar-contract], [data-abyss-legacy-visual-fixture]')
    .forEach((element) => {
      element.remove();
    });
});

describe('forecast rendering contract', () => {
  it('renders independent timed Day forecasts with repeated title/badge and orthogonal DOM axes', () => {
    const source = rootSource({
      title: 'Daily standup',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-07'), time: '09:00', duration: 30 },
    });
    const [first, second] = forecasts(source, '2026-08-08', '2026-08-09');
    const firstContainer = freshContainer();
    const secondContainer = freshContainer();

    new TodayView(timeGridCallbacks()).render(
      firstContainer,
      [expectDefined(first).task],
      resolvedConfig({ startPosition: '2026-08-08' }),
      false,
    );
    new TodayView(timeGridCallbacks()).render(
      secondContainer,
      [expectDefined(second).task],
      resolvedConfig({ startPosition: '2026-08-09' }),
      false,
    );

    for (const [container, fixture] of [
      [firstContainer, expectDefined(first)],
      [secondContainer, expectDefined(second)],
    ] as const) {
      const block = expectDefined(container.querySelector<HTMLElement>('.abyss-tg-block'));
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
    expect(expectDefined(forecast).task.planning).toEqual({
      start: localDate('2026-08-07'),
      due: localDate('2026-08-09'),
    });
    const week = freshContainer();
    const month = freshContainer();

    new WeekView(legacyCallbacks()).render(
      week,
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08-03', firstDayOfWeek: 1 }),
    );
    new MonthView(legacyCallbacks()).render(
      month,
      [expectDefined(forecast).task],
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
      for (const card of [expectDefined(start), ...continuations, expectDefined(terminal)]) {
        expect(card.getAttribute('data-occurrence-key')).toBe(
          expectDefined(forecast).occurrence.key,
        );
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
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );
    new MonthGridView(monthCallbacks()).render(
      month,
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08' }),
    );

    for (const root of [week, month]) {
      const pieces = Array.from(
        root.querySelectorAll<HTMLElement>(
          '.abyss-mg-span-segment, .abyss-span-piece.abyss-tg-span, .abyss-span-piece.abyss-tg-span-continuation',
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
          piece.classList.contains('abyss-tg-span-continuation') ? 'continuation' : 'terminal',
          'true',
        );
        expect(piece.getAttribute('data-occurrence-key')).toBe(
          expectDefined(forecast).occurrence.key,
        );
        expect(piece.getAttribute('data-segment-identity')).toBe(
          `${expectDefined(forecast).occurrence.key}:${piece.getAttribute('data-span-role')}`,
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
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );

    const blocks = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-tg-block[data-occurrence-state="forecast"]'),
    ).sort((left, right) =>
      expectDefined(left.dataset['tgSegmentDate']).localeCompare(
        expectDefined(right.dataset['tgSegmentDate']),
      ),
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
      expect(block.dataset['occurrenceKey']).toBe(expectDefined(forecast).occurrence.key);
      expect(block.dataset['segmentIdentity']).toBe(
        `${expectDefined(forecast).occurrence.key}:${block.dataset['spanRole']}`,
      );
      expectForecastInert(block);
      expect(block.classList.contains('abyss-calendar-item')).toBe(true);
      const head = expectDefined(block.querySelector<HTMLElement>('.abyss-calendar-leading-row'));
      expect(head.dataset['controlSlot']).toBe('reserved');
      expect(head.dataset['recurrenceSlot']).toBe('occupied');
      expect(head.querySelector('.abyss-status-marker')).toBeNull();
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
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08-10', firstDayOfWeek: 1 }),
      false,
    );

    const body = expectDefined(
      container.querySelector<HTMLElement>('[data-tg-date="2026-08-10"] .abyss-tg-plain'),
    );
    const deadline = expectDefined(
      container.querySelector<HTMLElement>('[data-tg-date="2026-08-12"] .abyss-tg-deadline-marker'),
    );
    expect(body.getAttribute('data-occurrence-key')).toBe(expectDefined(forecast).occurrence.key);
    expect(deadline.getAttribute('data-occurrence-key')).toBe(
      expectDefined(forecast).occurrence.key,
    );
    expect(body.getAttribute('data-span-role')).toBe('scheduled-body');
    expect(deadline.getAttribute('data-span-role')).toBe('due-deadline');
    expect(body.getAttribute('data-segment-identity')).toBe(
      `${expectDefined(forecast).occurrence.key}:scheduled-body`,
    );
    expect(deadline.getAttribute('data-segment-identity')).toBe(
      `${expectDefined(forecast).occurrence.key}:due-deadline`,
    );
    for (const item of [body, deadline]) {
      expect(item.classList.contains('abyss-calendar-leading-row')).toBe(true);
      expect(item.dataset['controlSlot']).toBe('reserved');
      expect(item.dataset['recurrenceSlot']).toBe('occupied');
      expect(item.querySelector('.abyss-status-marker')).toBeNull();
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
    const forecast = expectDefined(
      forecasts(
        rootSource({
          title: 'Forecast repeat',
          recurrence: 'every day',
          planning: { due: '2026-08-08' },
          line: 3,
        }),
        '2026-08-09',
        '2026-08-09',
      )[0],
    ).task;
    const container = freshContainer();

    new MonthGridView(monthCallbacks()).render(
      container,
      [forecast, ordinary, recurringMaterialized],
      resolvedConfig({ startPosition: '2026-08' }),
    );

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-mg-date="2026-08-09"] .abyss-mg-plain'),
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.classList.contains('abyss-calendar-item')).toBe(true);
      expect(item.classList.contains('abyss-calendar-leading-row')).toBe(true);
      expect(item.dataset['controlSlot']).toMatch(/^(?:occupied|reserved)$/u);
      expect(item.dataset['recurrenceSlot']).toMatch(/^(?:occupied|reserved)$/u);
    }

    const ordinaryItem = expectDefined(
      items.find((item) => item.textContent.includes('Ordinary item')),
    );
    const materializedItem = expectDefined(
      items.find((item) => item.textContent.includes('Materialized repeat')),
    );
    const forecastItem = expectDefined(
      items.find((item) => item.textContent.includes('Forecast repeat')),
    );
    const style = installCalendarStyles();
    expect(ordinaryItem.dataset['controlSlot']).toBe('occupied');
    expect(ordinaryItem.dataset['recurrenceSlot']).toBe('reserved');
    expect(ordinaryItem.querySelector('.abyss-status-marker')).not.toBeNull();
    expect(ordinaryItem.querySelector('.abyss-recurrence-badge')).toBeNull();
    expect(
      winningDeclaration(
        style,
        expectDefined(ordinaryItem.querySelector<HTMLElement>('.abyss-status-marker')),
        'margin-inline-end',
      ),
    ).toBeUndefined();
    expect(materializedItem.dataset['controlSlot']).toBe('occupied');
    expect(materializedItem.dataset['recurrenceSlot']).toBe('occupied');
    expect(materializedItem.querySelector('.abyss-status-marker')).not.toBeNull();
    expect(materializedItem.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(1);
    expect(forecastItem.dataset['controlSlot']).toBe('reserved');
    expect(forecastItem.dataset['recurrenceSlot']).toBe('occupied');
    expect(forecastItem.querySelector('.abyss-status-marker')).toBeNull();
    expect(forecastItem.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(1);
  });

  it('keeps reserved leading-slot diagnostics out of layout and hit geometry', () => {
    const style = installCalendarStyles();

    for (const surface of [
      'abyss-tg-block-head',
      'abyss-tg-body',
      'abyss-tg-deadline-marker',
      'abyss-mg-plain',
      'abyss-mg-block-dot',
      'abyss-mg-span-segment',
      'abyss-mg-deadline-marker',
    ]) {
      const ghost = createFragment().createDiv();
      ghost.className = `abyss-calendar-leading-row ${surface}`;
      ghost.setAttribute('data-control-slot', 'reserved');
      ghost.setAttribute('data-recurrence-slot', 'reserved');

      expect(ghost.childElementCount).toBe(0);
      expect(winningDeclaration(style, ghost, 'content', 'before')).toBeUndefined();
      expect(winningDeclaration(style, ghost, 'flex-basis', 'before')).toBeUndefined();
      expect(winningDeclaration(style, ghost, 'inline-size', 'before')).toBeUndefined();
      expect(winningDeclaration(style, ghost, 'min-width', 'before')).toBeUndefined();
    }
  });

  it('keeps separate month forecasts compact and orders timed occurrences before untimed ones', () => {
    const timed = expectDefined(
      forecasts(
        rootSource({
          title: '09:00 forecast',
          recurrence: 'every week',
          planning: { due: '2026-08-02', time: '09:00' },
          line: 10,
        }),
        '2026-08-09',
        '2026-08-09',
      )[0],
    );
    const untimed = expectDefined(
      forecasts(
        rootSource({
          title: 'Untimed forecast',
          recurrence: 'every week',
          planning: { due: '2026-08-02' },
          line: 11,
        }),
        '2026-08-09',
        '2026-08-09',
      )[0],
    );
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
        '[data-mg-date="2026-08-09"] .abyss-mg-block-dot, [data-mg-date="2026-08-09"] .abyss-mg-plain',
      ),
    ).sort((left, right) => Number(left.style.gridRow) - Number(right.style.gridRow));
    expect(augustNinth.slice(0, 2).map((item) => item.textContent)).toEqual([
      expect.stringContaining('09:00 forecast'),
      expect.stringContaining('Untimed forecast'),
    ]);
    const dailyItems = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-mg-plain[data-occurrence-state="forecast"]'),
    ).filter((item) => item.textContent.includes('Independent daily'));
    expect(dailyItems).toHaveLength(3);
    expect(new Set(dailyItems.map((item) => item.dataset['occurrenceKey'])).size).toBe(3);
    expect(
      container.querySelectorAll('.abyss-mg-span-segment[data-occurrence-state="forecast"]'),
    ).toHaveLength(0);
  });

  it('derives forecast surfaces and current time from theme tokens without fading task text', () => {
    const lightTokens = declarationsFor('.abyss-panel-view');
    const darkTokens = declarationsFor('.theme-dark .abyss-panel-view');
    for (const token of [
      '--abyss-calendar-surface',
      '--abyss-calendar-surface-forecast',
      '--abyss-calendar-border',
      '--abyss-calendar-border-forecast',
      '--abyss-calendar-foreground',
      '--abyss-calendar-now',
    ]) {
      expect(lightTokens).toContain(token);
    }
    expect(darkTokens).toContain('--abyss-calendar-forecast-fill-strength');
    const itemTokens = declarationsFor('.abyss-calendar-item');
    expect(itemTokens).toMatch(
      /--abyss-calendar-surface\s*:\s*color-mix\([\s\S]*var\(--abyss-tag-color,\s*var\(--interactive-accent\)\)/u,
    );
    expect(itemTokens).toMatch(
      /--abyss-calendar-surface-forecast\s*:\s*color-mix\([\s\S]*--abyss-calendar-forecast-fill-strength/u,
    );
    expect(itemTokens).toContain('--abyss-calendar-foreground: var(--abyss-tag-text-color');

    const forecastAxis = declarationsForRuleContaining(
      ".abyss-calendar-item[data-occurrence-state='forecast']",
    );
    expect(forecastAxis).toMatch(/background\s*:\s*var\(--abyss-calendar-surface-forecast\)/u);
    expect(forecastAxis).toMatch(
      /outline\s*:\s*var\(--abyss-calendar-border-width\) dotted var\(--abyss-calendar-border-forecast\)/u,
    );
    expect(forecastAxis).not.toMatch(/opacity\s*:/u);

    const geometry = declarationsForRuleContaining(
      '.abyss-tg-block.abyss-calendar-item',
      '.abyss-tg-body.abyss-calendar-item',
      '.abyss-mg-plain.abyss-calendar-item',
    );
    expect(geometry).toMatch(/border-radius\s*:\s*var\(--abyss-calendar-item-radius\)/u);
    expect(geometry).toMatch(/padding\s*:\s*2px var\(--abyss-calendar-item-pad-inline\)/u);
    expect(geometry).toMatch(/font-size\s*:\s*var\(--abyss-calendar-item-font-size\)/u);
    const materializedSurface = declarationsForRuleContaining(
      '.abyss-tg-block',
      '.abyss-tg-span-continuation',
      '.abyss-mg-plain',
    );
    expect(materializedSurface).toMatch(/background\s*:\s*var\(--abyss-calendar-surface\)/u);
    expect(materializedSurface).toMatch(
      /box-shadow\s*:\s*inset 0 0 0 1px var\(--abyss-calendar-border\)/u,
    );
    const nowLine = declarationsFor('.abyss-tg-now-line');
    expect(nowLine).toMatch(/left\s*:\s*3\.5em/u);
    expect(nowLine).toMatch(/right\s*:\s*0/u);
    expect(nowLine).toMatch(/background\s*:\s*var\(--abyss-calendar-now\)/u);
    expect(nowLine).toMatch(/z-index\s*:\s*0/u);
    expect(nowLine).not.toMatch(/opacity\s*:/u);
    expect(declarationsFor('.abyss-tg-now-line-dot')).toMatch(
      /background\s*:\s*var\(--abyss-calendar-now\)/u,
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

    const diagnostics = root.querySelectorAll<HTMLElement>('.abyss-calendar-projection-diagnostic');
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
    const diagnostic = expectDefined(
      root.querySelector<HTMLElement>('.abyss-calendar-projection-diagnostic'),
    );
    const announcements: MutationRecord[] = [];
    const observer = new MutationObserver((records) => announcements.push(...records));
    observer.observe(diagnostic, { childList: true, characterData: true, subtree: true });

    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(announcements).toHaveLength(0);

    sources = [];
    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(diagnostic.textContent).toBe('');

    sources = [limitSource];
    notify?.({ type: 'changed', files: ['Stable.md'] });
    await Promise.resolve();
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBe(diagnostic);
    expect(diagnostic.textContent).toBe('More repeating occurrences are not shown');
    expect(announcements).toHaveLength(2);

    observer.disconnect();
    panel.destroy();
    expect(diagnostic.isConnected).toBe(false);
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBeNull();
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
    const diagnostic = expectDefined(
      root.querySelector<HTMLElement>('.abyss-calendar-projection-diagnostic'),
    );

    notify?.({ type: 'changed', files: ['Legacy-stable.md'] });
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBe(diagnostic);

    sources = [];
    notify?.({ type: 'changed', files: ['Legacy-stable.md'] });
    expect(root.querySelector('.abyss-calendar-projection-diagnostic')).toBe(diagnostic);
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
    expect(calendarOccurrenceForTask(expectDefined(preview).task)?.key).toBe(sourceIdentity);
    expect(taskLayoutIdentity(expectDefined(preview).task)).toBe(sourceIdentity);
    expect({
      column: expectDefined(preview).column,
      columns: expectDefined(preview).columns,
    }).toEqual({
      column: expectDefined(committed).column,
      columns: expectDefined(committed).columns,
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
    const forecast = expectDefined(
      forecasts(
        rootSource({
          title: 'Forecast between',
          recurrence: 'every day',
          planning: { due: localDate('2026-08-07'), time: '09:00' },
          line: 2,
        }),
        '2026-08-08',
        '2026-08-08',
      )[0],
    );
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

    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.abyss-tg-block'));
    expect(blocks).toHaveLength(3);
    expectDefined(blocks[0]).focus();
    expectDefined(blocks[0]).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(activeDocument.activeElement).toBe(blocks[2]);
    expectDefined(blocks[1]).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
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
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08-09' }),
      false,
    );
    expectDefined(container.querySelector<HTMLElement>('.abyss-tg-plain')).click();

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
      [expectDefined(forecast).task],
      resolvedConfig({ startPosition: '2026-08' }),
    );
    expectDefined(
      container.querySelector<HTMLElement>('[data-mg-date="2026-08-09"] .abyss-mg-plain'),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menu = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu'),
    );
    const items = Array.from(menu.querySelectorAll<HTMLElement>('button'));
    expect(items.map((item) => item.textContent)).toEqual(['Edit repeat…', 'Open source task']);
    expect(menu.querySelector('.abyss-status-marker')).toBeNull();

    expectDefined(items[0]).click();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledWith(source, localDate('2026-08-09'));
    expect(callbacks.onForecastContextMenu.mock.calls[0]?.[0].target).toEqual(source.target);

    expectDefined(
      container.querySelector<HTMLElement>('[data-mg-date="2026-08-09"] .abyss-mg-plain'),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expectDefined(
      activeDocument.querySelectorAll<HTMLElement>('.abyss-forecast-context-menu button')[1],
    ).click();
    expect(callbacks.onForecastClick).toHaveBeenCalledWith(source, localDate('2026-08-09'));
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onSetStatus).not.toHaveBeenCalled();
    expect(callbacks.onSetPriority).not.toHaveBeenCalled();
  });

  it.each([
    { edge: 'top-left', x: -20, y: -20 },
    { edge: 'top-right', x: 290, y: -20 },
    { edge: 'bottom-left', x: -20, y: 190 },
    { edge: 'bottom-right', x: 290, y: 190 },
  ])('measures and clamps the forecast menu inside the owner viewport at $edge', ({ x, y }) => {
    const ownerWindow = expectDefined(activeDocument.defaultView);
    vi.spyOn(ownerWindow, 'innerWidth', 'get').mockReturnValue(300);
    vi.spyOn(ownerWindow, 'innerHeight', 'get').mockReturnValue(200);
    const realRect = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('abyss-forecast-context-menu')) return rect(0, 0, 120, 80);
      return realRect.call(this);
    });
    const source = rootSource({
      title: 'Viewport forecast',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-08') },
    });
    const forecast = expectDefined(forecasts(source, '2026-08-09', '2026-08-09')[0]);
    const owner = createForecastContextMenuOwner(activeDocument);
    forecastMenuOwners.push(owner);
    const anchor = activeDocument.body.createEl('button');

    owner.open(
      anchor,
      new MouseEvent('contextmenu', { clientX: x, clientY: y }),
      forecast.occurrence,
      {},
    );

    const menu = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu'),
    );
    const left = Number.parseFloat(menu.style.left);
    const top = Number.parseFloat(menu.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + 120).toBeLessThanOrEqual(292);
    expect(top + 80).toBeLessThanOrEqual(192);
    anchor.remove();
  });

  it('lets the forecast menu shrink and wrap inside owner viewports narrower than 12rem', () => {
    const style = installCalendarStyles();
    const menu = activeDocument.body.createDiv({
      cls: 'abyss-status-popover abyss-forecast-context-menu',
    });
    const item = menu.createEl('button', { text: 'Open source task with a long label' });

    expect(winningDeclaration(style, menu, 'box-sizing')?.value).toBe('border-box');
    expect(winningDeclaration(style, menu, 'min-width')?.value).toBe('min(12rem, -16px + 100vw)');
    expect(winningDeclaration(style, menu, 'max-width')?.value).toBe('min(16rem, -16px + 100vw)');
    expect(winningDeclaration(style, item, 'min-width')?.value).toBe('0px');
    expect(winningDeclaration(style, item, 'white-space')?.value).toBe('normal');
    expect(winningDeclaration(style, item, 'overflow-wrap')?.value).toBe('anywhere');
  });

  it('uses a secondary document owner window for forecast geometry and exact lifecycle', () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const ownerWindow = frame.contentWindow as Window & typeof window;
    for (const method of ['createDiv', 'createEl'] as const) {
      Object.defineProperty(ownerWindow.HTMLElement.prototype, method, {
        configurable: true,
        value: methodOf(HTMLElement.prototype, method),
      });
    }
    vi.spyOn(ownerWindow, 'innerWidth', 'get').mockReturnValue(160);
    vi.spyOn(ownerWindow, 'innerHeight', 'get').mockReturnValue(120);
    let ownerRectCalls = 0;
    const OwnerDOMRect = ownerWindow.DOMRect;
    class TrackingDOMRect extends OwnerDOMRect {
      constructor(x = 0, y = 0, width = 0, height = 0) {
        super(x, y, width, height);
        ownerRectCalls++;
      }
    }
    Object.defineProperty(ownerWindow, 'DOMRect', {
      configurable: true,
      value: TrackingDOMRect,
    });
    const createOwnerDiv = ownerDocument.body.createDiv.bind(ownerDocument.body);
    const createMeasuredDiv = ((...args: Parameters<typeof createOwnerDiv>) => {
      const element = createOwnerDiv(...args);
      if (element.classList.contains('abyss-forecast-context-menu')) {
        Object.defineProperty(element, 'getBoundingClientRect', {
          configurable: true,
          value: () => rect(0, 0, 120, 80),
        });
      }
      return element;
    }) as typeof ownerDocument.body.createDiv;
    Object.defineProperty(ownerDocument.body, 'createDiv', {
      configurable: true,
      value: createMeasuredDiv,
    });
    const add = vi.spyOn(ownerDocument, 'addEventListener');
    const remove = vi.spyOn(ownerDocument, 'removeEventListener');
    const primaryAdd = vi.spyOn(activeDocument, 'addEventListener');
    const source = rootSource({
      title: 'Secondary owner forecast',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-08') },
    });
    const forecast = expectDefined(forecasts(source, '2026-08-09', '2026-08-09')[0]);
    const owner = createForecastContextMenuOwner(ownerDocument);
    forecastMenuOwners.push(owner);
    const anchor = ownerDocument.body.createEl('button');
    anchor.focus();

    try {
      owner.open(
        anchor,
        new ownerWindow.MouseEvent('contextmenu', { clientX: 150, clientY: 110 }),
        forecast.occurrence,
        {},
      );
      const menu = expectDefined(
        ownerDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu'),
      );
      expect(menu.ownerDocument).toBe(ownerDocument);
      expect(menu.style.left).toBe('32px');
      expect(menu.style.top).toBe('30px');
      expect(ownerRectCalls).toBe(2);
      const registrations = add.mock.calls.filter(
        ([type]) => type === 'keydown' || type === 'mousedown',
      );
      expect(registrations).toHaveLength(2);
      expect(
        primaryAdd.mock.calls.filter(([type]) => type === 'keydown' || type === 'mousedown'),
      ).toHaveLength(0);

      ownerDocument.dispatchEvent(
        new ownerWindow.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(ownerDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
      expect(ownerDocument.activeElement).toBe(anchor);
      for (const registration of registrations)
        expect(remove.mock.calls).toContainEqual(registration);
    } finally {
      owner.dismiss({ restoreFocus: false });
      frame.remove();
    }
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
    const first = expectDefined(forecasts(firstSource, '2026-08-09', '2026-08-09')[0]);
    const second = expectDefined(forecasts(secondSource, '2026-08-09', '2026-08-09')[0]);
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
        '[data-mg-date="2026-08-09"] .abyss-mg-plain[data-occurrence-state="forecast"]',
      ),
    );

    expectDefined(items[0]).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const staleEdit = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-forecast-context-menu-edit-repeat'),
    );
    expectDefined(items[1]).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(activeDocument.querySelectorAll('.abyss-forecast-context-menu')).toHaveLength(1);

    staleEdit.click();
    expect(callbacks.onForecastContextMenu).not.toHaveBeenCalled();
    activeDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);

    expectDefined(items[1]).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    activeDocument.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);

    expectDefined(items[1]).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu-edit-repeat'),
    ).click();
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledOnce();
    expect(callbacks.onForecastContextMenu).toHaveBeenCalledWith(
      secondSource,
      localDate('2026-08-09'),
    );
    trigger.remove();
  });

  it('acquires one shortcut blocker per forecast menu and releases on replacement/dismiss', () => {
    const source = rootSource({
      title: 'Owned forecast',
      recurrence: 'every day',
      planning: { due: localDate('2026-08-08') },
    });
    const forecast = expectDefined(forecasts(source, '2026-08-09', '2026-08-09')[0]);
    const releases = [vi.fn(), vi.fn()];
    const interactionOwnership = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] }),
    };
    const owner = createForecastContextMenuOwner(activeDocument, interactionOwnership);
    const anchor = activeDocument.body.createEl('button');

    owner.open(anchor, new MouseEvent('contextmenu'), forecast.occurrence, {});
    owner.open(anchor, new MouseEvent('contextmenu'), forecast.occurrence, {});
    expect(interactionOwnership.acquire).toHaveBeenCalledTimes(2);
    expect(interactionOwnership.acquire).toHaveBeenNthCalledWith(1, { blocksShortcuts: true });
    expect(releases[0]).toHaveBeenCalledOnce();

    owner.dismiss();
    owner.dismiss();
    expect(releases[1]).toHaveBeenCalledOnce();
    anchor.remove();
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
      expectDefined(
        root.querySelector<HTMLElement>(
          '.task[data-occurrence-state="forecast"][data-due="2026-08-09"]',
        ),
      ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    };

    openMenu();
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).not.toBeNull();
    notify?.({ type: 'changed', files: ['Legacy.md'] });
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();

    openMenu();
    renderer.destroy();
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
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
      expectDefined(
        root.querySelector<HTMLElement>(
          '[data-mg-date="2026-08-09"] [data-occurrence-state="forecast"]',
        ),
      ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    };

    openMenu();
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).not.toBeNull();
    notify?.({ type: 'changed', files: ['Modern.md'] });
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();

    openMenu();
    panel.destroy();
    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
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
      const forecast = expectDefined(
        root.querySelector<HTMLElement>(
          '.task[data-occurrence-state="forecast"][data-due="2026-08-02"]',
        ),
      );

      forecast.click();
      const sourceModal = activeDocument.querySelector<HTMLElement>('.abyss-modal');
      expect(sourceModal?.textContent).toContain('Daily source');
      expect(sourceModal?.querySelector('.abyss-forecast-source-context')?.textContent).toBe(
        'Forecast for 2026-08-02',
      );

      forecast.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu-edit-repeat'),
      ).click();
      expect(activeDocument.querySelector<HTMLInputElement>('.abyss-recurrence-raw')?.value).toBe(
        'every day',
      );

      renderer.destroy();
      activeDocument.querySelector<HTMLElement>('.abyss-modal-close-btn')?.click();
    },
  );

  it('forecast right-click exposes only Edit repeat', () => {
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
    const forecast = expectDefined(
      root.querySelector<HTMLElement>(
        '[data-mg-date="2026-08-09"] .abyss-mg-plain[data-occurrence-state="forecast"]',
      ),
    );

    forecast.click();
    expect(openModal).toHaveBeenCalledWith(sourceRoot);
    expect(activeDocument.querySelector('.abyss-forecast-source-context')?.textContent).toBe(
      'Forecast for 2026-08-09',
    );

    forecast.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(activeDocument.querySelector('.abyss-forecast-context-menu-edit-repeat')).not.toBeNull();
    expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-forecast-context-menu-edit-repeat'),
    ).click();
    expect(activeDocument.querySelector<HTMLInputElement>('.abyss-recurrence-raw')?.value).toBe(
      'every day',
    );

    panel.destroy();
  });
});
