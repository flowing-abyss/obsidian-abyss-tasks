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
    stats: { total: 4, done: 2, cancelled: 0, inProgress: 1 },
  };
}

const mounted = new Set<ProjectsTimelineView<Cell>>();

afterEach(() => {
  for (const view of mounted) view.destroy();
  mounted.clear();
  activeDocument.body.empty();
  vi.restoreAllMocks();
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
    modelInput: () => ({ fields, statuses: DEFAULT_SETTINGS.projects.statuses }),
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
      expectDefined(bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'))
        .hidden,
    ).toBe(true);
    expect(
      expectDefined(bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end')).hidden,
    ).toBe(false);
  });

  it.each([
    ['open-start', project('Projects/Open start.md', undefined, '2026-09-08')],
    ['open-end', project('Projects/Open end.md', '2026-09-08')],
  ] as const)('keeps both endpoint handles reachable for an %s range', (_kind, item) => {
    const { host } = mount([item]);
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));

    expect(
      expectDefined(bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'))
        .hidden,
    ).toBe(false);
    expect(
      expectDefined(bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end')).hidden,
    ).toBe(false);
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
      bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
    );
    const end = expectDefined(
      bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
    );

    expect(bar.classList).toContain('is-one-date');
    expect(bar.style.getPropertyValue('--abyss-project-timeline-one-date-center')).toBe('25%');
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

  it('aligns a bounded row grid to the axis tick intervals', () => {
    const { host } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
    const ticks = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-timeline-axis .abyss-project-timeline-tick',
      ),
    );
    const lines = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.abyss-project-timeline-track .abyss-project-timeline-gridline',
      ),
    );

    expect(lines).toHaveLength(ticks.length);
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(lines.map(({ style }) => style.left)).toEqual(ticks.map(({ style }) => style.left));
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
      bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-start'),
    );
    const end = expectDefined(
      bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
    );
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
    expect(host.querySelectorAll('.abyss-project-timeline-tick').length).toBeLessThanOrEqual(15);
  });

  it('offers all five direct scales and refits the active scale after Today', () => {
    const { host } = mount([
      project('Projects/Early.md', '2026-09-10', '2026-09-10'),
      project('Projects/Late.md', '2026-09-19', '2026-09-20'),
    ]);
    const scaleButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
    );

    expect(scaleButtons.map(({ textContent }) => textContent)).toEqual([
      'Day',
      'Week',
      'Month',
      'Quarter',
      'Year',
    ]);
    const expectedBounds = [
      '2026-09-10 – 2026-09-20',
      '2026-09-07 – 2026-09-20',
      '2026-09-01 – 2026-09-30',
      '2026-07-01 – 2026-09-30',
      '2026-01-01 – 2026-12-31',
    ];
    for (const [index, button] of scaleButtons.entries()) {
      button.click();
      expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
        expectedBounds[index],
      );
      expect(button.getAttribute('aria-pressed')).toBe('true');
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
    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      '2026-01-01 – 2026-12-31',
    );

    month.click();
    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      '2026-09-01 – 2026-09-30',
    );
  });

  it('fits an empty scale activation around today', () => {
    const { host } = mount([project('Projects/Unscheduled.md')]);
    const month = expectDefined(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('.abyss-project-timeline-scale-control button'),
      ).find(({ textContent }) => textContent === 'Month'),
    );

    month.click();

    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      '2026-01-01 – 2026-12-31',
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
    ['year', new Date(2026, 11, 31), '2029-01-01 – 2033-12-31'],
  ] as const)(
    'advances a %s window from its calendar range instead of overflowing the day',
    (scale, now, expected) => {
      const { host } = mount([project('Projects/A.md')], now, scale);

      expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Next range"]')).click();

      expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
        expected,
      );
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

    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(expected);
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
