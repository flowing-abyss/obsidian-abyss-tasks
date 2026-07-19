import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { fixedToday, freshContainer, resolvedConfig, task, useRealMoment } from './helpers';

useRealMoment();
const fakeApp = {} as App;
const registry = new StatusRegistry(buildDefaultTaskStatuses());

function callbacks() {
  return {
    app: fakeApp,
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onDropTime: vi.fn(),
    onCreateAtTime: vi.fn(),
    onDayHeaderClick: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onStartChange: vi.fn(),
    onDueChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    statusRegistry: registry,
  };
}

describe('WeekTimeGridView', () => {
  it('threads relative keyboard intents from timed blocks', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    const t = task({ planning: { due: '2026-07-08', time: '10:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));

    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    expect(cbs.onKeyboardIntent).toHaveBeenCalledWith(t, {
      type: 'shift-schedule',
      days: -1,
    });
  });

  it('renders 7 day columns for the week containing startPosition', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    // 2026-07-06 is a Monday; ISO week 28 of 2026
    view.render(container, [], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    expect(container.querySelectorAll('.tc-tg-day-column')).toHaveLength(7);
  });

  it('threads onDropTime through to each day column, firing on drop', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    const hourColumnEl = container.querySelectorAll('.tc-tg-hour-column')[0] as HTMLElement;
    const dt = { getData: () => 'f.md:::0' } as unknown as DataTransfer;
    const ev = new MouseEvent('drop', { bubbles: true, clientY: 148 });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    hourColumnEl.dispatchEvent(ev);
    expect(cbs.onDropTime).toHaveBeenCalledWith('f.md:::0', expect.any(String), expect.any(String));
  });

  it("threads onDayHeaderClick through to each header cell, firing with that column's date", () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    const headerCells = Array.from(container.querySelectorAll('.tc-tg-header-cell'));
    expect(headerCells).toHaveLength(7);
    const dates = Array.from(container.querySelectorAll('.tc-tg-day-column')).map((el) =>
      el.getAttribute('data-tg-date'),
    );
    (headerCells[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayHeaderClick).toHaveBeenCalledWith(dates[2]);
  });

  it('places a timed task in the correct day column within the week', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    const t = task({ planning: { due: '2026-07-08', time: '10:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    expect(container.querySelectorAll('.tc-tg-block')).toHaveLength(1);
  });

  it('a span crossing multiple days in the week renders continuations before one due-date terminal', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    const t = task({ planning: { start: '2026-07-07', due: '2026-07-09' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    expect(container.querySelectorAll('.tc-tg-span')).toHaveLength(1);
    expect(container.querySelectorAll('.tc-tg-span-continuation')).toHaveLength(2);
  });

  it('destroy() does not throw', () => {
    const view = new WeekTimeGridView(callbacks());
    expect(() => view.destroy()).not.toThrow();
  });

  it('periodically repositions the now-line while the mounted week includes today, and clears the interval on destroy', () => {
    vi.useFakeTimers();
    try {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      // Task 42b: mirrors CenterPanel.startPositionFor's own fix — 'YYYY-ww' always
      // round-trips to a Sunday anchor, so the source date must be shifted back by
      // firstDayOfWeek days before formatting for the reconstructed week to actually
      // contain it (this test uses firstDayOfWeek: 1 below).
      const todayWeek = window.moment().subtract(1, 'days').format('YYYY-ww');
      view.render(container, [], resolvedConfig({ startPosition: todayWeek, firstDayOfWeek: 1 }));

      const nowLineEl = container.querySelector('.tc-tg-now-line') as HTMLElement;
      expect(nowLineEl).not.toBeNull();
      const initialTop = nowLineEl.style.top;

      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(nowLineEl.style.top).not.toBe(initialTop);

      view.destroy();
      expect(clearIntervalSpy).toHaveBeenCalled();

      const topAfterDestroy = nowLineEl.style.top;
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(nowLineEl.style.top).toBe(topAfterDestroy);

      clearIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-rendering without an intervening destroy() clears the previous interval instead of stacking a second one', () => {
    vi.useFakeTimers();
    try {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      // Task 42b: mirrors CenterPanel.startPositionFor's own fix — 'YYYY-ww' always
      // round-trips to a Sunday anchor, so the source date must be shifted back by
      // firstDayOfWeek days before formatting for the reconstructed week to actually
      // contain it (this test uses firstDayOfWeek: 1 below).
      const todayWeek = window.moment().subtract(1, 'days').format('YYYY-ww');

      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(container, [], resolvedConfig({ startPosition: todayWeek, firstDayOfWeek: 1 }));
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      view.render(container, [], resolvedConfig({ startPosition: todayWeek, firstDayOfWeek: 1 }));
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);

      view.destroy();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a timed block title via renderTaskText (markdown-link-aware) for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-08', time: '10:00' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.querySelector('.tc-md')).not.toBeNull();
  });

  it('clicking the status marker on a timed block fires onToggle, not onTaskClick (threaded through WeekTimeGridView)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    const t = task({ planning: { due: '2026-07-08', time: '10:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    const marker = container.querySelector('.tc-tg-block .tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('auto-scrolls the grid row to center the now-line when the rendered week contains today', () => {
    vi.useFakeTimers();
    // 2026-06-15 is a Monday within ISO week 25 of 2026, at 14:30
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-25', firstDayOfWeek: 1 }));
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    expect(gridRowEl.scrollTop).toBe(0);
    // Use runOnlyPendingTimers, not runAllTimers: render() now also registers a repeating
    // now-line-refresh interval, and runAllTimers would loop on it forever.
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('does not auto-scroll when today is not in the rendered week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    // 2026-28 is a different week than the current system time's week
    view.render(container, [], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runAllTimers();
    expect(gridRowEl.scrollTop).toBe(0);
    vi.useRealTimers();
  });

  it('does not auto-scroll when shouldScrollToNow=false (Task 27: CenterPanel-driven dedup for reactive re-renders)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(
      container,
      [],
      resolvedConfig({ startPosition: '2026-25', firstDayOfWeek: 1 }),
      false,
    );
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(0);
    vi.useRealTimers();
  });

  it('shouldScrollToNow=false still registers the periodic now-line-repositioning interval (Round 2 Task 16 unaffected)', () => {
    vi.useFakeTimers();
    try {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      // Task 42b: mirrors CenterPanel.startPositionFor's own fix — 'YYYY-ww' always
      // round-trips to a Sunday anchor, so the source date must be shifted back by
      // firstDayOfWeek days before formatting for the reconstructed week to actually
      // contain it (this test uses firstDayOfWeek: 1 below).
      const todayWeek = window.moment().subtract(1, 'days').format('YYYY-ww');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(
        container,
        [],
        resolvedConfig({ startPosition: todayWeek, firstDayOfWeek: 1 }),
        false,
      );
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      const nowLineEl = container.querySelector('.tc-tg-now-line') as HTMLElement;
      expect(nowLineEl).not.toBeNull();
      const initialTop = nowLineEl.style.top;
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(nowLineEl.style.top).not.toBe(initialTop);

      view.destroy();
      setIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults shouldScrollToNow to true when the 4th param is omitted (preserves prior call-site behavior)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-25', firstDayOfWeek: 1 }));
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('Task 31: restores preservedScrollTop onto the fresh grid-row when shouldScrollToNow=false', () => {
    vi.useFakeTimers();
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(
      container,
      [],
      resolvedConfig({ startPosition: '2026-25', firstDayOfWeek: 1 }),
      false,
      321,
    );
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    expect(gridRowEl.scrollTop).toBe(0);
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(321);
    vi.useRealTimers();
  });

  it('Task 31: ignores preservedScrollTop when shouldScrollToNow=true (fresh navigation takes priority)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(
      container,
      [],
      resolvedConfig({ startPosition: '2026-25', firstDayOfWeek: 1 }),
      true,
      321,
    );
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runOnlyPendingTimers();
    // Scrolls to center-on-now (496), not the stale preservedScrollTop (321).
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('Task 31: restores preservedScrollTop even when today is not in the rendered week', () => {
    vi.useFakeTimers();
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(
      container,
      [],
      resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }),
      false,
      55,
    );
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(55);
    vi.useRealTimers();
  });

  // Task 42b: the rendered week must contain "today" no matter which real weekday today
  // is. The bug only ever showed up on a Sunday-today + Monday-first config, so this
  // loops over all 7 weekdays for "today" (using fixedToday at describe scope, not
  // inside the test body, so vi.setSystemTime actually takes effect) for both
  // firstDayOfWeek settings this codebase supports (0=Sunday, 1=Monday).
  describe('the rendered week always contains "today", for every weekday and firstDayOfWeek', () => {
    // 2026-07-06..12 is a real Mon..Sun span.
    const weekdays: Array<{ date: string; label: string }> = [
      { date: '2026-07-06', label: 'Monday' },
      { date: '2026-07-07', label: 'Tuesday' },
      { date: '2026-07-08', label: 'Wednesday' },
      { date: '2026-07-09', label: 'Thursday' },
      { date: '2026-07-10', label: 'Friday' },
      { date: '2026-07-11', label: 'Saturday' },
      { date: '2026-07-12', label: 'Sunday' },
    ];

    for (const { date, label } of weekdays) {
      describe(`today is ${label} (${date})`, () => {
        fixedToday(date);

        for (const firstDayOfWeek of [0, 1] as const) {
          it(`contains today exactly once, spans 7 consecutive days, and starts on the configured firstDayOfWeek=${firstDayOfWeek}`, () => {
            const container = freshContainer();
            const view = new WeekTimeGridView(callbacks());
            // No startPosition: exercises the `window.moment().startOf('week')` branch,
            // which is the one that broke (config.startPosition undefined, "today" used
            // directly as the anchor).
            view.render(container, [], resolvedConfig({ firstDayOfWeek }));

            const dates = Array.from(container.querySelectorAll('.tc-tg-day-column')).map(
              (el) => el.getAttribute('data-tg-date') as string,
            );

            expect(dates).toHaveLength(7);
            expect(dates.filter((d) => d === date)).toHaveLength(1);

            for (let i = 1; i < dates.length; i++) {
              expect(window.moment(dates[i]).diff(window.moment(dates[i - 1]), 'days')).toBe(1);
            }

            expect(parseInt(window.moment(dates[0]).format('d'), 10)).toBe(firstDayOfWeek);
          });
        }
      });
    }
  });

  // Task 42b: this is the path CenterPanel actually drives in production — it always
  // supplies `startPosition` (never leaves it undefined), computed as
  // `calDate.clone().subtract(firstDayOfWeek, 'days').format('YYYY-ww')` (see
  // CenterPanel.startPositionFor's own comment for why the subtraction is required). This
  // loop reproduces that exact call for every weekday "today" could be, confirming the
  // rendered week genuinely contains it — this is the scenario the real bug shipped in.
  describe('the rendered week always contains "today" via CenterPanel\'s startPosition label, for every weekday and firstDayOfWeek', () => {
    const weekdays = [
      '2026-07-06', // Monday
      '2026-07-07', // Tuesday
      '2026-07-08', // Wednesday
      '2026-07-09', // Thursday
      '2026-07-10', // Friday
      '2026-07-11', // Saturday
      '2026-07-12', // Sunday
    ];

    for (const date of weekdays) {
      describe(`today is ${date}`, () => {
        fixedToday(date);

        for (const firstDayOfWeek of [0, 1] as const) {
          it(`contains today for firstDayOfWeek=${firstDayOfWeek}`, () => {
            const container = freshContainer();
            const view = new WeekTimeGridView(callbacks());
            const startPosition = window
              .moment()
              .subtract(firstDayOfWeek, 'days')
              .format('YYYY-ww');
            view.render(container, [], resolvedConfig({ startPosition, firstDayOfWeek }));

            const dates = Array.from(container.querySelectorAll('.tc-tg-day-column')).map(
              (el) => el.getAttribute('data-tg-date') as string,
            );

            expect(dates).toHaveLength(7);
            expect(dates.filter((d) => d === date)).toHaveLength(1);
            for (let i = 1; i < dates.length; i++) {
              expect(window.moment(dates[i]).diff(window.moment(dates[i - 1]), 'days')).toBe(1);
            }
            expect(parseInt(window.moment(dates[0]).format('d'), 10)).toBe(firstDayOfWeek);
          });
        }
      });
    }
  });

  describe('timed multi-day spans (Task 29)', () => {
    it('renders the full interactive block only on the due (anchor) day, and a continuation segment on the other spanned days, for a start+due+time task', () => {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      // Monday-Sunday week of 2026-07-06..12 (firstDayOfWeek: 1); the span covers Mon-Wed.
      const t = task({
        title: 'Conference',
        planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));

      const dueColumn = container.querySelector<HTMLElement>(
        '.tc-tg-day-column[data-tg-date="2026-07-08"]',
      )!;
      expect(dueColumn.querySelector('.tc-tg-block')).not.toBeNull();
      expect(dueColumn.querySelector('.tc-tg-block-continuation')).toBeNull();

      for (const date of ['2026-07-06', '2026-07-07']) {
        const col = container.querySelector<HTMLElement>(
          `.tc-tg-day-column[data-tg-date="${date}"]`,
        )!;
        expect(col.querySelector('.tc-tg-block')).toBeNull();
        const seg = col.querySelector('.tc-tg-block-continuation');
        expect(seg).not.toBeNull();
        expect(seg?.textContent).toContain('Conference');
      }

      // Not part of the span: no block, no continuation.
      const outside = container.querySelector<HTMLElement>(
        '.tc-tg-day-column[data-tg-date="2026-07-09"]',
      )!;
      expect(outside.querySelector('.tc-tg-block')).toBeNull();
      expect(outside.querySelector('.tc-tg-block-continuation')).toBeNull();
    });

    it('an untimed start+due span still renders only in the all-day row (unaffected by the new timedSpans handling)', () => {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      const t = task({ title: 'Trip', planning: { start: '2026-07-06', due: '2026-07-08' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }));
      expect(container.querySelector('.tc-tg-span')).not.toBeNull();
      expect(container.querySelector('.tc-tg-block-continuation')).toBeNull();
    });
  });
});
