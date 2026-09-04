import type {
  ParsedShortcutAlternative,
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
  if (closestBlockingInteraction(ownerDocument.activeElement) != null) return true;
  return event.composedPath().some((target) => closestBlockingInteraction(target) !== null);
}

function exactShortcutMatch(event: KeyboardEvent, shortcut: ParsedShortcutAlternative): boolean {
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
  const dispatchers: Record<ShortcutActionId, () => void> = {
    openQuickCapture: () => {
      actions.openQuickCapture();
    },
    openTasks: () => {
      actions.openTasks();
    },
    openInbox: () => {
      actions.openList('inbox');
    },
    openToday: () => {
      actions.openList('today');
    },
    openUpcoming: () => {
      actions.openList('upcoming');
    },
    openCalendar: () => {
      actions.openCalendar();
    },
    openCalendarToday: () => {
      actions.openCalendarView('today');
    },
    openCalendarWeek: () => {
      actions.openCalendarView('week');
    },
    openCalendarMonth: () => {
      actions.openCalendarView('month');
    },
    openProjects: () => {
      actions.openProjects();
    },
    openSearch: () => {
      actions.openSearch();
    },
  };
  dispatchers[action]();
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
    this.onKeyDown = (event) => {
      this.route(event);
    };
    options.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.options.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
  }

  private route(event: KeyboardEvent): void {
    if (this.destroyed || !this.options.isActive()) return;
    const current = this.currentShortcuts();
    if (current === undefined || this.eventIsBlocked(event)) return;

    const match = [...current.bindings.entries()].find(([, bindings]) =>
      bindings.some((binding) => exactShortcutMatch(event, binding)),
    );
    if (match == null || !this.options.registry.allows(match[0])) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    dispatchAction(this.options.actions, match[0]);
  }

  private currentShortcuts(): ReturnType<typeof validateShortcuts> | undefined {
    try {
      return validateShortcuts(this.options.settings(), this.options.platform);
    } catch {
      return undefined;
    }
  }

  private eventIsBlocked(event: KeyboardEvent): boolean {
    return (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      interactionPathBlocks(event, this.options.ownerDocument) ||
      this.options.nativeHostBlocks()
    );
  }
}
