import { Menu, type MenuItem } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { configureNativeSubmenu } from '../src/ui/nativeSubmenu';

describe('configureNativeSubmenu', () => {
  it('uses the guarded runtime submenu capability when present', () => {
    const submenu = new Menu();
    const setSubmenu = vi.fn(() => submenu);
    const configure = vi.fn();

    const native = configureNativeSubmenu({ setSubmenu } as unknown as MenuItem, {
      configure,
      fallbackAnchor: document.body,
    });

    expect(native).toBe(true);
    expect(setSubmenu).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith(submenu);
  });

  it('opens a public secondary menu and returns focus after the final close', () => {
    let activate: ((event: MouseEvent | KeyboardEvent) => void) | undefined;
    const parent = {
      onClick: (callback: (event: MouseEvent | KeyboardEvent) => void) => {
        activate = callback;
        return parent;
      },
    } as unknown as MenuItem;
    const anchor = document.body.createEl('button');
    const parentMenu = new Menu();
    const closeParent = vi.spyOn(parentMenu, 'close');
    const show = vi.spyOn(Menu.prototype, 'showAtPosition');
    const configure = vi.fn();

    const native = configureNativeSubmenu(parent, {
      configure,
      fallbackAnchor: anchor,
      parentMenu,
    });
    expect(native).toBe(false);
    activate?.(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(closeParent).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    const child = show.mock.instances[0] as Menu;
    expect(configure).toHaveBeenCalledWith(child);
    child.close();
    expect(document.activeElement).toBe(anchor);
  });

  it('does not steal focus from a rename input when a fallback closes', () => {
    let activate: ((event: MouseEvent | KeyboardEvent) => void) | undefined;
    const parent = {
      onClick: (callback: (event: MouseEvent | KeyboardEvent) => void) => {
        activate = callback;
        return parent;
      },
    } as unknown as MenuItem;
    const anchor = document.body.createEl('button');
    const rename = document.body.createEl('input', { cls: 'abyss-project-column-rename' });
    const show = vi.spyOn(Menu.prototype, 'showAtPosition');
    const restoreFocus = vi.fn(() => {
      if (document.activeElement?.classList.contains('abyss-project-column-rename') !== true) {
        anchor.focus();
      }
    });

    configureNativeSubmenu(parent, { configure: () => {}, fallbackAnchor: anchor, restoreFocus });
    activate?.(new MouseEvent('click'));
    rename.focus();
    (show.mock.instances[0] as Menu | undefined)?.close();

    expect(restoreFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(rename);
  });
});
