import { Menu, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult } from '../src/tasks';
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

interface CapturedMenuItem {
  icon__: string;
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

describe('list card tracked time indicator', () => {
  it('stays away from a task with no tracked time', async () => {
    const harness = await center(UNTRACKED);

    expect(timeBadge(cardFor(harness.el, 'Alpha'))).toBeNull();
  });

  it('shows the subtree total with the shared count badge family', async () => {
    const harness = await center(CLOSED_SESSIONS);

    const badge = expectDefined(timeBadge(cardFor(harness.el, 'Alpha')));
    expect(badge.classList.contains('abyss-task-count-badge')).toBe(true);
    expect(badge.textContent).toContain('1h35m');
    expect(badge.classList.contains('is-tracking')).toBe(false);
    expect(timeBadge(cardFor(harness.el, 'Beta'))).toBeNull();
  });

  it('marks the running card and advances it on the shared tick', async () => {
    const clock = fakeTickWindow();
    const harness = await center(RUNNING_SESSION, clock.win);

    const badge = expectDefined(timeBadge(cardFor(harness.el, 'Alpha')));
    expect(badge.classList.contains('is-tracking')).toBe(true);
    expect(badge.dataset['trackingRoot']).toBeDefined();
    expect(badge.textContent).toContain('1h35m');

    harness.advance(MINUTE);
    clock.tick();

    expect(expectDefined(timeBadge(cardFor(harness.el, 'Alpha'))).textContent).toContain('1h36m');
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
});

describe('task card tracking menu item', () => {
  it('starts tracking the task it was opened on', async () => {
    const harness = await center(UNTRACKED);

    const item = expectDefined(trackingItem(openCardMenu(cardFor(harness.el, 'Beta'))));
    expect(item.title__).toBe('Start tracking');
    expect(item.icon__).toBe('play');
    expect(item.section__).toBe('actions');

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

  it('leaves a finished task alone', async () => {
    const harness = await center('- [x] Alpha\n');

    expect(trackingItem(openCardMenu(cardFor(harness.el, 'Alpha')))).toBeUndefined();
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
