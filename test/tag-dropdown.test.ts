import { afterEach, describe, expect, it, vi } from 'vitest';
import { showTagDropdown } from '../src/ui/tagDropdown';
import { expectDefined, freshContainer } from './helpers';

function key(target: HTMLElement, value: string): KeyboardEvent {
  const KeyboardEventConstructor = expectDefined(target.ownerDocument.defaultView).KeyboardEvent;
  const event = new KeyboardEventConstructor('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('inline tag dropdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a focused combobox and listbox with truthful active-option state', () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const container = freshContainer();
    ownerDocument.body.append(ownerDocument.adoptNode(container));
    try {
      showTagDropdown(
        container,
        ['#alpha', '#beta'],
        () => undefined,
        vi.fn(() => 'committed' as const),
      );
      const input = expectDefined(container.querySelector<HTMLInputElement>('.abyss-tag-input'));
      const listbox = expectDefined(container.querySelector<HTMLElement>('.abyss-tag-dropdown'));
      const options = listbox.querySelectorAll<HTMLElement>('.abyss-tag-dropdown-opt');

      expect(ownerDocument.activeElement).toBe(input);
      expect(input.getAttribute('role')).toBe('combobox');
      expect(input.getAttribute('aria-controls')).toBe(listbox.id);
      expect(input.getAttribute('aria-expanded')).toBe('true');
      expect(listbox.getAttribute('role')).toBe('listbox');
      expect(options).toHaveLength(2);
      expect([...options].map((option) => option.getAttribute('role'))).toEqual([
        'option',
        'option',
      ]);
      expect([...options].map((option) => option.getAttribute('aria-selected'))).toEqual([
        'false',
        'false',
      ]);
    } finally {
      frame.remove();
    }
  });

  it('retains an active option across filtering and commits it with Enter', () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const container = freshContainer();
    ownerDocument.body.append(ownerDocument.adoptNode(container));
    const commit = vi.fn<(tags: readonly string[]) => 'committed'>(() => 'committed');

    try {
      showTagDropdown(container, ['#alpha', '#beta'], () => undefined, commit);
      const input = expectDefined(container.querySelector<HTMLInputElement>('.abyss-tag-input'));
      key(input, 'ArrowDown');
      key(input, 'ArrowDown');
      const activeBefore = expectDefined(
        container.querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active'),
      );
      expect(activeBefore.textContent).toBe('#beta');
      expect(activeBefore.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(activeBefore.id);

      input.value = 'be';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const activeAfter = expectDefined(
        container.querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active'),
      );
      expect(ownerDocument.activeElement).toBe(input);
      expect(activeAfter.textContent).toBe('#beta');
      expect(activeAfter.id).toBe(activeBefore.id);
      expect(activeAfter.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(activeAfter.id);

      const enter = key(input, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(commit).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith(['#beta']);
      expect(container.querySelector('.abyss-tag-dropdown-wrap')).toBeNull();
    } finally {
      frame.remove();
    }
  });

  it('retains invalid and command-failed drafts without partially applying tags', async () => {
    const container = freshContainer();
    const commit = vi
      .fn<(tags: readonly string[]) => Promise<'failed'>>()
      .mockResolvedValue('failed');
    showTagDropdown(container, ['#alpha'], () => undefined, commit);
    const input = expectDefined(container.querySelector<HTMLInputElement>('.abyss-tag-input'));

    input.value = '#alpha #bad!';
    key(input, 'Enter');
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe('#alpha #bad!');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = '##work #home work';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledWith(['#work', '#home']);
    });
    expect(container.querySelector('.abyss-tag-dropdown-wrap')).not.toBeNull();
    expect(input.value).toBe('##work #home work');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
