import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RailPanel } from '../src/panels/RailPanel';
import type { PanelNavigationActions } from '../src/views/panelNavigation';
import { freshContainer } from './helpers';

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
    actions.openTasks = vi.fn(() => state.set('mode', 'tasks'));
    actions.openCalendar = vi.fn(() => state.set('mode', 'calendar'));
    actions.openProjects = vi.fn(() => state.set('mode', 'projects'));
    actions.openSearch = vi.fn(() => state.set('mode', 'search'));
    return actions;
  }

  function foreignSettingsHarness() {
    const iframe = activeDocument.createElement('iframe');
    activeDocument.body.appendChild(iframe);
    const ownerDocument = iframe.contentDocument!;
    const ownerWindow = ownerDocument.defaultView!;
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
        this.observeCalls.push({ target, options });
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

    let modalEl: HTMLElement | undefined;
    const setting = {
      open: vi.fn(() => {
        modalEl = ownerDocument.createElement('div');
        modalEl.className = 'modal mod-settings';
        ownerDocument.body.appendChild(modalEl);
        setting.modalEl = modalEl;
      }),
      openTabById: vi.fn(),
      modalEl,
    };

    return {
      iframe,
      ownerDocument,
      observers,
      setting,
      modal: () => setting.modalEl!,
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

  it('click Projects button sets mode to projects', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Projects',
    )!;
    btn.click();
    expect(state.get('mode')).toBe('projects');
  });

  it('routes mode buttons through semantic navigation actions', () => {
    const state = new AppState();
    const navigation = navigationActions();
    const panel = new RailPanel(state, { setting: {} }, navigation);
    panel.mount(freshContainer());

    for (const [label, action] of [
      ['Tasks', navigation.openTasks],
      ['Calendar', navigation.openCalendar],
      ['Projects', navigation.openProjects],
      ['Search', navigation.openSearch],
    ] as const) {
      panel['el'].querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
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

  it('click Tasks button sets mode to tasks', () => {
    const state = new AppState();
    state.set('mode', 'calendar');
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Tasks',
    )!;
    btn.click();
    expect(state.get('mode')).toBe('tasks');
  });

  it('click Calendar button sets mode to calendar', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Calendar',
    )!;
    btn.click();
    expect(state.get('mode')).toBe('calendar');
  });

  it('click Search button sets mode to search', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: {} }, stateNavigationActions(state));
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Search',
    )!;
    btn.click();
    expect(state.get('mode')).toBe('search');
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
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Settings',
    )!;
    btn.click();
    expect(open).toHaveBeenCalledOnce();
  });

  it('click Settings calls openTabById with task-calendar', () => {
    const state = new AppState();
    const openTabById = vi.fn();
    const panel = new RailPanel(state, { setting: { open: vi.fn(), openTabById } });
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Settings',
    )!;
    btn.click();
    expect(openTabById).toHaveBeenCalledWith('task-calendar');
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
        const settingsButton =
          panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]')!;
        settingsButton.click();

        expect(
          Array.from(panel['el'].querySelectorAll('.abyss-rail-btn.is-active')).map((button) =>
            button.getAttribute('aria-label'),
          ),
        ).toEqual([mode === 'projects' ? 'Projects' : 'Search', 'Settings']);
        expect(harness.observers).toHaveLength(1);
        expect(harness.observers[0]!.observeCalls).toEqual([
          {
            target: harness.ownerDocument.body,
            options: { childList: true, subtree: true },
          },
        ]);

        harness.modal().remove();
        await vi.waitFor(() => expect(settingsButton.classList.contains('is-active')).toBe(false));

        expect(
          panel['el'].querySelector('.abyss-rail-btn.is-active')?.getAttribute('aria-label'),
        ).toBe(mode === 'projects' ? 'Projects' : 'Search');
        expect(harness.observers[0]!.disconnectCalls).toBe(1);
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
      panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click();
      expect(harness.observers).toHaveLength(1);

      panel.destroy();

      expect(harness.observers[0]!.disconnectCalls).toBe(1);
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
      const settingsButton =
        panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]')!;
      settingsButton.click();
      const staleModal = harness.modal();
      const staleObserver = harness.observers[0]!;

      settingsButton.click();
      const currentModal = harness.modal();
      const currentObserver = harness.observers[1]!;

      expect(staleObserver.disconnectCalls).toBe(1);
      expect(currentObserver.disconnectCalls).toBe(0);
      expect(settingsButton.classList.contains('is-active')).toBe(true);

      staleModal.remove();
      staleObserver.deliverStaleCallback();

      expect(settingsButton.classList.contains('is-active')).toBe(true);
      expect(currentObserver.disconnectCalls).toBe(0);

      currentModal.remove();
      await vi.waitFor(() => expect(settingsButton.classList.contains('is-active')).toBe(false));
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
      panel['el'].querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click();
      const observer = harness.observers[0]!;
      expect(observer.disconnectCalls).toBe(0);

      state.set('mode', 'search');

      expect(observer.disconnectCalls).toBe(1);
      expect(harness.observers).toHaveLength(1);
      expect(
        panel['el'].querySelector('.abyss-rail-btn.is-active')?.getAttribute('aria-label'),
      ).toBe('Search');
      expect(
        panel['el']
          .querySelector<HTMLButtonElement>('[aria-label="Settings"]')!
          .classList.contains('is-active'),
      ).toBe(false);
    } finally {
      panel.destroy();
      harness.restore();
    }
  });

  it('settings button click with undefined setting does not throw', () => {
    const state = new AppState();
    const panel = new RailPanel(state, { setting: undefined });
    panel.mount(freshContainer());
    const btn = Array.from(panel['el'].querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Settings',
    )!;
    expect(() => btn.click()).not.toThrow();
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
