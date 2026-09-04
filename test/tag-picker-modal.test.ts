import { App, Modal } from 'obsidian';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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
  (app.metadataCache as unknown as { getTags: () => Record<string, number> }).getTags = () =>
    Object.fromEntries((opts.tags ?? ['#all', '#some', '#none']).map((tag) => [tag, 1]));
  const onCommit = vi.fn();
  const modal = new TagPickerModal(
    app,
    () => undefined,
    new Set(opts.currentTags ?? ['#all']),
    new Set(opts.partialTags ?? ['#some']),
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  activeDocument.body.empty();
});

describe('TagPickerModal', () => {
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

    search.value = 'some';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(modal.contentEl.querySelectorAll('.abyss-tag-picker-item')).toHaveLength(1);
    expect(tagButton(modal, '#some')).toBeInstanceOf(HTMLButtonElement);
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
