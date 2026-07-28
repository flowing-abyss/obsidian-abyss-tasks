import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { bucketTasksForDate, TodayView } from '../src/views/TodayView';
import { freshContainer, resolvedConfig, task, useRealMoment } from './helpers';

useRealMoment();

const fakeApp = {} as App;
const registry = new StatusRegistry(buildDefaultTaskStatuses());
const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function callbacks() {
  return {
    app: fakeApp,
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onDropTime: vi.fn(),
    onCreateAtTime: vi.fn(),
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

function gridRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('TodayView', () => {
  it('patches only task layers while retaining the day skeleton, scroll position, listeners, and now-line interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T09:30:00'));
    try {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new TodayView(cbs);
      const config = resolvedConfig({ startPosition: '2026-07-10' });
      const initial = task({
        title: 'Initial task',
        markdownTitle: 'Initial task',
        planning: { due: '2026-07-10', time: '09:00', duration: 60 },
      });
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(container, [initial], config, false);
      const header = container.querySelector('.tc-tg-header-row');
      const gridRow = container.querySelector('.tc-tg-grid-row') as HTMLElement;
      const hourRow = container.querySelector('.tc-tg-hour-row');
      const dayColumn = container.querySelector('.tc-tg-day-column');
      const allDayCell = container.querySelector('.tc-tg-allday-cell');
      const nowLine = container.querySelector('.tc-tg-now-line');
      const todayHourColumn = (dayColumn as HTMLElement).querySelector('.tc-tg-hour-column');
      const quickAdd = (dayColumn as HTMLElement)
        .querySelector<HTMLElement>('.tc-tg-hour-column')!
        .createDiv({ cls: 'tc-tg-quick-add' });
      gridRow.scrollTop = 321;

      for (let revision = 1; revision <= 3; revision++) {
        view.patch(
          container,
          [
            task({
              title: `Updated task ${revision}`,
              markdownTitle: `Updated task ${revision}`,
              planning: { due: '2026-07-10', time: '10:00', duration: 60 },
            }),
          ],
          config,
        );
      }

      expect(container.querySelector('.tc-tg-header-row')).toBe(header);
      expect(container.querySelector('.tc-tg-grid-row')).toBe(gridRow);
      expect(container.querySelector('.tc-tg-hour-row')).toBe(hourRow);
      expect(container.querySelector('.tc-tg-day-column')).toBe(dayColumn);
      expect(container.querySelector('.tc-tg-allday-cell')).toBe(allDayCell);
      expect(container.querySelector('.tc-tg-now-line')).toBe(nowLine);
      expect(nowLine?.parentElement).toBe(todayHourColumn);
      expect(container.querySelector('.tc-tg-quick-add')).toBe(quickAdd);
      expect(gridRow.scrollTop).toBe(321);
      expect(container.textContent).not.toContain('Initial task');
      expect(container.textContent).toContain('Updated task 3');
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      const hourColumn = container.querySelector('.tc-tg-hour-column') as HTMLElement;
      hourColumn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 96 }));
      expect(cbs.onCreateAtTime).toHaveBeenCalledTimes(1);
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

  it('patch falls back to a full render when the visible day changes', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-07-10' }));
    const header = container.querySelector('.tc-tg-header-row');

    view.patch(container, [], resolvedConfig({ startPosition: '2026-07-11' }));

    expect(container.querySelector('.tc-tg-header-row')).not.toBe(header);
    expect(container.querySelector('.tc-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      '2026-07-11',
    );
  });

  it('threads relative keyboard intents from timed blocks', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new TodayView(cbs);
    const t = task({ planning: { due: '2026-07-10', time: '15:00', duration: 60 } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));

    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    expect(cbs.onKeyboardIntent).toHaveBeenCalledWith(t, {
      type: 'move-time',
      deltaMinutes: 15,
    });
  });

  it('renders a timed task in the hour grid for the configured day', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { due: '2026-07-10', time: '15:00', duration: 60 } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(container.querySelector('.tc-tg-block')).not.toBeNull();
  });

  it('threads onDropTime through to the hour-grid column, firing on drop', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new TodayView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07-10' }));
    const hourColumnEl = container.querySelector('.tc-tg-hour-column') as HTMLElement;
    const dt = { getData: () => 'f.md:::0' } as unknown as DataTransfer;
    const ev = new MouseEvent('drop', { bubbles: true, clientY: 148 });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    hourColumnEl.dispatchEvent(ev);
    expect(cbs.onDropTime).toHaveBeenCalledWith('f.md:::0', '2026-07-10', expect.any(String));
  });

  it('renders a plain due-only task in the all-day band, not the hour grid', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { due: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(container.querySelector('.tc-tg-plain')).not.toBeNull();
    expect(container.querySelector('.tc-tg-block')).toBeNull();
  });

  it('gives a Day all-day span one stylesheet-backed track so its segment fills the layer', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    view.render(
      container,
      [task({ planning: { start: '2026-07-09', due: '2026-07-10' } })],
      resolvedConfig({ startPosition: '2026-07-10' }),
    );

    const layer = container.querySelector<HTMLElement>('.tc-tg-span-layer')!;
    const segment = layer.querySelector<HTMLElement>('.tc-span-piece')!;
    expect(layer.style.getPropertyValue('--tc-span-track-count')).toBe('1');
    expect(segment.style.gridColumn).toBe('1 / 2');
    expect(css).toMatch(
      /\.tc-tg-span-layer,\s*\.tc-mg-span-layer\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--tc-span-track-count\),\s*minmax\(0,\s*1fr\)\)/u,
    );
  });

  it('renders a scheduled+due task as a plain body on its scheduled day, and a deadline marker on due day (not shown here since due != this day)', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { due: '2026-07-15', scheduled: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(container.querySelector('.tc-tg-plain')).not.toBeNull();
    expect(container.querySelector('.tc-tg-deadline-marker')).toBeNull();
  });

  it('Task 38: bucketTasksForDate does NOT filter out done/cancelled tasks (timed, plain, deadlines)', () => {
    const doneTimed = task({
      status: 'done',
      planning: { due: '2026-07-10', time: '15:00' },
      source: { filePath: 'a.md', line: 1 },
    });
    const cancelledPlain = task({
      status: 'cancelled',
      planning: { due: '2026-07-10' },
      source: { filePath: 'b.md', line: 2 },
    });
    const doneDeadline = task({
      status: 'done',
      planning: { due: '2026-07-10', scheduled: '2026-07-05' },
      source: { filePath: 'c.md', line: 3 },
    });
    const { timed, plain, deadlines } = bucketTasksForDate(
      [doneTimed, cancelledPlain, doneDeadline],
      '2026-07-10',
    );
    expect(timed).toContain(doneTimed);
    expect(plain).toContain(cancelledPlain);
    expect(deadlines).toContain(doneDeadline);
  });

  it('a task not anchored to the configured day is excluded entirely', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { due: '2026-08-01' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(container.querySelector('.tc-tg-plain')).toBeNull();
  });

  it('Task 38: a done timed task still renders as a full block in the hour grid, checkbox checked, not removed', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({
      status: 'done',
      statusSymbol: 'x',
      planning: { due: '2026-07-10', time: '15:00', duration: 60 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block).not.toBeNull();
    const marker = block.querySelector('.tc-status-marker') as HTMLElement;
    expect(marker.getAttribute('data-status-type')).toBe('done');
    const title = block.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.classList.contains('is-done')).toBe(true);
  });

  it('Task 38: a done plain (untimed) task still renders in the all-day band, not removed', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ status: 'done', statusSymbol: 'x', planning: { due: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(container.querySelector('.tc-tg-plain')).not.toBeNull();
  });

  it('destroy() does not throw', () => {
    const view = new TodayView(callbacks());
    expect(() => view.destroy()).not.toThrow();
  });

  it('patch() and destroy() cancel an active timed session without committing or leaving a preview', () => {
    const container = freshContainer();
    const onTimedMove = vi.fn();
    const cbs = { ...callbacks(), onTimedMove };
    const view = new TodayView(cbs);
    const config = resolvedConfig({ startPosition: '2026-07-10' });
    const t = task({ planning: { due: '2026-07-10', time: '09:00', duration: 60 } });

    const arm = (): HTMLElement => {
      const day = container.querySelector('.tc-tg-day-column') as HTMLElement;
      const hour = container.querySelector('.tc-tg-hour-column') as HTMLElement;
      const allDay = container.querySelector('.tc-tg-allday-cell') as HTMLElement;
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      day.getBoundingClientRect = () => gridRect(0, 100, 100, 24 * 48);
      hour.getBoundingClientRect = () => gridRect(0, 100, 100, 24 * 48);
      allDay.getBoundingClientRect = () => gridRect(0, 10, 100, 30);
      block.getBoundingClientRect = () => gridRect(0, 532, 100, 48);
      block.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 25,
          clientY: 544,
          pointerId: 21,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 25, clientY: 592, pointerId: 21 }),
      );
      expect(container.querySelector('.tc-tg-drag-preview')).not.toBeNull();
      return block;
    };

    view.render(container, [t], config);
    arm();
    view.patch(container, [t], config);
    expect(container.querySelector('.tc-tg-drag-preview')).toBeNull();
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 592, pointerId: 21 }),
    );
    expect(onTimedMove).not.toHaveBeenCalled();

    arm();
    view.destroy();
    expect(container.querySelector('.tc-tg-drag-preview')).toBeNull();
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 592, pointerId: 21 }),
    );
    expect(onTimedMove).not.toHaveBeenCalled();
  });

  it('periodically repositions the now-line while mounted on today, and clears the interval on destroy', () => {
    vi.useFakeTimers();
    try {
      const container = freshContainer();
      const view = new TodayView(callbacks());
      const today = window.moment().format('YYYY-MM-DD');
      view.render(container, [], resolvedConfig({ startPosition: today }));

      const nowLineEl = container.querySelector('.tc-tg-now-line') as HTMLElement;
      expect(nowLineEl).not.toBeNull();
      const initialTop = nowLineEl.style.top;

      const setIntervalSpy = vi.spyOn(window, 'setInterval');
      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

      // Advance real+fake clock together by moving forward 2 hours, then let the 5-minute
      // interval fire; the now-line's `top` should change to reflect the new time.
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(nowLineEl.style.top).not.toBe(initialTop);

      view.destroy();
      expect(clearIntervalSpy).toHaveBeenCalled();

      // A destroyed view's interval must not still be running: further time advancement
      // must not throw and must not keep moving the (now-detached) now-line.
      const topAfterDestroy = nowLineEl.style.top;
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(nowLineEl.style.top).toBe(topAfterDestroy);

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-rendering without an intervening destroy() clears the previous interval instead of stacking a second one', () => {
    vi.useFakeTimers();
    try {
      const container = freshContainer();
      const view = new TodayView(callbacks());
      const today = window.moment().format('YYYY-MM-DD');

      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(container, [], resolvedConfig({ startPosition: today }));
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      view.render(container, [], resolvedConfig({ startPosition: today }));
      // The stale interval from the first render must be cleared before/when the second
      // render registers its own, so at most one interval is ever live at a time.
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);

      view.destroy();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking the status marker on a timed block fires onToggle, not onTaskClick (threaded through TodayView)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new TodayView(cbs);
    const t = task({ planning: { due: '2026-07-10', time: '15:00', duration: 60 } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    const marker = container.querySelector('.tc-tg-block .tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('clicking the status marker on a plain all-day chip fires onToggle, not onTaskClick (threaded through TodayView)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new TodayView(cbs);
    const t = task({ planning: { due: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    const marker = container.querySelector('.tc-tg-plain .tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a timed block title via renderTaskText (markdown-link-aware) for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-10', time: '15:00', duration: 60 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    // MarkdownRenderer is a noop in this test harness (see test/center-panel-integration.test.ts
    // and friends); `.tc-md` is the reliable signal that renderTaskText's markdown path (not a
    // raw textContent assignment) was taken.
    expect(title.querySelector('.tc-md')).not.toBeNull();
  });

  it('a second render() call does not leak the previous Component (unload/reload lifecycle mirrors legacy MonthView)', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { due: '2026-07-10', time: '15:00', duration: 60 } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' }));
    expect(() =>
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07-10' })),
    ).not.toThrow();
  });

  it('a task with start+due+distinct scheduled lands in spans (not deadlines) on its due day', () => {
    const t = task({
      planning: { start: '2026-07-01', due: '2026-07-05', scheduled: '2026-07-03' },
    });
    const { spans, deadlines } = bucketTasksForDate([t], '2026-07-05');
    expect(spans).toContain(t);
    expect(deadlines).not.toContain(t);
  });

  it('renders only a span bar, not a deadline marker, for a start+due+distinct-scheduled task on its due day', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({
      planning: { start: '2026-07-01', due: '2026-07-05', scheduled: '2026-07-03' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-05' }));
    expect(container.querySelector('.tc-tg-span')).not.toBeNull();
    expect(container.querySelector('.tc-tg-deadline-marker')).toBeNull();
  });

  it('renders an untimed multi-day span as a continuation before its due date', () => {
    const container = freshContainer();
    const view = new TodayView(callbacks());
    const t = task({ planning: { start: '2026-07-01', due: '2026-07-05' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07-04' }));
    expect(container.querySelector('.tc-tg-span-continuation')).not.toBeNull();
    expect(container.querySelector('.tc-tg-span')).toBeNull();
  });

  describe('timed multi-day spans (Task 29)', () => {
    it('a start+due task with a time set lands in timedSpans, not the untimed spans bucket', () => {
      const t = task({ planning: { start: '2026-07-01', due: '2026-07-03', time: '09:00' } });
      const { spans, timedSpans } = bucketTasksForDate([t], '2026-07-02');
      expect(timedSpans).toContain(t);
      expect(spans).not.toContain(t);
    });

    it('an untimed start+due task still lands in spans, not timedSpans', () => {
      const t = task({ planning: { start: '2026-07-01', due: '2026-07-03' } });
      const { spans, timedSpans } = bucketTasksForDate([t], '2026-07-02');
      expect(spans).toContain(t);
      expect(timedSpans).not.toContain(t);
    });

    it('a timed span is present in timedSpans on every day from start to due inclusive', () => {
      const t = task({ planning: { start: '2026-07-01', due: '2026-07-03', time: '09:00' } });
      expect(bucketTasksForDate([t], '2026-07-01').timedSpans).toContain(t);
      expect(bucketTasksForDate([t], '2026-07-02').timedSpans).toContain(t);
      expect(bucketTasksForDate([t], '2026-07-03').timedSpans).toContain(t);
      expect(bucketTasksForDate([t], '2026-06-30').timedSpans).not.toContain(t);
    });

    it('Task 38: a done/cancelled timed span is NOT excluded from timedSpans (stays visible)', () => {
      const t = task({
        status: 'done',
        planning: { start: '2026-07-01', due: '2026-07-03', time: '09:00' },
      });
      const { timedSpans } = bucketTasksForDate([t], '2026-07-02');
      expect(timedSpans).toContain(t);
    });
  });

  it('auto-scrolls the grid row to center the now-line when the rendered day is today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig());
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    expect(gridRowEl.scrollTop).toBe(0);
    // Use runOnlyPendingTimers, not runAllTimers: render() now also registers a repeating
    // now-line-refresh interval, and runAllTimers would loop on it forever.
    vi.runOnlyPendingTimers();
    // 14:30 = 870 minutes -> 696px at 48px/hour; centered in a 400px viewport -> 696 - 200 = 496
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('does not auto-scroll when shouldScrollToNow=false (Task 27: CenterPanel-driven dedup for reactive re-renders)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00'));
    const container = freshContainer();
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig(), false);
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
      const view = new TodayView(callbacks());
      const today = window.moment().format('YYYY-MM-DD');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      view.render(container, [], resolvedConfig({ startPosition: today }), false);
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
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig());
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('Task 31: restores preservedScrollTop onto the fresh grid-row when shouldScrollToNow=false', () => {
    vi.useFakeTimers();
    const container = freshContainer();
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig(), false, 321);
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
    const view = new TodayView(callbacks());
    view.render(container, [], resolvedConfig(), true, 321);
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    Object.defineProperty(gridRowEl, 'clientHeight', { value: 400, configurable: true });
    vi.runOnlyPendingTimers();
    // Scrolls to center-on-now (496), not the stale preservedScrollTop (321).
    expect(gridRowEl.scrollTop).toBe(496);
    vi.useRealTimers();
  });

  it('Task 31: restores preservedScrollTop even when the rendered day is not today (no now-line context)', () => {
    vi.useFakeTimers();
    const container = freshContainer();
    const view = new TodayView(callbacks());
    // A non-today date never enters the scroll-to-now/now-line branches, but the restore itself
    // is unconditional on date — this documents that shouldScrollToNow=false with an explicit
    // preservedScrollTop still applies regardless of which day is shown.
    view.render(container, [], resolvedConfig({ startPosition: '2020-01-01' }), false, 55);
    const gridRowEl = container.querySelector('.tc-tg-grid-row') as HTMLElement;
    vi.runOnlyPendingTimers();
    expect(gridRowEl.scrollTop).toBe(55);
    vi.useRealTimers();
  });

  describe('timed multi-day spans (Task 29)', () => {
    it('renders the full interactive block on the due (anchor) day', () => {
      const container = freshContainer();
      const view = new TodayView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07-08' }));
      expect(container.querySelector('.tc-tg-block')).not.toBeNull();
      expect(container.querySelector('.tc-tg-block-continuation')).toBeNull();
    });

    it('renders a continuation segment as the common interactive block root on a pre-due day', () => {
      const container = freshContainer();
      const view = new TodayView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07-07' }));
      const ghost = container.querySelector('.tc-tg-block.tc-tg-block-continuation') as HTMLElement;
      expect(ghost).not.toBeNull();
      expect(ghost.tabIndex).toBe(0);
      expect(ghost.getAttribute('draggable')).toBeNull();
      expect(ghost.querySelector('.tc-tg-resize-handle')).not.toBeNull();
      expect(ghost.querySelector('.tc-status-marker')).toBeNull();
    });
  });
});
