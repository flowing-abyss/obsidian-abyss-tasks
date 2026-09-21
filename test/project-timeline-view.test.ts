import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectsTimelineView,
  type ProjectTimelineCellContext,
} from '../src/panels/projects/ProjectsTimelineView';
import type { ProjectColumn, ProjectFieldCatalogItem } from '../src/projects/projectFields';
import { buildDefaultProjectTableSettings } from '../src/projects/projectTableSettings';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, freshContainer, loadPluginStyles } from './helpers';

interface Cell extends ProjectTimelineCellContext {
  project: Project;
  field: ProjectFieldCatalogItem;
  column?: ProjectColumn;
}

const fields: ProjectFieldCatalogItem[] = [
  { id: 'name', label: 'Name', type: 'name' },
  { id: 'status', label: 'Status', type: 'status' },
  { id: 'start', label: 'Start', type: 'date', property: 'start' },
  { id: 'end', label: 'End', type: 'date', property: 'end' },
  { id: 'progress', label: 'Progress', type: 'progress' },
  { id: 'property:Priority', label: 'Priority', type: 'text', property: 'Priority' },
];

function project(path: string, start?: unknown, end?: unknown): Project {
  return {
    path,
    name: path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
    frontmatter: {
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    },
    tags: [],
    statusId: DEFAULT_SETTINGS.projects.statuses[0]?.id ?? null,
    rawStatus: null,
    stats: {
      total: 4,
      done: 2,
      cancelled: 0,
      inProgress: 1,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
  };
}

const mounted = new Set<ProjectsTimelineView<Cell>>();

afterEach(() => {
  for (const view of mounted) view.destroy();
  mounted.clear();
  activeDocument.body.empty();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(
  projects: Project[],
  now = new Date(2026, 8, 13),
  scale?: ReturnType<typeof buildDefaultProjectTimelineSettings>['scale'],
) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const settings = buildDefaultProjectTimelineSettings(buildDefaultProjectTableSettings());
  if (scale !== undefined) settings.scale = scale;
  const selected: Cell[] = [];
  const openRangeMenu = vi.fn();
  const mountedView: { current?: ProjectsTimelineView<Cell> } = {};
  const view = new ProjectsTimelineView<Cell>(host, {
    settings: () => settings,
    modelInput: () => ({
      nowMs: Date.UTC(2026, 8, 20),
      fields,
      statuses: DEFAULT_SETTINGS.projects.statuses,
    }),
    renderCell: ({ host: cellHost, project: item, field, column, occurrenceId, existing }) => {
      const cell = existing ?? {
        element: cellHost,
        identity: { projectPath: item.path, columnId: field.id, occurrenceId },
        project: item,
        field,
      };
      cell.project = item;
      cell.field = field;
      if (column === undefined) delete cell.column;
      else cell.column = column;
      cell.element.dataset['fieldId'] = field.id;
      cell.element.dataset['columnLabel'] = column?.label;
      cell.element.dataset['dateDisplay'] = column?.dateDisplay;
      cell.element.tabIndex = 0;
      const value = item.frontmatter[field.property ?? ''];
      cell.element.setText(typeof value === 'string' ? value : item.name);
      return cell;
    },
    selectCell: (cell) => {
      selected.push(cell);
    },
    requestViewChange: async (mutation) => {
      mutation();
      mountedView.current?.update(projects, '');
      return true;
    },
    requestNavigation: (action) => {
      action();
    },
    requestScaleChange: async (nextScale) => {
      mountedView.current?.prepareScaleChange();
      settings.scale = nextScale;
      mountedView.current?.update(projects, '');
      return true;
    },
    renderGroupContent: (_marker, label, group) => {
      label.setText(group.label);
    },
    statusColor: () => '#336699',
    captureRangeSource: () => ({ kind: 'rejected', reason: 'Test capture unavailable' }),
    commitRangeEdit: vi.fn().mockResolvedValue({ applied: [], failed: [] }),
    reportRangeFailure: vi.fn(),
    finishEditor: async () => true,
    openRangeMenu,
    now: () => new Date(now),
  });
  mountedView.current = view;
  mounted.add(view);
  view.mount(projects, '');
  return { host, view, settings, selected, openRangeMenu };
}

function geometry(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 40,
    width,
    height: 40,
    toJSON: () => ({}),
  };
}

function mockTimelineGeometry(
  host: HTMLElement,
  view: ProjectsTimelineView<Cell>,
  options: {
    readonly summaryWidth: number;
    readonly trackWidth: number;
    readonly viewportWidth: number;
    readonly outerViewportWidth?: number;
  },
): void {
  const { summaryWidth, trackWidth, viewportWidth } = options;
  const outerViewportWidth = options.outerViewportWidth ?? viewportWidth;
  const axis = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-axis'));
  Object.defineProperty(axis, 'scrollWidth', {
    configurable: true,
    value: summaryWidth + trackWidth + 40,
  });
  Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: viewportWidth });
  Object.defineProperty(view.scroll, 'offsetWidth', {
    configurable: true,
    value: outerViewportWidth,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('abyss-project-timeline-scroll')) {
      return geometry(0, outerViewportWidth);
    }
    if (this.classList.contains('abyss-project-timeline-axis-summary')) {
      return geometry(0, summaryWidth);
    }
    if (this.classList.contains('abyss-project-timeline-axis-dates')) {
      return geometry(summaryWidth - view.scroll.scrollLeft, trackWidth);
    }
    return geometry(0, 0);
  });
}

describe('ProjectsTimelineView', () => {
  it('names simultaneous Timeline scroll surfaces without native hover labels', () => {
    const first = mount([]);
    const second = mount([]);
    const scrolls = [first.host, second.host].map((host) =>
      expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-scroll')),
    );
    const labelIds = scrolls.map((scroll) => expectDefined(scroll.getAttribute('aria-labelledby')));

    expect(new Set(labelIds).size).toBe(2);
    for (const scroll of scrolls) {
      expect(scroll.hasAttribute('aria-label')).toBe(false);
      expect(scroll.hasAttribute('title')).toBe(false);
      expect(
        scroll.ownerDocument.getElementById(expectDefined(scroll.getAttribute('aria-labelledby')))
          ?.textContent,
      ).toBe('Project Timeline');
      expect(scroll.getAttribute('aria-describedby')).toMatch(
        /^abyss-project-timeline-axis-range-/u,
      );
    }
  });

  it('retains all navigation controls inside the sticky axis corner as its range changes', () => {
    const projects = [
      project('Projects/Early.md', '2026-09-10', '2026-09-10'),
      project('Projects/Late.md', '2026-09-19', '2026-09-20'),
    ];
    const { host, view } = mount(projects);
    const root = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline'));
    const axisSummary = expectDefined(
      root.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
    );
    const navigation = expectDefined(
      axisSummary.querySelector<HTMLElement>('.abyss-project-timeline-navigation'),
    );
    const rangeNavigation = expectDefined(
      navigation.querySelector<HTMLElement>('.abyss-project-timeline-range-navigation'),
    );
    const scaleControl = expectDefined(
      navigation.querySelector<HTMLElement>('.abyss-project-timeline-scale-control'),
    );
    const range = expectDefined(
      axisSummary.querySelector<HTMLElement>('.abyss-project-timeline-axis-range'),
    );
    const descriptionId = expectDefined(view.scroll.getAttribute('aria-describedby'));
    const rangeButtons = Array.from(rangeNavigation.querySelectorAll<HTMLButtonElement>('button'));
    const scaleButtons = Array.from(scaleControl.querySelectorAll<HTMLButtonElement>('button'));
    const buttons = [...rangeButtons, ...scaleButtons];

    expect(navigation.parentElement).toBe(axisSummary);
    expect(root.querySelector(':scope > .abyss-project-timeline-navigation')).toBeNull();
    expect(Array.from(navigation.children)).toEqual([rangeNavigation, scaleControl]);
    expect(range.classList).toContain('abyss-sr-only');
    expect(range.id).toBe(descriptionId);
    expect(root.querySelector(`#${descriptionId}`)).toBe(range);
    expect(rangeButtons.map(({ ariaLabel, textContent }) => [ariaLabel, textContent])).toEqual([
      ['Previous range', ''],
      [null, 'Today'],
      ['Next range', ''],
    ]);
    expect(scaleButtons.map(({ textContent }) => textContent)).toEqual([
      'Day',
      'Week',
      'Month',
      'Quarter',
      'Year',
    ]);
    expect(buttons).toHaveLength(8);

    rangeButtons[0]?.click();
    expect(range.textContent).toBe('2025-01-01 – 2025-12-31');
    rangeButtons[1]?.click();
    expect(range.textContent).toBe('2026-01-01 – 2026-12-31');
    rangeButtons[2]?.click();
    expect(range.textContent).toBe('2027-01-01 – 2027-12-31');

    const expectedBounds = [
      '2026-09-10 – 2026-09-20',
      '2026-09-07 – 2026-09-20',
      '2026-09-01 – 2026-09-30',
      '2026-07-01 – 2026-09-30',
      '2025-01-01 – 2028-12-31',
    ];
    for (const [index, button] of scaleButtons.entries()) {
      button.focus();
      button.click();
      expect(range.textContent).toBe(expectedBounds[index]);
      expect(activeDocument.activeElement).toBe(button);
    }

    view.update(projects, '');

    expect(axisSummary.querySelector('.abyss-project-timeline-axis-range')).toBe(range);
    expect(Array.from(navigation.querySelectorAll('button'))).toEqual(buttons);
    expect(view.scroll.getAttribute('aria-describedby')).toBe(descriptionId);
  });

  it('retains a keyed row, focused date cell, and scroll during an ordinary update', () => {
    const item = project('Projects/A.md', '2026-09-01', '2026-09-30');
    const { host, view } = mount([item]);
    const row = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );
    const start = expectDefined(row.querySelector<HTMLElement>('[data-field-id="start"]'));
    const scroll = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-scroll'));
    start.focus();
    scroll.scrollLeft = 180;
    scroll.scrollTop = 44;

    view.update([{ ...item, stats: { ...item.stats, done: 3 } }], '');

    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(start);
    expect(scroll.scrollLeft).toBe(180);
    expect(scroll.scrollTop).toBe(44);
  });

  it('shows malformed, open, and unscheduled states instead of dropping rows', () => {
    const { host } = mount([
      project('Projects/Malformed.md', 'later', '2026-09-03'),
      project('Projects/Open.md', '2026-09-04'),
      project('Projects/Unscheduled.md'),
    ]);

    expect(host.querySelectorAll('.abyss-project-timeline-row')).toHaveLength(3);
    expect(
      host.querySelector('[data-project-path="Projects/Malformed.md"] .is-malformed'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-project-path="Projects/Open.md"] .is-open-end'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-project-path="Projects/Unscheduled.md"]')?.textContent,
    ).toContain('Unscheduled');
  });

  it('keeps unscheduled ranges out of the timeline geometry', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([project('Projects/Unscheduled.md')]);
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));

    expect(host.querySelector('.abyss-project-timeline-show-range')).toBeNull();
    expect(activeWindow.getComputedStyle(bar).display).toBe('none');
    sheet.remove();
  });

  it('layers selected sticky summaries over an opaque primary background', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
    const row = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-row'));
    const summary = expectDefined(
      row.querySelector<HTMLElement>('.abyss-project-timeline-summary'),
    );
    summary.click();

    expect(row.classList).toContain('is-selected');
    expect(activeWindow.getComputedStyle(summary).backgroundImage).not.toBe('none');
    sheet.remove();
  });

  it('keeps malformed range state aligned with the exposed date viewport while scrolling', () => {
    const { host, view } = mount([
      project('Projects/Invalid.md', '2026-09-20', '2026-09-10'),
      project('Projects/Future.md', undefined, '2032-01-03'),
    ]);

    view.scroll.scrollLeft = 173.5;
    view.scroll.dispatchEvent(new Event('scroll'));

    expect(view.root.style.getPropertyValue('--abyss-project-timeline-range-state-left')).toBe(
      '183.5px',
    );
    expect(host.querySelector('.abyss-project-timeline-state')).not.toBeNull();
    expect(host.querySelector('.abyss-project-timeline-show-range')).toBeNull();
  });

  it('shows clipped endpoint handles only when their calendar day is visible', () => {
    const { host } = mount([project('Projects/Clipped.md', '2025-12-30', '2026-01-03')]);
    const bar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Clipped.md"] .abyss-project-timeline-bar',
      ),
    );

    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
      ).hidden,
    ).toBe(true);
    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
      ).hidden,
    ).toBe(false);
  });

  it.each([
    ['open-start', project('Projects/Open start.md', undefined, '2026-09-08')],
    ['open-end', project('Projects/Open end.md', '2026-09-08')],
  ] as const)('keeps both endpoint handles reachable for an %s range', (_kind, item) => {
    const { host } = mount([item]);
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));

    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
      ).hidden,
    ).toBe(false);
    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
      ).hidden,
    ).toBe(false);
    if (_kind === 'open-start') {
      expect(bar.style.getPropertyValue('--abyss-project-timeline-range-left')).toMatch(
        /^calc\(.+% - max\(40px, .+%\)\)$/u,
      );
    }
  });

  it('uses a compact bounded marker for a one-date range', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount(
      [project('Projects/One date.md', '2026-09-10', '2026-09-10')],
      new Date(2026, 8, 13),
      'day',
    );
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));
    const start = expectDefined(
      bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
    );
    const end = expectDefined(
      bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
    );

    expect(bar.classList).toContain('is-one-date');
    expect(bar.style.getPropertyValue('--abyss-project-timeline-one-date-center')).toBe('');
    expect(bar.style.getPropertyValue('--abyss-project-timeline-range-left')).toMatch(/^[\d.]+%$/u);
    expect(bar.style.left).toBe('');
    expect(start.parentElement).toBe(bar);
    expect(end.parentElement).toBe(bar);
    expect(Number.parseFloat(activeWindow.getComputedStyle(bar).minWidth)).toBe(40);
    expect(Number.parseFloat(activeWindow.getComputedStyle(start).width)).toBeGreaterThanOrEqual(
      14,
    );
    expect(Number.parseFloat(activeWindow.getComputedStyle(end).width)).toBeGreaterThanOrEqual(14);
    expect(Number.parseFloat(activeWindow.getComputedStyle(start).height)).toBeGreaterThanOrEqual(
      24,
    );
    expect(Number.parseFloat(activeWindow.getComputedStyle(end).height)).toBeGreaterThanOrEqual(24);
    expect(start.querySelector('.abyss-project-timeline-grip')).not.toBeNull();
    expect(end.querySelector('.abyss-project-timeline-grip')).not.toBeNull();
    sheet.remove();
  });

  it('keeps a compact multi-day range inside the fitted right boundary', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([
      project('Projects/Anchor.md', '2026-01-01'),
      project('Projects/Year end.md', '2028-12-30', '2028-12-31'),
    ]);
    const year = expectDefined(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
      ).find(({ textContent }) => textContent === 'Year'),
    );

    year.click();

    const bar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Year end.md"] .abyss-project-timeline-bar',
      ),
    );
    expect(bar.classList).not.toContain('is-one-date');
    const rangeLeft = bar.style.getPropertyValue('--abyss-project-timeline-range-left');
    expect(Number.parseFloat(rangeLeft)).toBeCloseTo((1459 / 1461) * 100);
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo((2 / 1461) * 100);
    expect(bar.style.left).toBe('');
    const compactRule = expectDefined(
      Array.from(sheet.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === '.abyss-project-timeline-bar',
      ),
    );
    expect(compactRule.style.left.replace(/\s+/gu, ' ')).toBe(
      'max(0px, min(var(--abyss-project-timeline-range-left), 100% - 40px))',
    );
    const trackWidth = 640;
    const sourceLeft = (Number.parseFloat(rangeLeft) / 100) * trackWidth;
    const visualLeft = Math.max(0, Math.min(sourceLeft, trackWidth - 40));
    expect(visualLeft).toBe(600);
    expect(visualLeft + 40).toBe(trackWidth);
    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
      ).hidden,
    ).toBe(false);
    expect(
      expectDefined(
        bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
      ).hidden,
    ).toBe(false);
    sheet.remove();
  });

  it('keeps range control names accessible without visible or native hover text', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
    const track = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-track'));
    const bar = expectDefined(track.querySelector<HTMLElement>('.abyss-project-timeline-bar'));
    const nameId = expectDefined(bar.getAttribute('aria-labelledby'));
    const descriptionId = expectDefined(bar.getAttribute('aria-describedby'));

    expect(bar.hasAttribute('aria-label')).toBe(false);
    expect(track.hasAttribute('aria-label')).toBe(false);
    expect(bar.getAttribute('title')).toBeNull();
    expect(track.getAttribute('title')).toBeNull();
    const name = expectDefined(host.querySelector<HTMLElement>(`#${nameId}`));
    expect(name.textContent).toBe('Timeline dates for A: 2026-09-01 through 2026-09-03');
    expect(expectDefined(host.querySelector<HTMLElement>(`#${descriptionId}`)).textContent).toBe(
      'Test capture unavailable',
    );
    const hiddenStyle = activeWindow.getComputedStyle(name);
    expect(hiddenStyle.position).toBe('absolute');
    expect(hiddenStyle.width).toBe('1px');
    expect(hiddenStyle.height).toBe('1px');
    expect(hiddenStyle.clipPath).toBe('inset(50%)');
    sheet.remove();
  });

  it('routes a handle context menu through the shared range menu', () => {
    const { host, openRangeMenu } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
    const handle = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
    );
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    handle.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openRangeMenu).toHaveBeenCalledOnce();
  });

  it('aligns a bounded row grid to the visible calendar boundaries', () => {
    const { host } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
    const cells = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-timeline-axis .abyss-project-timeline-axis-cell',
      ),
    );
    const firstGrid = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-track .abyss-project-timeline-grid'),
    );
    const lines = Array.from(
      firstGrid.querySelectorAll<HTMLElement>('.abyss-project-timeline-gridline'),
    );

    expect(cells.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(80);
    expect(lines.map(({ dataset }) => dataset['day'])).toContain(cells[0]?.dataset['startDay']);
    expect(lines.every(({ style }) => Number.isFinite(Number.parseFloat(style.left)))).toBe(true);
  });

  it('patches only visible axis and grid cells while a long Day range scrolls', async () => {
    vi.useFakeTimers();
    const projects = [
      project('Projects/Early.md', '2024-01-01', '2024-01-02'),
      project('Projects/Late.md', '2024-12-30', '2024-12-31'),
    ];
    const { host, view } = mount(projects, new Date(2024, 1, 29), 'month');
    const dayButton = expectDefined(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
      ).find(({ textContent }) => textContent === 'Day'),
    );
    dayButton.click();
    await Promise.resolve();
    const bar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Early.md"] .abyss-project-timeline-bar',
      ),
    );
    const trackWidth = 366 * 32;
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth,
      viewportWidth: 610,
    });
    const firstBefore = host.querySelector<HTMLElement>(
      '.abyss-project-timeline-axis-cell[data-start-day]',
    )?.dataset['startDay'];

    view.scroll.scrollLeft = 180 * 32;
    view.scroll.dispatchEvent(new Event('scroll'));
    await vi.runAllTimersAsync();

    const visibleCells = Array.from(
      host.querySelectorAll<HTMLElement>('.abyss-project-timeline-axis-cell'),
    );
    expect(visibleCells[0]?.dataset['startDay']).not.toBe(firstBefore);
    expect(visibleCells.length).toBeLessThanOrEqual(16);
    expect(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Early.md"] .abyss-project-timeline-bar',
      ),
    ).toBe(bar);
    expect(
      Math.max(
        ...Array.from(
          host.querySelectorAll<HTMLElement>('.abyss-project-timeline-grid'),
          (grid) => grid.querySelectorAll('.abyss-project-timeline-gridline').length,
        ),
      ),
    ).toBeLessThanOrEqual(20);
  });

  it('uses distinct physical density for Day and Week scales', () => {
    const day = mount([project('Projects/Day.md')], new Date(2026, 8, 13), 'day');
    const week = mount([project('Projects/Week.md')], new Date(2026, 8, 13), 'week');
    const dayDates = expectDefined(
      day.host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates'),
    );
    const weekDates = expectDefined(
      week.host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates'),
    );

    expect(Number(dayDates.dataset['trackWidth'])).toBe(14 * 32);
    expect(Number(weekDates.dataset['trackWidth'])).toBe(84 * 12);
  });

  it('reveals the fitted beginning after a direct scale activation', async () => {
    const projects = [
      project('Projects/Early.md', '2024-01-01', '2024-01-02'),
      project('Projects/Late.md', '2024-12-30', '2024-12-31'),
    ];
    const { host, view } = mount(projects, new Date(2024, 1, 29), 'month');
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 366 * 32,
      viewportWidth: 610,
    });
    view.scroll.scrollLeft = 800;
    const dayButton = expectDefined(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
      ).find(({ textContent }) => textContent === 'Day'),
    );

    dayButton.click();
    await Promise.resolve();

    expect(view.scroll.scrollLeft).toBe(0);
    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
      '2024-01-01 – 2024-12-31',
    );
  });

  it('highlights the visible current-date label alongside the Today line', () => {
    const { host } = mount(
      [project('Projects/A.md', '2024-02-28', '2024-03-01')],
      new Date(2024, 1, 29),
      'day',
    );

    const todayCell = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-cell.is-today[data-start-day="2024-02-29"]',
      ),
    );
    expect(
      Array.from(todayCell.children, ({ className, textContent }) => ({
        className,
        text: textContent,
      })),
    ).toEqual([
      { className: 'abyss-project-timeline-axis-label', text: 'Thu' },
      { className: 'abyss-project-timeline-axis-secondary-label', text: '29' },
    ]);
    expect(todayCell.classList).toContain('is-day');
    expect(
      host
        .querySelector<HTMLElement>('.abyss-project-timeline-axis .abyss-project-timeline-today')
        ?.getAttribute('aria-label'),
    ).toBe('Today, 2024-02-29');
  });

  it('renders the four-year overview as quarter cells beneath current year labels', () => {
    const { host } = mount([project('Projects/Unscheduled.md')], new Date(2026, 8, 13), 'year');
    const dates = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates'),
    );
    const cells = Array.from(
      host.querySelectorAll<HTMLElement>('.abyss-project-timeline-axis-cell'),
    );
    const hierarchy = Array.from(
      host.querySelectorAll<HTMLElement>('.abyss-project-timeline-axis-hierarchy-cell'),
    );

    expect(dates.classList).not.toContain('is-single-tier');
    expect(cells).toHaveLength(16);
    expect(cells.map(({ textContent }) => textContent)).toEqual([
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q1',
      'Q2',
      'Q3',
      'Q4',
    ]);
    expect(hierarchy.map(({ textContent }) => textContent)).toEqual([
      '2025',
      '2026',
      '2027',
      '2028',
    ]);
    expect(
      cells
        .filter(({ classList }) => classList.contains('is-today'))
        .map(({ textContent }) => textContent),
    ).toEqual(['Q3']);
    expect(
      hierarchy
        .filter(({ classList }) => classList.contains('is-today'))
        .map(({ textContent }) => textContent),
    ).toEqual(['2026']);
    expect(
      host
        .querySelector<HTMLElement>('.abyss-project-timeline-axis .abyss-project-timeline-today')
        ?.getAttribute('aria-label'),
    ).toBe('Today, 2026-09-13');
  });

  it('keeps hierarchy context anchored past the sticky summary while scrolling', async () => {
    vi.useFakeTimers();
    const { host, view } = mount(
      [project('Projects/A.md', '2026-09-07', '2026-09-20')],
      new Date(2026, 8, 13),
      'day',
    );
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 448,
      viewportWidth: 520,
    });
    view.scroll.scrollLeft = 84.5;

    view.scroll.dispatchEvent(new Event('scroll'));
    await vi.runAllTimersAsync();

    const hierarchy = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-hierarchy-cell'),
    );
    const label = expectDefined(
      hierarchy.querySelector<HTMLElement>('.abyss-project-timeline-axis-hierarchy-label'),
    );
    expect(hierarchy.dataset).toMatchObject({
      startDay: '2026-09-07',
      endDay: '2026-09-13',
    });
    const hierarchyLeft = Number.parseFloat(hierarchy.style.left);
    const hierarchyWidth = Number.parseFloat(hierarchy.style.width);
    const labelLeft = Number.parseFloat(label.style.left);
    expect(hierarchyLeft + (labelLeft / 100) * hierarchyWidth).toBeCloseTo((84.5 / 448) * 100);
    expect(label.textContent).toBe('W37');
  });

  it('uses readable muted or normal colors for ordinary and hierarchy labels', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([project('Projects/A.md')], new Date(2026, 8, 13), 'day');
    const cell = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-cell:not(.is-today)'),
    );
    const hierarchyContext = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-hierarchy-cell:not(.is-today)'),
    );

    expect(activeWindow.getComputedStyle(cell).color).toBe('var(--text-muted)');
    expect(activeWindow.getComputedStyle(hierarchyContext).color).toBe('var(--text-muted)');
    sheet.remove();
  });

  it('uses semantic theme tokens for current periods and range controls', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount(
      [project('Projects/A.md', '2026-09-10', '2026-09-14')],
      new Date(2026, 8, 13),
      'day',
    );
    expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-axis-cell.is-today'));
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));
    expectDefined(bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-grip'));

    expect(
      Array.from(sheet.sheet?.cssRules ?? []).some(
        (rule) =>
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes('button.abyss-project-timeline-scale'),
      ),
    ).toBe(false);
    const currentPeriodRule = expectDefined(
      Array.from(sheet.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes('.abyss-project-timeline-axis .is-today'),
      ),
    );
    const barRule = expectDefined(
      Array.from(sheet.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === '.abyss-project-timeline-bar',
      ),
    );
    const gripRule = expectDefined(
      Array.from(sheet.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === '.abyss-project-timeline-grip',
      ),
    );
    expect(currentPeriodRule.style.background).toContain('var(--text-normal)');
    expect(currentPeriodRule.style.background).toContain('var(--background-secondary)');
    expect(currentPeriodRule.style.background).not.toContain('var(--text-error)');
    expect(currentPeriodRule.style.color).toBe('var(--text-normal)');
    expect(currentPeriodRule.style.boxShadow).toBe('inset 0 2px 0 var(--interactive-accent)');
    expect(barRule.style.border).not.toContain('black');
    expect(barRule.style.border).toContain('var(--abyss-preview-border-tag-strength)');
    expect(barRule.style.border).toContain('var(--text-normal)');
    expect(barRule.style.background).toContain('var(--abyss-event-fill-strength)');
    expect(gripRule.style.boxShadow).toBe('none');
    expect(gripRule.style.background).toContain('var(--abyss-project-status-color');
    expect(gripRule.style.background).toContain('var(--abyss-preview-border-tag-strength)');
    expect(gripRule.style.background).toContain('var(--text-normal)');
    sheet.remove();
  });

  it('reserves a usable body move target between both minimum-width handles', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount(
      [project('Projects/Short.md', '2026-09-10', '2026-09-10')],
      new Date(2026, 8, 13),
      'year',
    );
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));
    const start = expectDefined(
      bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
    );
    const end = expectDefined(
      bar.parentElement?.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
    );
    expect(bar.dataset['timelinePart']).toBe('bar');
    expect(start.parentElement).toBe(bar);
    expect(end.parentElement).toBe(bar);
    expect(bar.tabIndex).toBe(0);
    const barStyle = activeWindow.getComputedStyle(bar);
    const minimumBodyAndBorderWidth =
      Number.parseFloat(barStyle.minWidth) -
      Number.parseFloat(activeWindow.getComputedStyle(start).width) -
      Number.parseFloat(activeWindow.getComputedStyle(end).width);

    expect(minimumBodyAndBorderWidth).toBeGreaterThanOrEqual(10);
    sheet.remove();
  });

  it('uses a passive directional marker for an offscreen project without inventing a date', () => {
    const { host, view } = mount([
      project('Projects/Past.md', '2005-06-28', '2005-06-29'),
      project('Projects/Future.md', '2045-06-28', '2045-06-29'),
    ]);
    expect(
      expectDefined(
        host.querySelector<HTMLElement>(
          '[data-project-path="Projects/Future.md"] .abyss-project-timeline-bar',
        ),
      ).hidden,
    ).toBe(true);

    const marker = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Future.md"] .abyss-project-timeline-boundary-marker',
      ),
    );
    expect(marker.tagName).toBe('SPAN');
    expect(marker.dataset['direction']).toBe('after');
    expect(marker.dataset['date']).toBeUndefined();
    expect(marker.style.left).toBe('');
    expect(marker.style.width).toBe('');
    expect(host.querySelector('.abyss-project-timeline-show-range')).toBeNull();
    expect(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Past.md"] .abyss-project-timeline-boundary-marker',
      )?.dataset['direction'],
    ).toBe('before');

    view.revealProject('Projects/Future.md');

    const bar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Future.md"] .abyss-project-timeline-bar',
      ),
    );
    expect(bar.hidden).toBe(false);
    expect(host.querySelectorAll('.abyss-project-timeline-axis-cell').length).toBeLessThanOrEqual(
      15,
    );
  });

  it('offers all five direct scales and refits the active scale after Today', () => {
    const { host } = mount([
      project('Projects/Early.md', '2026-09-10', '2026-09-10'),
      project('Projects/Late.md', '2026-09-19', '2026-09-20'),
    ]);
    const scaleButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
    );
    const scaleControl = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-scale-control'),
    );
    const today = expectDefined(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        ({ textContent }) => textContent === 'Today',
      ),
    );

    expect(scaleControl.classList).toContain('abyss-cal-view-switcher');
    expect(today.classList).toContain('abyss-cal-nav-today');
    expect(scaleButtons.map(({ textContent }) => textContent)).toEqual([
      'Day',
      'Week',
      'Month',
      'Quarter',
      'Year',
    ]);
    expect(scaleButtons.every((button) => button.classList.contains('abyss-cal-view-btn'))).toBe(
      true,
    );
    const expectedBounds = [
      '2026-09-10 – 2026-09-20',
      '2026-09-07 – 2026-09-20',
      '2026-09-01 – 2026-09-30',
      '2026-07-01 – 2026-09-30',
      '2025-01-01 – 2028-12-31',
    ];
    for (const [index, button] of scaleButtons.entries()) {
      button.click();
      expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
        expectedBounds[index],
      );
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.classList).toContain('is-active');
      expect(scaleButtons.filter((candidate) => candidate.classList.contains('is-active'))).toEqual(
        [button],
      );
      if (button.textContent === 'Month') {
        const interiorGridLines = Array.from(
          host.querySelectorAll<HTMLElement>('.abyss-project-timeline-gridline'),
        ).filter(({ style }) => {
          const left = Number.parseFloat(style.left);
          return left > 0 && left < 100;
        });
        expect(interiorGridLines.length).toBeGreaterThan(0);
      }
    }
    const month = expectDefined(scaleButtons.find(({ textContent }) => textContent === 'Month'));
    month.click();

    expectDefined(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        ({ textContent }) => textContent === 'Today',
      ),
    ).click();
    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
      '2026-01-01 – 2026-12-31',
    );

    month.click();
    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
      '2026-09-01 – 2026-09-30',
    );
  });

  it('fits empty scale activations around today, including four years for Year', () => {
    const { host } = mount([project('Projects/Unscheduled.md')]);
    const scaleButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
    );
    const month = expectDefined(scaleButtons.find(({ textContent }) => textContent === 'Month'));
    const year = expectDefined(scaleButtons.find(({ textContent }) => textContent === 'Year'));

    month.click();

    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
      '2026-01-01 – 2026-12-31',
    );

    year.click();

    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(
      '2025-01-01 – 2028-12-31',
    );
  });

  it('restores focused range identity when a date edit regroups its row', () => {
    const item = project('Projects/A.md', '2026-09-01', '2026-09-03');
    const { host, view, settings } = mount([item]);
    settings.groupBy = 'start';
    view.update([item], '');
    const originalBar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] .abyss-project-timeline-bar',
      ),
    );
    originalBar.focus();

    view.update([project('Projects/A.md', '2026-09-02', '2026-09-04')], '');

    const regroupedBar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/A.md"] .abyss-project-timeline-bar',
      ),
    );
    expect(regroupedBar).not.toBe(originalBar);
    expect(activeDocument.activeElement).toBe(regroupedBar);
  });

  it('expands the owning group when revealing a project', async () => {
    const { host, view, settings } = mount([project('Projects/A.md', '2026-09-01')]);
    settings.groupBy = 'status';
    view.update([project('Projects/A.md', '2026-09-01')], '');
    const header = expectDefined(
      host.querySelector<HTMLButtonElement>('.abyss-project-timeline-group-header'),
    );
    header.click();
    await Promise.resolve();
    expect(header.getAttribute('aria-expanded')).toBe('false');

    view.revealProject('Projects/A.md');

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(
      expectDefined(header.closest('.abyss-project-timeline-group')).querySelector<HTMLElement>(
        '.abyss-project-timeline-group-body',
      )?.hidden,
    ).toBe(false);
  });

  it.each([
    ['day', new Date(2026, 0, 31), '2026-02-09 – 2026-02-22'],
    ['week', new Date(2026, 0, 31), '2026-03-16 – 2026-06-07'],
    ['month', new Date(2026, 0, 31), '2027-01-01 – 2027-12-31'],
    ['quarter', new Date(2026, 11, 31), '2028-01-01 – 2030-12-31'],
    ['year', new Date(2026, 11, 31), '2029-01-01 – 2032-12-31'],
  ] as const)(
    'advances a %s window from its calendar range instead of overflowing the day',
    (scale, now, expected) => {
      const { host } = mount([project('Projects/A.md')], now, scale);

      expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Next range"]')).click();

      expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(expected);
    },
  );

  it.each([
    ['Previous range', '2031-01-01 – 2031-12-31'],
    ['Next range', '2033-01-01 – 2033-12-31'],
  ] as const)('moves %s from a fitted remote date context', (label, expected) => {
    const projects = [
      project('Projects/Early.md', '2032-03-04', '2032-03-05'),
      project('Projects/Late.md', '2032-10-20', '2032-10-21'),
    ];
    const { host } = mount(projects, new Date(2026, 8, 13), 'month');
    const month = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
    ).find(({ textContent }) => textContent === 'Month');
    expectDefined(month).click();

    expectDefined(host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)).click();

    expect(host.querySelector('.abyss-project-timeline-axis-range')?.textContent).toBe(expected);
  });

  it('moves Year from fitted directional edges and roundtrips across different leap alignment', () => {
    const projects = [project('Projects/Leap.md', '2096-02-29', '2096-10-20')];
    const { host } = mount(projects, new Date(2026, 8, 13), 'month');
    const year = expectDefined(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
      ).find(({ textContent }) => textContent === 'Year'),
    );
    const previous = expectDefined(
      host.querySelector<HTMLButtonElement>('[aria-label="Previous range"]'),
    );
    const next = expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Next range"]'));
    const range = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-range'),
    );

    year.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');

    next.click();
    expect(range.textContent).toBe('2099-01-01 – 2102-12-31');
    previous.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');

    previous.click();
    expect(range.textContent).toBe('2091-01-01 – 2094-12-31');
    next.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');
  });

  it('refits direct Year scale changes in both directions while retaining row and focus', () => {
    const projects = [project('Projects/A.md', '2096-02-29', '2096-10-20')];
    const { host } = mount(projects, new Date(2026, 8, 13), 'month');
    const row = expectDefined(
      host.querySelector<HTMLElement>('[data-project-path="Projects/A.md"]'),
    );
    const scaleButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
    );
    const month = expectDefined(scaleButtons.find(({ textContent }) => textContent === 'Month'));
    const year = expectDefined(scaleButtons.find(({ textContent }) => textContent === 'Year'));
    const next = expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Next range"]'));
    const range = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-range'),
    );

    year.focus();
    year.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(year);

    next.click();
    expect(range.textContent).toBe('2099-01-01 – 2102-12-31');
    year.focus();
    year.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(year);

    month.focus();
    month.click();
    expect(range.textContent).toBe('2096-02-01 – 2096-10-31');
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(month);

    year.focus();
    year.click();
    expect(range.textContent).toBe('2095-01-01 – 2098-12-31');
    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(year);
  });

  it('exposes Today after returning from a horizontally scrolled range', () => {
    const { host, view } = mount([project('Projects/A.md', '2026-09-13')]);
    expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Next range"]')).click();
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 640,
      viewportWidth: 400,
    });
    view.scroll.scrollLeft = 240;

    const today = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      ({ textContent }) => textContent === 'Today',
    );
    expectDefined(today).click();

    const marker = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis .abyss-project-timeline-today'),
    );
    const markerPosition = 210 + (Number.parseFloat(marker.style.left) / 100) * 640;
    expect(markerPosition).toBeGreaterThanOrEqual(view.scroll.scrollLeft + 210);
    expect(markerPosition).toBeLessThanOrEqual(view.scroll.scrollLeft + 400);
  });

  it('omits redundant Fit and Show range controls', () => {
    const { host } = mount([project('Projects/Future.md', '2045-06-28', '2045-06-29')]);

    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).some(
        ({ textContent }) => textContent === 'Fit' || textContent === 'Show range',
      ),
    ).toBe(false);
  });

  it('renders ordered configured metadata with aliases and empty values', () => {
    const item = project('Projects/A.md', '2026-09-01', '2026-09-30');
    item.frontmatter['Priority'] = '';
    const { host, view, settings } = mount([item]);
    settings.fields = [
      { id: 'property:Priority', label: 'Urgency', visible: true },
      { id: 'start', label: 'Begins', visible: true, dateDisplay: 'raw' },
      { id: 'end', visible: false },
    ];
    settings.showEmptyFields = true;

    view.update([item], '');

    expect(
      Array.from(host.querySelectorAll('.abyss-project-timeline-field-label'), (label) =>
        label.textContent.trim(),
      ),
    ).toEqual(['Urgency', 'Begins']);
    expect(
      host.querySelector<HTMLElement>('[data-field-id="property:Priority"]')?.textContent,
    ).toBe('');
    expect(host.querySelector<HTMLElement>('[data-field-id="start"]')?.dataset).toMatchObject({
      columnLabel: 'Begins',
      dateDisplay: 'raw',
    });
  });

  it('keeps legacy status, start, and end metadata when saved fields are absent', () => {
    const item = project('Projects/A.md');
    const { host, view, settings } = mount([item]);
    delete settings.fields;

    view.update([item], '');

    expect(
      Array.from(host.querySelectorAll('.abyss-project-timeline-field-label'), (label) =>
        label.textContent.trim(),
      ),
    ).toEqual(['Status', 'Start', 'End']);
  });
});
