import { localDate, localTime } from '../../tasks';
import type { CaptureTarget } from '../../ui/taskCapture/CaptureTargetResolver';
import { minutesToPixels, timeStringToMinutes } from '../../views/timegrid/layout';

export type CalendarCapturePlacement =
  | { readonly type: 'calendar-timed'; readonly date: string; readonly time: string }
  | { readonly type: 'calendar-all-day'; readonly date: string }
  | { readonly type: 'calendar-month'; readonly date: string };

export function isCalendarCapturePlacement<T extends { readonly type: string }>(
  placement: T,
): placement is T & CalendarCapturePlacement {
  return placement.type.startsWith('calendar-');
}

export function calendarCaptureInputClass(placement: {
  readonly type: string;
}): string | undefined {
  if (placement.type === 'calendar-timed') return 'abyss-tg-quick-add-input';
  if (placement.type === 'calendar-all-day') return 'abyss-tg-allday-quick-add-input';
  if (placement.type === 'calendar-month') return 'abyss-mg-quick-add-input';
  return undefined;
}

/** Seeds the capture target with the clicked date (and time) and labels it for the surface. */
export function captureTargetForCalendarPlacement(
  target: CaptureTarget,
  placement: CalendarCapturePlacement,
): CaptureTarget {
  const label =
    placement.type === 'calendar-timed'
      ? `${placement.date} · ${placement.time}`
      : `${placement.date} · all day`;
  const initial = {
    ...target.initial,
    due: { type: 'set' as const, value: localDate(placement.date) },
    ...(placement.type === 'calendar-timed'
      ? { time: { type: 'set' as const, value: localTime(placement.time) } }
      : {}),
  };
  return { ...target, label, initial };
}

function captureWrapper(parent: HTMLElement, className: string): HTMLElement {
  const ownerWindow = parent.ownerDocument.defaultView;
  const current = [...parent.children].find(
    (candidate): candidate is HTMLElement =>
      ownerWindow != null &&
      candidate.instanceOf(ownerWindow.HTMLElement) &&
      candidate.classList.contains(className),
  );
  return current ?? parent.createDiv({ cls: className });
}

/**
 * The wrapper inside the mounted grid that hosts the capture surface, or null when the
 * cell is not rendered.
 */
export function calendarCaptureHost(
  root: HTMLElement,
  placement: CalendarCapturePlacement,
): HTMLElement | null {
  if (placement.type === 'calendar-timed') {
    const day = [...root.querySelectorAll<HTMLElement>('.abyss-tg-day-column')].find(
      (candidate) => candidate.dataset['tgDate'] === placement.date,
    );
    const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
    if (hourColumn == null) return null;
    const host = captureWrapper(hourColumn, 'abyss-tg-quick-add');
    host.style.top = `${minutesToPixels(timeStringToMinutes(placement.time))}px`;
    host.dataset['abyssCaptureHost'] = placement.type;
    host.dataset['abyssCaptureDate'] = placement.date;
    host.dataset['abyssCaptureTime'] = placement.time;
    return host;
  }

  const selector = placement.type === 'calendar-month' ? '.abyss-mg-cell' : '.abyss-tg-allday-cell';
  const dateKey = placement.type === 'calendar-month' ? 'mgDate' : 'tgDate';
  const cell = [...root.querySelectorAll<HTMLElement>(selector)].find(
    (candidate) => candidate.dataset[dateKey] === placement.date,
  );
  if (cell == null) return null;
  const wrapperClass =
    placement.type === 'calendar-month' ? 'abyss-mg-quick-add' : 'abyss-tg-allday-quick-add';
  const host = captureWrapper(cell, wrapperClass);
  host.dataset['abyssCaptureHost'] = placement.type;
  host.dataset['abyssCaptureDate'] = placement.date;
  return host;
}
