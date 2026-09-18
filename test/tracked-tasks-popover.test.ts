import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult, TaskNodeRef } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
import { mountRailTrackingWidget } from '../src/ui/timeTracking/RailTrackingWidget';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../src/ui/timeTracking/trackingActions';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  useRealMoment,
} from './helpers';

useRealMoment();

const OFFSET_MINUTES = 180;
/** 2026-09-18T14:05:32+03:00, a Friday, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 11, 5, 32);
const NOW_ATOM = '2026-09-18T14:05:32+03:00';
const SECOND = 1000;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

/**
 * The tick the test drives, because a real interval survives a later switch to fake timers. The
 * midnight rollover is exercised in the widget's own suite, so here it is only kept from firing.
 */
function fakeTimerWindow(): { readonly win: Window; tick(): void } {
  let interval: (() => void) | undefined;
  return {
    win: {
      setInterval: (callback: () => void) => {
        interval = callback;
        return -1;
      },
      clearInterval: () => {
        interval = undefined;
      },
      setTimeout: () => -1,
      clearTimeout: () => undefined,
    } as unknown as Window,
    tick: () => interval?.(),
  };
}

async function trackingStack(markdown: string) {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const content = `\n${markdown}`;
  const app = await createAppWithFiles({ 'tasks.md': content });
  let nowMs = NOW_MS;
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS, {
    authority: true,
    clock: systemClock(
      () => nowMs,
      () => OFFSET_MINUTES,
    ),
  });
  await stack.index.initialize();
  stack.index.installCommittedContent('tasks.md', content);
  cleanups.push(() => {
    stack.index.destroy();
  });
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  return {
    ...stack,
    app,
    read: async () => (await app.vault.read(file)).slice(1),
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

async function widgetFor(markdown: string) {
  const stack = await trackingStack(markdown);
  const clock = fakeTimerWindow();
  const layout = activeDocument.body.createDiv({ cls: 'abyss-layout' });
  const host = layout.createDiv({ cls: 'abyss-rail' }).createDiv({ cls: 'abyss-rail-tracking' });
  const reported: TaskCommandResult[] = [];
  const opened: TaskNodeRef[] = [];
  const ticker = new TrackingTicker({
    queries: stack.tasks.queries,
    now: stack.now,
    win: clock.win,
  });
  const widget = mountRailTrackingWidget({
    host,
    popoverOwner: layout,
    boundary: layout,
    queries: stack.tasks.queries,
    ticker,
    actions: createTrackingActions(stack.tasks, (result) => reported.push(result)),
    openTask: (target) => opened.push(target),
    context: () => ({ nowMs: stack.now(), offsetAt: () => OFFSET_MINUTES }),
    win: clock.win,
  });
  cleanups.push(() => {
    widget.destroy();
    ticker.destroy();
  });
  return { ...stack, clock, host, layout, opened, reported, widget };
}

function query<T extends HTMLElement>(root: ParentNode, selector: string, what: string): T {
  return expectDefined(root.querySelector<T>(selector), what);
}

function toggle(host: HTMLElement): HTMLButtonElement {
  return query(host, 'button.abyss-rail-tracking-toggle', 'Missing the tracking toggle');
}

function taskClock(host: HTMLElement): HTMLButtonElement {
  return query(host, 'button.abyss-rail-tracking-task', 'Missing the current task total');
}

function dayClock(host: HTMLElement): HTMLButtonElement {
  return query(host, 'button.abyss-rail-tracking-day', 'Missing the day total');
}

function popover(layout: HTMLElement): HTMLElement | null {
  return layout.querySelector<HTMLElement>('.abyss-time-tracking-popover--tasks');
}

function dayHeadings(layout: HTMLElement): Array<[string, string, string | null]> {
  return [...(popover(layout)?.querySelectorAll('.abyss-tracked-day-header') ?? [])].map(
    (header) => [
      header.querySelector('.abyss-tracked-day-name')?.textContent ?? '',
      header.querySelector('.abyss-tracked-day-total')?.textContent ?? '',
      header.getAttribute('aria-expanded'),
    ],
  );
}

function daySection(layout: HTMLElement, name: string): HTMLElement {
  const sections = [
    ...(popover(layout)?.querySelectorAll<HTMLElement>('.abyss-tracked-day') ?? []),
  ];
  return expectDefined(
    sections.find((day) => day.querySelector('.abyss-tracked-day-name')?.textContent === name),
    `Missing the ${name} section`,
  );
}

function rowsOf(section: HTMLElement): Array<[string, string, string]> {
  return [...section.querySelectorAll('.abyss-tracked-row')].map((row) => [
    row.querySelector('.abyss-tracked-row-title')?.textContent ?? '',
    row.querySelector('.abyss-tracked-row-parent')?.textContent ?? '',
    row.querySelector('.abyss-tracked-row-clock')?.textContent ?? '',
  ]);
}

/** A `h:mm` clock back as minutes, so a sum of rows can be compared with its heading. */
function clockMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Nothing at all today, so resuming is the only thing that can put a row on today. */
const YESTERDAY_ONLY = [
  '- [ ] Write report',
  '  - 2026-09-17T09:00:00+03:00 → 2026-09-17T15:30:00+03:00',
  '',
].join('\n');

/** Today is 5:12 across three tasks, one of them still running at 1:47. */
const WORKING_WEEK = [
  '- [ ] Write report',
  '  - 2026-09-18T12:18:32+03:00 →',
  '- [ ] Review PR',
  '  - 2026-09-18T08:00:00+03:00 → 2026-09-18T10:05:00+03:00',
  '- [ ] Email cleanup',
  '  - 2026-09-18T10:30:00+03:00 → 2026-09-18T11:50:00+03:00',
  '- [ ] Older',
  '  - 2026-09-16T10:00:00+03:00 → 2026-09-16T14:15:00+03:00',
  '  - [ ] Yesterday pass',
  '    - 2026-09-17T09:00:00+03:00 → 2026-09-17T15:30:00+03:00',
  '',
].join('\n');

describe('tracked tasks popover', () => {
  it('opens the last seven days with today expanded', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    dayClock(harness.host).click();

    expect(dayClock(harness.host).getAttribute('aria-expanded')).toBe('true');
    expect(dayHeadings(harness.layout)).toEqual([
      ['Today', '5:12', 'true'],
      ['Yesterday', '6:30', 'false'],
      ['Wed 16 Sep', '4:15', 'false'],
    ]);
    expect(rowsOf(daySection(harness.layout, 'Today'))).toEqual([
      ['Write report', '', '1:47'],
      ['Email cleanup', '', '1:20'],
      ['Review PR', '', '2:05'],
    ]);
  });

  it('adds every row of a day up to the number in its heading', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    dayClock(harness.host).click();

    for (const [name, total] of dayHeadings(harness.layout)) {
      const rows = rowsOf(daySection(harness.layout, name));
      expect(rows.reduce((sum, row) => sum + clockMinutes(row[2]), 0)).toBe(clockMinutes(total));
    }
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe(dayClock(harness.host).textContent);
  });

  it('keeps the running row level with the widget while the seconds pass', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();

    harness.advance(60 * SECOND);
    harness.clock.tick();

    expect(rowsOf(daySection(harness.layout, 'Today'))[0]?.[2]).toBe('1:48');
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe(dayClock(harness.host).textContent);
  });

  it('opens today the instant a timer starts and stays level with the widget', async () => {
    const harness = await widgetFor(YESTERDAY_ONLY);
    dayClock(harness.host).click();
    expect(dayHeadings(harness.layout).map(([name]) => name)).toEqual(['Yesterday']);

    // The entry is stamped at this very instant, so it has earned nothing at all yet.
    toggle(harness.host).click();
    await flushMicrotasks();

    expect(dayHeadings(harness.layout)).toEqual([
      ['Today', '0:00', 'true'],
      ['Yesterday', '6:30', 'false'],
    ]);
    const today = daySection(harness.layout, 'Today');
    expect(rowsOf(today)).toEqual([['Write report', '', '0:00']]);
    expect(
      query(today, '.abyss-tracked-row-toggle', 'Missing the row pause').getAttribute('aria-label'),
    ).toBe('Pause Write report');
    expect(rowsOf(today)[0]?.[2]).toBe(taskClock(harness.host).textContent);
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe(dayClock(harness.host).textContent);

    harness.advance(60 * SECOND);
    harness.clock.tick();

    expect(rowsOf(daySection(harness.layout, 'Today'))).toEqual([['Write report', '', '0:01']]);
    expect(taskClock(harness.host).textContent).toBe('0:01');
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe(dayClock(harness.host).textContent);
  });

  it('lays every row out as control, title cell, clock, parent title or not', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    query<HTMLButtonElement>(
      daySection(harness.layout, 'Yesterday'),
      '.abyss-tracked-day-header',
      'Missing the header',
    ).click();

    // The sub-task row carries an extra muted span, and a row that grows a second span must not
    // pull the whole list off its columns, so both shapes are asserted against one structure.
    const shapes = [
      ...expectDefined(popover(harness.layout)).querySelectorAll<HTMLElement>('.abyss-tracked-row'),
    ].map((row) => [...row.children].map((child) => child.className));
    expect(shapes).toEqual([
      ['abyss-tracked-row-toggle', 'abyss-tracked-row-open', 'abyss-tracked-row-clock'],
      ['abyss-tracked-row-toggle', 'abyss-tracked-row-open', 'abyss-tracked-row-clock'],
      ['abyss-tracked-row-toggle', 'abyss-tracked-row-open', 'abyss-tracked-row-clock'],
      ['abyss-tracked-row-toggle', 'abyss-tracked-row-open', 'abyss-tracked-row-clock'],
      ['abyss-tracked-row-toggle', 'abyss-tracked-row-open', 'abyss-tracked-row-clock'],
    ]);
    const cells = [
      ...expectDefined(popover(harness.layout)).querySelectorAll<HTMLElement>(
        '.abyss-tracked-row-open',
      ),
    ].map((cell) => [...cell.children].map((child) => child.className));
    expect(cells).toEqual([
      ['abyss-tracked-row-title'],
      ['abyss-tracked-row-title'],
      ['abyss-tracked-row-title'],
      ['abyss-tracked-row-title', 'abyss-tracked-row-parent'],
      ['abyss-tracked-row-title'],
    ]);
  });

  it('expands a past day and names the parent of a sub-task', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    const yesterday = daySection(harness.layout, 'Yesterday');
    expect(
      query<HTMLElement>(yesterday, '.abyss-tracked-day-rows', 'Missing the rows').hidden,
    ).toBe(true);

    query<HTMLButtonElement>(yesterday, '.abyss-tracked-day-header', 'Missing the header').click();

    expect(
      query<HTMLElement>(yesterday, '.abyss-tracked-day-rows', 'Missing the rows').hidden,
    ).toBe(false);
    expect(
      query(yesterday, '.abyss-tracked-day-header', 'Missing the header').getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
    expect(rowsOf(yesterday)).toEqual([['Yesterday pass', 'Older', '6:30']]);
  });

  it('moves the timer to the task whose play is pressed', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    const rows = [
      ...daySection(harness.layout, 'Today').querySelectorAll<HTMLElement>('.abyss-tracked-row'),
    ];
    expect(rows[0]?.classList.contains('is-tracking')).toBe(true);
    expect(
      query(
        expectDefined(rows[0]),
        '.abyss-tracked-row-toggle',
        'Missing the row pause',
      ).getAttribute('aria-label'),
    ).toBe('Pause Write report');

    query<HTMLButtonElement>(
      expectDefined(rows[2], 'Missing the third row'),
      '.abyss-tracked-row-toggle',
      'Missing the row play',
    ).click();
    await flushMicrotasks();

    const markdown = await harness.read();
    expect(markdown).toContain(`  - 2026-09-18T12:18:32+03:00 → ${NOW_ATOM}\n`);
    expect(markdown).toContain(`  - ${NOW_ATOM} →\n`);
    expect(toggle(harness.host).title).toBe('Pause Review PR');
    expect(harness.reported).toEqual([]);
  });

  it('shows no play on a finished task', async () => {
    const harness = await widgetFor(
      [
        '- [x] Email cleanup',
        '  - 2026-09-18T10:30:00+03:00 → 2026-09-18T11:50:00+03:00',
        '- [ ] Review PR',
        '  - 2026-09-18T12:00:00+03:00 → 2026-09-18T12:30:00+03:00',
        '',
      ].join('\n'),
    );

    dayClock(harness.host).click();
    const rows = [
      ...daySection(harness.layout, 'Today').querySelectorAll<HTMLElement>('.abyss-tracked-row'),
    ];
    const finished = expectDefined(rows[1], 'Missing the finished row');

    expect(finished.querySelector('.abyss-tracked-row-toggle')).toBeNull();
    expect(finished.querySelector('.abyss-tracked-row-done')).not.toBeNull();
  });

  it('opens a task from its title and closes behind it', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();

    query<HTMLButtonElement>(
      daySection(harness.layout, 'Today'),
      '.abyss-tracked-row-open',
      'Missing the row title',
    ).click();

    expect(harness.opened).toHaveLength(1);
    expect(popover(harness.layout)).toBeNull();
    expect(dayClock(harness.host).getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on an outside pointer down and on Escape', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    dayClock(harness.host).click();
    activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover(harness.layout)).toBeNull();

    dayClock(harness.host).click();
    expect(popover(harness.layout)).not.toBeNull();
    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover(harness.layout)).toBeNull();
  });

  it('keeps the keyboard on the row it was on after a rebuild', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    const rows = [
      ...daySection(harness.layout, 'Today').querySelectorAll<HTMLElement>('.abyss-tracked-row'),
    ];
    const play = query<HTMLButtonElement>(
      expectDefined(rows[1], 'Missing the second row'),
      '.abyss-tracked-row-toggle',
      'Missing the row play',
    );
    play.focus();

    play.click();
    await flushMicrotasks();

    // The list reorders around the newly running task, so the control has to be found again by the
    // row it belongs to rather than by where it used to sit.
    const focused = activeDocument.activeElement as HTMLElement | null;
    expect(focused?.className).toBe('abyss-tracked-row-toggle');
    expect(
      focused?.closest('.abyss-tracked-row')?.querySelector('.abyss-tracked-row-title')
        ?.textContent,
    ).toBe('Email cleanup');
    expect(focused?.getAttribute('aria-label')).toBe('Pause Email cleanup');
  });

  it('finds the focused control again when it carries a state class', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    const open = query<HTMLButtonElement>(
      daySection(harness.layout, 'Today'),
      '.abyss-tracked-row-open',
      'Missing the row title',
    );
    open.focus();
    // A control is found again by what it is. Its class list is a style decision, and a state class
    // on it must not turn the lookup into a selector that matches something else or nothing at all.
    open.addClass('is-pressed');

    toggle(harness.host).click();
    await flushMicrotasks();

    const focused = activeDocument.activeElement as HTMLElement | null;
    expect(focused?.className).toBe('abyss-tracked-row-open');
    expect(
      focused?.closest('.abyss-tracked-row')?.querySelector('.abyss-tracked-row-title')
        ?.textContent,
    ).toBe('Write report');
  });

  it('keeps the days a reader opened across an index change', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    dayClock(harness.host).click();
    query<HTMLButtonElement>(
      daySection(harness.layout, 'Yesterday'),
      '.abyss-tracked-day-header',
      'Missing the header',
    ).click();

    toggle(harness.host).click();
    await flushMicrotasks();

    expect(popover(harness.layout)).not.toBeNull();
    expect(dayHeadings(harness.layout).map(([name, , expanded]) => [name, expanded])).toEqual([
      ['Today', 'true'],
      ['Yesterday', 'true'],
      ['Wed 16 Sep', 'false'],
    ]);
  });
});
