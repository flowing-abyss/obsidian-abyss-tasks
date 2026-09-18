import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskCommandResult } from '../src/tasks';
import { systemClock } from '../src/tasks/domain/clock';
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

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function inspector(markdown = SESSIONS, selected = 'Current') {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const content = `\n${markdown}`;
  const app = await createAppWithFiles({ 'tasks.md': content });
  const nowMs = NOW_MS;
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS, {
    authority: true,
    clock: systemClock(
      () => nowMs,
      () => OFFSET_MINUTES,
    ),
  });
  await stack.index.initialize();
  stack.index.installCommittedContent('tasks.md', content);
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
    win: window,
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
    select: (title: string) => {
      const next = located(title);
      state.updateInspectorSelection([next.root, ...next.path]);
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
    node: text(row, '.abyss-time-row-node'),
    tail: text(row, '.abyss-time-row-tail'),
  };
}

/** Reads a rendered row duration back into the whole minutes the badge total floors to. */
function minutesOf(duration: string): number {
  const clock = /^\+(\d+):(\d{2}):\d{2}$/u.exec(duration);
  if (clock !== null) return Number(clock[1]) * 60 + Number(clock[2]);
  const compact = /^\+(?:(\d+)h)?(?:(\d+)m)?$/u.exec(duration);
  if (compact === null) throw new Error(`Unreadable duration ${duration}`);
  return Number(compact[1] ?? 0) * 60 + Number(compact[2] ?? 0);
}

describe('tracked sessions popover', () => {
  it('lists every session in the subtree, newest first', async () => {
    const harness = await inspector();
    open(harness.el);

    const listed = rows(harness.el).map(rowShape);

    expect(listed).toEqual([
      { duration: '+1:35:32', range: 'Today 12:30 →', node: '', tail: '' },
      { duration: '+15m', range: 'Today 11:00 → 11:15', node: 'Child', tail: '' },
      { duration: '+1h20m', range: 'Today 09:12 → 10:32', node: '', tail: '' },
      {
        duration: '+15m',
        range: 'Yesterday 18:40 → 18:55',
        node: '',
        tail: 'call with Bob',
      },
      { duration: '', range: '2026-09-16 14:05 → 13:20', node: '', tail: '' },
    ]);
    expect(rows(harness.el)[0]?.classList.contains('is-tracking')).toBe(true);
    expect(rows(harness.el)[4]?.querySelector('.abyss-time-row-warning')).not.toBeNull();
    expect(
      expectDefined(harness.el.querySelector('.abyss-time-badge-body')).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
  });

  it('adds every valid row up to the badge total', async () => {
    const harness = await inspector();
    open(harness.el);
    const listed = rows(harness.el)
      .map(rowShape)
      .filter((row) => row.duration !== '');

    const total = listed.reduce((sum, row) => sum + minutesOf(row.duration), 0);

    expect(total).toBe(205);
    expect(harness.el.querySelector('.abyss-time-badge-body')?.textContent).toBe('3h25m');
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
    expect([...popover(harness.el).children].indexOf(undoRow)).toBe(2);

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
});
