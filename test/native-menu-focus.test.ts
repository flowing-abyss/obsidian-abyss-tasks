import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMenuAtMouseEventWithFocus } from '../src/ui/nativeMenuFocus';
import { freshContainer } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.querySelectorAll('.menu').forEach((menu) => menu.remove());
});

describe('showMenuAtMouseEventWithFocus', () => {
  it('keeps keyboard focus in the menu and restores its anchor only after close', () => {
    const anchor = freshContainer();
    anchor.tabIndex = 0;
    activeDocument.body.append(anchor);
    const activated = vi.fn();
    const menu = new Menu();
    let surface: HTMLElement | undefined;
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      surface = activeDocument.body.createDiv({ cls: 'menu' });
      for (const title of ['First', 'Set as Next Action']) {
        const item = surface.createDiv({ cls: 'menu-item', text: title });
        item.addEventListener('click', () => {
          if (title === 'Set as Next Action') activated();
          this.close();
          surface?.remove();
        });
      }
      return this;
    });
    const focus = vi.spyOn(anchor, 'focus');

    showMenuAtMouseEventWithFocus(menu, new MouseEvent('contextmenu', { bubbles: true }), {
      restoreFocusTo: anchor,
    });

    const first = surface!.querySelector<HTMLElement>('.menu-item')!;
    const next = surface!.querySelectorAll<HTMLElement>('.menu-item')[1]!;
    expect(activeDocument.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(activeDocument.activeElement).toBe(next);
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(activeDocument.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(activeDocument.activeElement).toBe(next);
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activated).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    anchor.remove();
  });
});
