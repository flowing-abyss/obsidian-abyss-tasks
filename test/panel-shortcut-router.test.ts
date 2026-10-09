import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ShortcutActionId, ShortcutSettings } from '../src/settings/shortcuts';
import { InteractionRegistry } from '../src/ui/interactionOwnership';
import { nativeInteractionBlocksPanelShortcuts } from '../src/ui/nativeInteractionBlocker';
import { PanelShortcutRouter } from '../src/ui/panelShortcutRouter';
import type { PanelNavigationActions } from '../src/views/panelNavigation';
import { expectDefined, methodOf } from './helpers';
import { scopeKeyboardEvent } from './support/scopeKeyboardEvent';

function navigationActions(): PanelNavigationActions {
  return {
    openTasks: vi.fn(),
    openList: vi.fn(),
    openCalendar: vi.fn(),
    openCalendarView: vi.fn(),
    openProjects: vi.fn(),
    openStatistics: vi.fn(),
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
  });
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

function harness(isActionAvailable?: (action: ShortcutActionId) => boolean): RouterHarness {
  const actions = navigationActions();
  const registry = new InteractionRegistry<ShortcutActionId>();
  const settings = structuredClone(DEFAULT_SETTINGS.shortcuts);
  const nativeHostBlocks = vi.fn(() => false);
  const panel = createEl('section');
  document.body.appendChild(panel);
  mounted.push(panel);
  let active = true;
  const router = new PanelShortcutRouter({
    ownerDocument: document,
    isActive: () => active && panel.isConnected && panel.hidden === false,
    settings: () => settings,
    platform: { mod: 'ctrl' },
    actions,
    registry,
    nativeHostBlocks,
    ...(isActionAvailable === undefined ? {} : { isActionAvailable }),
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
  document.querySelectorAll('.menu, .modal-container, .suggestion-container').forEach((element) => {
    element.remove();
  });
  vi.restoreAllMocks();
});

describe('nativeInteractionBlocksPanelShortcuts', () => {
  it.each(['menu', 'modal-container', 'suggestion-container'])(
    'blocks while a connected native %s surface exists',
    (className) => {
      const nativeSurface = createDiv();
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
        surface.setCssProps({ display: 'none' });
      },
    ],
    [
      'visibility:hidden',
      (surface: HTMLElement): void => {
        surface.setCssProps({ visibility: 'hidden' });
      },
    ],
    [
      'disconnection',
      (surface: HTMLElement): void => {
        surface.remove();
      },
    ],
    [
      'zero area',
      (surface: HTMLElement): void => {
        setGeometry(surface, rect(20, 20, 0, 80));
      },
    ],
    [
      'no rendered client rectangles',
      (surface: HTMLElement): void => {
        setGeometry(surface, rect(20, 20, 180, 80), []);
      },
    ],
    [
      'offscreen geometry',
      (surface: HTMLElement): void => {
        setGeometry(surface, rect(window.innerWidth + 20, 20, 180, 80));
      },
    ],
  ] as const)('ignores a retained native surface with %s', (_reason, hideSurface) => {
    const nativeSurface = createDiv();
    nativeSurface.className = 'menu';
    setGeometry(nativeSurface, rect(20, 20, 180, 80));
    document.body.appendChild(nativeSurface);
    hideSurface(nativeSurface);

    expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(false);
  });

  it('keeps partially onscreen animated native surfaces blocking', () => {
    const nativeSurface = createDiv();
    nativeSurface.className = 'suggestion-container';
    nativeSurface.setCssProps({ opacity: '0', transform: 'translateX(-10px)' });
    setGeometry(nativeSurface, rect(-20, 20, 80, 80));
    document.body.appendChild(nativeSurface);

    expect(nativeInteractionBlocksPanelShortcuts(document)).toBe(true);
  });

  it('does not treat plugin popovers or similar class names as native blockers', () => {
    const pluginPopover = createDiv();
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
    ['openStatistics', 'KeyA', 'openStatistics', undefined],
    ['openSearch', 'KeyS', 'openSearch', undefined],
  ] as const)(
    'maps %s exactly once to its semantic navigation action',
    (_actionId, code, method, argument) => {
      const h = harness();

      const event = keydown(h.panel, code);

      const action = methodOf(h.actions, method) as ReturnType<typeof vi.fn>;
      if (argument === undefined) expect(action).toHaveBeenCalledWith();
      else expect(action).toHaveBeenCalledWith(argument);
      expect(action).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('leaves unavailable Analysis unconsumed and permits other available actions', () => {
    let available = false;
    const h = harness((action) => action !== 'openStatistics' || available);
    const unavailable = keydown(h.panel, 'KeyA');
    expect(unavailable.defaultPrevented).toBe(false);
    expect(methodOf(h.actions, 'openStatistics')).not.toHaveBeenCalled();
    expect(keydown(h.panel, 'KeyS').defaultPrevented).toBe(true);
    expect(methodOf(h.actions, 'openSearch')).toHaveBeenCalledOnce();
    available = true;
    expect(keydown(h.panel, 'KeyA', { key: 'ф' }).defaultPrevented).toBe(true);
    expect(methodOf(h.actions, 'openStatistics')).toHaveBeenCalledOnce();
  });

  it.each([
    ['KeyQ', 'й', 'openQuickCapture'],
    ['KeyA', 'ф', 'openStatistics'],
  ] as const)('uses physical %s when a Russian layout reports %s', (code, key, action) => {
    const h = harness();

    const event = keydown(h.panel, code, { key });

    expect(methodOf(h.actions, action)).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes every valid alternative using physical codes', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Q | shift 7';

    keydown(h.panel, 'KeyQ', { key: 'й' });
    keydown(h.panel, 'Digit7', { key: '?', shiftKey: true });

    expect(methodOf(h.actions, 'openQuickCapture')).toHaveBeenCalledTimes(2);
  });

  it('blocks only a conflicting alternative', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Q | shift 7';
    h.settings.openSearch = 'Q | S';

    keydown(h.panel, 'KeyQ', { key: 'й' });
    keydown(h.panel, 'Digit7', { key: '?', shiftKey: true });
    keydown(h.panel, 'KeyS', { key: 'ы' });

    expect(methodOf(h.actions, 'openQuickCapture')).toHaveBeenCalledTimes(1);
    expect(methodOf(h.actions, 'openSearch')).toHaveBeenCalledTimes(1);
  });

  it('requires an exact modifier set', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Ctrl Shift Q';

    const missingShift = keydown(h.panel, 'KeyQ', { ctrlKey: true });
    const extraAlt = keydown(h.panel, 'KeyQ', { ctrlKey: true, shiftKey: true, altKey: true });
    const exact = keydown(h.panel, 'KeyQ', { ctrlKey: true, shiftKey: true });

    expect(methodOf(h.actions, 'openQuickCapture')).toHaveBeenCalledOnce();
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

    h.settings.openQuickCapture = 'Q | shift 7';
    keydown(h.panel, 'Digit7', { shiftKey: true });
    h.settings.openQuickCapture = 'E | alt 9';
    const stale = keydown(h.panel, 'KeyQ');
    const current = keydown(h.panel, 'KeyE');

    expect(methodOf(h.actions, 'openQuickCapture')).toHaveBeenCalledTimes(2);
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
    const button = h.panel.appendChild(createEl('button'));

    keydown(h.panel, 'KeyQ', { repeat: true });
    keydown(button, 'KeyQ');
    keydown(h.panel, 'KeyZ');

    expect(snapshots).toHaveBeenCalledTimes(3);
    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
  });

  it('fails closed immediately when a live settings edit creates a conflict', () => {
    const h = harness();
    h.settings.openQuickCapture = 'Q';
    h.settings.openTasks = 'Q';

    const event = keydown(h.panel, 'KeyQ');

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(methodOf(h.actions, 'openTasks')).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    [
      'settings getter exception',
      (): ShortcutSettings => {
        throw new Error('settings unavailable');
      },
    ],
    ['malformed runtime snapshot', (): ShortcutSettings => ({}) as ShortcutSettings],
  ])('fails closed without consuming when %s occurs', (_reason, settings) => {
    const h = harness();
    h.router.destroy();
    const router = new PanelShortcutRouter({
      ownerDocument: document,
      isActive: () => true,
      settings,
      platform: { mod: 'ctrl' },
      actions: h.actions,
      registry: h.registry,
      nativeHostBlocks: h.nativeHostBlocks,
    });
    liveRouters.push(router);

    const event = keydown(h.panel, 'KeyQ');

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['KeyQ', 'KeyA'])(
    'ignores inactive, hidden, disconnected, and destroyed ownership for %s',
    (code) => {
      const h = harness();
      h.setActive(false);
      const inactive = keydown(h.panel, code);
      h.setActive(true);
      h.panel.hidden = true;
      const hidden = keydown(h.panel, code);
      h.panel.hidden = false;
      h.panel.remove();
      const disconnected = keydown(document.body, code);
      document.body.appendChild(h.panel);
      h.router.destroy();
      const destroyed = keydown(h.panel, code);

      expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
      expect(methodOf(h.actions, 'openStatistics')).not.toHaveBeenCalled();
      expect(
        [inactive, hidden, disconnected, destroyed].every((event) => !event.defaultPrevented),
      ).toBe(true);
    },
  );

  it.each([
    ['repeat', 'KeyQ', { repeat: true }],
    ['composition', 'KeyQ', { isComposing: true }],
    ['unmatched code', 'KeyZ', {}],
    ['Analysis repeat', 'KeyA', { repeat: true }],
    ['Analysis composition', 'KeyA', { isComposing: true }],
    ['Analysis legacy IME', 'KeyA', { keyCode: 229 }],
    ['Analysis Alt', 'KeyA', { altKey: true }],
    ['Analysis Shift', 'KeyA', { shiftKey: true }],
    ['Analysis Ctrl select-all', 'KeyA', { ctrlKey: true }],
    ['Analysis Cmd select-all', 'KeyA', { metaKey: true }],
  ] as const)('does not consume %s keydown events', (_name, code, options) => {
    const h = harness();

    const event = keydown(h.panel, code, options);

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(methodOf(h.actions, 'openStatistics')).not.toHaveBeenCalled();
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

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['input', 'input'],
      ['textarea', 'textarea'],
      ['select', 'select'],
      ['button', 'button'],
      ['link', 'a'],
      ['contenteditable', 'div'],
    ].flatMap(([name, tag]) => ['KeyQ', 'KeyA'].map((code) => [name, tag, code] as const)),
  )('suppresses shortcuts from a composed-path %s for %s / %s', (_name, tagName, code) => {
    const h = harness();
    const element = createEl(tagName as keyof HTMLElementTagNameMap);
    if (_name === 'contenteditable') element.setAttribute('contenteditable', 'true');
    h.panel.appendChild(element);

    const event = keydown(element, code);

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(methodOf(h.actions, 'openStatistics')).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['cm-editor', 'CodeMirror'])(
    'suppresses descendants of the %s editor host',
    (className) => {
      const h = harness();
      const editor = createDiv();
      editor.className = className;
      const line = editor.appendChild(createDiv());
      h.panel.appendChild(editor);

      const event = keydown(line, 'KeyQ');

      expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it('suppresses an editable found only through the shadow composed path', () => {
    const h = harness();
    const shadowHost = h.panel.appendChild(createDiv());
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const input = shadow.appendChild(createEl('input'));

    const event = keydown(input, 'KeyQ');

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('suppresses when the active element is editable even if the event path is not', () => {
    const h = harness();
    const input = h.panel.appendChild(createEl('input'));
    input.focus();

    const event = keydown(h.panel, 'KeyQ');

    expect(methodOf(h.actions, 'openQuickCapture')).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['KeyQ', 'KeyA'])(
    'lets native hosts and the interaction registry block %s without consuming',
    (code) => {
      const native = harness();
      native.nativeHostBlocks.mockReturnValue(true);
      const nativeEvent = keydown(native.panel, code);

      const registered = harness();
      registered.registry.acquire({ blocksShortcuts: true });
      const registryEvent = keydown(registered.panel, code);

      expect(methodOf(native.actions, 'openQuickCapture')).not.toHaveBeenCalled();
      expect(methodOf(registered.actions, 'openQuickCapture')).not.toHaveBeenCalled();
      expect(methodOf(native.actions, 'openStatistics')).not.toHaveBeenCalled();
      expect(methodOf(registered.actions, 'openStatistics')).not.toHaveBeenCalled();
      expect(nativeEvent.defaultPrevented).toBe(false);
      expect(registryEvent.defaultPrevented).toBe(false);
    },
  );

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

describe('owned local Find and Escape', () => {
  it.each(['ctrl', 'meta'] as const)(
    'routes the %s primary from buttons and the same input, rejecting drafts/leases/native owners',
    (primary) => {
      const h = harness();
      h.router.destroy();
      h.panel.tabIndex = -1;
      const input = h.panel.createEl('input');
      input.value = 'Теск';
      const button = h.panel.createEl('button');
      const router = new PanelShortcutRouter({
        ownerDocument: document,
        ownerElement: h.panel,
        isActive: () => h.panel.isConnected && h.panel.hidden !== true,
        settings: () => h.settings,
        platform: { mod: primary },
        actions: h.actions,
        registry: h.registry,
        nativeHostBlocks: h.nativeHostBlocks,
        localSearchTarget: () => ({ input, owner: h.panel }),
      });
      liveRouters.push(router);
      const modifiers = { ctrlKey: primary === 'ctrl', metaKey: primary === 'meta' };
      button.focus();
      const host = vi.fn();
      document.addEventListener('keydown', host, true);
      try {
        expect(keydown(button, 'KeyF', modifiers).defaultPrevented).toBe(true);
        expect(host).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', host, true);
      }
      expect(document.activeElement).toBe(input);
      expect(input.selectionEnd).toBe(4);
      input.setSelectionRange(2, 2);
      keydown(input, 'KeyF', modifiers);
      expect(input.selectionStart).toBe(0);
      for (const extra of [
        { altKey: true },
        { shiftKey: true },
        { ctrlKey: true, metaKey: true },
        { ctrlKey: false, metaKey: false },
        { ctrlKey: primary !== 'ctrl', metaKey: primary !== 'meta' },
        { isComposing: true },
        { keyCode: 229 },
        { repeat: true },
      ]) {
        button.focus();
        expect(keydown(button, 'KeyF', { ...modifiers, ...extra }).defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(button);
      }
      const prevented = new KeyboardEvent('keydown', {
        code: 'KeyF',
        ...modifiers,
        bubbles: true,
        cancelable: true,
      });
      prevented.preventDefault();
      button.dispatchEvent(prevented);
      expect(document.activeElement).toBe(button);
      h.nativeHostBlocks.mockReturnValue(true);
      expect(keydown(button, 'KeyF', modifiers).defaultPrevented).toBe(false);
      h.nativeHostBlocks.mockReturnValue(false);
      const lease = h.registry.acquire({ blocksShortcuts: true });
      expect(keydown(button, 'KeyF', modifiers).defaultPrevented).toBe(false);
      lease.release();
      const draft = h.panel.createEl('textarea');
      draft.focus();
      expect(keydown(draft, 'KeyF', modifiers).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(draft);
      input.focus();
      for (const extra of [
        { altKey: true },
        { shiftKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { isComposing: true },
        { keyCode: 229 },
        { repeat: true },
      ]) {
        expect(keydown(input, 'Escape', { key: 'Escape', ...extra }).defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('Теск');
      }
      const escape = keydown(input, 'Escape', { key: 'Escape' });
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(h.panel);
      expect(input.value).toBe('Теск');
      const otherPane = document.body.createEl('section');
      mounted.push(otherPane);
      const otherButton = otherPane.createEl('button');
      otherButton.focus();
      expect(keydown(otherButton, 'KeyF', modifiers).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(otherButton);
    },
  );
});

it.each(['ctrl', 'meta'] as const)(
  'routes host-Window Scope transport with %s through the current adopted owner',
  (primary) => {
    const h = harness();
    h.router.destroy();
    h.panel.tabIndex = -1;
    let active = true;
    const input = h.panel.createEl('input');
    input.value = 'preserved';
    const router = new PanelShortcutRouter({
      ownerDocument: document,
      ownerElement: h.panel,
      isActive: () => active,
      settings: () => h.settings,
      platform: { mod: primary },
      actions: h.actions,
      registry: h.registry,
      nativeHostBlocks: h.nativeHostBlocks,
      localSearchTarget: () => ({ input, owner: h.panel }),
    });
    liveRouters.push(router);
    const frame = document.body.createEl('iframe');
    mounted.push(frame);
    const doc = expectDefined(frame.contentDocument);
    doc.body.append(h.panel);
    input.focus();
    const find = {
      key: 'f',
      code: 'KeyF',
      ctrlKey: primary === 'ctrl',
      metaKey: primary === 'meta',
    };
    const hostWindow = window;
    const event = () => scopeKeyboardEvent(input, find, [hostWindow]);
    const accepted = event();
    expect(accepted.target).toBe(doc.activeElement);
    expect(accepted.composedPath()).toEqual([hostWindow]);
    expect(accepted.composedPath()[0]).not.toBe(accepted.target);
    expect(hostWindow).not.toBe(doc.defaultView);
    expect(accepted.view?.document).toBe(doc);
    expect(accepted.isTrusted).toBe(false);
    expect.soft(router.routeLocalSearch(accepted, 'scope')).toBe(true);
    expect.soft(accepted.defaultPrevented).toBe(true);
    expect.soft([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
    expect(router.routeLocalSearch(event(), 'dom')).toBe(false);
    for (const extra of [
      { altKey: true },
      { shiftKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: false, metaKey: false },
      { ctrlKey: primary !== 'ctrl', metaKey: primary !== 'meta' },
      { repeat: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      const rejected = scopeKeyboardEvent(input, { ...find, ...extra }, [hostWindow]);
      expect(router.routeLocalSearch(rejected, 'scope')).toBe(false);
      expect(rejected.defaultPrevented).toBe(false);
    }
    const prevented = event();
    prevented.preventDefault();
    expect(router.routeLocalSearch(prevented, 'scope')).toBe(false);
    const escape = scopeKeyboardEvent(input, { key: 'Escape' }, [hostWindow]);
    expect(router.routeLocalSearch(escape, 'scope')).toBe(true);
    expect(doc.activeElement).toBe(h.panel);
    expect(input.value).toBe('preserved');

    input.focus();
    const other = h.panel.createEl('button');
    const oldInput = document.body.createEl('input');
    mounted.push(oldInput);
    for (const rejected of [
      scopeKeyboardEvent(other, find, [hostWindow]),
      scopeKeyboardEvent(input, find, [other]),
      scopeKeyboardEvent(input, find, []),
      scopeKeyboardEvent(input, find, [doc]),
      scopeKeyboardEvent(input, find, [hostWindow, other]),
      scopeKeyboardEvent(oldInput, { ...find, view: doc.defaultView }, [hostWindow]),
      scopeKeyboardEvent(input, { ...find, view: window }, [hostWindow]),
    ]) {
      expect(router.routeLocalSearch(rejected, 'scope')).toBe(false);
      expect(rejected.defaultPrevented).toBe(false);
    }
    other.focus();
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    expect(doc.activeElement).toBe(other);
    const editor = h.panel.createEl('textarea');
    editor.focus();
    expect(router.routeLocalSearch(scopeKeyboardEvent(editor, find, [hostWindow]), 'scope')).toBe(
      false,
    );
    expect(doc.activeElement).toBe(editor);
    const foreign = document.body.createEl('input');
    doc.body.append(foreign);
    foreign.focus();
    expect(router.routeLocalSearch(scopeKeyboardEvent(foreign, find, [hostWindow]), 'scope')).toBe(
      false,
    );
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    input.focus();
    h.nativeHostBlocks.mockReturnValue(true);
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    h.nativeHostBlocks.mockReturnValue(false);
    const lease = h.registry.acquire({ blocksShortcuts: true });
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    lease.release();
    active = false;
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    active = true;
    h.panel.hidden = true;
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    h.panel.hidden = false;
    h.panel.remove();
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
    doc.body.append(h.panel);
    input.focus();
    router.destroy();
    expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
  },
);

it('guards public scope routing live, permits neutral focus only for scope, and ignores broken navigation settings', () => {
  const h = harness();
  h.router.destroy();
  const input = h.panel.createEl('input');
  const router = new PanelShortcutRouter({
    ownerDocument: document,
    ownerElement: h.panel,
    isActive: () => h.panel.hidden !== true,
    settings: () => {
      throw new Error('bad settings');
    },
    platform: { mod: 'ctrl' },
    actions: h.actions,
    registry: h.registry,
    nativeHostBlocks: h.nativeHostBlocks,
    localSearchTarget: () => ({ input, owner: h.panel }),
  });
  liveRouters.push(router);
  const event = () =>
    new KeyboardEvent('keydown', { code: 'KeyF', ctrlKey: true, cancelable: true });
  expect(router.routeLocalSearch(event())).toBe(false);
  expect(router.routeLocalSearch(event(), 'scope')).toBe(true);
  input.blur();
  h.panel.hidden = true;
  expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
  h.panel.hidden = false;
  const other = document.body.createEl('button');
  mounted.push(other);
  other.focus();
  expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
  other.remove();
  const frame = document.body.createEl('iframe');
  mounted.push(frame);
  const foreign = expectDefined(frame.contentDocument);
  foreign.body.append(h.panel);
  expect(router.routeLocalSearch(event(), 'scope')).toBe(true);
  input.blur();
  h.panel.remove();
  expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
  document.body.append(h.panel);
  router.destroy();
  expect(router.routeLocalSearch(event(), 'scope')).toBe(false);
});
