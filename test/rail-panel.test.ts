import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RailPanel } from '../src/panels/RailPanel';
import type { PanelNavigationActions } from '../src/views/panelNavigation';
import {
  cssDeclarationText as cssDeclarationsFor,
  cssValue as cssDeclarationValue,
} from './cssHelpers';
import { expectDefined, freshContainer, loadPluginStyles, methodOf } from './helpers';

const css = await loadPluginStyles();

describe('RailPanel', () => {
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

  function stateNavigationActions(state: AppState): PanelNavigationActions {
    const actions = navigationActions();
    actions.openTasks = vi.fn(() => {
      state.set('mode', 'tasks');
    });
    actions.openCalendar = vi.fn(() => {
      state.set('mode', 'calendar');
    });
    actions.openProjects = vi.fn(() => {
      state.set('mode', 'projects');
    });
    actions.openSearch = vi.fn(() => {
      state.set('mode', 'search');
    });
    return actions;
  }

  function foreignSettingsHarness() {
    const iframe = createFragment().createEl('iframe');
    activeDocument.body.appendChild(iframe);
    const ownerDocument = expectDefined(iframe.contentDocument);
    const ownerWindow = expectDefined(ownerDocument.defaultView);
    const NativeMutationObserver = ownerWindow.MutationObserver;
    const observers: TrackingMutationObserver[] = [];

    class TrackingMutationObserver extends NativeMutationObserver {
      readonly observeCalls: Array<{
        target: Node;
        options?: MutationObserverInit;
      }> = [];
      disconnectCalls = 0;
      private readonly callback: MutationCallback;

      constructor(callback: MutationCallback) {
        super(callback);
        this.callback = callback;
        observers.push(this);
      }

      override observe(target: Node, options?: MutationObserverInit): void {
        this.observeCalls.push(options === undefined ? { target } : { target, options });
        super.observe(target, options);
      }

      override disconnect(): void {
        this.disconnectCalls += 1;
        super.disconnect();
      }

      deliverStaleCallback(): void {
        this.callback([], this);
      }
    }

    Object.defineProperty(ownerWindow, 'MutationObserver', {
      configurable: true,
      value: TrackingMutationObserver,
    });

    const setting: {
      open(): void;
      openTabById(id: string): void;
      modalEl?: HTMLElement;
    } = {
      open: vi.fn(() => {
        const nextModal = ownerDocument.createElementNS(
          'http://www.w3.org/1999/xhtml',
          'div',
        ) as HTMLDivElement;
        nextModal.className = 'modal mod-settings';
        ownerDocument.body.appendChild(nextModal);
        setting.modalEl = nextModal;
      }),
      openTabById: vi.fn(),
    };

    return {
      iframe,
      ownerDocument,
      observers,
      setting,
      modal: () => expectDefined(setting.modalEl),
      restore: () => {
        Object.defineProperty(ownerWindow, 'MutationObserver', {
          configurable: true,
          value: NativeMutationObserver,
        });
        iframe.remove();
      },
    };
  }

  it('renders 4 mode buttons + 1 settings button', () => {
    const state = new AppState();
    const app = { setting: { open: vi.fn(), openTabById: vi.fn() } };
    const panel = new RailPanel(state, app);
    panel.mount(freshContainer());
    const buttons = panel['el'].querySelectorAll('button');
    expect(buttons).toHaveLength(5);
  });

  it('mode buttons have correct aria-labels, Calendar in 2nd position', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const labels = Array.from(panel['el'].querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Tasks', 'Calendar', 'Projects', 'Search', 'Settings']);
  });

  it.each([
    ['Projects', 'projects'],
    ['Tasks', 'tasks'],
    ['Calendar', 'calendar'],
    ['Search', 'search'],
  ] as const)('click %s button sets mode to %s', (label, expectedMode) => {
    const state = new AppState();
    if (label === 'Tasks') state.set('mode', 'calendar');
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const button = expectDefined(
      Array.from(panel['el'].querySelectorAll('button')).find(
        (candidate) => candidate.getAttribute('aria-label') === label,
      ),
    );
    button.click();
    expect(state.get('mode')).toBe(expectedMode);
  });

  it('routes mode buttons through semantic navigation actions', () => {
    const state = new AppState();
    const navigation = navigationActions();
    const panel = new RailPanel(state, { setting: {} }, navigation);
    panel.mount(freshContainer());

    for (const [label, action] of [
      ['Tasks', methodOf(navigation, 'openTasks')],
      ['Calendar', methodOf(navigation, 'openCalendar')],
      ['Projects', methodOf(navigation, 'openProjects')],
      ['Search', methodOf(navigation, 'openSearch')],
    ] as const) {
      expectDefined(
        panel['el'].querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
      ).click();
      expect(action).toHaveBeenCalledOnce();
    }

    expect(state.get('mode')).toBe('tasks');
  });

  it('active mode button has is-active class', () => {
    const state = new AppState();
    state.set('mode', 'calendar');
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const active = panel['el'].querySelector('.abyss-rail-btn.is-active');
    expect(active?.getAttribute('aria-label')).toBe('Calendar');
  });

  it('state change re-renders active class', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} });
    panel.mount(freshContainer());
    state.set('mode', 'search');
    const active = panel['el'].querySelector('.abyss-rail-btn.is-active');
    expect(active?.getAttribute('aria-label')).toBe('Search');
  });

  it('click Settings calls app.setting.open', () => {
    const state = new AppState();
    const open = vi.fn();
    const openTabById = vi.fn();
    const panel = new RailPanel(state, { setting: { open, openTabById } });
    panel.mount(freshContainer());
    const btn = expectDefined(
      Array.from(panel['el'].querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Settings',
      ),
    );
    btn.click();
    expect(open).toHaveBeenCalledOnce();
  });

  it('click Settings calls openTabById with abyss-tasks', () => {
    const state = new AppState();
    const openTabById = vi.fn();
    const panel = new RailPanel(state, { setting: { open: vi.fn(), openTabById } });
    panel.mount(freshContainer());
    const btn = expectDefined(
      Array.from(panel['el'].querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Settings',
      ),
    );
    btn.click();
    expect(openTabById).toHaveBeenCalledWith('abyss-tasks');
  });

  it.each(['projects', 'search'] as const)(
    'deactivates Settings after its foreign-document modal closes while %s remains active',
    async (mode) => {
      const harness = foreignSettingsHarness();
      const state = new AppState();
      state.set('mode', mode);
      const panel = new RailPanel(state, { setting: harness.setting });

      try {
        panel.mount(freshContainer());
        const settingsButton = expectDefined(
          panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
        );
        settingsButton.click();

        expect(
          Array.from(panel['el'].querySelectorAll('.abyss-rail-btn.is-active')).map((button) =>
            button.getAttribute('aria-label'),
          ),
        ).toEqual([mode === 'projects' ? 'Projects' : 'Search', 'Settings']);
        expect(harness.observers).toHaveLength(1);
        expect(expectDefined(harness.observers[0]).observeCalls).toEqual([
          {
            target: harness.ownerDocument.body,
            options: { childList: true, subtree: true },
          },
        ]);

        harness.modal().remove();
        await vi.waitFor(() => {
          expect(settingsButton.classList.contains('is-active')).toBe(false);
        });

        expect(
          panel['el'].querySelector('.abyss-rail-btn.is-active')?.getAttribute('aria-label'),
        ).toBe(mode === 'projects' ? 'Projects' : 'Search');
        expect(expectDefined(harness.observers[0]).disconnectCalls).toBe(1);
      } finally {
        panel.destroy();
        harness.restore();
      }
    },
  );

  it('disconnects the foreign-document Settings observer when destroyed', () => {
    const harness = foreignSettingsHarness();
    const panel = new RailPanel(new AppState(), { setting: harness.setting });

    try {
      panel.mount(freshContainer());
      expectDefined(
        panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
      ).click();
      expect(harness.observers).toHaveLength(1);

      panel.destroy();

      expect(expectDefined(harness.observers[0]).disconnectCalls).toBe(1);
      expect(panel['el'].children).toHaveLength(0);
    } finally {
      harness.restore();
    }
  });

  it('ignores a stale foreign-document observer after Settings is opened again', async () => {
    const harness = foreignSettingsHarness();
    const panel = new RailPanel(new AppState(), { setting: harness.setting });

    try {
      panel.mount(freshContainer());
      const settingsButton = expectDefined(
        panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
      );
      settingsButton.click();
      const staleModal = harness.modal();
      const staleObserver = expectDefined(harness.observers[0]);

      settingsButton.click();
      const currentModal = harness.modal();
      const currentObserver = expectDefined(harness.observers[1]);

      expect(staleObserver.disconnectCalls).toBe(1);
      expect(currentObserver.disconnectCalls).toBe(0);
      expect(settingsButton.classList.contains('is-active')).toBe(true);

      staleModal.remove();
      staleObserver.deliverStaleCallback();

      expect(settingsButton.classList.contains('is-active')).toBe(true);
      expect(currentObserver.disconnectCalls).toBe(0);

      currentModal.remove();
      await vi.waitFor(() => {
        expect(settingsButton.classList.contains('is-active')).toBe(false);
      });
      expect(currentObserver.disconnectCalls).toBe(1);
    } finally {
      panel.destroy();
      harness.restore();
    }
  });

  it('disconnects the exact Settings observer when a mode render replaces its button', () => {
    const harness = foreignSettingsHarness();
    const state = new AppState();
    state.set('mode', 'projects');
    const panel = new RailPanel(state, { setting: harness.setting });

    try {
      panel.mount(freshContainer());
      expectDefined(
        panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
      ).click();
      const observer = expectDefined(harness.observers[0]);
      expect(observer.disconnectCalls).toBe(0);

      state.set('mode', 'search');

      expect(observer.disconnectCalls).toBe(1);
      expect(harness.observers).toHaveLength(1);
      expect(
        panel['el'].querySelector('.abyss-rail-btn.is-active')?.getAttribute('aria-label'),
      ).toBe('Search');
      expect(
        expectDefined(
          panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
        ).classList.contains('is-active'),
      ).toBe(false);
    } finally {
      panel.destroy();
      harness.restore();
    }
  });

  it('settings button click with undefined setting does not throw', () => {
    const state = new AppState();
    const panel = new RailPanel(state, {});
    panel.mount(freshContainer());
    const btn = expectDefined(
      Array.from(panel['el'].querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Settings',
      ),
    );
    expect(() => {
      btn.click();
    }).not.toThrow();
  });

  it('destroy removes state listener (no re-render after)', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} });
    panel.mount(freshContainer());
    panel.destroy();
    const el = panel['el'];
    state.set('mode', 'search');
    // el is emptied but no new buttons rendered
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });

  it('destroy empties el', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} });
    panel.mount(freshContainer());
    panel.destroy();
    expect(panel['el'].children).toHaveLength(0);
  });

  it('keeps the same tracking host element across a mode render, above Settings', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const host = expectDefined(panel.trackingHost(), 'The rail never made a tracking host');
    const bottom = expectDefined(
      panel['el'].querySelector<HTMLElement>('.abyss-rail-bottom'),
      'Missing the rail bottom group',
    );
    expect(host.parentElement).toBe(bottom);
    expect(host.nextElementSibling?.getAttribute('aria-label')).toBe('Settings');

    state.set('mode', 'calendar');

    // A remount would throw away whatever the tracking widget had mounted into the host, so the
    // rail has to re-place the very same element rather than build a new one.
    expect(panel.trackingHost()).toBe(host);
    const rebuilt = expectDefined(
      panel['el'].querySelector<HTMLElement>('.abyss-rail-bottom'),
      'Missing the rail bottom group',
    );
    expect(rebuilt).not.toBe(bottom);
    expect(host.parentElement).toBe(rebuilt);
    expect(host.nextElementSibling?.getAttribute('aria-label')).toBe('Settings');
    expect(panel['el'].querySelectorAll('.abyss-rail-tracking')).toHaveLength(1);

    panel.destroy();
  });

  it('keeps the tracking widget off the Settings button', () => {
    // The widget sits directly above Settings, so the space that keeps them apart is its own: the
    // two controls are given the whole column to be targets in, the rule's own margin is the 4px
    // under them, and the widget's bottom padding is the 8px below the hairline.
    const widget = cssDeclarationsFor(css, '.abyss-rail-tracking');
    expect(cssDeclarationValue(widget, 'gap')).toBe('0');
    expect(widget).toContain('padding-bottom: var(--size-4-2)');
    const rule = cssDeclarationsFor(css, '.abyss-rail-tracking-rule');
    expect(rule).toContain('margin-top: var(--size-4-1)');
    expect(rule).toContain('width: 20px');
    expect(rule).toContain('height: 1px');
  });

  it('gives the tracking number a target a pointer can find', () => {
    const widget = cssDeclarationsFor(css, '.abyss-rail-tracking');
    const number = cssDeclarationsFor(css, '.abyss-rail-tracking .abyss-rail-tracking-task');

    // `1m` is about 14px of text, which is next to nothing to aim at in a 48px rail.
    expect(cssDeclarationValue(number, 'min-width')).toBe('36px');
    // 10px over 1.2 is a 12px line, so this padding is what makes the target 24px tall, and it is
    // the same above and below, so the digits sit in the middle of what a pointer aims at.
    expect(cssDeclarationValue(widget, 'font-size')).toBe('10px');
    expect(cssDeclarationValue(widget, 'line-height')).toBe('1.2');
    expect(cssDeclarationValue(number, 'padding')).toBe('var(--size-2-3) 0');
    // The column pays for the target rather than lending it out of the control above, so the two
    // never overlap and nothing of the number reaches into the toggle's own square.
    expect(cssDeclarationValue(number, 'margin-block')).toBeUndefined();
    // `23h 59m` is wider than the target and leaves no room beside it, so the ring goes inside.
    expect(
      cssDeclarationValue(
        cssDeclarationsFor(css, '.abyss-rail-tracking .abyss-rail-tracking-task:focus-visible'),
        'outline-offset',
      ),
    ).toBe('-1px');
  });

  it('weighs the filled tracking glyph against the outlined icons around it', () => {
    // Filled at the rail's own 18px the play reads heavier than the Settings gear under it, so the
    // one glyph on the rail that carries a fill takes 2px off to carry the same mass.
    expect(cssDeclarationValue(cssDeclarationsFor(css, '.abyss-rail-btn svg'), 'width')).toBe(
      '18px',
    );
    const glyph = cssDeclarationsFor(css, '.abyss-rail-tracking-toggle svg');
    expect(cssDeclarationValue(glyph, 'width')).toBe('16px');
    expect(cssDeclarationValue(glyph, 'height')).toBe('16px');
    // What a pointer aims at is the button, which keeps its square whatever the glyph weighs.
    const toggle = cssDeclarationsFor(css, '.abyss-rail-tracking .abyss-rail-tracking-toggle');
    expect(cssDeclarationValue(toggle, 'width')).toBe('28px');
    expect(cssDeclarationValue(toggle, 'height')).toBe('28px');
  });

  it('collapses the host the widget hides itself with', () => {
    // The host is a flex column, which outranks the browser's own rule for `hidden`, so a rail with
    // nothing to report would keep its own bottom padding above Settings unless the sheet says so.
    expect(cssDeclarationsFor(css, '.abyss-rail-tracking[hidden]')).toContain('display: none');
  });
});
