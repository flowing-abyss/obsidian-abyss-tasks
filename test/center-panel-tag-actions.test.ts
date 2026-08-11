import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import {
  flushMicrotasks,
  freshContainer,
  makeCenterPanelForTest,
  makeStubStore,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  activeDocument.querySelectorAll('.tc-date-picker-popover').forEach((element) => element.remove());
  activeDocument
    .querySelectorAll('.tc-test-center-attached')
    .forEach((element) => element.remove());
  activeDocument
    .querySelectorAll('.tc-status-popover, .tc-recurrence-popover, .tc-recurrence-delete-confirm')
    .forEach((element) => element.remove());
});

describe('CenterPanel recurrence context action', () => {
  it('opens one shared anchored editor and submits against the exact card task', async () => {
    const recurring = task({
      title: 'Repeat from card',
      status: 'open',
      tags: ['#task/inbox'],
      recurrence: 'every week',
      planning: { due: '2026-08-09' },
      source: {
        originalMarkdown: '- [ ] Repeat from card #task/inbox 🔁 every week 📅 2026-08-09',
        originalBlock: '- [ ] Repeat from card #task/inbox 🔁 every week 📅 2026-08-09',
      },
    });
    const { el, execute } = makeCenter([recurring]);

    el.querySelector<HTMLElement>('.tc-task-card .tc-status-marker')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const edit = activeDocument.querySelector<HTMLElement>('.tc-status-popover-edit-repeat');
    expect(edit).not.toBeNull();
    edit?.click();

    const popover = activeDocument.querySelector<HTMLElement>('.tc-recurrence-popover');
    expect(popover?.querySelectorAll('.tc-recurrence-editor')).toHaveLength(1);
    expect(popover?.querySelector<HTMLInputElement>('.tc-recurrence-raw')?.value).toBe(
      'every week',
    );
    const raw = popover?.querySelector<HTMLInputElement>('.tc-recurrence-raw');
    if (!raw) throw new Error('missing recurrence input');
    raw.value = 'every month';
    raw.dispatchEvent(new Event('input', { bubbles: true }));
    popover?.querySelector<HTMLButtonElement>('.tc-recurrence-save')?.click();
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref: recurring.ref },
      patch: {
        recurrence: { type: 'set', value: 'every month' },
      },
    });
  });
});

interface CapturedMenuItem {
  checked__: boolean | null;
  onClick__: ((event: MouseEvent) => unknown) | null;
  title__: string;
}

function captureMenu(): CapturedMenuItem[] {
  const items: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
    const item = {
      checked__: null as boolean | null,
      dom: document.createElement('div'),
      onClick__: null as ((event: MouseEvent) => unknown) | null,
      title__: '',
      onClick(value: (event: MouseEvent) => unknown) {
        this.onClick__ = value;
        return this;
      },
      setChecked(value: boolean | null) {
        this.checked__ = value;
        return this;
      },
      setDisabled() {
        return this;
      },
      setIcon() {
        return this;
      },
      setSection() {
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

function openMenu(card: HTMLElement): void {
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function relevantDateTitles(items: readonly CapturedMenuItem[]): string[] {
  return items
    .map((item) => item.title__)
    .filter((title) => ['Today', 'Tomorrow', 'Set date…', 'Set tag…'].includes(title));
}

function makeCenter(
  tasks: TaskSnapshot[] = [],
  settings: Partial<CalendarSettings> = {},
  pinnedTags: string[] = [],
) {
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const s: CalendarSettings = { ...DEFAULT_SETTINGS, ...settings, pinnedTags, archivedTags: [] };
  const save = vi.fn().mockResolvedValue(undefined);
  const tm = new TagManager(null as never, s, save);
  const store = makeStubStore(tasks);
  const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] }).taskQueries;
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'io-error',
    cause: 'test',
    contentState: 'unchanged',
  });
  const panel = makeCenterPanelForTest(state, store, null as never, s, tm, undefined, null, null, {
    queries,
    execute,
  });
  const el = freshContainer();
  panel.mount(el);
  return { el, state, tm, execute, panel };
}

describe('CenterPanel drag source', () => {
  it('task card has draggable attribute', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#task/inbox'],
        source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
      }),
    ];
    const { el } = makeCenter(tasks);
    const card = el.querySelector('.tc-task-card') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('dragstart sets state.draggingTask', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state } = makeCenter([t]);
    const card = el.querySelector('.tc-task-card') as HTMLElement;
    const ev = new MouseEvent('dragstart', { bubbles: true });
    card.dispatchEvent(ev);
    expect(state.get('draggingTask')).toBeTruthy();
  });

  it('dragend clears state.draggingTask', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state } = makeCenter([t]);
    const card = el.querySelector('.tc-task-card') as HTMLElement;
    const startEv = new MouseEvent('dragstart', { bubbles: true });
    card.dispatchEvent(startEv);
    const endEv = new MouseEvent('dragend', { bubbles: true });
    card.dispatchEvent(endEv);
    expect(state.get('draggingTask')).toBeNull();
  });
});

describe('CenterPanel tag→task drop target', () => {
  it('task card assigns a tag and removes the inbox tag in one API patch', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state, execute } = makeCenter([t]);
    const card = el.querySelector('.tc-task-card') as HTMLElement;

    state.set('draggingTag', '#task/next');
    const overEv = new MouseEvent('dragover', { bubbles: true });
    card.dispatchEvent(overEv);
    expect(card.classList.contains('tc-drop-target')).toBe(true);

    const dropEv = new MouseEvent('drop', { bubbles: true });
    card.dispatchEvent(dropEv);
    expect(card.classList.contains('tc-drop-target')).toBe(false);
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#task/next'], remove: ['#task/inbox'] } },
    });
  });

  it('task card ignores dragover when draggingTag is null', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state } = makeCenter([t]);
    state.set('draggingTag', null);
    const card = el.querySelector('.tc-task-card') as HTMLElement;
    const overEv = new MouseEvent('dragover', { bubbles: true });
    card.dispatchEvent(overEv);
    expect(card.classList.contains('tc-drop-target')).toBe(false);
  });

  it('ignores inline-code tag lookalikes and adds the real tag through the API', () => {
    const t = Object.assign(
      task({
        status: 'open',
        source: {
          originalMarkdown: '- [ ] t `#work` #task/inbox',
          originalBlock: '- [ ] t `#work` #task/inbox',
        },
      }),
      {
        tags: ['#task/inbox'],
      },
    );
    const { el, state, execute } = makeCenter([t]);
    const card = el.querySelector('.tc-task-card') as HTMLElement;

    expect(Array.from(el.querySelectorAll('.tc-task-tag')).map((chip) => chip.textContent)).toEqual(
      ['#task/inbox'],
    );
    state.set('draggingTag', '#work');
    card.dispatchEvent(new MouseEvent('drop', { bubbles: true }));

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#work'], remove: ['#task/inbox'] } },
    });
  });
});

describe('CenterPanel pinned-tag context menu', () => {
  it('offers add for an inline-only lookalike and sends an add patch', () => {
    const items: Array<{
      checked__: boolean | null;
      onClick__: ((event: MouseEvent) => unknown) | null;
      title__: string;
    }> = [];
    const addItem = vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      callback,
    ) {
      const item = {
        checked__: null as boolean | null,
        dom: document.createElement('div'),
        onClick__: null as ((event: MouseEvent) => unknown) | null,
        title__: '',
        onClick(value: (event: MouseEvent) => unknown) {
          this.onClick__ = value;
          return this;
        },
        setChecked(value: boolean | null) {
          this.checked__ = value;
          return this;
        },
        setDisabled() {
          return this;
        },
        setIcon() {
          return this;
        },
        setSection() {
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
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (
      this: Menu,
    ) {
      return this;
    });
    const t = Object.assign(
      task({
        status: 'open',
        source: {
          originalMarkdown: '- [ ] t `#work` #task/inbox',
          originalBlock: '- [ ] t `#work` #task/inbox',
        },
      }),
      {
        tags: ['#task/inbox'],
      },
    );
    const { el, execute } = makeCenter([t], {}, ['#work']);

    (el.querySelector('.tc-task-card') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const pinned = items.find((item) => item.title__ === '#work');
    expect(pinned?.checked__).toBe(false);

    pinned?.onClick__?.(new MouseEvent('click'));
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#work'], remove: [] } },
    });
    addItem.mockRestore();
    show.mockRestore();
  });
});

describe('CenterPanel task date context menus', () => {
  const first = task({
    status: 'open',
    tags: ['#task/inbox'],
    source: {
      filePath: 'a.md',
      line: 0,
      originalMarkdown: '- [ ] first #task/inbox',
      originalBlock: '- [ ] first #task/inbox',
    },
  });
  const second = task({
    status: 'open',
    tags: ['#task/inbox'],
    source: {
      filePath: 'a.md',
      line: 1,
      originalMarkdown: '- [ ] second #task/inbox',
      originalBlock: '- [ ] second #task/inbox',
    },
  });

  it('moves focus from the task card into the newly mounted native menu', () => {
    const menu = activeDocument.createElement('div');
    menu.className = 'menu';
    const firstItem = menu.createDiv({ cls: 'menu-item', text: 'Today' });
    captureMenu();
    vi.mocked(Menu.prototype.showAtMouseEvent).mockImplementation(function (this: Menu) {
      activeDocument.body.append(menu);
      return this;
    });
    const { el, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const card = el.querySelector<HTMLElement>('.tc-task-card')!;

    try {
      card.focus();
      openMenu(card);

      expect(activeDocument.activeElement).toBe(firstItem);
      expect(menu.contains(activeDocument.activeElement)).toBe(true);
      expect(firstItem.tabIndex).toBe(0);
    } finally {
      panel.destroy();
      menu.remove();
      el.remove();
    }
  });

  it('orders Today, Tomorrow, Set date…, and Set tag… in the single menu', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);

    openMenu(el.querySelector<HTMLElement>('.tc-task-card')!);

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
  });

  it('uses the center panel as the explicit boundary for custom-date placement', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);
    const card = el.querySelector<HTMLElement>('.tc-task-card')!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 200),
    });
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(390, 70, 20, 20),
    });
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('tc-date-picker-popover')) return rect(0, 0, 120, 40);
      return real.call(this);
    });

    openMenu(card);
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));

    const popover = el.querySelector<HTMLElement>('.tc-date-picker-popover')!;
    expect(popover.style.getPropertyValue('--tc-pop-left')).toBe('172px');
    expect(popover.style.getPropertyValue('--tc-pop-top')).toBe('44px');
  });

  it('restores custom-date focus to the matching replacement card after refresh', () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const originalCard = el.querySelector<HTMLElement>('.tc-task-card')!;

    try {
      execute.mockImplementation(() => {
        panel.refresh();
        return Promise.resolve({
          type: 'io-error',
          cause: 'test',
          contentState: 'unchanged',
        });
      });
      originalCard.focus();
      openMenu(originalCard);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = el.querySelector<HTMLInputElement>(
        '.tc-date-picker-popover input[type="date"]',
      )!;
      input.focus();
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));

      const replacement = el.querySelector<HTMLElement>('.tc-task-card')!;
      expect(originalCard.isConnected).toBe(false);
      expect(replacement).not.toBe(originalCard);
      expect(replacement.dataset['filePath']).toBe('a.md');
      expect(replacement.dataset['line']).toBe('0');
      expect(activeDocument.activeElement).toBe(replacement);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('keeps bulk custom-date focus on the final replacement across per-task refreshes', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first, second]);
    activeDocument.body.append(el);
    const cards = Array.from(el.querySelectorAll<HTMLElement>('.tc-task-card'));
    const originalTrigger = cards.find((card) => card.dataset['line'] === '0')!;
    const replacements: HTMLElement[] = [];

    try {
      for (const card of cards) {
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
      execute.mockImplementation(() => {
        panel.refresh();
        replacements.push(
          Array.from(el.querySelectorAll<HTMLElement>('.tc-task-card')).find(
            (card) => card.dataset['line'] === '0',
          )!,
        );
        return Promise.resolve({
          type: 'io-error',
          cause: 'test',
          contentState: 'unchanged',
        });
      });
      originalTrigger.focus();
      openMenu(originalTrigger);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = el.querySelector<HTMLInputElement>(
        '.tc-date-picker-popover input[type="date"]',
      )!;
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(replacements).toHaveLength(2);
      expect(originalTrigger.isConnected).toBe(false);
      expect(replacements[0]!.isConnected).toBe(false);
      expect(replacements[1]!.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(replacements[1]);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('sets and clears Tomorrow from the single menu', async () => {
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const items = captureMenu();
    const { el, execute } = makeCenter([first]);
    openMenu(el.querySelector<HTMLElement>('.tc-task-card')!);

    items.find((item) => item.title__ === 'Tomorrow')?.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();
    expect(execute).toHaveBeenLastCalledWith({
      type: 'patch',
      target: { type: 'task', ref: first.ref },
      patch: { due: { type: 'set', value: tomorrow } },
    });

    vi.restoreAllMocks();
    const tomorrowTask = { ...first, planning: { due: tomorrow as never } };
    const clearItems = captureMenu();
    const clearCenter = makeCenter([tomorrowTask]);
    openMenu(clearCenter.el.querySelector<HTMLElement>('.tc-task-card')!);
    clearItems.find((item) => item.title__ === 'Tomorrow')?.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();
    expect(clearCenter.execute).toHaveBeenLastCalledWith({
      type: 'patch',
      target: { type: 'task', ref: tomorrowTask.ref },
      patch: { due: { type: 'clear' } },
    });
  });

  it('orders Today, Tomorrow, Set date…, and Set tag… in the bulk menu', () => {
    const items = captureMenu();
    const { el } = makeCenter([first, second]);
    const cards = el.querySelectorAll<HTMLElement>('.tc-task-card');
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

    openMenu(cards[0]!);

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
  });

  it('sets a mixed bulk preset and clears an all-matching preset in visible order', async () => {
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const mixedSecond = { ...second, planning: { due: tomorrow as never } };
    const items = captureMenu();
    const mixedCenter = makeCenter([first, mixedSecond]);
    const mixedCards = Array.from(mixedCenter.el.querySelectorAll<HTMLElement>('.tc-task-card'));
    for (const card of mixedCards) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    const mixedFirstCard = mixedCards.find((card) => card.dataset['line'] === '0')!;
    const mixedSecondCard = mixedCards.find((card) => card.dataset['line'] === '1')!;
    mixedFirstCard.parentElement!.append(mixedFirstCard, mixedSecondCard);
    openMenu(mixedFirstCard);

    items.find((item) => item.title__ === 'Tomorrow')?.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();
    expect(mixedCenter.execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: first.ref },
        patch: { due: { type: 'set', value: tomorrow } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: mixedSecond.ref },
        patch: { due: { type: 'set', value: tomorrow } },
      },
    ]);

    vi.restoreAllMocks();
    const matchingFirst = { ...first, planning: { due: tomorrow as never } };
    const matchingSecond = { ...second, planning: { due: tomorrow as never } };
    const clearItems = captureMenu();
    const matchingCenter = makeCenter([matchingFirst, matchingSecond]);
    const matchingCards = Array.from(
      matchingCenter.el.querySelectorAll<HTMLElement>('.tc-task-card'),
    );
    for (const card of matchingCards) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    const matchingFirstCard = matchingCards.find((card) => card.dataset['line'] === '0')!;
    const matchingSecondCard = matchingCards.find((card) => card.dataset['line'] === '1')!;
    matchingFirstCard.parentElement!.append(matchingFirstCard, matchingSecondCard);
    openMenu(matchingFirstCard);

    clearItems.find((item) => item.title__ === 'Tomorrow')?.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();
    expect(matchingCenter.execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: matchingFirst.ref },
        patch: { due: { type: 'clear' } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: matchingSecond.ref },
        patch: { due: { type: 'clear' } },
      },
    ]);
  });

  it('opens mixed bulk dates empty and applies a custom due date sequentially in visible order', async () => {
    const datedSecond = { ...second, planning: { due: '2026-07-30' as never } };
    const items = captureMenu();
    const { el, execute } = makeCenter([first, datedSecond]);
    let resolveFirst:
      | ((result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void)
      | undefined;
    execute.mockReset();
    execute
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({
        type: 'io-error',
        cause: 'test',
        contentState: 'unchanged',
      });
    const cards = el.querySelectorAll<HTMLElement>('.tc-task-card');
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const firstCard = Array.from(cards).find((card) => card.dataset['line'] === '0')!;
    const secondCard = Array.from(cards).find((card) => card.dataset['line'] === '1')!;
    firstCard.parentElement!.append(firstCard, secondCard);
    openMenu(firstCard);

    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    const input = el.querySelector<HTMLInputElement>('.tc-date-picker-popover input[type="date"]');
    expect(input?.value).toBe('');
    input!.value = '2026-08-02';
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'patch',
      target: { type: 'task', ref: first.ref },
      patch: { due: { type: 'set', value: '2026-08-02' } },
    });

    resolveFirst?.({
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    });
    await flushMicrotasks();
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'patch',
      target: { type: 'task', ref: datedSecond.ref },
      patch: { due: { type: 'set', value: '2026-08-02' } },
    });
  });

  it('rejects an invalid custom date before executing a command', () => {
    const items = captureMenu();
    const { el, execute } = makeCenter([first]);
    openMenu(el.querySelector<HTMLElement>('.tc-task-card')!);
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    const input = el.querySelector<HTMLInputElement>('.tc-date-picker-popover input[type="date"]')!;

    input.value = 'not-a-date';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'destroy'] as const)(
    'removes picker document listeners when the panel %s removes its owner DOM',
    (lifecycle) => {
      vi.useFakeTimers();
      const items = captureMenu();
      const { el, panel } = makeCenter([first]);
      const ownerDocument = el.ownerDocument;
      const addListener = vi.spyOn(ownerDocument, 'addEventListener');
      const removeListener = vi.spyOn(ownerDocument, 'removeEventListener');
      openMenu(el.querySelector<HTMLElement>('.tc-task-card')!);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      vi.runOnlyPendingTimers();
      const added = addListener.mock.calls as unknown as Array<
        [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
      >;
      const keydown = added.find(([type]) => type === 'keydown')?.[1];
      const mousedown = added.find(([type]) => type === 'mousedown')?.[1];

      panel[lifecycle]();

      const removed = removeListener.mock.calls as unknown as Array<
        [string, EventListenerOrEventListenerObject, boolean | EventListenerOptions | undefined]
      >;
      const removedKeydown = removed.some(
        ([type, listener, options]) =>
          type === 'keydown' && listener === keydown && options === true,
      );
      const removedMousedown = removed.some(
        ([type, listener, options]) =>
          type === 'mousedown' && listener === mousedown && options === true,
      );
      ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (lifecycle === 'refresh') panel.destroy();

      expect(keydown).toBeDefined();
      expect(mousedown).toBeDefined();
      expect(removedKeydown).toBe(true);
      expect(removedMousedown).toBe(true);
    },
  );

  it('closes the bulk picker on Escape without clearing selection or detail state', () => {
    vi.useFakeTimers();
    const items = captureMenu();
    const { el, panel, state } = makeCenter([first, second]);
    el.addClass('tc-test-center-attached');
    activeDocument.body.append(el);
    state.set('taskStack', [first]);
    const cards = el.querySelectorAll<HTMLElement>('.tc-task-card');
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    openMenu(cards[0]!);
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    vi.runOnlyPendingTimers();
    const input = el.querySelector<HTMLInputElement>('.tc-date-picker-popover input[type="date"]')!;
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    const selectedAfterEscape = el.querySelectorAll('.tc-task-card.tc-multi-selected').length;
    const detailAfterEscape = state.get('taskStack');
    const pickerClosed = el.querySelector('.tc-date-picker-popover') === null;
    panel.destroy();

    expect(event.defaultPrevented).toBe(true);
    expect(pickerClosed).toBe(true);
    expect(selectedAfterEscape).toBe(2);
    expect(detailAfterEscape).toEqual([first]);
  });
});

describe('CenterPanel tag chip replace on drop', () => {
  it('dropping draggingTag onto a chip sends one replacement patch', () => {
    const t = task({
      status: 'open',
      tags: ['#work', '#task/inbox'],
      source: {
        originalMarkdown: '- [ ] t #work #task/inbox',
        originalBlock: '- [ ] t #work #task/inbox',
        line: 1,
      },
    });
    const { el, state, execute } = makeCenter([t], {
      inbox: { mode: 'both', tag: '#task/inbox', removeTagOnAssign: true },
    });

    state.set('draggingTag', '#task/next');
    const chip = el.querySelector('.tc-task-tag') as HTMLElement;
    expect(chip).not.toBeNull();

    chip.dispatchEvent(new MouseEvent('dragover', { bubbles: true }));
    expect(chip.classList.contains('tc-drop-target')).toBe(true);

    chip.dispatchEvent(new MouseEvent('drop', { bubbles: true }));
    expect(chip.classList.contains('tc-drop-target')).toBe(false);
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#task/next'], remove: ['#work'] } },
    });
  });

  it('dragging a chip onto itself is a no-op', () => {
    const t = task({
      status: 'open',
      tags: ['#work'],
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work', line: 1 },
    });
    const { el, state, execute } = makeCenter([t], {
      inbox: { mode: 'tag', tag: '#work', removeTagOnAssign: true },
    });

    state.set('draggingTag', '#work');
    const chip = el.querySelector('.tc-task-tag') as HTMLElement;
    chip.dispatchEvent(new MouseEvent('dragover', { bubbles: true }));
    expect(chip.classList.contains('tc-drop-target')).toBe(false);

    chip.dispatchEvent(new MouseEvent('drop', { bubbles: true }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('renders one canonical chip when the same spelling also appears in inline code', () => {
    const t = Object.assign(
      task({
        status: 'open',
        source: {
          originalMarkdown: '- [ ] t `#work` #work #task/inbox',
          originalBlock: '- [ ] t `#work` #work #task/inbox',
        },
      }),
      { tags: ['#work', '#task/inbox'] },
    );
    const { el } = makeCenter([t]);

    expect(Array.from(el.querySelectorAll('.tc-task-tag')).map((chip) => chip.textContent)).toEqual(
      ['#work', '#task/inbox'],
    );
  });
});

describe('CenterPanel inbox tasks (new inbox object)', () => {
  it('getInboxTasks tag mode returns tasks with inbox.tag', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#task/inbox'],
        source: { originalMarkdown: '- [ ] a #task/inbox', originalBlock: '- [ ] a #task/inbox' },
      }),
      task({
        status: 'open',
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] b #work', originalBlock: '- [ ] b #work' },
      }),
    ];
    const { el } = makeCenter(tasks, {
      inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
    });
    const cards = el.querySelectorAll('.tc-task-card');
    expect(cards).toHaveLength(1);
  });

  it('getInboxTasks untagged mode returns tasks without any tag', () => {
    const tasks = [
      task({
        status: 'open',
        source: { originalMarkdown: '- [ ] no tag', originalBlock: '- [ ] no tag' },
      }),
      task({
        status: 'open',
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] has tag #work', originalBlock: '- [ ] has tag #work' },
      }),
    ];
    const { el } = makeCenter(tasks, {
      inbox: { mode: 'untagged', tag: '#task/inbox', removeTagOnAssign: true },
    });
    const cards = el.querySelectorAll('.tc-task-card');
    expect(cards).toHaveLength(1);
  });
});
