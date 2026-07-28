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

  it('orders Today, Tomorrow, Set date…, and Set tag… in the single menu', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);

    openMenu(el.querySelector<HTMLElement>('.tc-task-card')!);

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
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
