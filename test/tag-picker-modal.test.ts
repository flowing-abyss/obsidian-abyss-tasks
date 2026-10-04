import { App, Modal } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { TagPickerModal } from '../src/ui/TagPickerModal';
import { expectDefined, methodOf } from './helpers';

interface TagPickerHarness {
  modal: TagPickerModal;
  onCommit: ReturnType<typeof vi.fn>;
}

interface ModalHostSeam {
  readonly open: MockInstance<Modal['open']>;
  readonly close: MockInstance<Modal['close']>;
  dispose(modal: Modal): void;
}

function installInheritedModalHostEscapeSeam(): ModalHostSeam {
  const cleanups = new WeakMap<Modal, () => void>();
  const inheritedClose = methodOf(Modal.prototype, 'close');
  const close = vi.spyOn(Modal.prototype, 'close').mockImplementation(function (this: Modal) {
    cleanups.get(this)?.();
    inheritedClose.call(this);
    this.containerEl.remove();
  });
  const open = vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    const opening = this.onOpen();
    if (opening instanceof Promise) {
      opening.catch((error: unknown) => {
        throw error;
      });
    }
    const ownerDocument = this.containerEl.ownerDocument;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) this.close();
    };
    const cleanup = (): void => {
      ownerDocument.removeEventListener('keydown', onKeydown);
      cleanups.delete(this);
    };
    cleanups.set(this, cleanup);
    ownerDocument.addEventListener('keydown', onKeydown);
  });
  return {
    open,
    close,
    dispose: (modal) => cleanups.get(modal)?.(),
  };
}

function makeTagPicker(
  opts: {
    currentTags?: string[];
    partialTags?: string[];
    tags?: string[];
  } = {},
  initialize = true,
): TagPickerHarness {
  const app = new App();
  (app.metadataCache as unknown as { getTags: () => Record<string, number> }).getTags = () => ({
    '#metadata-only': 1,
  });
  const onCommit = vi.fn();
  const modal = new TagPickerModal(
    app,
    () => undefined,
    new Set(opts.currentTags ?? ['#all']),
    new Set(opts.partialTags ?? ['#some']),
    opts.tags ?? ['#all', '#some', '#none'],
    onCommit,
  );
  if (initialize) {
    activeDocument.body.append(modal.containerEl);
    modal.onOpen();
  }
  return { modal, onCommit };
}

function tagButton(modal: TagPickerModal, tag: string): HTMLButtonElement {
  return expectDefined(modal.contentEl.querySelector<HTMLButtonElement>(`[data-tag="${tag}"]`));
}

beforeEach(() => {
  // jsdom does not implement the browser scroll boundary.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.useRealTimers();
  vi.restoreAllMocks();
  activeDocument.body.empty();
});

describe('TagPickerModal', () => {
  it('moves from search to the first or last filtered tag with arrows, skipping headings', () => {
    const { modal } = makeTagPicker({ currentTags: [], partialTags: [], tags: ['#a/one', '#b'] });
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(search.ownerDocument.activeElement).toBe(tagButton(modal, '#a/one'));
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(search.ownerDocument.activeElement).toBe(tagButton(modal, '#b'));
    search.value = 'b';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(search.ownerDocument.activeElement).toBe(tagButton(modal, '#b'));
  });

  it('returns above the first tag to search, clamps below the last, and navigates toggled tags', () => {
    const { modal } = makeTagPicker({ currentTags: [], partialTags: [], tags: ['#a/one', '#b'] });
    const first = tagButton(modal, '#a/one');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    expect(activeDocument.activeElement).toBe(search);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement).toBe(first);
    const label = expectDefined(first.querySelector('.abyss-tag-picker-label'));
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const last = tagButton(modal, '#b');
    expect(activeDocument.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement).toBe(last);
    last.click();
    const toggled = tagButton(modal, '#b');
    expect(activeDocument.activeElement).toBe(toggled);
    toggled.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(activeDocument.activeElement).toBe(tagButton(modal, '#a/one'));
  });

  it.each([
    { query: 'one', tag: '#a/one', currentTags: [], tags: ['#a/one', '#b'] },
    { query: 'all', tag: '#all', currentTags: ['#all'], tags: ['#all', '#some'] },
    { query: 'some', tag: '#some', currentTags: [], tags: ['#all', '#some'] },
  ])(
    'returns from the first filtered tag to the existing search and retains query/caret: $tag',
    (fixture) => {
      const { modal } = makeTagPicker({ ...fixture, partialTags: [] });
      const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
      search.value = fixture.query;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.focus();
      search.setSelectionRange(1, 2, 'backward');
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const first = tagButton(modal, fixture.tag);
      expect(activeDocument.activeElement).toBe(first);

      const arrowUp = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      first.dispatchEvent(arrowUp);

      expect(arrowUp.defaultPrevented).toBe(true);
      expect(activeDocument.activeElement).toBe(search);
      expect(modal.contentEl.querySelector('input')).toBe(search);
      expect(search.value).toBe(fixture.query);
      expect(search.selectionStart).toBe(1);
      expect(search.selectionEnd).toBe(2);
      expect(search.selectionDirection).toBe('backward');
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(activeDocument.activeElement).toBe(first);
      expect(tagButton(modal, fixture.tag)).toBe(first);
    },
  );

  it('leaves arrows untouched when filtering has no tag choices', () => {
    const { modal } = makeTagPicker();
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    search.value = 'missing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.focus();
    for (const key of ['ArrowDown', 'ArrowUp']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      search.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(activeDocument.activeElement).toBe(search);
    }
  });

  it.each([
    { key: ' ' },
    { key: 'b' },
    { key: 'Enter' },
    { key: 'ArrowDown', isComposing: true },
    { key: 'Process' },
    { key: 'ArrowDown', ctrlKey: true },
    { key: 'ArrowDown', metaKey: true },
    { key: 'ArrowDown', altKey: true },
    { key: 'ArrowDown', shiftKey: true },
  ])('leaves ordinary search and composition/modifier events untouched: %j', (init) => {
    const { modal, onCommit } = makeTagPicker();
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    search.focus();
    const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(activeDocument.activeElement).toBe(search);
    modal.onClose();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves legacy composition arrows and arrows from remove controls untouched', () => {
    const { modal } = makeTagPicker();
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    search.focus();
    const composing = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, 'keyCode', { value: 229 });
    search.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(activeDocument.activeElement).toBe(search);
    const remove = expectDefined(
      modal.contentEl.querySelector<HTMLButtonElement>('[data-remove-tag]'),
    );
    remove.focus();
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    remove.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    expect(activeDocument.activeElement).toBe(remove);
  });

  it('prevents scrolling only for handled navigation and scrolls the focused tag into view', () => {
    const { modal } = makeTagPicker();
    const first = tagButton(modal, '#all');
    const scroll = vi.fn();
    first.scrollIntoView = scroll;
    const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    search.focus();
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(activeDocument.activeElement).toBe(first);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('schedules initial search focus in the document window that owns the modal', () => {
    vi.useFakeTimers();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const ownerWindow = expectDefined(ownerDocument.defaultView);
    const schedule = vi.spyOn(ownerWindow, 'setTimeout');
    const { modal } = makeTagPicker({}, false);
    ownerDocument.body.append(ownerDocument.adoptNode(modal.containerEl));
    modal.onOpen();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 10);
    vi.advanceTimersByTime(10);
    expect(ownerDocument.activeElement).toBe(modal.contentEl.querySelector('input'));
    modal.onClose();
  });

  it('cancels delayed focus on close before the same modal opens again', () => {
    vi.useFakeTimers();
    const { modal } = makeTagPicker();
    vi.advanceTimersByTime(5);
    modal.onClose();
    modal.onOpen();
    const outside = activeDocument.body.createEl('button');
    outside.focus();
    vi.advanceTimersByTime(5);
    expect(activeDocument.activeElement).toBe(outside);
    vi.advanceTimersByTime(5);
    expect(activeDocument.activeElement).toBe(modal.contentEl.querySelector('input'));
    modal.onClose();
  });

  it('acquires one blocking owner per open and releases it once on close', () => {
    const app = new App();
    (app.metadataCache as unknown as { getTags: () => Record<string, number> }).getTags =
      () => ({});
    const release = vi.fn();
    const interactionOwnership = { acquire: vi.fn(() => ({ release })) };
    const modal = new TagPickerModal(
      app,
      () => undefined,
      new Set(),
      new Set(),
      [],
      vi.fn(),
      interactionOwnership,
    );

    modal.onOpen();
    expect(interactionOwnership.acquire).toHaveBeenCalledOnce();
    expect(interactionOwnership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
    modal.onClose();
    modal.onClose();
    expect(release).toHaveBeenCalledOnce();
  });

  it('renders filtered tag choices as native pressed buttons with truthful bulk states', () => {
    const { modal } = makeTagPicker();
    const search = expectDefined(
      modal.contentEl.querySelector<HTMLInputElement>('.abyss-tag-picker-search'),
    );

    expect(tagButton(modal, '#all')).toBeInstanceOf(HTMLButtonElement);
    expect(tagButton(modal, '#all').getAttribute('aria-pressed')).toBe('true');
    expect(tagButton(modal, '#some').getAttribute('aria-pressed')).toBe('mixed');
    expect(tagButton(modal, '#none').getAttribute('aria-pressed')).toBe('false');
    expect(modal.contentEl.querySelector('[data-tag="#metadata-only"]')).toBeNull();

    search.value = 'some';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(modal.contentEl.querySelectorAll('.abyss-tag-picker-item')).toHaveLength(1);
    expect(tagButton(modal, '#some')).toBeInstanceOf(HTMLButtonElement);
  });

  it('puts selected tags absent from candidates first and removes a mixed tag in one action', () => {
    const { modal, onCommit } = makeTagPicker({
      currentTags: ['#selected/missing'],
      partialTags: ['#mixed'],
      tags: ['#work/client/deep', '#work/home'],
    });
    const rows = [...modal.contentEl.querySelectorAll<HTMLElement>('[data-tag]')];
    expect(rows.map((row) => row.dataset['tag'])).toEqual([
      '#selected/missing',
      '#mixed',
      '#work/client/deep',
      '#work/home',
    ]);
    expect(modal.contentEl.querySelector('[data-tag="#work"]')).toBeNull();
    expect(
      [...modal.contentEl.querySelectorAll('.abyss-tag-picker-heading')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['#work', '#work/client']);

    const remove = expectDefined(
      modal.contentEl.querySelector<HTMLButtonElement>(
        '.abyss-tag-picker-remove[data-remove-tag="#mixed"]',
      ),
    );
    remove.click();
    modal.onClose();

    expect(onCommit).toHaveBeenCalledWith([], ['#mixed']);
  });

  it('keeps focus on the toggled tag as native activation rebuilds the filtered list', () => {
    const { modal } = makeTagPicker();
    const search = expectDefined(
      modal.contentEl.querySelector<HTMLInputElement>('.abyss-tag-picker-search'),
    );
    search.value = 'some';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const partial = tagButton(modal, '#some');
    partial.focus();

    partial.click();

    const checked = tagButton(modal, '#some');
    expect(checked.getAttribute('aria-pressed')).toBe('true');
    expect(activeDocument.activeElement).toBe(checked);
    checked.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(activeDocument.activeElement).toBe(search);
    expect(search.value).toBe('some');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement).toBe(checked);

    checked.click();
    const removing = tagButton(modal, '#some');
    expect(removing.getAttribute('aria-pressed')).toBe('false');
    expect(activeDocument.activeElement).toBe(removing);
  });

  it('lets the opened Obsidian modal host close on Escape and commit pending changes', () => {
    vi.useFakeTimers();
    const host = installInheritedModalHostEscapeSeam();
    const { modal, onCommit } = makeTagPicker({ currentTags: [], partialTags: [] }, false);
    activeDocument.body.append(modal.containerEl);
    modal.open();

    try {
      const item = tagButton(modal, '#none');
      item.focus();
      item.click();
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });

      tagButton(modal, '#none').dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(host.open).toHaveBeenCalledOnce();
      expect(host.close).toHaveBeenCalledOnce();
      expect(modal.containerEl.isConnected).toBe(false);
      expect(modal.contentEl.childElementCount).toBe(0);
      expect(onCommit).toHaveBeenCalledWith(['#none'], []);
    } finally {
      host.dispose(modal);
      vi.clearAllTimers();
    }
  });
});

it('selects the actual modal search from a tag button and cancels pending initial focus', () => {
  vi.useFakeTimers();
  const { modal } = makeTagPicker({ tags: ['#Alpha'] });
  const search = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
  search.value = 'Alxha';
  const button = tagButton(modal, '#Alpha');
  button.focus();
  const find = new KeyboardEvent('keydown', {
    code: 'KeyF',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(find);
  expect(find.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(search);
  expect(search.selectionEnd).toBe(5);
  modal.onClose();
  const outside = document.body.createEl('input');
  outside.focus();
  vi.runAllTimers();
  expect(document.activeElement).toBe(outside);
});
