import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMenuAtMouseEventWithFocus } from '../src/ui/nativeMenuFocus';
import { freshContainer } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.querySelectorAll('.menu').forEach((menu) => menu.remove());
});

describe('showMenuAtMouseEventWithFocus', () => {
  it('dismisses on Tab and moves focus forward from its anchor', () => {
    const anchor = freshContainer();
    anchor.tabIndex = 0;
    activeDocument.body.append(anchor);
    const following = freshContainer();
    following.tabIndex = 0;
    activeDocument.body.append(following);
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
    const close = menu.close.bind(menu);
    vi.spyOn(menu, 'close').mockImplementation(() => {
      close();
      surface?.remove();
    });
    const focus = vi.spyOn(anchor, 'focus');

    showMenuAtMouseEventWithFocus(menu, new MouseEvent('contextmenu', { bubbles: true }), {
      restoreFocusTo: anchor,
    });

    const first = surface!.querySelector<HTMLElement>('.menu-item')!;
    expect(activeDocument.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(surface?.isConnected).toBe(false);
    expect(activeDocument.activeElement).toBe(following);
    expect(activated).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    anchor.remove();
    following.remove();
  });

  it('dismisses on Shift+Tab and moves focus before its anchor while Escape restores it', () => {
    const before = freshContainer();
    before.tabIndex = 0;
    activeDocument.body.append(before);
    const anchor = freshContainer();
    anchor.tabIndex = 0;
    activeDocument.body.append(anchor);
    const menu = new Menu();
    let surface: HTMLElement | undefined;
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      surface = activeDocument.body.createDiv({ cls: 'menu' });
      surface.createDiv({ cls: 'menu-item', text: 'First' });
      return this;
    });
    const close = menu.close.bind(menu);
    vi.spyOn(menu, 'close').mockImplementation(() => {
      close();
      surface?.remove();
    });

    showMenuAtMouseEventWithFocus(menu, new MouseEvent('contextmenu', { bubbles: true }), {
      restoreFocusTo: anchor,
    });
    const first = surface!.querySelector<HTMLElement>('.menu-item')!;
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(surface?.isConnected).toBe(false);
    expect(activeDocument.activeElement).toBe(before);

    showMenuAtMouseEventWithFocus(menu, new MouseEvent('contextmenu', { bubbles: true }), {
      restoreFocusTo: anchor,
    });
    surface!
      .querySelector<HTMLElement>('.menu-item')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(activeDocument.activeElement).toBe(anchor);
    before.remove();
    anchor.remove();
  });
});
