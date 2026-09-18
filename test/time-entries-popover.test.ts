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

function affects(event: TaskIndexEvent, path: string): boolean {
  if (event.type === 'initialized') return true;
  if (event.type === 'changed') return event.files.includes(path);
  if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
  return event.path === path;
}

const ELSEWHERE = '- [ ] Elsewhere\n';

async function inspector(markdown = SESSIONS, selected = 'Current') {
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
    expect(rowShape(expectDefined(rows(harness.el)[1])).range).toBe('Today 11:00 → 11:15');

    harness.advance(10 * 3_600_000);
    await harness.touchOtherFile();

    expect(rowShape(expectDefined(rows(harness.el)[1])).range).toBe('Yesterday 11:00 → 11:15');
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

  it('places a second undo row where its own row was', async () => {
    const harness = await inspector();
    open(harness.el);
    // The first undo row sits above the second removal, so it moves that row's place by one.
    expectDefined(
      rows(harness.el)[1]?.querySelector<HTMLButtonElement>('.abyss-time-row-remove'),
    ).click();
    await flushMicrotasks();
    const second = expectDefined(rows(harness.el)[2], 'Missing the second row to remove');
    expect(rowShape(second).range).toBe('Yesterday 18:40 → 18:55');

    expectDefined(second.querySelector<HTMLButtonElement>('.abyss-time-row-remove')).click();
    await flushMicrotasks();

    const undoRows = popover(harness.el).querySelectorAll('.abyss-undo-row');
    expect(undoRows).toHaveLength(1);
    expect([...popover(harness.el).children].indexOf(expectDefined(undoRows[0]))).toBe(2);
  });
});
