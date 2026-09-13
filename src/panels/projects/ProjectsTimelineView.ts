import { setIcon } from 'obsidian';
import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import {
  findProjectFieldById,
  type ProjectColumn,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import type { ProjectTableGroup } from '../../projects/projectTableModel';
import {
  projectTimelineAxisLayout,
  projectTimelineTrackWidth,
  type ProjectTimelineAxisCell,
  type ProjectTimelineAxisLayout,
} from '../../projects/projectTimelineAxis';
import {
  buildProjectTimelineModel,
  projectTimelineBarGeometry,
  projectTimelineFitWindow,
  projectTimelineWindow,
  type ProjectTimelineBarGeometry,
  type ProjectTimelineGroup,
  type ProjectTimelineModel,
  type ProjectTimelineModelInput,
  type ProjectTimelineRange,
  type ProjectTimelineRow,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';
import {
  projectTimelineDescriptionLines,
  projectTimelineFields,
  type ProjectTimelineSettings,
} from '../../projects/projectTimelineSettings';
import type { Project } from '../../projects/types';
import { projectCardFields } from './projectCardFields';
import {
  applyProjectTimelineBarGeometry,
  freezeProjectTimelineRangeBinding,
  ProjectTimelinePointerInteraction,
  type ProjectTimelineRangeCommitter,
} from './projectTimelineInteraction';

export interface ProjectTimelineCellContext {
  readonly element: HTMLElement;
  readonly identity: {
    readonly projectPath: string;
    readonly columnId: string;
    readonly occurrenceId: string;
  };
}

export interface ProjectsTimelineViewContext<
  TCell extends ProjectTimelineCellContext,
> extends ProjectTimelineRangeCommitter {
  readonly settings: () => ProjectTimelineSettings;
  readonly modelInput: () => Omit<ProjectTimelineModelInput, 'projects' | 'settings' | 'search'>;
  readonly renderCell: (options: {
    readonly host: HTMLElement;
    readonly project: Project;
    readonly field: ProjectFieldCatalogItem;
    readonly column?: ProjectColumn;
    readonly occurrenceId: string;
    readonly groupKey: string;
    readonly existing?: TCell;
  }) => TCell;
  readonly selectCell: (cell: TCell) => void;
  readonly requestViewChange: (mutation: () => void) => Promise<boolean>;
  readonly requestNavigation: (action: () => void) => void;
  readonly requestScaleChange: (scale: ProjectTimelineSettings['scale']) => Promise<boolean>;
  readonly renderGroupContent: (
    marker: HTMLElement,
    label: HTMLElement,
    group: ProjectTableGroup,
  ) => void;
  readonly statusColor: (project: Project) => string | undefined;
  readonly openRangeMenu: (occurrenceId: string, event: MouseEvent | KeyboardEvent) => void;
  readonly finishEditor: () => Promise<boolean>;
  readonly now?: () => Date;
}

export interface ProjectTimelineViewportState {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly anchorDay: string;
}

interface RenderedRow<TCell extends ProjectTimelineCellContext> {
  readonly element: HTMLElement;
  readonly summary: HTMLElement;
  readonly name: HTMLElement;
  readonly metadata: HTMLElement;
  readonly progress: HTMLElement;
  readonly track: HTMLElement;
  readonly grid: HTMLElement;
  readonly bar: HTMLElement;
  readonly startHandle: HTMLElement;
  readonly endHandle: HTMLElement;
  readonly state: HTMLElement;
  readonly rangeName: HTMLElement;
  readonly rangeDescription: HTMLElement;
  readonly cells: Map<string, TCell>;
  project: Project;
  range: ProjectTimelineRange;
  groupKey: string;
}

interface RenderedGroup<TCell extends ProjectTimelineCellContext> {
  readonly element: HTMLElement;
  readonly header: HTMLButtonElement;
  readonly chevron: HTMLElement;
  readonly marker: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly body: HTMLElement;
  readonly rows: Map<string, RenderedRow<TCell>>;
}

interface TimelineScrollPosition {
  readonly left: number;
  readonly top: number;
}

interface TimelineAxisGeometry {
  readonly summaryWidth: number;
  readonly trackStart: number;
  readonly trackWidth: number;
  readonly viewportWidth: number;
}

const TIMELINE_SCALES = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['quarter', 'Quarter'],
  ['year', 'Year'],
] as const;

interface TimelineFocusIdentity {
  readonly projectPath: string;
  readonly part: 'bar' | 'track';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function dayOrdinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}

function dayDate(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const value = new Date(0);
  value.setFullYear(year, month - 1, date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function dayFromOrdinal(ordinal: number): string {
  return projectCalendarDayFromOrdinal(ordinal) as string;
}

function localDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rangeAnchor(range: ProjectTimelineRange): string | undefined {
  if (range.kind === 'closed' || range.kind === 'open-end') return range.startDay;
  return range.kind === 'open-start' ? range.endDay : undefined;
}

function rangeBounds(range: ProjectTimelineRange): readonly string[] {
  if (range.kind === 'closed') return [range.startDay, range.endDay];
  const anchor = rangeAnchor(range);
  return anchor === undefined ? [] : [anchor];
}

function timelineRangeLabel(range: ProjectTimelineRange): string {
  if (range.kind === 'open-start') {
    return `No start date, ends ${range.endDay}`;
  }
  if (range.kind === 'open-end') {
    return `Starts ${range.startDay}, no end date`;
  }
  if (range.kind === 'closed') {
    return `${range.startDay} through ${range.endDay}`;
  }
  return 'Timeline date range';
}

function timelineRangeInstructions(range: ProjectTimelineRange): string {
  return range.kind === 'open-end'
    ? 'Arrow keys move. Shift plus Arrow sets End.'
    : 'Arrow keys move. Shift plus Arrow adjusts End.';
}

function rangeEndpoint(range: ProjectTimelineRange, endpoint: 'start' | 'end'): string | undefined {
  if (endpoint === 'start' && (range.kind === 'closed' || range.kind === 'open-end')) {
    return range.startDay;
  }
  if (endpoint === 'end' && (range.kind === 'closed' || range.kind === 'open-start')) {
    return range.endDay;
  }
  return undefined;
}

function endpointVisible(day: string | undefined, window: ProjectTimelineWindow): boolean {
  if (day === undefined) return false;
  const value = dayOrdinal(day);
  return value >= dayOrdinal(window.startDay) && value <= dayOrdinal(window.endDay);
}

function requestsRangeMenu(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

function rangeArrowDelta(event: KeyboardEvent): -1 | 1 | undefined {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return undefined;
  if (event.key === 'ArrowLeft') return -1;
  return event.key === 'ArrowRight' ? 1 : undefined;
}

function rangeTargetAttributes(part: 'track' | 'bar'): Record<string, string> {
  return {
    tabindex: '0',
    role: 'button',
    'data-timeline-part': part,
    'aria-keyshortcuts': 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight',
  };
}

function exactRangeEventTarget(
  event: Event,
  track: HTMLElement,
  bar: HTMLElement,
): HTMLElement | undefined {
  if (event.target === track) return track;
  if (event.target === bar) return bar;
  if (
    event.target instanceof Element &&
    event.target.closest('.abyss-project-timeline-handle')?.parentElement === bar
  ) {
    return bar;
  }
  return undefined;
}

function calendarWindowYears(scale: ProjectTimelineSettings['scale']): number {
  if (scale === 'month') return 1;
  if (scale === 'quarter') return 3;
  return 5;
}

function fallbackAxisDayCount(scale: ProjectTimelineSettings['scale']): number {
  if (scale === 'day') return 31;
  if (scale === 'week') return 140;
  if (scale === 'month') return 732;
  return scale === 'quarter' ? 2_922 : 11_688;
}

function reconcileOrder(parent: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor = parent.firstChild;
  for (const element of desired) {
    if (element === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(element, cursor);
  }
}

let timelineRangeAccessibilitySequence = 0;

export class ProjectsTimelineView<TCell extends ProjectTimelineCellContext> {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  private readonly axis_abyssPrivate: HTMLElement;
  private readonly axisSummary_abyssPrivate: HTMLElement;
  private readonly axisRange_abyssPrivate: HTMLElement;
  private readonly axisDates_abyssPrivate: HTMLElement;
  private readonly axisHierarchy_abyssPrivate: HTMLElement;
  private readonly axisCells_abyssPrivate: HTMLElement;
  private readonly groupsHost_abyssPrivate: HTMLElement;
  private readonly groups_abyssPrivate = new Map<string, RenderedGroup<TCell>>();
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private visibleCells_abyssPrivate: TCell[] = [];
  private projects_abyssPrivate: readonly Project[] = [];
  private search_abyssPrivate = '';
  private model_abyssPrivate: ProjectTimelineModel | undefined;
  private anchor_abyssPrivate: Date;
  private renderedScale_abyssPrivate: ProjectTimelineSettings['scale'];
  private preparedScaleChange_abyssPrivate = false;
  private scaleContextOrdinal_abyssPrivate: number | undefined;
  private fittedWindow_abyssPrivate: ProjectTimelineWindow | undefined;
  private selectedPath_abyssPrivate: string | undefined;
  private hiddenScrollPosition_abyssPrivate: TimelineScrollPosition | undefined;
  private readonly scaleButtons_abyssPrivate = new Map<
    ProjectTimelineSettings['scale'],
    HTMLButtonElement
  >();
  private readonly interaction_abyssPrivate: ProjectTimelinePointerInteraction;
  private readonly resizeObserver_abyssPrivate: ResizeObserver | undefined;
  private axisFrame_abyssPrivate: number | undefined;
  private axisLayout_abyssPrivate: ProjectTimelineAxisLayout = {
    cells: [],
    hierarchyCells: [],
    gridBoundaries: [],
  };

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsTimelineViewContext<TCell>,
  ) {
    this.anchor_abyssPrivate = new Date((context_abyssPrivate.now ?? (() => new Date()))());
    this.renderedScale_abyssPrivate = context_abyssPrivate.settings().scale;
    this.root = host.createDiv({ cls: 'abyss-project-timeline', attr: { tabindex: '-1' } });
    this.scroll = this.root.createDiv({
      cls: 'abyss-project-timeline-scroll',
      attr: { tabindex: '0', 'aria-label': 'Project Timeline' },
    });
    this.axis_abyssPrivate = this.scroll.createDiv({ cls: 'abyss-project-timeline-axis' });
    this.axisSummary_abyssPrivate = this.axis_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-axis-summary',
    });
    this.axisRange_abyssPrivate = this.axisSummary_abyssPrivate.createSpan({
      cls: 'abyss-project-timeline-axis-range abyss-sr-only',
    });
    this.axisRange_abyssPrivate.id = `abyss-project-timeline-axis-range-${String(++timelineRangeAccessibilitySequence)}`;
    this.scroll.setAttribute('aria-describedby', this.axisRange_abyssPrivate.id);
    this.createNavigation_abyssPrivate();
    this.axisDates_abyssPrivate = this.axis_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-axis-dates',
    });
    this.axisHierarchy_abyssPrivate = this.axisDates_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-axis-hierarchy',
      attr: { 'aria-hidden': 'true' },
    });
    this.axisCells_abyssPrivate = this.axisDates_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-axis-cells',
      attr: { 'aria-hidden': 'true' },
    });
    this.groupsHost_abyssPrivate = this.scroll.createDiv({ cls: 'abyss-project-timeline-groups' });
    this.scroll.addEventListener('scroll', this.handleScroll_abyssPrivate);
    this.syncRangeStateOffset_abyssPrivate();
    this.resizeObserver_abyssPrivate = this.createResizeObserver_abyssPrivate();
    this.resizeObserver_abyssPrivate?.observe(this.scroll);
    this.interaction_abyssPrivate = new ProjectTimelinePointerInteraction({
      root: this.root,
      scroll: this.scroll,
      window: () => this.currentWindow_abyssPrivate(),
      captureRangeSource: context_abyssPrivate.captureRangeSource,
      commitRangeEdit: context_abyssPrivate.commitRangeEdit,
      reportRangeFailure: context_abyssPrivate.reportRangeFailure,
      finishEditor: context_abyssPrivate.finishEditor,
      selectRange: (occurrenceId, focus) => {
        const row = this.findRowByOccurrence_abyssPrivate(occurrenceId);
        if (row !== undefined) this.selectRange_abyssPrivate(row, focus);
      },
    });
  }

  private createNavigation_abyssPrivate(): void {
    const navigation = this.axisSummary_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-navigation',
    });
    const rangeNavigation = navigation.createDiv({
      cls: 'abyss-project-timeline-range-navigation',
    });
    this.addNavigationButton_abyssPrivate(rangeNavigation, 'Previous range', 'chevron-left', () => {
      this.context_abyssPrivate.requestNavigation(() => {
        this.moveAnchor_abyssPrivate(-1);
      });
    });
    const todayButton = this.addTextButton_abyssPrivate(rangeNavigation, 'Today', () => {
      this.context_abyssPrivate.requestNavigation(() => {
        const today = new Date((this.context_abyssPrivate.now ?? (() => new Date()))());
        this.anchor_abyssPrivate = today;
        this.fittedWindow_abyssPrivate = undefined;
        this.scaleContextOrdinal_abyssPrivate = dayOrdinal(localDay(today));
        this.render_abyssPrivate(true);
      });
    });
    todayButton.addClass('abyss-cal-nav-today');
    this.addNavigationButton_abyssPrivate(rangeNavigation, 'Next range', 'chevron-right', () => {
      this.context_abyssPrivate.requestNavigation(() => {
        this.moveAnchor_abyssPrivate(1);
      });
    });
    const scaleControl = navigation.createDiv({
      cls: 'abyss-project-timeline-scale-control abyss-cal-view-switcher',
      attr: { role: 'group', 'aria-label': 'Timeline scale' },
    });
    for (const [scale, label] of TIMELINE_SCALES) {
      const button = this.addTextButton_abyssPrivate(scaleControl, label, () => {
        void this.context_abyssPrivate.requestScaleChange(scale).catch((error: unknown) => {
          console.error('[abyss-tasks] Could not change project Timeline scale', error);
        });
      });
      button.addClass('abyss-cal-view-btn');
      this.scaleButtons_abyssPrivate.set(scale, button);
    }
  }

  mount(projects: readonly Project[], search: string): void {
    this.update(projects, search);
  }

  update(projects: readonly Project[], search: string): void {
    this.projects_abyssPrivate = projects;
    this.search_abyssPrivate = search;
    this.handleScaleTransition_abyssPrivate();
    this.render_abyssPrivate(false);
  }

  destroy(): void {
    this.interaction_abyssPrivate.destroy();
    this.scroll.removeEventListener('scroll', this.handleScroll_abyssPrivate);
    this.resizeObserver_abyssPrivate?.disconnect();
    const ownerWindow = this.root.ownerDocument.defaultView;
    if (this.axisFrame_abyssPrivate !== undefined && ownerWindow !== null) {
      ownerWindow.cancelAnimationFrame(this.axisFrame_abyssPrivate);
    }
    this.axisFrame_abyssPrivate = undefined;
    this.groups_abyssPrivate.clear();
    this.visibleCells_abyssPrivate = [];
    this.root.remove();
  }

  visibleCells(): readonly TCell[] {
    return this.visibleCells_abyssPrivate;
  }

  currentModel(): ProjectTimelineModel | undefined {
    return this.model_abyssPrivate;
  }

  visibleRow(occurrenceId: string): ProjectTimelineRow | undefined {
    for (const group of this.model_abyssPrivate?.groups ?? []) {
      if (this.collapsedGroups_abyssPrivate.has(group.key)) continue;
      const row = group.rows.find((candidate) => candidate.occurrenceId === occurrenceId);
      if (row !== undefined) return row;
    }
    return undefined;
  }

  selectedProjectPath(): string | undefined {
    return this.selectedPath_abyssPrivate;
  }

  syncSelectedProjectPath(path: string | undefined): void {
    this.selectedPath_abyssPrivate = path;
    this.syncSelectedRows_abyssPrivate();
  }

  retainedViewportState(): ProjectTimelineViewportState {
    return {
      scrollLeft: this.scroll.scrollLeft,
      scrollTop: this.scroll.scrollTop,
      anchorDay: localDay(this.anchor_abyssPrivate),
    };
  }

  captureViewportBeforeHide(): void {
    this.interaction_abyssPrivate.cancelActive();
    this.hiddenScrollPosition_abyssPrivate = {
      left: this.scroll.scrollLeft,
      top: this.scroll.scrollTop,
    };
  }

  cancelInteraction(): void {
    this.interaction_abyssPrivate.cancelActive();
  }

  prepareScaleChange(): void {
    this.preparedScaleChange_abyssPrivate = true;
  }

  revealProject(path: string): void {
    const located = this.findLocatedRow_abyssPrivate(path);
    if (located !== undefined && this.collapsedGroups_abyssPrivate.delete(located.groupKey)) {
      this.render_abyssPrivate(false);
    }
    const row = this.findRow_abyssPrivate(path);
    if (row === undefined) return;
    const window = this.currentWindow_abyssPrivate();
    let revealedOrdinal: number | undefined;
    if (projectTimelineBarGeometry(row.range, window) === undefined) {
      const anchor = rangeAnchor(row.range);
      if (anchor !== undefined) {
        revealedOrdinal = dayOrdinal(anchor);
        this.anchor_abyssPrivate = dayDate(anchor);
        this.fittedWindow_abyssPrivate = undefined;
        this.scaleContextOrdinal_abyssPrivate = revealedOrdinal;
        this.render_abyssPrivate(true);
      }
    }
    const element = this.findRow_abyssPrivate(path)?.element;
    if (element !== undefined && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (revealedOrdinal !== undefined) {
      this.scroll.scrollLeft = this.scaleScrollLeft_abyssPrivate(
        this.currentWindow_abyssPrivate(),
        revealedOrdinal,
        this.scroll.scrollLeft,
      );
    }
  }

  private addNavigationButton_abyssPrivate(
    host: HTMLElement,
    label: string,
    icon: string,
    action: () => void,
  ): void {
    const button = host.createEl('button', {
      cls: 'clickable-icon abyss-cal-nav-btn',
      attr: { type: 'button', 'aria-label': label },
    });
    setIcon(button, icon);
    button.addEventListener('click', action);
  }

  private addTextButton_abyssPrivate(
    host: HTMLElement,
    label: string,
    action: () => void,
  ): HTMLButtonElement {
    const button = host.createEl('button', { text: label, attr: { type: 'button' } });
    button.addEventListener('click', action);
    return button;
  }

  private syncScaleButtons_abyssPrivate(): void {
    const scale = this.context_abyssPrivate.settings().scale;
    for (const [candidate, button] of this.scaleButtons_abyssPrivate) {
      const active = candidate === scale;
      button.setAttribute('aria-pressed', String(active));
      button.toggleClass('is-active', active);
    }
  }

  private handleScaleTransition_abyssPrivate(): void {
    const scale = this.context_abyssPrivate.settings().scale;
    if (scale === this.renderedScale_abyssPrivate) return;
    this.fittedWindow_abyssPrivate = undefined;
    this.renderedScale_abyssPrivate = scale;
  }

  private scaleScrollLeft_abyssPrivate(
    window: ProjectTimelineWindow,
    contextOrdinal: number,
    fallback: number,
  ): number {
    const geometry = this.axisGeometry_abyssPrivate();
    if (geometry === undefined) return fallback;
    const { summaryWidth, trackStart, trackWidth, viewportWidth } = geometry;
    const fraction =
      (contextOrdinal - dayOrdinal(window.startDay) + 0.5) / Math.max(1, window.dayCount);
    const contextPosition = trackStart + clamp(fraction, 0, 1) * trackWidth;
    const centered = contextPosition - (summaryWidth + viewportWidth) / 2;
    return clamp(centered, 0, Math.max(0, trackStart + trackWidth - viewportWidth));
  }

  private axisGeometry_abyssPrivate(): TimelineAxisGeometry | undefined {
    const summary = this.axis_abyssPrivate.querySelector<HTMLElement>(
      '.abyss-project-timeline-axis-summary',
    );
    const dates = this.axis_abyssPrivate.querySelector<HTMLElement>(
      '.abyss-project-timeline-axis-dates',
    );
    if (summary === null || dates === null) return undefined;
    const viewport = this.scroll.getBoundingClientRect();
    const summaryBounds = summary.getBoundingClientRect();
    const dateBounds = dates.getBoundingClientRect();
    const excludedWidth = Math.max(0, this.scroll.offsetWidth - this.scroll.clientWidth);
    const viewportWidth =
      viewport.width > 0 ? viewport.width - excludedWidth : this.scroll.clientWidth;
    if (dateBounds.width <= 0 || viewportWidth <= summaryBounds.width) return undefined;
    return {
      summaryWidth: summaryBounds.width,
      trackStart:
        dateBounds.left - (viewport.left + this.scroll.clientLeft) + this.scroll.scrollLeft,
      trackWidth: dateBounds.width,
      viewportWidth,
    };
  }

  private moveAnchor_abyssPrivate(direction: -1 | 1): void {
    const scale = this.context_abyssPrivate.settings().scale;
    if (this.fittedWindow_abyssPrivate !== undefined) {
      const context =
        dayOrdinal(this.fittedWindow_abyssPrivate.startDay) +
        Math.floor((this.fittedWindow_abyssPrivate.dayCount - 1) / 2);
      this.anchor_abyssPrivate = dayDate(dayFromOrdinal(context));
    }
    this.fittedWindow_abyssPrivate = undefined;
    if (scale === 'day' || scale === 'week') {
      const span = scale === 'day' ? 14 : 84;
      this.anchor_abyssPrivate = dayDate(
        dayFromOrdinal(dayOrdinal(localDay(this.anchor_abyssPrivate)) + span * direction),
      );
    } else {
      const years = calendarWindowYears(scale);
      const current = this.anchor_abyssPrivate;
      const shifted = new Date(0);
      shifted.setFullYear(current.getFullYear() + years * direction, current.getMonth(), 1);
      const lastDay = new Date(0);
      lastDay.setFullYear(shifted.getFullYear(), shifted.getMonth() + 1, 0);
      shifted.setDate(Math.min(current.getDate(), lastDay.getDate()));
      shifted.setHours(0, 0, 0, 0);
      this.anchor_abyssPrivate = shifted;
    }
    this.render_abyssPrivate(true);
  }

  private fittedWindowForModel_abyssPrivate(
    model: ProjectTimelineModel,
  ): ProjectTimelineWindow | undefined {
    const bounds = model.groups.flatMap(({ rows }) =>
      rows.flatMap(({ range }) => rangeBounds(range)),
    );
    if (bounds.length === 0) return undefined;
    bounds.sort((left, right) => dayOrdinal(left) - dayOrdinal(right));
    return projectTimelineFitWindow(
      bounds[0] as string,
      bounds[bounds.length - 1] as string,
      this.context_abyssPrivate.settings().scale,
    );
  }

  private currentWindow_abyssPrivate(): ProjectTimelineWindow {
    return (
      this.fittedWindow_abyssPrivate ??
      projectTimelineWindow(this.anchor_abyssPrivate, this.context_abyssPrivate.settings().scale)
    );
  }

  private render_abyssPrivate(navigation: boolean): void {
    this.syncScaleButtons_abyssPrivate();
    const focused = this.focusedDescendant_abyssPrivate();
    const focusedRange = this.focusedRangeIdentity_abyssPrivate(focused);
    const hiddenPosition = this.hiddenScrollPosition_abyssPrivate;
    const left = hiddenPosition?.left ?? this.scroll.scrollLeft;
    const top = hiddenPosition?.top ?? this.scroll.scrollTop;
    this.hiddenScrollPosition_abyssPrivate = undefined;
    const input = this.context_abyssPrivate.modelInput();
    const model = buildProjectTimelineModel({
      ...input,
      projects: this.projects_abyssPrivate,
      settings: this.context_abyssPrivate.settings(),
      search: this.search_abyssPrivate,
    });
    this.model_abyssPrivate = model;
    if (this.preparedScaleChange_abyssPrivate) {
      this.preparedScaleChange_abyssPrivate = false;
      this.renderedScale_abyssPrivate = this.context_abyssPrivate.settings().scale;
      this.fittedWindow_abyssPrivate = this.fittedWindowForModel_abyssPrivate(model);
      if (this.fittedWindow_abyssPrivate === undefined) {
        this.anchor_abyssPrivate = new Date(
          (this.context_abyssPrivate.now ?? (() => new Date()))(),
        );
        this.scaleContextOrdinal_abyssPrivate = dayOrdinal(localDay(this.anchor_abyssPrivate));
      } else {
        this.scaleContextOrdinal_abyssPrivate = dayOrdinal(this.fittedWindow_abyssPrivate.startDay);
      }
    }
    const window = this.currentWindow_abyssPrivate();
    this.syncTrackWidth_abyssPrivate(window);
    this.patchAxis_abyssPrivate(window);
    this.reconcileGroups_abyssPrivate(model.groups, window);
    this.interaction_abyssPrivate.reconcileAfterRender();
    this.syncSelectedRows_abyssPrivate();
    this.restoreScroll_abyssPrivate(navigation, window, left, top);
    this.patchVisibleCalendar_abyssPrivate(window);
    this.restoreFocus_abyssPrivate(focused, focusedRange);
  }

  private restoreScroll_abyssPrivate(
    navigation: boolean,
    window: ProjectTimelineWindow,
    left: number,
    top: number,
  ): void {
    if (this.scaleContextOrdinal_abyssPrivate !== undefined) {
      this.scroll.scrollLeft = this.scaleScrollLeft_abyssPrivate(
        window,
        this.scaleContextOrdinal_abyssPrivate,
        left,
      );
      this.scroll.scrollTop = top;
      this.scaleContextOrdinal_abyssPrivate = undefined;
    } else if (!navigation) {
      this.scroll.scrollLeft = left;
      this.scroll.scrollTop = top;
    }
    this.syncRangeStateOffset_abyssPrivate();
  }

  private readonly handleScroll_abyssPrivate = (): void => {
    this.syncRangeStateOffset_abyssPrivate();
    this.scheduleAxisPatch_abyssPrivate();
  };

  private readonly scheduleAxisPatch_abyssPrivate = (): void => {
    if (this.axisFrame_abyssPrivate !== undefined) return;
    const ownerWindow = this.root.ownerDocument.defaultView;
    if (ownerWindow === null || typeof ownerWindow.requestAnimationFrame !== 'function') {
      this.patchVisibleCalendar_abyssPrivate(this.currentWindow_abyssPrivate());
      return;
    }
    this.axisFrame_abyssPrivate = ownerWindow.requestAnimationFrame(() => {
      this.axisFrame_abyssPrivate = undefined;
      const window = this.currentWindow_abyssPrivate();
      this.syncTrackWidth_abyssPrivate(window);
      this.patchVisibleCalendar_abyssPrivate(window);
    });
  };

  private createResizeObserver_abyssPrivate(): ResizeObserver | undefined {
    const ResizeObserverClass = this.root.ownerDocument.defaultView?.ResizeObserver;
    return ResizeObserverClass === undefined
      ? undefined
      : new ResizeObserverClass(this.scheduleAxisPatch_abyssPrivate);
  }

  private readonly syncRangeStateOffset_abyssPrivate = (): void => {
    this.root.style.setProperty(
      '--abyss-project-timeline-range-state-left',
      `${this.scroll.scrollLeft + 10}px`,
    );
    this.root.style.setProperty(
      '--abyss-project-timeline-range-state-right',
      `${Math.max(10, this.scroll.scrollWidth - this.scroll.scrollLeft - this.scroll.clientWidth + 10)}px`,
    );
  };

  private restoreFocus_abyssPrivate(
    focused: HTMLElement | undefined,
    focusedRange: TimelineFocusIdentity | undefined,
  ): void {
    if (focused?.isConnected === true && this.root.ownerDocument.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      return;
    }
    if (focused === undefined || focused.isConnected || focusedRange === undefined) return;
    const row = this.findRow_abyssPrivate(focusedRange.projectPath);
    let replacement = this.root;
    if (row !== undefined) {
      replacement = focusedRange.part === 'bar' && !row.bar.hidden ? row.bar : row.track;
    }
    replacement.focus({ preventScroll: true });
  }

  private syncTrackWidth_abyssPrivate(window: ProjectTimelineWindow): void {
    const summaryWidth = this.axisSummary_abyssPrivate.getBoundingClientRect().width;
    const viewportWidth = Math.max(0, this.scroll.clientWidth - summaryWidth);
    const trackWidth = projectTimelineTrackWidth(window, viewportWidth);
    this.root.style.setProperty('--abyss-project-timeline-track-width', `${String(trackWidth)}px`);
    this.axisDates_abyssPrivate.dataset['trackWidth'] = String(trackWidth);
  }

  private visibleAxisSlice_abyssPrivate(window: ProjectTimelineWindow): {
    readonly visibleStartDay: string;
    readonly visibleEndDay: string;
    readonly visibleStartPercent: number;
  } {
    const geometry = this.axisGeometry_abyssPrivate();
    const first = dayOrdinal(window.startDay);
    const last = dayOrdinal(window.endDay);
    if (geometry === undefined) {
      return {
        visibleStartDay: window.startDay,
        visibleEndDay: dayFromOrdinal(
          Math.min(last, first + fallbackAxisDayCount(window.scale) - 1),
        ),
        visibleStartPercent: 0,
      };
    }
    const visibleLeft = clamp(
      this.scroll.scrollLeft + geometry.summaryWidth - geometry.trackStart,
      0,
      geometry.trackWidth,
    );
    const visibleRight = clamp(
      this.scroll.scrollLeft + geometry.viewportWidth - geometry.trackStart,
      visibleLeft,
      geometry.trackWidth,
    );
    const startOffset = Math.min(
      window.dayCount - 1,
      Math.floor((visibleLeft / geometry.trackWidth) * window.dayCount),
    );
    const endOffset = Math.min(
      window.dayCount - 1,
      Math.max(startOffset, Math.ceil((visibleRight / geometry.trackWidth) * window.dayCount) - 1),
    );
    return {
      visibleStartDay: dayFromOrdinal(first + startOffset),
      visibleEndDay: dayFromOrdinal(first + endOffset),
      visibleStartPercent: (visibleLeft / geometry.trackWidth) * 100,
    };
  }

  private patchAxis_abyssPrivate(window: ProjectTimelineWindow): void {
    const today = localDay((this.context_abyssPrivate.now ?? (() => new Date()))());
    this.axisLayout_abyssPrivate = projectTimelineAxisLayout(window, {
      ...this.visibleAxisSlice_abyssPrivate(window),
      overscanCells: 1,
      todayDay: today,
    });
    this.axisRange_abyssPrivate.setText(`${window.startDay} – ${window.endDay}`);
    this.patchAxisCells_abyssPrivate(
      this.axisHierarchy_abyssPrivate,
      this.axisLayout_abyssPrivate.hierarchyCells,
      'abyss-project-timeline-axis-hierarchy-cell',
      true,
    );
    this.patchAxisCells_abyssPrivate(
      this.axisCells_abyssPrivate,
      this.axisLayout_abyssPrivate.cells,
      `abyss-project-timeline-axis-cell${window.scale === 'day' ? ' is-day' : ''}`,
      false,
    );
    this.axisDates_abyssPrivate.toggleClass(
      'is-single-tier',
      this.axisLayout_abyssPrivate.hierarchyCells.length === 0,
    );
    for (const marker of this.axisDates_abyssPrivate.querySelectorAll(
      ':scope > .abyss-project-timeline-today',
    )) {
      marker.remove();
    }
    this.addTodayMarker_abyssPrivate(this.axisDates_abyssPrivate, window);
  }

  private patchAxisCells_abyssPrivate(
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

  private patchVisibleCalendar_abyssPrivate(window: ProjectTimelineWindow): void {
    this.patchAxis_abyssPrivate(window);
    for (const group of this.groups_abyssPrivate.values()) {
      for (const row of group.rows.values()) {
        this.patchGrid_abyssPrivate(row.grid);
      }
    }
  }

  private addTodayMarker_abyssPrivate(host: HTMLElement, window: ProjectTimelineWindow): void {
    const today = localDay((this.context_abyssPrivate.now ?? (() => new Date()))());
    const offset = dayOrdinal(today) - dayOrdinal(window.startDay);
    if (offset < 0 || offset >= window.dayCount) return;
    const marker = host.createDiv({
      cls: 'abyss-project-timeline-today',
      attr: { 'aria-label': `Today, ${today}` },
    });
    marker.style.left = `${((offset + 0.5) / window.dayCount) * 100}%`;
  }

  private reconcileGroups_abyssPrivate(
    groups: readonly ProjectTimelineGroup[],
    window: ProjectTimelineWindow,
  ): void {
    const desired: HTMLElement[] = [];
    const retained = new Set<string>();
    const cells: TCell[] = [];
    const grouped = this.context_abyssPrivate.settings().groupBy !== 'none';
    for (const model of groups) {
      retained.add(model.key);
      const group =
        this.groups_abyssPrivate.get(model.key) ?? this.createGroup_abyssPrivate(model.key);
      this.groups_abyssPrivate.set(model.key, group);
      group.header.hidden = !grouped;
      group.header.setAttribute(
        'aria-expanded',
        String(!this.collapsedGroups_abyssPrivate.has(model.key)),
      );
      group.chevron.empty();
      const chevron = this.collapsedGroups_abyssPrivate.has(model.key)
        ? 'chevron-right'
        : 'chevron-down';
      group.chevron.dataset['icon'] = chevron;
      setIcon(group.chevron, chevron);
      this.context_abyssPrivate.renderGroupContent(group.marker, group.label, {
        ...model,
        projects: model.rows.map(({ project }) => project),
      });
      group.count.setText(String(model.rows.length));
      group.body.hidden = this.collapsedGroups_abyssPrivate.has(model.key);
      this.reconcileRows_abyssPrivate(group, model, window, cells);
      desired.push(group.element);
    }
    for (const [key, group] of this.groups_abyssPrivate) {
      if (retained.has(key)) continue;
      group.element.remove();
      this.groups_abyssPrivate.delete(key);
    }
    reconcileOrder(this.groupsHost_abyssPrivate, desired);
    this.visibleCells_abyssPrivate = cells;
  }

  private createGroup_abyssPrivate(key: string): RenderedGroup<TCell> {
    const element = this.groupsHost_abyssPrivate.createDiv({ cls: 'abyss-project-timeline-group' });
    const header = element.createEl('button', {
      cls: 'abyss-project-timeline-group-header',
      attr: { type: 'button' },
    });
    const group: RenderedGroup<TCell> = {
      element,
      header,
      chevron: header.createSpan({ cls: 'abyss-project-table-group-chevron' }),
      marker: header.createSpan({ cls: 'abyss-status-dot' }),
      label: header.createSpan({ cls: 'abyss-projects-group-label' }),
      count: header.createSpan({ cls: 'abyss-projects-group-count' }),
      body: element.createDiv({ cls: 'abyss-project-timeline-group-body' }),
      rows: new Map(),
    };
    header.addEventListener('click', () => {
      this.toggleGroup_abyssPrivate(key);
    });
    return group;
  }

  private reconcileRows_abyssPrivate(
    group: RenderedGroup<TCell>,
    model: ProjectTimelineGroup,
    window: ProjectTimelineWindow,
    visibleCells: TCell[],
  ): void {
    const desired: HTMLElement[] = [];
    const retained = new Set<string>();
    for (const item of model.rows) {
      retained.add(item.occurrenceId);
      const row =
        group.rows.get(item.occurrenceId) ?? this.createRow_abyssPrivate(group, item, model.key);
      group.rows.set(item.occurrenceId, row);
      row.project = item.project;
      row.range = item.range;
      row.groupKey = model.key;
      row.element.dataset['projectPath'] = item.project.path;
      row.element.dataset['occurrenceId'] = item.occurrenceId;
      row.track.dataset['occurrenceId'] = item.occurrenceId;
      this.patchRow_abyssPrivate(row, item, visibleCells, window);
      desired.push(row.element);
    }
    for (const [key, row] of group.rows) {
      if (retained.has(key)) continue;
      row.element.remove();
      group.rows.delete(key);
    }
    reconcileOrder(group.body, desired);
  }

  private createRangeAccessibility_abyssPrivate(track: HTMLElement): {
    readonly name: HTMLElement;
    readonly description: HTMLElement;
    readonly attributes: Record<string, string>;
  } {
    const name = track.createSpan({ cls: 'abyss-sr-only' });
    const description = track.createSpan({ cls: 'abyss-sr-only' });
    const accessibleId = `abyss-project-timeline-range-${String(++timelineRangeAccessibilitySequence)}`;
    name.id = `${accessibleId}-name`;
    description.id = `${accessibleId}-description`;
    const attributes = {
      'aria-labelledby': name.id,
      'aria-describedby': description.id,
    };
    for (const [attribute, value] of Object.entries(attributes)) {
      track.setAttribute(attribute, value);
    }
    return { name, description, attributes };
  }

  private createRangeHandle_abyssPrivate(bar: HTMLElement, endpoint: 'start' | 'end'): HTMLElement {
    const handle = bar.createSpan({
      cls: `abyss-project-timeline-handle is-${endpoint}`,
      attr: { 'data-timeline-part': endpoint, 'aria-hidden': 'true' },
    });
    handle.createSpan({ cls: 'abyss-project-timeline-grip' });
    return handle;
  }

  private createRow_abyssPrivate(
    group: RenderedGroup<TCell>,
    item: ProjectTimelineRow,
    groupKey: string,
  ): RenderedRow<TCell> {
    const element = group.body.createDiv({ cls: 'abyss-project-timeline-row' });
    const summary = element.createDiv({ cls: 'abyss-project-timeline-summary' });
    const track = element.createDiv({
      cls: 'abyss-project-timeline-track',
      attr: rangeTargetAttributes('track'),
    });
    const accessibility = this.createRangeAccessibility_abyssPrivate(track);
    const grid = track.createDiv({
      cls: 'abyss-project-timeline-grid',
      attr: { 'aria-hidden': 'true' },
    });
    const bar = track.createDiv({
      cls: 'abyss-project-timeline-bar',
      attr: { ...rangeTargetAttributes('bar'), ...accessibility.attributes },
    });
    const startHandle = this.createRangeHandle_abyssPrivate(bar, 'start');
    const endHandle = this.createRangeHandle_abyssPrivate(bar, 'end');
    const row: RenderedRow<TCell> = {
      element,
      summary,
      name: summary.createDiv({ cls: 'abyss-project-timeline-name' }),
      metadata: summary.createDiv({ cls: 'abyss-project-timeline-metadata' }),
      progress: summary.createDiv({ cls: 'abyss-project-timeline-progress' }),
      track,
      grid,
      bar,
      startHandle,
      endHandle,
      state: track.createSpan({ cls: 'abyss-project-timeline-state' }),
      rangeName: accessibility.name,
      rangeDescription: accessibility.description,
      cells: new Map(),
      project: item.project,
      range: item.range,
      groupKey,
    };
    track.addEventListener('keydown', (event) => {
      const focus = exactRangeEventTarget(event, track, bar);
      if (focus === undefined) return;
      this.handleRangeKeydown_abyssPrivate(row, event, focus);
    });
    track.addEventListener('contextmenu', (event) => {
      const focus = exactRangeEventTarget(event, track, bar);
      if (focus === undefined) return;
      event.preventDefault();
      this.selectRange_abyssPrivate(row, focus);
      this.context_abyssPrivate.openRangeMenu(row.element.dataset['occurrenceId'] ?? '', event);
    });
    element.addEventListener('click', (event) => {
      if (
        event.target instanceof Element &&
        (event.target.closest('.abyss-project-table-cell') !== null ||
          event.target.closest('[data-timeline-part]') !== null)
      )
        return;
      this.selectedPath_abyssPrivate = row.project.path;
      const cell = row.cells.get('name') ?? row.cells.values().next().value;
      if (cell !== undefined) this.context_abyssPrivate.selectCell(cell);
      this.syncSelectedRows_abyssPrivate();
    });
    return row;
  }

  private patchRow_abyssPrivate(
    row: RenderedRow<TCell>,
    item: ProjectTimelineRow,
    visibleCells: TCell[],
    window: ProjectTimelineWindow,
  ): void {
    const fields = this.context_abyssPrivate.modelInput().fields;
    const retained = new Set<string>();
    const name = findProjectFieldById(fields, 'name');
    if (name !== undefined) {
      this.renderRowCell_abyssPrivate({
        row,
        item,
        visibleCells,
        retained,
        field: name,
        parent: row.name,
        className: 'abyss-project-timeline-name-cell',
        selectable: true,
      });
    }
    const settings = this.context_abyssPrivate.settings();
    this.patchDescriptionPresentation_abyssPrivate(row, settings);
    this.patchMetadata_abyssPrivate({ row, item, visibleCells, retained, fields, settings });
    this.patchProgress_abyssPrivate({ row, item, visibleCells, retained, fields, settings });
    this.removeUnusedRowCells_abyssPrivate(row, retained);
    this.patchRange_abyssPrivate(row, item.range, window);
  }

  private renderRowCell_abyssPrivate(options: {
    readonly row: RenderedRow<TCell>;
    readonly item: ProjectTimelineRow;
    readonly visibleCells: TCell[];
    readonly retained: Set<string>;
    readonly field: ProjectFieldCatalogItem;
    readonly parent: HTMLElement;
    readonly className: string;
    readonly selectable: boolean;
    readonly column?: ProjectColumn;
  }): void {
    const { row, item, field, retained, visibleCells } = options;
    retained.add(field.id);
    const existing = row.cells.get(field.id);
    const host = existing?.element ?? options.parent.createDiv({ cls: options.className });
    const cell = this.context_abyssPrivate.renderCell({
      host,
      project: item.project,
      field,
      ...(options.column === undefined ? {} : { column: options.column }),
      occurrenceId: item.occurrenceId,
      groupKey: row.groupKey,
      ...(existing === undefined ? {} : { existing }),
    });
    if (cell.element !== host && cell.element.parentElement !== host) host.append(cell.element);
    row.cells.set(field.id, cell);
    const groupBody = row.element.closest('.abyss-project-timeline-group-body');
    if (options.selectable && groupBody !== null && !groupBody.hasAttribute('hidden')) {
      visibleCells.push(cell);
    }
  }

  private patchDescriptionPresentation_abyssPrivate(
    row: RenderedRow<TCell>,
    settings: ProjectTimelineSettings,
  ): void {
    const lines = projectTimelineDescriptionLines(settings);
    row.name.toggleClass('has-description', lines !== 0);
    row.name.toggleClass('is-full-description', lines === 'full');
    if (lines === 'full') row.name.style.removeProperty('--abyss-project-description-lines');
    else row.name.style.setProperty('--abyss-project-description-lines', String(lines));
  }

  private patchMetadata_abyssPrivate(options: {
    readonly row: RenderedRow<TCell>;
    readonly item: ProjectTimelineRow;
    readonly visibleCells: TCell[];
    readonly retained: Set<string>;
    readonly fields: readonly ProjectFieldCatalogItem[];
    readonly settings: ProjectTimelineSettings;
  }): void {
    const { row, item, visibleCells, retained, fields, settings } = options;
    row.metadata.hidden = !settings.showMetadata;
    const desiredMetadata: HTMLElement[] = [];
    for (const metadataItem of projectCardFields(
      item.project,
      settings,
      fields,
      projectTimelineFields(settings),
    )) {
      const existing = row.cells.get(metadataItem.field.id);
      const fieldRow =
        existing?.element.closest<HTMLElement>('.abyss-project-timeline-field') ??
        row.metadata.createDiv({ cls: 'abyss-project-timeline-field' });
      let label = fieldRow.querySelector<HTMLElement>('.abyss-project-timeline-field-label');
      label ??= fieldRow.createSpan({ cls: 'abyss-project-timeline-field-label' });
      label.setText(metadataItem.label);
      this.renderRowCell_abyssPrivate({
        row,
        item,
        visibleCells,
        retained,
        field: metadataItem.field,
        parent: fieldRow,
        className: 'abyss-project-timeline-field-value',
        selectable: settings.showMetadata,
        column: metadataItem.column,
      });
      desiredMetadata.push(fieldRow);
    }
    reconcileOrder(row.metadata, desiredMetadata);
  }

  private patchProgress_abyssPrivate(options: {
    readonly row: RenderedRow<TCell>;
    readonly item: ProjectTimelineRow;
    readonly visibleCells: TCell[];
    readonly retained: Set<string>;
    readonly fields: readonly ProjectFieldCatalogItem[];
    readonly settings: ProjectTimelineSettings;
  }): void {
    const { row, item, visibleCells, retained, fields, settings } = options;
    const progress = settings.progress;
    row.progress.hidden = progress === 'hidden';
    if (progress !== 'hidden') {
      const progressField = findProjectFieldById(fields, 'progress');
      if (progressField !== undefined) {
        this.renderRowCell_abyssPrivate({
          row,
          item,
          visibleCells,
          retained,
          field: progressField,
          parent: row.progress,
          className: 'abyss-project-timeline-progress-cell',
          selectable: true,
        });
      }
    }
  }

  private removeUnusedRowCells_abyssPrivate(
    row: RenderedRow<TCell>,
    retained: ReadonlySet<string>,
  ): void {
    for (const [fieldId, cell] of row.cells) {
      if (retained.has(fieldId)) continue;
      const fieldRow = cell.element.closest('.abyss-project-timeline-field');
      if (fieldRow === null) cell.element.remove();
      else fieldRow.remove();
      row.cells.delete(fieldId);
    }
  }

  private patchRange_abyssPrivate(
    row: RenderedRow<TCell>,
    range: ProjectTimelineRange,
    window: ProjectTimelineWindow,
  ): void {
    for (const marker of row.track.querySelectorAll(':scope > .abyss-project-timeline-today')) {
      marker.remove();
    }
    this.addTodayMarker_abyssPrivate(row.track, window);
    this.patchGrid_abyssPrivate(row.grid);
    this.patchRangeEditability_abyssPrivate(row);
    const geometry = projectTimelineBarGeometry(range, window);
    if (geometry === undefined) {
      row.bar.hidden = true;
      this.renderMissingRange_abyssPrivate(row, range, window);
      return;
    }
    this.patchVisibleRange_abyssPrivate(row, range, window, geometry);
  }

  private patchRangeEditability_abyssPrivate(row: RenderedRow<TCell>): void {
    const capture = this.context_abyssPrivate.captureRangeSource(
      row.element.dataset['occurrenceId'] ?? '',
    );
    const editReason = capture.kind === 'rejected' ? capture.reason : undefined;
    row.track.setAttribute('aria-disabled', String(editReason !== undefined));
    row.bar.setAttribute('aria-disabled', String(editReason !== undefined));
    row.rangeName.setText(
      `Timeline dates for ${row.project.name}: ${timelineRangeLabel(row.range)}`,
    );
    row.rangeDescription.setText(
      editReason ??
        `${timelineRangeInstructions(row.range)} Click to set a missing date or drag to draw a range.`,
    );
    row.track.removeAttribute('aria-label');
    row.bar.removeAttribute('aria-label');
    row.track.removeAttribute('title');
    row.bar.removeAttribute('title');
  }

  private patchVisibleRange_abyssPrivate(
    row: RenderedRow<TCell>,
    range: ProjectTimelineRange,
    window: ProjectTimelineWindow,
    geometry: ProjectTimelineBarGeometry,
  ): void {
    row.state.hidden = true;
    row.state.className = 'abyss-project-timeline-state';
    delete row.state.dataset['direction'];
    const bar = row.bar;
    bar.hidden = false;
    applyProjectTimelineBarGeometry(bar, range, geometry);
    const color = this.context_abyssPrivate.statusColor(row.project);
    if (color !== undefined) bar.style.setProperty('--abyss-project-status-color', color);
    else bar.style.removeProperty('--abyss-project-status-color');
    row.startHandle.hidden = !(
      range.kind === 'open-start' || endpointVisible(rangeEndpoint(range, 'start'), window)
    );
    row.endHandle.hidden = !(
      range.kind === 'open-end' || endpointVisible(rangeEndpoint(range, 'end'), window)
    );
  }

  private patchGrid_abyssPrivate(grid: HTMLElement): void {
    const boundaries = this.axisLayout_abyssPrivate.gridBoundaries;
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

  private renderMissingRange_abyssPrivate(
    row: RenderedRow<TCell>,
    range: ProjectTimelineRange,
    window: ProjectTimelineWindow,
  ): void {
    if (range.kind === 'unscheduled' || range.kind === 'malformed') {
      row.state.hidden = false;
      row.state.className = `abyss-project-timeline-state is-${range.kind}`;
      delete row.state.dataset['direction'];
      row.state.setText(range.kind === 'unscheduled' ? 'Unscheduled' : 'Invalid date range');
      return;
    }
    const anchor = rangeAnchor(range) as string;
    const direction = dayOrdinal(anchor) < dayOrdinal(window.startDay) ? 'before' : 'after';
    row.state.hidden = false;
    row.state.className = `abyss-project-timeline-state abyss-project-timeline-boundary-marker is-${direction}`;
    row.state.dataset['direction'] = direction;
    row.state.empty();
    row.state.createSpan({
      text: direction === 'before' ? '←' : '→',
      attr: { 'aria-hidden': 'true' },
    });
    row.state.createSpan({
      cls: 'abyss-sr-only',
      text: `Scheduled ${direction} visible range`,
    });
  }

  private selectRange_abyssPrivate(row: RenderedRow<TCell>, focus: HTMLElement): void {
    this.selectedPath_abyssPrivate = row.project.path;
    const cell = row.cells.get('name') ?? row.cells.values().next().value;
    if (cell !== undefined) this.context_abyssPrivate.selectCell(cell);
    focus.focus({ preventScroll: true });
    this.syncSelectedRows_abyssPrivate();
  }

  private handleRangeKeydown_abyssPrivate(
    row: RenderedRow<TCell>,
    event: KeyboardEvent,
    focus: HTMLElement,
  ): void {
    if (requestsRangeMenu(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.selectRange_abyssPrivate(row, focus);
      this.context_abyssPrivate.openRangeMenu(row.element.dataset['occurrenceId'] ?? '', event);
      return;
    }
    const deltaDays = rangeArrowDelta(event);
    if (deltaDays === undefined) return;
    const occurrenceId = row.element.dataset['occurrenceId'];
    if (occurrenceId === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectRange_abyssPrivate(row, focus);
    const captured = this.context_abyssPrivate.captureRangeSource(occurrenceId);
    if (captured.kind === 'rejected') {
      this.context_abyssPrivate.reportRangeFailure(captured.reason);
      return;
    }
    void this.context_abyssPrivate
      .commitRangeEdit({
        kind: 'keyboard',
        target: freezeProjectTimelineRangeBinding(captured.source),
        intent: event.shiftKey ? { type: 'adjustEnd', deltaDays } : { type: 'move', deltaDays },
      })
      .then(
        (result) => {
          if (result.failed.length > 0) this.context_abyssPrivate.reportRangeFailure(result);
        },
        (error: unknown) => {
          this.context_abyssPrivate.reportRangeFailure(error);
        },
      );
  }

  private focusedDescendant_abyssPrivate(): HTMLElement | undefined {
    const active = this.root.ownerDocument.activeElement;
    return active instanceof HTMLElement && this.root.contains(active) ? active : undefined;
  }

  private focusedRangeIdentity_abyssPrivate(
    focused: HTMLElement | undefined,
  ): TimelineFocusIdentity | undefined {
    if (focused === undefined) return undefined;
    const part = focused.dataset['timelinePart'];
    if (part !== 'bar' && part !== 'track') return undefined;
    const projectPath = focused.closest<HTMLElement>('[data-project-path]')?.dataset['projectPath'];
    return projectPath === undefined ? undefined : { projectPath, part };
  }

  private findRow_abyssPrivate(path: string): RenderedRow<TCell> | undefined {
    return this.findLocatedRow_abyssPrivate(path)?.row;
  }

  private findRowByOccurrence_abyssPrivate(occurrenceId: string): RenderedRow<TCell> | undefined {
    for (const group of this.groups_abyssPrivate.values()) {
      const row = group.rows.get(occurrenceId);
      if (row !== undefined) return row;
    }
    return undefined;
  }

  private findLocatedRow_abyssPrivate(
    path: string,
  ): { readonly groupKey: string; readonly row: RenderedRow<TCell> } | undefined {
    for (const group of this.groups_abyssPrivate.values()) {
      const row = Array.from(group.rows.values()).find(({ project }) => project.path === path);
      if (row !== undefined) return { groupKey: row.groupKey, row };
    }
    return undefined;
  }

  private toggleGroup_abyssPrivate(key: string): void {
    this.context_abyssPrivate
      .requestViewChange(() => {
        if (this.collapsedGroups_abyssPrivate.has(key)) {
          this.collapsedGroups_abyssPrivate.delete(key);
        } else {
          this.collapsedGroups_abyssPrivate.add(key);
        }
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] Could not change project Timeline view', error);
      });
  }

  private syncSelectedRows_abyssPrivate(): void {
    for (const group of this.groups_abyssPrivate.values()) {
      for (const row of group.rows.values()) {
        row.element.toggleClass('is-selected', row.project.path === this.selectedPath_abyssPrivate);
      }
    }
  }
}
