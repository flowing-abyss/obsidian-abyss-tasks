import { describe, expect, it, vi } from 'vitest';
import { renderHourGrid, repositionNowLine } from '../src/views/timegrid/HourGrid';
import {
  cssDeclarationsFor,
  cssRuleParts,
  DataTransferStub,
  expectDefined,
  freshContainer,
  loadPluginStyles,
  useRealMoment,
} from './helpers';

useRealMoment();

const css = await loadPluginStyles();

function declarationsFor(selector: string): string {
  return cssDeclarationsFor(css, selector);
}

function declarationsForRuleContaining(...selectors: string[]): string {
  for (const rule of cssRuleParts(css)) {
    const selectorList = rule.selector.replace(/\s+/gu, '');
    if (selectors.every((selector) => selectorList.includes(selector.replace(/\s+/gu, '')))) {
      return rule.declarations;
    }
  }
  return '';
}

describe('renderHourGrid', () => {
  it('defines the shared light/dark calendar scale and committed fill tokens', () => {
    const light = declarationsFor('.abyss-panel-view');
    const dark = declarationsFor('.theme-dark .abyss-panel-view');
    expect(light).toMatch(/--abyss-calendar-item-font-size\s*:\s*0\.8em/u);
    expect(light).toMatch(/--abyss-calendar-track-height\s*:\s*1\.65em/u);
    expect(light).toMatch(/--abyss-calendar-item-radius\s*:\s*6px/u);
    expect(light).toMatch(/--abyss-calendar-item-pad-inline\s*:\s*6px/u);
    expect(light).toMatch(/--abyss-calendar-item-rail\s*:\s*3px/u);
    expect(light).toMatch(/--abyss-calendar-ghost-rail\s*:\s*var\(--abyss-calendar-item-rail\)/u);
    expect(light).toMatch(/--abyss-event-fill-strength\s*:\s*11%/u);
    expect(light).toMatch(/--abyss-event-outline-strength\s*:\s*24%/u);
    expect(light).toMatch(/--abyss-event-focus-tag-strength\s*:\s*55%/u);
    expect(dark).toMatch(/--abyss-event-fill-strength\s*:\s*14%/u);
    expect(dark).toMatch(/--abyss-event-outline-strength\s*:\s*32%/u);
  });

  it('keeps timed event fills opaque and preserves them through hover, selection, and drag', () => {
    const fills = declarationsForRuleContaining(
      '.abyss-tg-block',
      '.abyss-tg-span',
      '.abyss-tg-plain',
      '.abyss-mg-block-dot',
      '.abyss-mg-span-segment',
      '.abyss-mg-plain',
    );
    const itemTokens = declarationsFor('.abyss-calendar-item');
    expect(fills).toMatch(/background\s*:\s*var\(--abyss-calendar-surface\)/u);
    expect(fills).toMatch(/box-shadow\s*:\s*inset 0 0 0 1px var\(--abyss-calendar-border\)/u);
    expect(fills).not.toMatch(/transparent/u);
    expect(fills).toMatch(/border-inline-start\s*:/u);
    expect(itemTokens).toMatch(
      /--abyss-calendar-surface\s*:\s*color-mix\(\s*in srgb,\s*var\(--abyss-tag-color,\s*var\(--interactive-accent\)\)\s+var\(--abyss-event-fill-strength,\s*11%\),\s*var\(--background-primary\)\s*\)/u,
    );

    const hover = declarationsForRuleContaining(
      '.abyss-tg-block:hover',
      '.abyss-tg-span-continuation:hover',
      '.abyss-mg-plain:hover',
    );
    expect(hover).not.toMatch(/background(?:-color)?\s*:/u);
    expect(hover).toMatch(/box-shadow\s*:.*var\(--background-modifier-hover\)/u);

    const selected = declarationsFor('.abyss-tg-block.is-selected');
    const resting = fills;
    expect(selected).not.toMatch(/background(?:-color)?\s*:/u);
    expect(resting).toMatch(/box-shadow\s*:\s*inset 0 0 0 1px/u);
    expect(selected).toMatch(/box-shadow\s*:\s*inset 0 0 0 2px/u);
    expect(selected).toMatch(/--abyss-event-focus-tag-strength/u);
    expect(selected).toMatch(/--text-normal/u);

    const dragging = declarationsForRuleContaining(
      '.abyss-tg-block.is-dragging',
      '.abyss-tg-body.is-dragging',
      '.abyss-mg-block-dot.is-dragging',
      '.abyss-mg-plain.is-dragging',
    );
    expect(dragging).not.toMatch(/opacity\s*:/u);
    expect(dragging).not.toMatch(/background(?:-color)?\s*:/u);
    expect(css).not.toMatch(/(?:^|\n)\.is-dragging\s*\{[^}]*opacity\s*:/u);
    expect(
      declarationsForRuleContaining(
        '.is-dragging:not(',
        '.abyss-tg-block',
        '.abyss-tg-body',
        '.abyss-mg-block-dot',
        '.abyss-mg-plain',
      ),
    ).toMatch(/opacity\s*:\s*0\.4/u);
  });

  it('keeps recurrence badge spacing on live repeat chips only', () => {
    expect(css).not.toContain('.abyss-status-popover-edit-repeat');
    expect(declarationsForRuleContaining('.abyss-repeat-chip .abyss-recurrence-badge')).toMatch(
      /margin-inline-end\s*:\s*var\(--size-2-1\)/u,
    );
  });

  it('provides full 10px vertical and horizontal resize hit targets', () => {
    expect(declarationsFor('.abyss-tg-resize-handle')).toMatch(/height\s*:\s*10px/u);
    expect(declarationsFor('.abyss-tg-span-edge')).toMatch(/width\s*:\s*10px/u);
  });

  it('renders a day-header cell per date with weekday + day number', () => {
    const container = freshContainer();
    renderHourGrid(container, ['2026-07-10', '2026-07-11']);
    const headers = container.querySelectorAll('.abyss-tg-header-cell');
    expect(headers).toHaveLength(2);
    expect(headers[0]?.textContent).toContain('Fri');
    expect(headers[0]?.textContent).toContain('10');
    expect(headers[1]?.textContent).toContain('Sat');
    expect(headers[1]?.textContent).toContain('11');
  });

  it('marks the header cell matching today with is-today', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const other = window.moment().add(1, 'day').format('YYYY-MM-DD');
    renderHourGrid(container, [today, other]);
    const headers = Array.from(container.querySelectorAll('.abyss-tg-header-cell'));
    expect(headers[0]?.hasClass('is-today')).toBe(true);
    expect(headers[1]?.hasClass('is-today')).toBe(false);
  });

  it('never marks the day-column itself with is-today (no full-column border in any view)', () => {
    // Round 3: the day-column's box-shadow border was removed entirely — Day view found it
    // redundant (only one column, obviously "today") and Week found a full-height border
    // around one column too visually noisy. "Today" is now conveyed only via the header's
    // accented day-number (see the header-cell tests below), never a column-level class.
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const other = window.moment().add(1, 'day').format('YYYY-MM-DD');
    renderHourGrid(container, [today, other]);
    const columns = Array.from(container.querySelectorAll('.abyss-tg-day-column'));
    expect(columns[0]?.hasClass('is-today')).toBe(false);
    expect(columns[1]?.hasClass('is-today')).toBe(false);
  });

  it('single-date (Day/Today view) render has no is-today day-column anywhere', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    renderHourGrid(container, [today]);
    const columns = Array.from(container.querySelectorAll('.abyss-tg-day-column'));
    expect(columns.every((c) => !c.hasClass('is-today'))).toBe(true);
  });

  it("splits the header cell's date into an independently-selectable weekday span and day-number span", () => {
    const container = freshContainer();
    renderHourGrid(container, ['2026-07-10']);
    const header = container.querySelector('.abyss-tg-header-cell') as HTMLElement;
    const weekday = header.querySelector('.abyss-tg-header-weekday');
    const dayNumber = header.querySelector('.abyss-tg-header-day-number');
    expect(weekday?.textContent).toBe('Fri');
    expect(dayNumber?.textContent).toBe('10');
  });

  it("accents only today's header day-number span, in a multi-date (Week) render", () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const other = window.moment().add(1, 'day').format('YYYY-MM-DD');
    renderHourGrid(container, [today, other]);
    const headers = Array.from(container.querySelectorAll('.abyss-tg-header-cell'));
    expect(headers[0]?.hasClass('is-today')).toBe(true);
    expect(headers[0]?.querySelector('.abyss-tg-header-day-number')).not.toBeNull();
    expect(headers[1]?.hasClass('is-today')).toBe(false);
  });

  it('renders one day column per date, with 24 hour rows each', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10']);
    expect(handles.days).toHaveLength(1);
    expect(handles.days[0]?.date).toBe('2026-07-10');
    expect(container.querySelectorAll('.abyss-tg-hour-row')).toHaveLength(24);
  });

  it('renders 7 day columns for a week of dates', () => {
    const container = freshContainer();
    const dates = [
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ];
    const handles = renderHourGrid(container, dates);
    expect(handles.days).toHaveLength(7);
    expect(handles.days.map((d) => d.date)).toEqual(dates);
    expect(container.querySelectorAll('.abyss-tg-day-column')).toHaveLength(7);
  });

  it('labels the all-day gutter "No-time" so its purpose is clear', () => {
    const container = freshContainer();
    renderHourGrid(container, ['2026-07-10']);
    const gutter = container.querySelector('.abyss-tg-allday-gutter') as HTMLElement;
    expect(gutter.textContent).toBe('No-time');
  });

  it('each day gets an independent all-day cell element', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10', '2026-07-11']);
    expect(handles.days[0]?.allDayCellEl).not.toBe(handles.days[1]?.allDayCellEl);
    expect(container.querySelectorAll('.abyss-tg-allday-cell')).toHaveLength(2);
  });

  it('hourColumnEl is positioned relative (so absolutely-positioned blocks anchor to it)', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10']);
    expect(handles.days[0]?.hourColumnEl.hasClass('abyss-tg-hour-column')).toBe(true);
  });

  it('re-rendering into the same container clears prior content', () => {
    const container = freshContainer();
    renderHourGrid(container, ['2026-07-10']);
    renderHourGrid(container, ['2026-07-11']);
    expect(container.querySelectorAll('.abyss-tg-day-column')).toHaveLength(1);
  });

  it('renders the now-line across the full time grid, positioned by current time', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const other = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [today, other]);
    const nowLines = container.querySelectorAll('.abyss-tg-now-line');
    expect(nowLines).toHaveLength(1);
    const nowLine = nowLines[0] as HTMLElement;
    expect(nowLine.parentElement).toBe(handles.gridRowEl);
    expect(nowLine.closest('.abyss-tg-day-column')).toBeNull();
    expect(handles.days[0]?.hourColumnEl.querySelector('.abyss-tg-now-line')).toBeNull();
    expect(handles.days[1]?.hourColumnEl.querySelector('.abyss-tg-now-line')).toBeNull();
    const top = parseFloat(nowLine.style.top);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("centers the now-line dot in today's column across the full grid", () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const yesterday = window.moment().subtract(1, 'day').format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [yesterday, today, tomorrow]);
    const dot = handles.nowLineEl?.querySelector('.abyss-tg-now-line-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.left).toBe('50%');
  });

  it('single-date (Day view) centers the now-line dot in its only column', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [today]);
    const dot = handles.nowLineEl?.querySelector('.abyss-tg-now-line-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.left).toBe('50%');
  });

  it('keeps the full-width now-line beneath timed task blocks', () => {
    const nowLine = declarationsFor('.abyss-tg-now-line');
    const calendarTokens = declarationsFor('.abyss-panel-view');
    const taskBlock = declarationsFor('.abyss-tg-block');
    const continuation = declarationsFor('.abyss-tg-block-continuation');
    expect(nowLine).toMatch(/left\s*:\s*3\.5em/u);
    expect(nowLine).toMatch(/right\s*:\s*0/u);
    expect(nowLine).toMatch(/height\s*:\s*1px/u);
    expect(nowLine).toMatch(/z-index\s*:\s*0/u);
    expect(nowLine).toMatch(/background\s*:\s*var\(--abyss-calendar-now\)/u);
    expect(nowLine).not.toMatch(/opacity\s*:/u);
    expect(calendarTokens).toMatch(
      /--abyss-calendar-now\s*:\s*color-mix\(in srgb, var\(--text-error\) 48%, transparent\)/u,
    );
    expect(taskBlock).toMatch(/z-index\s*:\s*2/u);
    expect(continuation).toMatch(/z-index\s*:\s*2/u);
  });

  it('gives ghost span pieces the same track-fitting surface geometry as committed calendar items', () => {
    const sharedSurface = declarationsForRuleContaining(
      '.abyss-tg-span',
      '.abyss-tg-span-continuation',
      '.abyss-mg-span-segment:not(.abyss-mg-span-continuation)',
      '.abyss-mg-span-continuation',
    );
    const allDayBody = declarationsFor('.abyss-tg-body');
    const ghostTimegrid = declarationsFor('.abyss-tg-span-continuation');
    const ghostMonth = declarationsFor('.abyss-mg-span-continuation');

    expect(sharedSurface).toMatch(/box-sizing\s*:\s*border-box/u);
    expect(sharedSurface).toMatch(
      /border-inline-start\s*:\s*var\(--abyss-calendar-item-rail\) solid/u,
    );
    expect(sharedSurface).toMatch(/box-shadow\s*:\s*inset 0 0 0 1px/u);
    expect(allDayBody).toMatch(/box-sizing\s*:\s*border-box/u);
    expect(allDayBody).not.toMatch(/block-size\s*:\s*100%/u);
    expect(allDayBody).toMatch(/min-block-size\s*:\s*0/u);
    expect(allDayBody).toMatch(/border-radius\s*:\s*var\(--abyss-calendar-item-radius\)/u);
    expect(allDayBody).toMatch(/padding\s*:\s*2px\s+var\(--abyss-calendar-item-pad-inline\)/u);
    expect(allDayBody).toMatch(/align-items\s*:\s*center/u);
    expect(allDayBody).toMatch(/line-height\s*:\s*1\.4/u);
    for (const ghost of [ghostTimegrid, ghostMonth]) {
      expect(ghost).toMatch(/border-inline-start\s*:\s*var\(--abyss-calendar-ghost-rail\) dashed/u);
    }
  });

  it('no now-line dot is rendered when today is not among the rendered dates', () => {
    const container = freshContainer();
    const other = window.moment().add(5, 'days').format('YYYY-MM-DD');
    renderHourGrid(container, [other]);
    expect(container.querySelectorAll('.abyss-tg-now-line')).toHaveLength(0);
    expect(container.querySelector('.abyss-tg-now-line-dot')).toBeNull();
  });

  it('exposes the now-line element via handles so callers can reposition it later (periodic refresh)', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [today]);
    expect(handles.nowLineEl).not.toBeNull();
    expect(handles.nowLineEl?.hasClass('abyss-tg-now-line')).toBe(true);
  });

  it('nowLineEl is null when today is not among the rendered dates', () => {
    const container = freshContainer();
    const other = window.moment().add(5, 'days').format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [other]);
    expect(container.querySelectorAll('.abyss-tg-now-line')).toHaveLength(0);
    expect(handles.nowLineEl).toBeNull();
  });

  it('repositionNowLine recomputes top from the current time', () => {
    const container = freshContainer();
    const today = window.moment().format('YYYY-MM-DD');
    const handles = renderHourGrid(container, [today]);
    const nowLineEl = expectDefined(handles.nowLineEl);
    nowLineEl.setCssProps({ top: '0px' });
    repositionNowLine(nowLineEl);
    const top = parseFloat(nowLineEl.style.top);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('exposes the scrollable grid-row container so callers can scroll to now', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10']);
    expect(handles.gridRowEl.hasClass('abyss-tg-grid-row')).toBe(true);
  });

  it('dropping onto a day column computes the time from the drop Y-position', () => {
    const container = freshContainer();
    const onDropTime = vi.fn();
    const handles = renderHourGrid(container, ['2026-07-10'], onDropTime);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    // Stub getBoundingClientRect so a clientY of 148 maps to a known offset
    vi.spyOn(hourColumnEl, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
    } as DOMRect);
    const dt = new DataTransferStub();
    dt.setData('text/plain', 'f.md:::0');
    const ev = new MouseEvent('drop', { bubbles: true, clientY: 148 });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    hourColumnEl.dispatchEvent(ev);
    expect(onDropTime).toHaveBeenCalledWith('f.md:::0', '2026-07-10', '01:00'); // (148-100)px = 48px = 60min
  });

  it('clicking empty hour-grid space fires onCreateAtTime with the computed time', () => {
    const container = freshContainer();
    const onCreateAtTime = vi.fn();
    const handles = renderHourGrid(container, ['2026-07-10'], undefined, onCreateAtTime);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    vi.spyOn(hourColumnEl, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
    } as DOMRect);
    hourColumnEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 148 }));
    expect(onCreateAtTime).toHaveBeenCalledWith('2026-07-10', '01:00');
  });

  it('clicking on an existing timed block does not also fire onCreateAtTime', () => {
    const container = freshContainer();
    const onCreateAtTime = vi.fn();
    const handles = renderHourGrid(container, ['2026-07-10'], undefined, onCreateAtTime);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    const block = hourColumnEl.createDiv({ cls: 'abyss-tg-block' });
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCreateAtTime).not.toHaveBeenCalled();
  });

  it("clicking a multi-day timed span's continuation segment does not also fire onCreateAtTime", () => {
    const container = freshContainer();
    const onCreateAtTime = vi.fn();
    const handles = renderHourGrid(container, ['2026-07-10'], undefined, onCreateAtTime);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    const continuation = hourColumnEl.createDiv({ cls: 'abyss-tg-block-continuation' });
    continuation.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCreateAtTime).not.toHaveBeenCalled();
  });

  it('does not wire a click listener when onCreateAtTime is not provided (no throw on click)', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10']);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    expect(() =>
      hourColumnEl.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    ).not.toThrow();
  });

  it('clicking a header cell fires onDayHeaderClick with that date', () => {
    const container = freshContainer();
    const onDayHeaderClick = vi.fn();
    const handles = renderHourGrid(
      container,
      ['2026-07-10', '2026-07-11'],
      undefined,
      undefined,
      onDayHeaderClick,
    );
    const headers = Array.from(container.querySelectorAll('.abyss-tg-header-cell'));
    (headers[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDayHeaderClick).toHaveBeenCalledWith('2026-07-11');
    expect(handles.days).toHaveLength(2); // sanity: handles still line up with dates
    // Clickable headers advertise the affordance (pointer/hover is CSS-gated on is-clickable).
    expect((headers[0] as HTMLElement).classList.contains('is-clickable')).toBe(true);
  });

  it('does not wire a header click listener when onDayHeaderClick is not provided (no throw on click), and does not advertise clickability', () => {
    const container = freshContainer();
    renderHourGrid(container, ['2026-07-10']);
    const header = container.querySelector('.abyss-tg-header-cell') as HTMLElement;
    expect(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    // No handler → no false pointer-cursor/hover affordance (Day/Today view's single header).
    expect(header.classList.contains('is-clickable')).toBe(false);
  });

  it('clicking inside the all-day band does not fire onDayHeaderClick (separate row from the header)', () => {
    const container = freshContainer();
    const onDayHeaderClick = vi.fn();
    renderHourGrid(container, ['2026-07-10'], undefined, undefined, onDayHeaderClick);
    const alldayCell = container.querySelector('.abyss-tg-allday-cell') as HTMLElement;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDayHeaderClick).not.toHaveBeenCalled();
  });

  it('does not wire drop listeners when onDropTime is not provided (no throw on drop)', () => {
    const container = freshContainer();
    const handles = renderHourGrid(container, ['2026-07-10']);
    const hourColumnEl = expectDefined(handles.days[0]).hourColumnEl;
    vi.spyOn(hourColumnEl, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
    } as DOMRect);
    const dt = new DataTransferStub();
    dt.setData('text/plain', 'f.md:::0');
    const ev = new MouseEvent('drop', { bubbles: true, clientY: 148 });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    expect(() => hourColumnEl.dispatchEvent(ev)).not.toThrow();
  });
});

describe('is-today styling (Round 3: no column border anywhere, header day-number accent only)', () => {
  it('.abyss-tg-day-column.is-today no longer declares a box-shadow border', () => {
    expect(css).not.toMatch(/\.abyss-tg-day-column\.is-today\s*\{[^}]*box-shadow/u);
  });

  it('.abyss-tg-header-cell.is-today no longer colors the whole header cell text', () => {
    const declarations = declarationsFor('.abyss-tg-header-cell.is-today');
    // The old rule set `color` directly on the header cell; that's been replaced by a
    // more specific rule targeting only the day-number span (checked below).
    expect(declarations).toBe('');
  });

  it('accents the day-number span red/bold when its header cell is is-today', () => {
    const declarations = declarationsFor(
      '.abyss-tg-header-cell.is-today .abyss-tg-header-day-number',
    );
    expect(declarations).toContain('var(--text-error)');
    expect(declarations).toMatch(/font-weight:\s*700/u);
  });
});

describe('tag-fill background (Round 3 Task 24: solid, not washed-out/gridline-bleeding)', () => {
  it('shares one background rule across timed blocks, all-day spans/plain, and Month compact items', () => {
    const declarations = declarationsForRuleContaining(
      '.abyss-tg-block',
      '.abyss-tg-span',
      '.abyss-tg-plain',
      '.abyss-mg-block-dot',
      '.abyss-mg-span-segment:not(.abyss-mg-span-continuation)',
      '.abyss-mg-plain',
    );
    expect(declarations).toContain('background:');
  });

  it('mixes the tag color against a solid background (not `transparent`), so the fill is fully opaque and can never let the hour-gridline (or anything else behind it) show through — regardless of the mix percentage', () => {
    const declarations = declarationsForRuleContaining(
      '.abyss-tg-block',
      '.abyss-tg-span',
      '.abyss-tg-plain',
      '.abyss-mg-block-dot',
      '.abyss-mg-span-segment:not(.abyss-mg-span-continuation)',
      '.abyss-mg-plain',
    );
    const itemTokens = declarationsFor('.abyss-calendar-item');
    expect(declarations).toMatch(/background\s*:\s*var\(--abyss-calendar-surface\)/u);
    expect(itemTokens).toMatch(
      /--abyss-calendar-surface\s*:\s*color-mix\(\s*in srgb,\s*var\(--abyss-tag-color,\s*var\(--interactive-accent\)\)\s+var\(--abyss-event-fill-strength,\s*11%\),\s*var\(--background-primary\)\s*\)/u,
    );
    expect(itemTokens).not.toMatch(/--abyss-calendar-surface\s*:\s*color-mix\([^;]*transparent/u);
  });
});

describe(".abyss-tg-allday-gutter styling (Round 3 Task 25: match the hour-label's muted look)", () => {
  it('uses the same muted color variable and font-size as .abyss-tg-hour-label, on its nested label (not the gutter box itself)', () => {
    // Task 47: font-size/color moved off .abyss-tg-allday-gutter itself onto a nested
    // .abyss-tg-allday-gutter-label span — see that selector's styles.css doc comment for why:
    // font-size directly on the gutter box made its own `width: 3.5em` resolve against its own
    // (smaller) font-size instead of the ambient one .abyss-tg-header-gutter/.abyss-tg-hour-gutter use,
    // silently narrowing this one gutter and offsetting the whole all-day band from the hour-grid
    // below it.
    const label = declarationsFor('.abyss-tg-allday-gutter-label');
    const hourLabel = declarationsFor('.abyss-tg-hour-label');
    expect(label).toContain('color: var(--text-faint)');
    expect(hourLabel).toContain('color: var(--text-faint)');
    expect(label).toContain('font-size: 0.75em');
    expect(hourLabel).toContain('font-size: 0.75em');
    const gutter = declarationsFor('.abyss-tg-allday-gutter');
    expect(gutter).toContain('text-align: right');
  });

  it('.abyss-tg-allday-gutter itself sets no font-size override, so its width: 3.5em resolves against the same ambient font-size as .abyss-tg-header-gutter/.abyss-tg-hour-gutter', () => {
    const gutter = declarationsFor('.abyss-tg-allday-gutter');
    expect(gutter).not.toMatch(/font-size/u);
  });
});

describe('Task 47: all-day band day-cells share the hour-grid day-columns’ exact layout mechanism', () => {
  it('.abyss-tg-allday-cell sets min-width: 0, so a long title cannot force the cell wider than its flex-computed share (which also misaligns it against the day-column below)', () => {
    const cell = declarationsFor('.abyss-tg-allday-cell');
    expect(cell).toMatch(/min-width:\s*0/u);
  });

  it('.abyss-tg-header-row and .abyss-tg-allday-row reserve the identical scrollbar-gutter space that .abyss-tg-grid-row (which actually scrolls) reserves, so their flex day-cells divide up the same usable width', () => {
    const gridRow = declarationsFor('.abyss-tg-grid-row');
    const headerRow = declarationsFor('.abyss-tg-header-row');
    const alldayRow = declarationsFor('.abyss-tg-allday-row');
    expect(gridRow).toContain('scrollbar-gutter: stable');
    expect(headerRow).toContain('scrollbar-gutter: stable');
    expect(alldayRow).toContain('scrollbar-gutter: stable');
    expect(headerRow).toContain('overflow-y: auto');
    expect(alldayRow).toContain('overflow-y: auto');
  });
});

describe('.abyss-tg-grid-row layout (regression: today-column outline / click-drop hit-test truncation)', () => {
  it('does not stretch day-columns to the scroll container height', () => {
    // Regression test: .abyss-tg-grid-row is a flex row whose children (the hour-gutter and each
    // day-column) hold 24 hour-rows of real content (1152px), but the row itself is a shorter,
    // scrollable viewport. Without `align-items: flex-start`, the default `stretch` sizes every
    // day-column's own box to the *visible* container height instead of its 1152px content —
    // which in turn truncates .abyss-tg-hour-column (positioned `inset: 0` to its day-column parent)
    // to that same short height, silently clipping click-to-create/drag-drop hit-testing and the
    // is-today red outline partway down the column (confirmed live: the outline stopped around
    // 17:00 in a viewport tall enough to show ~16.5 hours, while hour-row gridlines kept
    // rendering past that point as unclipped normal-flow overflow).
    const gridRow = declarationsFor('.abyss-tg-grid-row');
    expect(gridRow).toContain('align-items: flex-start');
  });
});
