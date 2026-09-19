import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult, TaskIndexEvent } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
import { rebuildTaskSelection, rootTaskRef } from '../src/ui/taskSelection';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../src/ui/timeTracking/trackingActions';
import {
  configuredTaskApplication,
  createAppWithFiles,
  cssDeclarationsFor,
  cssDeclarationValue,
  expectDefined,
  flushMicrotasks,
  loadPluginStyles,
  useRealMoment,
} from './helpers';

useRealMoment();

const css = await loadPluginStyles();

const OFFSET_MINUTES = 180;
/** 2026-09-18T14:05:32+03:00, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 11, 5, 32);

/** One running session, two closed ones, a tail, a sub-task's session and a broken line. */
const SESSIONS = [
  '- [ ] Current',
  '  - 2026-09-18T12:30:00+03:00 →',
  '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
  '  - 2026-09-17T18:40:00+03:00 → 2026-09-17T18:55:00+03:00 call with Bob',
  '  - 2026-09-16 14:05 → 13:20',
  '  - [ ] Child',
  '    - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:15:00+03:00',
  '- [ ] Other',
  '',
].join('\n');

/** The whole tracked time of a task in one line, for the list that has a single day to lose. */
const SOLE_SESSION = [
  '- [ ] Current',
  '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
  '',
].join('\n');

/** The same sessions with nothing running, for the popover no tick is driving. */
const IDLE_SESSIONS = [
  '- [ ] Current',
  '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
  '  - 2026-09-17T18:40:00+03:00 → 2026-09-17T18:55:00+03:00 call with Bob',
  '',
].join('\n');

/** How long the fixture instant has left before the local day rolls over. */
const TO_MIDNIGHT_MS = Date.UTC(2026, 8, 18, 21, 0) - NOW_MS;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

function affects(event: TaskIndexEvent, path: string): boolean {
  if (event.type === 'initialized') return true;
  if (event.type === 'changed') return event.files.includes(path);
  if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
  return event.path === path;
}

const ELSEWHERE = '- [ ] Elsewhere\n';

/**
 * The long timers a test cares about, told apart from the short ones the app itself runs by their
 * delay: only the wait for the next local midnight is measured in hours.
 */
function longTimers(): {
  armed(): readonly number[];
  cleared(): readonly number[];
} {
  const armed = vi.spyOn(activeWindow, 'setTimeout');
  const cleared = vi.spyOn(activeWindow, 'clearTimeout');
  return {
    armed: () =>
      armed.mock.calls.flatMap(([, delay], index) =>
        typeof delay === 'number' && delay > 60_000
          ? [Number(armed.mock.results[index]?.value)]
          : [],
      ),
    cleared: () => cleared.mock.calls.map(([timer]) => Number(timer)),
  };
}

/** A tick the test drives, because a real interval survives a later switch to fake timers. */
function fakeTickWindow(): { readonly win: Window; tick(): void } {
  let scheduled: (() => void) | undefined;
  return {
    win: {
      setInterval: (callback: () => void) => {
        scheduled = callback;
        return 1;
      },
      clearInterval: () => {
        scheduled = undefined;
      },
    } as unknown as Window,
    tick: () => scheduled?.(),
  };
}

async function inspector(markdown = SESSIONS, selected = 'Current', win: Window = window) {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const content = `\n${markdown}`;
  const elsewhere = `\n${ELSEWHERE}`;
  const app = await createAppWithFiles({ 'tasks.md': content, 'other.md': elsewhere });
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
  stack.index.installCommittedContent('other.md', elsewhere);
  const located = (title: string) =>
    expectDefined(
      stack.index.listNodes().find(({ node }) => node.title === title),
      `Missing ${title}`,
    );
  const state = new AppState();
  const start = located(selected);
  state.set('taskStack', [start.root, ...start.path]);
  const reported: TaskCommandResult[] = [];
  const ticker = new TrackingTicker({
    queries: stack.tasks.queries,
    now: () => nowMs,
    win,
  });
  const panel = new RightPanel(
    state,
    app,
    stack.statusRegistry,
    DEFAULT_SETTINGS,
    undefined,
    stack.tasks,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ticker,
      actions: createTrackingActions(stack.tasks, (result) => reported.push(result)),
      context: () => ({ nowMs, offsetAt: () => OFFSET_MINUTES }),
    },
  );
  const el = activeDocument.body.createDiv();
  panel.mount(el);
  // What the owning view does: it converges the selection only for the file the inspector shows.
  const off = stack.tasks.queries.subscribe((event) => {
    const current = state.get('taskStack');
    const root = current[0];
    if (root === undefined || !affects(event, rootTaskRef(root).filePath)) return;
    const resolution = stack.tasks.queries.resolve(rootTaskRef(root));
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return;
    const task = resolution.type === 'exact' ? resolution.task : resolution.current;
    const draft = panel.captureDraftState();
    state.updateInspectorSelection(rebuildTaskSelection(task, current));
    panel.restoreDraftState(draft, task);
  });
  cleanups.push(() => {
    off();
    panel.destroy();
    ticker.destroy();
    stack.index.destroy();
  });
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  return {
    ...stack,
    app,
    el,
    panel,
    state,
    reported,
    located,
    read: async () => (await app.vault.read(file)).slice(1),
    advance: (ms: number) => {
      nowMs += ms;
    },
    select: (title: string) => {
      const next = located(title);
      state.updateInspectorSelection([next.root, ...next.path]);
    },
    /** A write to a file the inspector is not showing, which still reaches every subscriber. */
    touchOtherFile: async () => {
      await stack.tasks.execute({
        type: 'add-comment',
        parent: { type: 'task', ref: located('Elsewhere').root.ref },
        text: 'noted',
      });
      await flushMicrotasks();
    },
  };
}

function open(el: HTMLElement): HTMLElement {
  expectDefined(el.querySelector<HTMLButtonElement>('.abyss-time-badge-body')).click();
  return popover(el);
}

function popover(el: HTMLElement): HTMLElement {
  return expectDefined(
    el.querySelector<HTMLElement>('.abyss-time-tracking-popover'),
    'Missing sessions popover',
  );
}

function rows(el: HTMLElement): HTMLElement[] {
  return [...popover(el).querySelectorAll<HTMLElement>('.abyss-time-row')];
}

function text(row: HTMLElement, selector: string): string {
  return row.querySelector<HTMLElement>(selector)?.textContent ?? '';
}

function rowShape(row: HTMLElement) {
  return {
    duration: text(row, '.abyss-time-row-duration'),
    range: text(row, '.abyss-time-row-range'),
    note: text(row, '.abyss-time-row-note'),
  };
}

function days(el: HTMLElement): HTMLElement[] {
  return [...popover(el).querySelectorAll<HTMLElement>('.abyss-time-day')];
}

/** The day one section stands for, which is also how an undo row finds its way back into it. */
function dayOf(el: HTMLElement, heading: string): HTMLElement {
  return expectDefined(
    days(el).find((day) => text(day, '.abyss-time-day-label') === heading),
    `Missing the ${heading} section`,
  );
}

/** The list as a reader scans it: each day heading, then its rows as their three columns. */
function listed(el: HTMLElement): string[][] {
  return days(el).flatMap((day) => [
    ['day', text(day, '.abyss-time-day-label')],
    ...[...day.querySelectorAll<HTMLElement>('.abyss-time-row')].map((row) => [
      'row',
      text(row, '.abyss-time-row-range'),
      text(row, '.abyss-time-row-note'),
      text(row, '.abyss-time-row-duration'),
    ]),
  ]);
}

function headings(el: HTMLElement): string[] {
  return days(el).map((day) => text(day, '.abyss-time-day-label'));
}

/** Where an undo row sits: the day it was filed under and its place among that day's children. */
function undoPlace(el: HTMLElement): { day: string; index: number } {
  const row = expectDefined(
    popover(el).querySelector<HTMLElement>('.abyss-undo-row'),
    'Missing undo row',
  );
  const day = expectDefined(row.parentElement, 'The undo row left its day');
  return {
    day: text(day, '.abyss-time-day-label'),
    index: [...day.children].indexOf(row),
  };
}

/** Reads a rendered row duration back into the whole minutes the badge total floors to. */
function minutesOf(duration: string): number {
  const parts = /^(?:(\d+)h)?(?: ?(\d+)m)?(?: ?(\d+)s)?$/u.exec(duration);
  const [, hours, minutes, seconds] = parts ?? [];
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    throw new Error(`Unreadable duration ${duration}`);
  }
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

describe('tracked sessions popover', () => {
  it('groups every session under the day it started, newest first', async () => {
    const harness = await inspector();
    open(harness.el);

    expect(listed(harness.el)).toEqual([
      ['day', 'Today'],
      ['row', '12:30 →', '', '1h 35m 32s'],
      ['row', '11:00 → 11:15', 'Child', '15m'],
      ['row', '09:12 → 10:32', '', '1h 20m'],
      ['day', 'Yesterday'],
      ['row', '18:40 → 18:55', 'call with Bob', '15m'],
      ['day', 'Needs attention'],
      ['row', '', '2026-09-16 14:05 → 13:20', ''],
    ]);
    expect(rows(harness.el)[0]?.classList.contains('is-tracking')).toBe(true);
    expect(rows(harness.el)[4]?.querySelector('.abyss-time-row-warning')).not.toBeNull();
    expect(
      expectDefined(harness.el.querySelector('.abyss-time-badge-body')).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
  });

  it('files a session that crossed midnight under the day it began', async () => {
    const harness = await inspector(
      ['- [ ] Current', '  - 2026-09-17T23:30:00+03:00 → 2026-09-18T00:15:00+03:00', ''].join('\n'),
    );
    open(harness.el);

    expect(listed(harness.el)).toEqual([
      ['day', 'Yesterday'],
      ['row', '23:30 → 00:15', '', '45m'],
    ]);
  });

  it('keeps a note and the sub-task it belongs to in the one note cell', async () => {
    const harness = await inspector(
      [
        '- [ ] Current',
        '  - [ ] Child',
        '    - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:15:00+03:00 pairing',
        '',
      ].join('\n'),
    );
    open(harness.el);
    const note = expectDefined(
      rows(harness.el)[0]?.querySelector('.abyss-time-row-note'),
      'Missing the note cell',
    );

    expect([...note.children].map((span) => `${span.className} ${span.textContent}`)).toEqual([
      'abyss-time-row-tail pairing',
      'abyss-time-row-node Child',
    ]);
  });

  it('carries the note as the row tooltip, at every width', async () => {
    const harness = await inspector();
    open(harness.el);

    // The cell truncates wherever it is shown and is dropped outright in a narrow pane, so the row
    // always says what it holds. A broken line carries its own text for the same reason.
    expect(rows(harness.el).map((row) => row.title)).toEqual([
      '',
      'Child',
      '',
      'call with Bob',
      '2026-09-16 14:05 → 13:20',
    ]);
  });

  it('keeps the question a long-running row earns as its tooltip at any width', async () => {
    const harness = await inspector(
      ['- [ ] Current', '  - 2026-09-17T20:00:00+03:00 →', ''].join('\n'),
    );
    open(harness.el);

    expect(rows(harness.el).map((row) => row.title)).toEqual([
      'Still tracking since yesterday at 20:00?',
    ]);
  });

  it('drops the note cell in a pane too narrow to say a word in it', () => {
    const hidden = cssDeclarationsFor(css, '.abyss-time-row:not(.is-broken) .abyss-time-row-note');

    expect(css).toContain('@container abyss-panel-layout (max-width: 20rem)');
    expect(cssDeclarationValue(hidden, 'display')).toBe('none');
    // The line nobody could read is the whole reason its row exists, so it keeps its text.
    expect(cssDeclarationsFor(css, '.abyss-time-row.is-broken .abyss-time-row-note')).not.toContain(
      'display: none',
    );
  });

  it('gives every row the same columns, with the remove slot always reserved', async () => {
    const harness = await inspector();
    open(harness.el);

    const cells = rows(harness.el).map((row) => [...row.children].map((cell) => cell.className));

    expect(cells.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () => [
        'abyss-time-row-range',
        'abyss-time-row-note',
        'abyss-time-row-duration',
        'abyss-time-row-remove',
      ]),
    );
    expect(cells[4]).toEqual([
      'abyss-time-row-warning',
      'abyss-time-row-note',
      'abyss-time-row-remove',
    ]);
  });

  it('ticks the running row alone, down to the second', async () => {
    const clock = fakeTickWindow();
    const harness = await inspector(SESSIONS, 'Current', clock.win);
    open(harness.el);
    const running = expectDefined(rows(harness.el)[0], 'Missing the running row');
    const observer = new MutationObserver(() => {});
    observer.observe(popover(harness.el), { characterData: true, childList: true, subtree: true });
    try {
      harness.advance(1000);
      clock.tick();

      expect(rowShape(running).duration).toBe('1h 35m 33s');
      const written = observer.takeRecords().map((record) => {
        const { target } = record;
        return (target.instanceOf(HTMLElement) ? target : target.parentElement)?.className;
      });
      expect(written.length).toBeGreaterThan(0);
      expect([...new Set(written)]).toEqual(['abyss-time-row-duration']);

      // The same second again writes nothing at all, which is what the guarded writes buy.
      clock.tick();

      expect(observer.takeRecords()).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });

  it('adds every valid row up to the badge total', async () => {
    const harness = await inspector();
    open(harness.el);
    const counted = rows(harness.el)
      .map(rowShape)
      .filter((row) => row.duration !== '');

    const total = counted.reduce((sum, row) => sum + minutesOf(row.duration), 0);

    expect(total).toBe(205);
    expect(harness.el.querySelector('.abyss-time-badge-body')?.textContent).toBe('3h 25m');
  });

  it('reports an untracked task instead of an empty list', async () => {
    const harness = await inspector('- [ ] Current\n');
    open(harness.el);

    expect(rows(harness.el)).toEqual([]);
    expect(popover(harness.el).textContent).toContain('No tracked time yet');
  });

  it('removes one session and puts it back through undo', async () => {
    const harness = await inspector();
    const before = await harness.read();
    open(harness.el);

    expectDefined(
      rows(harness.el)[2]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(await harness.read()).not.toContain('09:12:00+03:00');
    const undoRow = expectDefined(
      popover(harness.el).querySelector<HTMLElement>('.abyss-undo-row'),
      'Missing undo row',
    );
    expect(undoRow.textContent).toContain('Removed');
    // The row sat third under the `Today` heading, whose label is that section's first child.
    expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 3 });

    expectDefined(undoRow.querySelector<HTMLButtonElement>('button')).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(before);
    expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
    expect(harness.reported).toEqual([]);
  });

  it('stops tracking when the running session is removed', async () => {
    const harness = await inspector();
    open(harness.el);

    expectDefined(
      rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(harness.tasks.queries.activeEntries()).toEqual([]);
    expect(await harness.read()).not.toContain('12:30:00+03:00');
    expect(harness.el.querySelector('.abyss-time-badge')?.classList.contains('is-tracking')).toBe(
      false,
    );
  });

  it('closes on Escape', async () => {
    const harness = await inspector();
    open(harness.el);

    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
    expect(harness.el.querySelector('.abyss-time-badge-body')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('takes the keyboard into the list and hands it back on Escape', async () => {
    const harness = await inspector();
    const badge = expectDefined(
      harness.el.querySelector<HTMLButtonElement>('.abyss-time-badge-body'),
    );
    badge.focus();
    badge.click();

    const surface = popover(harness.el);
    expect(activeDocument.activeElement).toBe(surface);
    expect(surface.getAttribute('tabindex')).toBe('-1');

    // Tab moves the keyboard onto the first control of the list, which must not dismiss it.
    expectDefined(rows(harness.el)[0]?.querySelector<HTMLButtonElement>('button')).focus();
    expect(harness.el.querySelector('.abyss-time-tracking-popover')).not.toBeNull();

    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(badge);
  });

  it('closes when another task is selected', async () => {
    const harness = await inspector();
    open(harness.el);

    harness.select('Other');

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
  });

  it('closes on a pointer press outside the popover', async () => {
    const harness = await inspector();
    open(harness.el);

    activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
  });

  it('closes when the keyboard leaves it', async () => {
    const harness = await inspector();
    open(harness.el);
    const elsewhere = activeDocument.body.createEl('button', { text: 'Elsewhere' });

    // This list opens nothing of its own, so an outside focus is always a reader leaving it. The
    // shared surface dismisses on it unless the caller holds one of its own actions.
    elsewhere.focus();

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
  });

  it('keeps the list alive across an index change', async () => {
    const harness = await inspector();
    open(harness.el);

    await harness.tasks.execute({
      type: 'start-tracking',
      parent: { type: 'task', ref: harness.located('Other').root.ref },
    });
    await flushMicrotasks();

    expect(rows(harness.el)).toHaveLength(5);
  });

  it('leaves the rows and the focus alone when another file changes', async () => {
    const harness = await inspector();
    open(harness.el);
    const before = rows(harness.el);
    const remove = expectDefined(
      before[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    );
    remove.focus();

    await harness.touchOtherFile();

    const after = rows(harness.el);
    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) expect(row).toBe(before[index]);
    expect(activeDocument.activeElement).toBe(remove);
  });

  it('rebuilds the rows when the shown file changes', async () => {
    const harness = await inspector();
    open(harness.el);
    const before = rows(harness.el);

    await harness.tasks.execute({
      type: 'delete-time-entry',
      entry: {
        parent: { type: 'task', ref: harness.located('Current').root.ref },
        relativeLine: 2,
        originalMarkdown: '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
      },
    });
    await flushMicrotasks();

    const after = rows(harness.el);
    expect(after).toHaveLength(4);
    expect(after[0]).not.toBe(before[0]);
  });

  it('relabels the days once the clock passes local midnight', async () => {
    const harness = await inspector();
    open(harness.el);
    expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

    harness.advance(10 * 3_600_000);
    await harness.touchOtherFile();

    expect(headings(harness.el)).toEqual(['Yesterday', 'Thu 17 Sep', 'Needs attention']);
  });

  /**
   * With nothing running there is no tick to notice a new day, so the popover keeps one timer of
   * its own for the next local midnight and re-reads its headings when it fires.
   */
  it('relabels the days at midnight with nothing running and no index event', async () => {
    const harness = await inspector(IDLE_SESSIONS);
    vi.useFakeTimers();
    const timers = longTimers();
    try {
      open(harness.el);
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday']);
      expect(timers.armed()).toHaveLength(1);

      harness.advance(TO_MIDNIGHT_MS);
      await vi.advanceTimersByTimeAsync(TO_MIDNIGHT_MS);

      expect(headings(harness.el)).toEqual(['Yesterday', 'Thu 17 Sep']);
      // The midnight that arrived arms the next one, and nothing else waits alongside it.
      expect(timers.armed()).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('keeps one midnight timer across an index event it ignores', async () => {
    const harness = await inspector(IDLE_SESSIONS);
    vi.useFakeTimers();
    const timers = longTimers();
    try {
      open(harness.el);
      const first = timers.armed();
      expect(first).toHaveLength(1);

      // A file this list never shows repaints nothing, and the early return still has to leave the
      // one wait it already had rather than arming a second beside it.
      const touched = harness.touchOtherFile();
      await vi.advanceTimersByTimeAsync(20);
      await touched;

      const armed = timers.armed();
      const cleared = timers.cleared();
      expect(armed).toHaveLength(2);
      expect(cleared).toEqual(expect.arrayContaining([...first]));
      expect(armed.filter((timer) => !cleared.includes(timer))).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('leaves no midnight timer behind when it closes', async () => {
    const harness = await inspector(IDLE_SESSIONS);
    vi.useFakeTimers();
    const timers = longTimers();
    try {
      open(harness.el);
      expect(timers.armed()).toHaveLength(1);

      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
      expect(timers.cleared()).toEqual(expect.arrayContaining([...timers.armed()]));
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('leaves the midnight to the tick while a timer is running', async () => {
    const clock = fakeTickWindow();
    const harness = await inspector(SESSIONS, 'Current', clock.win);
    vi.useFakeTimers();
    const timers = longTimers();
    try {
      open(harness.el);

      expect(timers.armed()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('relabels the days on the tick that crosses midnight, with no index event', async () => {
    const clock = fakeTickWindow();
    const harness = await inspector(SESSIONS, 'Current', clock.win);
    open(harness.el);
    expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

    harness.advance(10 * 3_600_000);
    clock.tick();

    expect(headings(harness.el)).toEqual(['Yesterday', 'Thu 17 Sep', 'Needs attention']);
  });

  it('keeps the scroll position across a rebuild', async () => {
    const harness = await inspector();
    open(harness.el);
    popover(harness.el).scrollTop = 24;

    await harness.tasks.execute({
      type: 'delete-time-entry',
      entry: {
        parent: { type: 'task', ref: harness.located('Current').root.ref },
        relativeLine: 2,
        originalMarkdown: '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
      },
    });
    await flushMicrotasks();

    // One row fewer proves the list was rebuilt rather than left untouched by the write.
    expect(rows(harness.el)).toHaveLength(4);
    expect(popover(harness.el).scrollTop).toBe(24);
  });

  it('follows its anchor when an unrelated write moves the inspector', async () => {
    const harness = await inspector();
    open(harness.el);
    const anchor = expectDefined(
      harness.el.querySelector<HTMLButtonElement>('.abyss-time-badge-body'),
    );
    vi.spyOn(harness.el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 800));
    const anchorRect = vi
      .spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(10, 100, 50, 20));
    await harness.touchOtherFile();
    expect(popover(harness.el).style.getPropertyValue('--abyss-pop-top')).toBe('124px');

    anchorRect.mockReturnValue(new DOMRect(10, 200, 50, 20));
    await harness.touchOtherFile();

    expect(popover(harness.el).style.getPropertyValue('--abyss-pop-top')).toBe('224px');
  });

  it('keeps the earlier undo row when the next removal fails', async () => {
    const harness = await inspector();
    open(harness.el);
    expectDefined(
      rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();
    expect(popover(harness.el).querySelectorAll('.abyss-undo-row')).toHaveLength(1);

    vi.spyOn(harness.app.vault, 'process').mockRejectedValueOnce(new Error('disk full'));
    expectDefined(
      rows(harness.el)[2]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(popover(harness.el).querySelectorAll('.abyss-undo-row')).toHaveLength(1);
    expect(harness.reported.map((result) => result.type)).toEqual(['io-error']);
  });

  it('closes with the selection it was opened from', async () => {
    const harness = await inspector();
    open(harness.el);

    harness.state.set('taskStack', []);

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();

    harness.select('Current');

    expect(harness.el.querySelector('.abyss-time-tracking-popover')).toBeNull();
  });

  it('drops a row whose line the note no longer holds', async () => {
    const harness = await inspector();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    open(harness.el);
    const stale = expectDefined(
      rows(harness.el)[2]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    );
    await harness.tasks.execute({
      type: 'delete-time-entry',
      entry: {
        parent: { type: 'task', ref: harness.located('Current').root.ref },
        relativeLine: 2,
        originalMarkdown: '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
      },
    });
    await flushMicrotasks();

    stale.click();
    await flushMicrotasks();

    expect(rows(harness.el)).toHaveLength(4);
    expect(error).toHaveBeenCalledWith(
      '[abyss-tasks] The tracked session to remove is no longer in the note',
    );
    expect(harness.reported).toEqual([]);
  });

  it('files a second undo row under the day its own row came from', async () => {
    const harness = await inspector();
    open(harness.el);
    expectDefined(
      rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();
    expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 2 });
    const second = expectDefined(rows(harness.el)[2], 'Missing the second row to remove');
    expect(rowShape(second).range).toBe('18:40 → 18:55');

    expectDefined(second.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
    await flushMicrotasks();

    expect(popover(harness.el).querySelectorAll('.abyss-undo-row')).toHaveLength(1);
    expect(undoPlace(harness.el)).toEqual({ day: 'Yesterday', index: 1 });
  });

  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
  ])('puts the undo row of row %i of a day back in its own place', async (at, index) => {
    const harness = await inspector();
    open(harness.el);

    expectDefined(
      rows(harness.el)[at]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(undoPlace(harness.el)).toEqual({ day: 'Today', index });
  });

  it('keeps the heading of a day whose last session was removed', async () => {
    const harness = await inspector();
    const before = await harness.read();
    open(harness.el);

    // `Yesterday` holds one session, so removing it would otherwise take its heading with it.
    expectDefined(
      rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);
    expect(dayOf(harness.el, 'Yesterday').querySelectorAll('.abyss-time-row')).toHaveLength(0);
    expect(undoPlace(harness.el)).toEqual({ day: 'Yesterday', index: 1 });

    expectDefined(
      popover(harness.el).querySelector<HTMLButtonElement>('.abyss-undo-row button'),
    ).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(before);
    expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
    expect(listed(harness.el)).toEqual([
      ['day', 'Today'],
      ['row', '12:30 →', '', '1h 35m 32s'],
      ['row', '11:00 → 11:15', 'Child', '15m'],
      ['row', '09:12 → 10:32', '', '1h 20m'],
      ['day', 'Yesterday'],
      ['row', '18:40 → 18:55', 'call with Bob', '15m'],
      ['day', 'Needs attention'],
      ['row', '', '2026-09-16 14:05 → 13:20', ''],
    ]);
  });

  /**
   * A removal that fails leaves the offer it interrupted standing, so that offer has to keep its
   * own identity: it is still the one holding a day open and still the one that must let it go.
   */
  it('lets an emptied day go after a failed removal interrupted its offer', async () => {
    const harness = await inspector();
    vi.useFakeTimers();
    try {
      open(harness.el);
      expectDefined(
        rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

      vi.spyOn(harness.app.vault, 'process').mockRejectedValueOnce(new Error('disk full'));
      expectDefined(
        rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(popover(harness.el).querySelectorAll('.abyss-undo-row')).toHaveLength(1);

      // The offer runs out, which is the moment the day it was holding has to go with it.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(headings(harness.el)).toEqual(['Today', 'Needs attention']);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  /**
   * The offer a failed removal interrupted can be over by the time the write answers, and a day
   * given back to an offer that has already ended would sit there empty with nobody to drop it.
   */
  it('drops an emptied day when its offer ends while the next removal is in flight', async () => {
    const harness = await inspector();
    vi.useFakeTimers();
    try {
      open(harness.el);
      // The only session of `Yesterday` goes, so its heading is held open for the undo row.
      expectDefined(
        rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

      let refuse: (error: Error) => void = () => {};
      vi.spyOn(harness.app.vault, 'process').mockReturnValueOnce(
        new Promise<string>((_resolve, reject) => {
          refuse = reject;
        }),
      );
      expectDefined(
        rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);

      // The first offer runs out while the second write is still unanswered.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();

      refuse(new Error('disk full'));
      await vi.advanceTimersByTimeAsync(10);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(headings(harness.el)).toEqual(['Today', 'Needs attention']);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  /**
   * Two removals can be waiting on the one write queue at once, and each has a day of its own to
   * keep standing. They answer in the order they were made rather than the order they were offered,
   * so neither may hand a day back to the other or to the offer already on screen.
   */
  it('lets an emptied day go after two overlapping removals both failed', async () => {
    const harness = await inspector();
    vi.useFakeTimers();
    try {
      open(harness.el);
      // The only session of `Yesterday` goes, so its heading is held open for the undo row.
      expectDefined(
        rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

      const refuse: Array<(error: Error) => void> = [];
      const deferred = (): Promise<string> =>
        new Promise<string>((_resolve, reject) => {
          refuse.push(reject);
        });
      vi.spyOn(harness.app.vault, 'process')
        .mockImplementationOnce(deferred)
        .mockImplementationOnce(deferred);
      // Both `Today` rows are asked for before either write answers, so the second is made while
      // the first is still unanswered even though the queue only starts it once the first is over.
      expectDefined(
        rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expectDefined(
        rows(harness.el)[2]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);

      expectDefined(refuse[0], 'The first removal never reached the vault')(new Error('disk full'));
      await vi.advanceTimersByTimeAsync(10);
      expectDefined(
        refuse[1],
        'The second removal never reached the vault',
      )(new Error('disk full'));
      await vi.advanceTimersByTimeAsync(10);

      // Neither failure wrote anything, so the offer on screen is still the first one's.
      expect(undoPlace(harness.el)).toEqual({ day: 'Yesterday', index: 1 });

      // That offer runs out, which is the moment the day it was holding has to go with it.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(headings(harness.el)).toEqual(['Today', 'Needs attention']);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  /**
   * A removal whose write breaks rather than answers leaves through the action boundary, and the
   * day it was holding has to go with it: a hold nothing releases would outlive every later offer.
   */
  it('lets go of the day a removal that threw was holding', async () => {
    const harness = await inspector();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      open(harness.el);
      vi.spyOn(harness.app.vault, 'process').mockRejectedValueOnce(new Error('disk full'));
      // The refused write is reported, and the reader of that report is what breaks here.
      vi.spyOn(harness.reported, 'push').mockImplementationOnce(() => {
        throw new Error('nowhere to report');
      });
      const yesterday = expectDefined(rows(harness.el)[3], 'Missing the Yesterday row');
      expect(rowShape(yesterday).range).toBe('18:40 → 18:55');
      expectDefined(yesterday.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
      await vi.advanceTimersByTimeAsync(10);

      expect(error).toHaveBeenCalledWith(
        '[abyss-tasks] Could not remove a tracked session',
        expect.any(Error),
      );

      // The same row goes for good on the next attempt, whose own hold is the only one left.
      expectDefined(
        rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(undoPlace(harness.el)).toEqual({ day: 'Yesterday', index: 1 });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(headings(harness.el)).toEqual(['Today', 'Needs attention']);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  /**
   * An offer over a day that still has sessions changes nothing about what the list shows, so it
   * may not take that list apart: the rows a reader is looking at and the control the keyboard is
   * on are both worth more than a rebuild that would draw the same thing again.
   */
  it('keeps the rows and the focus when an offer over a day that still has rows ends', async () => {
    const harness = await inspector();
    vi.useFakeTimers();
    try {
      open(harness.el);
      expectDefined(
        rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      const kept = expectDefined(rows(harness.el)[1], 'Missing the row that stayed');
      const remove = expectDefined(kept.querySelector<HTMLButtonElement>('.abyss-time-row-remove'));
      remove.focus();

      // The offer runs out over a day that never lost its last session.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(kept.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(remove);
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the list once for a removal the index has already reported', async () => {
    const harness = await inspector();
    const surface = open(harness.el);
    const drawn = vi.spyOn(surface, 'empty');

    expectDefined(
      rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    // The write is reported by the index, which rebuilds the list; taking the day for the undo row
    // that goes into it must not build the same list a second time.
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 2 });
  });

  /**
   * The day a removal is writing and the day under the undo row already on screen are two
   * different days, so a rebuild that lands while that write is unanswered has to keep both. The
   * midnight tick is such a rebuild, and it needs no write of its own to arrive first.
   */
  it('keeps a pending undo row under its own day while another removal is in flight', async () => {
    const clock = fakeTickWindow();
    const harness = await inspector(SESSIONS, 'Current', clock.win);
    open(harness.el);
    // The only session of `Yesterday` goes, so its heading is held open for the undo row.
    expectDefined(
      rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();
    expect(undoPlace(harness.el)).toEqual({ day: 'Yesterday', index: 1 });

    let refuse: (error: Error) => void = () => {};
    vi.spyOn(harness.app.vault, 'process').mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    expectDefined(
      rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    // The list is rebuilt from scratch while that write is unanswered, and the day the undo row
    // sits under is still the day it was removed from, whatever it is now called.
    harness.advance(10 * 3_600_000);
    clock.tick();

    expect(headings(harness.el)).toEqual(['Yesterday', 'Thu 17 Sep', 'Needs attention']);
    expect(undoPlace(harness.el)).toEqual({ day: 'Thu 17 Sep', index: 1 });

    refuse(new Error('disk full'));
    await flushMicrotasks();

    expect(undoPlace(harness.el)).toEqual({ day: 'Thu 17 Sep', index: 1 });
    expect(headings(harness.el)).toEqual(['Yesterday', 'Thu 17 Sep', 'Needs attention']);
  });

  it('names the day an undo row restores into', async () => {
    const harness = await inspector();
    open(harness.el);

    expectDefined(
      rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    const undo = expectDefined(
      popover(harness.el).querySelector<HTMLButtonElement>('.abyss-undo-row button'),
    );
    expect(undo.getAttribute('aria-label')).toBe('Undo removing 18:40 to 18:55 on Yesterday');
    expect(undo.textContent).toBe('Undo');
  });

  it('says a running session it removed by the time it began', async () => {
    const harness = await inspector();
    open(harness.el);

    expectDefined(
      rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(
      popover(harness.el)
        .querySelector<HTMLButtonElement>('.abyss-undo-row button')
        ?.getAttribute('aria-label'),
    ).toBe('Undo removing 12:30 onwards on Today');
  });

  it('says the arrow of a line it could not read as a word too', async () => {
    const harness = await inspector();
    open(harness.el);
    const broken = expectDefined(rows(harness.el)[4], 'Missing the broken row');
    // The row shows the line exactly as the note wrote it, arrow and all.
    expect(broken.textContent).toContain('2026-09-16 14:05 → 13:20');

    expectDefined(broken.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
    await flushMicrotasks();

    // Only the name that is read out spells the arrow, because a reader hears this one.
    expect(
      popover(harness.el)
        .querySelector<HTMLButtonElement>('.abyss-undo-row button')
        ?.getAttribute('aria-label'),
    ).toBe('Undo removing 2026-09-16 14:05 to 13:20');
  });

  it('reports a row that has lost its day instead of doing nothing about it', async () => {
    const harness = await inspector();
    const before = await harness.read();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    open(harness.el);
    const stray = expectDefined(rows(harness.el)[1], 'Missing the row to strand');
    // Whatever moved it, the row is no longer under a day and cannot say where to file an undo.
    popover(harness.el).appendChild(stray);

    expectDefined(stray.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
    await flushMicrotasks();

    expect(error).toHaveBeenCalledWith(
      '[abyss-tasks] The tracked session to remove is no longer under a day',
    );
    expect(await harness.read()).toBe(before);
    expect(rows(harness.el)).toHaveLength(5);
    expect(
      rows(harness.el).every(
        (row) => row.parentElement?.classList.contains('abyss-time-day') === true,
      ),
    ).toBe(true);
  });

  it('lets an emptied day go once its undo offer is over', async () => {
    const harness = await inspector();
    open(harness.el);
    expectDefined(
      rows(harness.el)[3]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();
    expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);

    // The next removal replaces the offer, which ends the one that was holding `Yesterday` open.
    expectDefined(
      rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(headings(harness.el)).toEqual(['Today', 'Needs attention']);
    expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 1 });
  });

  /**
   * The last session of a whole task takes the only day of the list with it, so the list may not
   * call the task untracked while the row that would bring it back is still on screen.
   */
  it('holds the only day of a list open until its undo offer is over', async () => {
    const harness = await inspector(SOLE_SESSION);
    const before = await harness.read();
    vi.useFakeTimers();
    try {
      open(harness.el);
      expectDefined(
        rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);

      expect(headings(harness.el)).toEqual(['Today']);
      expect(popover(harness.el).textContent).not.toContain('No tracked time yet');
      expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 1 });

      // The offer is taken, so the one session comes back into the day that was held for it.
      expectDefined(
        popover(harness.el).querySelector<HTMLButtonElement>('.abyss-undo-row button'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(listed(harness.el)).toEqual([
        ['day', 'Today'],
        ['row', '09:12 → 10:32', '', '1h 20m'],
      ]);

      // Removed again and left alone, the day goes when the offer does and the list says so.
      expectDefined(
        rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(headings(harness.el)).toEqual([]);
      expect(popover(harness.el).textContent).toContain('No tracked time yet');
      expect(await harness.read()).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Two removals from the one day, the first offered and the second refused: the offer on screen is
   * still the first one's, in the place it was filed, and the day both came from keeps its rows.
   */
  it('keeps the first undo row in its place when a removal from the same day fails', async () => {
    const harness = await inspector();
    vi.useFakeTimers();
    try {
      open(harness.el);
      expectDefined(
        rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
      ).click();
      await vi.advanceTimersByTimeAsync(10);
      expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 2 });

      vi.spyOn(harness.app.vault, 'process').mockRejectedValueOnce(new Error('disk full'));
      const same = expectDefined(rows(harness.el)[1], 'Missing the second row of the day');
      expect(rowShape(same).range).toBe('09:12 → 10:32');
      expectDefined(same.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
      await vi.advanceTimersByTimeAsync(10);

      expect(popover(harness.el).querySelectorAll('.abyss-undo-row')).toHaveLength(1);
      expect(undoPlace(harness.el)).toEqual({ day: 'Today', index: 2 });
      expect(harness.reported.map((result) => result.type)).toEqual(['io-error']);

      // The offer runs out, and the day neither removal emptied is still standing with its rows.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(popover(harness.el).querySelector('.abyss-undo-row')).toBeNull();
      expect(headings(harness.el)).toEqual(['Today', 'Yesterday', 'Needs attention']);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

function selectedTitles(harness: Awaited<ReturnType<typeof inspector>>): readonly string[] {
  return harness.state.get('taskStack').map((node) => node.title);
}

function badge(el: HTMLElement): HTMLElement {
  return expectDefined(el.querySelector<HTMLElement>('.abyss-time-badge'), 'Missing badge');
}

function toggle(el: HTMLElement): HTMLButtonElement {
  return expectDefined(
    el.querySelector<HTMLButtonElement>('.abyss-time-badge-toggle'),
    'Missing badge control',
  );
}

/**
 * An entry written under a selected sub-task rewrites that sub-task's source block, so the
 * inspector has to recognise the successor by position rather than by text.
 */
describe('tracking a selected sub-task', () => {
  it('keeps the sub-task selected when its own badge starts the timer', async () => {
    const harness = await inspector(SESSIONS, 'Child');
    expect(selectedTitles(harness)).toEqual(['Current', 'Child']);

    toggle(harness.el).click();
    await flushMicrotasks();

    expect(selectedTitles(harness)).toEqual(['Current', 'Child']);
    expect(badge(harness.el).classList.contains('is-tracking')).toBe(true);
    expect(harness.tasks.queries.activeEntries().map((entry) => entry.title)).toEqual(['Child']);
  });

  it('keeps the sub-task selected when its own badge pauses the timer', async () => {
    const harness = await inspector(SESSIONS, 'Child');
    toggle(harness.el).click();
    await flushMicrotasks();
    harness.advance(2 * 60_000);

    toggle(harness.el).click();
    await flushMicrotasks();

    expect(selectedTitles(harness)).toEqual(['Current', 'Child']);
    expect(badge(harness.el).classList.contains('is-tracking')).toBe(false);
    expect(harness.tasks.queries.activeEntries()).toEqual([]);
  });

  it('keeps the sub-task selected when a pause runs from outside the inspector', async () => {
    const harness = await inspector(SESSIONS, 'Child');
    toggle(harness.el).click();
    await flushMicrotasks();
    harness.advance(2 * 60_000);

    await harness.tasks.execute({ type: 'stop-tracking' });
    await flushMicrotasks();

    expect(selectedTitles(harness)).toEqual(['Current', 'Child']);
    expect(harness.tasks.queries.activeEntries()).toEqual([]);
  });

  it('keeps the undo row after a session is removed with a sub-task selected', async () => {
    const harness = await inspector(SESSIONS, 'Child');
    const before = await harness.read();
    open(harness.el);

    expectDefined(
      rows(harness.el)[0]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();

    expect(selectedTitles(harness)).toEqual(['Current', 'Child']);
    const undoRow = expectDefined(
      popover(harness.el).querySelector<HTMLElement>('.abyss-undo-row'),
      'Missing undo row',
    );
    expectDefined(undoRow.querySelector<HTMLButtonElement>('button')).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(before);
  });
});
