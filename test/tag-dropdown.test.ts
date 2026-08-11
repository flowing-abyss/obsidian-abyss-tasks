import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showTagDropdown } from '../src/ui/tagDropdown';

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new target.ownerDocument.defaultView!.KeyboardEvent('keydown', {
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
    const ownerDocument = frame.contentDocument!;
    const container = activeDocument.createElement('div');
    ownerDocument.body.append(ownerDocument.adoptNode(container));
    const app = {
      metadataCache: { getTags: () => ({ '#alpha': 2, '#beta': 1 }) },
    } as unknown as App;

    try {
      showTagDropdown(container, app, () => undefined, vi.fn());
      const input = container.querySelector<HTMLInputElement>('.tc-tag-input')!;
      const listbox = container.querySelector<HTMLElement>('.tc-tag-dropdown')!;
      const options = listbox.querySelectorAll<HTMLElement>('.tc-tag-dropdown-opt');

      expect(ownerDocument.activeElement).toBe(input);
      expect(input.getAttribute('role')).toBe('combobox');
      expect(input.getAttribute('aria-controls')).toBe(listbox.id);
      expect(input.getAttribute('aria-expanded')).toBe('true');
      expect(listbox.getAttribute('role')).toBe('listbox');
      expect(options).toHaveLength(2);
      expect(Array.from(options, (option) => option.getAttribute('role'))).toEqual([
        'option',
        'option',
      ]);
      expect(Array.from(options, (option) => option.getAttribute('aria-selected'))).toEqual([
        'false',
        'false',
      ]);
    } finally {
      frame.remove();
    }
  });

  it('retains an active option across filtering and commits it with Enter', () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    const container = activeDocument.createElement('div');
    ownerDocument.body.append(ownerDocument.adoptNode(container));
    const app = {
      metadataCache: { getTags: () => ({ '#alpha': 2, '#beta': 1 }) },
    } as unknown as App;
    const commit = vi.fn<(tag: string) => void>();

    try {
      showTagDropdown(container, app, () => undefined, commit);
      const input = container.querySelector<HTMLInputElement>('.tc-tag-input')!;
      key(input, 'ArrowDown');
      key(input, 'ArrowDown');
      const activeBefore = container.querySelector<HTMLElement>('.tc-tag-dropdown-opt.is-active')!;
      expect(activeBefore.textContent).toBe('#beta');
      expect(activeBefore.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(activeBefore.id);

      input.value = 'be';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const activeAfter = container.querySelector<HTMLElement>('.tc-tag-dropdown-opt.is-active')!;
      expect(ownerDocument.activeElement).toBe(input);
      expect(activeAfter.textContent).toBe('#beta');
      expect(activeAfter.id).toBe(activeBefore.id);
      expect(activeAfter.getAttribute('aria-selected')).toBe('true');
      expect(input.getAttribute('aria-activedescendant')).toBe(activeAfter.id);

      const enter = key(input, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(commit).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith('#beta');
      expect(container.querySelector('.tc-tag-dropdown-wrap')).toBeNull();
    } finally {
      frame.remove();
    }
  });
});
