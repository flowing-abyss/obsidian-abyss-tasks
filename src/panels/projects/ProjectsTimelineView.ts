import { setIcon, type Component } from 'obsidian';
import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import {
  findProjectFieldById,
  type ProjectColumn,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import {
  projectGroupCollapseKey,
  setProjectGroupCollapsed,
} from '../../projects/projectGroupCollapse';
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
  NO_PROJECT_OVERVIEW_CELLS,
  projectTimelineCells,
  type ProjectOverviewCells,
  type ProjectOverviewFieldResolver,
} from './projectOverviewCells';
import {
  scrollIntoUsableViewport,
  type ProjectOverviewEditorFrame,
  type ProjectOverviewRenderHooks,
  type ProjectsOverviewSurface,
} from './ProjectsOverviewSurface';
import type { ProjectTableSelectableCell } from './projectTableSelection';
import {
  applyProjectTimelineBarGeometry,
  freezeProjectTimelineRangeBinding,
  ProjectTimelinePointerInteraction,
  type ProjectTimelineRangeCommitter,
} from './projectTimelineInteraction';
import { timelineViewportRows, type TimelineViewportRow } from './projectTimelineRowModel';
import { ProjectTimelineRows, type TimelineRowMount } from './projectTimelineRows';

let timelineSurfaceAccessibilitySequence = 0;

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
  /** The original saved view, independently of effective schema fallbacks. */
  readonly savedSettings: () => ProjectTimelineSettings;
  readonly modelInput: () => Omit<ProjectTimelineModelInput, 'projects' | 'settings' | 'search'>;
  /** The field each cell edits, which an owned clear may retype; `cells()` lists it. */
  readonly effectiveField: ProjectOverviewFieldResolver;
  readonly renderCell: (options: {
    readonly host: HTMLElement;
    readonly markdown: Component;
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
    markdown: Component,
  ) => void;
  readonly statusColor: (project: Project) => string | undefined;
  readonly openRangeMenu: (occurrenceId: string, event: MouseEvent | KeyboardEvent) => void;
  readonly finishEditor: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly reportRenderFailure: (error: unknown) => void;
  readonly windowRendered?: () => void;
  readonly copy?: (event: ClipboardEvent) => void;
  readonly paste?: (event: ClipboardEvent) => void;
}

interface RenderedRow<TCell extends ProjectTimelineCellContext> {
  readonly markdown: Component;
  readonly cleanup: Array<() => void>;
  visibleCells: TCell[];
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

function fallbackAxisDayCount(scale: ProjectTimelineSettings['scale']): number {
  if (scale === 'day') return 31;
  if (scale === 'week') return 140;
  if (scale === 'month') return 732;
  return 2_922;
}

function reconcileOrder(parent: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor = parent.firstChild;
  for (const element of desired) {
    if (element === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(element, cursor);
  }
}

let timelineRangeAccessibilitySequence = 0;

export class ProjectsTimelineView<
  TCell extends ProjectTimelineCellContext,
> implements ProjectsOverviewSurface<TCell> {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  private readonly axis_abyssPrivate: HTMLElement;
  private readonly axisSummary_abyssPrivate: HTMLElement;
  private readonly axisRange_abyssPrivate: HTMLElement;
  private readonly axisDates_abyssPrivate: HTMLElement;
  private readonly axisHierarchy_abyssPrivate: HTMLElement;
  private readonly axisCells_abyssPrivate: HTMLElement;
  private readonly groupsHost_abyssPrivate: HTMLElement;
  private readonly rows_abyssPrivate = new Map<string, RenderedRow<TCell>>();
  private readonly rowMounts_abyssPrivate: ProjectTimelineRows;
  private readonly gestureReleases_abyssPrivate = new Map<string, () => void>();
  private editorRelease_abyssPrivate: (() => void) | undefined;
  private rendering_abyssPrivate = false;
  private layoutSignature_abyssPrivate = '';
  private readonly rowOrder_abyssPrivate = new Map<string, number>();
  private readonly modelRows_abyssPrivate = new Map<string, ProjectTimelineRow>();
  private readonly rowGroups_abyssPrivate = new Map<string, string>();
  private readonly modelGroups_abyssPrivate = new Map<string, ProjectTimelineGroup>();
  private visibleCells_abyssPrivate: TCell[] = [];
  private cells_abyssPrivate: ProjectOverviewCells = NO_PROJECT_OVERVIEW_CELLS;
  private projects_abyssPrivate: readonly Project[] = [];
  private search_abyssPrivate = '';
  private model_abyssPrivate: ProjectTimelineModel | undefined;
  private anchor_abyssPrivate: Date;
  private renderedScale_abyssPrivate: ProjectTimelineSettings['scale'];
  private preparedScaleChange_abyssPrivate = false;
  private scaleContextOrdinal_abyssPrivate: number | undefined;
  private fittedWindow_abyssPrivate: ProjectTimelineWindow | undefined;
  private selectedPath_abyssPrivate: string | undefined;
  private editingMarks_abyssPrivate: HTMLElement[] = [];
  private hiddenScrollPosition_abyssPrivate: TimelineScrollPosition | undefined;
  private readonly scaleButtons_abyssPrivate = new Map<
    ProjectTimelineSettings['scale'],
    HTMLButtonElement
  >();
  private readonly interaction_abyssPrivate: ProjectTimelinePointerInteraction;
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
    const surfaceName = this.root.createSpan({
      cls: 'abyss-sr-only',
      text: 'Project Timeline',
    });
    surfaceName.id = `abyss-project-timeline-surface-${String(++timelineSurfaceAccessibilitySequence)}`;
    this.scroll = this.root.createDiv({
      cls: 'abyss-project-timeline-scroll',
      attr: { tabindex: '0', 'aria-labelledby': surfaceName.id },
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
    this.syncRangeStateOffset_abyssPrivate();
    this.scroll.addEventListener('scroll', this.syncRangeStateOffset_abyssPrivate, {
      passive: true,
    });
    if (context_abyssPrivate.copy !== undefined)
      this.root.addEventListener('copy', context_abyssPrivate.copy);
    if (context_abyssPrivate.paste !== undefined)
      this.root.addEventListener('paste', context_abyssPrivate.paste);
    this.rowMounts_abyssPrivate = this.createRowMounts_abyssPrivate();
    this.interaction_abyssPrivate = new ProjectTimelinePointerInteraction({
      root: this.root,
      scroll: this.scroll,
      window: () => this.currentWindow_abyssPrivate(),
      captureRangeSource: context_abyssPrivate.captureRangeSource,
      commitRangeEdit: context_abyssPrivate.commitRangeEdit,
      reportRangeFailure: context_abyssPrivate.reportRangeFailure,
      finishEditor: context_abyssPrivate.finishEditor,
      pinsChanged: () => {
        this.syncGesturePins_abyssPrivate();
      },
      selectRange: (occurrenceId, focus) => {
        const row = this.findRowByOccurrence_abyssPrivate(occurrenceId);
        if (row !== undefined) this.selectRange_abyssPrivate(row, focus);
      },
    });
  }

  private createRowMounts_abyssPrivate(): ProjectTimelineRows {
    return new ProjectTimelineRows({
      host: this.groupsHost_abyssPrivate,
      scroll: this.scroll,
      mount: (host, row, markdown) => this.mountRow_abyssPrivate(host, row, markdown),
      beforeWindow: () => {
        if (!this.root.isConnected || this.root.hidden === true || this.scroll.clientHeight <= 0) {
          this.interaction_abyssPrivate.cancelActive();
          return;
        }
        this.syncRangeStateOffset_abyssPrivate();
        this.syncTrackWidth_abyssPrivate(this.currentWindow_abyssPrivate());
        this.patchVisibleCalendar_abyssPrivate(this.currentWindow_abyssPrivate());
        this.refreshLayout_abyssPrivate();
      },
      mountedChanged: () => {
        this.visibleCells_abyssPrivate = [...this.rows_abyssPrivate.values()]
          .sort(
            (a, b) =>
              (this.rowOrder_abyssPrivate.get(a.element.dataset['occurrenceId'] ?? '') ?? 0) -
              (this.rowOrder_abyssPrivate.get(b.element.dataset['occurrenceId'] ?? '') ?? 0),
          )
          .flatMap((row) => row.visibleCells);
        this.syncSelectedRows_abyssPrivate();
        if (!this.rendering_abyssPrivate) this.context_abyssPrivate.windowRendered?.();
      },
      reportFailure: this.context_abyssPrivate.reportRenderFailure,
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
    this.renderProjects_abyssPrivate(projects, search);
  }

  show(): void {
    this.root.hidden = false;
    this.rowMounts_abyssPrivate.setActive(true);
  }

  hide(): void {
    this.interaction_abyssPrivate.cancelActive();
    this.rowMounts_abyssPrivate.setActive(false);
    this.root.hidden = true;
  }

  render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void {
    hooks.publish(this.renderProjects_abyssPrivate(projects, search));
    hooks.settleSelection();
  }

  destroy(): void {
    this.rendering_abyssPrivate = true;
    this.interaction_abyssPrivate.destroy();
    this.scroll.removeEventListener('scroll', this.syncRangeStateOffset_abyssPrivate);
    if (this.context_abyssPrivate.copy !== undefined)
      this.root.removeEventListener('copy', this.context_abyssPrivate.copy);
    if (this.context_abyssPrivate.paste !== undefined)
      this.root.removeEventListener('paste', this.context_abyssPrivate.paste);
    this.editorRelease_abyssPrivate?.();
    this.rowMounts_abyssPrivate.destroy();
    this.rows_abyssPrivate.clear();
    this.visibleCells_abyssPrivate = [];
    this.cells_abyssPrivate = NO_PROJECT_OVERVIEW_CELLS;
    this.editingMarks_abyssPrivate = [];
    this.root.remove();
  }

  cells(): ProjectOverviewCells {
    return this.cells_abyssPrivate;
  }

  renderedCells(): readonly TCell[] {
    return this.visibleCells_abyssPrivate;
  }

  revealCell(identity: ProjectTableSelectableCell): void {
    this.rowMounts_abyssPrivate.reveal(identity.occurrenceId);
  }

  scrollCellIntoView(cell: TCell): void {
    scrollIntoUsableViewport(cell.element, {
      horizontal: this.scroll,
      vertical: this.scroll,
      header: this.axis_abyssPrivate,
    });
  }

  editorFrame(): ProjectOverviewEditorFrame {
    return { boundary: this.scroll, stickyHeader: this.axis_abyssPrivate };
  }

  occurrenceElement(cell: TCell): HTMLElement {
    return cell.element.closest<HTMLElement>('.abyss-project-timeline-row') ?? cell.element;
  }

  visibleRow(occurrenceId: string): ProjectTimelineRow | undefined {
    const groupKey = this.rowGroups_abyssPrivate.get(occurrenceId);
    if (groupKey === undefined || this.isGroupCollapsed_abyssPrivate(groupKey)) return undefined;
    return this.modelRows_abyssPrivate.get(occurrenceId);
  }

  syncSelectedProjectPath(path: string | undefined): void {
    this.selectedPath_abyssPrivate = path;
    this.syncSelectedRows_abyssPrivate();
  }

  /**
   * Raises the row and the summary that hold an edited cell above their neighbours, so its editor
   * can overlap them, and lowers the ones raised for the previous cell. A cell outside this
   * timeline raises nothing.
   */
  setEditingCell(cell: HTMLElement | undefined): void {
    for (const element of this.editingMarks_abyssPrivate) element.removeClass('is-cell-editing');
    this.editingMarks_abyssPrivate = [];
    const previous = this.editorRelease_abyssPrivate;
    this.editorRelease_abyssPrivate = undefined;
    const key = cell?.closest<HTMLElement>('.abyss-project-timeline-row')?.dataset['occurrenceId'];
    if (key !== undefined) this.editorRelease_abyssPrivate = this.rowMounts_abyssPrivate.pin(key);
    previous?.();
    if (cell === undefined || !this.root.contains(cell)) return;
    for (const holder of ['.abyss-project-timeline-row', '.abyss-project-timeline-summary']) {
      const element = cell.closest<HTMLElement>(holder);
      if (element === null) continue;
      element.addClass('is-cell-editing');
      this.editingMarks_abyssPrivate.push(element);
    }
  }

  captureViewportBeforeHide(): void {
    this.interaction_abyssPrivate.cancelActive();
    this.rowMounts_abyssPrivate.setActive(false);
    this.hiddenScrollPosition_abyssPrivate = {
      left: this.scroll.scrollLeft,
      top: this.scroll.scrollTop,
    };
  }

  prepareScaleChange(): void {
    this.preparedScaleChange_abyssPrivate = true;
  }

  revealProject(path: string): void {
    const located = this.findLocatedRow_abyssPrivate(path);
    if (located !== undefined && this.isGroupCollapsed_abyssPrivate(located.groupKey)) {
      this.changeGroupCollapsed_abyssPrivate(located.groupKey, false);
    }
    const row = located?.row;
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
    this.rowMounts_abyssPrivate.reveal(row.occurrenceId);
    if (revealedOrdinal !== undefined) {
      this.scroll.scrollLeft = this.scaleScrollLeft_abyssPrivate(
        this.currentWindow_abyssPrivate(),
        revealedOrdinal,
        this.scroll.scrollLeft,
      );
    }
  }

  private renderProjects_abyssPrivate(
    projects: readonly Project[],
    search: string,
  ): ProjectTimelineModel {
    this.projects_abyssPrivate = projects;
    this.search_abyssPrivate = search;
    this.handleScaleTransition_abyssPrivate();
    return this.render_abyssPrivate(false);
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
    if (scale === 'year') {
      this.moveYearAnchor_abyssPrivate(direction);
      return;
    }
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
      const years = scale === 'month' ? 1 : 3;
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

  private moveYearAnchor_abyssPrivate(direction: -1 | 1): void {
    const window = this.currentWindow_abyssPrivate();
    const anchor = dayDate(direction === 1 ? window.endDay : window.startDay);
    anchor.setFullYear(anchor.getFullYear() + (direction === 1 ? 2 : -3), 0, 1);
    this.anchor_abyssPrivate = anchor;
    this.fittedWindow_abyssPrivate = undefined;
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

  private render_abyssPrivate(navigation: boolean): ProjectTimelineModel {
    this.syncScaleButtons_abyssPrivate();
    const focused = this.focusedDescendant_abyssPrivate();
    const focusedRange = this.focusedRangeIdentity_abyssPrivate(focused);
    const hiddenPosition = this.scroll.isConnected
      ? this.hiddenScrollPosition_abyssPrivate
      : undefined;
    const left = hiddenPosition?.left ?? this.scroll.scrollLeft;
    if (hiddenPosition !== undefined) this.scroll.scrollTop = hiddenPosition.top;
    if (hiddenPosition !== undefined) this.hiddenScrollPosition_abyssPrivate = undefined;
    const input = this.context_abyssPrivate.modelInput();
    const model = buildProjectTimelineModel({
      ...input,
      projects: this.projects_abyssPrivate,
      settings: this.context_abyssPrivate.settings(),
      search: this.search_abyssPrivate,
    });
    this.model_abyssPrivate = model;
    this.rendering_abyssPrivate = true;
    this.indexModel_abyssPrivate(model);
    this.cells_abyssPrivate = projectTimelineCells({
      model,
      settings: this.context_abyssPrivate.settings(),
      fields: input.fields,
      collapsedGroups: new Set(
        model.groups
          .filter(({ key }) => this.isGroupCollapsed_abyssPrivate(key))
          .map(({ key }) => key),
      ),
      effectiveField: this.context_abyssPrivate.effectiveField,
    });
    this.fitScale_abyssPrivate(model);
    const window = this.currentWindow_abyssPrivate();
    this.syncTrackWidth_abyssPrivate(window);
    this.patchAxis_abyssPrivate(window);
    this.reconcileGroups_abyssPrivate(model.groups, window);
    this.interaction_abyssPrivate.reconcileAfterRender();
    this.syncSelectedRows_abyssPrivate();
    this.restoreScroll_abyssPrivate(navigation, window, left);
    this.patchVisibleCalendar_abyssPrivate(window);
    this.restoreFocus_abyssPrivate(focused, focusedRange);
    this.rendering_abyssPrivate = false;
    return model;
  }

  private fitScale_abyssPrivate(model: ProjectTimelineModel): void {
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
  }

  private indexModel_abyssPrivate(model: ProjectTimelineModel): void {
    const protectedKeys = [...this.gestureReleases_abyssPrivate.keys()];
    const focusKey = this.root.ownerDocument.activeElement?.closest<HTMLElement>(
      '.abyss-project-timeline-row',
    )?.dataset['occurrenceId'];
    if (focusKey !== undefined && !protectedKeys.includes(focusKey)) protectedKeys.push(focusKey);
    protectedKeys.sort(
      (left, right) =>
        (this.rowOrder_abyssPrivate.get(left) ?? 0) - (this.rowOrder_abyssPrivate.get(right) ?? 0),
    );
    this.modelRows_abyssPrivate.clear();
    this.rowGroups_abyssPrivate.clear();
    this.modelGroups_abyssPrivate.clear();
    this.rowOrder_abyssPrivate.clear();
    for (const group of model.groups) {
      this.modelGroups_abyssPrivate.set(group.key, group);
      for (const row of group.rows) {
        this.modelRows_abyssPrivate.set(row.occurrenceId, row);
        this.rowGroups_abyssPrivate.set(row.occurrenceId, group.key);
        this.rowOrder_abyssPrivate.set(row.occurrenceId, this.rowOrder_abyssPrivate.size);
      }
    }
    if (
      protectedKeys.some(
        (key, index) =>
          index > 0 &&
          (this.rowOrder_abyssPrivate.get(key) ?? Infinity) <
            (this.rowOrder_abyssPrivate.get(protectedKeys[index - 1] ?? '') ?? 0),
      )
    )
      this.interaction_abyssPrivate.cancelActive();
    if (
      this.interaction_abyssPrivate
        .pinnedOccurrences()
        .some((key) => this.visibleRow(key) === undefined)
    )
      this.interaction_abyssPrivate.cancelActive();
    this.interaction_abyssPrivate.reconcileAfterRender();
  }

  private restoreScroll_abyssPrivate(
    navigation: boolean,
    window: ProjectTimelineWindow,
    left: number,
  ): void {
    if (this.scaleContextOrdinal_abyssPrivate !== undefined) {
      this.scroll.scrollLeft = this.scaleScrollLeft_abyssPrivate(
        window,
        this.scaleContextOrdinal_abyssPrivate,
        left,
      );

      this.scaleContextOrdinal_abyssPrivate = undefined;
    } else if (!navigation && this.scroll.scrollLeft !== left) {
      this.scroll.scrollLeft = left;
    }
    this.syncRangeStateOffset_abyssPrivate();
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
      replacement = focusedRange.part === 'bar' && row.bar.hidden === false ? row.bar : row.track;
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
    for (const row of this.rows_abyssPrivate.values()) this.patchGrid_abyssPrivate(row.grid);
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

  private layoutSignatureForRows_abyssPrivate(): string {
    const style = this.root.ownerDocument.defaultView?.getComputedStyle(this.root);
    return JSON.stringify([
      this.scroll.clientWidth,
      style?.fontFamily,
      style?.fontSize,
      style?.lineHeight,
    ]);
  }

  private refreshLayout_abyssPrivate(): void {
    if (
      this.layoutSignatureForRows_abyssPrivate() === this.layoutSignature_abyssPrivate ||
      this.model_abyssPrivate === undefined
    )
      return;
    this.reconcileGroups_abyssPrivate(
      this.model_abyssPrivate.groups,
      this.currentWindow_abyssPrivate(),
    );
  }

  private reconcileGroups_abyssPrivate(
    groups: readonly ProjectTimelineGroup[],
    _window: ProjectTimelineWindow,
  ): void {
    const settings = this.context_abyssPrivate.settings();
    this.layoutSignature_abyssPrivate = this.layoutSignatureForRows_abyssPrivate();
    const revision = JSON.stringify([
      settings,
      this.layoutSignature_abyssPrivate,
      this.context_abyssPrivate.modelInput().fields,
    ]);
    const rows = timelineViewportRows(
      groups.map((group) => ({
        key: group.key,
        collapsed: this.isGroupCollapsed_abyssPrivate(group.key),
        rows: group.rows.map((row) => ({
          occurrenceId: row.occurrenceId,
          revision: JSON.stringify(row.project),
          estimatedHeight: 100,
        })),
      })),
      revision,
      settings.groupBy === 'none' ? 0 : 36,
    );
    this.rowMounts_abyssPrivate.update(rows, true);
  }

  private mountRow_abyssPrivate(
    host: HTMLElement,
    viewportRow: TimelineViewportRow,
    markdown: Component,
  ): TimelineRowMount {
    if (viewportRow.kind === 'group')
      return this.mountGroup_abyssPrivate(host, viewportRow, markdown);
    const item = this.modelRows_abyssPrivate.get(viewportRow.key);
    if (item === undefined) throw new Error('Timeline row is no longer available');
    const row = this.createRow_abyssPrivate(host, item, viewportRow.groupKey, markdown);
    this.rows_abyssPrivate.set(viewportRow.key, row);
    const update = (): void => {
      const current = this.modelRows_abyssPrivate.get(viewportRow.key);
      if (current === undefined) return;
      row.project = current.project;
      row.range = current.range;
      row.element.dataset['projectPath'] = current.project.path;
      row.element.dataset['occurrenceId'] = current.occurrenceId;
      row.track.dataset['occurrenceId'] = current.occurrenceId;
      row.visibleCells = [];
      this.patchRow_abyssPrivate(row, current, row.visibleCells, this.currentWindow_abyssPrivate());
    };
    try {
      update();
    } catch (error) {
      this.destroyRow_abyssPrivate(viewportRow.key, row);
      throw error;
    }
    return {
      element: row.element,
      update,
      destroy: () => {
        this.destroyRow_abyssPrivate(viewportRow.key, row);
      },
    };
  }

  private destroyRow_abyssPrivate(key: string, row: RenderedRow<TCell>): void {
    this.rows_abyssPrivate.delete(key);
    for (const cleanup of row.cleanup) cleanup();
    this.visibleCells_abyssPrivate = this.visibleCells_abyssPrivate.filter(
      (cell) => !row.element.contains(cell.element),
    );
    row.cells.clear();
    row.visibleCells = [];
    row.element.remove();
  }

  private mountGroup_abyssPrivate(
    host: HTMLElement,
    row: TimelineViewportRow,
    markdown: Component,
  ): TimelineRowMount {
    const header = host.createEl('button', {
      cls: 'abyss-project-timeline-group-header',
      attr: { type: 'button' },
    });
    const chevron = header.createSpan({ cls: 'abyss-project-table-group-chevron' });
    const marker = header.createSpan({ cls: 'abyss-status-dot' });
    const label = header.createSpan({ cls: 'abyss-projects-group-label' });
    const count = header.createSpan({ cls: 'abyss-projects-group-count' });
    const click = (): void => {
      this.toggleGroup_abyssPrivate(row.groupKey);
    };
    header.addEventListener('click', click);
    const update = (): void => {
      const group = this.modelGroups_abyssPrivate.get(row.groupKey);
      if (group === undefined) return;
      const collapsed = this.isGroupCollapsed_abyssPrivate(row.groupKey);
      header.setAttribute('aria-expanded', String(!collapsed));
      chevron.empty();
      const icon = collapsed ? 'chevron-right' : 'chevron-down';
      chevron.dataset['icon'] = icon;
      setIcon(chevron, icon);
      this.context_abyssPrivate.renderGroupContent(
        marker,
        label,
        { ...group, projects: group.rows.map(({ project }) => project) },
        markdown,
      );
      count.setText(String(group.rows.length));
    };
    update();
    return {
      element: header,
      update,
      destroy: () => {
        header.removeEventListener('click', click);
        header.remove();
      },
    };
  }

  private syncGesturePins_abyssPrivate(): void {
    const next = new Set(this.interaction_abyssPrivate.pinnedOccurrences());
    for (const [key, release] of this.gestureReleases_abyssPrivate) {
      if (next.has(key)) continue;
      this.gestureReleases_abyssPrivate.delete(key);
      release();
    }
    for (const key of next)
      if (!this.gestureReleases_abyssPrivate.has(key))
        this.gestureReleases_abyssPrivate.set(key, this.rowMounts_abyssPrivate.pin(key));
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
    host: HTMLElement,
    item: ProjectTimelineRow,
    groupKey: string,
    markdown: Component,
  ): RenderedRow<TCell> {
    const element = host.createDiv({ cls: 'abyss-project-timeline-row' });
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
      markdown,
      cleanup: [],
      visibleCells: [],
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
    const keydown = (event: KeyboardEvent): void => {
      const focus = exactRangeEventTarget(event, track, bar);
      if (focus === undefined) return;
      this.handleRangeKeydown_abyssPrivate(row, event, focus);
    };
    const contextmenu = (event: MouseEvent): void => {
      const focus = exactRangeEventTarget(event, track, bar);
      if (focus === undefined) return;
      event.preventDefault();
      this.selectRange_abyssPrivate(row, focus);
      this.context_abyssPrivate.openRangeMenu(row.element.dataset['occurrenceId'] ?? '', event);
    };
    const click = (event: MouseEvent): void => {
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
    };
    track.addEventListener('keydown', keydown);
    track.addEventListener('contextmenu', contextmenu);
    element.addEventListener('click', click);
    row.cleanup.push(() => {
      track.removeEventListener('keydown', keydown);
      track.removeEventListener('contextmenu', contextmenu);
      element.removeEventListener('click', click);
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
      markdown: row.markdown,
      project: item.project,
      field,
      ...(options.column === undefined ? {} : { column: options.column }),
      occurrenceId: item.occurrenceId,
      groupKey: row.groupKey,
      ...(existing === undefined ? {} : { existing }),
    });
    if (cell.element !== host && cell.element.parentElement !== host) host.append(cell.element);
    row.cells.set(field.id, cell);
    if (options.selectable) visibleCells.push(cell);
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
    return [...this.rows_abyssPrivate.values()].find((row) => row.project.path === path);
  }
  private findRowByOccurrence_abyssPrivate(occurrenceId: string): RenderedRow<TCell> | undefined {
    return this.rows_abyssPrivate.get(occurrenceId);
  }
  private findLocatedRow_abyssPrivate(
    path: string,
  ): { readonly groupKey: string; readonly row: ProjectTimelineRow } | undefined {
    for (const group of this.model_abyssPrivate?.groups ?? []) {
      const row = group.rows.find((candidate) => candidate.project.path === path);
      if (row !== undefined) return { groupKey: group.key, row };
    }
    return undefined;
  }

  private isGroupCollapsed_abyssPrivate(key: string): boolean {
    return (
      this.context_abyssPrivate
        .savedSettings()
        .collapsedGroups?.includes(
          projectGroupCollapseKey(this.context_abyssPrivate.settings().groupBy, key),
        ) ?? false
    );
  }

  private setGroupCollapsed_abyssPrivate(key: string, collapsed: boolean): void {
    const settings = this.context_abyssPrivate.savedSettings();
    settings.collapsedGroups = setProjectGroupCollapsed(
      settings.collapsedGroups,
      projectGroupCollapseKey(this.context_abyssPrivate.settings().groupBy, key),
      collapsed,
    );
  }

  private toggleGroup_abyssPrivate(key: string): void {
    this.changeGroupCollapsed_abyssPrivate(key);
  }

  private changeGroupCollapsed_abyssPrivate(key: string, collapsed?: boolean): void {
    this.context_abyssPrivate
      .requestViewChange(() => {
        this.setGroupCollapsed_abyssPrivate(
          key,
          collapsed ?? !this.isGroupCollapsed_abyssPrivate(key),
        );
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] Could not change project Timeline view', error);
      });
  }

  private syncSelectedRows_abyssPrivate(): void {
    for (const row of this.rows_abyssPrivate.values())
      row.element.toggleClass('is-selected', row.project.path === this.selectedPath_abyssPrivate);
  }
}
