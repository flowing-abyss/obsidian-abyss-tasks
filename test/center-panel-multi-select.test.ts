import { Component, MarkdownRenderer, Menu } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { TagManager } from '../src/tags/TagManager';
import {
  taskNodeAddress,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskRef,
  type TaskSnapshot,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { clockFrom } from '../src/tasks/domain/clock';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import {
  appWithFiles,
  canonicalStatusCatalog,
  deferred,
  dispatchImeKey,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  makeStubStore,
  methodOf,
  task,
  useRealMoment,
} from './helpers';
import { makeCenterPanelForTest, taskCommandsOf } from './support/panelHarness';
import { hierarchyHarness } from './support/taskHierarchyHarness';
import { prepareTaskPanelViewport, taskListRect } from './support/taskPanelViewport';
import { canonicalSearchForIndex } from './support/taskSearchHarness';
import { mountCanonicalSearchUi, searchUiCompleted } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';
import { VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS } from './support/timeouts';
import { runVirtualSurfaceAuditCycles } from './support/virtualSurfaceAudit';
import { recordVirtualSurfaceResources } from './support/virtualSurfaceResources';
import { taskKeys } from './task-list-row-assertions';

useRealMoment();

const viewportFrames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  viewportFrames.clear();
  let frame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    viewportFrames.set(++frame, callback);
    return frame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    viewportFrames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
function flushViewport(): void {
  const frames = [...viewportFrames.values()];
  viewportFrames.clear();
  for (const callback of frames) callback(0);
}

afterEach(() => {
  activeDocument.querySelectorAll('.abyss-test-center-attached').forEach((element) => {
    element.remove();
  });
});

function makeCenter(
  tasks: TaskSnapshot[],
  application?: TaskApplicationApi,
  tracking = false,
): {
  el: HTMLElement;
  state: AppState;
  panel: CenterPanel;
  ticker: TrackingTicker | undefined;
} {
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const save = vi.fn().mockResolvedValue(undefined);
  const settings = {
    ...DEFAULT_SETTINGS,
    inbox: { mode: 'tag' as const, tag: '#task/inbox', removeTagOnAssign: true },
  };
  const tm = new TagManager(null as never, settings, save, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const store = makeStubStore(tasks);
  const ticker = tracking
    ? new TrackingTicker({ queries: store.queries, now: () => 60000, win: window })
    : undefined;
  const panel = makeCenterPanelForTest(
    state,
    store,
    appWithFiles({}),
    settings,
    tm,
    undefined,
    undefined,
    undefined,
    application,
    ticker === undefined
      ? undefined
      : {
          ticker,
          context: () => ({ nowMs: 60000, offsetAt: () => 0 }),
          actions: {
            start: async () => {},
            pause: async () => {},
            remove: async () => undefined,
            restore: async () => ({ type: 'ok', outcome: { type: 'stopped' }, changed: false }),
          },
        },
  );
  const el = freshContainer();
  attach(el);
  panel.mount(el);
  return { el, state, panel, ticker };
}

function cards(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card'));
}

function click(card: HTMLElement, init: MouseEventInit = {}): void {
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
}

function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function selectedLines(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card.abyss-multi-selected')).map(
    (card) => card.dataset['line'] ?? '',
  );
}

function attach(el: HTMLElement): void {
  el.addClass('abyss-test-center-attached');
  activeDocument.body.append(el);
}

/** Renders a project's task list into the panel through the entry a project dashboard calls. */
function renderDashboardList(panel: CenterPanel, el: HTMLElement, path: string): HTMLElement {
  const host = el.createDiv({ cls: 'abyss-project-tasks' });
  (
    panel as unknown as { renderProjectTasks_abyssPrivate(host: HTMLElement, path: string): void }
  ).renderProjectTasks_abyssPrivate(host, path);
  return host;
}

describe('CenterPanel multi-selection', () => {
  const t1 = task({
    status: 'open',
    tags: ['#task/inbox'],
    source: {
      filePath: 'a.md',
      line: 0,
      originalMarkdown: '- [ ] Task 1 #task/inbox',
      originalBlock: '- [ ] Task 1 #task/inbox',
    },
  });
  const t2 = task({
    status: 'open',
    tags: ['#task/inbox'],
    source: {
      filePath: 'a.md',
      line: 1,
      originalMarkdown: '- [ ] Task 2 #task/inbox',
      originalBlock: '- [ ] Task 2 #task/inbox',
    },
  });
  const t3 = task({
    status: 'open',
    tags: ['#task/inbox'],
    source: {
      filePath: 'a.md',
      line: 2,
      originalMarkdown: '- [ ] Task 3 #task/inbox',
      originalBlock: '- [ ] Task 3 #task/inbox',
    },
  });

  it('plain click selects only one card (no abyss-multi-selected)', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(expectDefined(cards[0]).classList.contains('abyss-multi-selected')).toBe(false);
    expect(expectDefined(cards[1]).classList.contains('abyss-multi-selected')).toBe(false);
  });

  it('mounts one delete button only on the active root task', () => {
    const { el, state } = makeCenter([t1, t2]);
    const [first, second] = cards(el);

    expect(el.querySelectorAll('.abyss-task-delete-btn')).toHaveLength(0);

    click(expectDefined(first));
    expect(expectDefined(first).querySelector('.abyss-task-delete-btn')).not.toBeNull();
    expect(expectDefined(second).querySelector('.abyss-task-delete-btn')).toBeNull();

    click(expectDefined(second));
    expect(expectDefined(first).querySelector('.abyss-task-delete-btn')).toBeNull();
    expect(expectDefined(second).querySelector('.abyss-task-delete-btn')).not.toBeNull();
    expect(el.querySelectorAll('.abyss-task-delete-btn')).toHaveLength(1);

    click(expectDefined(first), { ctrlKey: true });
    expect(expectDefined(first).classList.contains('abyss-multi-selected')).toBe(true);
    expect(expectDefined(first).querySelector('.abyss-task-delete-btn')).toBeNull();
    expect(el.querySelectorAll('.abyss-task-delete-btn')).toHaveLength(0);

    click(expectDefined(first), { ctrlKey: true });
    expect(expectDefined(first).classList.contains('abyss-multi-selected')).toBe(false);
    expect(expectDefined(second).querySelector('.abyss-task-delete-btn')).not.toBeNull();

    state.set('taskStack', []);
    expect(el.querySelectorAll('.abyss-task-delete-btn')).toHaveLength(0);
  });

  it('creates the selection live region without an initial announcement', () => {
    const { el } = makeCenter([t1, t2]);

    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('');
  });

  it('does not mutate the live region for plain activation, refresh, or a no-op visual update', () => {
    const { el, panel } = makeCenter([t1, t2]);
    const live = expectDefined(el.querySelector<HTMLElement>('.abyss-selection-live'));
    const observer = new MutationObserver(() => undefined);
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    const liveMutations = (): MutationRecord[] =>
      observer
        .takeRecords()
        .filter(
          (record) =>
            record.target.instanceOf(HTMLElement) &&
            record.target.classList.contains('abyss-selection-live'),
        );

    click(expectDefined(cards(el)[0]));
    expect(liveMutations()).toHaveLength(0);

    (
      panel as unknown as { updateSelectionVisuals_abyssPrivate(): void }
    ).updateSelectionVisuals_abyssPrivate();
    expect(liveMutations()).toHaveLength(0);

    panel.refresh();
    expect(liveMutations()).toHaveLength(0);
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('');
    observer.disconnect();
    expect(live.isConnected).toBe(true);
  });

  it('mutates the live region once for each real 0 to 1 to 2 to 1 to 0 count transition', () => {
    const { el, panel } = makeCenter([t1, t2]);
    const live = expectDefined(el.querySelector<HTMLElement>('.abyss-selection-live'));
    const observer = new MutationObserver(() => undefined);
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    const expectAnnouncement = (message: string): void => {
      const mutations = observer.takeRecords();
      expect(mutations).toHaveLength(1);
      expect(live.textContent).toBe(message);
    };

    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    expectAnnouncement('1 task selected');
    (
      panel as unknown as { updateSelectionVisuals_abyssPrivate(): void }
    ).updateSelectionVisuals_abyssPrivate();
    expect(observer.takeRecords()).toHaveLength(0);

    click(expectDefined(cards(el)[1]), { ctrlKey: true });
    expectAnnouncement('2 tasks selected');
    click(expectDefined(cards(el)[1]), { ctrlKey: true });
    expectAnnouncement('1 task selected');
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    expectAnnouncement('0 tasks selected');
    observer.disconnect();
  });

  it('Ctrl+Click adds card to multi-selection', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expect(expectDefined(cards[0]).classList.contains('abyss-multi-selected')).toBe(true);
  });

  it('Ctrl+Click two cards selects both', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expect(expectDefined(cards[0]).classList.contains('abyss-multi-selected')).toBe(true);
    expect(expectDefined(cards[1]).classList.contains('abyss-multi-selected')).toBe(true);
  });

  it('archives two selected roots with one frozen session and retains failed selection', async () => {
    const execute = vi
      .fn<(ref: TaskRef) => Promise<TaskCommandResult>>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'archived', ref: t1.ref, filePath: 'archive/2026-09-19.md' },
      })
      .mockResolvedValueOnce({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      });
    const planArchive = vi.fn().mockResolvedValue({
      type: 'ready',
      filePath: 'archive/2026-09-19.md',
      execute,
    });
    const application: TaskApplicationApi = {
      queries: makeStubStore([t1, t2]).queries,
      execute: vi.fn(),
      planArchive,
    };
    const { el, panel } = makeCenter([t1, t2], application);
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    click(expectDefined(cards(el)[1]), { ctrlKey: true });

    await taskCommandsOf(panel).archiveTasks([t1, t2]);

    expect(planArchive).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([calledRef]) => calledRef)).toEqual([t1.ref, t2.ref]);
    expect(selectedLines(el)).toEqual(['1']);
  });

  it('Ctrl+Click already-selected card deselects it', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expect(expectDefined(cards[0]).classList.contains('abyss-multi-selected')).toBe(false);
  });

  it('announces multi-selection without changing task-scroll children', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    const childOrder = Array.from(scroll.children);
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );

    const live = el.querySelector<HTMLElement>('.abyss-selection-live');
    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(live?.textContent).toBe('2 tasks selected');
    expect(scroll.contains(live)).toBe(false);
    expect(Array.from(scroll.children)).toEqual(childOrder);
    expect(expectDefined(cards[0]).getAttribute('aria-describedby')).toContain(
      'abyss-selected-state-',
    );
    expect(expectDefined(cards[0]).querySelector('.abyss-selected-state')?.textContent).toBe(
      'Selected',
    );
    const selectedStates = Array.from(el.querySelectorAll<HTMLElement>('.abyss-selected-state'));
    expect(selectedStates).toHaveLength(2);
    selectedStates.forEach((state) => {
      expect(state.classList.contains('abyss-sr-only')).toBe(true);
    });

    const menuTitles: string[] = [];
    const makeMenu = (): { addItem: (callback: (item: never) => unknown) => unknown } => ({
      addItem: (callback) => {
        const item = {
          setTitle: (title: string) => {
            menuTitles.push(title);
            return item;
          },
          setSection: () => item,
          setDisabled: () => item,
          setIcon: () => item,
          setChecked: () => item,
          onClick: () => item,
          setSubmenu: () => makeMenu(),
        };
        callback(item as never);
        return makeMenu();
      },
    });
    const addItem = vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      callback,
    ) {
      const menu = makeMenu();
      menu.addItem(callback as (item: never) => unknown);
      return this;
    });
    try {
      expectDefined(cards[1]).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expect(menuTitles).toContain('2 tasks selected');
    } finally {
      addItem.mockRestore();
    }
  });

  it('removes a deselected card description while preserving the remaining selection state', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );

    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('1 task selected');
    expect(expectDefined(cards[0]).querySelector('.abyss-selected-state')?.textContent).toBe(
      'Selected',
    );
    expect(expectDefined(cards[1]).querySelector('.abyss-selected-state')).toBeNull();
    expect(expectDefined(cards[1]).getAttribute('aria-describedby') ?? '').not.toContain(
      'abyss-selected-state-',
    );
  });

  it('preserves another component description while toggling selection state', () => {
    const { el } = makeCenter([t1]);
    const card = expectDefined(cards(el)[0]);
    const externalDescription = el.createDiv({ attr: { id: 'other-component-description' } });
    card.setAttribute('aria-describedby', externalDescription.id);

    click(card, { ctrlKey: true });
    expect(card.getAttribute('aria-describedby')).toContain(externalDescription.id);
    expect(card.getAttribute('aria-describedby')).toContain('abyss-selected-state-');

    click(card, { ctrlKey: true });
    expect(card.getAttribute('aria-describedby')).toBe(externalDescription.id);
  });

  it('consumes Escape when clearing selection before workspace fallback', () => {
    const { el, panel, state } = makeCenter([t1, t2]);
    attach(el);
    const first = expectDefined(cards(el)[0]);
    const second = expectDefined(cards(el)[1]);
    click(first, { ctrlKey: true });
    click(second, { ctrlKey: true });
    expect(selectedLines(el)).toEqual(['0', '1']);
    first.focus();
    const ownerWindow = expectDefined(el.ownerDocument.defaultView);
    const fallback = vi.fn();
    const observe = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) fallback();
    };
    ownerWindow.addEventListener('keydown', observe);
    try {
      const handled = key(first, 'Escape');
      expect(selectedLines(el)).toEqual([]);
      expect(handled.defaultPrevented).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
      expect(el.ownerDocument.activeElement).toBe(first);

      expect(key(first, 'Escape').defaultPrevented).toBe(false);
      expect(fallback).toHaveBeenCalledTimes(1);
      state.set('mode', 'calendar');
      expect(key(el, 'Escape').defaultPrevented).toBe(false);
      expect(fallback).toHaveBeenCalledTimes(2);
      panel.destroy();
      expect(key(el, 'Escape').defaultPrevented).toBe(false);
      expect(fallback).toHaveBeenCalledTimes(3);
    } finally {
      ownerWindow.removeEventListener('keydown', observe);
      panel.destroy();
      el.remove();
    }
  });

  it.each(['anchor-only', 'multi'] as const)(
    'leaves Calendar Escape to workspace when list state is retained (%s)',
    (kind) => {
      const { el, panel, state } = makeCenter([t1, t2]);
      attach(el);
      const first = expectDefined(cards(el)[0]);
      const second = expectDefined(cards(el)[1]);
      click(first);
      if (kind === 'multi') click(second, { shiftKey: true });
      expect(selectedLines(el)).toEqual(kind === 'multi' ? ['0', '1'] : []);
      const ownerWindow = expectDefined(el.ownerDocument.defaultView);
      const fallback = vi.fn();
      const observe = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !event.defaultPrevented) fallback();
      };
      ownerWindow.addEventListener('keydown', observe);
      try {
        state.set('mode', 'calendar');
        const dayButton = (): HTMLButtonElement =>
          expectDefined(
            [...el.querySelectorAll<HTMLButtonElement>('.abyss-cal-view-switcher button')].find(
              (button) => button.textContent === 'Day',
            ),
          );
        dayButton().click();
        const day = dayButton();
        day.focus();
        expect(el.ownerDocument.activeElement).toBe(day);

        const escape = key(day, 'Escape');
        expect(escape.defaultPrevented).toBe(false);
        expect(fallback).toHaveBeenCalledOnce();
        state.set('mode', 'tasks');
        expect(selectedLines(el)).toEqual([]);
        expect(key(el, 'Escape').defaultPrevented).toBe(false);
        expect(fallback).toHaveBeenCalledTimes(2);
      } finally {
        ownerWindow.removeEventListener('keydown', observe);
        panel.destroy();
        el.remove();
      }
    },
  );

  it.each(['composing', 'legacy'] as const)(
    'leaves IME-owned Escape and arrows to the IME (%s)',
    (ime) => {
      const { el, state } = makeCenter([t1, t2, t3]);
      attach(el);
      const first = expectDefined(cards(el)[0]);
      click(first, { ctrlKey: true });
      const stack = state.get('taskStack');

      const escape = dispatchImeKey(el, 'Escape', ime);
      const arrow = dispatchImeKey(el, 'ArrowDown', ime);

      // A guard on the arrow branch alone still lets a composing Escape clear the selection.
      expect(first.classList.contains('abyss-multi-selected')).toBe(true);
      expect([escape.defaultPrevented, arrow.defaultPrevented]).toEqual([false, false]);
      expect(state.get('taskStack')).toBe(stack);
      el.remove();
    },
  );

  it('Shift+Click selects range', () => {
    const { el } = makeCenter([t1, t2, t3]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    // Ctrl+Click first to set anchor
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    // Shift+Click last
    expectDefined(cards[2]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    expect(expectDefined(cards[0]).classList.contains('abyss-multi-selected')).toBe(true);
    expect(expectDefined(cards[1]).classList.contains('abyss-multi-selected')).toBe(true);
    expect(expectDefined(cards[2]).classList.contains('abyss-multi-selected')).toBe(true);
  });

  it.each([
    ['ArrowDown', t1],
    ['ArrowUp', t3],
  ])('%s without an origin opens and focuses the boundary task', (arrow, expected) => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    visibleCards.forEach((card) => {
      card.scrollIntoView = vi.fn();
    });

    key(el, arrow);

    const expectedCard =
      arrow === 'ArrowDown' ? expectDefined(visibleCards[0]) : expectDefined(visibleCards[2]);
    expect(state.get('taskStack')).toEqual([expected]);
    expect(activeDocument.activeElement).toBe(expectedCard);
    expect(selectedLines(el)).toEqual([]);
    el.remove();
  });

  it('uses rendered card order rather than query order for keyboard navigation', () => {
    const late = { ...t1, planning: { due: '2026-07-03' as never } };
    const early = { ...t2, planning: { due: '2026-07-01' as never } };
    const middle = { ...t3, planning: { due: '2026-07-02' as never } };
    const { el, state } = makeCenter([late, early, middle]);
    attach(el);
    const rendered = cards(el);
    expect(rendered.map((card) => card.dataset['line'])).toEqual(['1', '2', '0']);

    key(el, 'ArrowDown');

    expect(state.get('taskStack')).toEqual([early]);
    expect(activeDocument.activeElement).toBe(rendered[0]);
    el.remove();
  });

  it('plain arrows move from the focused card and open exactly one task', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[0]));

    key(expectDefined(visibleCards[0]), 'ArrowDown');
    expect(state.get('taskStack')).toEqual([t2]);
    expect(activeDocument.activeElement).toBe(visibleCards[1]);
    expect(selectedLines(el)).toEqual([]);

    key(expectDefined(visibleCards[1]), 'ArrowUp');
    expect(state.get('taskStack')).toEqual([t1]);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);
    el.remove();
  });

  it('plain arrows use the current detail card when the range origin is absent', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    state.set('taskStack', [t2]);

    key(el, 'ArrowDown');

    expect(state.get('taskStack')).toEqual([t3]);
    el.remove();
  });

  it('plain arrows clamp at the first and last cards without wrapping', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[0]));
    key(expectDefined(visibleCards[0]), 'ArrowUp');
    expect(state.get('taskStack')).toEqual([t1]);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);

    click(expectDefined(visibleCards[2]));
    key(expectDefined(visibleCards[2]), 'ArrowDown');
    expect(state.get('taskStack')).toEqual([t3]);
    expect(activeDocument.activeElement).toBe(visibleCards[2]);
    el.remove();
  });

  it('Shift+Arrow expands, shrinks on reversal, and crosses a fixed anchor', () => {
    const { el } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[1]), { ctrlKey: true });

    key(expectDefined(visibleCards[1]), 'ArrowDown', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['1', '2']);

    key(expectDefined(visibleCards[2]), 'ArrowUp', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['1']);

    key(expectDefined(visibleCards[1]), 'ArrowUp', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['0', '1']);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);
    el.remove();
  });

  it.each(['ArrowDown', 'ArrowUp'])(
    'Shift+%s without an origin starts a one-card boundary range',
    (arrow) => {
      const { el, state } = makeCenter([t1, t2, t3]);

      key(el, arrow, { shiftKey: true });

      expect(selectedLines(el)).toEqual([arrow === 'ArrowDown' ? '0' : '2']);
      expect(state.get('taskStack')).toEqual([]);
    },
  );

  it('Shift+Arrow clamps without growing or wrapping at a boundary', () => {
    const { el } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[0]), { ctrlKey: true });

    key(expectDefined(visibleCards[0]), 'ArrowUp', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['0']);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);
    el.remove();
  });

  it('Shift+Click replaces an earlier range and shrinks toward the anchor', () => {
    const { el } = makeCenter([t1, t2, t3]);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[0]), { ctrlKey: true });
    click(expectDefined(visibleCards[2]), { shiftKey: true });
    expect(selectedLines(el)).toEqual(['0', '1', '2']);

    click(expectDefined(visibleCards[1]), { shiftKey: true });

    expect(selectedLines(el)).toEqual(['0', '1']);
  });

  it('prunes hidden selections and stale range origins on task-list rerender', () => {
    const tasks = [t1, t2, t3];
    const { el, panel } = makeCenter(tasks);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards.find((card) => card.dataset['line'] === '0')), {
      ctrlKey: true,
    });
    click(expectDefined(visibleCards.find((card) => card.dataset['line'] === '1')), {
      ctrlKey: true,
    });
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('2 tasks selected');

    tasks.splice(
      tasks.findIndex((candidate) => candidate.source.line === 0),
      1,
    );
    panel.refresh();

    expect(selectedLines(el)).toEqual(['1']);
    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('1 task selected');
    expect(expectDefined(cards(el)[0]).querySelector('.abyss-selected-state')?.textContent).toBe(
      'Selected',
    );

    tasks.splice(0);
    panel.refresh();
    expect(selectedLines(el)).toEqual([]);
  });

  it('preserves a visible plain-click origin across rerender for the next Shift range', () => {
    const { el, panel } = makeCenter([t1, t2, t3]);
    click(expectDefined(cards(el).find((card) => card.dataset['line'] === '0')));

    panel.refresh();
    click(expectDefined(cards(el).find((card) => card.dataset['line'] === '2')), {
      shiftKey: true,
    });

    expect(selectedLines(el)).toEqual(['0', '1', '2']);
  });

  it('preserves a visible Ctrl-toggle-off origin across rerender for the next Shift range', () => {
    const { el, panel } = makeCenter([t1, t2, t3]);
    const origin = expectDefined(cards(el).find((card) => card.dataset['line'] === '0'));
    click(origin, { ctrlKey: true });
    click(origin, { ctrlKey: true });
    expect(selectedLines(el)).toEqual([]);

    panel.refresh();
    click(expectDefined(cards(el).find((card) => card.dataset['line'] === '2')), {
      shiftKey: true,
    });

    expect(selectedLines(el)).toEqual(['0', '1', '2']);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('%s+Click resets the next range anchor even when toggling off', (_name, modifier) => {
    const { el } = makeCenter([t1, t2, t3]);
    const visibleCards = cards(el);
    click(expectDefined(visibleCards[0]), modifier);
    click(expectDefined(visibleCards[2]), modifier);
    click(expectDefined(visibleCards[2]), modifier);

    click(expectDefined(visibleCards[1]), { shiftKey: true });

    expect(selectedLines(el)).toEqual(['1', '2']);
  });

  it('does not hijack Arrow keys from interactive or popover targets', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    const host = expectDefined(cards(el)[0]);
    const targets = [
      host.createEl('input'),
      host.createEl('textarea'),
      host.createEl('select'),
      host.createEl('button'),
      host.createEl('a'),
      host.createDiv({ attr: { contenteditable: 'true' } }),
      host.createDiv({ cls: 'abyss-status-marker' }),
      el.createDiv({ cls: 'abyss-popover' }),
    ];

    for (const target of targets) {
      const event = key(target, 'ArrowDown', { shiftKey: true });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(state.get('taskStack')).toEqual([]);
    expect(selectedLines(el)).toEqual([]);
  });

  it('leaves the task selection alone for ArrowDown in a centre input inside a popout', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    const frame = activeDocument.body.createEl('iframe');
    try {
      const popoutDocument = expectDefined(frame.contentDocument);
      const popoutWindow = expectDefined(frame.contentWindow) as Window & typeof window;
      // The panel's elements are main-window objects; the append moves them, as in Obsidian.
      popoutDocument.body.append(el);
      const filter = expectDefined(el.querySelector<HTMLInputElement>('.abyss-center-search'));
      expect(filter.ownerDocument).toBe(popoutDocument);
      expect(filter).not.toBeInstanceOf(popoutWindow.HTMLElement);
      filter.focus();

      const event = new popoutWindow.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      filter.dispatchEvent(event);

      // A helper that accepts only the owner document's realm reads the input as a card target.
      expect(state.get('taskStack')).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
      expect(popoutDocument.activeElement).toBe(filter);
    } finally {
      frame.remove();
    }
  });

  it('opens a clicked dashboard card without focusing or scrolling it', () => {
    const { el, state, panel } = makeCenter([t1, t2, t3]);
    attach(el);
    state.set('mode', 'projects');
    const dashboard = renderDashboardList(panel, el, 'a.md');
    const card = expectDefined(cards(dashboard)[1]);
    card.scrollIntoView = vi.fn();

    click(card);

    expect(state.get('taskStack')).toEqual([t2]);
    expect(card.classList.contains('is-selected')).toBe(true);
    expect(methodOf(card, 'scrollIntoView')).not.toHaveBeenCalled();
    expect(activeDocument.activeElement).not.toBe(card);
    el.remove();
  });

  it('clears the selection when the list changes, even to a list showing the same tasks', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    click(expectDefined(cards(el)[1]), { ctrlKey: true });

    state.set('selectedList', { type: 'tag', tag: '#task/inbox' });

    expect(cards(el)).toHaveLength(3);
    expect(selectedLines(el)).toEqual([]);
    click(expectDefined(cards(el)[2]), { shiftKey: true });
    expect(selectedLines(el)).toEqual(['2']);
  });

  it('keeps the selection and its highlights across a Calendar round trip', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    click(expectDefined(cards(el)[2]), { ctrlKey: true });

    state.set('mode', 'calendar');
    expect(cards(el)).toHaveLength(0);
    state.set('mode', 'tasks');

    expect(selectedLines(el)).toEqual(['0', '2']);
    expect(el.querySelectorAll('.abyss-selected-state')).toHaveLength(2);
  });

  it('clears page-local selection across a Lists, Search, Lists round trip', async () => {
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] Task 1\n- [ ] Task 2' },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    try {
      click(expectDefined(cards(h.root)[0]), { ctrlKey: true });
      click(expectDefined(cards(h.root)[1]), { ctrlKey: true });
      h.state.set('searchQuery', 'Task 1');
      h.state.set('mode', 'search');
      await h.completed();
      expect(cards(h.root)).toHaveLength(1);
      h.state.set('mode', 'tasks');
      expect(selectedLines(h.root)).toEqual([]);
    } finally {
      h.dispose();
    }
  });
  it('reads no rows after a canonical filter empties the list while preserving inspector selection', async () => {
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] Task 1' },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    try {
      click(expectDefined(cards(h.root)[0]));
      const selected = h.state.get('taskStack');
      h.query('nothing matches');
      await h.completed();
      expect(cards(h.root)).toHaveLength(0);
      expect(key(h.root, 'ArrowDown').defaultPrevented).toBe(false);
      expect(h.state.get('taskStack')).toEqual(selected);
    } finally {
      h.dispose();
    }
  });
  it('leaves ArrowDown in canonical Search to the page', async () => {
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] Task 1' },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query('Task');
      await h.completed();
      const result = expectDefined(cards(h.root)[0]);
      result.focus();
      expect(key(result, 'ArrowDown').defaultPrevented).toBe(false);
      expect(h.state.get('taskStack')).toEqual([]);
      expect(document.activeElement).toBe(result);
      expect(selectedLines(h.root)).toEqual([]);
    } finally {
      h.dispose();
    }
  });
  it('shows the empty states of Lists, canonical Search, and a dashboard', async () => {
    const h = await mountCanonicalSearchUi({}, structuredClone(DEFAULT_SETTINGS), 'tasks');
    try {
      expect(h.root.querySelector('.abyss-center-empty')?.textContent).toBe('No tasks');
      h.state.set('searchQuery', 'nothing matches');
      h.state.set('mode', 'search');
      await h.completed();
      expect(h.root.querySelector('.abyss-center-scroll .abyss-center-empty')?.textContent).toBe(
        'No results',
      );
      h.state.set('mode', 'projects');
      const dashboard = renderDashboardList(h.panel, h.root, 'a.md');
      expect(dashboard.querySelector('.abyss-center-empty')?.textContent).toBe('No tasks yet');
    } finally {
      h.dispose();
    }
  });
});

describe('outgoing-link repeated cards', () => {
  it('selects both occurrences independently, counts one physical task, and traverses both', () => {
    const linked = task({
      markdownTitle: 'Ask [[Alice]] [[Bob]]',
      tags: ['#task/inbox'],
      source: { filePath: 'tasks.md', line: 0 },
    });
    const { panel, el, state } = makeCenter([linked]);
    attach(el);
    state.set('centerListViewState', {
      ...state.get('centerListViewState'),
      groupBy: 'outgoing-link',
    });
    const rows = cards(el);
    expect(rows).toHaveLength(2);
    click(expectDefined(rows[0]), { ctrlKey: true });
    click(expectDefined(rows[1]), { metaKey: true });
    expect(selectedLines(el)).toEqual(['0', '0']);
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('1 task selected');
    expect(
      panel['rowSelection_abyssPrivate']
        .selectedNodes(panel['listOrder_abyssPrivate']())
        .map(({ task }) => ('root' in task ? task.node : undefined)),
    ).toEqual([linked]);
    click(expectDefined(rows[0]));
    key(expectDefined(rows[0]), 'ArrowDown');
    expect(activeDocument.activeElement).toBe(rows[1]);
    panel.destroy();
  });
});

it('retains only the selected outgoing occurrence when an archive fails after a sibling was removed', async () => {
  const first = task({
    markdownTitle: '[[Alice]] [[Bob]]',
    tags: ['#task/inbox'],
    source: { filePath: 'tasks.md', line: 0 },
  });
  const second = task({
    markdownTitle: '[[Alice]] [[Bob]]',
    tags: ['#task/inbox'],
    source: { filePath: 'tasks.md', line: 1 },
  });
  const execute = vi
    .fn<(ref: TaskRef) => Promise<TaskCommandResult>>()
    .mockResolvedValueOnce({
      type: 'ok',
      changed: true,
      outcome: { type: 'archived', ref: first.ref, filePath: 'archive.md' },
    })
    .mockResolvedValueOnce({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
  const application: TaskApplicationApi = {
    queries: makeStubStore([first, second]).queries,
    execute: vi.fn(),
    planArchive: vi.fn().mockResolvedValue({ type: 'ready', filePath: 'archive.md', execute }),
  };
  const { panel, el, state } = makeCenter([first, second], application);
  state.set('centerListViewState', {
    ...state.get('centerListViewState'),
    groupBy: 'outgoing-link',
  });
  const rows = cards(el);
  expect(rows).toHaveLength(4);
  click(expectDefined(rows[0]), { ctrlKey: true });
  click(expectDefined(rows[2]), { ctrlKey: true });
  click(expectDefined(rows[3]), { ctrlKey: true });
  await taskCommandsOf(panel).archiveTasks([first, second]);
  expect(selectedLines(el)).toEqual(['1']);
  expect(rows[3]?.classList.contains('abyss-multi-selected')).toBe(true);
  panel.destroy();
});

describe('windowed Tasks integration', () => {
  function largeTasks(): TaskSnapshot[] {
    return Array.from({ length: 1200 }, (_, line) =>
      task({
        title: `Task ${line}`,
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line },
      }),
    );
  }
  it('reveals logical arrow targets outside the mounted window and keeps DOM bounded', () => {
    const tasks = largeTasks();
    const { el, state, panel } = makeCenter(tasks);
    state.set('taskStack', [expectDefined(tasks[998])]);
    key(el, 'ArrowDown');
    expect(state.get('taskStack')).toEqual([tasks[999]]);
    expect(activeDocument.activeElement?.getAttribute('data-line')).toBe('999');
    expect(cards(el).length).toBeLessThanOrEqual(100);
    panel.destroy();
  });
  it('extends a logical range across windows without mounting the selection', () => {
    const { el, state, panel } = makeCenter(largeTasks());
    click(expectDefined(cards(el)[0]));
    for (let i = 0; i < 120; i++) key(el, 'ArrowDown', { shiftKey: true });
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('121 tasks selected');
    expect(activeDocument.activeElement?.getAttribute('data-line')).toBe('120');
    expect(state.get('taskStack')[0]).toMatchObject({ source: { line: 0 } });
    expect(cards(el).length).toBeLessThanOrEqual(100);
    panel.destroy();
  });
  it('preserves fractional and elastic native scrolling without completing an application render', () => {
    const { el, panel } = makeCenter(largeTasks());
    const complete = vi.spyOn(
      panel as unknown as { completeTaskCardRender_abyssPrivate(): void },
      'completeTaskCardRender_abyssPrivate',
    );
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 12000.25;
    scroll.dispatchEvent(new Event('scroll'));
    flushViewport();
    expect(scroll.scrollTop).toBe(12000.25);
    expect(cards(el).length).toBeLessThanOrEqual(100);
    expect(cards(el)[0]?.dataset['line']).not.toBe('0');
    scroll.scrollTop = -1.5;
    scroll.dispatchEvent(new Event('scroll'));
    flushViewport();
    expect(scroll.scrollTop).toBe(-1.5);
    expect(complete).not.toHaveBeenCalled();
    panel.destroy();
  });
});

describe('offscreen date focus authorization', () => {
  it.each([false, true])(
    'reveals an exact offscreen source only while focus authority remains (%s outside)',
    async (outsideFocus) => {
      const tasks = Array.from({ length: 1200 }, (_, line) =>
        task({
          title: `Task ${line}`,
          tags: ['#task/inbox'],
          source: { filePath: 'large.md', line },
        }),
      );
      const { el, panel } = makeCenter(tasks);
      const original = expectDefined(tasks[0]);
      const card = expectDefined(cards(el)[0]);
      card.focus();
      let resolve!: (value: boolean) => void;
      vi.spyOn(taskCommandsOf(panel), 'setTaskDue').mockImplementation(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );
      panel['pickTaskDate_abyssPrivate']([original], '2026-10-08', card.dataset['rowKey']);
      const outside = activeDocument.body.createEl('input');
      if (outsideFocus) outside.focus();
      else card.blur();
      const complete = vi.spyOn(
        panel as unknown as { completeTaskCardRender_abyssPrivate(): void },
        'completeTaskCardRender_abyssPrivate',
      );
      const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
      scroll.scrollTop = 25000.25;
      scroll.dispatchEvent(new Event('scroll'));
      flushViewport();
      expect(complete).not.toHaveBeenCalled();
      resolve(true);
      await Promise.resolve();
      panel.refresh();
      if (outsideFocus) {
        expect(activeDocument.activeElement).toBe(outside);
        expect(scroll.scrollTop).toBe(25000.25);
      } else {
        expect(activeDocument.activeElement?.getAttribute('data-line')).toBe('0');
        expect(scroll.scrollTop).toBeLessThan(100);
      }
      outside.remove();
      panel.destroy();
    },
  );
});

it('pins an open recurrence editor across scrolling and cancels it when its task is filtered out', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'large.md': Array.from({ length: 1200 }, (_, line) => `- [ ] Task ${line} #task/inbox`).join(
        '\n',
      ),
    },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true } },
    'tasks',
  );
  const { root: el, panel } = h;
  const tasks = h.index.list();
  const card = expectDefined(cards(el)[0]);
  panel['openRecurrenceEditor_abyssPrivate'](card, expectDefined(tasks[0]));
  const editor = expectDefined(activeDocument.querySelector('.abyss-recurrence-popover'));
  const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
  scroll.scrollTop = 20000;
  scroll.dispatchEvent(new Event('scroll'));
  flushViewport();
  expect(card.isConnected).toBe(true);
  panel.refresh();
  expect(editor.isConnected).toBe(true);
  h.query('unmatched task title');
  await h.completed();
  expect(editor.isConnected).toBe(false);
  expect(card.isConnected).toBe(false);
  h.dispose();
});

it('does not reveal a stale date opener while cancelling a replaced source before reconciliation', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({ title: `Task ${line}`, tags: ['#task/inbox'], source: { filePath: 'large.md', line } }),
  );
  const { el, panel } = makeCenter(tasks);
  const original = expectDefined(tasks[0]);
  const card = expectDefined(cards(el)[0]);
  panel['openTaskDatePicker_abyssPrivate'](card, [original]);
  const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
  scroll.scrollTop = 25000.25;
  scroll.dispatchEvent(new Event('scroll'));
  flushViewport();
  tasks[0] = { ...original, ref: { ...original.ref, revision: 'external-replacement' } };
  panel.refresh();
  expect(scroll.scrollTop).toBe(25000.25);
  expect(el.querySelector('.abyss-date-picker-popover')).toBeNull();
  expect(activeDocument.activeElement).not.toBe(card);
  panel.destroy();
});

it('selects all outgoing occurrences across windows while deduplicating physical task targets', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({
      title: `Task ${line}`,
      markdownTitle: `Task ${line} [[Alice]] [[Bob]]`,
      tags: ['#task/inbox'],
      source: { filePath: 'large.md', line },
    }),
  );
  const { el, state, panel } = makeCenter(tasks);
  state.set('centerListViewState', {
    ...state.get('centerListViewState'),
    groupBy: 'outgoing-link',
  });
  const first = expectDefined(cards(el)[0]);
  click(first);
  const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
  scroll.scrollTop = 1e9;
  scroll.dispatchEvent(new Event('scroll'));
  flushViewport();
  const mounted = cards(el);
  const last = expectDefined(mounted[mounted.length - 1]);
  expect(last.dataset['line']).toBe('1199');
  click(last, { shiftKey: true });
  expect(panel['rowSelection_abyssPrivate'].size).toBe(2400);
  expect(
    panel['rowSelection_abyssPrivate']
      .selectedNodes(panel['listOrder_abyssPrivate']())
      .map(({ task }) => ('root' in task ? task.node : undefined)),
  ).toEqual(tasks);
  expect(cards(el).length).toBeLessThanOrEqual(100);
  panel.destroy();
});

it('retains a native drag source while scrolling and releases it when Escape cancels', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({ title: `Task ${line}`, tags: ['#task/inbox'], source: { filePath: 'large.md', line } }),
  );
  const { el, state, panel } = makeCenter(tasks);
  const card = expectDefined(cards(el)[0]);
  card.dispatchEvent(new Event('dragstart'));
  const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
  scroll.scrollTop = 25000;
  scroll.dispatchEvent(new Event('scroll'));
  flushViewport();
  expect(card.isConnected).toBe(true);
  expect(state.get('draggingTaskNode')?.task.root).toEqual(tasks[0]);
  key(el, 'Escape');
  flushViewport();
  expect(state.get('draggingTaskNode')).toBeNull();
  expect(card.isConnected).toBe(false);
  panel.destroy();
});

it.each([false, true])(
  'returns a delayed recurrence successor only while its original return authority remains (%s outside)',
  async (outsideFocus) => {
    const original = task({
      title: 'Original',
      planning: { due: '2026-10-04' },
      tags: ['#task/inbox'],
      source: { filePath: 'large.md', line: 0 },
    });
    const successor = { ...original, ref: { ...original.ref, revision: 'owned-successor' } };
    const tasks = [
      original,
      ...Array.from({ length: 1199 }, (_, index) =>
        task({
          title: `Task ${index + 1}`,
          tags: ['#task/inbox'],
          source: { filePath: 'large.md', line: index + 1 },
        }),
      ),
    ];
    const pending = deferred<TaskCommandResult>();
    const application: TaskApplicationApi = {
      queries: makeStubStore(tasks).queries,
      execute: vi.fn(() => pending.promise),
    };
    const { el, panel } = makeCenter(tasks, application);
    const card = expectDefined(cards(el)[0]);
    card.focus();
    panel['openRecurrenceEditor_abyssPrivate'](card, original);
    expectDefined(
      activeDocument.querySelector<HTMLElement>('[data-recurrence-preset="weekly"]'),
    ).click();
    const save = expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-recurrence-save'),
    );
    expect(save.disabled).toBe(false);
    save.focus();
    save.click();
    const outside = activeDocument.body.createEl('input');
    if (outsideFocus) outside.focus();
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 25000.25;
    scroll.dispatchEvent(new Event('scroll'));
    flushViewport();
    tasks[0] = successor;
    panel.refresh();
    pending.resolve({ type: 'ok', changed: true, outcome: { type: 'task', task: successor } });
    await Promise.resolve();
    await Promise.resolve();
    if (outsideFocus) {
      expect(activeDocument.activeElement).toBe(outside);
      expect(scroll.scrollTop).toBe(25000.25);
    } else {
      expect(activeDocument.activeElement?.getAttribute('data-line')).toBe('0');
      expect(scroll.scrollTop).toBeLessThan(100);
    }
    panel.destroy();
    outside.remove();
  },
);

it('reveals an exact offscreen Search destination in the bounded list without moving focus', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'large.md': Array.from(
        { length: 1200 },
        (_, line) => `- [ ] Task ${String(line).padStart(4, '0')} #task/inbox`,
      ).join('\n'),
    },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true } },
  );
  const { root: el, state } = h;
  const target = expectDefined(h.index.list()[1199]);
  h.query(target.title);
  await h.completed();
  const result = expectDefined(el.querySelector<HTMLElement>('.abyss-task-title'));
  const outside = el.ownerDocument.body.createEl('input');
  outside.focus();
  result.click();
  await vi.waitFor(() => {
    expect(state.get('mode')).toBe('tasks');
  });
  await vi.waitFor(() => {
    flushViewport();
    expect(el.dataset['searchPhase']).toBe('complete');
  });
  await h.completed();
  expect(state.get('selectedList')).toBe('inbox');
  expect(state.get('taskStack')).toEqual([target]);
  expect(el.querySelector('.abyss-task-card[data-line="1199"]')).not.toBeNull();
  expect(
    expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll')).scrollTop,
  ).toBeGreaterThan(1000);
  // Exact navigation waits for the pinned logical destination before its measured reveal.
  expect(el.querySelector('.is-search-revealed')?.getAttribute('data-line')).toBe('1199');
  expect(cards(el).length).toBeLessThanOrEqual(100);
  expect(el.ownerDocument.activeElement).toBe(outside);
  outside.remove();
  h.dispose();
});

it.each([{ ctrlKey: true }, { metaKey: true }])(
  'selects all logical occurrences directly with Mod+A and archives each physical task once (%j)',
  async (modifier) => {
    const tasks = Array.from({ length: 1200 }, (_, line) =>
      task({
        title: `Task ${line}`,
        markdownTitle: `Task ${line} [[Alice]] [[Bob]]`,
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line },
      }),
    );
    const execute = vi.fn(async (ref: TaskRef): Promise<TaskCommandResult> => ({
      type: 'ok',
      changed: true,
      outcome: { type: 'archived', ref, filePath: 'archive.md' },
    }));
    const planArchive = vi
      .fn()
      .mockResolvedValue({ type: 'ready', filePath: 'archive.md', execute });
    // This command fixture never rewrites its snapshots. Keep exact lookups indexed so the
    // 1200-command selection proof does not add a full fixture scan to every pending rebase.
    const exactTasks = new Map(
      tasks.map((item) => [`${item.ref.filePath}:${item.ref.line}`, item]),
    );
    const application: TaskApplicationApi = {
      queries: {
        ...makeStubStore(tasks).queries,
        resolve: (ref) => {
          const found = exactTasks.get(`${ref.filePath}:${ref.line}`);
          return found === undefined
            ? { type: 'not-found', ref }
            : { type: 'exact', task: found, basis: { observed: found } };
        },
      },
      execute: vi.fn(),
      planArchive,
    };
    const { el, state, panel } = makeCenter(tasks, application);
    state.set('centerListViewState', {
      ...state.get('centerListViewState'),
      groupBy: 'outgoing-link',
    });
    flushViewport();
    const first = expectDefined(cards(el)[0]);
    first.focus();
    const event = key(first, 'a', modifier);
    expect(event.defaultPrevented).toBe(true);
    expect(panel['rowSelection_abyssPrivate'].size).toBe(2400);
    expect(
      panel['rowSelection_abyssPrivate']
        .selectedNodes(panel['listOrder_abyssPrivate']())
        .map(({ task }) => ('root' in task ? task.node : undefined)),
    ).toEqual(tasks);
    expect(cards(el).length).toBeLessThanOrEqual(100);
    const targets = panel['taskMenuTargets_abyssPrivate']();
    await taskCommandsOf(panel).archiveTasks(
      (await targets.resolve(targets.signal)).map((entry) => entry.task),
    );
    expect(planArchive).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([ref]) => ref)).toEqual(tasks.map(({ ref }) => ref));
    expect(new Set(execute.mock.calls.map(([ref]) => ref))).toHaveLength(1200);
    panel.destroy();
  },
);

it.each(['tasks', 'dashboard', 'search'] as const)(
  'bounds real %s Component/badge/native resources over twenty full-range cycles at both scales',
  async (mode) => {
    const mountedCounts: number[] = [];
    for (const count of [1000, 10000]) {
      const resources = recordVirtualSurfaceResources();
      const markdown = new Set<Component>();
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
        const [, , holder, , owner] = args;
        const child = owner.addChild(new Component());
        markdown.add(child);
        child.register(() => markdown.delete(child));
        holder.createEl('a', {
          cls: 'internal-link',
          text: 'Target',
          attr: { 'data-href': 'Target' },
        });
      });
      const tasks = Array.from({ length: count }, (_, line) =>
        task({
          title: `Task ${line}`,
          markdownTitle: `Task ${line} [[Target]]`,
          description: '[[Target]]',
          tags: ['#task/inbox'],
          source: { filePath: 'large.md', line },
          timeEntries: [
            { relativeLine: 1, originalMarkdown: 'running', state: 'running', startMs: 0 },
          ],
        }),
      );
      const { el, state, panel, ticker } = makeCenter(tasks, undefined, true);
      if (mode === 'dashboard') {
        state.set('mode', 'projects');
        renderDashboardList(panel, el, 'large.md');
      } else if (mode === 'search') {
        state.set('mode', 'search');
        // Exercise the native supplied-row renderer at both full scales. Canonical Search
        // retrieval/completion is covered separately; Task1 still allocates 50-root pages.
        panel['renderFlat_abyssPrivate'](
          expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll')),
          tasks,
        );
      }
      const surface = expectDefined(panel['taskSurface_abyssPrivate']).surface;
      resources.installObserver();
      surface.suspend();
      surface.resume();
      flushViewport();
      await flushMicrotasks();
      const keys = taskKeys(surface.rows);
      expect(keys).toHaveLength(count);
      const first = expectDefined(keys[0]);
      const last = expectDefined(keys[keys.length - 1]);
      const pin = surface.pin(first);
      const retained = resources.counts();
      const retainedMarkdown = markdown.size;
      expect(retained.components).toBeGreaterThan(0);
      expect(retainedMarkdown).toBeGreaterThan(0);
      const initialMounted = [...surface.cards()].length;
      expect(el.querySelectorAll('.abyss-task-time-badge.is-tracking')).toHaveLength(
        initialMounted,
      );
      const renderer = panel['taskCardRenderer_abyssPrivate'];
      const active = tasks.map((item) => ({
        filePath: item.source.filePath,
        root: item.ref,
        target: { type: 'task' as const, ref: item.ref },
        address: taskNodeAddress({ type: 'task', ref: item.ref }),
        rootAddress: taskNodeAddress({ type: 'task', ref: item.ref }),
        title: item.title,
        status: item.status,
        entry: expectDefined(item.timeEntries[0]),
      }));
      const heldBadges: HTMLElement[] = [];
      mountedCounts.push(initialMounted);
      await runVirtualSurfaceAuditCycles(async (cycle) => {
        surface.reveal(last);
        flushViewport();
        const badges = Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-time-badge span'));
        const retired = expectDefined(badges[badges.length - 1]);
        heldBadges.push(retired);
        surface.reveal(first);
        flushViewport();
        await flushMicrotasks();
        document.body.append(retired);
        const oldText = retired.textContent;
        renderer.paintTracking({ nowMs: (cycle + 2) * 60000, active });
        expect(retired.textContent).toBe(oldText);
        expect(el.querySelector('.abyss-task-time-badge span')?.textContent).toBe(`${cycle + 2}m`);
        expect(resources.counts()).toEqual(retained);
        expect(markdown.size).toBeLessThanOrEqual(retainedMarkdown);
        expect([...surface.cards()].length).toBeLessThanOrEqual(initialMounted + 1);
        expect(el.querySelectorAll('.abyss-task-time-badge').length).toBeLessThanOrEqual(
          initialMounted + 1,
        );
      });
      expect(heldBadges).toHaveLength(20);
      pin();
      panel.destroy();
      ticker?.destroy();
      const texts = heldBadges.map((badge) => badge.textContent);
      renderer.paintTracking({ nowMs: 3600000, active });
      expect(heldBadges.map((badge) => badge.textContent)).toEqual(texts);
      heldBadges.forEach((badge) => {
        badge.remove();
      });
      flushViewport();
      expect(resources.liveComponents.size).toBe(0);
      expect(resources.observers.size).toBe(0);
      expect(resources.observed.size).toBe(0);
      expect(markdown.size).toBe(0);
      expect(viewportFrames.size).toBe(0);
      // Mounted panel/global listeners must be released; document's lazy jsdom delegates are excluded.
      expect(resources.nativeListeners.size).toBe(0);
      vi.restoreAllMocks();
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        viewportFrames.set(viewportFrames.size + 1, callback);
        return viewportFrames.size;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) =>
        viewportFrames.delete(id),
      );
    }
    expect(expectDefined(mountedCounts[1])).toBeLessThanOrEqual(
      expectDefined(mountedCounts[0]) * 1.1,
    );
  },
  VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS,
);

it.each(['title', 'desc'])(
  'retires held task %s links when their actual content generation is evicted',
  async (region) => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
      const holder = args[2];
      holder.createEl('a', {
        cls: 'internal-link',
        text: 'Target',
        attr: { 'data-href': 'Target' },
      });
    });
    const tasks = Array.from({ length: 1200 }, (_, line) =>
      task({
        markdownTitle: `Task ${line} [[Target]]`,
        description: '[[Target]]',
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line },
      }),
    );
    const { el, panel } = makeCenter(tasks);
    flushViewport();
    await flushMicrotasks();
    const anchor = expectDefined(
      cards(el)[0]?.querySelector<HTMLElement>(`.abyss-task-${region} a.internal-link`),
    );
    const open = vi.spyOn(panel['app_abyssPrivate'].workspace, 'openLinkText');
    const hover = vi.spyOn(panel['app_abyssPrivate'].workspace, 'trigger');
    const surface = expectDefined(panel['taskSurface_abyssPrivate']).surface;
    surface.reveal(expectDefined(surface.rows.taskKeyAt(surface.rows.taskCount - 1)));
    flushViewport();
    expect(anchor.isConnected).toBe(false);
    const click = new MouseEvent('click', { cancelable: true });
    anchor.dispatchEvent(click);
    anchor.dispatchEvent(new MouseEvent('mouseover'));
    const menu = new MouseEvent('contextmenu', { cancelable: true });
    anchor.dispatchEvent(menu);
    await flushMicrotasks();
    expect.soft(click.defaultPrevented).toBe(false);
    expect.soft(menu.defaultPrevented).toBe(false);
    expect.soft(open).not.toHaveBeenCalled();
    expect.soft(hover.mock.calls.filter(([type]) => type === 'hover-link')).toEqual([]);
    panel.destroy();
  },
);

it.each([false, true])(
  'Mod+A keeps later-window focus and scroll with an existing lead=%s',
  (hasLead) => {
    const tasks = Array.from({ length: 1200 }, (_, line) =>
      task({
        title: `Task ${String(line).padStart(4, '0')}`,
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line },
      }),
    );
    const { el, panel, state } = makeCenter(tasks);
    const surface = expectDefined(panel['taskSurface_abyssPrivate']).surface;
    const card = expectDefined(surface.reveal('large.md:700'));
    card.focus();
    if (hasLead) {
      click(card);
      key(card, 'ArrowDown', { shiftKey: true });
    }
    const active = expectDefined(el.ownerDocument.activeElement) as HTMLElement;
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop += 0.25;
    const offset = scroll.scrollTop;
    const stack = state.get('taskStack');
    const complete = vi.spyOn(
      panel as unknown as { completeTaskCardRender_abyssPrivate(): void },
      'completeTaskCardRender_abyssPrivate',
    );
    const reveal = vi.spyOn(surface, 'reveal');
    for (let repeat = 0; repeat < 2; repeat++)
      expect(key(active, 'A', { metaKey: true }).defaultPrevented).toBe(true);
    expect(panel['rowSelection_abyssPrivate'].size).toBe(1200);
    expect(panel['rowSelection_abyssPrivate'].anchor).toBe('large.md:700');
    expect(panel['rowSelection_abyssPrivate'].focus).toBe(
      hasLead ? 'large.md:701' : 'large.md:700',
    );
    expect(el.ownerDocument.activeElement).toBe(active);
    expect(scroll.scrollTop).toBe(offset);
    expect(state.get('taskStack')).toBe(stack);
    expect(complete).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(cards(el).length).toBeLessThanOrEqual(100);
    key(active, 'ArrowDown', { shiftKey: true });
    expect(panel['rowSelection_abyssPrivate'].inOrder(surface.rows)).toEqual(
      hasLead ? ['large.md:700', 'large.md:701', 'large.md:702'] : ['large.md:700', 'large.md:701'],
    );
    key(expectDefined(el.ownerDocument.activeElement) as HTMLElement, 'ArrowDown');
    expect(panel['rowSelection_abyssPrivate'].size).toBe(0);
    expect(state.get('taskStack')).toEqual([tasks[hasLead ? 703 : 702]]);
    panel.destroy();
  },
);

it('Mod+A follows the current filtered and reordered logical projection', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] Keep Z #task/inbox\n- [ ] Other #task/inbox\n- [ ] Keep A #task/inbox' },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true } },
    'tasks',
  );
  const { root: el, panel, state } = h;
  const tasks = h.index.list();
  h.query('Keep');
  state.set('centerListViewState', {
    ...state.get('centerListViewState'),
    groupBy: 'none',
    sortBy: { field: 'title', dir: 'asc' },
  });
  await h.completed();
  expect(key(el, 'a', { ctrlKey: true }).defaultPrevented).toBe(true);
  const targets = panel['taskMenuTargets_abyssPrivate']();
  expect((await targets.resolve(targets.signal)).map(({ task }) => task.node)).toEqual([
    tasks[2],
    tasks[0],
  ]);
  h.query('No matching rows');
  await h.completed();
  expect(key(el, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
  h.dispose();
});

it('Mod+A ignores other chords, consumed events, IME, and interactive targets', () => {
  const { el, panel, state } = makeCenter([task({ tags: ['#task/inbox'] })]);
  const first = expectDefined(cards(el)[0]);
  const select = vi.spyOn(panel['rowSelection_abyssPrivate'], 'selectAll');
  for (const init of [
    {},
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, metaKey: true },
    { ctrlKey: true, isComposing: true },
  ]) {
    expect(key(first, 'a', init).defaultPrevented).toBe(false);
  }
  const legacy = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(legacy, 'keyCode', { value: 229 });
  first.dispatchEvent(legacy);
  expect(legacy.defaultPrevented).toBe(false);
  const consumed = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  consumed.preventDefault();
  first.dispatchEvent(consumed);
  const targets = [
    first.createEl('input'),
    first.createEl('textarea'),
    first.createEl('select'),
    first.createEl('button'),
    first.createEl('a'),
    first.createDiv({ attr: { contenteditable: 'true' } }),
    first.createDiv({ cls: 'abyss-status-marker' }),
    first.createDiv({ cls: 'abyss-status-control' }),
    el.createDiv({ cls: 'abyss-popover' }),
  ];
  for (const target of targets)
    expect(key(target, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(select).not.toHaveBeenCalled();
  expect(state.get('taskStack')).toEqual([]);
  panel.destroy();
});

it('Mod+A leaves the real filter and foreign-realm input text selection alone', () => {
  const { el, panel } = makeCenter([task({ tags: ['#task/inbox'] })]);
  const input = expectDefined(el.querySelector<HTMLInputElement>('.abyss-center-search'));
  input.value = 'draft filter';
  input.focus();
  input.setSelectionRange(2, 5);
  const blur = vi.fn();
  input.addEventListener('blur', blur);
  expect(key(input, 'a', { metaKey: true }).defaultPrevented).toBe(false);
  expect(el.ownerDocument.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(input.value).toBe('draft filter');
  expect(blur).not.toHaveBeenCalled();
  const frame = el.ownerDocument.body.createEl('iframe');
  const doc = expectDefined(frame.contentDocument);
  doc.body.append(el);
  expect(key(input, 'a', { metaKey: true }).defaultPrevented).toBe(false);
  // Native creation matches the existing realm fixture; Obsidian createEl uses the main realm.
  const foreign = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
  expect(foreign).not.toBeInstanceOf(HTMLElement);
  el.append(foreign);
  expect(key(foreign, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(panel['rowSelection_abyssPrivate'].size).toBe(0);
  panel.destroy();
  frame.remove();
});

it.each(['search', 'projects', 'calendar'] as const)(
  'Mod+A does not acquire %s or a destroyed panel',
  (mode) => {
    const { el, panel, state } = makeCenter([task({ title: 'Task', tags: ['#task/inbox'] })]);
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    const selected = panel['rowSelection_abyssPrivate'];
    const anchor = selected.anchor;
    state.set('searchQuery', 'Task');
    state.set('mode', mode);
    if (mode === 'projects') renderDashboardList(panel, el, 'tasks.md');
    const stack = state.get('taskStack');
    expect(key(el, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
    // Search's preexisting page transition clears Tasks range selection at this checkpoint.
    expect(selected.anchor).toBe(mode === 'search' ? null : anchor);
    expect(selected.size).toBe(mode === 'search' ? 0 : 1);
    expect(state.get('taskStack')).toBe(stack);
    state.set('mode', 'tasks');
    expect(selected.size).toBe(mode === 'search' ? 0 : 1);
    panel.destroy();
    expect(key(el, 'a', { metaKey: true }).defaultPrevented).toBe(false);
  },
);

it('scrolls already-active Tasks after transient adoption without a full panel render', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({
      title: `Task ${line}`,
      tags: ['#task/inbox'],
      source: { filePath: 'adopt.md', line },
    }),
  );
  const { el, panel } = makeCenter(tasks);
  attach(el);
  flushViewport();
  const refresh = vi.spyOn(panel, 'refresh');
  const completion = vi.spyOn(
    panel as unknown as {
      completeTaskCardRender_abyssPrivate(): void;
    },
    'completeTaskCardRender_abyssPrivate',
  );
  const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
  el.remove();
  scroll.dispatchEvent(new Event('scroll'));
  flushViewport();
  const owner = taskViewportOwner();
  owner.doc.body.append(el);
  scroll.scrollTop = 76000.5;
  scroll.dispatchEvent(new owner.win.Event('scroll'));
  owner.flush();
  expect(cards(el).some((card) => Number(card.dataset['line']) > 1100)).toBe(true);
  expect(cards(el).length).toBeLessThan(100);
  expect(scroll.scrollTop).toBe(76000.5);
  expect(refresh).not.toHaveBeenCalled();
  expect(completion).not.toHaveBeenCalled();
  panel.destroy();
  owner.destroy();
});

it.each([false, true])(
  'settled task scroll decorates mounts without collecting logical selection (selected=%s)',
  (selected) => {
    const tasks = Array.from({ length: 1200 }, (_, line) =>
      task({
        title: `Task ${line}`,
        markdownTitle: `Task ${line} [[Alice]] [[Bob]]`,
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line },
      }),
    );
    const { el, panel, state } = makeCenter(tasks);
    state.set('centerListViewState', {
      ...state.get('centerListViewState'),
      groupBy: 'outgoing-link',
    });
    if (selected) key(el, 'a', { ctrlKey: true });
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe(
      selected ? '1200 tasks selected' : '',
    );
    const collect = vi.spyOn(panel['rowSelection_abyssPrivate'], 'selectedNodes');
    const visits = vi.spyOn(panel['rowSelection_abyssPrivate'], 'inOrder');
    const scroll = expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 25000.25;
    scroll.dispatchEvent(new Event('scroll'));
    flushViewport();
    expect(collect).not.toHaveBeenCalled();
    expect(visits).not.toHaveBeenCalled();
    expect(cards(el).length).toBeLessThan(100);
    expect(
      cards(el).every((card) => card.classList.contains('abyss-multi-selected') === selected),
    ).toBe(true);
    if (selected) {
      tasks.splice(0, 600);
      panel.refresh();
      expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('600 tasks selected');
      expect(
        panel['rowSelection_abyssPrivate']
          .selectedNodes(panel['listOrder_abyssPrivate']())
          .map(({ task }) => ('root' in task ? task.node : undefined)),
      ).toEqual(tasks);
    }
    panel.destroy();
  },
);

it('keeps owned compact selections only after current exact address validation', async () => {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] Keep First #task/inbox\n  - [ ] Keep Child\n- [ ] Keep Second #task/inbox\n' },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: false } },
    'tasks',
  );
  try {
    h.query('Keep');
    h.state.set('centerListViewState', { ...h.state.get('centerListViewState'), groupBy: 'none' });
    await h.completed();
    key(h.root, 'a', { ctrlKey: true });
    const before = h.panel['rowSelection_abyssPrivate'].size;
    expect(before).toBeGreaterThan(1);
    const targets = h.panel['taskMenuTargets_abyssPrivate']();
    const tasks = (await targets.resolve(targets.signal)).map((entry) => entry.task);
    const matches = vi.spyOn(h.index, 'matchesSearchAddress');
    await taskCommandsOf(h.panel).setBulkPriority(tasks, 'A');
    await h.completed();
    expect(matches).toHaveBeenCalled();
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(before);
    const after = h.panel['taskMenuTargets_abyssPrivate']();
    expect((await after.resolve(after.signal)).map((entry) => entry.task.node.priority)).toEqual(
      tasks.map(() => 'A'),
    );
    const nextTargets = h.panel['taskMenuTargets_abyssPrivate']();
    const nextTasks = (await nextTargets.resolve(nextTargets.signal)).map((entry) => entry.task);
    await taskCommandsOf(h.panel).setBulkPriority(nextTasks, 'B');
    await h.completed();
    expect(h.panel['rowSelection_abyssPrivate'].size).toBe(before);
  } finally {
    h.dispose();
  }
});

it('retains compact owned selection after normalized Inbox removal and delayed organization', async () => {
  const h = await hierarchyHarness({
    'source.md': '- [ ] Keep First #inbox\n- [ ] Keep Second #inbox\n',
    'target.md': '- [ ] Parent\n',
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    inbox: { mode: 'tag' as const, tag: '#inbox', removeTagOnAssign: true },
  };
  const tasks = new TaskApplicationService(
    h.index,
    h.repository,
    canonicalStatusCatalog(),
    clockFrom(Date.UTC(2026, 9, 3), 0),
    undefined,
    () => settings,
  );
  const search = canonicalSearchForIndex(h.index);
  const state = new AppState();
  state.set('selectedList', { type: 'project', path: 'source.md' });
  state.set('searchQuery', 'Keep');
  state.set('centerListViewState', { ...state.get('centerListViewState'), groupBy: 'none' });
  const panel = new CenterPanel({
    state,
    app: h.app,
    settings,
    queries: h.index,
    search,
    tasks,
    statusRegistry: new StatusRegistry(settings.taskStatuses),
  });
  const el = document.body.createDiv();
  prepareTaskPanelViewport(el, true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      taskListRect(this) ?? {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 700,
        bottom: 900,
        width: 700,
        height: 900,
        toJSON: () => ({}),
      }
    );
  });
  panel.mount(el);
  try {
    const input = expectDefined(el.querySelector<HTMLInputElement>('.abyss-center-search'));
    input.value = 'Keep';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchUiCompleted(el);
    key(el, 'a', { ctrlKey: true });
    const targets = panel['taskMenuTargets_abyssPrivate']();
    const selected = await targets.resolve(targets.signal);
    expect(selected).toHaveLength(2);
    await taskCommandsOf(panel).applyBulkTaskTags(
      selected.map((entry) => entry.task),
      ['#owned'],
      [],
    );
    await searchUiCompleted(el);
    expect(h.index.list({ filePath: 'source.md' }).map((task) => task.tags)).toEqual([
      ['#owned'],
      ['#owned'],
    ]);
    expect(panel['rowSelection_abyssPrivate'].size).toBe(2);
  } finally {
    panel.destroy();
    search.dispose();
    h.index.destroy();
    el.remove();
  }
});

it.each([
  ['calendar', false],
  ['projects', false],
  ['calendar', true],
  ['projects', true],
] as const)(
  'reconciles retained compact selection across %s (replacement=%s)',
  async (mode, replacement) => {
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] Keep First #task/inbox\n- [ ] Keep Second #task/inbox\n' },
      { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: false } },
      'tasks',
    );
    try {
      h.query('Keep');
      await h.completed();
      const previous = expectDefined(h.panel['taskSurface_abyssPrivate']?.search).order;
      key(h.root, 'a', { ctrlKey: true });
      const selection = h.panel['rowSelection_abyssPrivate'];
      expect(selection.size).toBe(2);
      const ranges = selection.ranges();
      const focus = selection.focus;
      h.state.set('mode', mode);
      expect(h.panel['taskSurface_abyssPrivate']?.search).toBeUndefined();
      expect(h.panel['selectionRows_abyssPrivate']).toBe(previous);
      if (replacement)
        h.index.installCommittedContent(
          'a.md',
          '- [ ] Keep Replacement #task/inbox\n- [ ] Keep Other #task/inbox\n',
        );
      h.state.set('mode', 'tasks');
      await h.completed();
      expect(expectDefined(h.panel['taskSurface_abyssPrivate']?.search).order).not.toBe(previous);
      expect(selection.ranges()).toEqual(replacement ? [] : ranges);
      expect(selection.focus).toBe(replacement ? null : focus);
      expect(h.root.querySelectorAll('.abyss-multi-selected')).toHaveLength(replacement ? 0 : 2);
    } finally {
      h.dispose();
    }
  },
);

async function acceptedCompactSelection() {
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] Keep First #task/inbox\n- [ ] Keep Second #task/inbox\n' },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: false } },
    'tasks',
  );
  h.query('Keep');
  await h.completed();
  key(h.root, 'a', { ctrlKey: true });
  const commands = taskCommandsOf(h.panel);
  const targets = h.panel['taskMenuTargets_abyssPrivate']();
  const subjects = (await targets.resolve(targets.signal)).map((entry) => entry.task);
  await commands.setBulkPriority(subjects, 'A');
  await h.completed();
  expect(h.panel['rowSelection_abyssPrivate'].size).toBe(2);
  return { ...h, commands };
}

it.each(['plain', 'ctrl', 'meta', 'arrow', 'range', 'all'] as const)(
  'retires accepted compact command evidence immediately on %s input',
  async (input) => {
    const h = await acceptedCompactSelection();
    try {
      const retire = vi.spyOn(h.commands, 'retireSelectionEvidence');
      const bind = vi.spyOn(h.panel['rowSelection_abyssPrivate'], 'bind');
      const card = expectDefined(cards(h.root)[0]);
      if (input === 'plain') click(card);
      if (input === 'ctrl')
        for (const selected of cards(h.root)) click(selected, { ctrlKey: true });
      if (input === 'meta')
        for (const selected of cards(h.root)) click(selected, { metaKey: true });
      if (input === 'arrow') key(card, 'ArrowDown');
      if (input === 'range') key(card, 'End', { shiftKey: true });
      if (input === 'all') key(h.root, 'a', { ctrlKey: true });
      expect(retire).toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      if (['plain', 'ctrl', 'meta', 'arrow'].includes(input))
        expect(h.panel['rowSelection_abyssPrivate'].size).toBe(0);
    } finally {
      h.dispose();
    }
  },
);

it.each(['plain', 'arrow'] as const)(
  'retires compact selection observation during a deferred command on %s input',
  async (input) => {
    const h = await acceptedCompactSelection();
    const entered = deferred<void>();
    const release = deferred<void>();
    const execute = h.tasks.execute.bind(h.tasks);
    vi.spyOn(h.tasks, 'execute').mockImplementationOnce(async (command, options) => {
      entered.resolve();
      await release.promise;
      return execute(command, options);
    });
    try {
      const targets = h.panel['taskMenuTargets_abyssPrivate']();
      const subjects = (await targets.resolve(targets.signal)).map((entry) => entry.task);
      const pending = h.commands.setBulkPriority(subjects, 'B');
      await entered.promise;
      const retire = vi.spyOn(h.commands, 'retireSelectionEvidence');
      const card = expectDefined(cards(h.root)[0]);
      if (input === 'plain') click(card);
      else key(card, 'ArrowDown');
      expect(retire).toHaveBeenCalledOnce();
      expect(h.panel['rowSelection_abyssPrivate'].size).toBe(0);
      release.resolve();
      await pending;
      await h.completed();
      expect(h.index.list().map((task) => task.priority)).toEqual(['B', 'B']);
      expect(h.panel['rowSelection_abyssPrivate'].size).toBe(0);
    } finally {
      release.resolve();
      h.dispose();
    }
  },
);

it('retires late compact hydration on Calendar entry while keeping the immutable selection order', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'a.md': Array.from(
        { length: 120 },
        (_, n) => `- [ ] Keep ${String(n).padStart(3, '0')} #task/inbox`,
      ).join('\n'),
    },
    { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: false } },
    'tasks',
  );
  const release = deferred<void>();
  const original = h.index.resolveSearchHits.bind(h.index);
  try {
    h.query('Keep');
    await h.completed();
    key(h.root, 'a', { ctrlKey: true });
    const selection = h.panel['rowSelection_abyssPrivate'];
    const focus = selection.focus;
    const compact = expectDefined(h.panel['taskSurface_abyssPrivate']?.search);
    const dispose = vi.spyOn(compact.rows, 'dispose');
    let signal: AbortSignal | undefined;
    const read = vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, abort) => {
      signal = abort;
      await release.promise;
      return original(hits, abort);
    });
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 6000;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      flushViewport();
      expect(read).toHaveBeenCalled();
    });
    h.state.set('mode', 'calendar');
    expect(dispose).toHaveBeenCalledOnce();
    expect(expectDefined(signal).aborted).toBe(true);
    expect(h.panel['selectionRows_abyssPrivate']).toBe(compact.order);
    release.resolve();
    await flushMicrotasks();
    expect(cards(h.root)).toHaveLength(0);
    read.mockRestore();
    h.state.set('mode', 'tasks');
    await h.completed();
    expect(selection.size).toBe(120);
    expect(selection.focus).toBe(focus);
  } finally {
    release.resolve();
    h.dispose();
  }
});
