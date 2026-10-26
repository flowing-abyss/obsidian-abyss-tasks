import { describe, expect, it } from 'vitest';
import {
  createTimelineNavigation,
  patchTimelineAxisCells,
  patchTimelineToday,
} from '../src/panels/timeline/timelinePresentation';
import { projectTimelineAxisLayout } from '../src/projects/projectTimelineAxis';
import { projectTimelineWindowForRange } from '../src/projects/projectTimelineModel';

const window = projectTimelineWindowForRange('2024-01-01', '2024-12-31', 'day');
function slice(start: string, end: string) {
  return projectTimelineAxisLayout(window, {
    visibleStartDay: start,
    visibleEndDay: end,
    todayDay: '2024-02-29',
  });
}

describe('retained Timeline presentation', () => {
  it.each([false, true])(
    'retains intersecting cells and label nodes while slicing (hierarchy %s)',
    (hierarchy) => {
      const host = createDiv();
      const initial = slice('2024-02-25', '2024-03-02');
      patchTimelineAxisCells(
        host,
        hierarchy ? initial.hierarchyCells : initial.cells,
        'axis-cell',
        hierarchy,
      );
      const retained = host.querySelector('[data-end-day="2024-03-02"]') ?? host.lastElementChild;
      expect(retained).not.toBeNull();
      const label = retained?.querySelector('.abyss-project-timeline-axis-label');
      const removed = host.firstElementChild;
      const next = slice('2024-03-01', '2024-03-08');
      patchTimelineAxisCells(
        host,
        hierarchy ? next.hierarchyCells : next.cells,
        'axis-cell',
        hierarchy,
      );
      expect(retained?.parentElement).toBe(host);
      expect(retained?.querySelector('.abyss-project-timeline-axis-label')).toBe(label);
      expect(removed?.parentElement).toBeNull();
      expect(host.children).toHaveLength(
        hierarchy ? next.hierarchyCells.length : next.cells.length,
      );
      expect(Array.from(host.children, (cell) => cell.getAttribute('data-start-day'))).toEqual(
        (hierarchy ? next.hierarchyCells : next.cells).map((cell) => cell.startDay),
      );
    },
  );

  it('reconciles Day and Week classes on a retained Monday while preserving Today', () => {
    const host = createDiv();
    const visible = {
      visibleStartDay: '2024-02-26',
      visibleEndDay: '2024-02-26',
      todayDay: '2024-02-26',
    };
    const dayWindow = projectTimelineWindowForRange('2024-02-26', '2024-03-03', 'day');
    const weekWindow = projectTimelineWindowForRange('2024-02-26', '2024-03-03', 'week');
    const dayCells = projectTimelineAxisLayout(dayWindow, visible).cells;
    const weekCells = projectTimelineAxisLayout(weekWindow, visible).cells;
    patchTimelineAxisCells(host, dayCells, 'abyss-project-timeline-axis-cell is-day', false);
    const monday = host.firstElementChild;
    expect(monday?.classList.contains('is-day')).toBe(true);
    expect(monday?.classList.contains('is-today')).toBe(true);
    patchTimelineAxisCells(host, weekCells, 'abyss-project-timeline-axis-cell', false);
    expect(host.firstElementChild).toBe(monday);
    expect(monday?.classList.contains('is-day')).toBe(false);
    expect(monday?.classList.contains('is-today')).toBe(true);
    expect(monday?.querySelector('.abyss-project-timeline-axis-secondary-label')).toBeNull();
    patchTimelineAxisCells(host, dayCells, 'abyss-project-timeline-axis-cell is-day', false);
    expect(host.firstElementChild).toBe(monday);
    expect(monday?.classList.contains('is-day')).toBe(true);
    expect(monday?.classList.contains('is-today')).toBe(true);
    expect(monday?.querySelector('.abyss-project-timeline-axis-secondary-label')?.textContent).toBe(
      '26',
    );
  });

  it('retains a calendar interval when the physical window clips its end differently', () => {
    const host = createDiv();
    const firstWindow = projectTimelineWindowForRange('2024-02-01', '2024-03-03', 'week');
    const nextWindow = projectTimelineWindowForRange('2024-02-01', '2024-03-02', 'week');
    const visible = { visibleStartDay: '2024-02-26', visibleEndDay: '2024-03-03' };
    patchTimelineAxisCells(
      host,
      projectTimelineAxisLayout(firstWindow, visible).cells,
      'axis-cell',
      false,
    );
    const interval = host.firstElementChild;
    patchTimelineAxisCells(
      host,
      projectTimelineAxisLayout(nextWindow, visible).cells,
      'axis-cell',
      false,
    );
    expect(host.firstElementChild).toBe(interval);
    expect(interval?.getAttribute('data-end-day')).toBe('2024-03-02');
  });

  it('updates retained labels, geometry, Today state and secondary labels without replacing cells', () => {
    const host = createDiv();
    const cells = slice('2024-02-29', '2024-02-29').cells;
    patchTimelineAxisCells(host, cells, 'axis-cell', false);
    const element = host.firstElementChild;
    const label = element?.firstElementChild;
    patchTimelineAxisCells(
      host,
      cells.map((cell) => {
        const updated = {
          ...cell,
          label: 'Updated',
          leftPercent: 10,
          rightPercent: 20,
          isToday: false,
        };
        delete updated.secondaryLabel;
        return updated;
      }),
      'axis-cell',
      false,
    );
    expect(host.firstElementChild).toBe(element);
    expect(element?.firstElementChild).toBe(label);
    expect(element?.textContent).toBe('Updated');
    expect((element as HTMLElement).style.left).toBe('10%');
    expect((element as HTMLElement).style.width).toBe('10%');
    expect(element?.classList.contains('is-today')).toBe(false);
    patchTimelineAxisCells(host, cells, 'axis-cell', false);
    expect(element?.textContent).toBe('Thu29');
  });

  it('keeps mounted cells bounded after many slices', () => {
    const host = createDiv();
    for (let day = 1; day < 25; day += 1) {
      const layout = slice(
        `2024-03-${String(day).padStart(2, '0')}`,
        `2024-03-${String(day + 6).padStart(2, '0')}`,
      );
      patchTimelineAxisCells(host, layout.cells, 'axis-cell', false);
      expect(host.children).toHaveLength(7);
    }
    patchTimelineAxisCells(host, [], 'axis-cell', false);
    expect(host.children).toHaveLength(0);
  });

  it('updates Today in place until it leaves the physical window', () => {
    const host = createDiv();
    patchTimelineToday(host, window, new Date(2024, 1, 29));
    const marker = host.firstElementChild;
    const narrower = projectTimelineWindowForRange('2024-02-01', '2024-03-31', 'day');
    patchTimelineToday(host, narrower, new Date(2024, 2, 1));
    expect(host.firstElementChild).toBe(marker);
    expect(marker?.getAttribute('aria-label')).toBe('Today, 2024-03-01');
    expect((marker as HTMLElement).style.left).toBe(`${(29.5 / 60) * 100}%`);
    patchTimelineToday(host, narrower, new Date(2024, 3, 1));
    expect(host.children).toHaveLength(0);
  });
});

it('offers only the five scale buttons, with repeated active scale delegated to its owner', () => {
  const host = createDiv();
  const selected: string[] = [];
  const buttons = createTimelineNavigation(host, { scale: (scale) => selected.push(scale) });
  expect(host.querySelector('[aria-label="Previous range"]')).toBeNull();
  expect(host.querySelector('[aria-label="Next range"]')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some((button) => button.textContent === 'Today'),
  ).toBe(false);
  expect(buttons.size).toBe(5);
  buttons.get('month')?.click();
  buttons.get('month')?.click();
  expect(selected).toEqual(['month', 'month']);
});
