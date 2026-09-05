import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import { localDate, type TaskApplicationApi, type TaskSnapshot } from '../src/tasks';
import {
  expectDefined,
  flushMicrotasks,
  makeCenterPanelForTest,
  makeStubStore,
  methodOf,
  objectMatching,
  task,
  useRealMoment,
} from './helpers';

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

async function withQueuedAnimationFrames(
  run: (flush: () => void, callbacks: Map<number, FrameRequestCallback>) => Promise<void>,
): Promise<void> {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = methodOf(window, 'requestAnimationFrame');
  const cancelAnimationFrame = methodOf(window, 'cancelAnimationFrame');
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const frame = nextFrame++;
    callbacks.set(frame, callback);
    return frame;
  };
  window.cancelAnimationFrame = (frame: number): void => {
    callbacks.delete(frame);
  };

  try {
    await run(() => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(0);
    }, callbacks);
  } finally {
    Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });
  }
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
  const createElement = methodOf(ownerDocument, 'createElement');
  const el = createElement.call(ownerDocument, 'div');
  panel.mount(el);
  return { el, state, tm, execute, panel };
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

describe('CenterPanel tag→task drop target', () => {
  it('task card assigns a tag and removes the inbox tag in one API patch', () => {
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
    const menu = createFragment().createDiv();
    menu.className = 'menu';
    const firstItem = menu.createDiv({ cls: 'menu-item', text: 'Today' });
    captureMenu();
    vi.mocked(methodOf(Menu.prototype, 'showAtMouseEvent')).mockImplementation(function (
      this: Menu,
    ) {
      activeDocument.body.append(menu);
      return this;
    });
    const { el, panel } = makeCenter([first]);
    activeDocument.body.append(el);
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));

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

    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));

    expect(relevantDateTitles(items)).toEqual(['Today', 'Tomorrow', 'Set date…', 'Set tag…']);
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
      expect(originalCard.isConnected).toBe(false);
      expect(replacement).not.toBe(originalCard);
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
      panel.refresh();

      const replacement = el.querySelector<HTMLElement>('.abyss-task-card');
      expect(original.isConnected).toBe(false);
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
      panel.refresh();

      const replacement = el.querySelector<HTMLElement>('.abyss-task-card');
      expect(original.isConnected).toBe(false);
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

        expect(original.isConnected).toBe(false);
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
      panel.refresh();
      const finalReplacement = el.querySelector<HTMLElement>('.abyss-task-card');
      const ownerActiveAfterOwnerBlur = ownerDocument.activeElement;
      panel.destroy();
      destroyed = true;

      expect(original.isConnected).toBe(false);
      expect(ownerReplacement).not.toBeNull();
      expect(ownerReplacement).not.toBe(original);
      expect(ownerActiveAfterPrimaryDeparture).toBe(ownerReplacement);
      expect(finalReplacement).not.toBeNull();
      expect(finalReplacement).not.toBe(ownerReplacement);
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
      expect(originalTrigger.isConnected).toBe(false);
      expect(firstReplacement.isConnected).toBe(false);
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

  it('preserves changed focus across coalesced and later search result frames until departure', async () => {
    const items = captureMenu();
    const searchable = task({
      title: 'focus needle',
      tags: ['#task/inbox'],
      source: {
        filePath: 'search.md',
        line: 2,
        originalMarkdown: '- [ ] focus needle #task/inbox',
        originalBlock: '- [ ] focus needle #task/inbox',
      },
    });
    const { el, execute, panel, state } = makeCenter([searchable]);
    activeDocument.body.append(el);
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });

    try {
      execute.mockResolvedValue(changedTaskResult(searchable));
      await withQueuedAnimationFrames(async (flush, callbacks) => {
        state.set('mode', 'search');
        await flushMicrotasks();
        state.set('searchQuery', 'focus needle');
        flush();
        const originalCard = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
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
        panel.refresh();
        panel.refresh();
        expect(callbacks).toHaveLength(1);
        flush();
        const coalescedReplacement = expectDefined(
          el.querySelector<HTMLElement>('.abyss-task-card'),
        );
        expect(originalCard.isConnected).toBe(false);
        expect(activeDocument.activeElement).toBe(coalescedReplacement);

        panel.refresh();
        expect(callbacks).toHaveLength(1);
        flush();
        const laterReplacement = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
        expect(coalescedReplacement.isConnected).toBe(false);
        expect(activeDocument.activeElement).toBe(laterReplacement);

        outside.focus();
        panel.refresh();
        flush();
        expect(activeDocument.activeElement).toBe(outside);
      });
    } finally {
      panel.destroy();
      outside.remove();
      el.remove();
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
      expect(originalTrigger.isConnected).toBe(false);
      expect(expectDefined(replacements[0]).isConnected).toBe(false);
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

      panel.refresh();

      expect(activeDocument.activeElement).toBe(activeDocument.body);
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
    const mixedSecondCard = expectDefined(mixedCards.find((card) => card.dataset['line'] === '1'));
    expectDefined(mixedFirstCard.parentElement).append(mixedFirstCard, mixedSecondCard);
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
      matchingCenter.el.querySelectorAll<HTMLElement>('.abyss-task-card'),
    );
    for (const card of matchingCards) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }
    const matchingFirstCard = expectDefined(
      matchingCards.find((card) => card.dataset['line'] === '0'),
    );
    const matchingSecondCard = expectDefined(
      matchingCards.find((card) => card.dataset['line'] === '1'),
    );
    expectDefined(matchingFirstCard.parentElement).append(matchingFirstCard, matchingSecondCard);
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
    const cards = el.querySelectorAll<HTMLElement>('.abyss-task-card');
    expectDefined(cards[1]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    expectDefined(cards[0]).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    const firstCard = expectDefined(Array.from(cards).find((card) => card.dataset['line'] === '0'));
    const secondCard = expectDefined(
      Array.from(cards).find((card) => card.dataset['line'] === '1'),
    );
    expectDefined(firstCard.parentElement).append(firstCard, secondCard);
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
    openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));
    items.find((item) => item.title__ === 'Set date…')?.onClick__?.(new MouseEvent('click'));
    const input = expectDefined(
      el.querySelector<HTMLInputElement>('.abyss-date-picker-popover input[type="date"]'),
    );

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
      openMenu(expectDefined(el.querySelector<HTMLElement>('.abyss-task-card')));
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
