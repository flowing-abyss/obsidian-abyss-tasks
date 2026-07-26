import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { firstVisibleWeekDate } from '../src/domain/weekGridOffset';
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
    onSpanMove: vi.fn(),
    onSpanBoundary: vi.fn(),
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
  it('patches only task layers while retaining the week skeleton, scroll position, listeners, and now-line interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T09:30:00'));
    try {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new WeekTimeGridView(cbs);
      const config = resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 });
      const initial = task({
        title: 'Initial week task',
        markdownTitle: 'Initial week task',
        planning: { due: '2026-07-08', time: '09:00', duration: 60 },
      });
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(container, [initial], config, false);
      const header = container.querySelector('.tc-tg-header-row');
      const gridRow = container.querySelector('.tc-tg-grid-row') as HTMLElement;
      const hourRow = container.querySelector('.tc-tg-hour-row');
      const dayColumn = container.querySelector('[data-tg-date="2026-07-08"].tc-tg-day-column');
      const allDayCell = container.querySelector('[data-tg-date="2026-07-08"].tc-tg-allday-cell');
      const nowLine = container.querySelector('.tc-tg-now-line');
      const quickAdd = (dayColumn as HTMLElement)
        .querySelector<HTMLElement>('.tc-tg-hour-column')!
        .createDiv({ cls: 'tc-tg-quick-add' });
      gridRow.scrollTop = 412;

      for (let revision = 1; revision <= 3; revision++) {
        view.patch(
          container,
          [
            task({
              title: `Updated week task ${revision}`,
              markdownTitle: `Updated week task ${revision}`,
              planning: { due: '2026-07-09', time: '10:00', duration: 60 },
            }),
          ],
          config,
        );
      }

      expect(container.querySelector('.tc-tg-header-row')).toBe(header);
      expect(container.querySelector('.tc-tg-grid-row')).toBe(gridRow);
      expect(container.querySelector('.tc-tg-hour-row')).toBe(hourRow);
      expect(container.querySelector('[data-tg-date="2026-07-08"].tc-tg-day-column')).toBe(
        dayColumn,
      );
      expect(container.querySelector('[data-tg-date="2026-07-08"].tc-tg-allday-cell')).toBe(
        allDayCell,
      );
      expect(container.querySelector('.tc-tg-now-line')).toBe(nowLine);
      expect(container.querySelector('.tc-tg-quick-add')).toBe(quickAdd);
      expect(gridRow.scrollTop).toBe(412);
      expect(container.textContent).not.toContain('Initial week task');
      expect(container.textContent).toContain('Updated week task 3');
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      const headerCell = container.querySelector(
        '.tc-tg-header-cell:nth-of-type(4)',
      ) as HTMLElement;
      headerCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cbs.onDayHeaderClick).toHaveBeenCalledTimes(1);
      const drop = new MouseEvent('drop', { bubbles: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { getData: () => 'task.md:::1' },
      });
      (allDayCell as HTMLElement).dispatchEvent(drop);
      expect(cbs.onDrop).toHaveBeenCalledTimes(1);

      view.destroy();
      setIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('patch falls back to a full render when the visible week changes', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }));
    const header = container.querySelector('.tc-tg-header-row');

    view.patch(container, [], resolvedConfig({ startPosition: '2026-07-13', firstDayOfWeek: 1 }));

    expect(container.querySelector('.tc-tg-header-row')).not.toBe(header);
    expect(container.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      '2026-07-13',
    );
  });

  it('renders one shared continuous all-day ghost across adjacent columns with a due terminal', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    const t = task({
      title: 'Trip',
      planning: { start: '2026-07-07', due: '2026-07-09' },
    });

    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }));

    const layer = container.querySelector('.tc-tg-span-layer');
    const ghost = layer?.querySelector<HTMLElement>('[data-span-kind="ghost"]');
    const terminal = layer?.querySelector<HTMLElement>('[data-span-kind="terminal"]');
    expect(layer).not.toBeNull();
    expect(layer?.querySelectorAll('[data-span-kind="ghost"]')).toHaveLength(1);
    expect(ghost?.style.gridColumn).toBe('2 / 4');
    expect(terminal?.style.gridColumn).toBe('4 / 5');
    expect(ghost?.getAttribute('tabindex')).toBe('0');
    expect(terminal?.getAttribute('tabindex')).toBe('0');
  });

  it('puts actual boundary handles on their visible pieces and no false handles on a fully clipped ghost', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    const visible = task({
      title: 'Visible edges',
      planning: { start: '2026-07-07', due: '2026-07-09' },
      source: { line: 1 },
    });
    const clipped = task({
      title: 'Clipped',
      planning: { start: '2026-07-01', due: '2026-07-20' },
      source: { line: 2 },
    });

    view.render(
      container,
      [visible, clipped],
      resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }),
    );

    const visiblePieces = container.querySelectorAll<HTMLElement>('[data-task-line="1"]');
    expect(visiblePieces[0]?.querySelector('[data-boundary="start"]')).not.toBeNull();
    expect(visiblePieces[0]?.querySelector('[data-boundary="due"]')).toBeNull();
    expect(visiblePieces[1]?.querySelector('[data-boundary="due"]')).not.toBeNull();
    const clippedGhost = container.querySelector<HTMLElement>('[data-task-line="2"]');
    expect(clippedGhost?.getAttribute('tabindex')).toBe('0');
    expect(clippedGhost?.querySelectorAll('[data-boundary]')).toHaveLength(0);
  });

  it('keeps single-day items below equal reserved span lanes while day cells remain click/drop targets', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    const spans = [
      task({ planning: { start: '2026-07-06', due: '2026-07-10' }, source: { line: 1 } }),
      task({ planning: { start: '2026-07-07', due: '2026-07-11' }, source: { line: 2 } }),
    ];
    const plain = task({
      title: 'Single',
      planning: { scheduled: '2026-07-08' },
      source: { line: 3 },
    });

    view.render(
      container,
      [...spans, plain],
      resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }),
    );

    const cells = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-allday-cell'));
    expect(cells.every((cell) => cell.style.getPropertyValue('--tc-span-lane-count') === '2')).toBe(
      true,
    );
    expect(
      container.querySelector('[data-tg-date="2026-07-08"] .tc-tg-cell-items .tc-tg-plain'),
    ).not.toBeNull();
    const target = container.querySelector<HTMLElement>('[data-tg-date="2026-07-12"]')!;
    const drop = new MouseEvent('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { getData: () => 'f.md:::3' },
    });
    target.dispatchEvent(drop);
    expect(cbs.onDrop).toHaveBeenCalledWith('f.md:::3', '2026-07-12');
  });

  it('keeps a scheduled-only single body marker and labels its extension affordance explicitly', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(
      container,
      [task({ planning: { scheduled: '2026-07-08' } })],
      resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }),
    );

    const body = container.querySelector('.tc-tg-plain')!;
    expect(body.querySelectorAll('.tc-status-marker')).toHaveLength(1);
    expect(body.querySelector('[data-boundary="create-span"]')).not.toBeNull();
  });

  it('keeps only the latest single-date extension resize session active', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new WeekTimeGridView(cbs);
    const tasks = [
      task({ planning: { scheduled: '2026-07-08' }, source: { line: 1 } }),
      task({ planning: { scheduled: '2026-07-09' }, source: { line: 2 } }),
    ];
    view.render(
      container,
      tasks,
      resolvedConfig({ startPosition: '2026-07-06', firstDayOfWeek: 1 }),
    );

    const handles = Array.from(
      container.querySelectorAll<HTMLElement>('[data-boundary="create-span"]'),
    );
    const target = container.querySelector<HTMLElement>('[data-tg-date="2026-07-10"]')!;
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      handles[0]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      handles[1]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
      expect(cbs.onExtendToSpan).toHaveBeenCalledTimes(1);
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(tasks[1], '2026-07-10');
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }
  });
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

  it('treats an exact startPosition as the first visible day across Dec/Jan', () => {
    const container = freshContainer();
    const view = new WeekTimeGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2025-12-29', firstDayOfWeek: 1 }));
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-day-column')).map(
        (column) => column.dataset['tgDate'],
      ),
    ).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
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
    expect(container.querySelectorAll('.tc-tg-span-continuation')).toHaveLength(1);
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
      const todayWeek = firstVisibleWeekDate(window.moment(), 1);
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
      const todayWeek = firstVisibleWeekDate(window.moment(), 1);

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
      const todayWeek = firstVisibleWeekDate(window.moment(), 1);
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

  // The fallback week must contain today for every anchor weekday and every supported
  // firstDayOfWeek value.
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

        for (const firstDayOfWeek of [0, 1, 2, 3, 4, 5, 6] as const) {
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

  // This is the exact YYYY-MM-DD startPosition path CenterPanel drives in production.
  describe('the rendered week always contains "today" via CenterPanel\'s exact startPosition, for every weekday and firstDayOfWeek', () => {
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

        for (const firstDayOfWeek of [0, 1, 2, 3, 4, 5, 6] as const) {
          it(`contains today for firstDayOfWeek=${firstDayOfWeek}`, () => {
            const container = freshContainer();
            const view = new WeekTimeGridView(callbacks());
            const startPosition = firstVisibleWeekDate(window.moment(), firstDayOfWeek);
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
    it('renders every timed span segment as an interactive block and keeps terminal ownership on due', () => {
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
      const dueBlock = dueColumn.querySelector('.tc-tg-block') as HTMLElement;
      expect(dueBlock).not.toBeNull();
      expect(dueColumn.querySelector('.tc-tg-block-continuation')).toBeNull();
      expect(dueBlock.querySelector('.tc-status-marker')).not.toBeNull();
      expect(dueBlock.querySelector('.tc-tg-block-title')).not.toBeNull();
      expect(dueBlock.querySelector('[data-boundary="due"]')).not.toBeNull();

      for (const [date, boundary] of [
        ['2026-07-06', 'start'],
        ['2026-07-07', null],
      ] as const) {
        const col = container.querySelector<HTMLElement>(
          `.tc-tg-day-column[data-tg-date="${date}"]`,
        )!;
        const seg = col.querySelector('.tc-tg-block.tc-tg-block-continuation') as HTMLElement;
        expect(seg).not.toBeNull();
        expect(seg?.textContent).toContain('Conference');
        expect(seg.tabIndex).toBe(0);
        expect(seg.getAttribute('draggable')).toBeNull();
        expect(seg.querySelector('.tc-tg-resize-handle')).not.toBeNull();
        expect(seg.querySelector('.tc-status-marker')).toBeNull();
        expect(seg.querySelector('.tc-tg-block-title')).toBeNull();
        expect(seg.querySelector('.tc-tg-block-continuation-title')).not.toBeNull();
        expect(seg.querySelector('.tc-tg-span-edge')?.getAttribute('data-boundary') ?? null).toBe(
          boundary,
        );
      }

      expect(container.querySelectorAll('.tc-tg-block')).toHaveLength(3);

      // Not part of the span: no block, no continuation.
      const outside = container.querySelector<HTMLElement>(
        '.tc-tg-day-column[data-tg-date="2026-07-09"]',
      )!;
      expect(outside.querySelector('.tc-tg-block')).toBeNull();
      expect(outside.querySelector('.tc-tg-block-continuation')).toBeNull();
    });

    it('packs a timed continuation together with an overlapping terminal block', () => {
      const container = freshContainer();
      const view = new WeekTimeGridView(callbacks());
      const continuation = task({
        title: 'Span',
        planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
        source: { line: 0 },
      });
      const terminal = task({
        title: 'Local',
        planning: { due: '2026-07-07', time: '09:15', duration: 60 },
        source: { line: 1 },
      });
      view.render(
        container,
        [continuation, terminal],
        resolvedConfig({ startPosition: '2026-28', firstDayOfWeek: 1 }),
      );
      const day = container.querySelector<HTMLElement>(
        '.tc-tg-day-column[data-tg-date="2026-07-07"]',
      )!;
      const blocks = Array.from(day.querySelectorAll<HTMLElement>('.tc-tg-block'));
      expect(blocks).toHaveLength(2);
      expect(blocks.map((block) => block.style.width)).toEqual(['50%', '50%']);
      expect(blocks.map((block) => block.style.left)).toEqual(['0%', '50%']);
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
