import { setIcon } from 'obsidian';
import type { AppState, ViewMode } from '../app/AppState';

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
    private state: AppState,
    private app: {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
        modalEl?: HTMLElement;
      };
    },
  ) {}

  mount(container: HTMLElement): void {
    this.el = container;
    this.offMode = this.state.on('mode', () => this.render());
    this.render();
  }

  destroy(): void {
    this.disposeSettingsLifecycle();
    this.offMode?.();
    this.el?.empty();
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
        this.state.set('mode', item.mode);
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
      this.disposeSettingsLifecycle();
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.('task-calendar');
      const modal = this.app.setting?.modalEl;
      const OwnerMutationObserver = modal?.ownerDocument.defaultView?.MutationObserver;
      if (!modal?.isConnected || !OwnerMutationObserver) return;
      settingsBtn.addClass('is-active');
      let observer!: MutationObserver;
      observer = new OwnerMutationObserver(() => {
        const lifecycle = this.settingsLifecycle;
        if (lifecycle?.modal === modal && lifecycle.observer === observer && !modal.isConnected) {
          this.disposeSettingsLifecycle();
        }
      });
      this.settingsLifecycle = { button: settingsBtn, modal, observer };
      observer.observe(modal.ownerDocument.body, { childList: true, subtree: true });
    });
  }

  private disposeSettingsLifecycle(): void {
    const lifecycle = this.settingsLifecycle;
    this.settingsLifecycle = null;
    lifecycle?.observer.disconnect();
    lifecycle?.button.removeClass('is-active');
  }
}
