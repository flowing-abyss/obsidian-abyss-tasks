import type {
  ParsedShortcut,
  ShortcutActionId,
  ShortcutPlatform,
  ShortcutSettings,
} from '../settings/shortcuts';
import { validateShortcuts } from '../settings/shortcuts';
import type { PanelNavigationActions } from '../views/panelNavigation';
import type { InteractionRegistry } from './interactionOwnership';

const PANEL_SHORTCUT_BLOCKING_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '.cm-editor',
  '.CodeMirror',
].join(', ');

function closestBlockingInteraction(target: EventTarget | null): Element | null {
  if (target === null || typeof (target as Element).closest !== 'function') return null;
  return (target as Element).closest(PANEL_SHORTCUT_BLOCKING_SELECTOR);
}

function interactionPathBlocks(event: KeyboardEvent, ownerDocument: Document): boolean {
  if (closestBlockingInteraction(ownerDocument.activeElement)) return true;
  return event.composedPath().some((target) => closestBlockingInteraction(target) !== null);
}

function exactShortcutMatch(event: KeyboardEvent, shortcut: ParsedShortcut): boolean {
  const modifiers = shortcut.modifiers;
  return (
    event.code === shortcut.code &&
    event.altKey === modifiers.alt &&
    event.ctrlKey === modifiers.ctrl &&
    event.metaKey === modifiers.meta &&
    event.shiftKey === modifiers.shift
  );
}

function dispatchAction(actions: PanelNavigationActions, action: ShortcutActionId): void {
  switch (action) {
    case 'openQuickCapture':
      actions.openQuickCapture();
      return;
    case 'openTasks':
      actions.openTasks();
      return;
    case 'openInbox':
      actions.openList('inbox');
      return;
    case 'openToday':
      actions.openList('today');
      return;
    case 'openUpcoming':
      actions.openList('upcoming');
      return;
    case 'openCalendar':
      actions.openCalendar();
      return;
    case 'openCalendarToday':
      actions.openCalendarView('today');
      return;
    case 'openCalendarWeek':
      actions.openCalendarView('week');
      return;
    case 'openCalendarMonth':
      actions.openCalendarView('month');
      return;
    case 'openProjects':
      actions.openProjects();
      return;
    case 'openSearch':
      actions.openSearch();
  }
}

export class PanelShortcutRouter {
  private destroyed = false;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor(
    private readonly options: {
      readonly ownerDocument: Document;
      readonly isActive: () => boolean;
      readonly settings: () => ShortcutSettings;
      readonly platform: ShortcutPlatform;
      readonly actions: PanelNavigationActions;
      readonly registry: InteractionRegistry<ShortcutActionId>;
      readonly nativeHostBlocks: () => boolean;
    },
  ) {
    this.onKeyDown = (event) => this.route(event);
    options.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.options.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
  }

  private route(event: KeyboardEvent): void {
    if (this.destroyed || !this.options.isActive()) return;
    let current: ReturnType<typeof validateShortcuts>;
    try {
      current = validateShortcuts(this.options.settings(), this.options.platform);
    } catch {
      return;
    }
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      interactionPathBlocks(event, this.options.ownerDocument) ||
      this.options.nativeHostBlocks()
    ) {
      return;
    }

    const shortcut = [...current.bindings.values()].find((binding) =>
      exactShortcutMatch(event, binding),
    );
    if (!shortcut || !this.options.registry.allows(shortcut.action)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    dispatchAction(this.options.actions, shortcut.action);
  }
}
