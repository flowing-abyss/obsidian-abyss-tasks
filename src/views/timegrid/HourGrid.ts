import { minutesToPixels, minutesToTimeString, pixelsToMinutes, snapMinutes } from './layout';

const DROP_SNAP_MINUTES = 15;

interface DayColumnHandles {
  date: string;
  hourColumnEl: HTMLElement;
  allDayCellEl: HTMLElement;
}

export interface HourGridHandles {
  rootEl: HTMLElement;
  gridRowEl: HTMLElement;
  allDayDaysEl: HTMLElement;
  allDaySpanLayerEl: HTMLElement;
  days: DayColumnHandles[];
  /** The "now" red-line element, present only when `dates` includes today; null otherwise. */
  nowLineEl: HTMLElement | null;
}

/** Recompute and apply a now-line element's vertical position from the current time. Used both
 * at initial render and by the periodic refresh (TodayView/WeekTimeGridView) so the line doesn't
 * silently drift out of sync while the view stays mounted for a while. */
export function repositionNowLine(nowLineEl: HTMLElement): void {
  const nowMinutes = window.moment().hours() * 60 + window.moment().minutes();
  nowLineEl.style.top = `${minutesToPixels(nowMinutes)}px`;
}

/** Render the static hour-grid + all-day band skeleton for the given dates (1 = Today, 7 = Week). */
export function renderHourGrid(
  container: HTMLElement,
  dates: string[],
  onDropTime?: (dragData: string, date: string, time: string) => void,
  onCreateAtTime?: (date: string, time: string) => void,
  onDayHeaderClick?: (date: string) => void,
): HourGridHandles {
  container.empty();
  const root = container.createDiv({ cls: 'abyss-tg-root' });

  // Day headers: weekday + day number per date, so multi-column views (Week)
  // can be read without cross-referencing the nav bar's week number.
  const today = window.moment().format('YYYY-MM-DD');
  const headerRow = root.createDiv({ cls: 'abyss-tg-header-row' });
  headerRow.createDiv({ cls: 'abyss-tg-header-gutter' });
  for (const date of dates) {
    // is-clickable gates the pointer-cursor/hover affordance (CSS) so it only appears when a
    // click actually does something — e.g. Day/Today view wires no onDayHeaderClick for its
    // single header cell, so that cell must not falsely advertise itself as clickable.
    const headerCell = headerRow.createDiv({
      cls: `abyss-tg-header-cell${date === today ? ' is-today' : ''}${onDayHeaderClick ? ' is-clickable' : ''}`,
    });
    // Two separate spans (not one text node) so the day number can be styled independently of
    // the weekday abbreviation — today's accent (red, bold) applies only to the number, not the
    // whole "ddd D" string, per the Round 3 request to tone down Week's full-column red border
    // into a smaller, header-scoped accent.
    headerCell.createSpan({
      cls: 'abyss-tg-header-weekday',
      text: window.moment(date).format('ddd'),
    });
    headerCell.createSpan({
      cls: 'abyss-tg-header-day-number',
      text: window.moment(date).format('D'),
    });
    // Drill into the Day (Today) view for this specific date — same behavior as clicking a
    // Month day cell (CenterPanel's onDayClick). Optional so callers that don't need it (or
    // haven't opted in yet) pay no listener cost.
    if (onDayHeaderClick) {
      headerCell.addEventListener('click', () => {
        onDayHeaderClick(date);
      });
    }
  }

  // All-day band: one cell per date
  const alldayRow = root.createDiv({ cls: 'abyss-tg-allday-row' });
  const alldayGutter = alldayRow.createDiv({ cls: 'abyss-tg-allday-gutter' });
  // Task 47: nested label (not textContent directly on the gutter) so its smaller font-size
  // doesn't also warp the gutter's own `width: 3.5em` — see .abyss-tg-allday-gutter-label's CSS
  // doc comment (styles.css) for the alignment bug this fixes.
  alldayGutter.createSpan({ cls: 'abyss-tg-allday-gutter-label', text: 'No-time' });
  const allDayDaysEl = alldayRow.createDiv({ cls: 'abyss-tg-allday-days' });
  const alldayCells: HTMLElement[] = dates.map((date) => {
    const cell = allDayDaysEl.createDiv({ cls: 'abyss-tg-allday-cell' });
    cell.setAttribute('data-tg-date', date);
    return cell;
  });
  const allDaySpanLayerEl = allDayDaysEl.createDiv({ cls: 'abyss-tg-span-layer' });

  // Hour grid: a gutter with hour labels, plus one column per date
  const gridRow = root.createDiv({ cls: 'abyss-tg-grid-row' });
  const gutter = gridRow.createDiv({ cls: 'abyss-tg-hour-gutter' });
  for (let h = 0; h < 24; h++) {
    const label = gutter.createDiv({ cls: 'abyss-tg-hour-label' });
    label.textContent = `${h.toString().padStart(2, '0')}:00`;
  }

  let nowLineEl: HTMLElement | null = null;
  const todayIndex = dates.indexOf(today);

  const days: DayColumnHandles[] = dates.map((date, i) => {
    // No is-today class here: Round 3 removed the day-column's full-column red border (too
    // aggressive in Day view, where it boxed in the entire single-column view redundantly; too
    // noisy in Week, where it outlined one of 7 columns). "Today" is now conveyed only via the
    // header's accented day-number span above, so this column never needs the class.
    const dayColumn = gridRow.createDiv({ cls: 'abyss-tg-day-column' });
    // Lets CenterPanel locate a specific day's column from outside this module (e.g. to
    // anchor the click-to-create quick-add popover — see onCreateAtTime below).
    dayColumn.setAttribute('data-tg-date', date);
    for (let h = 0; h < 24; h++) {
      dayColumn.createDiv({ cls: 'abyss-tg-hour-row' });
    }
    const hourColumnEl = dayColumn.createDiv({ cls: 'abyss-tg-hour-column' });

    if (onDropTime) {
      hourColumnEl.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      hourColumnEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragData = e.dataTransfer?.getData('text/plain');
        if (!dragData) return;
        const offsetY = e.clientY - hourColumnEl.getBoundingClientRect().top;
        const rawMinutes = pixelsToMinutes(offsetY);
        const snapped = Math.max(0, snapMinutes(rawMinutes, DROP_SNAP_MINUTES));
        onDropTime(dragData, date, minutesToTimeString(snapped));
      });
    }

    if (onCreateAtTime) {
      // Click-to-create: fires only for a click on genuinely empty space — not on an
      // existing timed block (dragged/clicked for its own context menu) and not on the
      // quick-add popover CenterPanel renders into this same column in response.
      hourColumnEl.addEventListener('click', (e) => {
        if (
          (e.target as HTMLElement).closest(
            '.abyss-tg-block, .abyss-tg-block-continuation, .abyss-tg-quick-add',
          )
        )
          return;
        const offsetY = e.clientY - hourColumnEl.getBoundingClientRect().top;
        const rawMinutes = pixelsToMinutes(offsetY);
        const snapped = Math.max(0, snapMinutes(rawMinutes, DROP_SNAP_MINUTES));
        onCreateAtTime(date, minutesToTimeString(snapped));
      });
    }

    return { date, hourColumnEl, allDayCellEl: alldayCells[i]! };
  });

  // Now-line: a single overlay from the end of the hour gutter through every rendered day column.
  // The dot is positioned at today's column center rather than at a grid boundary, and the CSS
  // layer stays underneath each day column's interactive task layer.
  if (todayIndex !== -1) {
    nowLineEl = gridRow.createDiv({ cls: 'abyss-tg-now-line' });
    nowLineEl.createDiv({ cls: 'abyss-tg-now-line-dot' });
    const dot = nowLineEl.querySelector<HTMLElement>('.abyss-tg-now-line-dot');
    if (dot) dot.style.left = `${((todayIndex + 0.5) / dates.length) * 100}%`;
    repositionNowLine(nowLineEl);
  }

  return { rootEl: root, gridRowEl: gridRow, allDayDaysEl, allDaySpanLayerEl, days, nowLineEl };
}
