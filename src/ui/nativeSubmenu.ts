import { Menu, type MenuItem } from 'obsidian';

interface RuntimeSubmenuItem {
  setSubmenu: () => Menu;
}

interface RuntimeSubmenuCapability {
  setSubmenu(this: MenuItem): Menu;
}

export interface NativeSubmenuOptions {
  readonly configure: (menu: Menu) => void;
  readonly fallbackAnchor: HTMLElement;
  readonly fallbackEvent?: MouseEvent;
  readonly parentMenu?: Menu;
  readonly restoreFocus?: () => void;
}

function runtimeSubmenu(item: MenuItem): RuntimeSubmenuItem | undefined {
  const method = (item as unknown as Partial<RuntimeSubmenuCapability>).setSubmenu;
  return typeof method === 'function' ? { setSubmenu: () => method.call(item) } : undefined;
}

function fallbackPosition(
  anchor: HTMLElement,
  event: MouseEvent | KeyboardEvent | undefined,
  originalEvent: MouseEvent | undefined,
): { x: number; y: number } {
  const pointer = event instanceof MouseEvent ? event : originalEvent;
  if (pointer !== undefined && (pointer.clientX !== 0 || pointer.clientY !== 0)) {
    return { x: pointer.clientX, y: pointer.clientY };
  }
  const bounds = anchor.getBoundingClientRect();
  return { x: bounds.right, y: bounds.top };
}

function focusFirstMenuItem(surface: HTMLElement | undefined): void {
  const first = surface?.querySelector<HTMLElement>('.menu-item:not(.is-disabled)');
  if (first === undefined || first === null) return;
  first.tabIndex = 0;
  first.focus({ preventScroll: true });
}

/** Uses Obsidian's runtime submenu when available, with a public Menu fallback. */
export function configureNativeSubmenu(
  parentItem: MenuItem,
  options: NativeSubmenuOptions,
): boolean {
  const native = runtimeSubmenu(parentItem);
  if (native !== undefined) {
    options.configure(native.setSubmenu());
    return true;
  }
  parentItem.onClick((event) => {
    options.parentMenu?.close();
    const menu = new Menu();
    options.configure(menu);
    menu.onHide(() => {
      if (options.restoreFocus !== undefined) options.restoreFocus();
      else if (options.fallbackAnchor.isConnected) {
        options.fallbackAnchor.focus({ preventScroll: true });
      }
    });
    const existingMenus = new Set(
      options.fallbackAnchor.ownerDocument.querySelectorAll<HTMLElement>('.menu'),
    );
    menu.showAtPosition(
      fallbackPosition(options.fallbackAnchor, event, options.fallbackEvent),
      options.fallbackAnchor.ownerDocument,
    );
    const surface = Array.from(
      options.fallbackAnchor.ownerDocument.querySelectorAll<HTMLElement>('.menu'),
    ).find((candidate) => !existingMenus.has(candidate));
    focusFirstMenuItem(surface);
  });
  return false;
}
