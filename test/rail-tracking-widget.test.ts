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
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

/** Every timer the widget and the shared ticker own, driven by the test instead of by the clock. */
function fakeTimerWindow(): {
  readonly win: Window;
  tick(): void;
  ticking(): boolean;
  delays(): number[];
  pending(): number;
  fireTimeouts(): void;
} {
  let interval: (() => void) | undefined;
  const timeouts = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 0;
  return {
    win: {
      setInterval: (callback: () => void) => {
        interval = callback;
        return -1;
      },
      clearInterval: () => {
        interval = undefined;
      },
      setTimeout: (callback: () => void, delay: number) => {
        nextId += 1;
        delays.push(delay);
        timeouts.set(nextId, callback);
        return nextId;
      },
      clearTimeout: (id: number) => {
        timeouts.delete(id);
      },
    } as unknown as Window,
    tick: () => interval?.(),
    ticking: () => interval !== undefined,
    delays: () => [...delays],
    pending: () => timeouts.size,
    fireTimeouts: () => {
      for (const [id, callback] of [...timeouts]) {
        timeouts.delete(id);
        callback();
      }
    },
  };
}

async function trackingStack(markdown: string, extra: Record<string, string> = {}) {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const content = `\n${markdown}`;
  const app = await createAppWithFiles({ 'tasks.md': content, ...extra });
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

type TrackingStack = Awaited<ReturnType<typeof trackingStack>>;

/** The index behind a counted subscription, so a released surface can be proved released. */
function countedQueries(stack: TrackingStack) {
  const source = stack.tasks.queries;
  let subscribers = 0;
  return {
    subscribers: () => subscribers,
    api: {
      activeEntries: () => source.activeEntries(),
      entriesOverlapping: (fromMs: number, toMs: number) => source.entriesOverlapping(fromMs, toMs),
      fileTotal: (filePath: string) => source.fileTotal(filePath),
      subscribe: (listener: Parameters<typeof source.subscribe>[0]) => {
        subscribers += 1;
        const off = source.subscribe(listener);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          subscribers -= 1;
          off();
        };
      },
    },
  };
}

function mountWidget(stack: TrackingStack, clock: ReturnType<typeof fakeTimerWindow>) {
  const layout = activeDocument.body.createDiv({ cls: 'abyss-layout' });
  const host = layout.createDiv({ cls: 'abyss-rail' }).createDiv({ cls: 'abyss-rail-tracking' });
  const reported: TaskCommandResult[] = [];
  const opened: TaskNodeRef[] = [];
  const queries = countedQueries(stack);
  let contextReads = 0;
  const ticker = new TrackingTicker({
    queries: queries.api,
    now: stack.now,
    win: clock.win,
  });
  const widget = mountRailTrackingWidget({
    host,
    popoverOwner: layout,
    boundary: layout,
    queries: queries.api,
    ticker,
    actions: createTrackingActions(stack.tasks, (result) => reported.push(result)),
    openTask: (target) => opened.push(target),
    context: () => {
      contextReads += 1;
      return { nowMs: stack.now(), offsetAt: () => OFFSET_MINUTES };
    },
    win: clock.win,
  });
  cleanups.push(() => {
    widget.destroy();
    ticker.destroy();
  });
  return {
    clock,
    host,
    layout,
    opened,
    reported,
    ticker,
    widget,
    subscribers: queries.subscribers,
    contextReads: () => contextReads,
  };
}

async function widgetFor(markdown: string, extra: Record<string, string> = {}) {
  const stack = await trackingStack(markdown, extra);
  return { ...stack, ...mountWidget(stack, fakeTimerWindow()) };
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

/** The rail is 48px wide, so its one number binds its units with a thin space. */
const THIN = '\u2009';

function dayHeadings(layout: HTMLElement): Array<[string, string]> {
  return [
    ...layout.querySelectorAll('.abyss-time-tracking-popover--tasks .abyss-tracked-day-header'),
  ].map((header) => [
    header.querySelector('.abyss-tracked-day-name')?.textContent ?? '',
    header.querySelector('.abyss-tracked-day-total')?.textContent ?? '',
  ]);
}

const EMPTY_VAULT = '- [ ] Nothing tracked\n';

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

describe('rail tracking widget', () => {
  it('stays out of the rail when nothing was ever tracked', async () => {
    const { host } = await widgetFor(EMPTY_VAULT);

    expect(host.hidden).toBe(true);
    expect(host.childElementCount).toBe(0);
  });

  it('offers to resume the last task when today is still empty', async () => {
    const { host } = await widgetFor(YESTERDAY_ONLY);

    expect(host.hidden).toBe(false);
    expect(host.classList.contains('is-tracking')).toBe(false);
    expect(taskTotal(host).textContent).toBe('0m');
    expect(toggle(host).disabled).toBe(false);
    expect(toggle(host).title).toBe('Resume Write report');
    expect(toggle(host).getAttribute('aria-label')).toBe('Resume Write report');
    expect(taskTotal(host).title).toBe('Tracked on this task today');
    // A screen reader hears the number, not only what the number is about.
    expect(taskTotal(host).getAttribute('aria-label')).toBe('Tracked on this task today, 0m');
  });

  it('says one number and nothing a clock would say', async () => {
    const { host } = await widgetFor(WORKING_WEEK);

    // The day total moved into the list's own heading, and the caption and the blinking separator
    // are gone, so the rail carries a control and a number and nothing else.
    expect(host.querySelector('.abyss-rail-tracking-day')).toBeNull();
    expect(host.querySelector('.abyss-rail-tracking-caption')).toBeNull();
    expect(host.querySelector('.abyss-rail-tracking-colon')).toBeNull();
    expect([...host.children].map((child) => child.className)).toEqual([
      'abyss-rail-tracking-toggle',
      'abyss-rail-tracking-task',
      'abyss-rail-tracking-rule',
    ]);
    // Never the filled mode-button style: this control speaks for one task, not for a view.
    expect(toggle(host).classList.contains('is-active')).toBe(false);
    expect(toggle(host).classList.contains('abyss-rail-btn')).toBe(false);
  });

  it('counts the running task, and rewrites only on the minute', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const { host } = harness;

    expect(host.classList.contains('is-tracking')).toBe(true);
    expect(toggle(host).classList.contains('is-active')).toBe(false);
    expect(toggle(host).title).toBe('Pause Write report');
    expect(taskTotal(host).textContent).toBe(`1h${THIN}47m`);
    expect(taskTotal(host).getAttribute('aria-label')).toBe('Tracked on this task today, 1h 47m');

    const observer = new MutationObserver(() => {});
    observer.observe(host, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    try {
      for (let second = 0; second < 59; second += 1) {
        harness.advance(SECOND);
        harness.clock.tick();
      }
      expect(observer.takeRecords()).toEqual([]);
      expect(taskTotal(host).textContent).toBe(`1h${THIN}47m`);

      harness.advance(SECOND);
      harness.clock.tick();

      expect(taskTotal(host).textContent).toBe(`1h${THIN}48m`);
      expect(observer.takeRecords().length).toBeGreaterThan(0);
    } finally {
      observer.disconnect();
    }
  });

  /** Two timers left running by the skip policy, one on the resume target and one elsewhere. */
  const TWO_RUNNING = [
    '- [ ] Write report',
    '  - 2026-09-18T13:05:32+03:00 \u2192',
    '- [ ] Review PR',
    '  - 2026-09-18T13:35:32+03:00 \u2192',
    '',
  ].join('\n');

  it('speaks for the current task while the day keeps every open timer', async () => {
    const harness = await widgetFor(TWO_RUNNING);
    const { host } = harness;

    // The resume target is the newest open timer, so the rail reads its half hour alone while the
    // day the list heads up carries both.
    expect(taskTotal(host).textContent).toBe('30m');
    taskTotal(host).click();
    // The list has the room the rail has not, so its own numbers keep the ordinary space.
    expect(dayHeadings(harness.layout)).toEqual([['Today', '1h 30m']]);

    harness.advance(2 * MINUTE);
    harness.clock.tick();

    // Two minutes on the task, four on the day, because both timers kept counting.
    expect(taskTotal(host).textContent).toBe('32m');
    expect(dayHeadings(harness.layout)).toEqual([['Today', '1h 34m']]);
  });

  it('opens and closes the tracked list from the number', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const number = taskTotal(harness.host);
    expect(number.getAttribute('aria-haspopup')).toBe('dialog');
    expect(number.getAttribute('aria-expanded')).toBe('false');

    number.click();

    expect(harness.layout.querySelector('.abyss-time-tracking-popover--tasks')).not.toBeNull();
    expect(number.getAttribute('aria-expanded')).toBe('true');

    number.click();

    expect(harness.layout.querySelector('.abyss-time-tracking-popover--tasks')).toBeNull();
    expect(number.getAttribute('aria-expanded')).toBe('false');
  });

  it('pauses the running task from the rail', async () => {
    const harness = await widgetFor(WORKING_WEEK);

    toggle(harness.host).click();
    await flushMicrotasks();

    expect(await harness.read()).toContain(`  - 2026-09-18T12:18:32+03:00 → ${NOW_ATOM}\n`);
    expect(harness.host.classList.contains('is-tracking')).toBe(false);
    expect(toggle(harness.host).title).toBe('Resume Write report');
    expect(taskTotal(harness.host).textContent).toBe(`1h${THIN}47m`);
    expect(harness.reported).toEqual([]);
  });

  it('resumes the task that was tracked most recently', async () => {
    const harness = await widgetFor(YESTERDAY_ONLY);

    toggle(harness.host).click();
    await flushMicrotasks();

    expect(await harness.read()).toContain(`  - ${NOW_ATOM} →\n`);
    expect(harness.host.classList.contains('is-tracking')).toBe(true);
    expect(toggle(harness.host).title).toBe('Pause Write report');
  });

  it('refuses to resume a task that has since been finished', async () => {
    const { host } = await widgetFor(
      ['- [x] Write report', '  - 2026-09-17T09:00:00+03:00 → 2026-09-17T15:30:00+03:00', ''].join(
        '\n',
      ),
    );

    expect(host.hidden).toBe(false);
    expect(toggle(host).disabled).toBe(true);
    expect(toggle(host).title).toBe('The last tracked task is already finished');
  });

  it('starts the day again at local midnight', async () => {
    const harness = await widgetFor(
      [
        '- [ ] Write report',
        '  - 2026-09-18T13:05:32+03:00 →',
        '- [ ] Review PR',
        '  - 2026-09-18T08:00:00+03:00 → 2026-09-18T08:30:00+03:00',
        '',
      ].join('\n'),
    );

    expect(taskTotal(harness.host).textContent).toBe('1h');
    // 2026-09-19T00:00:00+03:00 is nine hours, fifty-four minutes and twenty-eight seconds away.
    expect(harness.clock.delays()).toEqual([9 * HOUR + 54 * MINUTE + 28 * SECOND]);

    harness.advance(9 * HOUR + 54 * MINUTE + 28 * SECOND + MINUTE);
    harness.clock.fireTimeouts();

    expect(taskTotal(harness.host).textContent).toBe('1m');
  });

  it('questions a timer that has been running for half a day', async () => {
    const { host } = await widgetFor(
      ['- [ ] Write report', '  - 2026-09-18T02:00:00+03:00 →', ''].join('\n'),
    );

    expect(host.classList.contains('is-stale')).toBe(true);
    expect(toggle(host).title).toBe('Still tracking since 02:00?');
    expect(toggle(host).getAttribute('aria-label')).toBe('Pause Write report');
  });

  it('releases every timer and subscription it owns', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    expect(harness.clock.ticking()).toBe(true);
    expect(harness.clock.pending()).toBe(1);
    // The shared ticker holds one; the widget's own model subscription is the other.
    expect(harness.subscribers()).toBe(2);

    harness.widget.destroy();

    expect(harness.clock.ticking()).toBe(false);
    expect(harness.clock.pending()).toBe(0);
    expect(harness.subscribers()).toBe(1);
    expect(harness.host.childElementCount).toBe(0);

    harness.advance(MINUTE);
    harness.index.installCommittedContent('tasks.md', `\n${EMPTY_VAULT}`);
    await flushMicrotasks();

    expect(harness.host.childElementCount).toBe(0);
  });

  it('reads the clock once per index event and once per tick', async () => {
    const harness = await widgetFor(WORKING_WEEK);
    const mounted = harness.contextReads();

    harness.advance(SECOND);
    harness.clock.tick();

    expect(harness.contextReads()).toBe(mounted + 1);

    toggle(harness.host).click();
    await flushMicrotasks();

    // One repaint per index event: the shared ticker also emits on an index change, and a surface
    // that painted from both would show the stale model for an instant and write the DOM twice.
    expect(harness.contextReads()).toBe(mounted + 2);
    expect(toggle(harness.host).title).toBe('Resume Write report');
  });

  it('leaves the widget alone when another file changes', async () => {
    const harness = await widgetFor(WORKING_WEEK, { 'notes.md': '\n- [ ] Unrelated\n' });
    taskTotal(harness.host).click();
    const row = query(harness.layout, '.abyss-tracked-row', 'Missing a row');
    const observer = new MutationObserver(() => {});
    observer.observe(harness.host, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    try {
      harness.index.installCommittedContent('notes.md', '\n- [ ] Unrelated again\n');
      await flushMicrotasks();

      expect(observer.takeRecords()).toEqual([]);
      // The entries came back identical, so the day list was never regrouped or rebuilt.
      expect(query(harness.layout, '.abyss-tracked-row', 'Missing a row')).toBe(row);
    } finally {
      observer.disconnect();
    }
  });
});
