import { describe, expect, it } from 'vitest';
import {
  calendarCaptureHost,
  calendarCaptureInputClass,
  captureTargetForCalendarPlacement,
  isCalendarCapturePlacement,
} from '../src/panels/calendar/calendarCapturePlacement';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { minutesToPixels, timeStringToMinutes } from '../src/views/timegrid/layout';
import { freshContainer } from './helpers';

function timeGridRoot(): { root: HTMLElement; hourColumn: HTMLElement; allDay: HTMLElement } {
  const root = freshContainer();
  const day = root.createDiv({
    cls: 'abyss-tg-day-column',
    attr: { 'data-tg-date': '2026-09-23' },
  });
  const hourColumn = day.createDiv({ cls: 'abyss-tg-hour-column' });
  const allDay = root.createDiv({
    cls: 'abyss-tg-allday-cell',
    attr: { 'data-tg-date': '2026-09-23' },
  });
  return { root, hourColumn, allDay };
}

describe('isCalendarCapturePlacement', () => {
  it('recognises the three calendar placements and nothing else', () => {
    expect(isCalendarCapturePlacement({ type: 'calendar-timed' })).toBe(true);
    expect(isCalendarCapturePlacement({ type: 'calendar-all-day' })).toBe(true);
    expect(isCalendarCapturePlacement({ type: 'calendar-month' })).toBe(true);
    expect(isCalendarCapturePlacement({ type: 'list' })).toBe(false);
    expect(isCalendarCapturePlacement({ type: 'project' })).toBe(false);
  });
});

describe('calendarCaptureInputClass', () => {
  it('maps each calendar placement to its input class and others to undefined', () => {
    expect(calendarCaptureInputClass({ type: 'calendar-timed' })).toBe('abyss-tg-quick-add-input');
    expect(calendarCaptureInputClass({ type: 'calendar-all-day' })).toBe(
      'abyss-tg-allday-quick-add-input',
    );
    expect(calendarCaptureInputClass({ type: 'calendar-month' })).toBe('abyss-mg-quick-add-input');
    expect(calendarCaptureInputClass({ type: 'list' })).toBeUndefined();
  });
});

describe('calendarCaptureHost', () => {
  it('places a timed host inside the hour column at the time offset', () => {
    const { root, hourColumn } = timeGridRoot();
    const host = calendarCaptureHost(root, {
      type: 'calendar-timed',
      date: '2026-09-23',
      time: '09:30',
    });
    expect(host?.parentElement).toBe(hourColumn);
    expect(host?.classList.contains('abyss-tg-quick-add')).toBe(true);
    expect(host?.style.top).toBe(`${minutesToPixels(timeStringToMinutes('09:30'))}px`);
    expect(host?.dataset['abyssCaptureHost']).toBe('calendar-timed');
    expect(host?.dataset['abyssCaptureDate']).toBe('2026-09-23');
    expect(host?.dataset['abyssCaptureTime']).toBe('09:30');
  });

  it('reuses an existing wrapper instead of stacking a second one', () => {
    const { root } = timeGridRoot();
    const placement = { type: 'calendar-timed' as const, date: '2026-09-23', time: '09:30' };
    const first = calendarCaptureHost(root, placement);
    const second = calendarCaptureHost(root, placement);
    expect(second).toBe(first);
    expect(root.querySelectorAll('.abyss-tg-quick-add')).toHaveLength(1);
  });

  it('returns null when the date has no column', () => {
    const { root } = timeGridRoot();
    expect(
      calendarCaptureHost(root, { type: 'calendar-timed', date: '2026-09-24', time: '09:30' }),
    ).toBeNull();
  });

  it('places an all-day host inside the all-day cell', () => {
    const { root, allDay } = timeGridRoot();
    const host = calendarCaptureHost(root, { type: 'calendar-all-day', date: '2026-09-23' });
    expect(host?.parentElement).toBe(allDay);
    expect(host?.classList.contains('abyss-tg-allday-quick-add')).toBe(true);
    expect(host?.dataset['abyssCaptureHost']).toBe('calendar-all-day');
    expect(host?.dataset['abyssCaptureDate']).toBe('2026-09-23');
  });

  it('places a month host inside the month cell', () => {
    const root = freshContainer();
    const cell = root.createDiv({ cls: 'abyss-mg-cell', attr: { 'data-mg-date': '2026-09-23' } });
    const host = calendarCaptureHost(root, { type: 'calendar-month', date: '2026-09-23' });
    expect(host?.parentElement).toBe(cell);
    expect(host?.classList.contains('abyss-mg-quick-add')).toBe(true);
    expect(calendarCaptureHost(root, { type: 'calendar-month', date: '2026-09-30' })).toBeNull();
  });
});

describe('captureTargetForCalendarPlacement', () => {
  const base = {
    label: 'Inbox',
    initial: { title: 'draft' },
  } as unknown as CaptureTarget;

  it('labels a timed placement with date and time and seeds due and time', () => {
    const target = captureTargetForCalendarPlacement(base, {
      type: 'calendar-timed',
      date: '2026-09-23',
      time: '09:30',
    });
    expect(target.label).toBe('2026-09-23 · 09:30');
    expect(target.initial).toEqual({
      title: 'draft',
      due: { type: 'set', value: '2026-09-23' },
      time: { type: 'set', value: '09:30' },
    });
  });

  it('labels an all-day placement and seeds only the due date', () => {
    const target = captureTargetForCalendarPlacement(base, {
      type: 'calendar-month',
      date: '2026-09-23',
    });
    expect(target.label).toBe('2026-09-23 · all day');
    expect(target.initial).toEqual({ title: 'draft', due: { type: 'set', value: '2026-09-23' } });
    expect(target).not.toBe(base);
  });
});
