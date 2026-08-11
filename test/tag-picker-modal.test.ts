import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagPickerModal } from '../src/ui/TagPickerModal';

interface TagPickerHarness {
  modal: TagPickerModal;
  onCommit: ReturnType<typeof vi.fn>;
}

function makeTagPicker(
  opts: {
    currentTags?: string[];
    partialTags?: string[];
    tags?: string[];
  } = {},
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
  activeDocument.body.append(modal.containerEl);
  modal.onOpen();
  return { modal, onCommit };
}

function tagButton(modal: TagPickerModal, tag: string): HTMLButtonElement {
  return modal.contentEl.querySelector<HTMLButtonElement>(`[data-tag="${tag}"]`)!;
}

afterEach(() => {
  activeDocument.body.empty();
});

describe('TagPickerModal', () => {
  it('renders filtered tag choices as native pressed buttons with truthful bulk states', () => {
    const { modal } = makeTagPicker();
    const search = modal.contentEl.querySelector<HTMLInputElement>('.tc-tag-picker-search')!;

    expect(tagButton(modal, '#all')).toBeInstanceOf(HTMLButtonElement);
    expect(tagButton(modal, '#all').getAttribute('aria-pressed')).toBe('true');
    expect(tagButton(modal, '#some').getAttribute('aria-pressed')).toBe('mixed');
    expect(tagButton(modal, '#none').getAttribute('aria-pressed')).toBe('false');

    search.value = 'some';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(modal.contentEl.querySelectorAll('.tc-tag-picker-item')).toHaveLength(1);
    expect(tagButton(modal, '#some')).toBeInstanceOf(HTMLButtonElement);
  });

  it('keeps focus on the toggled tag as native activation rebuilds the filtered list', () => {
    const { modal } = makeTagPicker();
    const search = modal.contentEl.querySelector<HTMLInputElement>('.tc-tag-picker-search')!;
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

  it('lets Escape bubble to the modal host while committing pending tag changes on close', () => {
    const { modal, onCommit } = makeTagPicker({ currentTags: [], partialTags: [] });
    const item = tagButton(modal, '#none');
    item.focus();
    item.click();
    const escaped = vi.fn();
    modal.containerEl.addEventListener('keydown', escaped);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    tagButton(modal, '#none').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(escaped).toHaveBeenCalledOnce();
    modal.close();
    expect(onCommit).toHaveBeenCalledWith(['#none'], []);
  });
});
