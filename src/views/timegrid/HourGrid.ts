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

interface AllDayBand {
  readonly days: HTMLElement;
  readonly cells: readonly HTMLElement[];
  readonly spanLayer: HTMLElement;
}

type DropTimeCallback = (dragData: string, date: string, time: string) => void;
type CreateAtTimeCallback = (date: string, time: string) => void;

function renderDayHeaders(
  root: HTMLElement,
  dates: readonly string[],
  today: string,
  onDayHeaderClick: ((date: string) => void) | undefined,
): void {
  const row = root.createDiv({ cls: 'abyss-tg-header-row' });
  row.createDiv({ cls: 'abyss-tg-header-gutter' });
  for (const date of dates) {
    const cell = row.createDiv({
      cls: `abyss-tg-header-cell${date === today ? ' is-today' : ''}${onDayHeaderClick === undefined ? '' : ' is-clickable'}`,
    });
    cell.createSpan({ cls: 'abyss-tg-header-weekday', text: window.moment(date).format('ddd') });
    cell.createSpan({
      cls: 'abyss-tg-header-day-number',
      text: window.moment(date).format('D'),
    });
    if (onDayHeaderClick !== undefined) {
      cell.addEventListener('click', () => {
        onDayHeaderClick(date);
      });
    }
  }
}

function renderAllDayBand(root: HTMLElement, dates: readonly string[]): AllDayBand {
  const row = root.createDiv({ cls: 'abyss-tg-allday-row' });
  row
    .createDiv({ cls: 'abyss-tg-allday-gutter' })
    .createSpan({ cls: 'abyss-tg-allday-gutter-label', text: 'No-time' });
  const days = row.createDiv({ cls: 'abyss-tg-allday-days' });
  const cells = dates.map((date) => {
    const cell = days.createDiv({ cls: 'abyss-tg-allday-cell' });
    cell.setAttribute('data-tg-date', date);
    return cell;
  });
  return { days, cells, spanLayer: days.createDiv({ cls: 'abyss-tg-span-layer' }) };
}

function renderGridRow(root: HTMLElement): HTMLElement {
  const row = root.createDiv({ cls: 'abyss-tg-grid-row' });
  const gutter = row.createDiv({ cls: 'abyss-tg-hour-gutter' });
  for (let hour = 0; hour < 24; hour++) {
    gutter.createDiv({
      cls: 'abyss-tg-hour-label',
      text: `${hour.toString().padStart(2, '0')}:00`,
    });
  }
  return row;
}

function bindDropTime(column: HTMLElement, date: string, onDropTime: DropTimeCallback): void {
  column.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  column.addEventListener('drop', (event) => {
    event.preventDefault();
    const dragData = event.dataTransfer?.getData('text/plain');
    if (dragData === undefined || dragData.length === 0) return;
    const offsetY = event.clientY - column.getBoundingClientRect().top;
    const snapped = Math.max(0, snapMinutes(pixelsToMinutes(offsetY), DROP_SNAP_MINUTES));
    onDropTime(dragData, date, minutesToTimeString(snapped));
  });
}

function bindCreateAtTime(
  column: HTMLElement,
  date: string,
  onCreateAtTime: CreateAtTimeCallback,
): void {
  column.addEventListener('click', (event) => {
    const blockedTarget = (event.target as HTMLElement).closest(
      '.abyss-tg-block, .abyss-tg-block-continuation, .abyss-tg-quick-add',
    );
    if (blockedTarget !== null) return;
    const offsetY = event.clientY - column.getBoundingClientRect().top;
    const snapped = Math.max(0, snapMinutes(pixelsToMinutes(offsetY), DROP_SNAP_MINUTES));
    onCreateAtTime(date, minutesToTimeString(snapped));
  });
}

function renderDayColumns(
  row: HTMLElement,
  dates: readonly string[],
  allDayCells: readonly HTMLElement[],
  callbacks: {
    readonly onDropTime?: DropTimeCallback;
    readonly onCreateAtTime?: CreateAtTimeCallback;
  },
): DayColumnHandles[] {
  return dates.map((date, index) => {
    const dayColumn = row.createDiv({ cls: 'abyss-tg-day-column' });
    dayColumn.setAttribute('data-tg-date', date);
    for (let hour = 0; hour < 24; hour++) dayColumn.createDiv({ cls: 'abyss-tg-hour-row' });
    const hourColumnEl = dayColumn.createDiv({ cls: 'abyss-tg-hour-column' });
    if (callbacks.onDropTime !== undefined) bindDropTime(hourColumnEl, date, callbacks.onDropTime);
    if (callbacks.onCreateAtTime !== undefined) {
      bindCreateAtTime(hourColumnEl, date, callbacks.onCreateAtTime);
    }
    const allDayCellEl = allDayCells[index];
    if (allDayCellEl === undefined) throw new Error('Missing all-day cell for hour-grid column');
    return { date, hourColumnEl, allDayCellEl };
  });
}

function renderNowLine(
  row: HTMLElement,
  todayIndex: number,
  dateCount: number,
): HTMLElement | null {
  if (todayIndex === -1) return null;
  const line = row.createDiv({ cls: 'abyss-tg-now-line' });
  const dot = line.createDiv({ cls: 'abyss-tg-now-line-dot' });
  dot.style.left = `${((todayIndex + 0.5) / dateCount) * 100}%`;
  repositionNowLine(line);
  return line;
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
  ...callbacks: [
    onDropTime?: DropTimeCallback,
    onCreateAtTime?: CreateAtTimeCallback,
    onDayHeaderClick?: (date: string) => void,
  ]
): HourGridHandles {
  const [onDropTime, onCreateAtTime, onDayHeaderClick] = callbacks;
  container.empty();
  const root = container.createDiv({ cls: 'abyss-tg-root' });
  const today = window.moment().format('YYYY-MM-DD');
  renderDayHeaders(root, dates, today, onDayHeaderClick);
  const allDay = renderAllDayBand(root, dates);
  const gridRow = renderGridRow(root);
  const days = renderDayColumns(gridRow, dates, allDay.cells, {
    ...(onDropTime === undefined ? {} : { onDropTime }),
    ...(onCreateAtTime === undefined ? {} : { onCreateAtTime }),
  });
  const nowLineEl = renderNowLine(gridRow, dates.indexOf(today), dates.length);
  return {
    rootEl: root,
    gridRowEl: gridRow,
    allDayDaysEl: allDay.days,
    allDaySpanLayerEl: allDay.spanLayer,
    days,
    nowLineEl,
  };
}
