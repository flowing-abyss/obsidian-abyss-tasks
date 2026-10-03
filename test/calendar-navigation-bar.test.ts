import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moment } from '../src/obsidianMoment';
import {
  CalendarNavigationBar,
  type CalendarNavigationBarCallbacks,
} from '../src/panels/calendar/CalendarNavigationBar';
import type { CalViewType } from '../src/panels/calendar/calendarViewType';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { expectDefined, useRealMoment } from './helpers';

useRealMoment();

const bars: CalendarNavigationBar[] = [];

function harness(
  view: CalViewType = 'month',
  date = moment('2026-09-23'),
): {
  owner: HTMLElement;
  bar: CalendarNavigationBar;
  callbacks: { [K in keyof CalendarNavigationBarCallbacks]: ReturnType<typeof vi.fn> };
  button(selector: string): HTMLElement;
} {
  const owner = document.body.createDiv();
  const callbacks = {
    view: vi.fn(() => view),
    date: vi.fn(() => date),
    onStep: vi.fn(),
    onToday: vi.fn(),
    onSelectMonth: vi.fn(),
    onSelectYear: vi.fn(),
    onSelectView: vi.fn(),
  };
  const bar = new CalendarNavigationBar({
    owner,
    interactionOwnership: noInteractionOwnership,
    callbacks,
  });
  bar.mount(owner);
  bars.push(bar);
  return {
    owner,
    bar,
    callbacks,
    button: (selector) => expectDefined(owner.querySelector<HTMLElement>(selector)),
  };
}

afterEach(() => {
  for (const bar of bars.splice(0)) bar.destroy();
  document.body.empty();
});

describe('CalendarNavigationBar DOM', () => {
  it('renders the toolbar', () => {
    const h = harness();
    const nav = h.button('.abyss-cal-nav');
    expect(nav.parentElement).toBe(h.owner);
    const left = expectDefined(nav.querySelector('.abyss-cal-nav-left'));
    expect([...left.children].map((child) => child.className)).toEqual([
      'abyss-cal-nav-btn',
      'abyss-cal-nav-title-group',
      'abyss-cal-nav-btn',
    ]);
    const monthButton = h.button('.abyss-cal-nav-month');
    expect(monthButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(monthButton.getAttribute('aria-expanded')).toBe('false');
    expect(h.button('.abyss-cal-nav-year').getAttribute('aria-haspopup')).toBe('dialog');
    expect(h.button(':scope > .abyss-cal-nav > .abyss-cal-nav-today').textContent).toBe('Today');
    expect(
      [...nav.querySelectorAll(':scope > .abyss-cal-view-switcher > .abyss-cal-view-btn')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['Day', 'Week', 'Month']);
    expect(h.button('.abyss-cal-view-btn.is-active').textContent).toBe('Month');
  });

  // Obsidian flips the phone flag and its body class while the app runs, so the toolbar is one
  // DOM everywhere and CSS lays it out.
  it.each([false, true])('builds the same flat toolbar when the phone flag is %s', (phone) => {
    Platform.isPhone = phone;
    document.body.toggleClass('is-phone', phone);
    try {
      const nav = harness().button('.abyss-cal-nav');

      expect([...nav.children].map((child) => child.className)).toEqual([
        'abyss-cal-nav-left',
        'abyss-cal-nav-today',
        'abyss-cal-view-switcher',
      ]);
      expect(nav.querySelector('.abyss-cal-nav-right')).toBeNull();
    } finally {
      Platform.isPhone = false;
      document.body.removeClass('is-phone');
    }
  });

  it('marks the active view button for each view', () => {
    expect(harness('today').button('.abyss-cal-view-btn.is-active').textContent).toBe('Day');
    expect(harness('week').button('.abyss-cal-view-btn.is-active').textContent).toBe('Week');
  });

  it('leaves the title empty until updateTitle writes the primary and the year', () => {
    // 2027-01-01 is locale week 1 and ISO week 53; the toolbar must never read "Week 53".
    const h = harness('week', moment('2027-01-01'));
    expect(h.button('.abyss-cal-nav-month').textContent).toBe('');
    h.bar.updateTitle();
    expect(h.button('.abyss-cal-nav-month').textContent).toBe('Week 1');
    expect(h.button('.abyss-cal-nav-year').textContent).toBe('2027');
  });
});

describe('CalendarNavigationBar callbacks', () => {
  it('routes prev, next, today, and the view switcher', () => {
    const h = harness();
    h.button('.abyss-cal-nav-btn[aria-label="Previous"]').click();
    h.button('.abyss-cal-nav-btn[aria-label="Next"]').click();
    expect(h.callbacks.onStep.mock.calls).toEqual([[-1], [1]]);
    h.button('.abyss-cal-nav-today').click();
    expect(h.callbacks.onToday).toHaveBeenCalledOnce();
    [...h.owner.querySelectorAll<HTMLElement>('.abyss-cal-view-btn')].forEach((button) => {
      button.click();
    });
    const buttons = [...h.owner.querySelectorAll<HTMLButtonElement>('.abyss-cal-view-btn')];
    expect(h.callbacks.onSelectView).toHaveBeenNthCalledWith(1, 'today', buttons[0]);
    expect(h.callbacks.onSelectView).toHaveBeenNthCalledWith(2, 'week', buttons[1]);
    expect(h.callbacks.onSelectView).toHaveBeenNthCalledWith(3, 'month', buttons[2]);
  });
});

describe('CalendarNavigationBar focus visibility', () => {
  function geometry(nav: HTMLElement, control: HTMLElement, left: number, right: number): void {
    Object.defineProperties(nav, {
      clientLeft: { configurable: true, value: 2 },
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 320 },
    });
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 20, 204, 40));
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(left, 24, right - left, 32),
    );
  }

  it.each([
    { edge: 'right', left: 280, right: 340, start: 0, width: 200, extent: 320, want: 38 },
    { edge: 'left', left: 80, right: 120, start: 100, width: 200, extent: 320, want: 78 },
    { edge: 'visible', left: 140, right: 180, start: 40, width: 200, extent: 320, want: 40 },
    { edge: 'no overflow', left: 280, right: 340, start: 0, width: 200, extent: 200, want: 0 },
    { edge: 'zero width', left: 280, right: 340, start: 0, width: 0, extent: 320, want: 0 },
  ])(
    'reveals $edge focus only within the toolbar strip',
    ({ left, right, start, width, extent, want }) => {
      const h = harness();
      const nav = h.button('.abyss-cal-nav');
      const control = h.button('.abyss-cal-view-btn:last-child');
      geometry(nav, control, left, right);
      Object.defineProperties(nav, {
        clientWidth: { value: width },
        scrollWidth: { value: extent },
      });
      nav.scrollLeft = start;
      nav.scrollTop = 13;
      h.owner.scrollLeft = 17;
      h.owner.scrollTop = 29;

      control.focus({ preventScroll: true });

      expect(document.activeElement).toBe(control);
      expect(nav.scrollLeft).toBe(want);
      expect(nav.scrollTop).toBe(13);
      expect(h.owner.scrollLeft).toBe(17);
      expect(h.owner.scrollTop).toBe(29);
    },
  );

  it('reveals the restored view button while focusView protects ancestor scroll', () => {
    const h = harness();
    const nav = h.button('.abyss-cal-nav');
    const month = h.button('.abyss-cal-view-btn:last-child');
    geometry(nav, month, 280, 340);
    h.owner.scrollTop = 29;

    expect(h.bar.focusView('month')).toBe(true);

    expect(document.activeElement).toBe(month);
    expect(nav.scrollLeft).toBe(38);
    expect(h.owner.scrollTop).toBe(29);
  });

  it.each(['month', 'year'])(
    'keeps %s picker focus outside the strip and reveals its returning anchor',
    (kind) => {
      const h = harness();
      const nav = h.button('.abyss-cal-nav');
      const anchor = h.button(`.abyss-cal-nav-${kind}`);
      geometry(nav, anchor, 80, 120);
      nav.scrollLeft = 100;

      anchor.click();

      const option = h.button(`.abyss-${kind}-picker-btn.is-active`);
      expect(document.activeElement).toBe(option);
      expect(nav.contains(option)).toBe(false);
      expect(nav.scrollLeft).toBe(100);
      vi.spyOn(option, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 24, 40, 32));
      option.blur();
      option.focus({ preventScroll: true });
      expect(nav.scrollLeft).toBe(100);

      h.bar.closePicker(true);

      expect(document.activeElement).toBe(anchor);
      expect(nav.scrollLeft).toBe(78);
    },
  );
});

describe('CalendarNavigationBar pickers', () => {
  it('opens the month picker with the current month active and reports a selection', () => {
    const h = harness('month', moment('2026-09-23'));
    const anchor = h.button('.abyss-cal-nav-month');
    anchor.click();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    const picker = h.button('.abyss-month-picker');
    expect(picker.parentElement).toBe(h.owner);
    expect(picker.getAttribute('role')).toBe('dialog');
    expect(picker.getAttribute('aria-label')).toBe('Select month');
    const options = [...picker.querySelectorAll<HTMLElement>('.abyss-month-picker-btn')];
    expect(options.map((option) => option.textContent)).toEqual([
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
    ]);
    const active = expectDefined(options.find((option) => option.classList.contains('is-active')));
    expect(active.textContent).toBe('Sep');
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(options[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(active);
    expectDefined(options[2]).click();
    expect(h.callbacks.onSelectMonth).toHaveBeenCalledWith(2);
    expect(h.owner.querySelector('.abyss-month-picker')).not.toBeNull();
  });

  it('opens the year picker with five years either side and reports a selection', () => {
    const h = harness('month', moment('2026-09-23'));
    h.button('.abyss-cal-nav-year').click();
    const options = [...h.owner.querySelectorAll<HTMLElement>('.abyss-year-picker-btn')];
    expect(options.map((option) => option.textContent)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(2021 + index)),
    );
    const active = expectDefined(options.find((option) => option.classList.contains('is-active')));
    expect(active.textContent).toBe('2026');
    expect(document.activeElement).toBe(active);
    expectDefined(options[10]).click();
    expect(h.callbacks.onSelectYear).toHaveBeenCalledWith(2031);
  });

  it('toggles a picker closed, swaps pickers, and restores the anchor on closePicker(true)', () => {
    const h = harness();
    const month = h.button('.abyss-cal-nav-month');
    const year = h.button('.abyss-cal-nav-year');
    month.click();
    month.click();
    expect(h.owner.querySelector('.abyss-month-picker')).toBeNull();
    expect(month.getAttribute('aria-expanded')).toBe('false');
    month.click();
    year.click();
    expect(h.owner.querySelector('.abyss-month-picker')).toBeNull();
    expect(h.owner.querySelector('.abyss-year-picker')).not.toBeNull();
    expect(month.getAttribute('aria-expanded')).toBe('false');
    expect(year.getAttribute('aria-expanded')).toBe('true');
    h.bar.closePicker(true);
    expect(h.owner.querySelector('.abyss-year-picker')).toBeNull();
    expect(year.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(year);
  });

  it('closes an open picker on destroy without moving focus', () => {
    const h = harness();
    const month = h.button('.abyss-cal-nav-month');
    month.click();
    h.bar.destroy();
    expect(h.owner.querySelector('.abyss-month-picker')).toBeNull();
    expect(month.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).not.toBe(month);
  });
});
