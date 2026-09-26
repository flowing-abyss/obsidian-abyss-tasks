import { setIcon } from 'obsidian';
import { openAnchoredPopover, type AnchoredPopover } from '../../ui/anchoredPopover';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { calendarTitle, type CalendarMoment } from './calendarDateNavigation';
import type { CalViewType } from './calendarViewType';

export interface CalendarNavigationBarCallbacks {
  readonly view: () => CalViewType;
  readonly date: () => CalendarMoment;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onToday: () => void;
  /** Months are zero-based, as Moment numbers them. */
  readonly onSelectMonth: (month: number) => void;
  readonly onSelectYear: (year: number) => void;
  readonly onSelectView: (view: CalViewType) => void;
}

export interface CalendarNavigationBarOptions {
  /** The element that positions the pickers and bounds them. */
  readonly owner: HTMLElement;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly callbacks: CalendarNavigationBarCallbacks;
}

interface CalendarNavigationElements {
  readonly monthButton: HTMLButtonElement;
  readonly yearButton: HTMLButtonElement;
}

const VIEW_LABELS: Record<CalViewType, string> = { today: 'Day', week: 'Week', month: 'Month' };
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The calendar toolbar: previous, title (month and year pickers), next, Today, view switcher. */
export class CalendarNavigationBar {
  private elements_abyssPrivate: CalendarNavigationElements | null = null;
  private picker_abyssPrivate: AnchoredPopover | null = null;

  constructor(private readonly options_abyssPrivate: CalendarNavigationBarOptions) {}

  mount(parent: HTMLElement): void {
    const { callbacks } = this.options_abyssPrivate;
    const nav = parent.createDiv({ cls: 'abyss-cal-nav' });
    const left = nav.createDiv({ cls: 'abyss-cal-nav-left' });
    const prevButton = left.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Previous' },
    });
    setIcon(prevButton, 'chevron-left');
    const title = left.createDiv({ cls: 'abyss-cal-nav-title-group' });
    const monthButton = title.createEl('button', {
      cls: 'abyss-cal-nav-month',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const yearButton = title.createEl('button', {
      cls: 'abyss-cal-nav-year',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const nextButton = left.createEl('button', {
      cls: 'abyss-cal-nav-btn',
      attr: { 'aria-label': 'Next' },
    });
    setIcon(nextButton, 'chevron-right');
    const todayButton = nav.createEl('button', { cls: 'abyss-cal-nav-today', text: 'Today' });
    this.renderViewSwitcher_abyssPrivate(nav);
    this.elements_abyssPrivate = { monthButton, yearButton };

    monthButton.addEventListener('click', () => {
      this.toggleMonthPicker_abyssPrivate(monthButton);
    });
    yearButton.addEventListener('click', () => {
      this.toggleYearPicker_abyssPrivate(yearButton);
    });
    prevButton.addEventListener('click', () => {
      callbacks.onStep(-1);
    });
    nextButton.addEventListener('click', () => {
      callbacks.onStep(1);
    });
    todayButton.addEventListener('click', () => {
      callbacks.onToday();
    });
  }

  updateTitle(): void {
    const elements = this.elements_abyssPrivate;
    if (elements === null) return;
    const { callbacks } = this.options_abyssPrivate;
    const title = calendarTitle(callbacks.view(), callbacks.date());
    elements.monthButton.textContent = title.primary;
    elements.yearButton.textContent = title.year;
  }

  closePicker(restoreFocus = false): void {
    this.picker_abyssPrivate?.close(restoreFocus);
  }

  destroy(): void {
    this.closePicker();
    this.elements_abyssPrivate = null;
  }

  private renderViewSwitcher_abyssPrivate(host: HTMLElement): void {
    const { callbacks } = this.options_abyssPrivate;
    const switcher = host.createDiv({ cls: 'abyss-cal-view-switcher' });
    for (const view of ['today', 'week', 'month'] as const) {
      const button = switcher.createEl('button', {
        cls: `abyss-cal-view-btn${callbacks.view() === view ? ' is-active' : ''}`,
        text: VIEW_LABELS[view],
      });
      button.addEventListener('click', () => {
        callbacks.onSelectView(view);
      });
    }
  }

  /**
   * The month and year pickers float from the center pane like every other anchored list, so the
   * toolbar's scroll strip never clips them. The shared surface owns placement, outside and Escape
   * dismissal and shortcut ownership; the picker only keeps its anchor's expanded state in step.
   */
  private openPicker_abyssPrivate(
    anchor: HTMLElement,
    cls: 'abyss-month-picker' | 'abyss-year-picker',
    label: string,
  ): AnchoredPopover {
    const { owner, interactionOwnership } = this.options_abyssPrivate;
    const popover = openAnchoredPopover({
      owner,
      anchor,
      boundary: owner,
      preferred: 'below-start',
      cls,
      attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': label },
      ownership: interactionOwnership,
      onClose: (restoreFocus) => {
        anchor.setAttribute('aria-expanded', 'false');
        if (this.picker_abyssPrivate === popover) this.picker_abyssPrivate = null;
        if (restoreFocus && anchor.isConnected) anchor.focus();
      },
    });
    this.picker_abyssPrivate = popover;
    anchor.setAttribute('aria-expanded', 'true');
    return popover;
  }

  private seatPicker_abyssPrivate(popover: AnchoredPopover): void {
    popover.reposition();
    const selectedOption = popover.element.querySelector<HTMLElement>('button.is-active');
    const firstOption = popover.element.querySelector<HTMLElement>('button:not(:disabled)');
    (selectedOption ?? firstOption)?.focus({ preventScroll: true });
  }

  private toggleMonthPicker_abyssPrivate(anchor: HTMLElement): void {
    if (this.picker_abyssPrivate?.element.hasClass('abyss-month-picker') === true) {
      this.closePicker();
      return;
    }
    this.closePicker();
    const popover = this.openPicker_abyssPrivate(anchor, 'abyss-month-picker', 'Select month');
    const picker = popover.element;
    const { callbacks } = this.options_abyssPrivate;
    const currentMonth = callbacks.date().month();
    MONTH_NAMES.forEach((name, month) => {
      const selected = month === currentMonth;
      const button = picker.createEl('button', {
        cls: 'abyss-month-picker-btn',
        text: name,
        attr: { 'aria-pressed': String(selected) },
      });
      if (selected) button.addClass('is-active');
      button.addEventListener('click', () => {
        callbacks.onSelectMonth(month);
      });
    });
    this.seatPicker_abyssPrivate(popover);
  }

  private toggleYearPicker_abyssPrivate(anchor: HTMLElement): void {
    if (this.picker_abyssPrivate?.element.hasClass('abyss-year-picker') === true) {
      this.closePicker();
      return;
    }
    this.closePicker();
    const popover = this.openPicker_abyssPrivate(anchor, 'abyss-year-picker', 'Select year');
    const picker = popover.element;
    const { callbacks } = this.options_abyssPrivate;
    const currentYear = callbacks.date().year();
    for (let year = currentYear - 5; year <= currentYear + 5; year++) {
      this.renderYearOption_abyssPrivate(picker, year, currentYear);
    }
    this.seatPicker_abyssPrivate(popover);
  }

  private renderYearOption_abyssPrivate(
    picker: HTMLElement,
    year: number,
    currentYear: number,
  ): void {
    const selected = year === currentYear;
    const button = picker.createEl('button', {
      cls: 'abyss-year-picker-btn',
      text: String(year),
      attr: { 'aria-pressed': String(selected) },
    });
    if (selected) button.addClass('is-active');
    button.addEventListener('click', () => {
      this.options_abyssPrivate.callbacks.onSelectYear(year);
    });
  }
}
