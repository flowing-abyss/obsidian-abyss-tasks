import { projectCalendarDayOrdinal } from '../../projects/projectDateValue';
import type {
  ProjectTimelineAxisCell,
  ProjectTimelineAxisLayout,
} from '../../projects/projectTimelineAxis';
import type { ProjectTimelineWindow } from '../../projects/projectTimelineModel';
import type { ProjectTimelineScale } from '../../projects/projectTimelineSettings';

export const TIMELINE_SCALES = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['quarter', 'Quarter'],
  ['year', 'Year'],
] as const;

export function createTimelineRangeHandle(
  bar: HTMLElement,
  endpoint: 'start' | 'end',
): HTMLElement {
  const handle = bar.createSpan({
    cls: `abyss-project-timeline-handle is-${endpoint}`,
    attr: { 'data-timeline-part': endpoint, 'aria-hidden': 'true' },
  });
  handle.createSpan({ cls: 'abyss-project-timeline-grip' });
  return handle;
}

export function patchTimelineAxisCells(
  host: HTMLElement,
  cells: readonly ProjectTimelineAxisCell[],
  className: string,
): void {
  const retained = new Map(
    Array.from(host.querySelectorAll<HTMLElement>(':scope > span'), (element) => [
      element.dataset['startDay'],
      element,
    ]),
  );
  let cursor = host.firstElementChild;
  for (const cell of cells) {
    let element = retained.get(cell.startDay);
    if (element === undefined) {
      element = host.createSpan();
      element.dataset['startDay'] = cell.startDay;
    }
    element.dataset['endDay'] = cell.endDay;
    retained.delete(cell.startDay);
    if (element !== cursor) host.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
    setPercent(element, 'left', cell.leftPercent);
    setPercent(element, 'width', cell.rightPercent - cell.leftPercent);
    element.className = className;
    element.toggleClass('is-today', cell.isToday);
    const labelHost =
      element.querySelector<HTMLElement>(':scope > .abyss-project-timeline-axis-label-content') ??
      element.createSpan({ cls: 'abyss-project-timeline-axis-label-content' });
    const cellWidth = Math.max(Number.EPSILON, cell.rightPercent - cell.leftPercent);
    setPercent(labelHost, 'left', ((cell.labelPercent - cell.leftPercent) / cellWidth) * 100);
    patchAxisLabel(labelHost, 'abyss-project-timeline-axis-label', cell.label);
    patchAxisLabel(labelHost, 'abyss-project-timeline-axis-secondary-label', cell.secondaryLabel);
  }
  for (const element of retained.values()) element.remove();
}

function setPercent(element: HTMLElement, property: 'left' | 'width', value: number): void {
  const percent = `${value}%`;
  if (element.style[property] !== percent) element.style[property] = percent;
}

function patchAxisLabel(host: HTMLElement, className: string, text: string | undefined): void {
  const existing = host.querySelector<HTMLElement>(`:scope > .${className}`);
  if (text === undefined) {
    existing?.remove();
    return;
  }
  const label = existing ?? host.createSpan({ cls: className });
  if (label.textContent !== text) label.textContent = text;
}

export function patchTimelineGrid(grid: HTMLElement, layout: ProjectTimelineAxisLayout): void {
  const boundaries = layout.gridBoundaries;
  while (grid.children.length > boundaries.length) grid.lastElementChild?.remove();
  while (grid.children.length < boundaries.length) {
    grid.createSpan({ cls: 'abyss-project-timeline-gridline' });
  }
  for (const [index, boundary] of boundaries.entries()) {
    const line = grid.children.item(index);
    if (!(line instanceof HTMLElement)) continue;
    line.dataset['day'] = boundary.day;
    line.className = `abyss-project-timeline-gridline is-${boundary.weight}`;
    line.style.left = `${String(boundary.leftPercent)}%`;
  }
}

export function createTimelineNavigation(
  host: HTMLElement,
  actions: {
    readonly scale: (scale: ProjectTimelineScale) => void;
  },
): Map<ProjectTimelineScale, HTMLButtonElement> {
  const navigation = host.createDiv({ cls: 'abyss-project-timeline-navigation' });
  const scales = navigation.createDiv({
    cls: 'abyss-project-timeline-scale-control abyss-cal-view-switcher',
    attr: { role: 'group', 'aria-label': 'Timeline scale' },
  });
  return new Map(
    TIMELINE_SCALES.map(([scale, label]) => {
      const button = scales.createEl('button', {
        cls: 'abyss-cal-view-btn',
        text: label,
        attr: { type: 'button' },
      });
      button.addEventListener('click', () => {
        actions.scale(scale);
      });
      return [scale, button];
    }),
  );
}

/** Header and row markers use the same civil-day position in every timeline. */
export function patchTimelineToday(
  host: HTMLElement,
  window: ProjectTimelineWindow,
  now: Date,
): void {
  const existing = host.querySelector<HTMLElement>(':scope > .abyss-project-timeline-today');
  const today = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const offset =
    (projectCalendarDayOrdinal(today) as number) -
    (projectCalendarDayOrdinal(window.startDay) as number);
  if (offset < 0 || offset >= window.dayCount) {
    existing?.remove();
    return;
  }
  const marker = existing ?? host.createDiv({ cls: 'abyss-project-timeline-today' });
  const label = `Today, ${today}`;
  if (marker.getAttribute('aria-label') !== label) marker.setAttribute('aria-label', label);
  setPercent(marker, 'left', ((offset + 0.5) / window.dayCount) * 100);
}
