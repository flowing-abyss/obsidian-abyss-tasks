// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskSnapshot } from '../src/tasks';
import {
  freshContainer,
  makeCenterPanelForTest,
  makeStubStore,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();

afterEach(() => {
  activeDocument
    .querySelectorAll('.abyss-test-center-attached')
    .forEach((element) => element.remove());
});

function makeCenter(tasks: TaskSnapshot[]): {
  el: HTMLElement;
  state: AppState;
  panel: CenterPanel;
} {
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const save = vi.fn().mockResolvedValue(undefined);
  const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
  const store = makeStubStore(tasks);
  const panel = makeCenterPanelForTest(state, store, null as never, DEFAULT_SETTINGS, tm);
  const el = freshContainer();
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
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(false);
    expect(cards[1]!.classList.contains('abyss-multi-selected')).toBe(false);
  });

  it('Ctrl+Click adds card to multi-selection', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(true);
  });

  it('Ctrl+Click two cards selects both', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(true);
    expect(cards[1]!.classList.contains('abyss-multi-selected')).toBe(true);
  });

  it('Ctrl+Click already-selected card deselects it', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(false);
  });

  it('announces multi-selection without changing task-scroll children', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    const scroll = el.querySelector<HTMLElement>('.abyss-center-scroll')!;
    const childOrder = Array.from(scroll.children);
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

    const live = el.querySelector<HTMLElement>('.abyss-selection-live');
    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(live?.textContent).toBe('2 tasks selected');
    expect(scroll.contains(live!)).toBe(false);
    expect(Array.from(scroll.children)).toEqual(childOrder);
    expect(cards[0]!.getAttribute('aria-describedby')).toContain('abyss-selected-state-');
    expect(cards[0]!.querySelector('.abyss-selected-state')?.textContent).toBe('Selected');
    const selectedStates = Array.from(el.querySelectorAll<HTMLElement>('.abyss-selected-state'));
    expect(selectedStates).toHaveLength(2);
    selectedStates.forEach((state) => expect(state.classList.contains('abyss-sr-only')).toBe(true));

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
      cards[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(menuTitles).toContain('2 tasks selected');
    } finally {
      addItem.mockRestore();
    }
  });

  it('removes a deselected card description while preserving the remaining selection state', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('1 task selected');
    expect(cards[0]!.querySelector('.abyss-selected-state')?.textContent).toBe('Selected');
    expect(cards[1]!.querySelector('.abyss-selected-state')).toBeNull();
    expect(cards[1]!.getAttribute('aria-describedby') ?? '').not.toContain('abyss-selected-state-');
  });

  it('preserves another component description while toggling selection state', () => {
    const { el } = makeCenter([t1]);
    const card = cards(el)[0]!;
    const externalDescription = el.createDiv({ attr: { id: 'other-component-description' } });
    card.setAttribute('aria-describedby', externalDescription.id);

    click(card, { ctrlKey: true });
    expect(card.getAttribute('aria-describedby')).toContain(externalDescription.id);
    expect(card.getAttribute('aria-describedby')).toContain('abyss-selected-state-');

    click(card, { ctrlKey: true });
    expect(card.getAttribute('aria-describedby')).toBe(externalDescription.id);
  });

  it('Escape key clears selection', () => {
    const { el } = makeCenter([t1, t2]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(false);
  });

  it('Shift+Click selects range', () => {
    const { el } = makeCenter([t1, t2, t3]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    // Ctrl+Click first to set anchor
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    // Shift+Click last
    cards[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(cards[0]!.classList.contains('abyss-multi-selected')).toBe(true);
    expect(cards[1]!.classList.contains('abyss-multi-selected')).toBe(true);
    expect(cards[2]!.classList.contains('abyss-multi-selected')).toBe(true);
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

    const expectedCard = arrow === 'ArrowDown' ? visibleCards[0]! : visibleCards[2]!;
    expect(state.get('taskStack')).toEqual([expected]);
    expect(activeDocument.activeElement).toBe(expectedCard);
    expect(expectedCard.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(selectedLines(el)).toEqual([]);
    el.remove();
  });

  it('uses rendered card order rather than query order for keyboard navigation', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    const [first, second, third] = cards(el);
    const scroll = first!.parentElement!;
    scroll.append(second!, third!, first!);

    key(el, 'ArrowDown');

    expect(state.get('taskStack')).toEqual([t2]);
    expect(activeDocument.activeElement).toBe(second);
    el.remove();
  });

  it('plain arrows move from the focused card and open exactly one task', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(visibleCards[0]!);

    key(visibleCards[0]!, 'ArrowDown');
    expect(state.get('taskStack')).toEqual([t2]);
    expect(activeDocument.activeElement).toBe(visibleCards[1]);
    expect(selectedLines(el)).toEqual([]);

    key(visibleCards[1]!, 'ArrowUp');
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
    click(visibleCards[0]!);
    key(visibleCards[0]!, 'ArrowUp');
    expect(state.get('taskStack')).toEqual([t1]);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);

    click(visibleCards[2]!);
    key(visibleCards[2]!, 'ArrowDown');
    expect(state.get('taskStack')).toEqual([t3]);
    expect(activeDocument.activeElement).toBe(visibleCards[2]);
    el.remove();
  });

  it('Shift+Arrow expands, shrinks on reversal, and crosses a fixed anchor', () => {
    const { el } = makeCenter([t1, t2, t3]);
    attach(el);
    const visibleCards = cards(el);
    click(visibleCards[1]!, { ctrlKey: true });

    key(visibleCards[1]!, 'ArrowDown', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['1', '2']);

    key(visibleCards[2]!, 'ArrowUp', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['1']);

    key(visibleCards[1]!, 'ArrowUp', { shiftKey: true });
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
    click(visibleCards[0]!, { ctrlKey: true });

    key(visibleCards[0]!, 'ArrowUp', { shiftKey: true });
    expect(selectedLines(el)).toEqual(['0']);
    expect(activeDocument.activeElement).toBe(visibleCards[0]);
    el.remove();
  });

  it('Shift+Click replaces an earlier range and shrinks toward the anchor', () => {
    const { el } = makeCenter([t1, t2, t3]);
    const visibleCards = cards(el);
    click(visibleCards[0]!, { ctrlKey: true });
    click(visibleCards[2]!, { shiftKey: true });
    expect(selectedLines(el)).toEqual(['0', '1', '2']);

    click(visibleCards[1]!, { shiftKey: true });

    expect(selectedLines(el)).toEqual(['0', '1']);
  });

  it('prunes hidden selections and stale range origins on task-list rerender', () => {
    const tasks = [t1, t2, t3];
    const { el, panel } = makeCenter(tasks);
    const visibleCards = cards(el);
    click(visibleCards.find((card) => card.dataset['line'] === '0')!, { ctrlKey: true });
    click(visibleCards.find((card) => card.dataset['line'] === '1')!, { ctrlKey: true });
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('2 tasks selected');

    tasks.splice(
      tasks.findIndex((candidate) => candidate.source.line === 0),
      1,
    );
    panel.refresh();

    expect(selectedLines(el)).toEqual(['1']);
    expect(el.querySelector('.abyss-selection-badge')).toBeNull();
    expect(el.querySelector('.abyss-selection-live')?.textContent).toBe('1 task selected');
    expect(cards(el)[0]!.querySelector('.abyss-selected-state')?.textContent).toBe('Selected');

    tasks.splice(0);
    panel.refresh();
    expect(selectedLines(el)).toEqual([]);
  });

  it('preserves a visible plain-click origin across rerender for the next Shift range', () => {
    const { el, panel } = makeCenter([t1, t2, t3]);
    click(cards(el).find((card) => card.dataset['line'] === '0')!);

    panel.refresh();
    click(cards(el).find((card) => card.dataset['line'] === '2')!, { shiftKey: true });

    expect(selectedLines(el)).toEqual(['0', '1', '2']);
  });

  it('preserves a visible Ctrl-toggle-off origin across rerender for the next Shift range', () => {
    const { el, panel } = makeCenter([t1, t2, t3]);
    const origin = cards(el).find((card) => card.dataset['line'] === '0')!;
    click(origin, { ctrlKey: true });
    click(origin, { ctrlKey: true });
    expect(selectedLines(el)).toEqual([]);

    panel.refresh();
    click(cards(el).find((card) => card.dataset['line'] === '2')!, { shiftKey: true });

    expect(selectedLines(el)).toEqual(['0', '1', '2']);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('%s+Click resets the next range anchor even when toggling off', (_name, modifier) => {
    const { el } = makeCenter([t1, t2, t3]);
    const visibleCards = cards(el);
    click(visibleCards[0]!, modifier);
    click(visibleCards[2]!, modifier);
    click(visibleCards[2]!, modifier);

    click(visibleCards[1]!, { shiftKey: true });

    expect(selectedLines(el)).toEqual(['1', '2']);
  });

  it('does not hijack Arrow keys from interactive or popover targets', () => {
    const { el, state } = makeCenter([t1, t2, t3]);
    const host = cards(el)[0]!;
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
});
