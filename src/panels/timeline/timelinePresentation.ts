import { setIcon } from 'obsidian';
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
  clampLabel: boolean,
): void {
  host.empty();
  for (const cell of cells) {
    const element = host.createSpan({ cls: className });
    element.dataset['startDay'] = cell.startDay;
    element.dataset['endDay'] = cell.endDay;
    element.style.left = `${String(cell.leftPercent)}%`;
    element.style.width = `${String(cell.rightPercent - cell.leftPercent)}%`;
    element.toggleClass('is-today', cell.isToday);
    const labelHost = clampLabel
      ? element.createSpan({ cls: 'abyss-project-timeline-axis-hierarchy-label' })
      : element;
    if (clampLabel) {
      const cellWidth = Math.max(Number.EPSILON, cell.rightPercent - cell.leftPercent);
      labelHost.style.left = `${String(
        ((cell.labelPercent - cell.leftPercent) / cellWidth) * 100,
      )}%`;
    }
    labelHost.createSpan({ cls: 'abyss-project-timeline-axis-label', text: cell.label });
    if (cell.secondaryLabel !== undefined) {
      labelHost.createSpan({
        cls: 'abyss-project-timeline-axis-secondary-label',
        text: cell.secondaryLabel,
      });
    }
  }
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
    readonly previous: () => void;
    readonly next: () => void;
    readonly today: () => void;
    readonly scale: (scale: ProjectTimelineScale) => void;
  },
): Map<ProjectTimelineScale, HTMLButtonElement> {
  const navigation = host.createDiv({ cls: 'abyss-project-timeline-navigation' });
  const range = navigation.createDiv({ cls: 'abyss-project-timeline-range-navigation' });
  const previous = range.createEl('button', {
    cls: 'clickable-icon abyss-cal-nav-btn',
    attr: { type: 'button', 'aria-label': 'Previous range' },
  });
  setIcon(previous, 'chevron-left');
  previous.addEventListener('click', actions.previous);
  const today = range.createEl('button', {
    cls: 'abyss-cal-nav-today',
    text: 'Today',
    attr: { type: 'button' },
  });
  today.addEventListener('click', actions.today);
  const next = range.createEl('button', {
    cls: 'clickable-icon abyss-cal-nav-btn',
    attr: { type: 'button', 'aria-label': 'Next range' },
  });
  setIcon(next, 'chevron-right');
  next.addEventListener('click', actions.next);
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
  host.querySelector(':scope > .abyss-project-timeline-today')?.remove();
  const today = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const offset =
    (projectCalendarDayOrdinal(today) as number) -
    (projectCalendarDayOrdinal(window.startDay) as number);
  if (offset < 0 || offset >= window.dayCount) return;
  const marker = host.createDiv({
    cls: 'abyss-project-timeline-today',
    attr: { 'aria-label': `Today, ${today}` },
  });
  marker.style.left = `${((offset + 0.5) / window.dayCount) * 100}%`;
}
