import { setIcon } from 'obsidian';
import type { AppState, ViewMode } from '../app/AppState';
import type { PanelNavigationActions } from '../views/panelNavigation';

interface RailItem {
  mode: ViewMode;
  icon: string;
  label: string;
}

const ITEMS: RailItem[] = [
  { mode: 'tasks', icon: 'list-checks', label: 'Tasks' },
  { mode: 'calendar', icon: 'calendar-days', label: 'Calendar' },
  { mode: 'projects', icon: 'folder-kanban', label: 'Projects' },
  { mode: 'search', icon: 'search', label: 'Search' },
];

export class RailPanel {
  private el!: HTMLElement;
  private offMode?: () => void;
  private settingsLifecycle: {
    button: HTMLElement;
    modal: HTMLElement;
    observer: MutationObserver;
  } | null = null;

  constructor(
    private readonly state: AppState,
    private readonly app: {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
        modalEl?: HTMLElement;
      };
    },
    private readonly navigation?: PanelNavigationActions,
  ) {}

  mount(container: HTMLElement): void {
    this.el = container;
    this.offMode = this.state.on('mode', () => {
      this.render();
    });
    this.render();
  }

  destroy(): void {
    this.disposeSettingsLifecycle();
    this.offMode?.();
    this.el.empty();
  }

  private render(): void {
    this.disposeSettingsLifecycle();
    this.el.empty();
    const mode = this.state.get('mode');

    const topGroup = this.el.createDiv({ cls: 'abyss-rail-top' });
    for (const item of ITEMS) {
      const btn = topGroup.createEl('button', {
        cls: `abyss-rail-btn${mode === item.mode ? ' is-active' : ''}`,
        attr: { 'aria-label': item.label, title: item.label },
      });
      setIcon(btn, item.icon);
      btn.addEventListener('click', () => {
        this.openMode(item.mode);
      });
    }

    // Settings at bottom
    const bottomGroup = this.el.createDiv({ cls: 'abyss-rail-bottom' });
    const settingsBtn = bottomGroup.createEl('button', {
      cls: 'abyss-rail-btn',
      attr: { 'aria-label': 'Settings', title: 'Settings' },
    });
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      this.openSettings(settingsBtn);
    });
  }

  private openSettings(settingsButton: HTMLButtonElement): void {
    this.disposeSettingsLifecycle();
    const modal = this.openSettingsTab();
    const OwnerMutationObserver = modal?.ownerDocument.defaultView?.MutationObserver;
    if (modal === undefined || !modal.isConnected || OwnerMutationObserver == null) return;
    settingsButton.addClass('is-active');
    const observer = new OwnerMutationObserver(() => {
      if (this.isClosedSettingsLifecycle(this.settingsLifecycle, modal, observer)) {
        this.disposeSettingsLifecycle();
      }
    });
    this.settingsLifecycle = { button: settingsButton, modal, observer };
    observer.observe(modal.ownerDocument.body, { childList: true, subtree: true });
  }

  private openSettingsTab(): HTMLElement | undefined {
    this.app.setting?.open?.();
    this.app.setting?.openTabById?.('abyss-tasks');
    return this.app.setting?.modalEl;
  }

  private isClosedSettingsLifecycle(
    lifecycle: RailPanel['settingsLifecycle'],
    modal: HTMLElement,
    observer: MutationObserver,
  ): boolean {
    return (
      lifecycle !== null &&
      lifecycle.modal === modal &&
      lifecycle.observer === observer &&
      !modal.isConnected
    );
  }

  private openMode(mode: ViewMode): void {
    if (mode === 'tasks') this.navigation?.openTasks();
    else if (mode === 'calendar') this.navigation?.openCalendar();
    else if (mode === 'projects') this.navigation?.openProjects();
    else this.navigation?.openSearch();
  }

  private disposeSettingsLifecycle(): void {
    const lifecycle = this.settingsLifecycle;
    this.settingsLifecycle = null;
    lifecycle?.observer.disconnect();
    lifecycle?.button.removeClass('is-active');
  }
}
