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
    const cell = row.createEl(onDayHeaderClick === undefined ? 'div' : 'button', {
      cls: `abyss-tg-header-cell${date === today ? ' is-today' : ''}${onDayHeaderClick === undefined ? '' : ' is-clickable'}`,
    });
    cell.createSpan({ cls: 'abyss-tg-header-weekday', text: window.moment(date).format('ddd') });
    cell.createSpan({
      cls: 'abyss-tg-header-day-number',
      text: window.moment(date).format('D'),
    });
    if (onDayHeaderClick !== undefined) {
      cell.setAttribute('type', 'button');
      cell.setAttribute('aria-label', date);
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
    const snapped = Math.min(
      24 * 60 - DROP_SNAP_MINUTES,
      Math.max(0, snapMinutes(pixelsToMinutes(offsetY), DROP_SNAP_MINUTES)),
    );
    onCreateAtTime(date, minutesToTimeString(snapped));
  });
}

function renderDayColumns(
  row: HTMLElement,
  dates: readonly string[],
  allDayCells: readonly HTMLElement[],
  callbacks: {
    readonly today: string;
    readonly onDropTime?: DropTimeCallback;
    readonly onCreateAtTime?: CreateAtTimeCallback;
  },
): DayColumnHandles[] {
  return dates.map((date, index) => {
    const dayColumn = row.createDiv({ cls: 'abyss-tg-day-column' });
    dayColumn.toggleClass('is-today', date === callbacks.today);
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
  line.createDiv({ cls: 'abyss-tg-now-track' });
  const today = line.createDiv({ cls: 'abyss-tg-now-today' });
  const left = `${(todayIndex / dateCount) * 100}%`;
  today.style.left = left;
  today.style.width = `${100 / dateCount}%`;
  const dot = line.createDiv({ cls: 'abyss-tg-now-line-dot' });
  dot.style.left = left;
  line.createSpan({ cls: 'abyss-tg-now-label' });
  repositionNowLine(line);
  return line;
}

/** Recompute and apply a now-line element's vertical position from the current time. Used both
 * at initial render and by the periodic refresh (TodayView/WeekTimeGridView) so the line doesn't
 * silently drift out of sync while the view stays mounted for a while. */
export function repositionNowLine(nowLineEl: HTMLElement): void {
  const now = window.moment();
  const nowMinutes = now.hours() * 60 + now.minutes();
  const top = `${minutesToPixels(nowMinutes)}px`;
  nowLineEl.style.top = top;
  const row = nowLineEl.parentElement;
  row?.setCssProps({ '--abyss-tg-now-top': top });
  const label = nowLineEl.querySelector('.abyss-tg-now-label');
  if (label !== null) label.textContent = minutesToTimeString(nowMinutes);
  row?.querySelectorAll('.abyss-tg-hour-label').forEach((hour, index) => {
    hour.classList.toggle('is-obscured-by-now', Math.abs(index * 60 - nowMinutes) <= 20);
  });
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
  const content = root.createDiv({ cls: 'abyss-tg-content' });
  const allDay = renderAllDayBand(content, dates);
  const gridRow = renderGridRow(content);
  const days = renderDayColumns(gridRow, dates, allDay.cells, {
    today,
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
