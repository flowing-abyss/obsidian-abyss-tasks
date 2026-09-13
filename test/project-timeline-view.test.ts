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
    openScaleOptions: vi.fn(),
    renderGroupContent: (_marker, label, group) => {
      label.setText(group.label);
    },
    statusColor: () => '#336699',
    captureRangeSource: () => ({ kind: 'rejected', reason: 'Test capture unavailable' }),
    commitRangeEdit: vi.fn().mockResolvedValue({ applied: [], failed: [] }),
    reportRangeFailure: vi.fn(),
    finishEditor: async () => true,
    openRangeMenu: vi.fn(),
    now: () => new Date(now),
  });
  mountedView.current = view;
  mounted.add(view);
  view.mount(projects, '');
  return { host, view, settings, selected };
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

  it('forces retained hidden range controls out of layout', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    const { host } = mount([project('Projects/Unscheduled.md')]);
    const showRange = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-show-range'),
    );
    const bar = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-bar'));

    expect(showRange.hidden).toBe(true);
    expect(activeWindow.getComputedStyle(showRange).display).toBe('none');
    expect(activeWindow.getComputedStyle(bar).display).toBe('none');
    sheet.remove();
  });

  it('keeps range recovery controls aligned with the exposed date viewport while scrolling', () => {
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
    expect(host.querySelector('.abyss-project-timeline-show-range')).not.toBeNull();
  });

  it('shows resize handles only for actual endpoints inside the visible window', () => {
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

  it('reveals a project outside the current window and keeps ticks bounded', () => {
    const { host, view } = mount([project('Projects/Future.md', '2045-06-28', '2045-06-29')]);
    expect(
      expectDefined(
        host.querySelector<HTMLElement>(
          '[data-project-path="Projects/Future.md"] .abyss-project-timeline-bar',
        ),
      ).hidden,
    ).toBe(true);

    const show = expectDefined(
      host.querySelector<HTMLButtonElement>(
        '[data-project-path="Projects/Future.md"] .abyss-project-timeline-show-range',
      ),
    );
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 640,
      viewportWidth: 400,
    });
    show.focus();
    expect(activeDocument.activeElement).toBe(show);
    show.click();

    const bar = expectDefined(
      host.querySelector<HTMLElement>(
        '[data-project-path="Projects/Future.md"] .abyss-project-timeline-bar',
      ),
    );
    const trackWidth = 640;
    const barCenter =
      210 +
      ((Number.parseFloat(bar.style.left) + Number.parseFloat(bar.style.width) / 2) / 100) *
        trackWidth;
    expect(barCenter).toBeGreaterThanOrEqual(view.scroll.scrollLeft + 210);
    expect(barCenter).toBeLessThanOrEqual(view.scroll.scrollLeft + 400);
    expect(
      expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-show-range')).hidden,
    ).toBe(true);
    expect(host.querySelectorAll('.abyss-project-timeline-tick').length).toBeLessThanOrEqual(15);
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
    const fit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      ({ textContent }) => textContent === 'Fit',
    );
    expectDefined(fit).click();

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

  it.each([
    ['day', 14],
    ['week', 84],
    ['month', 366],
    ['quarter', 1096],
    ['year', 1827],
  ] as const)(
    'leaves Fit for the %s scale while retaining the scroll context',
    (scale, maximumDays) => {
      const { host, view, settings } = mount([
        project('Projects/Early.md', '2026-01-01', '2026-01-02'),
        project('Projects/Late.md', '2026-06-29', '2026-06-30'),
      ]);
      if (scale === 'month') {
        settings.scale = 'week';
        view.update(
          [
            project('Projects/Early.md', '2026-01-01', '2026-01-02'),
            project('Projects/Late.md', '2026-06-29', '2026-06-30'),
          ],
          '',
        );
      }
      const fit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        ({ textContent }) => textContent === 'Fit',
      );
      expectDefined(fit).click();
      mockTimelineGeometry(host, view, {
        summaryWidth: 200,
        trackWidth: 800,
        viewportWidth: 400,
      });
      view.scroll.scrollLeft = 400;

      view.prepareScaleChange();
      settings.scale = scale;
      view.update(
        [
          project('Projects/Early.md', '2026-01-01', '2026-01-02'),
          project('Projects/Late.md', '2026-06-29', '2026-06-30'),
        ],
        '',
      );

      const summary = expectDefined(
        host.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
      ).textContent;
      const [start, end] = summary.split(' – ').map((day) => new Date(`${day}T12:00:00`));
      expect(
        ((end as Date).getTime() - (start as Date).getTime()) / 86_400_000 + 1,
      ).toBeLessThanOrEqual(maximumDays);
      const [startDay, endDay] = summary.split(' – ');
      expect(expectDefined(startDay) <= '2026-04-24' && expectDefined(endDay) >= '2026-04-24').toBe(
        true,
      );
      const contextOffset =
        (new Date('2026-04-24T12:00:00').getTime() - (start as Date).getTime()) / 86_400_000;
      const contextPosition = 200 + ((contextOffset + 0.5) / maximumDays) * 800;
      expect(contextPosition).toBeGreaterThanOrEqual(view.scroll.scrollLeft + 200);
      expect(contextPosition).toBeLessThanOrEqual(view.scroll.scrollLeft + 400);
    },
  );

  it('anchors zoom to the rendered date track when tick labels overflow the axis', () => {
    const projects = [
      project('Projects/Early.md', '2032-01-01', '2032-01-02'),
      project('Projects/Late.md', '2032-12-30', '2032-12-31'),
    ];
    const { host, view, settings } = mount(projects);
    const fit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      ({ textContent }) => textContent === 'Fit',
    );
    expectDefined(fit).click();
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 640,
      viewportWidth: 400,
    });
    view.scroll.scrollLeft = 391;

    view.prepareScaleChange();
    settings.scale = 'quarter';
    view.update(projects, '');

    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      '2031-01-01 – 2033-12-31',
    );
  });

  it('excludes the scrollbar gutter when choosing the visible zoom date', () => {
    const projects = [
      project('Projects/Early.md', '2032-01-01', '2032-01-02'),
      project('Projects/Late.md', '2032-12-30', '2032-12-31'),
    ];
    const { host, view, settings } = mount(projects);
    const fit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      ({ textContent }) => textContent === 'Fit',
    );
    expectDefined(fit).click();
    mockTimelineGeometry(host, view, {
      summaryWidth: 210,
      trackWidth: 640,
      viewportWidth: 457,
      outerViewportWidth: 472,
    });
    view.scroll.scrollLeft = 350;

    view.prepareScaleChange();
    settings.scale = 'month';
    view.update(projects, '');

    expect(host.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      '2032-01-01 – 2032-12-31',
    );
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
