import type { Menu } from 'obsidian';

/**
 * Shows a plugin-owned Obsidian DOM menu and transfers focus into its first
 * actionable row. Obsidian's desktop Menu renders rows as non-focusable divs,
 * so callers must establish focus ownership explicitly for keyboard cleanup.
 */
export function showMenuAtMouseEventWithFocus(menu: Menu, event: MouseEvent): Menu {
  const eventTarget = event.currentTarget ?? event.target;
  const targetDocument =
    eventTarget != null && 'ownerDocument' in eventTarget
      ? (eventTarget as Node).ownerDocument
      : null;
  const ownerDocument = targetDocument ?? activeDocument;
  const existingMenus = new Set(ownerDocument.querySelectorAll<HTMLElement>('.menu'));

  menu.showAtMouseEvent(event);

  const surface = Array.from(ownerDocument.querySelectorAll<HTMLElement>('.menu')).find(
    (candidate) => !existingMenus.has(candidate),
  );
  const firstItem = surface?.querySelector<HTMLElement>('.menu-item:not(.is-disabled)');
  if (firstItem != null) {
    firstItem.tabIndex = 0;
    firstItem.focus({ preventScroll: true });
  }
  return menu;
}
