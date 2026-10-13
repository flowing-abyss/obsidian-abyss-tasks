import { Menu } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { showMenuAtMouseEventWithFocus } from '../src/ui/nativeMenuFocus';
it('registers the discovered native surface before its first focus', () => {
  const menu = new Menu();
  const anchor = document.body.createEl('button');
  const order: string[] = [];
  let surface: HTMLElement | undefined;
  vi.spyOn(menu, 'showAtMouseEvent').mockImplementation(() => {
    surface = document.body.createDiv({ cls: 'menu' });
    const item = surface.createDiv({ cls: 'menu-item' });
    item.addEventListener('focus', () => order.push('focus'));
    return menu;
  });
  anchor.addEventListener('click', (event) =>
    showMenuAtMouseEventWithFocus(menu, event, () => order.push('register')),
  );
  anchor.click();
  expect(order).toEqual(['register', 'focus']);
  surface?.remove();
  anchor.remove();
  vi.restoreAllMocks();
});
