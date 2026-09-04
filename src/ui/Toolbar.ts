import { setIcon } from 'obsidian';

const DEFAULT_VIEW_ICONS: Record<string, string> = {
  month: 'lucide:calendar-days',
  week: 'lucide:calendar-range',
  list: 'lucide:list',
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
  private readonly el: HTMLElement;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window;
  private readonly currentBtn: HTMLButtonElement;
  private readonly viewButtons = new Map<string, HTMLButtonElement>();
  private readonly filterBtn: HTMLButtonElement;
  private readonly overdueBtn: HTMLButtonElement;
  private readonly statBtn: HTMLButtonElement;
  private readonly statPopup: HTMLElement;
  private readonly statEls: Record<string, HTMLElement> = {};
  private readonly stylePopup: HTMLElement;
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
    this.el.setCssStyles({ position: 'relative' });
    this.filterBtn = this.makeBtn('filter', 'lucide:filter', '', () => {
      callbacks.onFilterToggle();
    });
    for (const v of views) {
      const icon = DEFAULT_VIEW_ICONS[v.id] ?? v.icon;
      const btn = this.makeBtn(`${v.id}View`, icon, v.label, () => {
        if (this.currentView === v.id) {
          this.toggleStylePopup(btn);
        } else {
          callbacks.onViewSwitch(v.id);
        }
      });
      this.viewButtons.set(v.id, btn);
    }

    this.stylePopup = this.createStylePopup(callbacks);
    this.currentBtn = this.makeBtn('current', '', '', () => {
      callbacks.onToday();
    });
    this.makeBtn('previous', 'lucide:arrow-left', '', () => {
      callbacks.onPrev();
    });
    this.makeBtn('next', 'lucide:arrow-right', '', () => {
      callbacks.onNext();
    });
    this.overdueBtn = this.makeBtn('overdueHighlighter', '⚠️', 'Highlight overdue', () => {
      callbacks.onOverdueHighlight();
    });
    this.statBtn = this.makeBtn('statistic', '📊', '', () => {
      this.toggleStatPopup();
    });
    this.statBtn.setAttribute('percentage', '');
    this.statBtn.setAttribute('aria-haspopup', 'menu');
    this.statBtn.setAttribute('aria-expanded', 'false');
    this.statPopup = this.createStatPopup(callbacks);
  }

  private createStylePopup(callbacks: ToolbarCallbacks): HTMLElement {
    const popup = this.el.createEl('ul', { cls: 'weekViewContext', attr: { role: 'menu' } });
    for (let i = 1; i <= 11; i++) {
      const style = `style${i}`;
      const li = popup.createEl('li', {
        attr: {
          'data-style': style,
          role: 'menuitemradio',
          tabindex: '-1',
          'aria-checked': 'false',
        },
      });
      const liIcon = li.createDiv({ cls: `liIcon iconStyle${i}` });
      for (let j = 0; j < 7; j++) liIcon.createDiv('box');
      li.createSpan({ text: `Style ${i}` });
      li.addEventListener('click', () => {
        popup.querySelectorAll('li').forEach((el) => {
          el.classList.remove('active');
        });
        li.classList.add('active');
        callbacks.onStyleChange(style);
        this.closePopup(true);
      });
      this.bindKeyboardActivation(li);
    }
    return popup;
  }

  private createStatPopup(callbacks: ToolbarCallbacks): HTMLElement {
    const popup = this.el.createEl('ul', { cls: 'statisticPopup', attr: { role: 'menu' } });
    const statDefs: Array<[string, string, string]> = [
      ['done', '✅', 'Done'],
      ['due', '📅', 'Due'],
      ['start', '🛫', 'Start'],
      ['scheduled', '⏳', 'Scheduled'],
      ['recurrence', '🔁', 'Recurring'],
      ['dailyNote', '📄', 'Daily'],
    ];
    for (const [group, icon, label] of statDefs) {
      const li = popup.createEl('li', {
        attr: {
          'data-group': group,
          role: 'menuitemradio',
          tabindex: '-1',
          'aria-checked': 'false',
        },
      });
      li.createSpan({ cls: 'stat-label', text: label });
      const countSpanEl = li.createSpan({ cls: 'stat-count', text: '0' });
      const iconSpan = li.createSpan({ text: `${icon} ` });
      li.prepend(iconSpan);
      this.statEls[group] = countSpanEl;
      li.addEventListener('click', () => {
        const isActive = li.classList.contains('active');
        popup.querySelectorAll('li').forEach((el) => {
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
    return popup;
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
    if (icon.startsWith('lucide:')) setIcon(btn, icon.slice('lucide:'.length));
    else if (icon.length > 0) btn.createSpan({ text: icon });
    if (title.length > 0) btn.title = title;
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
    this.stylePopup.style.left = `${btn.offsetLeft}px`;
    this.stylePopup.style.top = `${this.el.offsetHeight}px`;
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
    const owned: NonNullable<Toolbar['activePopup']> = {
      popup,
      trigger,
      registrationTimer: 0,
      listening: false,
      onDocumentKeydown: (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || this.activePopup !== owned) return;
        event.preventDefault();
        event.stopPropagation();
        this.closePopup(true);
      },
      onDocumentMousedown: (event: MouseEvent): void => {
        if (
          this.activePopup !== owned ||
          popup.contains(event.target as Node) ||
          trigger.contains(event.target as Node)
        ) {
          return;
        }
        this.closePopup(true);
      },
    };
    owned.registrationTimer = this.ownerWindow.setTimeout(() => {
      if (this.activePopup !== owned) return;
      owned.listening = true;
      this.ownerDocument.addEventListener('mousedown', owned.onDocumentMousedown, true);
      this.ownerDocument.addEventListener('keydown', owned.onDocumentKeydown, true);
    }, 0);
    this.activePopup = owned;
    const selected = popup.querySelector<HTMLElement>('[aria-checked="true"]');
    const first = popup.querySelector<HTMLElement>(
      '[role^="menuitem"]:not([aria-disabled="true"])',
    );
    (selected ?? first)?.focus({ preventScroll: true });
  }

  private closePopup(restoreFocus: boolean): void {
    const owned = this.activePopup;
    if (owned == null) return;
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
    if (this.statEls['done'] != null) this.statEls['done'].textContent = String(state.stats.done);
    if (this.statEls['due'] != null) this.statEls['due'].textContent = String(state.stats.due);
    if (this.statEls['start'] != null)
      this.statEls['start'].textContent = String(state.stats.start);
    if (this.statEls['scheduled'] != null)
      this.statEls['scheduled'].textContent = String(state.stats.scheduled);
    if (this.statEls['recurrence'] != null)
      this.statEls['recurrence'].textContent = String(state.stats.recurrence);
    if (this.statEls['dailyNote'] != null)
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
