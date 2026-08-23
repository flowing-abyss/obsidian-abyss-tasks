import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ShortcutActionId, ShortcutSettings } from '../src/settings/shortcuts';
import { InteractionRegistry } from '../src/ui/interactionOwnership';
import { nativeInteractionBlocksPanelShortcuts } from '../src/ui/nativeInteractionBlocker';
import { PanelShortcutRouter } from '../src/ui/panelShortcutRouter';
import type { PanelNavigationActions } from '../src/views/panelNavigation';

function navigationActions(): PanelNavigationActions {
  return {
    openTasks: vi.fn(),
    openList: vi.fn(),
    openCalendar: vi.fn(),
    openCalendarView: vi.fn(),
    openProjects: vi.fn(),
    openSearch: vi.fn(),
    openQuickCapture: vi.fn(),
    rebaseListIdentity: vi.fn(),
  };
}

function keydown(
  target: EventTarget,
  code: string,
  options: Omit<KeyboardEventInit, 'code'> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code.slice(5),
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function rectList(rectangles: readonly DOMRect[]): DOMRectList {
  const values = [...rectangles];
  return Object.assign(values, {
    item: (index: number) => values[index] ?? null,
  }) as unknown as DOMRectList;
}

function setGeometry(
  element: Element,
  bounds: DOMRect,
  clientRects: readonly DOMRect[] = [bounds],
): void {
  const list = rectList(clientRects);
  Object.defineProperties(element, {
    getBoundingClientRect: { configurable: true, value: () => bounds },
    getClientRects: { configurable: true, value: () => list },
  });
}

interface RouterHarness {
  readonly actions: PanelNavigationActions;
  readonly registry: InteractionRegistry<ShortcutActionId>;
  readonly settings: ShortcutSettings;
  readonly nativeHostBlocks: ReturnType<typeof vi.fn<() => boolean>>;
  readonly panel: HTMLElement;
  readonly router: PanelShortcutRouter;
  setActive(value: boolean): void;
}

const liveRouters: PanelShortcutRouter[] = [];
const mounted: Element[] = [];

function harness(): RouterHarness {
  const actions = navigationActions();
  const registry = new InteractionRegistry<ShortcutActionId>();
  const settings = structuredClone(DEFAULT_SETTINGS.shortcuts);
  const nativeHostBlocks = vi.fn(() => false);
  const panel = document.createElement('section');
  document.body.appendChild(panel);
  mounted.push(panel);
  let active = true;
  const router = new PanelShortcutRouter({
    ownerDocument: document,
    isActive: () => active && panel.isConnected && !panel.hidden,
    settings: () => settings,
    platform: { mod: 'ctrl' },
    actions,
    registry,
    nativeHostBlocks,
  });
  liveRouters.push(router);
  return {
    actions,
    registry,
    settings,
    nativeHostBlocks,
    panel,
    router,
    setActive: (value) => {
      active = value;
    },
  };
}

afterEach(() => {
  for (const router of liveRouters.splice(0)) router.destroy();
  for (const element of mounted.splice(0)) element.remove();
  document
    .querySelectorAll('.menu, .modal-container, .suggestion-container')
    .forEach((element) => element.remove());
  vi.restoreAllMocks();
});

describe('nativeInteractionBlocksPanelShortcuts', () => {
  it.each(['menu', 'modal-container', 'suggestion-container'])(
    'blocks while a connected native %s surface exists',
    (className) => {
      const nativeSurface = document.createElement('div');
      nativeSurface.className = className;
      setGeometry(nativeSurface, rect(20, 20, 180, 80));
      document.body.appendChild(nativeSurface);

      expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(true);

      nativeSurface.remove();
      expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(false);
    },
  );

  it.each([
    [
      'hidden attribute',
      (surface: HTMLElement): void => {
        surface.hidden = true;
      },
    ],
    [
      'aria-hidden state',
      (surface: HTMLElement): void => {
        surface.setAttribute('aria-hidden', 'true');
      },
    ],
    [
      'display:none',
      (surface: HTMLElement): void => {
        surface.style.display = 'none';
      },
    ],
    [
      'visibility:hidden',
      (surface: HTMLElement): void => {
        surface.style.visibility = 'hidden';
      },
    ],
    [
      'disconnection',
      (surface: HTMLElement): void => {
        surface.remove();
      },
    ],
    ['zero area', (surface: HTMLElement): void => setGeometry(surface, rect(20, 20, 0, 80))],
    [
      'no rendered client rectangles',
      (surface: HTMLElement): void => setGeometry(surface, rect(20, 20, 180, 80), []),
    ],
    [
      'offscreen geometry',
      (surface: HTMLElement): void =>
        setGeometry(surface, rect(window.innerWidth + 20, 20, 180, 80)),
    ],
  ] as const)('ignores a retained native surface with %s', (_reason, hideSurface) => {
    const nativeSurface = document.createElement('div');
    nativeSurface.className = 'menu';
    setGeometry(nativeSurface, rect(20, 20, 180, 80));
    document.body.appendChild(nativeSurface);
    hideSurface(nativeSurface);

    expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(false);
  });

  it('keeps partially onscreen animated native surfaces blocking', () => {
    const nativeSurface = document.createElement('div');
    nativeSurface.className = 'suggestion-container';
    nativeSurface.style.opacity = '0';
    nativeSurface.style.transform = 'translateX(-10px)';
    setGeometry(nativeSurface, rect(-20, 20, 80, 80));
    document.body.appendChild(nativeSurface);

    expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(true);
  });

  it('does not treat plugin popovers or similar class names as native blockers', () => {
    const pluginPopover = document.createElement('div');
    pluginPopover.className = 'abyss-popover menu-item modal-content suggestion-item';
    document.body.appendChild(pluginPopover);
    mounted.push(pluginPopover);

    expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(false);
  });
});

describe('PanelShortcutRouter', () => {
  it.each([
    ['openQuickCapture', 'KeyQ', 'openQuickCapture', undefined],
    ['openTasks', 'KeyL', 'openTasks', undefined],
    ['openInbox', 'KeyI', 'openList', 'inbox'],
    ['openToday', 'KeyT', 'openList', 'today'],
    ['openUpcoming', 'KeyU', 'openList', 'upcoming'],
    ['openCalendar', 'KeyC', 'openCalendar', undefined],
    ['openCalendarToday', 'KeyD', 'openCalendarView', 'today'],
    ['openCalendarWeek', 'KeyW', 'openCalendarView', 'week'],
    ['openCalendarMonth', 'KeyM', 'openCalendarView', 'month'],
    ['openProjects', 'KeyP', 'openProjects', undefined],
    ['openSearch', 'KeyS', 'openSearch', undefined],
  ] as const)(
    'maps %s exactly once to its semantic navigation action',
    (_actionId, code, method, argument) => {
      const h = harness();

      const event = keydown(h.panel, code);

      const action = h.actions[method] as ReturnType<typeof vi.fn>;
      if (argument === undefined) expect(action).toHaveBeenCalledWith();
      else expect(action).toHaveBeenCalledWith(argument);
      expect(action).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it("uses the physical code when a Russian layout reports key='й'", () => {
    const h = harness();

    const event = keydown(h.panel, 'KeyQ', { key: 'й' });

    expect(h.actions.openQuickCapture).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('requires an exact modifier set', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Ctrl Shift Q';

    const missingShift = keydown(h.panel, 'KeyQ', { ctrlKey: true });
    const extraAlt = keydown(h.panel, 'KeyQ', { ctrlKey: true, shiftKey: true, altKey: true });
    const exact = keydown(h.panel, 'KeyQ', { ctrlKey: true, shiftKey: true });

    expect(h.actions.openQuickCapture).toHaveBeenCalledOnce();
    expect(missingShift.defaultPrevented).toBe(false);
    expect(extraAlt.defaultPrevented).toBe(false);
    expect(exact.defaultPrevented).toBe(true);
  });

  it('reads and validates the live settings snapshot for every eligible keydown', () => {
    const h = harness();
    const snapshots = vi.fn(() => h.settings);
    h.router.destroy();
    const router = new PanelShortcutRouter({
      ownerDocument: document,
      isActive: () => true,
      settings: snapshots,
      platform: { mod: 'ctrl' },
      actions: h.actions,
      registry: h.registry,
      nativeHostBlocks: h.nativeHostBlocks,
    });
    liveRouters.push(router);

    keydown(h.panel, 'KeyQ');
    h.settings.openQuickCapture = 'E';
    const stale = keydown(h.panel, 'KeyQ');
    const current = keydown(h.panel, 'KeyE');

    expect(h.actions.openQuickCapture).toHaveBeenCalledTimes(2);
    expect(stale.defaultPrevented).toBe(false);
    expect(current.defaultPrevented).toBe(true);
    expect(snapshots).toHaveBeenCalledTimes(3);
  });

  it('validates the active router settings on every keydown before event-specific suppression', () => {
    const h = harness();
    const snapshots = vi.fn(() => h.settings);
    h.router.destroy();
    const router = new PanelShortcutRouter({
      ownerDocument: document,
      isActive: () => true,
      settings: snapshots,
      platform: { mod: 'ctrl' },
      actions: h.actions,
      registry: h.registry,
      nativeHostBlocks: h.nativeHostBlocks,
    });
    liveRouters.push(router);
    const button = h.panel.appendChild(document.createElement('button'));

    keydown(h.panel, 'KeyQ', { repeat: true });
    keydown(button, 'KeyQ');
    keydown(h.panel, 'KeyZ');

    expect(snapshots).toHaveBeenCalledTimes(3);
    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
  });

  it('fails closed immediately when a live settings edit creates a conflict', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Q';
    h.settings.openTasks = 'Q';

    const event = keydown(h.panel, 'KeyQ');

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(h.actions.openTasks).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores inactive, hidden, disconnected, and destroyed panel ownership', () => {
    const h = harness();
    h.setActive(false);
    const inactive = keydown(h.panel, 'KeyQ');
    h.setActive(true);
    h.panel.hidden = true;
    const hidden = keydown(h.panel, 'KeyQ');
    h.panel.hidden = false;
    h.panel.remove();
    const disconnected = keydown(document.body, 'KeyQ');
    document.body.appendChild(h.panel);
    h.router.destroy();
    const destroyed = keydown(h.panel, 'KeyQ');

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(
      [inactive, hidden, disconnected, destroyed].every((event) => !event.defaultPrevented),
    ).toBe(true);
  });

  it.each([
    ['repeat', 'KeyQ', { repeat: true }],
    ['composition', 'KeyQ', { isComposing: true }],
    ['unmatched code', 'KeyZ', {}],
  ] as const)('does not consume %s keydown events', (_name, code, options) => {
    const h = harness();

    const event = keydown(h.panel, code, options);

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not consume an event already prevented by another owner', () => {
    const h = harness();
    const event = new KeyboardEvent('keydown', {
      key: 'q',
      code: 'KeyQ',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    h.panel.dispatchEvent(event);

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['input', 'input'],
    ['textarea', 'textarea'],
    ['select', 'select'],
    ['button', 'button'],
    ['link', 'a'],
    ['contenteditable', 'div'],
  ] as const)('suppresses shortcuts from a composed-path %s', (_name, tagName) => {
    const h = harness();
    const element = document.createElement(tagName);
    if (_name === 'contenteditable') element.setAttribute('contenteditable', 'true');
    h.panel.appendChild(element);

    const event = keydown(element, 'KeyQ');

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['cm-editor', 'CodeMirror'])(
    'suppresses descendants of the %s editor host',
    (className) => {
      const h = harness();
      const editor = document.createElement('div');
      editor.className = className;
      const line = editor.appendChild(document.createElement('div'));
      h.panel.appendChild(editor);

      const event = keydown(line, 'KeyQ');

      expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it('suppresses an editable found only through the shadow composed path', () => {
    const h = harness();
    const shadowHost = h.panel.appendChild(document.createElement('div'));
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const input = shadow.appendChild(document.createElement('input'));

    const event = keydown(input, 'KeyQ');

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('suppresses when the active element is editable even if the event path is not', () => {
    const h = harness();
    const input = h.panel.appendChild(document.createElement('input'));
    input.focus();

    const event = keydown(h.panel, 'KeyQ');

    expect(h.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('lets native hosts and the interaction registry block without consuming the event', () => {
    const native = harness();
    native.nativeHostBlocks.mockReturnValue(true);
    const nativeEvent = keydown(native.panel, 'KeyQ');

    const registered = harness();
    registered.registry.acquire({ blocksShortcuts: true });
    const registryEvent = keydown(registered.panel, 'KeyQ');

    expect(native.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(registered.actions.openQuickCapture).not.toHaveBeenCalled();
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(registryEvent.defaultPrevented).toBe(false);
  });

  it('prevents default and both propagation paths only for an accepted action', () => {
    const h = harness();
    const accepted = new KeyboardEvent('keydown', {
      key: 'q',
      code: 'KeyQ',
      bubbles: true,
      cancelable: true,
    });
    const acceptedStop = vi.spyOn(accepted, 'stopPropagation');
    const acceptedImmediate = vi.spyOn(accepted, 'stopImmediatePropagation');
    h.panel.dispatchEvent(accepted);

    const unmatched = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      bubbles: true,
      cancelable: true,
    });
    const unmatchedStop = vi.spyOn(unmatched, 'stopPropagation');
    const unmatchedImmediate = vi.spyOn(unmatched, 'stopImmediatePropagation');
    h.panel.dispatchEvent(unmatched);

    expect(accepted.defaultPrevented).toBe(true);
    expect(acceptedStop).toHaveBeenCalledOnce();
    expect(acceptedImmediate).toHaveBeenCalledOnce();
    expect(unmatched.defaultPrevented).toBe(false);
    expect(unmatchedStop).not.toHaveBeenCalled();
    expect(unmatchedImmediate).not.toHaveBeenCalled();
  });
});
