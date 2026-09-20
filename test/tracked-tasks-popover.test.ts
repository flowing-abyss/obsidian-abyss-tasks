import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult, TaskNodeRef } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { mountRailTrackingWidget } from '../src/ui/timeTracking/RailTrackingWidget';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../src/ui/timeTracking/trackingActions';
import {
  cssDeclarationText as cssDeclarationsFor,
  cssValue as cssDeclarationValue,
} from './cssHelpers';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  loadPluginStyles,
  useRealMoment,
} from './helpers';

useRealMoment();

const css = await loadPluginStyles();

const OFFSET_MINUTES = 180;
/** 2026-09-18T14:05:32+03:00, a Friday, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 11, 5, 32);
const NOW_ATOM = '2026-09-18T14:05:32+03:00';
const SECOND = 1000;
/** The rail binds its units with a thin space; the list, which has room, does not. */
const THIN = '\u2009';

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

async function widgetFor(
  markdown: string,
  onOpenTask: () => void = () => {},
  ownership?: InteractionOwnershipPort,
) {
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
    openTask: (target) => {
      opened.push(target);
      // What the real inspector does on the way: it takes the keyboard while the click that opened
      // the task is still running.
      onOpenTask();
    },
    context: () => ({ nowMs: stack.now(), offsetAt: () => OFFSET_MINUTES }),
    ownership,
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

function taskTotal(host: HTMLElement): HTMLButtonElement {
  return query(host, 'button.abyss-rail-tracking-task', 'Missing the current task total');
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

/** A `1h 47m` or `1h 47m 12s` label back as seconds, so rows can be summed against a heading. */
function labelSeconds(label: string): number {
  const units: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const match of label.matchAll(/(\d{1,4})([hms])/gu)) {
    total += Number(match[1] ?? 0) * (units[match[2] ?? ''] ?? 0);
  }
  return total;
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

    taskTotal(harness.host).click();

    expect(taskTotal(harness.host).getAttribute('aria-expanded')).toBe('true');
    // Every total here is time already added to the pile, and says so.
    expect(dayHeadings(harness.layout)).toEqual([
      ['Today', '+5h 12m', 'true'],
      ['Yesterday', '+6h 30m', 'false'],
      ['Wed 16 Sep', '+4h 15m', 'false'],
    ]);
    // Only the running row spells out its seconds, which is what proves the timer is moving.
    expect(rowsOf(daySection(harness.layout, 'Today'))).toEqual([
      ['Write report', '', '+1h 47m 0s'],
      ['Email cleanup', '', '+1h 20m'],
      ['Review PR', '', '+2h 5m'],
    ]);
  });

  it('adds every row of a day up to the number in its heading', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    taskTotal(harness.host).click();

    for (const [name, total] of dayHeadings(harness.layout)) {
      const rows = rowsOf(daySection(harness.layout, name));
      const sum = rows.reduce((total_, row) => total_ + labelSeconds(row[2]), 0);
      // A heading has no seconds of its own, so the rows are compared at the minute they share.
      expect(Math.floor(sum / 60)).toBe(labelSeconds(total) / 60);
    }
  });

  it('ticks the running row by the second while its heading keeps to minutes', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    taskTotal(harness.host).click();

    harness.advance(SECOND);
    harness.clock.tick();

    expect(rowsOf(daySection(harness.layout, 'Today'))[0]?.[2]).toBe('+1h 47m 1s');
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe('+5h 12m');
    // The rail counts in minutes and reports a plain amount, so the seconds and the plus live in
    // the list a reader opened on purpose.
    expect(taskTotal(harness.host).textContent).toBe(`1h${THIN}47m`);

    harness.advance(59 * SECOND);
    harness.clock.tick();

    expect(rowsOf(daySection(harness.layout, 'Today'))[0]?.[2]).toBe('+1h 48m 0s');
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe('+5h 13m');
    expect(taskTotal(harness.host).textContent).toBe(`1h${THIN}48m`);
  });

  it('opens today the instant a timer starts and stays level with the widget', async () => {
    const harness = await widgetFor(YESTERDAY_ONLY);
    taskTotal(harness.host).click();
    expect(dayHeadings(harness.layout).map(([name]) => name)).toEqual(['Yesterday']);

    // The entry is stamped at this very instant, so it has earned nothing at all yet.
    toggle(harness.host).click();
    await flushMicrotasks();

    // A day that has earned nothing yet still reports a total, so it reports a gain of nothing.
    expect(dayHeadings(harness.layout)).toEqual([
      ['Today', '+0m', 'true'],
      ['Yesterday', '+6h 30m', 'false'],
    ]);
    const today = daySection(harness.layout, 'Today');
    expect(rowsOf(today)).toEqual([['Write report', '', '+0s']]);
    expect(
      query(today, '.abyss-tracked-row-toggle', 'Missing the row pause').getAttribute('aria-label'),
    ).toBe('Pause Write report');
    expect(taskTotal(harness.host).textContent).toBe('0m');

    harness.advance(60 * SECOND);
    harness.clock.tick();

    expect(rowsOf(daySection(harness.layout, 'Today'))).toEqual([['Write report', '', '+1m 0s']]);
    expect(taskTotal(harness.host).textContent).toBe('1m');
    expect(dayHeadings(harness.layout)[0]?.[1]).toBe('+1m');
  });

  it('keeps two running rows level with the day they share', async () => {
    const harness = await widgetFor(
      [
        '- [ ] Write report',
        '  - 2026-09-18T13:05:32+03:00 \u2192',
        '- [ ] Review PR',
        '  - 2026-09-18T13:35:32+03:00 \u2192',
        '',
      ].join('\n'),
    );
    taskTotal(harness.host).click();

    harness.advance(60 * SECOND);
    harness.clock.tick();

    const rows = rowsOf(daySection(harness.layout, 'Today'));
    expect(rows.map(([name, , clock]) => [name, clock])).toEqual([
      ['Write report', '+1h 1m 0s'],
      ['Review PR', '+31m 0s'],
    ]);
    expect(Math.floor(rows.reduce((sum, row) => sum + labelSeconds(row[2]), 0) / 60)).toBe(
      labelSeconds(expectDefined(dayHeadings(harness.layout)[0])[1]) / 60,
    );
  });

  it('lays every row out as control, title cell, clock, parent title or not', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    taskTotal(harness.host).click();
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
    taskTotal(harness.host).click();
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
    expect(rowsOf(yesterday)).toEqual([['Yesterday pass', 'Older', '+6h 30m']]);
  });

  it('moves the timer to the task whose play is pressed', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    taskTotal(harness.host).click();
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
    // The task that is running is the task the list is about, so it takes the top of its day.
    expect(rowsOf(daySection(harness.layout, 'Today')).map(([title]) => title)).toEqual([
      'Review PR',
      'Write report',
      'Email cleanup',
    ]);
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

    taskTotal(harness.host).click();
    const rows = [
      ...daySection(harness.layout, 'Today').querySelectorAll<HTMLElement>('.abyss-tracked-row'),
    ];
    const finished = expectDefined(rows[1], 'Missing the finished row');

    expect(finished.querySelector('.abyss-tracked-row-toggle')).toBeNull();
    expect(finished.querySelector('.abyss-tracked-row-done')).not.toBeNull();
  });

  it('gives the title button the whole height of its row', () => {
    const declarations = cssDeclarationsFor(css, '.abyss-tracked-row .abyss-tracked-row-open');

    // Without the stretch the button is one line of text inside a taller row, which leaves a dead
    // band above and below it that a click on the row passes straight through. The negative block
    // margin reaches the rest of that height, which is the row's own padding.
    expect(declarations).toContain('align-self: stretch');
    expect(declarations).toContain('align-items: center');
    expect(declarations).toContain('margin-block: -4px');
    expect(declarations).toContain('padding: var(--size-4-1) 0');
    expect(declarations).not.toContain('align-items: baseline');
    expect(
      cssDeclarationsFor(css, '.abyss-time-tracking-popover--tasks .abyss-tracked-day-header'),
    ).toBeDefined();
  });

  it('reads every total in the gain colour, which a running row takes back', () => {
    for (const cell of ['.abyss-tracked-day-total', '.abyss-tracked-row-clock']) {
      expect(cssDeclarationValue(cssDeclarationsFor(css, cell), 'color')).toBe(
        'var(--abyss-time-gain)',
      );
    }
    // Two classes outrank the one the clock carries, so a running row stays the accent whole.
    expect(
      cssDeclarationValue(
        cssDeclarationsFor(css, '.abyss-tracked-row.is-tracking .abyss-tracked-row-clock'),
        'color',
      ),
    ).toBe('var(--text-accent)');
    // A finished task mutes its title and nothing else: the time it earned is still a gain.
    expect(
      cssDeclarationValue(
        cssDeclarationsFor(css, '.abyss-tracked-row.is-finished .abyss-tracked-row-title'),
        'color',
      ),
    ).toBe('var(--text-muted)');
    expect(cssDeclarationsFor(css, '.abyss-tracked-row.is-finished .abyss-tracked-row-clock')).toBe(
      '',
    );
  });

  it('fills the play and pause glyphs while the finished check stays an outline', () => {
    for (const control of [
      '.abyss-time-badge-toggle',
      '.abyss-rail-tracking-toggle',
      '.abyss-tracked-row-toggle',
    ]) {
      expect(cssDeclarationValue(cssDeclarationsFor(css, `${control} svg`), 'fill')).toBe(
        'currentcolor',
      );
    }
    expect(cssDeclarationsFor(css, '.abyss-tracked-row-done svg')).not.toContain('fill');
  });

  it('takes the keyboard into the list and hands it back on Escape', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const day = taskTotal(harness.host);
    day.focus();
    day.click();

    const surface = query(harness.layout, '.abyss-time-tracking-popover', 'Missing the list');
    expect(activeDocument.activeElement).toBe(surface);
    expect(surface.getAttribute('tabindex')).toBe('-1');

    // Tab reaches the first control of the list, which must not read as a dismissal.
    query<HTMLButtonElement>(
      daySection(harness.layout, 'Today'),
      '.abyss-tracked-row-open',
      'Missing the row title',
    ).focus();
    expect(harness.layout.querySelector('.abyss-time-tracking-popover')).not.toBeNull();

    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(harness.layout.querySelector('.abyss-time-tracking-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(day);
  });

  it('opens a task from its title and stays open on that row', async () => {
    const inspector = activeDocument.body.createEl('button', { text: 'Inspector' });
    const harness = await widgetFor(WORKING_WEEK, () => {
      inspector.focus();
    });
    taskTotal(harness.host).click();

    const title = query<HTMLButtonElement>(
      daySection(harness.layout, 'Today'),
      '.abyss-tracked-row-open',
      'Missing the row title',
    );
    title.click();

    // Opening a task is how a reader moves through this list, so the list survives the keyboard
    // going to the inspector and hands it back to the row that was just opened.
    expect(harness.opened).toHaveLength(1);
    expect(popover(harness.layout)).not.toBeNull();
    expect(taskTotal(harness.host).getAttribute('aria-expanded')).toBe('true');
    expect(activeDocument.activeElement).toBe(title);
  });

  it('holds that focus for the click only', async () => {
    const inspector = activeDocument.body.createEl('button', { text: 'Inspector' });
    const harness = await widgetFor(WORKING_WEEK, () => {
      inspector.focus();
    });
    taskTotal(harness.host).click();
    query<HTMLButtonElement>(
      daySection(harness.layout, 'Today'),
      '.abyss-tracked-row-open',
      'Missing the row title',
    ).click();
    expect(popover(harness.layout)).not.toBeNull();

    // The hold covers the click and the microtask after it. Anything that reaches for the keyboard
    // later is a reader leaving, which dismisses the list like any other surface.
    await flushMicrotasks();
    inspector.focus();

    expect(popover(harness.layout)).toBeNull();
  });

  it('closes when the keyboard leaves it for another surface', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const elsewhere = activeDocument.body.createEl('button', { text: 'Elsewhere' });

    taskTotal(harness.host).click();
    expect(popover(harness.layout)).not.toBeNull();
    elsewhere.focus();

    expect(popover(harness.layout)).toBeNull();
    expect(taskTotal(harness.host).getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves the next Escape to whatever is on top once it has closed', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const elsewhere = activeDocument.body.createEl('button', { text: 'Elsewhere' });
    taskTotal(harness.host).click();
    elsewhere.focus();
    expect(popover(harness.layout)).toBeNull();

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    activeDocument.dispatchEvent(escape);

    // A closed list has released its listeners, so the command palette or modal that is on top now
    // still gets the key.
    expect(escape.defaultPrevented).toBe(false);
  });

  it('closes on an outside pointer down and on Escape', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    taskTotal(harness.host).click();
    activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover(harness.layout)).toBeNull();

    taskTotal(harness.host).click();
    expect(popover(harness.layout)).not.toBeNull();
    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover(harness.layout)).toBeNull();
  });

  it('takes the panel keyboard while it is open and hands it back once', async () => {
    const release = vi.fn();
    const ownership = { acquire: vi.fn(() => ({ release })) };
    const harness = await widgetFor(WORKING_WEEK, () => {}, ownership);

    taskTotal(harness.host).click();

    expect(ownership.acquire).toHaveBeenCalledOnce();
    expect(ownership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
    expect(release).not.toHaveBeenCalled();

    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(popover(harness.layout)).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the keyboard on the row it was on after a rebuild', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    taskTotal(harness.host).click();
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
    taskTotal(harness.host).click();
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
    taskTotal(harness.host).click();
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
