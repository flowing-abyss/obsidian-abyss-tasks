import type { Menu } from 'obsidian';

export interface NativeMenuFocusOptions {
  /** Return focus only once Obsidian has actually dismissed the menu. */
  readonly restoreFocusTo?: HTMLElement;
}

/**
 * Shows a plugin-owned Obsidian DOM menu and transfers focus into its first
 * actionable row. Obsidian's desktop Menu renders rows as non-focusable divs,
 * so callers must establish focus ownership explicitly for keyboard cleanup.
 */
export function showMenuAtMouseEventWithFocus(
  menu: Menu,
  event: MouseEvent,
  options: NativeMenuFocusOptions = {},
): Menu {
  const eventTarget = event.currentTarget ?? event.target;
  const targetDocument =
    eventTarget && 'ownerDocument' in eventTarget ? (eventTarget as Node).ownerDocument : null;
  const ownerDocument = targetDocument ?? activeDocument;
  const existingMenus = new Set(ownerDocument.querySelectorAll<HTMLElement>('.menu'));

  menu.showAtMouseEvent(event);

  const surface = Array.from(ownerDocument.querySelectorAll<HTMLElement>('.menu')).find(
    (candidate) => !existingMenus.has(candidate),
  );
  const firstItem = surface?.querySelector<HTMLElement>('.menu-item:not(.is-disabled)');
  const focusItem = (item: HTMLElement): void => {
    for (const candidate of surface?.querySelectorAll<HTMLElement>(
      '.menu-item:not(.is-disabled)',
    ) ?? []) {
      candidate.tabIndex = candidate === item ? 0 : -1;
    }
    item.focus({ preventScroll: true });
  };
  if (firstItem) {
    focusItem(firstItem);
    surface?.addEventListener('keydown', (keyboardEvent) => {
      const items = Array.from(
        surface.querySelectorAll<HTMLElement>('.menu-item:not(.is-disabled)'),
      );
      const current = keyboardEvent.target as HTMLElement;
      const index = items.indexOf(current);
      if (index < 0) return;
      if (
        keyboardEvent.key === 'ArrowDown' ||
        keyboardEvent.key === 'ArrowUp' ||
        keyboardEvent.key === 'Tab'
      ) {
        keyboardEvent.preventDefault();
        const delta =
          keyboardEvent.key === 'ArrowDown' ||
          (keyboardEvent.key === 'Tab' && !keyboardEvent.shiftKey)
            ? 1
            : -1;
        focusItem(items[(index + delta + items.length) % items.length]!);
      } else if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        keyboardEvent.preventDefault();
        current.click();
      } else if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        menu.close();
      }
    });
  }
  if (options.restoreFocusTo) {
    menu.onHide(() => {
      if (options.restoreFocusTo?.isConnected) {
        options.restoreFocusTo.focus({ preventScroll: true });
      }
    });
  }
  return menu;
}
