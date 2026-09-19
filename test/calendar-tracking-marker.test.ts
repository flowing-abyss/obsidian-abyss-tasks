import { Component, Platform, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate, type TaskSnapshot, type TimeEntrySnapshot } from '../src/tasks';
import { MonthGridView } from '../src/views/MonthGridView';
import {
  calendarOccurrenceForRender,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import { createSpanInteractionOwner } from '../src/views/spanInteractions';
import { layoutVisibleSpans } from '../src/views/spanLayout';
import { renderAllDaySpanLayer } from '../src/views/timegrid/renderAllDay';
import { renderTimedBlocksForDay } from '../src/views/timegrid/renderTimedBlocks';
import {
  cssDeclarationsFor,
  expectDefined,
  freshContainer,
  loadPluginStyles,
  resolvedConfig,
  subtask,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();

const registry = new StatusRegistry(buildDefaultTaskStatuses());
const fakeApp = {} as App;
const css = await loadPluginStyles();

const RUNNING: TimeEntrySnapshot = {
  relativeLine: 1,
  originalMarkdown: '  - 2026-07-30T09:00:00+03:00 →',
  state: 'running',
  startMs: Date.parse('2026-07-30T09:00:00+03:00'),
};

const CLOSED: TimeEntrySnapshot = {
  relativeLine: 1,
  originalMarkdown: '  - 2026-07-30T07:00:00+03:00 → 2026-07-30T08:00:00+03:00',
  state: 'closed',
  startMs: Date.parse('2026-07-30T07:00:00+03:00'),
  endMs: Date.parse('2026-07-30T08:00:00+03:00'),
};

function callbacks() {
  return {
    occurrenceFor: calendarOccurrenceForRender,
    app: fakeApp,
    component: new Component(),
    onDayClick: vi.fn(),
    onCreateAtDate: vi.fn(),
    onTaskClick: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onDrop: vi.fn(),
    onSpanMove: vi.fn(),
    onSpanBoundary: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onStartChange: vi.fn(),
    onDueChange: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    onWeekClick: vi.fn(),
    statusRegistry: registry,
  };
}

function trackedItem(overrides: Parameters<typeof task>[0] = {}): TaskSnapshot {
  return task({ timeEntries: [RUNNING], ...overrides });
}

function tracking(root: ParentNode, selector: string): boolean {
  return expectDefined(
    root.querySelector<HTMLElement>(selector),
    `Missing ${selector}`,
  ).classList.contains('is-tracking');
}

describe('sidebar calendar running marker', () => {
  it('marks a compact month item whose node is running', () => {
    const container = freshContainer();

    new MonthGridView(callbacks()).render(
      container,
      [trackedItem({ title: 'Running', planning: { scheduled: '2026-07-30', time: '20:00' } })],
      resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }),
    );

    expect(tracking(container, '.abyss-mg-plain, .abyss-mg-block-dot')).toBe(true);
  });

  it('leaves a compact month item alone when nothing under it runs', () => {
    const container = freshContainer();

    new MonthGridView(callbacks()).render(
      container,
      [
        task({
          title: 'Idle',
          timeEntries: [CLOSED],
          planning: { scheduled: '2026-07-30', time: '20:00' },
        }),
      ],
      resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }),
    );

    expect(tracking(container, '.abyss-mg-plain, .abyss-mg-block-dot')).toBe(false);
  });

  it('marks a month item whose sub-task carries the open timer', () => {
    const container = freshContainer();

    new MonthGridView(callbacks()).render(
      container,
      [
        task({
          title: 'Parent',
          planning: { scheduled: '2026-07-30', time: '20:00' },
          subtasks: [subtask({ title: 'Child', timeEntries: [RUNNING] })],
        }),
      ],
      resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }),
    );

    expect(tracking(container, '.abyss-mg-plain, .abyss-mg-block-dot')).toBe(true);
  });

  it('marks a timed week block whose node is running', () => {
    const container = freshContainer();

    renderTimedBlocksForDay(
      container,
      [
        trackedItem({
          title: 'Running',
          planning: { due: '2026-07-30', time: '09:00', duration: 60 },
        }),
      ],
      callbacks(),
    );

    expect(tracking(container, '.abyss-tg-block')).toBe(true);
  });

  it('marks an all-day span whose node is running', () => {
    const container = freshContainer();
    const layer = container.createDiv({ cls: 'abyss-tg-span-layer' });
    const dates = ['2026-07-29', '2026-07-30', '2026-07-31'];
    const span = trackedItem({
      title: 'Trip',
      planning: { start: '2026-07-29', due: '2026-07-31' },
    });

    renderAllDaySpanLayer(
      layer,
      expectDefined(layoutVisibleSpans([span], dates).rows[0]),
      dates,
      callbacks(),
      [],
      createSpanInteractionOwner(),
      'timegrid',
    );

    expect(tracking(layer, '[data-span-kind]')).toBe(true);
  });

  it('never marks a forecast occurrence, which has not happened yet', () => {
    const container = freshContainer();
    const source = trackedItem({
      title: 'Weekly',
      recurrence: 'every week',
      planning: { scheduled: '2026-07-02', time: '20:00' },
    });
    // Projecting the month registers the forecast occurrences the renderer then reads back.
    const projection = projectCalendarOccurrences(
      {
        materialized: [],
        recurringSources: [
          { root: source, node: source, target: { type: 'task', ref: source.ref } },
        ],
      },
      { from: localDate('2026-07-01'), to: localDate('2026-07-31') },
      { removeScheduledDate: false },
    );
    const forecasts = projection.occurrences.filter((occurrence) => occurrence.kind === 'forecast');
    expect(forecasts.length).toBeGreaterThan(0);

    new MonthGridView(callbacks()).render(
      container,
      forecasts.map((occurrence) => taskSnapshotForCalendarOccurrence(occurrence)),
      resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }),
    );

    const items = [...container.querySelectorAll<HTMLElement>('.abyss-calendar-item')];
    expect(items.map((item) => item.getAttribute('data-occurrence-state'))).toContain('forecast');
    expect(items.filter((item) => item.classList.contains('is-tracking'))).toEqual([]);
  });

  it('accents a running item through the outline token every item already resolves', () => {
    if (!Platform.isDesktop) throw new Error('CSS fixture requires the desktop test runtime');

    expect(cssDeclarationsFor(css, '.abyss-calendar-item.is-tracking')).toContain(
      '--abyss-calendar-border: var(--interactive-accent)',
    );
    expect(cssDeclarationsFor(css, '.abyss-calendar-item.is-tracking')).toContain(
      'border-inline-start-color: var(--interactive-accent)',
    );
  });
});
