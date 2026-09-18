import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
import { TaskModal } from '../src/ui/TaskModal';
import { rebuildTaskSelection, rootTaskRef } from '../src/ui/taskSelection';
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

function selectionState(stack: TrackingStack, title: string): AppState {
  const located = expectDefined(
    stack.index.listNodes().find(({ node }) => node.title === title),
    `Missing ${title}`,
  );
  const state = new AppState();
  state.set('taskStack', [located.root, ...located.path]);
  return state;
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

function mountInspector(stack: TrackingStack, state: AppState, win: Window = window) {
  const reported: TaskCommandResult[] = [];
  const ticker = new TrackingTicker({
    queries: stack.tasks.queries,
    now: stack.now,
    win,
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
  // The owning view converges the selection on every index change; the inspector alone does not.
  const off = stack.tasks.queries.subscribe(() => {
    const current = state.get('taskStack');
    const root = current[0];
    if (root === undefined) return;
    const resolution = stack.tasks.queries.resolve(rootTaskRef(root));
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return;
    const task = resolution.type === 'exact' ? resolution.task : resolution.current;
    state.updateInspectorSelection(rebuildTaskSelection(task, current));
  });
  cleanups.push(() => {
    off();
    panel.destroy();
    ticker.destroy();
  });
  return { panel, el, ticker, reported };
}

async function inspector(markdown: string, selected = 'Current', win?: Window) {
  const stack = await trackingStack(markdown);
  const state = selectionState(stack, selected);
  return { ...stack, ...mountInspector(stack, state, win), state };
}

function badge(el: HTMLElement): HTMLElement {
  return expectDefined(
    el.querySelector<HTMLElement>('.abyss-chips-row .abyss-time-badge'),
    'Missing tracked time badge',
  );
}

function body(el: HTMLElement): HTMLButtonElement {
  return expectDefined(badge(el).querySelector<HTMLButtonElement>('.abyss-time-badge-body'));
}

function toggle(el: HTMLElement): HTMLButtonElement {
  return expectDefined(badge(el).querySelector<HTMLButtonElement>('.abyss-time-badge-toggle'));
}

const UNTRACKED = '- [ ] Current\n';
const CLOSED_SESSIONS = [
  '- [ ] Current',
  '  - 2026-09-18T09:12:00+03:00 → 2026-09-18T10:32:00+03:00',
  '  - [ ] Child',
  '    - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:15:00+03:00',
  '',
].join('\n');
const RUNNING_SESSION = ['- [ ] Current', '  - 2026-09-18T12:30:32+03:00 →', ''].join('\n');

describe('inspector tracked time badge', () => {
  it('shows no tracked time and a start control for an untracked task', async () => {
    const { el } = await inspector(UNTRACKED);

    expect(badge(el).classList.contains('is-tracking')).toBe(false);
    expect(body(el).textContent).toBe('0m');
    expect(body(el).getAttribute('aria-label')).toBe('Tracked time 0m');
    expect(body(el).getAttribute('aria-haspopup')).toBe('dialog');
    expect(body(el).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(el).getAttribute('aria-label')).toBe('Start tracking');
    expect(toggle(el).disabled).toBe(false);
  });

  it('sums the node and its sub-tasks over all time', async () => {
    const { el } = await inspector(CLOSED_SESSIONS);

    expect(body(el).textContent).toBe('1h35m');
    expect(body(el).getAttribute('aria-label')).toBe('Tracked time 1h35m');
  });

  it('refuses to track a finished task', async () => {
    const { el } = await inspector('- [x] Current\n');

    expect(toggle(el).disabled).toBe(true);
    expect(toggle(el).title).toBe('Finished tasks cannot be tracked');
  });

  it('opens a session from the badge and closes it again', async () => {
    const harness = await inspector(UNTRACKED);

    toggle(harness.el).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(`- [ ] Current\n  - ${NOW_ATOM} →\n`);
    expect(badge(harness.el).classList.contains('is-tracking')).toBe(true);
    expect(toggle(harness.el).getAttribute('aria-label')).toBe('Pause tracking');
    expect(body(harness.el).textContent).toBe('0m');

    harness.advance(2 * MINUTE);
    toggle(harness.el).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(
      `- [ ] Current\n  - ${NOW_ATOM} → 2026-09-18T14:07:32+03:00\n`,
    );
    expect(badge(harness.el).classList.contains('is-tracking')).toBe(false);
    expect(toggle(harness.el).getAttribute('aria-label')).toBe('Start tracking');
    expect(body(harness.el).textContent).toBe('2m');
    expect(harness.reported).toEqual([]);
  });

  it('can be started on a sub-task', async () => {
    const harness = await inspector('- [ ] Current\n  - [ ] Child\n', 'Child');

    toggle(harness.el).click();
    await flushMicrotasks();

    expect(await harness.read()).toBe(`- [ ] Current\n  - [ ] Child\n    - ${NOW_ATOM} →\n`);
  });

  it('rewrites the running total only when its displayed minute changes', async () => {
    const clock = fakeTickWindow();
    const harness = await inspector(RUNNING_SESSION, 'Current', clock.win);
    expect(body(harness.el).textContent).toBe('1h35m');
    const observer = new MutationObserver(() => {});
    observer.observe(body(harness.el), { characterData: true, childList: true, subtree: true });
    try {
      for (let second = 0; second < 59; second++) {
        harness.advance(1000);
        clock.tick();
      }
      expect(observer.takeRecords()).toEqual([]);
      expect(body(harness.el).textContent).toBe('1h35m');

      harness.advance(1000);
      clock.tick();

      expect(body(harness.el).textContent).toBe('1h36m');
      expect(observer.takeRecords().length).toBeGreaterThan(0);
    } finally {
      observer.disconnect();
    }
  });

  it('releases the shared ticker when the inspector is destroyed', async () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const harness = await inspector(RUNNING_SESSION);
    const started = expectDefined(setInterval.mock.results[0], 'The badge never started the tick');

    harness.panel.destroy();

    expect(clearInterval).toHaveBeenCalledWith(started.value);
  });

  it('shows the same badge inside the task modal', async () => {
    const stack = await trackingStack(CLOSED_SESSIONS);
    const root = expectDefined(stack.index.list()[0], 'Missing root task');
    const modal = new TaskModal(
      stack.app,
      stack.statusRegistry,
      DEFAULT_SETTINGS,
      stack.index,
      stack.tasks,
    );
    cleanups.push(() => {
      modal.close();
    });

    modal.open(root);
    const el = expectDefined(
      activeDocument.body.querySelector<HTMLElement>('.abyss-modal'),
      'Missing modal',
    );
    expect(body(el).textContent).toBe('1h35m');

    toggle(el).click();
    await flushMicrotasks();

    expect(await stack.read()).toContain(`  - ${NOW_ATOM} →\n`);
    expect(badge(el).classList.contains('is-tracking')).toBe(true);
  });
});
