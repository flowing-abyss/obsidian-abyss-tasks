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
  it('renders the toolbar exactly as the centre panel did', () => {
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
    const right = expectDefined(nav.querySelector('.abyss-cal-nav-right'));
    expect(expectDefined(right.querySelector('.abyss-cal-nav-today')).textContent).toBe('Today');
    expect(
      [...right.querySelectorAll('.abyss-cal-view-btn')].map((button) => button.textContent),
    ).toEqual(['Day', 'Week', 'Month']);
    expect(h.button('.abyss-cal-view-btn.is-active').textContent).toBe('Month');
  });

  it('marks the active view button for each view', () => {
    expect(harness('today').button('.abyss-cal-view-btn.is-active').textContent).toBe('Day');
    expect(harness('week').button('.abyss-cal-view-btn.is-active').textContent).toBe('Week');
  });

  it('writes the title for each view on updateTitle and leaves it empty before', () => {
    const h = harness('week', moment('2026-09-23'));
    expect(h.button('.abyss-cal-nav-month').textContent).toBe('');
    h.bar.updateTitle();
    expect(h.button('.abyss-cal-nav-month').textContent).toBe(
      `Week ${moment('2026-09-23').format('w')}`,
    );
    expect(h.button('.abyss-cal-nav-year').textContent).toBe('2026');
    const day = harness('today', moment('2026-09-23'));
    day.bar.updateTitle();
    expect(day.button('.abyss-cal-nav-month').textContent).toBe('September 23');
    const month = harness('month', moment('2026-09-23'));
    month.bar.updateTitle();
    expect(month.button('.abyss-cal-nav-month').textContent).toBe('September');
  });

  it('titles the week view with the locale week number, not the ISO week', () => {
    // 2027-01-01 is locale week 1 and ISO week 53; the toolbar must never read "Week 53".
    const h = harness('week', moment('2027-01-01'));
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
    expect(h.callbacks.onSelectView.mock.calls).toEqual([['today'], ['week'], ['month']]);
  });
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
