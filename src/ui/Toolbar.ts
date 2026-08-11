const ARROW_LEFT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;
const ARROW_RIGHT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
const FILTER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;
const MONTH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>`;
const WEEK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="M17 14h-6"></path><path d="M13 18H7"></path><path d="M7 14h.01"></path><path d="M17 18h.01"></path></svg>`;
const LIST_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

const DEFAULT_VIEW_ICONS: Record<string, string> = {
  month: MONTH_ICON,
  week: WEEK_ICON,
  list: LIST_ICON,
};

export interface ViewEntry {
  id: string;
  icon: string;
  label: string;
}

export interface ToolbarState {
  currentView: string;
  currentTitle: string;
  currentStyle: string;
  filterActive: boolean;
  overdueHighlightActive: boolean;
  stats: {
    done: number;
    due: number;
    overdue: number;
    start: number;
    scheduled: number;
    recurrence: number;
    dailyNote: number;
  };
  activeStatGroup: string | null;
}

export interface ToolbarCallbacks {
  onPrev(): void;
  onNext(): void;
  onToday(): void;
  onViewSwitch(viewId: string): void;
  onFilterToggle(): void;
  onOverdueHighlight(): void;
  onStatFilter(group: string | null): void;
  onStyleChange(style: string): void;
}

export class Toolbar {
  private el: HTMLElement;
  private ownerDocument: Document;
  private ownerWindow: Window;
  private currentBtn: HTMLButtonElement;
  private viewButtons = new Map<string, HTMLButtonElement>();
  private filterBtn: HTMLButtonElement;
  private overdueBtn: HTMLButtonElement;
  private statBtn: HTMLButtonElement;
  private statPopup: HTMLElement;
  private statEls: Record<string, HTMLElement> = {};
  private stylePopup: HTMLElement;
  private activePopup:
    | {
        popup: HTMLElement;
        trigger: HTMLButtonElement;
        registrationTimer: number;
        listening: boolean;
        onDocumentKeydown: (event: KeyboardEvent) => void;
        onDocumentMousedown: (event: MouseEvent) => void;
      }
    | undefined;
  private currentView = '';

  constructor(container: HTMLElement, views: ViewEntry[], callbacks: ToolbarCallbacks) {
    this.ownerDocument = container.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView ?? activeWindow;
    this.el = container.createDiv('buttons');
    // eslint-disable-next-line obsidianmd/no-static-styles-assignment
    this.el.style.position = 'relative';
    this.filterBtn = this.makeBtn('filter', FILTER_ICON, '', () => callbacks.onFilterToggle());
    for (const v of views) {
      const icon = DEFAULT_VIEW_ICONS[v.id] ?? v.icon;
      const btn = this.makeBtn(v.id + 'View', icon, v.label, () => {
        if (this.currentView === v.id) {
          this.toggleStylePopup(btn);
        } else {
          callbacks.onViewSwitch(v.id);
        }
      });
      this.viewButtons.set(v.id, btn);
    }

    // Style picker popup (weekViewContext) — triggered by clicking active view button
    this.stylePopup = this.el.createEl('ul', { cls: 'weekViewContext', attr: { role: 'menu' } });
    for (let i = 1; i <= 11; i++) {
      const style = `style${i}`;
      const li = this.stylePopup.createEl('li', {
        attr: {
          'data-style': style,
          role: 'menuitemradio',
          tabindex: '-1',
          'aria-checked': 'false',
        },
      });
      const liIcon = li.createDiv({ cls: `liIcon iconStyle${i}` });
      for (let j = 0; j < 7; j++) liIcon.createDiv('box');
      li.createEl('span', { text: `Style ${i}` });
      li.addEventListener('click', () => {
        this.stylePopup.querySelectorAll('li').forEach((el) => el.classList.remove('active'));
        li.classList.add('active');
        callbacks.onStyleChange(style);
        this.closePopup(true);
      });
      this.bindKeyboardActivation(li);
    }
    this.currentBtn = this.makeBtn('current', '', '', () => callbacks.onToday());
    this.makeBtn('previous', ARROW_LEFT, '', () => callbacks.onPrev());
    this.makeBtn('next', ARROW_RIGHT, '', () => callbacks.onNext());
    this.overdueBtn = this.makeBtn('overdueHighlighter', '⚠️', 'Highlight overdue', () => {
      callbacks.onOverdueHighlight();
    });
    this.statBtn = this.makeBtn('statistic', '📊', '', () => this.toggleStatPopup());
    this.statBtn.setAttribute('percentage', '');
    this.statBtn.setAttribute('aria-haspopup', 'menu');
    this.statBtn.setAttribute('aria-expanded', 'false');

    // Statistics popup
    this.statPopup = this.el.createEl('ul', { cls: 'statisticPopup', attr: { role: 'menu' } });
    const statDefs: Array<[string, string, string]> = [
      ['done', '✅', 'Done'],
      ['due', '📅', 'Due'],
      ['start', '🛫', 'Start'],
      ['scheduled', '⏳', 'Scheduled'],
      ['recurrence', '🔁', 'Recurring'],
      ['dailyNote', '📄', 'Daily'],
    ];
    for (const [group, icon, label] of statDefs) {
      const li = this.statPopup.createEl('li', {
        attr: {
          'data-group': group,
          role: 'menuitemradio',
          tabindex: '-1',
          'aria-checked': 'false',
        },
      });
      li.createEl('span', { cls: 'stat-label', text: label });
      const countSpanEl = li.createEl('span', { cls: 'stat-count', text: '0' });
      const iconSpan = this.ownerDocument.createElement('span');
      iconSpan.textContent = icon + ' ';
      li.prepend(iconSpan);
      this.statEls[group] = countSpanEl;
      li.addEventListener('click', () => {
        const isActive = li.classList.contains('active');
        this.statPopup.querySelectorAll('li').forEach((el) => {
          el.classList.remove('active');
          el.setAttribute('aria-checked', 'false');
        });
        if (!isActive) {
          li.classList.add('active');
          li.setAttribute('aria-checked', 'true');
          callbacks.onStatFilter(group);
        } else {
          callbacks.onStatFilter(null);
        }
      });
      this.bindKeyboardActivation(li);
    }
  }

  private bindKeyboardActivation(item: HTMLElement): void {
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      item.click();
    });
  }

  private makeBtn(
    cls: string,
    icon: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = this.el.createEl('button', { cls });
    // eslint-disable-next-line no-unsanitized/property, @microsoft/sdl/no-inner-html
    if (icon) btn.innerHTML = icon;
    if (title) btn.title = title;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  private toggleStylePopup(btn: HTMLButtonElement): void {
    if (this.activePopup?.popup === this.stylePopup) {
      this.closePopup(true);
      return;
    }
    this.stylePopup.style.left = btn.offsetLeft + 'px';
    this.stylePopup.style.top = this.el.offsetHeight + 'px';
    this.openPopup(this.stylePopup, btn);
  }

  private toggleStatPopup(): void {
    if (this.activePopup?.popup === this.statPopup) {
      this.closePopup(true);
      return;
    }
    this.openPopup(this.statPopup, this.statBtn);
  }

  private openPopup(popup: HTMLElement, trigger: HTMLButtonElement): void {
    this.closePopup(false);
    popup.classList.add('active');
    if (popup === this.statPopup) trigger.classList.add('active');
    trigger.setAttribute('aria-expanded', 'true');
    let owned: NonNullable<Toolbar['activePopup']>;
    const onDocumentKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || this.activePopup !== owned) return;
      event.preventDefault();
      event.stopPropagation();
      this.closePopup(true);
    };
    const onDocumentMousedown = (event: MouseEvent): void => {
      if (
        this.activePopup !== owned ||
        popup.contains(event.target as Node) ||
        event.target === trigger
      ) {
        return;
      }
      this.closePopup(true);
    };
    owned = {
      popup,
      trigger,
      registrationTimer: this.ownerWindow.setTimeout(() => {
        if (this.activePopup !== owned) return;
        owned.listening = true;
        this.ownerDocument.addEventListener('mousedown', onDocumentMousedown, true);
        this.ownerDocument.addEventListener('keydown', onDocumentKeydown, true);
      }, 0),
      listening: false,
      onDocumentKeydown,
      onDocumentMousedown,
    };
    this.activePopup = owned;
    const selected = popup.querySelector<HTMLElement>('[aria-checked="true"]');
    const first = popup.querySelector<HTMLElement>(
      '[role^="menuitem"]:not([aria-disabled="true"])',
    );
    (selected ?? first)?.focus({ preventScroll: true });
  }

  private closePopup(restoreFocus: boolean): void {
    const owned = this.activePopup;
    if (!owned) return;
    this.activePopup = undefined;
    this.ownerWindow.clearTimeout(owned.registrationTimer);
    if (owned.listening) {
      this.ownerDocument.removeEventListener('mousedown', owned.onDocumentMousedown, true);
      this.ownerDocument.removeEventListener('keydown', owned.onDocumentKeydown, true);
    }
    owned.popup.classList.remove('active');
    if (owned.popup === this.statPopup) owned.trigger.classList.remove('active');
    owned.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && owned.trigger.isConnected) owned.trigger.focus({ preventScroll: true });
  }

  private updateViewButtons(currentView: string): void {
    for (const [id, btn] of this.viewButtons) {
      const isCurrent = id === currentView;
      btn.classList.toggle('active', isCurrent);
      if (isCurrent) {
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
      } else {
        btn.removeAttribute('aria-haspopup');
        btn.removeAttribute('aria-expanded');
      }
    }
  }

  update(state: ToolbarState): void {
    this.closePopup(true);
    this.currentView = state.currentView;
    this.currentBtn.textContent = state.currentTitle;
    this.filterBtn.classList.toggle('active', state.filterActive);
    this.overdueBtn.classList.toggle('active', state.overdueHighlightActive);
    this.updateViewButtons(state.currentView);
    // Sync active style in picker
    this.stylePopup.querySelectorAll('li').forEach((li) => {
      const selected = li.getAttribute('data-style') === state.currentStyle;
      li.classList.toggle('active', selected);
      li.setAttribute('aria-checked', String(selected));
    });
    if (this.statEls['done']) this.statEls['done'].textContent = String(state.stats.done);
    if (this.statEls['due']) this.statEls['due'].textContent = String(state.stats.due);
    if (this.statEls['start']) this.statEls['start'].textContent = String(state.stats.start);
    if (this.statEls['scheduled'])
      this.statEls['scheduled'].textContent = String(state.stats.scheduled);
    if (this.statEls['recurrence'])
      this.statEls['recurrence'].textContent = String(state.stats.recurrence);
    if (this.statEls['dailyNote'])
      this.statEls['dailyNote'].textContent = String(state.stats.dailyNote);

    // Reconcile active stat group highlight
    this.statPopup.querySelectorAll('li').forEach((li) => {
      li.classList.remove('active');
      li.setAttribute('aria-checked', 'false');
    });
    if (state.activeStatGroup !== null) {
      const activeLi = this.statPopup.querySelector(`li[data-group="${state.activeStatGroup}"]`);
      activeLi?.classList.add('active');
      activeLi?.setAttribute('aria-checked', 'true');
    }
  }

  destroy(): void {
    this.closePopup(false);
    this.el.remove();
  }
}
