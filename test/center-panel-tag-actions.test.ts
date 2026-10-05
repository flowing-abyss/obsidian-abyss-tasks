import { Menu, Modal } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import { localDate, type TaskApplicationApi, type TaskSnapshot } from '../src/tasks';
import { TagPickerModal } from '../src/ui/TagPickerModal';
import {
  appWithFiles,
  expectDefined,
  flushMicrotasks,
  loseFocusOnRemoval,
  makeStubStore,
  methodOf,
  objectMatching,
  task,
  useRealMoment,
} from './helpers';
import { makeCenterPanelForTest } from './support/panelHarness';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';

import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  activeDocument.querySelectorAll('.abyss-date-picker-popover').forEach((element) => {
    element.remove();
  });
  activeDocument.querySelectorAll('.abyss-test-center-attached').forEach((element) => {
    element.remove();
  });
  activeDocument
    .querySelectorAll(
      '.abyss-status-popover, .abyss-recurrence-popover, .abyss-recurrence-delete-confirm',
    )
    .forEach((element) => {
      element.remove();
    });
});

interface CapturedMenuItem {
  checked__: boolean | null;
  icon__: string;
  onClick__: ((event: MouseEvent) => unknown) | null;
  section__: string;
  title__: string;
}

function captureMenu(): CapturedMenuItem[] {
  const items: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
    const item = {
      checked__: null as boolean | null,
      dom: createDiv(),
      icon__: '',
      onClick__: null as ((event: MouseEvent) => unknown) | null,
      section__: '',
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

function openMenu(card: HTMLElement): void {
  const OwnerMouseEvent = card.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  card.dispatchEvent(new OwnerMouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function ownerEvent(ownerWindow: Window, type: string, init?: EventInit): Event {
  const OwnerEvent = (ownerWindow as unknown as { Event: typeof Event }).Event;
  return new OwnerEvent(type, init);
}

function installObsidianDomHelpers(ownerWindow: Window): void {
  const ownerRealm = ownerWindow as unknown as typeof window;
  const prototypePairs: Array<[object, object]> = [
    [HTMLElement.prototype, ownerRealm.HTMLElement.prototype],
    [Element.prototype, ownerRealm.Element.prototype],
    [Node.prototype, ownerRealm.Node.prototype],
  ];
  for (const [source, target] of prototypePairs) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === 'constructor' || name in target) continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (descriptor != null) Object.defineProperty(target, name, descriptor);
    }
  }

  const createEl = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
  ): HTMLElement {
    const createElement = methodOf(this.ownerDocument, 'createElement');
    const child = createElement.call(this.ownerDocument, tag);
    const classes = Array.isArray(options.cls) ? options.cls : options.cls?.split(' ');
    if (classes != null) child.classList.add(...classes.filter(Boolean));
    if (options.text !== undefined) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, value);
    }
    this.append(child);
    return child;
  };
  Object.defineProperties(ownerRealm.HTMLElement.prototype, {
    createEl: { configurable: true, value: createEl },
    createDiv: {
      configurable: true,
      value(
        this: HTMLElement,
        value:
          string | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
      ) {
        return createEl.call(this, 'div', typeof value === 'string' ? { cls: value } : value);
      },
    },
    createSpan: {
      configurable: true,
      value(
        this: HTMLElement,
        value:
          string | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
      ) {
        return createEl.call(this, 'span', typeof value === 'string' ? { cls: value } : value);
      },
    },
  });
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
  ownerDocument: Document = activeDocument,
) {
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const s: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
    ...settings,
    pinnedTags,
    archivedTags: [],
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const tm = new TagManager(null as never, s, save, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const store = makeStubStore(tasks);
  const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] }).taskQueries;
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'io-error',
    cause: 'test',
    contentState: 'unchanged',
  });
  const panel = makeCenterPanelForTest(
    state,
    store,
    appWithFiles({}),
    s,
    tm,
    undefined,
    null,
    null,
    {
      queries,
      execute,
    },
  );
  const createElement = methodOf(ownerDocument, 'createElement');
  const el = createElement.call(ownerDocument, 'div');
  prepareTaskPanelViewport(el);
  panel.mount(el);
  return { el, state, tm, execute, panel, queries };
}

function changedTaskResult(
  originalTask: TaskSnapshot,
): Awaited<ReturnType<TaskApplicationApi['execute']>> {
  const due = localDate('2026-08-02');
  const markdown = `${originalTask.source.originalMarkdown} 📅 ${due}`;
  const changedTask: TaskSnapshot = {
    ...originalTask,
    ref: { ...originalTask.ref, revision: `${originalTask.ref.revision}:due:${due}` },
    planning: { ...originalTask.planning, due },
    source: { ...originalTask.source, originalMarkdown: markdown, originalBlock: markdown },
  };
  return {
    type: 'ok',
    changed: true,
    outcome: { type: 'task', task: changedTask },
  };
}

function unchangedTaskResult(
  unchangedTask: TaskSnapshot,
): Awaited<ReturnType<TaskApplicationApi['execute']>> {
  return {
    type: 'ok',
    changed: false,
    outcome: { type: 'task', task: unchangedTask },
  };
}

async function settleChangedCustomDate(
  el: HTMLElement,
  items: readonly CapturedMenuItem[],
): Promise<HTMLElement> {
  const ownerWindow = el.ownerDocument.defaultView;
  if (ownerWindow == null) throw new Error('missing owner window');
  const card = el.querySelector<HTMLElement>('.abyss-task-card');
  if (card == null) throw new Error('missing task card');
  card.focus();
  openMenu(card);
  items
    .find((item) => item.title__ === 'Set date…')
    ?.onClick__?.(new ownerWindow.MouseEvent('click'));
  const input = el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]');
  if (input == null) throw new Error('missing custom date input');
  input.value = '2026-08-02';
  input.dispatchEvent(ownerEvent(ownerWindow, 'change', { bubbles: true }));
  await flushMicrotasks();
  return card;
}

/** Opens "Set date…" from a card's menu under fake timers, then closes the picker with Escape. */
function escapeCardDatePicker(
  el: HTMLElement,
  card: HTMLElement,
  items: readonly CapturedMenuItem[],
): void {
  openMenu(card);
  items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
  vi.runOnlyPendingTimers();
  const input = expectDefined(
    el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
  );
  expect(activeDocument.activeElement).toBe(input);
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(el.querySelector('.abyss-date-picker-popover')).toBeNull();
}

/** Opens "Set date…" from the focused card and types a date without committing it. */
async function openCustomDateDraft(el: HTMLElement, items: readonly CapturedMenuItem[]) {
  const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
  card.focus();
  openMenu(card);
  items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
  await flushMicrotasks();
  const popover = expectDefined(el.querySelector<HTMLElement>('.abyss-date-picker-popover'));
  const input = expectDefined(popover.querySelector<HTMLInputElement>('input[type="date"]'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
  input.value = '2026-08-02';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { card, popover, input };
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
    const card = el.querySelector('.abyss-task-card') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('dragstart sets state.draggingTaskNode', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state } = makeCenter([t]);
    const card = el.querySelector('.abyss-task-card') as HTMLElement;
    const ev = new MouseEvent('dragstart', { bubbles: true });
    card.dispatchEvent(ev);
    expect(state.get('draggingTaskNode')).toEqual({
      source: 'center-card',
      task: { root: t, path: [], node: t, target: { type: 'task', ref: t.ref } },
    });
  });

  it('dragend clears state.draggingTaskNode', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state } = makeCenter([t]);
    const card = el.querySelector('.abyss-task-card') as HTMLElement;
    const startEv = new MouseEvent('dragstart', { bubbles: true });
    card.dispatchEvent(startEv);
    const endEv = new MouseEvent('dragend', { bubbles: true });
    card.dispatchEvent(endEv);
    expect(state.get('draggingTaskNode')).toBeNull();
  });
});

describe('detached tag catalog menus', () => {
  it('opens the real tag menu without list/listNodes using observed strings and configured tags', () => {
    const items = captureMenu();
    const t = task({ tags: ['#task/inbox'] });
    const { el, panel, queries } = makeCenter([t], {}, ['#configured']);
    vi.spyOn(queries, 'observedTags').mockReturnValue(['#child', '#third']);
    vi.spyOn(queries, 'list').mockImplementation(() => {
      throw new Error('full list');
    });
    vi.spyOn(queries, 'listNodes').mockImplementation(() => {
      throw new Error('full nodes');
    });
    const opened: TagPickerModal[] = [];
    vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
      if (!(this instanceof TagPickerModal)) throw new Error('expected tag picker');
      opened.push(this);
      this.onOpen();
    });
    try {
      openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));
      items.find((item) => item.title__ === 'Set tag…')?.onClick__?.(new MouseEvent('click'));
      const modal = expectDefined(opened[0]);
      expect(
        [...modal.contentEl.querySelectorAll('[data-tag]')].map((button) =>
          button.getAttribute('data-tag'),
        ),
      ).toEqual(expect.arrayContaining(['#child', '#third', '#configured']));
    } finally {
      for (const modal of opened) modal.onClose();
      panel.destroy();
    }
  });
});

describe('CenterPanel tag→task drop target', () => {
  it('task card delegates tag assignment policy to the application API', () => {
    const t = task({
      status: 'open',
      tags: ['#task/inbox'],
      source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
    });
    const { el, state, execute } = makeCenter([t]);
    const card = el.querySelector('.abyss-task-card') as HTMLElement;

    state.set('draggingTag', '#task/next');
    const overEv = new MouseEvent('dragover', { bubbles: true });
    card.dispatchEvent(overEv);
    expect(card.classList.contains('abyss-drop-target')).toBe(true);

    const dropEv = new MouseEvent('drop', { bubbles: true });
    card.dispatchEvent(dropEv);
    expect(card.classList.contains('abyss-drop-target')).toBe(false);
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#task/next'] } },
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
    const card = el.querySelector('.abyss-task-card') as HTMLElement;
    const overEv = new MouseEvent('dragover', { bubbles: true });
    card.dispatchEvent(overEv);
    expect(card.classList.contains('abyss-drop-target')).toBe(false);
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
    const card = el.querySelector('.abyss-task-card') as HTMLElement;

    expect(
      Array.from(el.querySelectorAll('.abyss-task-tag')).map((chip) => chip.textContent),
    ).toEqual(['#task/inbox']);
    state.set('draggingTag', '#work');
    card.dispatchEvent(new MouseEvent('drop', { bubbles: true }));

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#work'] } },
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
        dom: createDiv(),
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

    (el.querySelector('.abyss-task-card') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const pinned = items.find((item) => item.title__ === '#work');
    expect(pinned?.checked__).toBe(false);

    pinned?.onClick__?.(new MouseEvent('click'));
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#work'] } },
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

  it.each(['single', 'bulk'] as const)(
    'consumes native menu Escape before workspace fallback for a %s task menu',
    (kind) => {
      const menu = createFragment().createDiv();
      menu.className = 'menu';
      const firstItem = menu.createDiv({ cls: 'menu-item', text: 'Today' });
      captureMenu();
      let shown: Menu | undefined;
      vi.mocked(methodOf(Menu.prototype, 'showAtMouseEvent')).mockImplementation(function (
        this: Menu,
      ) {
        shown = this.setParentElement(document.body);
        activeDocument.body.append(menu);
        return this;
      });
      const { el, panel } = makeCenter(kind === 'bulk' ? [first, second] : [first]);
      activeDocument.body.append(el);
      const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      const ownerWindow = expectDefined(el.ownerDocument.defaultView);
      const fallback = vi.fn();
      const nativeCapture = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        menu.remove();
        expectDefined(shown).hide();
      };
      const workspaceBubble = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !event.defaultPrevented) fallback();
      };
      ownerWindow.addEventListener('keydown', nativeCapture, true);
      ownerWindow.addEventListener('keydown', workspaceBubble);

      try {
        if (kind === 'bulk') {
          for (const selected of el.querySelectorAll<HTMLElement>('.abyss-task-card'))
            selected.dispatchEvent(
              new ownerWindow.MouseEvent('click', { bubbles: true, ctrlKey: true }),
            );
        }
        const selectedBefore = [...el.querySelectorAll('.abyss-multi-selected')];
        expect(selectedBefore).toHaveLength(kind === 'bulk' ? 2 : 0);
        card.focus();
        openMenu(card);

        expect(el.ownerDocument.activeElement).toBe(firstItem);
        expect(firstItem.tabIndex).toBe(0);
        const escape = new ownerWindow.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        firstItem.dispatchEvent(escape);

        expect(menu.isConnected).toBe(false);
        expect(fallback).not.toHaveBeenCalled();
        expect(escape.defaultPrevented).toBe(true);
        expect(el.ownerDocument.activeElement).toBe(card);
        expect([...el.querySelectorAll('.abyss-multi-selected')]).toEqual(selectedBefore);
      } finally {
        ownerWindow.removeEventListener('keydown', nativeCapture, true);
        ownerWindow.removeEventListener('keydown', workspaceBubble);
        panel.destroy();
        menu.remove();
        el.remove();
      }
    },
  );

  it('passes unrelated, modified and IME-owned keys through the native menu', () => {
    const menu = createFragment().createDiv({ cls: 'menu' });
    const firstItem = menu.createDiv({ cls: 'menu-item', text: 'Today' });
    captureMenu();
    let shown: Menu | undefined;
    vi.mocked(methodOf(Menu.prototype, 'showAtMouseEvent')).mockImplementation(function (
      this: Menu,
    ) {
      shown = this.setParentElement(document.body);
      activeDocument.body.append(menu);
      return this;
    });
    const { el, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
    const ownerWindow = expectDefined(el.ownerDocument.defaultView);
    const bubbled: KeyboardEvent[] = [];
    const observeBubble = (event: KeyboardEvent): void => {
      bubbled.push(event);
    };
    ownerWindow.addEventListener('keydown', observeBubble);
    const cases: Array<KeyboardEventInit & { legacyKeyCode?: number }> = [
      { key: 'ArrowDown' },
      { key: 'Escape', ctrlKey: true },
      { key: 'Escape', metaKey: true },
      { key: 'Escape', altKey: true },
      { key: 'Escape', shiftKey: true },
      { key: 'Escape', isComposing: true },
      { key: 'Process' },
      { key: 'Escape', legacyKeyCode: 229 },
    ];

    try {
      card.focus();
      openMenu(card);
      for (const { legacyKeyCode, ...init } of cases) {
        const keyEvent = new ownerWindow.KeyboardEvent('keydown', {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        if (legacyKeyCode !== undefined)
          Object.defineProperty(keyEvent, 'keyCode', { value: legacyKeyCode });
        firstItem.dispatchEvent(keyEvent);
        expect(keyEvent.defaultPrevented).toBe(false);
        expect(bubbled[bubbled.length - 1]).toBe(keyEvent);
      }

      menu.remove();
      expectDefined(shown).hide();
      panel.destroy();
      const bodyEscape = new ownerWindow.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      el.ownerDocument.body.dispatchEvent(bodyEscape);
      expect(bodyEscape.defaultPrevented).toBe(false);
      expect(bubbled[bubbled.length - 1]).toBe(bodyEscape);
    } finally {
      ownerWindow.removeEventListener('keydown', observeBubble);
      panel.destroy();
      menu.remove();
      el.remove();
    }
  });

  it('orders Today, Tomorrow, Set date…, and Set tag… in the single menu', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);

    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
  });

  it('places pinned tags before the edit group without creating an empty section', () => {
    const items = captureMenu();
    const { el } = makeCenter([first], {}, ['#focus']);

    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));

    expect(
      items
        .filter(({ title__ }) =>
          ['#focus', 'Set date…', 'Set tag…', 'Edit repeat…'].includes(title__),
        )
        .map(({ title__, section__ }) => [title__, section__]),
    ).toEqual([
      ['#focus', 'tags'],
      ['Set date…', 'edit'],
      ['Set tag…', 'edit'],
      ['Edit repeat…', 'edit'],
    ]);
  });

  it('keeps repeat editing in the native task menu', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);

    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));

    const editRepeat = items.find((item) => item.title__ === 'Edit repeat…');
    expect(editRepeat).toBeDefined();
    expect(editRepeat?.icon__).toBe('repeat-2');
  });

  it('uses the center panel as the explicit boundary for custom-date placement', () => {
    const items = captureMenu();
    const { el } = makeCenter([first]);
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 200),
    });
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(390, 70, 20, 20),
    });
    const real = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('abyss-date-picker-popover')) return rect(0, 0, 120, 40);
      return real.call(this);
    });

    openMenu(card);
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));

    const popover = expectDefined(el.querySelector<HTMLElement>('.abyss-date-picker-popover'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('172px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('44px');
  });

  it('restores custom-date focus to the matching replacement card after refresh', () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const originalCard = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));

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
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.focus();
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));

      const replacement = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      expect(originalCard.isConnected).toBe(true);
      expect(replacement).toBe(originalCard);
      expect(replacement.dataset['filePath']).toBe('a.md');
      expect(replacement.dataset['line']).toBe('0');
      expect(activeDocument.activeElement).toBe(replacement);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('waits for a changed command replacement render when settlement precedes notification', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const originalCard = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      originalCard.focus();
      openMenu(originalCard);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      panel.refresh();

      const replacement = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      expect(execute).toHaveBeenCalledOnce();
      expect(originalCard.isConnected).toBe(true);
      expect(replacement).toBe(originalCard);
      expect(activeDocument.activeElement).toBe(replacement);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('abandons deferred custom-date focus when the mounted window blurs', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const original = await settleChangedCustomDate(el, items);

      el.ownerDocument.defaultView?.dispatchEvent(new Event('blur'));
      original.blur();
      panel.refresh();

      const replacement = el.querySelector<HTMLElement>('.abyss-task-card');
      expect(original.isConnected).toBe(true);
      expect(replacement).not.toBeNull();
      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('abandons deferred custom-date focus after a pointer targets document background', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const original = await settleChangedCustomDate(el, items);
      const ownerWindow = el.ownerDocument.defaultView;
      if (ownerWindow == null) throw new Error('missing owner window');

      el.ownerDocument.body.dispatchEvent(
        ownerEvent(ownerWindow, 'pointerdown', { bubbles: true, cancelable: true }),
      );
      original.blur();
      panel.refresh();

      const replacement = el.querySelector<HTMLElement>('.abyss-task-card');
      expect(original.isConnected).toBe(true);
      expect(replacement).not.toBeNull();
      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it.each(['body', 'documentElement'] as const)(
    'abandons deferred custom-date focus after explicit focus enters %s',
    async (targetName) => {
      const items = captureMenu();
      const { el, execute, panel } = makeCenter([first]);
      activeDocument.body.append(el);
      const target = el.ownerDocument[targetName];
      const previousTabIndex = target.getAttribute('tabindex');

      try {
        execute.mockResolvedValue(changedTaskResult(first));
        const original = await settleChangedCustomDate(el, items);
        target.tabIndex = -1;
        target.focus();
        expect(activeDocument.activeElement).toBe(target);

        panel.refresh();

        expect(original.isConnected).toBe(true);
        expect(activeDocument.activeElement).toBe(target);
      } finally {
        panel.destroy();
        if (previousTabIndex === null) target.removeAttribute('tabindex');
        else target.setAttribute('tabindex', previousTabIndex);
        el.remove();
      }
    },
  );

  it('uses the mounted document and window for task-date departure ownership and cleanup', async () => {
    const iframe = createFragment().createEl('iframe');
    activeDocument.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    const ownerWindow = iframe.contentWindow;
    if (ownerDocument == null || ownerWindow == null) throw new Error('missing iframe realm');
    installObsidianDomHelpers(ownerWindow);
    const addDocumentListener = vi.spyOn(ownerDocument, 'addEventListener');
    const removeDocumentListener = vi.spyOn(ownerDocument, 'removeEventListener');
    const addWindowListener = vi.spyOn(ownerWindow, 'addEventListener');
    const removeWindowListener = vi.spyOn(ownerWindow, 'removeEventListener');
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first], {}, [], ownerDocument);
    ownerDocument.body.append(el);
    let destroyed = false;

    try {
      const focusRegistration = addDocumentListener.mock.calls.find(
        (call) => call[0] === 'focusin',
      );
      const pointerRegistration = addDocumentListener.mock.calls.find(
        (call) => call[0] === 'pointerdown',
      );
      const blurRegistration = addWindowListener.mock.calls.find((call) => call[0] === 'blur');
      execute.mockResolvedValue(changedTaskResult(first));
      const original = await settleChangedCustomDate(el, items);

      window.dispatchEvent(new Event('blur'));
      activeDocument.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      panel.refresh();
      const ownerReplacement = el.querySelector<HTMLElement>('.abyss-task-card');
      const ownerActiveAfterPrimaryDeparture = ownerDocument.activeElement;

      ownerWindow.dispatchEvent(ownerEvent(ownerWindow, 'blur'));
      original.blur();
      panel.refresh();
      const finalReplacement = el.querySelector<HTMLElement>('.abyss-task-card');
      const ownerActiveAfterOwnerBlur = ownerDocument.activeElement;
      panel.destroy();
      destroyed = true;

      expect(original.isConnected).toBe(false);
      expect(ownerReplacement).not.toBeNull();
      expect(ownerReplacement).toBe(original);
      expect(ownerActiveAfterPrimaryDeparture).toBe(ownerReplacement);
      expect(finalReplacement).not.toBeNull();
      expect(finalReplacement).toBe(ownerReplacement);
      expect(ownerActiveAfterOwnerBlur).toBe(ownerDocument.body);
      expect(focusRegistration).toBeDefined();
      expect(pointerRegistration).toBeDefined();
      expect(blurRegistration).toBeDefined();
      expect(
        removeDocumentListener.mock.calls.some(
          (call) =>
            call[0] === 'focusin' &&
            call[1] === focusRegistration?.[1] &&
            call[2] === focusRegistration[2],
        ),
      ).toBe(true);
      expect(
        removeDocumentListener.mock.calls.some(
          (call) =>
            call[0] === 'pointerdown' &&
            call[1] === pointerRegistration?.[1] &&
            call[2] === pointerRegistration[2],
        ),
      ).toBe(true);
      expect(
        removeWindowListener.mock.calls.some(
          (call) =>
            call[0] === 'blur' &&
            call[1] === blurRegistration?.[1] &&
            call[2] === blurRegistration[2],
        ),
      ).toBe(true);
    } finally {
      if (!destroyed) panel.destroy();
      iframe.remove();
    }
  });

  it('retains focus through every deferred bulk replacement after all commands settle', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first, second]);
    activeDocument.body.append(el);
    const cards = Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card'));
    const originalTrigger = expectDefined(cards.find((card) => card.dataset['line'] === '0'));

    try {
      for (const card of cards) {
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
      execute
        .mockResolvedValueOnce(changedTaskResult(first))
        .mockResolvedValueOnce(changedTaskResult(second));
      originalTrigger.focus();
      openMenu(originalTrigger);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      panel.refresh();
      const firstReplacement = expectDefined(
        Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
          (card) => card.dataset['line'] === '0',
        ),
      );
      panel.refresh();

      const finalReplacement = expectDefined(
        Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
          (card) => card.dataset['line'] === '0',
        ),
      );
      expect(execute).toHaveBeenCalledTimes(2);
      expect(originalTrigger.isConnected).toBe(true);
      expect(firstReplacement.isConnected).toBe(true);
      expect(finalReplacement.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(finalReplacement);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('stops changed-command continuity after focus intentionally leaves the replacement', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      openMenu(card);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      panel.refresh();
      outside.focus();

      panel.refresh();

      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      panel.destroy();
      outside.remove();
      el.remove();
    }
  });

  it('does not resurrect focus after a completed render proves the changed task absent', async () => {
    const items = captureMenu();
    const tasks = [first];
    const { el, execute, panel } = makeCenter(tasks);
    activeDocument.body.append(el);

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      openMenu(card);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      panel.refresh();
      expect(activeDocument.activeElement).toBe(el.querySelector<HTMLElement>('.abyss-task-card'));

      tasks.splice(0);
      panel.refresh();
      expect(activeDocument.activeElement).toBe(activeDocument.body);
      tasks.push(first);
      panel.refresh();

      expect(el.querySelector('.abyss-task-card')).not.toBeNull();
      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('preserves changed focus across coalesced and later Search requests until departure', async () => {
    const items = captureMenu();
    const h = await mountCanonicalSearchUi({ 'search.md': '- [ ] focus needle' }, DEFAULT_SETTINGS);
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    try {
      h.query('focus needle');
      await h.completed();
      const originalCard = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      originalCard.focus();
      openMenu(originalCard);
      expectDefined(expectDefined(items.find((item) => item.title__ === 'Set date…')).onClick__)(
        new MouseEvent('click'),
      );
      const input = expectDefined(
        h.root.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();
      h.panel.refresh();
      h.panel.refresh();
      h.panel.refresh();
      await h.completed();
      const replacement = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      expect(originalCard.isConnected).toBe(true);
      expect(replacement).toBe(originalCard);
      expect(activeDocument.activeElement).toBe(replacement);
      h.panel.refresh();
      await h.completed();
      const later = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      expect(replacement.isConnected).toBe(true);
      expect(later).toBe(replacement);
      expect(activeDocument.activeElement).toBe(later);
      outside.focus();
      h.panel.refresh();
      await h.completed();
      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      h.dispose();
      outside.remove();
    }
  });

  it('keeps bulk custom-date focus on the final replacement across per-task refreshes', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first, second]);
    activeDocument.body.append(el);
    const cards = Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card'));
    const originalTrigger = expectDefined(cards.find((card) => card.dataset['line'] === '0'));
    const replacements: HTMLElement[] = [];

    try {
      for (const card of cards) {
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
      const changedTasks = [first, second];
      execute.mockImplementation(() => {
        panel.refresh();
        replacements.push(
          expectDefined(
            Array.from(el.querySelectorAll<HTMLElement>('.abyss-task-card')).find(
              (card) => card.dataset['line'] === '0',
            ),
          ),
        );
        return Promise.resolve(
          changedTaskResult(expectDefined(changedTasks[replacements.length - 1])),
        );
      });
      originalTrigger.focus();
      openMenu(originalTrigger);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';

      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(replacements).toHaveLength(2);
      expect(originalTrigger.isConnected).toBe(true);
      expect(expectDefined(replacements[0]).isConnected).toBe(true);
      expect(expectDefined(replacements[1]).isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(replacements[1]);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it.each([
    ['an unchanged command', unchangedTaskResult(first)],
    ['a failed command', { type: 'io-error', cause: 'test', contentState: 'unchanged' } as const],
  ])('does not carry focus into a later unrelated refresh after %s', async (_case, result) => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      execute.mockResolvedValue(result);
      const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      openMenu(card);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.value = '2026-08-02';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flushMicrotasks();

      card.blur();
      panel.refresh();

      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('returns focus to a Search result card when its date picker closes', async () => {
    const items = captureMenu();
    const h = await mountCanonicalSearchUi({ 'search.md': '- [ ] first' }, DEFAULT_SETTINGS);
    try {
      h.query('first');
      await h.completed();
      const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      vi.useFakeTimers();
      escapeCardDatePicker(h.root, card, items);
      expect(activeDocument.activeElement).toBe(card);
    } finally {
      h.dispose();
    }
  });

  it('returns focus to a dashboard card when its date picker closes', () => {
    vi.useFakeTimers();
    const items = captureMenu();
    const { el, state, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      state.set('mode', 'projects');
      const host = el.createDiv({ cls: 'abyss-project-tasks' });
      (
        panel as unknown as {
          renderProjectTasks_abyssPrivate(host: HTMLElement, path: string): void;
        }
      ).renderProjectTasks_abyssPrivate(host, 'a.md');
      const card = expectDefined(host.querySelector<HTMLElement>('.abyss-task-card'));

      escapeCardDatePicker(el, card, items);

      expect(activeDocument.activeElement).toBe(card);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('does not carry focus into a later unrelated refresh after custom-date cancellation', () => {
    vi.useFakeTimers();
    const items = captureMenu();
    const { el, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      openMenu(card);
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      vi.runOnlyPendingTimers();
      const input = expectDefined(
        el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

      (activeDocument.activeElement as HTMLElement | null)?.blur();
      panel.refresh();

      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('sets and clears Tomorrow from the single menu', async () => {
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const items = captureMenu();
    const { el, execute } = makeCenter([first]);
    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));

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
    openMenu(expectDefined(clearCenter.el.querySelector<HTMLElement>('.abyss-task-card')));
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
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );

    openMenu(expectDefined(cards[0]));

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
  });

  it('sets a mixed bulk preset and clears an all-matching preset in visible order', async () => {
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const mixedSecond = { ...second, planning: { due: tomorrow as never } };
    const items = captureMenu();
    const mixedCenter = makeCenter([first, mixedSecond]);
    const mixedCards = Array.from(mixedCenter.el.querySelectorAll<HTMLElement>('.abyss-task-card'));
    for (const card of mixedCards) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    const mixedFirstCard = expectDefined(mixedCards.find((card) => card.dataset['line'] === '0'));
    openMenu(mixedFirstCard);

    items.find((item) => item.title__ === 'Tomorrow')?.onClick__?.(new MouseEvent('click'));
    await flushMicrotasks();
    // The date sort shows the dated task first.
    expect(mixedCenter.execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'patch',
        target: { type: 'task', ref: mixedSecond.ref },
        patch: { due: { type: 'set', value: tomorrow } },
      },
      {
        type: 'patch',
        target: { type: 'task', ref: first.ref },
        patch: { due: { type: 'set', value: tomorrow } },
      },
    ]);

    vi.restoreAllMocks();
    const matchingFirst = { ...first, planning: { due: tomorrow as never } };
    const matchingSecond = { ...second, planning: { due: tomorrow as never } };
    const clearItems = captureMenu();
    const matchingCenter = makeCenter([matchingFirst, matchingSecond]);
    const matchingCards = Array.from(
      matchingCenter.el.querySelectorAll<HTMLElement>('.abyss-task-card'),
    );
    for (const card of matchingCards) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    const matchingFirstCard = expectDefined(
      matchingCards.find((card) => card.dataset['line'] === '0'),
    );
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
      ((result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void) | undefined;
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
    // The date sort shows datedSecond first; query order and click order both put first first.
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    const firstCard = expectDefined(Array.from(cards).find((card) => card.dataset['line'] === '0'));
    openMenu(firstCard);

    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    const input = el.querySelector<HTMLInputElement>(
      '.abyss-date-picker-popover input[type="date"]',
    );
    expect(input?.value).toBe('');
    expectDefined(input).value = '2026-08-02';
    expectDefined(input).dispatchEvent(new Event('change', { bubbles: true }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'patch',
      target: { type: 'task', ref: datedSecond.ref },
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
      target: { type: 'task', ref: first.ref },
      patch: { due: { type: 'set', value: '2026-08-02' } },
    });
  });

  it('rejects an invalid custom date before executing a command', () => {
    const items = captureMenu();
    const { el, execute } = makeCenter([first]);
    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    const input = expectDefined(
      el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
    );

    input.value = 'not-a-date';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(execute).not.toHaveBeenCalled();
  });

  it('picks a keyboard custom date once, on Enter', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const { card, input } = await openCustomDateDraft(el, items);
      // Chromium fires change after every typed segment, so the change alone must not pick.
      expect(execute).not.toHaveBeenCalled();

      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(enter);
      await flushMicrotasks();
      panel.refresh();

      const replacement = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
      expect(enter.defaultPrevented).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(card.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(replacement);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('picks nothing when Escape cancels a keyboard custom date', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);

    try {
      const { card, popover, input } = await openCustomDateDraft(el, items);
      loseFocusOnRemoval(popover, input, card);

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      // Picking on the focusout that the removal fires would write the typed date.
      expect(execute).not.toHaveBeenCalled();
      expect(popover.isConnected).toBe(false);
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('picks nothing when a render removes a keyboard custom date', async () => {
    const items = captureMenu();
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] Task #task/inbox' },
      { ...DEFAULT_SETTINGS, inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true } },
      'tasks',
    );
    const execute = vi.spyOn(h.tasks, 'execute');
    try {
      const { card, popover, input } = await openCustomDateDraft(h.root, items);
      loseFocusOnRemoval(popover, input, card);
      h.query('unmatched task');
      await h.completed();
      expect(execute).not.toHaveBeenCalled();
      expect(popover.isConnected).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('picks a keyboard custom date on an outside press and leaves focus where the press put it', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const rail = activeDocument.body.createDiv();

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const { card } = await openCustomDateDraft(el, items);
      expect(execute).not.toHaveBeenCalled();

      rail.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      rail.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      // Chromium moves focus to body after a press on a non-focusable target.
      (activeDocument.activeElement as HTMLElement | null)?.blur();
      await flushMicrotasks();
      panel.refresh();

      // CenterPanel revokes its focus continuity on pointerdown, so a flush that armed it after
      // the press would pull focus back to the card.
      expect(execute).toHaveBeenCalledOnce();
      expect(card.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(activeDocument.body);
    } finally {
      panel.destroy();
      el.remove();
      rail.remove();
    }
  });

  it('picks a keyboard custom date when focus departs and keeps focus where it went', async () => {
    const items = captureMenu();
    const { el, execute, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const next = activeDocument.body.createEl('button', { text: 'Next' });
    const cardFocus = vi.fn();

    try {
      execute.mockResolvedValue(changedTaskResult(first));
      const { card } = await openCustomDateDraft(el, items);
      card.addEventListener('focus', cardFocus);
      expect(execute).not.toHaveBeenCalled();

      next.focus();
      await flushMicrotasks();
      panel.refresh();

      // A departure pick that returned focus would focus the card, where Chromium keeps it.
      expect(cardFocus).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(activeDocument.activeElement).toBe(next);
    } finally {
      panel.destroy();
      el.remove();
      next.remove();
    }
  });

  it.each(['filter', 'destroy'] as const)(
    'removes picker document listeners when the panel %s removes its owner DOM',
    async (lifecycle) => {
      const items = captureMenu();
      const h = await mountCanonicalSearchUi(
        { 'a.md': '- [ ] Task #task/inbox' },
        {
          ...DEFAULT_SETTINGS,
          inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
        },
        'tasks',
      );
      const { root: el, panel } = h;
      const ownerDocument = el.ownerDocument;
      const addListener = vi.spyOn(ownerDocument, 'addEventListener');
      const removeListener = vi.spyOn(ownerDocument, 'removeEventListener');
      openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));
      items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
      await flushMicrotasks();
      const added = addListener.mock.calls as unknown as Array<
        [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
      >;
      const keydown = added.find(([type]) => type === 'keydown')?.[1];
      const mousedown = added.find(([type]) => type === 'mousedown')?.[1];

      if (lifecycle === 'filter') {
        h.query('unmatched task');
        await h.completed();
      } else panel.destroy();

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
      h.dispose();

      expect(keydown).toBeDefined();
      expect(mousedown).toBeDefined();
      expect(removedKeydown).toBe(true);
      expect(removedMousedown).toBe(true);
    },
  );

  it('shows case-equivalent bulk tags checked and removes them from the held targets', async () => {
    const items = captureMenu();
    const tasks = [
      task({ ...first, tags: ['#Work', '#task/inbox'] }),
      task({ ...second, tags: ['#work', '#task/inbox'] }),
    ];
    const { el, panel, execute } = makeCenter(tasks);
    const opened: TagPickerModal[] = [];
    vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
      if (!(this instanceof TagPickerModal)) throw new Error('Expected tag picker');
      opened.push(this);
      this.onOpen();
    });
    try {
      const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
      for (const card of cards)
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      openMenu(expectDefined(cards[0]));
      items.find((item) => item.title__ === 'Set tag…')?.onClick__?.(new MouseEvent('click'));
      const modal = expectDefined(opened[0]);
      const button = expectDefined(
        modal.contentEl.querySelector<HTMLButtonElement>('[data-tag="#Work"]'),
      );
      expect(button.getAttribute('aria-pressed')).toBe('true');
      button.click();
      modal.onClose();
      await flushMicrotasks();
      expect(execute.mock.calls.map(([command]) => command)).toEqual(
        tasks.map((held) => ({
          type: 'patch',
          target: { type: 'task', ref: held.ref },
          patch: { tags: { remove: ['#Work'] } },
        })),
      );
    } finally {
      opened[0]?.contentEl.empty();
      opened[0]?.containerEl.remove();
      panel.destroy();
      el.remove();
    }
  });
  it('closes the bulk picker on Escape without clearing selection or detail state', () => {
    vi.useFakeTimers();
    const items = captureMenu();
    const { el, panel, state } = makeCenter([first, second]);
    el.addClass('abyss-test-center-attached');
    activeDocument.body.append(el);
    state.set('taskStack', [first]);
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    openMenu(expectDefined(cards[0]));
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    vi.runOnlyPendingTimers();
    const input = expectDefined(
      el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
    );
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    const selectedAfterEscape = el.querySelectorAll('.abyss-task-card.abyss-multi-selected').length;
    const detailAfterEscape = state.get('taskStack');
    const pickerClosed = el.querySelector('.abyss-date-picker-popover') === null;
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
    const chip = el.querySelector('.abyss-task-tag') as HTMLElement;
    expect(chip).not.toBeNull();

    chip.dispatchEvent(new MouseEvent('dragover', { bubbles: true }));
    expect(chip.classList.contains('abyss-drop-target')).toBe(true);

    chip.dispatchEvent(new MouseEvent('drop', { bubbles: true }));
    expect(chip.classList.contains('abyss-drop-target')).toBe(false);
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: t.ref.filePath, line: t.ref.line }),
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
    const chip = el.querySelector('.abyss-task-tag') as HTMLElement;
    chip.dispatchEvent(new MouseEvent('dragover', { bubbles: true }));
    expect(chip.classList.contains('abyss-drop-target')).toBe(false);

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

    expect(
      Array.from(el.querySelectorAll('.abyss-task-tag')).map((chip) => chip.textContent),
    ).toEqual(['#work', '#task/inbox']);
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
    const cards = el.querySelectorAll('.abyss-task-card');
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
    const cards = el.querySelectorAll('.abyss-task-card');
    expect(cards).toHaveLength(1);
  });
});

describe('outgoing occurrence date focus', () => {
  it.each(['escape', 'save', 'outside', 'replaced'] as const)(
    'keeps Bob occurrence authority on %s',
    async (mode) => {
      const items = captureMenu();
      const linked = task({
        markdownTitle: '[[Alice]] [[Bob]]',
        tags: ['#task/inbox'],
        source: { filePath: 'tasks.md', line: 0 },
      });
      const tasks = [linked];
      const h = makeCenter(tasks);
      activeDocument.body.append(h.el);
      const outside = activeDocument.body.createEl('input');
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        groupBy: 'outgoing-link',
      });
      const rows = () => [...h.el.querySelectorAll<HTMLElement>('.abyss-task-card')];
      const bob = expectDefined(rows()[1]);
      try {
        bob.click();
        bob.focus();
        openMenu(bob);
        expectDefined(expectDefined(items.find((item) => item.title__ === 'Set date…')).onClick__)(
          new MouseEvent('click'),
        );
        const input = expectDefined(
          h.el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input'),
        );
        if (mode === 'escape') {
          input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          );
          expect(activeDocument.activeElement).toBe(bob);
        } else {
          let release: (() => void) | undefined;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          h.execute.mockImplementation(async () => {
            await held;
            return changedTaskResult(linked);
          });
          input.value = '2026-08-02';
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (mode === 'outside') outside.focus();
          release?.();
          await flushMicrotasks();
          const result = changedTaskResult(linked);
          if (result.type !== 'ok' || result.outcome.type !== 'task') throw new Error('fixture');
          tasks[0] =
            mode === 'replaced'
              ? { ...linked, ref: { ...linked.ref, revision: 'external-replacement' } }
              : result.outcome.task;
          h.panel.refresh();
          if (mode === 'outside') expect(activeDocument.activeElement).toBe(outside);
          else if (mode === 'replaced') expect(rows()).not.toContain(activeDocument.activeElement);
          else expect(activeDocument.activeElement).toBe(rows()[1]);
        }
      } finally {
        h.panel.destroy();
        outside.remove();
        h.el.remove();
      }
    },
  );
});

describe('repeated outgoing rows command boundary', () => {
  it.each(['#work', 'Delete all', 'Archive all', 'In progress'])(
    'submits %s only once per physical task from a range with repeated rows',
    async (label) => {
      const items = captureMenu();
      const linked = task({
        markdownTitle: '[[Alice]] [[Bob]]',
        tags: ['#task/inbox'],
        source: { filePath: 'tasks.md', line: 0 },
      });
      const other = task({
        markdownTitle: '[[Carol]]',
        tags: ['#task/inbox'],
        source: { filePath: 'tasks.md', line: 1 },
      });
      const h = makeCenter([linked, other], {}, ['#work']);
      activeDocument.body.append(h.el);
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        groupBy: 'outgoing-link',
      });
      const rows = [...h.el.querySelectorAll<HTMLElement>('.abyss-task-card')];
      expect(rows).toHaveLength(3);
      expectDefined(rows[0]).click();
      expectDefined(rows[2]).dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true }),
      );
      expect(h.el.querySelectorAll('.abyss-multi-selected')).toHaveLength(3);
      openMenu(expectDefined(rows[1]));
      expect(items.some((item) => item.title__ === '2 tasks selected')).toBe(true);
      if (label === 'Archive all')
        h.execute.mockImplementation(async (command) => ({
          type: 'ok',
          changed: true,
          outcome: {
            type: 'archived',
            ref: command.type === 'archive' ? command.ref : linked.ref,
            filePath: 'archive.md',
          },
        }));
      const action = expectDefined(
        items.find((item) => item.title__ === (label === '#work' ? '#work  (0/2)' : label)),
      );
      action.onClick__?.(new MouseEvent('click'));
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(2);
      const refs = h.execute.mock.calls.map(([command]) => {
        if ('ref' in command) return command.ref;
        if ('target' in command && 'ref' in command.target) return command.target.ref;
        return undefined;
      });
      expect(refs).toEqual(
        label === 'Delete all' ? [other.ref, linked.ref] : [linked.ref, other.ref],
      );
      h.panel.destroy();
      h.el.remove();
    },
  );
});
