import type { Menu } from 'obsidian';

export interface NativeMenuFocusOptions {
  /** Return focus only once Obsidian has actually dismissed the menu. */
  readonly restoreFocusTo?: HTMLElement;
}

function focusableSiblings(
  ownerDocument: Document,
  surface: HTMLElement | undefined,
): readonly HTMLElement[] {
  return Array.from(
    ownerDocument.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (candidate) =>
      candidate !== surface &&
      !surface?.contains(candidate) &&
      candidate.getAttribute('aria-disabled') !== 'true' &&
      candidate.tabIndex >= 0,
  );
}

function adjacentFocusable(
  ownerDocument: Document,
  surface: HTMLElement | undefined,
  anchor: HTMLElement | undefined,
  reverse: boolean,
): HTMLElement | undefined {
  if (!anchor) return undefined;
  const candidates = focusableSiblings(ownerDocument, surface);
  const index = candidates.indexOf(anchor);
  if (index < 0) return undefined;
  return candidates[index + (reverse ? -1 : 1)];
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
  const focusAnchor =
    options.restoreFocusTo ?? (eventTarget instanceof HTMLElement ? eventTarget : undefined);
  const existingMenus = new Set(ownerDocument.querySelectorAll<HTMLElement>('.menu'));

  menu.showAtMouseEvent(event);

  const surface = Array.from(ownerDocument.querySelectorAll<HTMLElement>('.menu')).find(
    (candidate) => !existingMenus.has(candidate),
  );
  let dismissalFocus: HTMLElement | undefined;
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
      if (keyboardEvent.key === 'ArrowDown' || keyboardEvent.key === 'ArrowUp') {
        keyboardEvent.preventDefault();
        const delta = keyboardEvent.key === 'ArrowDown' ? 1 : -1;
        focusItem(items[(index + delta + items.length) % items.length]!);
      } else if (keyboardEvent.key === 'Tab') {
        keyboardEvent.preventDefault();
        dismissalFocus = adjacentFocusable(
          ownerDocument,
          surface,
          focusAnchor,
          keyboardEvent.shiftKey,
        );
        menu.close();
        dismissalFocus?.focus({ preventScroll: true });
      } else if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        keyboardEvent.preventDefault();
        current.click();
      } else if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        menu.close();
      }
    });
  }
  // Other menu builders may already own onHide for their ARIA state. Only the
  // callers that explicitly requested focus restoration receive this handler.
  if (options.restoreFocusTo) {
    menu.onHide(() => {
      const target = dismissalFocus ?? options.restoreFocusTo;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    });
  }
  return menu;
}
