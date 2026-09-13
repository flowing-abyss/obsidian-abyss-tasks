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
  buildProjectTimelineModel,
  projectTimelineBarGeometry,
  projectTimelineWindow,
  projectTimelineWindowForRange,
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
  readonly openScaleOptions: (anchor: HTMLElement) => void;
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
  readonly bar: HTMLElement;
  readonly startHandle: HTMLElement;
  readonly endHandle: HTMLElement;
  readonly state: HTMLElement;
  readonly showRange: HTMLButtonElement;
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
    return `No start date, ends ${range.endDay}. Arrow keys move; Shift plus Arrow adjusts End.`;
  }
  if (range.kind === 'open-end') {
    return `Starts ${range.startDay}, no end date. Arrow keys move; Shift plus Arrow sets End.`;
  }
  if (range.kind === 'closed') {
    return `${range.startDay} through ${range.endDay}. Arrow keys move; Shift plus Arrow adjusts End.`;
  }
  return 'Timeline date range';
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

function calendarWindowYears(scale: ProjectTimelineSettings['scale']): number {
  if (scale === 'month') return 1;
  if (scale === 'quarter') return 3;
  return 5;
}

function reconcileOrder(parent: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor = parent.firstChild;
  for (const element of desired) {
    if (element === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(element, cursor);
  }
}

export class ProjectsTimelineView<TCell extends ProjectTimelineCellContext> {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  private readonly axis_abyssPrivate: HTMLElement;
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
  private readonly scaleButton_abyssPrivate: HTMLButtonElement;
  private readonly interaction_abyssPrivate: ProjectTimelinePointerInteraction;

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsTimelineViewContext<TCell>,
  ) {
    this.anchor_abyssPrivate = new Date((context_abyssPrivate.now ?? (() => new Date()))());
    this.renderedScale_abyssPrivate = context_abyssPrivate.settings().scale;
    this.root = host.createDiv({ cls: 'abyss-project-timeline', attr: { tabindex: '-1' } });
    const navigation = this.root.createDiv({ cls: 'abyss-project-timeline-navigation' });
    this.addNavigationButton_abyssPrivate(navigation, 'Previous range', 'chevron-left', () => {
      this.moveAnchor_abyssPrivate(-1);
    });
    this.addTextButton_abyssPrivate(navigation, 'Today', () => {
      const today = new Date((this.context_abyssPrivate.now ?? (() => new Date()))());
      this.anchor_abyssPrivate = today;
      this.fittedWindow_abyssPrivate = undefined;
      this.scaleContextOrdinal_abyssPrivate = dayOrdinal(localDay(today));
      this.render_abyssPrivate(true);
    });
    this.addNavigationButton_abyssPrivate(navigation, 'Next range', 'chevron-right', () => {
      this.moveAnchor_abyssPrivate(1);
    });
    const scaleControl = navigation.createDiv({ cls: 'abyss-project-timeline-scale-control' });
    this.scaleButton_abyssPrivate = this.addTextButton_abyssPrivate(
      scaleControl,
      this.scaleLabel_abyssPrivate(this.renderedScale_abyssPrivate),
      () => {
        this.context_abyssPrivate.openScaleOptions(this.scaleButton_abyssPrivate);
      },
    );
    this.scaleButton_abyssPrivate.addClass('abyss-project-timeline-scale');
    this.addTextButton_abyssPrivate(navigation, 'Fit', () => {
      this.fit_abyssPrivate();
    });
    this.scroll = this.root.createDiv({
      cls: 'abyss-project-timeline-scroll',
      attr: { tabindex: '0', 'aria-label': 'Project Timeline' },
    });
    this.axis_abyssPrivate = this.scroll.createDiv({ cls: 'abyss-project-timeline-axis' });
    this.groupsHost_abyssPrivate = this.scroll.createDiv({ cls: 'abyss-project-timeline-groups' });
    this.scroll.addEventListener('scroll', this.syncRangeStateOffset_abyssPrivate);
    this.syncRangeStateOffset_abyssPrivate();
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
    this.scroll.removeEventListener('scroll', this.syncRangeStateOffset_abyssPrivate);
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
    const context = this.visibleContextOrdinal_abyssPrivate(this.currentWindow_abyssPrivate());
    this.anchor_abyssPrivate = dayDate(dayFromOrdinal(context));
    this.fittedWindow_abyssPrivate = undefined;
    this.preparedScaleChange_abyssPrivate = true;
    this.scaleContextOrdinal_abyssPrivate = context;
  }

  canRevealProjectRange(path: string): boolean {
    const row = this.findRow_abyssPrivate(path);
    return (
      row !== undefined &&
      rangeAnchor(row.range) !== undefined &&
      projectTimelineBarGeometry(row.range, this.currentWindow_abyssPrivate()) === undefined
    );
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
      cls: 'clickable-icon',
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

  private scaleLabel_abyssPrivate(scale: ProjectTimelineSettings['scale']): string {
    return { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }[scale];
  }

  private syncScaleButton_abyssPrivate(): void {
    const label = this.scaleLabel_abyssPrivate(this.context_abyssPrivate.settings().scale);
    this.scaleButton_abyssPrivate.setText(label);
    this.scaleButton_abyssPrivate.setAttribute('aria-label', `Timeline scale: ${label}`);
  }

  private handleScaleTransition_abyssPrivate(): void {
    const scale = this.context_abyssPrivate.settings().scale;
    if (this.preparedScaleChange_abyssPrivate) {
      this.preparedScaleChange_abyssPrivate = false;
      this.renderedScale_abyssPrivate = scale;
      return;
    }
    if (scale === this.renderedScale_abyssPrivate) return;
    const window =
      this.fittedWindow_abyssPrivate ??
      projectTimelineWindow(this.anchor_abyssPrivate, this.renderedScale_abyssPrivate);
    const center = dayOrdinal(window.startDay) + Math.floor((window.dayCount - 1) / 2);
    this.anchor_abyssPrivate = dayDate(dayFromOrdinal(center));
    this.fittedWindow_abyssPrivate = undefined;
    this.renderedScale_abyssPrivate = scale;
  }

  private visibleContextOrdinal_abyssPrivate(window: ProjectTimelineWindow): number {
    const geometry = this.axisGeometry_abyssPrivate();
    if (geometry === undefined) {
      return dayOrdinal(window.startDay) + Math.floor((window.dayCount - 1) / 2);
    }
    const { summaryWidth, trackStart, trackWidth, viewportWidth } = geometry;
    const trackEnd = trackStart + trackWidth;
    const visibleStart = Math.max(trackStart, this.scroll.scrollLeft + summaryWidth);
    const visibleEnd = Math.min(trackEnd, this.scroll.scrollLeft + viewportWidth);
    const viewportCenter = this.scroll.scrollLeft + (summaryWidth + viewportWidth) / 2;
    const center =
      visibleStart <= visibleEnd
        ? (visibleStart + visibleEnd) / 2
        : clamp(viewportCenter, trackStart, trackEnd);
    const fraction = clamp((center - trackStart) / trackWidth, 0, 1);
    return dayOrdinal(window.startDay) + Math.round((window.dayCount - 1) * fraction);
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
      const context = this.visibleContextOrdinal_abyssPrivate(this.fittedWindow_abyssPrivate);
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

  private fit_abyssPrivate(): void {
    const bounds = (this.model_abyssPrivate?.groups ?? []).flatMap(({ rows }) =>
      rows.flatMap(({ range }) => rangeBounds(range)),
    );
    if (bounds.length === 0) return;
    bounds.sort((left, right) => dayOrdinal(left) - dayOrdinal(right));
    this.fittedWindow_abyssPrivate = projectTimelineWindowForRange(
      bounds[0] as string,
      bounds[bounds.length - 1] as string,
      this.context_abyssPrivate.settings().scale,
    );
    this.render_abyssPrivate(true);
  }

  private currentWindow_abyssPrivate(): ProjectTimelineWindow {
    return (
      this.fittedWindow_abyssPrivate ??
      projectTimelineWindow(this.anchor_abyssPrivate, this.context_abyssPrivate.settings().scale)
    );
  }

  private render_abyssPrivate(navigation: boolean): void {
    this.syncScaleButton_abyssPrivate();
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
    const window = this.currentWindow_abyssPrivate();
    this.renderAxis_abyssPrivate(window);
    this.reconcileGroups_abyssPrivate(model.groups, window);
    this.interaction_abyssPrivate.reconcileAfterRender();
    this.syncSelectedRows_abyssPrivate();
    this.restoreScroll_abyssPrivate(navigation, window, left, top);
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

  private readonly syncRangeStateOffset_abyssPrivate = (): void => {
    this.root.style.setProperty(
      '--abyss-project-timeline-range-state-left',
      `${this.scroll.scrollLeft + 10}px`,
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

  private renderAxis_abyssPrivate(window: ProjectTimelineWindow): void {
    this.axis_abyssPrivate.empty();
    const summary = this.axis_abyssPrivate.createDiv({
      cls: 'abyss-project-timeline-axis-summary',
    });
    summary.setText(`${window.startDay} – ${window.endDay}`);
    const dates = this.axis_abyssPrivate.createDiv({ cls: 'abyss-project-timeline-axis-dates' });
    for (const tick of window.ticks) {
      const element = dates.createSpan({
        cls: 'abyss-project-timeline-tick',
        text: tick.label,
      });
      element.style.left = `${((dayOrdinal(tick.day) - dayOrdinal(window.startDay)) / window.dayCount) * 100}%`;
    }
    this.addTodayMarker_abyssPrivate(dates, window);
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

  private createRow_abyssPrivate(
    group: RenderedGroup<TCell>,
    item: ProjectTimelineRow,
    groupKey: string,
  ): RenderedRow<TCell> {
    const element = group.body.createDiv({ cls: 'abyss-project-timeline-row' });
    const summary = element.createDiv({ cls: 'abyss-project-timeline-summary' });
    const track = element.createDiv({
      cls: 'abyss-project-timeline-track',
      attr: { tabindex: '0', role: 'button', 'data-timeline-part': 'track' },
    });
    const bar = track.createDiv({
      cls: 'abyss-project-timeline-bar',
      attr: {
        tabindex: '0',
        role: 'button',
        'data-timeline-part': 'bar',
        'aria-keyshortcuts': 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight',
      },
    });
    const row: RenderedRow<TCell> = {
      element,
      summary,
      name: summary.createDiv({ cls: 'abyss-project-timeline-name' }),
      metadata: summary.createDiv({ cls: 'abyss-project-timeline-metadata' }),
      progress: summary.createDiv({ cls: 'abyss-project-timeline-progress' }),
      track,
      bar,
      startHandle: bar.createSpan({
        cls: 'abyss-project-timeline-handle is-start',
        attr: { 'data-timeline-part': 'start', 'aria-hidden': 'true' },
      }),
      endHandle: bar.createSpan({
        cls: 'abyss-project-timeline-handle is-end',
        attr: { 'data-timeline-part': 'end', 'aria-hidden': 'true' },
      }),
      state: track.createSpan({ cls: 'abyss-project-timeline-state' }),
      showRange: track.createEl('button', {
        cls: 'abyss-project-timeline-show-range',
        text: 'Show range',
        attr: { type: 'button' },
      }),
      cells: new Map(),
      project: item.project,
      range: item.range,
      groupKey,
    };
    bar.addEventListener('keydown', (event) => {
      this.handleRangeKeydown_abyssPrivate(row, event);
    });
    bar.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.selectRange_abyssPrivate(row, bar);
      this.context_abyssPrivate.openRangeMenu(row.element.dataset['occurrenceId'] ?? '', event);
    });
    row.showRange.addEventListener('click', () => {
      this.context_abyssPrivate.requestNavigation(() => {
        this.revealProject(row.project.path);
      });
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
    this.patchRangeEditability_abyssPrivate(row);
    const geometry = projectTimelineBarGeometry(range, window);
    if (geometry === undefined) {
      row.bar.hidden = true;
      this.renderMissingRange_abyssPrivate(row, range);
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
    row.track.setAttribute(
      'aria-label',
      editReason === undefined
        ? `Timeline dates for ${row.project.name}. Click to set a missing date or drag to draw a range.`
        : `Timeline dates for ${row.project.name}. ${editReason}`,
    );
    if (editReason === undefined) {
      row.track.removeAttribute('title');
      row.bar.removeAttribute('title');
    } else {
      row.track.setAttribute('title', editReason);
      row.bar.setAttribute('title', editReason);
    }
  }

  private patchVisibleRange_abyssPrivate(
    row: RenderedRow<TCell>,
    range: ProjectTimelineRange,
    window: ProjectTimelineWindow,
    geometry: ProjectTimelineBarGeometry,
  ): void {
    row.state.hidden = true;
    row.showRange.hidden = true;
    const bar = row.bar;
    bar.hidden = false;
    bar.className = `abyss-project-timeline-bar is-${range.kind}`;
    bar.style.left = `${geometry.leftPercent}%`;
    bar.style.width = `${geometry.widthPercent}%`;
    const color = this.context_abyssPrivate.statusColor(row.project);
    if (color !== undefined) bar.style.setProperty('--abyss-project-status-color', color);
    else bar.style.removeProperty('--abyss-project-status-color');
    bar.setAttribute('aria-label', timelineRangeLabel(range));
    row.startHandle.hidden = !endpointVisible(rangeEndpoint(range, 'start'), window);
    row.endHandle.hidden = !endpointVisible(rangeEndpoint(range, 'end'), window);
  }

  private renderMissingRange_abyssPrivate(
    row: RenderedRow<TCell>,
    range: ProjectTimelineRange,
  ): void {
    if (range.kind === 'unscheduled' || range.kind === 'malformed') {
      row.state.hidden = false;
      row.state.className = `abyss-project-timeline-state is-${range.kind}`;
      row.state.setText(range.kind === 'unscheduled' ? 'Unscheduled' : 'Invalid date range');
      row.showRange.hidden = true;
      return;
    }
    row.state.hidden = true;
    row.showRange.hidden = false;
    row.showRange.setAttribute('aria-label', `Show date range for ${row.project.name}`);
  }

  private selectRange_abyssPrivate(row: RenderedRow<TCell>, focus: HTMLElement): void {
    this.selectedPath_abyssPrivate = row.project.path;
    const cell = row.cells.get('name') ?? row.cells.values().next().value;
    if (cell !== undefined) this.context_abyssPrivate.selectCell(cell);
    focus.focus({ preventScroll: true });
    this.syncSelectedRows_abyssPrivate();
  }

  private handleRangeKeydown_abyssPrivate(row: RenderedRow<TCell>, event: KeyboardEvent): void {
    if (requestsRangeMenu(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.selectRange_abyssPrivate(row, row.bar);
      this.context_abyssPrivate.openRangeMenu(row.element.dataset['occurrenceId'] ?? '', event);
      return;
    }
    const deltaDays = rangeArrowDelta(event);
    if (deltaDays === undefined) return;
    const occurrenceId = row.element.dataset['occurrenceId'];
    if (occurrenceId === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectRange_abyssPrivate(row, row.bar);
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
