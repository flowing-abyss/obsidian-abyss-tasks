import { Menu, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { taskNodeAddress, type TaskCommandResult } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
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
/** 2026-09-18T14:05:32+03:00, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 11, 5, 32);
const NOW_ATOM = '2026-09-18T14:05:32+03:00';
const MINUTE = 60_000;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

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

type TrackingStack = Awaited<ReturnType<typeof trackingStack>>;

/**
 * A tick the test drives, because a real interval survives a later switch to fake timers. The
 * ticker runs its interval only while somebody is listening, so `running` also reports whether the
 * surface under test still holds a subscription.
 */
function fakeTickWindow(): { readonly win: Window; tick(): void; running(): boolean } {
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
    running: () => scheduled !== undefined,
  };
}

interface CapturedMenuItem {
  icon__: string;
  menu__: Menu;
  onClick__: ((event: MouseEvent) => unknown) | null;
  section__: string;
  title__: string;
}

function captureMenu(): CapturedMenuItem[] {
  const items: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
    const item = {
      dom: createDiv(),
      icon__: '',
      menu__: this,
      onClick__: null as ((event: MouseEvent) => unknown) | null,
      section__: '',
      title__: '',
      onClick(value: (event: MouseEvent) => unknown) {
        this.onClick__ = value;
        return this;
      },
      setChecked() {
        return this;
      },
      setDisabled() {
        return this;
      },
      setIcon(value: string) {
        this.icon__ = value;
        return this;
      },
      setSection(value: string) {
        this.section__ = value;
        return this;
      },
      setSubmenu() {
        return new Menu();
      },
      setTitle(value: string) {
        this.title__ = value;
        return this;
      },
      setWarning() {
        return this;
      },
    };
    callback(item as never);
    items.push(item);
    return this;
  });
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    return this;
  });
  return items;
}

/**
 * The items the opened menu added itself. A submenu is a menu of its own, and the priority and
 * status levels under it are recorded in the same list, so they are told apart by the menu each
 * item was added to. `Today` is the first item the card menu adds, which names that menu.
 */
function ownItems(items: readonly CapturedMenuItem[]): CapturedMenuItem[] {
  const menu = items.find((item) => item.title__ === 'Today')?.menu__;
  return items.filter((item) => item.menu__ === menu);
}

function trackingItem(items: readonly CapturedMenuItem[]): CapturedMenuItem | undefined {
  return items.find(
    (item) => item.title__ === 'Start tracking' || item.title__ === 'Pause tracking',
  );
}

function mountCenter(stack: TrackingStack, win: Window = window) {
  const state = new AppState();
  state.set('selectedList', { type: 'project', path: 'tasks.md' });
  const reported: TaskCommandResult[] = [];
  const ticker = new TrackingTicker({ queries: stack.tasks.queries, now: stack.now, win });
  const panel = new CenterPanel(
    state,
    stack.app,
    DEFAULT_SETTINGS,
    stack.tasks.queries,
    stack.statusRegistry,
    undefined,
    null,
    null,
    stack.tasks,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ticker,
      actions: createTrackingActions(stack.tasks, (result) => reported.push(result)),
      context: () => ({ nowMs: stack.now(), offsetAt: () => OFFSET_MINUTES }),
    },
  );
  const el = activeDocument.body.createDiv();
  panel.mount(el);
  // Every status group is allowed so a done task still has a card to right-click.
  state.set('centerListViewState', {
    groupBy: 'none',
    sortBy: { field: 'date', dir: 'asc' },
    filters: [],
    statusGroups: [],
  });
  panel.refresh();
  // What the owning view does on an index change.
  const off = stack.tasks.queries.subscribe(() => {
    panel.refresh();
  });
  cleanups.push(() => {
    off();
    panel.destroy();
    ticker.destroy();
  });
  return { panel, el, state, ticker, reported };
}

async function center(markdown: string, win?: Window) {
  const stack = await trackingStack(markdown);
  return { ...stack, ...mountCenter(stack, win) };
}

function cards(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('.abyss-task-card')];
}

function cardFor(el: HTMLElement, title: string): HTMLElement {
  return expectDefined(
    cards(el).find((card) => card.textContent.includes(title)),
    `Missing a card for ${title}`,
  );
}

function timeBadge(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('.abyss-task-time-badge');
}

function openCardMenu(card: HTMLElement): CapturedMenuItem[] {
  const items = captureMenu();
  const OwnerMouseEvent = card.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  card.dispatchEvent(new OwnerMouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return items;
}

const UNTRACKED = ['- [ ] Alpha', '- [ ] Beta', ''].join('\n');
const CLOSED_SESSIONS = [
  '- [ ] Alpha',
  '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
  '  - [ ] Child',
  '    - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:15:00+03:00',
  '- [ ] Beta',
  '',
].join('\n');
const RUNNING_SESSION = ['- [ ] Alpha', '  - 2026-09-18T12:30:32+03:00 →', '- [ ] Beta', ''].join(
  '\n',
);
const RUNNING_CHILD_SESSION = [
  '- [ ] Alpha',
  '  - [ ] Child',
  '    - 2026-09-18T12:30:32+03:00 →',
  '- [ ] Beta',
  '',
].join('\n');

describe('list card tracked time indicator', () => {
  it('stays away from a task with no tracked time', async () => {
    const harness = await center(UNTRACKED);

    expect(timeBadge(cardFor(harness.el, 'Alpha'))).toBeNull();
  });

  it('shows the subtree total with the shared count badge family', async () => {
    const harness = await center(CLOSED_SESSIONS);

    const badge = expectDefined(timeBadge(cardFor(harness.el, 'Alpha')));
    expect(badge.classList.contains('abyss-task-count-badge')).toBe(true);
    expect(badge.textContent).toContain('1h 35m');
    expect(badge.classList.contains('is-tracking')).toBe(false);
    expect(timeBadge(cardFor(harness.el, 'Beta'))).toBeNull();
  });

  it('marks the running card and advances it on the shared tick', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_SESSION, clock.win);

    const badge = expectDefined(timeBadge(cardFor(harness.el, 'Alpha')));
    expect(badge.classList.contains('is-tracking')).toBe(true);
    expect(badge.dataset['trackingRoot']).toBeDefined();
    expect(badge.textContent).toContain('1h 35m');

    harness.advance(MINUTE);
    clock.tick();

    expect(expectDefined(timeBadge(cardFor(harness.el, 'Alpha'))).textContent).toContain('1h 36m');
  });

  it('rewrites a running card only when its displayed minute changes', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_SESSION, clock.win);
    const observer = new MutationObserver(() => {});
    observer.observe(harness.el, { characterData: true, childList: true, subtree: true });
    try {
      for (let second = 0; second < 59; second++) {
        harness.advance(1000);
        clock.tick();
      }
      expect(observer.takeRecords()).toEqual([]);

      harness.advance(1000);
      clock.tick();

      expect(observer.takeRecords().length).toBeGreaterThan(0);
    } finally {
      observer.disconnect();
    }
  });

  it('advances the root card when the running entry belongs to a sub-task', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_CHILD_SESSION, clock.win);
    const root = expectDefined(
      harness.index.listNodes().find(({ node }) => node.title === 'Alpha'),
      'Missing Alpha',
    ).root;

    const badge = expectDefined(timeBadge(cardFor(harness.el, 'Alpha')));
    expect(badge.dataset['trackingRoot']).toBe(taskNodeAddress({ type: 'task', ref: root.ref }));
    expect(badge.classList.contains('is-tracking')).toBe(true);
    expect(badge.textContent).toContain('1h 35m');

    harness.advance(MINUTE);
    clock.tick();

    expect(expectDefined(timeBadge(cardFor(harness.el, 'Alpha'))).textContent).toContain('1h 36m');
  });

  it('releases its tick subscription when the panel is destroyed', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_SESSION, clock.win);
    expect(clock.running()).toBe(true);

    harness.panel.destroy();

    // The ticker runs its interval only while a listener remains, so a stopped one proves the
    // panel was its only listener and released that listener exactly once.
    expect(clock.running()).toBe(false);
  });

  it('keeps exactly one tick subscription across a remount', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_SESSION, clock.win);

    harness.panel.mount(activeDocument.body.createDiv());
    expect(clock.running()).toBe(true);
    harness.panel.destroy();

    expect(clock.running()).toBe(false);
  });
});

describe('task card tracking menu item', () => {
  it('starts tracking the task it was opened on', async () => {
    const harness = await center(UNTRACKED);

    const item = expectDefined(trackingItem(openCardMenu(cardFor(harness.el, 'Beta'))));
    expect(item.title__).toBe('Start tracking');
    expect(item.icon__).toBe('play');
    expect(item.section__).toBe('tracking');

    item.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();

    expect(await harness.read()).toBe(`- [ ] Alpha\n- [ ] Beta\n  - ${NOW_ATOM} →\n`);
  });

  it('pauses the running task', async () => {
    const harness = await center(RUNNING_SESSION);

    const item = expectDefined(trackingItem(openCardMenu(cardFor(harness.el, 'Alpha'))));
    expect(item.title__).toBe('Pause tracking');
    expect(item.icon__).toBe('pause');

    item.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();

    expect(await harness.read()).toBe(
      `- [ ] Alpha\n  - 2026-09-18T12:30:32+03:00 → ${NOW_ATOM}\n- [ ] Beta\n`,
    );
    expect(harness.reported).toEqual([]);
  });

  it('stands alone between the due presets and the rest of the menu', async () => {
    const harness = await center(UNTRACKED);

    const items = openCardMenu(cardFor(harness.el, 'Beta'));

    // Obsidian groups the menu by section and orders the sections by where each one was first
    // asked for, so what arranges the menu is the order the items were added together with the
    // section each named. The mock records both and reorders neither, so both are read here.
    expect(ownItems(items).map((item) => [item.title__, item.section__])).toEqual([
      ['Today', 'today'],
      ['Tomorrow', 'today'],
      ['Start tracking', 'tracking'],
      ['Set date…', 'actions'],
      ['Priority', 'priority'],
      ['Status', 'priority'],
      ['Filter by this priority', 'priority'],
      ['Filter by this status', 'priority'],
      ['Set tag…', 'actions'],
      ['Edit repeat…', 'actions'],
      ['Open in note', 'actions'],
      ['Delete', 'danger'],
    ]);
  });

  it('leaves a finished task alone', async () => {
    const harness = await center('- [x] Alpha\n');

    const items = openCardMenu(cardFor(harness.el, 'Alpha'));

    expect(trackingItem(items)).toBeUndefined();
    // An empty section would still draw its separator, so the section exists only where the item
    // does.
    expect(items.some((item) => item.section__ === 'tracking')).toBe(false);
  });

  it('still offers to pause a finished task whose sub-task is running', async () => {
    const harness = await center(
      ['- [x] Alpha', '  - [ ] Child', '    - 2026-09-18T12:30:32+03:00 →', ''].join('\n'),
    );

    expect(expectDefined(trackingItem(openCardMenu(cardFor(harness.el, 'Alpha')))).title__).toBe(
      'Pause tracking',
    );
  });

  it('stays out of the bulk selection menu', async () => {
    const harness = await center(UNTRACKED);
    for (const card of cards(harness.el)) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }

    const items = openCardMenu(cardFor(harness.el, 'Beta'));

    expect(items.some((item) => item.title__ === '2 tasks selected')).toBe(true);
    expect(trackingItem(items)).toBeUndefined();
  });

  it('stays out of the bulk menu while one of the selected tasks is running', async () => {
    const harness = await center(RUNNING_SESSION);
    for (const card of cards(harness.el)) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }

    const items = openCardMenu(cardFor(harness.el, 'Alpha'));

    // A timer belongs to one task, so the bulk menu offers neither half of the pair, and the
    // section it would sit in is never registered either.
    expect(items.some((item) => item.title__ === '2 tasks selected')).toBe(true);
    expect(trackingItem(items)).toBeUndefined();
    expect(items.some((item) => item.section__ === 'tracking')).toBe(false);
  });
});

function mountInspector(stack: TrackingStack, title: string) {
  const located = expectDefined(
    stack.index.listNodes().find(({ node }) => node.title === title),
    `Missing ${title}`,
  );
  const state = new AppState();
  state.set('taskStack', [located.root, ...located.path]);
  const reported: TaskCommandResult[] = [];
  const ticker = new TrackingTicker({
    queries: stack.tasks.queries,
    now: stack.now,
    win: window,
  });
  const panel = new RightPanel(
    state,
    stack.app,
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
      context: () => ({ nowMs: stack.now(), offsetAt: () => OFFSET_MINUTES }),
    },
  );
  const el = activeDocument.body.createDiv();
  panel.mount(el);
  cleanups.push(() => {
    panel.destroy();
    ticker.destroy();
  });
  return { panel, el, state, reported };
}

async function inspector(markdown: string, title = 'Alpha') {
  const stack = await trackingStack(markdown);
  return { ...stack, ...mountInspector(stack, title) };
}

function inspectorMenuItems(el: HTMLElement): HTMLElement[] {
  expectDefined(el.querySelector<HTMLButtonElement>('.abyss-right-action-btn')).click();
  return [...el.querySelectorAll<HTMLElement>('.abyss-task-context-menu .abyss-context-item')];
}

function inspectorItem(el: HTMLElement, text: string): HTMLElement | undefined {
  return inspectorMenuItems(el).find((item) => item.textContent === text);
}

describe('inspector context menu tracking item', () => {
  it('starts tracking the selected task', async () => {
    const harness = await inspector(UNTRACKED);

    expectDefined(inspectorItem(harness.el, 'Start tracking')).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(`- [ ] Alpha\n  - ${NOW_ATOM} →\n- [ ] Beta\n`);
  });

  it('starts tracking the selected sub-task', async () => {
    const harness = await inspector('- [ ] Alpha\n  - [ ] Child\n', 'Child');

    expectDefined(inspectorItem(harness.el, 'Start tracking')).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(`- [ ] Alpha\n  - [ ] Child\n    - ${NOW_ATOM} →\n`);
  });

  it('pauses the running selection', async () => {
    const harness = await inspector(RUNNING_SESSION);

    expectDefined(inspectorItem(harness.el, 'Pause tracking')).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(
      `- [ ] Alpha\n  - 2026-09-18T12:30:32+03:00 → ${NOW_ATOM}\n- [ ] Beta\n`,
    );
    expect(harness.reported).toEqual([]);
  });

  it('leaves a finished selection alone', async () => {
    const harness = await inspector('- [x] Alpha\n');

    expect(inspectorItem(harness.el, 'Start tracking')).toBeUndefined();
    expect(inspectorItem(harness.el, 'Pause tracking')).toBeUndefined();
  });
});
