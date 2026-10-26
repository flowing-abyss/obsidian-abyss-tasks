import type { Component } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectsTimelineView,
  type ProjectTimelineCellContext,
  type ProjectsTimelineViewContext,
} from '../src/panels/projects/ProjectsTimelineView';
import { projectCalendarDayOrdinal } from '../src/projects/projectDateValue';
import type { ProjectEditResult } from '../src/projects/projectEdits';
import type { ProjectColumn, ProjectFieldCatalogItem } from '../src/projects/projectFields';
import { buildDefaultProjectTableSettings } from '../src/projects/projectTableSettings';
import type { ProjectTimelineModel } from '../src/projects/projectTimelineModel';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { createSearchWordSegmenter } from '../src/tasks/infrastructure/search/searchWordSegmenter';
import { expectDefined, flushMicrotasks, freshContainer, loadPluginStyles } from './helpers';

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
  overrides: Partial<ProjectsTimelineViewContext<Cell>> & { readonly viewportWidth?: number } = {},
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
    savedSettings: () => settings,
    modelInput: () => ({
      segment: createSearchWordSegmenter(),
      nowMs: Date.UTC(2026, 8, 20),
      fields,
      statuses: DEFAULT_SETTINGS.projects.statuses,
    }),
    effectiveField: (_project, field) => ({ field }),
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
    releaseCell: () => {},
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
    reportRenderFailure: vi.fn(),
    finishEditor: async () => true,
    openRangeMenu,
    now: () => new Date(now),
    ...overrides,
  });
  mountedView.current = view;
  mounted.add(view);
  Object.defineProperties(view.scroll, {
    clientHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: overrides.viewportWidth ?? 400 },
  });
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
  Object.defineProperty(view.scroll, 'clientWidth', {
    configurable: true,
    value: viewportWidth,
  });
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

function logicalCenter(host: HTMLElement, view: ProjectsTimelineView<Cell>): number {
  const first = (host.querySelector('.abyss-project-timeline-axis-range')?.textContent ?? '').split(
    ' – ',
  )[0] as string;
  const [start, end] = (
    host.querySelector('.abyss-project-timeline-axis-range')?.textContent ?? ''
  ).split(' – ') as [string, string];
  const count =
    (projectCalendarDayOrdinal(end) as number) - (projectCalendarDayOrdinal(start) as number) + 1;
  const track = Number(
    host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates')?.dataset['trackWidth'],
  );
  const summary =
    host.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary')?.getBoundingClientRect()
      .width ?? 0;
  return (
    (projectCalendarDayOrdinal(first) as number) +
    (view.scroll.scrollLeft + (view.scroll.clientWidth - summary) / 2) / (track / count)
  );
}

describe('ProjectsTimelineView', () => {
  it('reads current saved collapse after filtering and grouping switches', async () => {
    const item = project('Projects/A.md', '2026-09-01');
    const { host, view, settings } = mount([item]);
    const key = JSON.stringify(['status', `id:${item.statusId}`]);
    settings.collapsedGroups = [key];
    view.update([item], '');
    expect(view.cells().identities).toHaveLength(0);
    view.update([item], 'absent');
    expect(settings.collapsedGroups).toEqual([key]);
    settings.groupBy = 'none';
    view.update([item], '');
    expect(view.cells().identities.length).toBeGreaterThan(0);
    settings.groupBy = 'status';
    view.update([item], '');
    expect(
      host.querySelector('.abyss-project-timeline-group-header')?.getAttribute('aria-expanded'),
    ).toBe('false');
    settings.collapsedGroups = [];
    view.update([item], '');
    expect(view.cells().identities.length).toBeGreaterThan(0);
  });

  it('raises the row and summary that hold the edited cell, one cell at a time', () => {
    const { host, view } = mount([
      project('Projects/A.md', '2026-09-10', '2026-09-12'),
      project('Projects/B.md', '2026-09-14', '2026-09-16'),
    ]);
    const holders = (index: number) => {
      const row = expectDefined(
        host.querySelectorAll<HTMLElement>('.abyss-project-timeline-row')[index],
      );
      const summary = expectDefined(
        row.querySelector<HTMLElement>('.abyss-project-timeline-summary'),
      );
      const cell = expectDefined(summary.querySelector<HTMLElement>('[data-field-id="name"]'));
      return { row, summary, cell };
    };
    const first = holders(0);
    const second = holders(1);
    const raised = (): Element[] => Array.from(host.querySelectorAll('.is-cell-editing'));

    view.setEditingCell(first.cell);
    expect(raised()).toEqual([first.row, first.summary]);
    view.setEditingCell(second.cell);
    expect(raised()).toEqual([second.row, second.summary]);
    view.setEditingCell(undefined);
    expect(raised()).toEqual([]);
  });

  it('stacks the edited row and summary above their neighbours with the plugin styles', async () => {
    const styles = await loadPluginStyles();
    const sheet = createEl('style');
    sheet.textContent = styles;
    activeDocument.head.append(sheet);
    // The page keeps a stylesheet across rows, so a failed assertion must not leave this one behind.
    try {
      const { host, view } = mount([project('Projects/A.md', '2026-09-01', '2026-09-03')]);
      const row = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-row'));
      const summary = expectDefined(
        row.querySelector<HTMLElement>('.abyss-project-timeline-summary'),
      );
      const stacking = (): string[] => {
        const rowStyle = activeWindow.getComputedStyle(row);
        const summaryStyle = activeWindow.getComputedStyle(summary);
        return [rowStyle.position, rowStyle.zIndex, summaryStyle.zIndex, summaryStyle.overflow];
      };
      const resting = stacking();

      view.setEditingCell(
        expectDefined(summary.querySelector<HTMLElement>('[data-field-id="name"]')),
      );
      expect(stacking()).toEqual(['relative', '6', '7', 'visible']);
      view.setEditingCell(undefined);
      expect(stacking()).toEqual(resting);
    } finally {
      sheet.remove();
    }
  });

  it('raises nothing for a cell outside its rows', () => {
    const { host, view } = mount([project('Projects/A.md', '2026-09-10', '2026-09-12')]);
    const other = mount([project('Projects/B.md', '2026-09-14', '2026-09-16')]);
    const foreign = expectDefined(
      other.host.querySelector<HTMLElement>('.abyss-project-timeline-row [data-field-id="name"]'),
    );
    const axis = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
    );

    view.setEditingCell(foreign);
    expect(activeDocument.querySelector('.is-cell-editing')).toBeNull();
    view.setEditingCell(axis);
    expect(activeDocument.querySelector('.is-cell-editing')).toBeNull();
  });

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
    const scaleControl = expectDefined(
      navigation.querySelector<HTMLElement>('.abyss-project-timeline-scale-control'),
    );
    const range = expectDefined(
      axisSummary.querySelector<HTMLElement>('.abyss-project-timeline-axis-range'),
    );
    const descriptionId = expectDefined(view.scroll.getAttribute('aria-describedby'));
    const buttons = [...scaleControl.querySelectorAll<HTMLButtonElement>('button')];
    expect(navigation.parentElement).toBe(axisSummary);
    expect([...navigation.children]).toEqual([scaleControl]);
    expect(range.classList).toContain('abyss-sr-only');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Day',
      'Week',
      'Month',
      'Quarter',
      'Year',
    ]);
    for (const button of buttons) {
      button.focus();
      button.click();
      expect(button.getAttribute('aria-pressed')).toBe('true');
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
    const center = logicalCenter(host, view);

    view.update([{ ...item, stats: { ...item.stats, done: 3 } }], '');

    expect(host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
    expect(activeDocument.activeElement).toBe(start);
    expect(logicalCenter(host, view)).toBeCloseTo(center, 8);
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
    const { host } = mount([project('Projects/Clipped.md', '1900-12-30', '2026-09-13')]);
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

  it('keeps compact multi-day geometry and handles inside the physical buffer', async () => {
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
    expect(Number.parseFloat(rangeLeft)).toBeGreaterThan(0);
    expect(Number.parseFloat(rangeLeft)).toBeLessThan(100);
    expect(Number.parseFloat(bar.style.width)).toBeGreaterThan(0);
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
    expect(visualLeft).toBeGreaterThanOrEqual(0);
    expect(visualLeft + 40).toBeLessThanOrEqual(trackWidth);
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
    expect(hiddenStyle.insetInlineStart).toBe('-10000px');
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

    expect(Number(dayDates.dataset['trackWidth'])).toBe(32768);
    expect(Number(weekDates.dataset['trackWidth'])).toBe(32772);
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
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(16);
    expect(cells.every((cell) => /^Q[1-4]$/u.test(cell.textContent))).toBe(true);
    expect(hierarchy.map((cell) => cell.textContent)).toContain('2026');
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
    view.update([project('Projects/A.md', '2026-09-07', '2026-09-20')], '');
    view.scroll.scrollLeft += 84.5;

    view.scroll.dispatchEvent(new Event('scroll'));
    await vi.runAllTimersAsync();

    const hierarchy = expectDefined(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-hierarchy-cell'),
    );
    const label = expectDefined(
      hierarchy.querySelector<HTMLElement>('.abyss-project-timeline-axis-hierarchy-label'),
    );
    const hierarchyLeft = Number.parseFloat(hierarchy.style.left);
    const hierarchyWidth = Number.parseFloat(hierarchy.style.width);
    const labelLeft = Number.parseFloat(label.style.left);
    expect(hierarchyLeft + (labelLeft / 100) * hierarchyWidth).toBeCloseTo(
      (view.scroll.scrollLeft /
        Number(
          host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates')?.dataset[
            'trackWidth'
          ],
        )) *
        100,
    );
    expect(label.textContent).toMatch(/^W\d+$/u);
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
    expect(settings.collapsedGroups).toEqual([
      JSON.stringify(['status', `id:${DEFAULT_SETTINGS.projects.statuses[0]?.id}`]),
    ]);

    view.revealProject('Projects/A.md');

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(settings.collapsedGroups).toEqual([]);
    expect(
      host.querySelector('.abyss-project-timeline-row[data-project-path="Projects/A.md"]'),
    ).not.toBeNull();
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

it('windows 1100 logical rows and mounts an offscreen requested cell with its row Markdown owner', () => {
  const items = Array.from({ length: 1100 }, (_, i) =>
    project(`Projects/P${String(i).padStart(4, '0')}.md`, '2026-09-01'),
  );
  const { host, view } = mount(items);
  expect(host.querySelectorAll('.abyss-project-timeline-row').length).toBeLessThan(20);
  const cells = view.cells().identities;
  expect(cells.length).toBeGreaterThanOrEqual(1100);
  const target = cells.find(
    (cell) => cell.projectPath === 'Projects/P1099.md' && cell.columnId === 'name',
  );
  expect(target).toBeDefined();
  view.revealCell(expectDefined(target));
  expect(
    view.renderedCells().some((cell) => cell.identity.projectPath === 'Projects/P1099.md'),
  ).toBe(true);
  expect(view.scroll.scrollTop).toBeGreaterThan(50_000);
});

it('bounds occurrence lookup work when native scrolling mounts fresh Timeline rows', () => {
  const frames = controlledFrames();
  const currentView: { current?: ProjectsTimelineView<Cell> } = {};
  let captures = 0;
  const f = mount(
    Array.from({ length: 1100 }, (_, index) =>
      project(`Projects/P${String(index).padStart(4, '0')}.md`, '2026-09-01'),
    ),
    undefined,
    undefined,
    {
      captureRangeSource: (occurrenceId) => {
        if (currentView.current !== undefined) {
          expect(currentView.current.visibleRow(occurrenceId)).toBeDefined();
          captures++;
        }
        return { kind: 'rejected', reason: 'Test capture unavailable' };
      },
    },
  );
  currentView.current = f.view;
  const model = expectDefined(
    (f.view as unknown as { model_abyssPrivate?: ProjectTimelineModel }).model_abyssPrivate,
  );
  let occurrenceReads = 0;
  for (const group of model.groups) {
    for (const row of group.rows) {
      const occurrenceId = row.occurrenceId;
      Object.defineProperty(row, 'occurrenceId', {
        configurable: true,
        get: () => {
          occurrenceReads++;
          return occurrenceId;
        },
      });
    }
  }
  f.view.scroll.scrollTop = 109_000;
  f.view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  expect(captures).toBeGreaterThan(0);
  expect(captures).toBeLessThan(30);
  expect(f.view.renderedCells().some((cell) => cell.project.path === 'Projects/P1090.md')).toBe(
    true,
  );
  expect(occurrenceReads).toBeLessThan(200);
});

function controlledFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
    callbacks.delete(key);
  });
  return {
    callbacks,
    run: () => {
      const work = [...callbacks.values()];
      callbacks.clear();
      expect(work.length).toBeGreaterThan(0);
      work.forEach((callback) => {
        callback(0);
      });
    },
  };
}
function gestureEvent(type: string, x: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    isPrimary: { value: true },
    pointerId: { value: 1 },
    clientX: { value: x },
  });
  return event;
}
async function gestureFixture() {
  const frames = controlledFrames();
  const items = Array.from({ length: 1100 }, (_, i) =>
    project(`Projects/P${String(i).padStart(4, '0')}.md`, '2026-09-01', '2026-09-05'),
  );
  let resolve: ((result: ProjectEditResult) => void) | undefined;
  const commit = vi.fn(
    () =>
      new Promise<ProjectEditResult>((done) => {
        resolve = done;
      }),
  );
  const f = mount(items, new Date(2026, 8, 13), undefined, {
    commitRangeEdit: commit,
    captureRangeSource: (occurrenceId) => {
      const item = expectDefined(items[0]);
      return {
        kind: 'ready',
        source: {
          occurrenceId,
          path: item.path,
          range: {
            kind: 'closed',
            startDay: String(item.frontmatter['start']),
            endDay: String(item.frontmatter['end']),
          },
          start: {
            field: { id: 'start', label: 'Start', type: 'date', property: 'start' },
            expectedExists: true,
            expectedValue: item.frontmatter['start'],
            sourceKey: 'start',
            sourceProperty: 'start',
          },
          end: {
            field: { id: 'end', label: 'End', type: 'date', property: 'end' },
            expectedExists: true,
            expectedValue: item.frontmatter['end'],
            sourceKey: 'end',
            sourceProperty: 'end',
          },
        },
      };
    },
  });
  frames.run();
  const track = expectDefined(f.host.querySelector<HTMLElement>('.abyss-project-timeline-track'));
  const bar = expectDefined(track.querySelector<HTMLElement>('.abyss-project-timeline-bar'));
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(geometry(0, 840));
  vi.spyOn(f.view.scroll, 'getBoundingClientRect').mockReturnValue(geometry(0, 900));
  let captured = false;
  Object.assign(track, {
    setPointerCapture: () => {
      captured = true;
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      expect(track.isConnected).toBe(true);
      captured = false;
    },
  });
  bar.dispatchEvent(gestureEvent('pointerdown', 200));
  await flushMicrotasks();
  bar.dispatchEvent(gestureEvent('pointermove', 240));
  f.view.root.focus();
  f.view.scroll.scrollTop = 80_000;
  f.view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  expect(track.isConnected).toBe(true);
  expect(captured).toBe(true);
  expect(f.host.querySelectorAll('.abyss-project-timeline-row').length).toBeLessThan(20);
  return {
    ...f,
    items,
    frames,
    track,
    bar,
    commit,
    resolve: (value: ProjectEditResult) => resolve?.(value),
  };
}

it('keeps the captured offscreen Timeline node through command success until projected source changes', async () => {
  const f = await gestureFixture();
  f.bar.dispatchEvent(gestureEvent('pointerup', 240));
  await flushMicrotasks();
  expect(f.commit).toHaveBeenCalledOnce();
  f.resolve({
    applied: [{}] as ProjectEditResult['applied'],
    failed: [],
  });
  await flushMicrotasks();
  expect(f.track.isConnected).toBe(true);
  expect(f.bar.classList.contains('is-previewing')).toBe(true);
  f.items[0] = {
    ...expectDefined(f.items[0]),
    frontmatter: { start: '2026-09-05', end: '2026-09-09' },
  };
  f.view.update(f.items, '');
  expect(f.track.isConnected).toBe(false);
});

it.each(['hide', 'detach', 'collapse', 'dispose'] as const)(
  'invalidates a captured Timeline node before %s and cannot resurrect it',
  async (action) => {
    const f = await gestureFixture();
    if (action === 'hide') f.view.hide();
    else if (action === 'detach') f.view.captureViewportBeforeHide();
    else if (action === 'collapse') {
      f.settings.collapsedGroups = [
        JSON.stringify(['status', `id:${expectDefined(f.items[0]).statusId}`]),
      ];
      f.view.update(f.items, '');
    } else f.view.destroy();
    expect(f.track.isConnected).toBe(false);
    if (action !== 'dispose') {
      f.view.show();
      f.view.update(f.items, '');
    }
    f.bar.dispatchEvent(gestureEvent('pointerup', 240));
    await flushMicrotasks();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.host.querySelector('.is-previewing')).toBeNull();
  },
);

it('releases a failed pending Timeline preview after its source scrolls away', async () => {
  const f = await gestureFixture();
  f.bar.dispatchEvent(gestureEvent('pointerup', 240));
  f.resolve({
    applied: [],
    failed: [{ path: expectDefined(f.items[0]).path, message: 'Changed source' }],
  });
  await flushMicrotasks();
  expect(f.track.isConnected).toBe(false);
});

it('pins explicit editing ownership while a root-level picker has focus', () => {
  const frames = controlledFrames();
  const f = mount(Array.from({ length: 1100 }, (_, i) => project(`Projects/${i}.md`)));
  frames.run();
  const first = expectDefined(f.view.renderedCells()[0]);
  f.view.setEditingCell(first.element);
  const picker = f.view.root.createEl('input');
  picker.focus();
  f.view.scroll.scrollTop = 80_000;
  f.view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  expect(first.element.isConnected).toBe(true);
  expect(document.activeElement).toBe(picker);
  f.view.setEditingCell(undefined);
  expect(first.element.isConnected).toBe(false);
});

it('threads each row and header Markdown owner through real renderer callbacks and clears references before unload', () => {
  const owners = new Map<string, Component>();
  const unloaded: string[] = [];
  const f = mount(
    Array.from({ length: 1100 }, (_, index) => project(`Projects/${index}.md`)),
    undefined,
    undefined,
    {
      renderCell: ({ host, markdown, occurrenceId, project: item, field, existing }) => {
        if (!owners.has(occurrenceId)) {
          owners.set(occurrenceId, markdown);
          markdown.register(() => {
            expect(
              view.renderedCells().some((cell) => cell.identity.occurrenceId === occurrenceId),
            ).toBe(false);
            unloaded.push(occurrenceId);
          });
        }
        expect(markdown).toBe(owners.get(occurrenceId));
        return (
          existing ?? {
            element: host,
            identity: { projectPath: item.path, columnId: field.id, occurrenceId },
            project: item,
            field,
          }
        );
      },
      renderGroupContent: (_marker, _label, group, markdown) => {
        owners.set(`header:${group.key}`, markdown);
      },
    },
  );
  const view = f.view;
  const first = expectDefined(view.renderedCells()[0]);
  expect(new Set(owners.values()).size).toBe(owners.size);
  view.revealCell(expectDefined(view.cells().identities[view.cells().identities.length - 1]));
  expect(unloaded).toContain(first.identity.occurrenceId);
  expect(first.element.isConnected).toBe(false);
});

it('coalesces horizontal grids and vertical windows and gives fresh rows the current axis', () => {
  const frames = controlledFrames();
  const { host, view } = mount(
    Array.from({ length: 1100 }, (_, i) => project(`Projects/${i}.md`)),
    new Date(2026, 8, 13),
    'day',
  );
  mockTimelineGeometry(host, view, { summaryWidth: 210, trackWidth: 448, viewportWidth: 520 });
  frames.run();
  const old = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-grid'));
  const oldAppend = vi.spyOn(old, 'appendChild');
  view.scroll.scrollLeft = 180.5;
  view.scroll.scrollTop = 80_000.25;
  const horizontal = vi.spyOn(view.scroll, 'scrollLeft', 'set');
  const vertical = vi.spyOn(view.scroll, 'scrollTop', 'set');
  view.scroll.dispatchEvent(new Event('scroll'));
  view.scroll.dispatchEvent(new Event('scroll'));
  expect(frames.callbacks.size).toBe(1);
  frames.run();
  expect(old.isConnected).toBe(false);
  expect(host.querySelectorAll('.abyss-project-timeline-row').length).toBeLessThan(20);
  const grids = [...host.querySelectorAll('.abyss-project-timeline-grid')].map((grid) =>
    [...grid.children].map((line) => (line as HTMLElement).dataset['day']),
  );
  expect(grids.length).toBeGreaterThan(0);
  for (const grid of grids) expect(grid).toEqual(grids[0]);
  const expectedDays = [
    ...host.querySelectorAll<HTMLElement>('.abyss-project-timeline-axis-cell'),
  ].map((cell) => cell.dataset['startDay']);
  expect(grids[0]).toEqual(expect.arrayContaining(expectedDays));
  expect(horizontal).toHaveBeenCalledTimes(1);
  // The geometry fixture measures rows at 40px, so a real anchor correction may write vertically.
  expect(vertical.mock.calls.every(([value]) => Number.isFinite(value))).toBe(true);
  oldAppend.mockClear();
  view.scroll.scrollLeft = 190.5;
  view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  expect(oldAppend).not.toHaveBeenCalled();
});

it.each(['initial', 'frame'] as const)(
  'reports %s mount errors once through the render boundary',
  (phase) => {
    const frames = controlledFrames();
    const renderFailure = vi.fn();
    const rangeFailure = vi.fn();
    let fail = phase === 'initial';
    const f = mount(
      Array.from({ length: 1100 }, (_, index) => project(`Projects/${index}.md`)),
      undefined,
      undefined,
      {
        reportRenderFailure: renderFailure,
        reportRangeFailure: rangeFailure,
        renderCell: ({ host, project: item, field, occurrenceId }) => {
          if (fail) throw new Error('Broken renderer');
          return {
            element: host,
            identity: { occurrenceId, projectPath: item.path, columnId: field.id },
            project: item,
            field,
          };
        },
      },
    );
    if (phase === 'frame') {
      frames.run();
      fail = true;
      f.view.scroll.scrollTop = 80_000;
      f.view.scroll.dispatchEvent(new Event('scroll'));
      frames.run();
    }
    expect(renderFailure).toHaveBeenCalledOnce();
    f.view.scroll.dispatchEvent(new Event('scroll'));
    expect(frames.callbacks.size).toBe(0);
    expect(renderFailure).toHaveBeenCalledOnce();
    f.view.update([], '');
    f.view.update([project('new.md')], '');
    expect(renderFailure).toHaveBeenCalledTimes(2);
    expect(rangeFailure).not.toHaveBeenCalled();
    f.view.destroy();
    for (const callback of frames.callbacks.values()) callback(0);
    expect(renderFailure).toHaveBeenCalledTimes(2);
  },
);

it('cancels the captured gesture before a zero-height resize evicts its row', async () => {
  const f = await gestureFixture();
  Object.defineProperty(f.view.scroll, 'clientHeight', { configurable: true, value: 0 });
  window.dispatchEvent(new Event('resize'));
  expect(f.track.isConnected).toBe(false);
  f.bar.dispatchEvent(gestureEvent('pointerup', 240));
  await flushMicrotasks();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.frames.callbacks.size).toBe(0);
});

it('keeps a vertical projection anchor without writing the independent horizontal offset', () => {
  const frames = controlledFrames();
  const items = Array.from({ length: 1100 }, (_, index) =>
    project(`Projects/P${String(index).padStart(4, '0')}.md`),
  );
  const f = mount(items);
  frames.run();
  f.view.scroll.scrollTop = 5000.75;
  f.view.scroll.scrollLeft = 137.5;
  f.view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  const horizontal = vi.spyOn(f.view.scroll, 'scrollLeft', 'set');
  f.view.update([project('Projects/000-before.md'), ...items], '');
  expect(f.view.scroll.scrollTop).toBe(5100.75);
  expect(horizontal).not.toHaveBeenCalled();
});

it('does not publish a native window while destroying an explicit editor pin', () => {
  const published = vi.fn();
  const f = mount([project('Projects/A.md')], undefined, undefined, { windowRendered: published });
  f.view.setEditingCell(expectDefined(f.view.renderedCells()[0]).element);
  published.mockClear();
  f.view.destroy();
  expect(published).not.toHaveBeenCalled();
});

it('centers Today on first measurement and repeated active scale without persisting or rerendering cards', () => {
  const renderCell = vi.fn<ProjectsTimelineViewContext<Cell>['renderCell']>();
  const requestScaleChange = vi.fn().mockResolvedValue(true);
  const { host, view } = mount([], new Date(2026, 8, 13), 'month', {
    requestScaleChange,
    renderCell,
  });
  mockTimelineGeometry(host, view, { summaryWidth: 180, trackWidth: 32768, viewportWidth: 900 });
  view.update([], '');
  const todayScreenX = () => {
    const marker = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    const width = Number(
      host.querySelector<HTMLElement>('.abyss-project-timeline-axis-dates')?.dataset['trackWidth'],
    );
    return 180 + (parseFloat(marker.style.left) / 100) * width - view.scroll.scrollLeft;
  };
  expect(host.querySelector('[aria-label="Previous range"]')).toBeNull();
  expect(todayScreenX()).toBeCloseTo(540, 1);
  view.scroll.scrollLeft += 111.25;
  expectDefined(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Month'),
  ).click();
  expect(todayScreenX()).toBeCloseTo(540, 1);
  expect(requestScaleChange).not.toHaveBeenCalled();
  expect(renderCell).not.toHaveBeenCalled();
});

it('preserves a fractional center across every different scale and leaves cards untouched while rebasing', () => {
  const frames = controlledFrames();
  const renderCell = vi.fn<ProjectsTimelineViewContext<Cell>['renderCell']>(
    ({ host, project: item, field, occurrenceId, existing }) =>
      existing ?? {
        element: host,
        identity: { projectPath: item.path, columnId: field.id, occurrenceId },
        project: item,
        field,
      },
  );
  const items = [project('Projects/A.md', '2026-09-10', '2026-09-15')];
  const h = mount(items, new Date(2026, 8, 13), 'month', { renderCell });
  mockTimelineGeometry(h.host, h.view, {
    summaryWidth: 180,
    trackWidth: 32768,
    viewportWidth: 900,
  });
  h.view.update(items, '');
  h.view.scroll.scrollLeft += 333.625;
  let center = logicalCenter(h.host, h.view);
  for (const label of ['Day', 'Week', 'Quarter', 'Year', 'Month']) {
    expectDefined(
      [...h.host.querySelectorAll('button')].find((button) => button.textContent === label),
    ).click();
    expect(logicalCenter(h.host, h.view)).toBeCloseTo(center, 8);
  }
  const row = h.host.querySelector('.abyss-project-timeline-row');
  renderCell.mockClear();
  for (const left of [110.125, 32000.625, 85.375]) {
    h.view.scroll.scrollLeft = left;
    center = logicalCenter(h.host, h.view);
    h.view.scroll.dispatchEvent(new Event('scroll'));
    frames.run();
    expect(logicalCenter(h.host, h.view)).toBeCloseTo(center, 8);
    expect(h.host.querySelector('.abyss-project-timeline-row')).toBe(row);
  }
  expect(renderCell).not.toHaveBeenCalled();
});

it('reveals a project inside the physical buffer but beyond the exposed viewport without remounting unrelated rows', () => {
  const items = [project('Projects/A.md', '2026-09-13'), project('Projects/B.md', '2027-04-08')];
  const h = mount(items);
  mockTimelineGeometry(h.host, h.view, {
    summaryWidth: 180,
    trackWidth: 32768,
    viewportWidth: 900,
  });
  h.view.update(items, '');
  const row = h.host.querySelector('[data-project-path="Projects/A.md"]');
  const distant = expectDefined(
    h.host.querySelector<HTMLElement>(
      '[data-project-path="Projects/B.md"] .abyss-project-timeline-bar',
    ),
  );
  expect(distant.hidden).toBe(false);
  const marker = expectDefined(
    h.host.querySelector<HTMLElement>(
      '[data-project-path="Projects/B.md"] .abyss-project-timeline-boundary-marker',
    ),
  );
  expect(marker.hidden).toBe(false);
  h.view.revealProject('Projects/B.md');
  expect(marker.hidden).toBe(true);
  expect(logicalCenter(h.host, h.view)).toBe(
    (projectCalendarDayOrdinal('2027-04-08') as number) + 0.5,
  );
  expect(h.host.querySelector('[data-project-path="Projects/A.md"]')).toBe(row);
});

it.each([false, true])(
  'waits for measured initial geometry and yields to a newer reveal (%s)',
  (reveal) => {
    const items = [project('Projects/Distant.md', '2032-04-08')];
    const h = mount(items, new Date(2026, 8, 13), 'month', { viewportWidth: 0 });
    if (reveal) h.view.revealProject('Projects/Distant.md');
    mockTimelineGeometry(h.host, h.view, {
      summaryWidth: 180,
      trackWidth: 32768,
      viewportWidth: 900,
    });
    h.view.update(items, '');
    expect(logicalCenter(h.host, h.view)).toBe(
      (projectCalendarDayOrdinal(reveal ? '2032-04-08' : '2026-09-13') as number) + 0.5,
    );
  },
);

it('gives a newer reveal priority over delayed Today in retained geometry', () => {
  const items = [project('Projects/Remote.md', '2032-04-08')];
  const h = mount(items);
  mockTimelineGeometry(h.host, h.view, {
    summaryWidth: 180,
    trackWidth: 32768,
    viewportWidth: 900,
  });
  h.view.update(items, '');
  h.view.revealProject('Projects/Remote.md');
  const center = logicalCenter(h.host, h.view);
  Object.defineProperty(h.view.scroll, 'clientWidth', { configurable: true, value: 0 });
  h.view.focusToday();
  h.view.revealProject('Projects/Remote.md');
  Object.defineProperty(h.view.scroll, 'clientWidth', { configurable: true, value: 900 });
  h.view.update(items, '');
  expect(logicalCenter(h.host, h.view)).toBeCloseTo(center, 8);
});

it('advances retained project row Today markers on a scroll-only midnight frame without rebuilding models or cards', () => {
  const frames = controlledFrames();
  let now = new Date(2026, 9, 26);
  const modelInput = vi.fn(() => ({
    segment: createSearchWordSegmenter(),
    nowMs: Date.UTC(2026, 9, 26),
    fields,
    statuses: DEFAULT_SETTINGS.projects.statuses,
  }));
  const renderCell = vi.fn<ProjectsTimelineViewContext<Cell>['renderCell']>(
    ({ host, project: item, field, occurrenceId, existing }) =>
      existing ?? {
        element: host,
        identity: { projectPath: item.path, columnId: field.id, occurrenceId },
        project: item,
        field,
      },
  );
  const items = [project('Projects/A.md', '2026-10-24', '2026-10-28')];
  const h = mount(items, now, 'month', { now: () => now, modelInput, renderCell });
  mockTimelineGeometry(h.host, h.view, {
    summaryWidth: 180,
    trackWidth: 32768,
    viewportWidth: 900,
  });
  h.view.update(items, '');
  frames.run();
  const row = expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-timeline-row'));
  const marker = expectDefined(row.querySelector<HTMLElement>('.abyss-project-timeline-today'));
  const cells = h.view.renderedCells().map((cell) => cell.element);
  const oldLeft = marker.style.left;
  modelInput.mockClear();
  renderCell.mockClear();
  now = new Date(2026, 9, 27);
  h.view.scroll.scrollLeft += 37.25;
  h.view.scroll.dispatchEvent(new Event('scroll'));
  frames.run();
  const header = expectDefined(
    h.host.querySelector<HTMLElement>(
      '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
    ),
  );
  expect(header.getAttribute('aria-label')).toBe('Today, 2026-10-27');
  expect(marker.getAttribute('aria-label')).toBe('Today, 2026-10-27');
  expect(marker.style.left).not.toBe(oldLeft);
  expect(marker.style.left).toBe(header.style.left);
  expect(h.host.querySelector('.abyss-project-timeline-row')).toBe(row);
  expect(row.querySelector('.abyss-project-timeline-today')).toBe(marker);
  expect(h.view.renderedCells().map((cell) => cell.element)).toEqual(cells);
  expect(modelInput).not.toHaveBeenCalled();
  expect(renderCell).not.toHaveBeenCalled();
});
