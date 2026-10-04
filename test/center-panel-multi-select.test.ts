import { Menu } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { type CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskCommandResult, TaskRef, TaskSnapshot } from '../src/tasks';
import {
  appWithFiles,
  deferred,
  dispatchImeKey,
  expectDefined,
  freshContainer,
  makeStubStore,
  methodOf,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';
import { makeCenterPanelForTest, taskCommandsOf } from './support/panelHarness';

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
): {
  el: HTMLElement;
  state: AppState;
  panel: CenterPanel;
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
  );
  const el = freshContainer();
  attach(el);
  panel.mount(el);
  return { el, state, panel };
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

  it('keeps the selection across a Lists, Search, Lists round trip', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    click(expectDefined(cards(el)[0]), { ctrlKey: true });
    click(expectDefined(cards(el)[1]), { ctrlKey: true });

    state.set('searchQuery', 'Task 1');
    state.set('mode', 'search');
    expect(cards(el)).toHaveLength(1);
    state.set('mode', 'tasks');

    expect(selectedLines(el)).toEqual(['0', '1']);
  });

  it('reads no rows after a filter empties the list', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    click(expectDefined(cards(el)[0]));

    state.set('centerFilter', 'nothing matches');
    expect(cards(el)).toHaveLength(0);
    const event = key(el, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(state.get('taskStack')).toEqual([t1]);
    el.remove();
  });

  it('leaves ArrowDown in Search to the page', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    state.set('searchQuery', 'Task');
    state.set('mode', 'search');
    const result = expectDefined(cards(el)[0]);
    result.focus();

    const event = key(result, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(state.get('taskStack')).toEqual([]);
    expect(activeDocument.activeElement).toBe(result);
    expect(selectedLines(el)).toEqual([]);
    el.remove();
  });

  it('shows the empty states of Lists, Search, and a dashboard', () => {
    const { el, state, panel } = makeCenter([]);
    expect(el.querySelector('.abyss-center-scroll .abyss-center-empty')?.textContent).toBe(
      'No tasks',
    );

    state.set('searchQuery', 'nothing matches');
    state.set('mode', 'search');
    expect(el.querySelector('.abyss-center-scroll .abyss-center-empty')?.textContent).toBe(
      'No results',
    );

    state.set('mode', 'projects');
    const dashboard = renderDashboardList(panel, el, 'a.md');
    expect(dashboard.querySelector('.abyss-center-empty')?.textContent).toBe('No tasks yet');
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
      (
        panel as unknown as { selectedTasksInVisualOrder_abyssPrivate(): TaskSnapshot[] }
      ).selectedTasksInVisualOrder_abyssPrivate(),
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

it('pins an open recurrence editor across scrolling and cancels it when its task is filtered out', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({ title: `Task ${line}`, tags: ['#task/inbox'], source: { filePath: 'large.md', line } }),
  );
  const { el, panel, state } = makeCenter(tasks);
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
  state.set('centerFilter', 'unmatched task title');
  expect(editor.isConnected).toBe(false);
  expect(card.isConnected).toBe(false);
  panel.destroy();
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
  expect(panel['selectedTasksInVisualOrder_abyssPrivate']()).toEqual(tasks);
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
      queries: taskQueryApi(),
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

it('reveals an exact offscreen Search destination in the bounded list without moving focus', () => {
  const tasks = Array.from({ length: 1200 }, (_, line) =>
    task({
      title: `Task ${String(line).padStart(4, '0')}`,
      tags: ['#task/inbox'],
      source: { filePath: 'large.md', line },
    }),
  );
  const { el, state } = makeCenter(tasks);
  const target = expectDefined(tasks[1199]);
  state.set('searchQuery', target.title);
  state.set('mode', 'search');
  const result = expectDefined(el.querySelector<HTMLElement>('.abyss-task-title'));
  const outside = el.ownerDocument.body.createEl('input');
  outside.focus();
  result.click();
  expect(state.get('mode')).toBe('tasks');
  expect(state.get('selectedList')).toBe('inbox');
  expect(state.get('taskStack')).toEqual([target]);
  expect(el.querySelector('.abyss-task-card[data-line="1199"]')).not.toBeNull();
  expect(
    expectDefined(el.querySelector<HTMLElement>('.abyss-center-scroll')).scrollTop,
  ).toBeGreaterThan(50000);
  expect(cards(el).length).toBeLessThanOrEqual(100);
  expect(el.ownerDocument.activeElement).toBe(outside);
  outside.remove();
});
