import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RailPanel } from '../src/panels/RailPanel';
import type { PanelNavigationActions } from '../src/views/panelNavigation';
import { expectDefined, freshContainer, methodOf } from './helpers';

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
});
