import { Notice } from 'obsidian';
import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import {
  projectTimelineAxisLayout,
  type ProjectTimelineAxisLayout,
} from '../../projects/projectTimelineAxis';
import type { ProjectTimelineEditIntent } from '../../projects/projectTimelineEdits';
import {
  projectTimelineBarGeometry,
  type ProjectTimelineRange,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';
import type { ProjectTimelineScale } from '../../projects/projectTimelineSettings';
import {
  rebaseTimelineViewport,
  timelineViewportAt,
  timelineViewportCenter,
  type TimelineViewport,
  type TimelineViewportPosition,
} from '../../projects/projectTimelineViewport';
import { planTaskTimelineEdit, taskTimelineDates } from '../../task-lists/taskTimelineModel';
import type { TaskTimelineSettings } from '../../task-lists/taskTimelineSettings';
import {
  localDate,
  sameTaskNodeRef,
  type TaskNodeSnapshot,
  type TaskPatch,
  type TaskPlanning,
} from '../../tasks';
import type { TaskListRow, TaskListRows } from '../task-list/taskListRows';
import {
  TaskListSurface,
  type TaskListNativeWriteObserver,
  type TaskListPresentation,
  type TaskListScrollPosition,
  type TaskListSurfaceOptions,
  type TaskRowMount,
} from '../task-list/TaskListSurface';
import type {
  TimelineContextOverlay,
  TimelineContextOverlayLayout,
} from '../timeline/TimelineContextOverlay';
import {
  TimelinePointerInteraction,
  applyProjectTimelineBarGeometry,
  type TimelineRangeSource,
} from '../timeline/TimelinePointerInteraction';
import {
  createTimelineNavigation,
  createTimelineRangeHandle,
  patchTimelineAxisCells,
  patchTimelineGrid,
  patchTimelineToday,
} from '../timeline/timelinePresentation';
import type { TaskCollectionSurface } from './TaskCollectionSurface';

interface TaskTimelineSource extends TimelineRangeSource {
  readonly key: string;
  readonly task: TaskNodeSnapshot;
  readonly part: 'range' | 'scheduled';
}
interface TaskTimelineActions<T> {
  settings(): TaskTimelineSettings;
  now(): Date;
  planning(task: T): TaskPlanning;
  completed?(task: T): boolean;
  snapshot(key: string): TaskNodeSnapshot | undefined;
  commit(task: TaskNodeSnapshot, patch: TaskPatch, accept: () => boolean): Promise<boolean>;
  select(key: string, element: HTMLElement): void;
  inspect?(key: string): void;
  openDates(key: string, anchor: HTMLElement): void;
  changeScale(scale: ProjectTimelineScale): void;
  mountContext?(
    axisDates: HTMLElement,
    layout: TimelineContextOverlayLayout,
  ): TimelineContextOverlay | undefined;
}
interface TimelineMount<T> {
  row: Extract<TaskListRow<T>, { kind: 'task' }>;
  readonly element: HTMLElement;
  readonly card: TaskRowMount<T>;
  readonly track: HTMLElement;
  readonly grid: HTMLElement;
  readonly bar: HTMLElement;
  readonly state: HTMLButtonElement;
  readonly scheduledTrack: HTMLElement;
  readonly scheduled: HTMLElement;
}
export interface TaskTimelineScrollPosition {
  readonly rows: TaskListScrollPosition;
  readonly center: number | 'today';
  readonly viewport: TimelineViewport;
  readonly usableWidth: number;
}
function ordinal(day: string): number {
  return projectCalendarDayOrdinal(day) as number;
}
function day(value: number): string {
  return projectCalendarDayFromOrdinal(value) as string;
}
function localDay(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function bounds(range: ProjectTimelineRange): readonly string[] {
  if (range.kind === 'closed') return [range.startDay, range.endDay];
  if (range.kind === 'open-end') return [range.startDay];
  return range.kind === 'open-start' ? [range.endDay] : [];
}
type RevealResult = HTMLElement | 'pending' | undefined;
const scheduledSuffix = '\u0000scheduled';

/** Existing task cards and row receipts under the same compact calendar used by Projects. */
export class TaskTimelineSurface<T> implements TaskCollectionSurface<T> {
  readonly #viewport: TaskListSurface<T>;
  readonly #axis: HTMLElement;
  readonly #contextOverlay: TimelineContextOverlay | undefined;
  readonly #summary: HTMLElement;
  readonly #dates: HTMLElement;
  readonly #hierarchy: HTMLElement;
  readonly #cells: HTMLElement;
  readonly #rowsHost: HTMLElement;
  readonly #buttons: Map<ProjectTimelineScale, HTMLButtonElement>;
  readonly #mounts = new Map<string, TimelineMount<T>>();
  readonly #pins = new Map<string, () => void>();
  readonly #interaction: TimelinePointerInteraction<TaskTimelineSource>;
  readonly #migrationCleanup: () => void;
  #owner: Window | null = null;
  #resize: ResizeObserver | undefined;
  #frame: number | undefined;
  #geometry: TimelineViewport;
  #usableWidth = 0;
  #lastLeft = 0;
  #calendarSignature = '';
  #todayDay = '';
  #scale: ProjectTimelineScale;
  #axisLayout: ProjectTimelineAxisLayout = { cells: [], hierarchyCells: [], gridBoundaries: [] };
  #pendingCenter: number | 'today' | undefined;
  #destroyed = false;
  #suspended = false;

  constructor(
    readonly options: TaskListSurfaceOptions<T>,
    readonly actions: TaskTimelineActions<T>,
  ) {
    this.#scale = actions.settings().scale;
    this.#pendingCenter = 'today';
    this.#geometry = timelineViewportAt(
      ordinal(localDay(actions.now())) + 0.5,
      this.#scale,
      1,
    ).viewport;
    options.host.addClass(
      'abyss-task-timeline',
      'abyss-project-timeline',
      'abyss-project-timeline-scroll',
    );
    this.#axis = options.host.createDiv({ cls: 'abyss-project-timeline-axis' });
    this.#summary = this.#axis.createDiv({ cls: 'abyss-project-timeline-axis-summary' });
    this.#buttons = createTimelineNavigation(this.#summary, {
      scale: (scale) => {
        if (scale === this.#scale) this.focusToday();
        else actions.changeScale(scale);
      },
    });
    this.#dates = this.#axis.createDiv({ cls: 'abyss-project-timeline-axis-dates' });
    this.#hierarchy = this.#dates.createDiv({
      cls: 'abyss-project-timeline-axis-hierarchy',
      attr: { 'aria-hidden': 'true' },
    });
    this.#cells = this.#dates.createDiv({
      cls: 'abyss-project-timeline-axis-cells',
      attr: { 'aria-hidden': 'true' },
    });
    this.#contextOverlay = this.#mountContext();
    this.#rowsHost = options.host.createDiv({ cls: 'abyss-task-timeline-rows' });
    this.#viewport = new TaskListSurface({
      ...options,
      host: this.#rowsHost,
      viewportInset: () => this.#axis.getBoundingClientRect().height,
      mount: (parent, row) => this.#mount(parent, row),
    });
    this.#interaction = new TimelinePointerInteraction({
      root: this.#rowsHost,
      scroll: options.scroll,
      window: () => this.#window(),
      captureRangeSource: (identity) => this.#capture(identity),
      sameSource: (a, b) => sameTaskNodeRef(a.task.target, b.task.target) && a.part === b.part,
      plan: (source, intent) =>
        planTaskTimelineEdit(source.task.node.planning, intent, source.part),
      commitRangeEdit: async ({ source, intent }) => ({
        changed: await this.#commit(source, intent),
      }),
      reportRangeFailure: (failure) => {
        this.#report(failure);
      },
      finishEditor: () => Promise.resolve(true),
      selectRange: (identity, focus) => {
        actions.select(this.#key(identity), focus);
      },
      clickTrack: (source, day) => {
        this.#setDue(source, day);
      },
      clickRange: (identity) => {
        actions.inspect?.(this.#key(identity));
      },
      pinsChanged: () => {
        this.#syncPins();
      },
    });
    this.#migrationCleanup = this.#watchViewport();
  }
  #mountContext(): TimelineContextOverlay | undefined {
    return this.actions.mountContext?.(this.#dates, {
      scroll: this.options.scroll,
      window: () => this.#window(),
      now: () => this.actions.now(),
      revealDay: (day) => {
        this.#pendingCenter = ordinal(day) + 0.5;
        this.#navigationChanged();
      },
    });
  }
  #watchViewport(): () => void {
    this.options.scroll.addEventListener('scroll', this.#scroll, { passive: true });
    this.#bind();
    return this.options.host.onWindowMigrated(() => {
      this.#bind();
    });
  }
  get rows(): TaskListRows<T> {
    return this.#viewport.rows;
  }
  captureScroll(): TaskTimelineScrollPosition {
    return {
      rows: this.#viewport.captureScroll(),
      center:
        this.#pendingCenter ??
        timelineViewportCenter(this.#geometry, this.options.scroll.scrollLeft, this.#usableWidth),
      viewport: this.#geometry,
      usableWidth: this.#usableWidth,
    };
  }
  restoreScroll(position: TaskTimelineScrollPosition): void {
    this.#geometry = position.viewport;
    this.#usableWidth = position.usableWidth;
    this.#pendingCenter = position.center;
    this.#viewport.restoreScroll(position.rows);
  }
  element(key: string): HTMLElement | undefined {
    return this.#mounts.get(key)?.card.element ?? this.#viewport.element(key);
  }
  *cards(): Iterable<readonly [string, HTMLElement]> {
    for (const key of this.#viewport.mountedKeys()) {
      const element = this.element(key);
      if (element !== undefined) yield [key, element];
    }
  }
  mountedKeys(): readonly string[] {
    return this.#viewport.mountedKeys();
  }
  refreshMeasurements(): void {
    this.#viewport.refreshMeasurements();
    this.#schedule();
  }
  update(
    rows: TaskListRows<T>,
    presentation: TaskListPresentation<T>,
    failure: 'report' | 'throw' = 'report',
  ): void {
    if (this.#destroyed) return;
    this.#bind();
    const settings = this.actions.settings();
    if (settings.scale !== this.#scale) {
      this.#contextOverlay?.cancel();
      this.#pendingCenter ??= timelineViewportCenter(
        this.#geometry,
        this.options.scroll.scrollLeft,
        this.#usableWidth,
      );
      this.#scale = settings.scale;
      this.#interaction.cancelActive();
    }
    this.options.host.dataset['descriptionLines'] = String(settings.descriptionLines);
    this.options.host.toggleClass('abyss-task-timeline--hide-metadata', !settings.showMetadata);
    this.#calendar();
    this.#viewport.update(rows, presentation, failure);
    this.#interaction.reconcileAfterRender();
  }
  reveal(key: string): HTMLElement | undefined;
  reveal(key: string, options: { readonly waitForReady: true }): RevealResult;
  reveal(key: string, options?: { readonly waitForReady: true }): RevealResult {
    const result =
      options === undefined ? this.#viewport.reveal(key) : this.#viewport.reveal(key, options);
    const task = this.rows.task(key);
    if (task !== undefined) this.#revealDates(task);
    let element: RevealResult;
    if (result === 'pending') element = 'pending';
    else if (result !== undefined) element = this.element(key);
    return element;
  }
  #revealDates(task: T): void {
    const dates = taskTimelineDates(this.actions.planning(task));
    const range =
      dates.range.kind === 'unscheduled' &&
      dates.scheduled !== undefined &&
      this.actions.settings().showScheduled
        ? { kind: 'open-end' as const, startDay: dates.scheduled }
        : dates.range;
    const first = bounds(range)[0];
    if (first !== undefined && (this.#pendingCenter !== undefined || !this.#rangeVisible(range))) {
      this.#pendingCenter = ordinal(first) + 0.5;
      this.#navigationChanged();
    }
  }
  pin(
    key: string,
    onInvalidated?: () => void,
    nativeWrite?: TaskListNativeWriteObserver,
  ): () => void {
    return this.#viewport.pin(key, onInvalidated, nativeWrite);
  }
  observeNativeWrites(
    observer: TaskListNativeWriteObserver,
    onInvalidated: () => void,
  ): () => void {
    return this.#viewport.observeNativeWrites(observer, onInvalidated);
  }
  suspend(releaseMounts = false): void {
    this.#suspended = true;
    this.#contextOverlay?.cancel();
    this.#interaction.cancelActive();
    this.#cancelFrame();
    this.#viewport.suspend(releaseMounts);
  }
  resume(): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    this.#bind();
    this.#viewport.resume();
    this.#schedule();
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#interaction.destroy();
    for (const release of this.#pins.values()) release();
    this.#pins.clear();
    this.#cancelFrame();
    this.#resize?.disconnect();
    this.#migrationCleanup();
    this.options.scroll.removeEventListener('scroll', this.#scroll);
    this.#viewport.destroy();
    this.#contextOverlay?.destroy();
    this.#axis.remove();
    this.#rowsHost.remove();
    this.options.host.removeClass(
      'abyss-task-timeline',
      'abyss-project-timeline',
      'abyss-project-timeline-scroll',
      'abyss-task-timeline--hide-metadata',
    );
    for (const property of [
      '--abyss-project-timeline-track-width',
      '--abyss-project-timeline-range-state-left',
      '--abyss-project-timeline-range-state-right',
    ])
      this.options.host.style.removeProperty(property);
    delete this.options.host.dataset['descriptionLines'];
  }
  #key(identity: string): string {
    return identity.endsWith(scheduledSuffix)
      ? identity.slice(0, -scheduledSuffix.length)
      : identity;
  }
  #capture(
    identity: string,
  ):
    | { readonly kind: 'ready'; readonly source: TaskTimelineSource }
    | { readonly kind: 'rejected'; readonly reason: string } {
    const key = this.#key(identity);
    const task = this.actions.snapshot(key);
    if (this.#destroyed || this.#suspended || task === undefined || this.rows.indexOf(key) < 0)
      return { kind: 'rejected', reason: 'This task is no longer available in the Timeline.' };
    const part = identity.endsWith(scheduledSuffix) ? 'scheduled' : 'range';
    const planning = task.node.planning;
    const range =
      part === 'scheduled'
        ? taskTimelineDates({
            ...(planning.scheduled === undefined ? {} : { start: planning.scheduled }),
          }).range
        : taskTimelineDates(planning).range;
    return { kind: 'ready', source: { occurrenceId: identity, key, task, part, range } };
  }
  async #commit(source: TaskTimelineSource, intent: ProjectTimelineEditIntent): Promise<boolean> {
    const plan = planTaskTimelineEdit(source.task.node.planning, intent, source.part);
    if (plan.kind === 'rejected') {
      this.#report(plan.reason);
      return false;
    }
    return this.#commitPatch(source, plan.patch);
  }
  #commitPatch(source: TaskTimelineSource, patch: TaskPatch): Promise<boolean> {
    const accept = (): boolean => {
      const current = this.#capture(source.occurrenceId);
      return (
        current.kind === 'ready' && sameTaskNodeRef(source.task.target, current.source.task.target)
      );
    };
    return accept() ? this.actions.commit(source.task, patch, accept) : Promise.resolve(false);
  }
  #setDue(source: TaskTimelineSource, day: string): void {
    void this.#commitPatch(source, { due: { type: 'set', value: localDate(day) } }).catch(
      (error: unknown) => {
        this.#report(error);
      },
    );
  }
  #report(failure: unknown): void {
    new Notice(typeof failure === 'string' ? failure : 'Could not update task dates.');
    console.error('[abyss-tasks] Task Timeline date edit failed', failure);
  }
  #syncPins(): void {
    if (this.#destroyed) return;
    const keys = new Set(this.#interaction.pinnedOccurrences().map((key) => this.#key(key)));
    for (const [key, release] of this.#pins) {
      if (!keys.has(key)) {
        this.#pins.delete(key);
        release();
      }
    }
    for (const key of keys)
      if (!this.#pins.has(key))
        this.#pins.set(
          key,
          this.#viewport.pin(key, () => {
            this.#interaction.cancelActive();
          }),
        );
  }
  #mount(parent: HTMLElement, row: TaskListRow<T>): TaskRowMount<T> {
    if (row.kind === 'group') return this.options.mount(parent, row);
    const element = parent.createDiv({ cls: 'abyss-project-timeline-row abyss-task-timeline-row' });
    element.dataset['occurrenceId'] = row.key;
    const summary = element.createDiv({ cls: 'abyss-project-timeline-summary' });
    const card = this.options.mount(summary, row);
    const track = element.createDiv({
      cls: 'abyss-project-timeline-track',
      attr: { tabindex: '0', 'data-timeline-part': 'track' },
    });
    const grid = track.createDiv({
      cls: 'abyss-project-timeline-grid',
      attr: { 'aria-hidden': 'true' },
    });
    const bar = track.createDiv({
      cls: 'abyss-project-timeline-bar',
      attr: { tabindex: '0', role: 'button', 'data-timeline-part': 'bar' },
    });
    for (const endpoint of ['start', 'end'] as const) createTimelineRangeHandle(bar, endpoint);
    const state = track.createEl('button', {
      cls: 'abyss-project-timeline-state',
      attr: { type: 'button' },
    });
    const scheduledTrack = track.createDiv({
      cls: 'abyss-project-timeline-track abyss-task-timeline-scheduled-track',
    });
    scheduledTrack.dataset['occurrenceId'] = row.key + scheduledSuffix;
    const scheduled = scheduledTrack.createDiv({
      cls: 'abyss-project-timeline-bar',
      attr: { tabindex: '0', role: 'button', 'data-timeline-part': 'bar' },
    });
    const mount: TimelineMount<T> = {
      row,
      element,
      card,
      track,
      grid,
      bar,
      state,
      scheduledTrack,
      scheduled,
    };
    this.#mounts.set(row.key, mount);
    const unbind = this.#bindRow(mount);
    const releaseContext = this.#contextOverlay?.mountTrack(track);
    this.#patch(mount);
    return {
      element,
      measurementReady: () => card.measurementReady?.() ?? true,
      update: (next) => {
        if (next.kind === 'task') {
          mount.row = next;
          card.update(next);
          // Canonical card replacement detaches its holder; this wrapper owns its placement.
          if (card.element.parentElement !== summary) summary.append(card.element);
          this.#patch(mount);
        }
      },
      destroy: () => {
        this.#mounts.delete(row.key);
        unbind();
        releaseContext?.();
        card.destroy();
        element.remove();
      },
    };
  }
  #bindRow(mount: TimelineMount<T>): () => void {
    const { track, state } = mount;
    const keydown = (event: KeyboardEvent): void => {
      this.#keydown(event, mount);
    };
    track.addEventListener('keydown', keydown);
    const rangeClick = (): void => {
      this.#stateClick(mount);
    };
    state.addEventListener('click', rangeClick);
    return () => {
      track.removeEventListener('keydown', keydown);
      state.removeEventListener('click', rangeClick);
    };
  }
  #keydown(event: KeyboardEvent, mount: TimelineMount<T>): void {
    const target = event.target;
    if (target !== mount.bar && target !== mount.scheduled && target !== mount.track) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (target === mount.track) this.actions.openDates(mount.row.key, mount.track);
      else this.actions.inspect?.(mount.row.key);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    this.#keyboardEdit(mount, target === mount.scheduled, event);
  }
  #keyboardEdit(mount: TimelineMount<T>, scheduled: boolean, event: KeyboardEvent): void {
    const captured = this.#capture(mount.row.key + (scheduled ? scheduledSuffix : ''));
    if (captured.kind !== 'ready') return;
    const deltaDays = event.key === 'ArrowLeft' ? -1 : 1;
    const intent: ProjectTimelineEditIntent =
      event.shiftKey && !scheduled ? { type: 'adjustEnd', deltaDays } : { type: 'move', deltaDays };
    void this.#commit(captured.source, intent).catch((error: unknown) => {
      this.#report(error);
    });
  }
  #patch(mount: TimelineMount<T>): void {
    mount.element.toggleClass('is-done', this.actions.completed?.(mount.row.task) ?? false);
    const dates = taskTimelineDates(this.actions.planning(mount.row.task));
    patchTimelineGrid(mount.grid, this.#axisLayout);
    patchTimelineToday(mount.track, this.#window(), this.actions.now());
    this.#patchBar(mount.bar, dates.range);
    mount.bar.setAttribute('aria-label', this.#rangeLabel(dates.range));
    const scheduledRange: ProjectTimelineRange =
      dates.scheduled === undefined
        ? { kind: 'unscheduled' }
        : { kind: 'open-end', startDay: dates.scheduled };
    this.#patchBar(mount.scheduled, scheduledRange);
    mount.scheduledTrack.hidden =
      !this.actions.settings().showScheduled || dates.scheduled === undefined;
    mount.scheduled.setAttribute('aria-label', `Scheduled ${dates.scheduled ?? ''}`);
    mount.element.toggleClass(
      'has-scheduled-range',
      !mount.scheduledTrack.hidden &&
        dates.range.kind !== 'unscheduled' &&
        dates.range.kind !== 'malformed',
    );
    this.#patchState(mount, dates);
  }
  #patchState(
    mount: TimelineMount<T>,
    dates: ReturnType<typeof taskTimelineDates>,
    visibleStart = this.#visibleStart(),
  ): void {
    const range =
      dates.range.kind === 'unscheduled' &&
      dates.scheduled !== undefined &&
      this.actions.settings().showScheduled
        ? { kind: 'open-end' as const, startDay: dates.scheduled }
        : dates.range;
    mount.state.hidden = this.#rangeVisible(range, visibleStart);
    mount.state.disabled = range.kind === 'unscheduled';
    if (range.kind === 'malformed') {
      mount.state.className = 'abyss-project-timeline-state is-malformed';
      mount.state.setText(`Start ${String(range.start)} · Due ${String(range.end)}`);
      return;
    }
    if (range.kind === 'unscheduled') {
      mount.state.className = 'abyss-project-timeline-state is-unscheduled';
      mount.state.setText('Unscheduled');
      return;
    }
    const anchor = bounds(range)[0];
    const before = anchor !== undefined && ordinal(anchor) < visibleStart;
    mount.state.className = `abyss-project-timeline-state abyss-project-timeline-boundary-marker is-${before ? 'before' : 'after'}`;
    mount.state.setText(before ? '←' : '→');
  }
  #patchBar(bar: HTMLElement, range: ProjectTimelineRange): void {
    const geometry = projectTimelineBarGeometry(range, this.#window());
    bar.hidden = geometry === undefined;
    if (geometry !== undefined) applyProjectTimelineBarGeometry(bar, range, geometry);
  }
  #rangeLabel(range: ProjectTimelineRange): string {
    if (range.kind === 'closed') return `Start ${range.startDay}, Due ${range.endDay}`;
    if (range.kind === 'open-end') return `Start ${range.startDay}, no Due date`;
    if (range.kind === 'open-start') return `Due ${range.endDay}, no Start date`;
    return 'Task dates';
  }
  #stateClick(mount: TimelineMount<T>): void {
    const dates = taskTimelineDates(this.actions.planning(mount.row.task));
    const first = bounds(dates.range)[0] ?? dates.scheduled;
    if (first !== undefined && dates.range.kind !== 'malformed') {
      this.#pendingCenter = ordinal(first) + 0.5;
      this.#navigationChanged();
    } else this.actions.openDates(mount.row.key, mount.state);
  }
  #window(): ProjectTimelineWindow {
    return this.#geometry.window;
  }
  focusToday(): void {
    this.#pendingCenter = 'today';
    this.#navigationChanged();
  }
  #visibleStart(): number {
    return (
      ordinal(this.#window().startDay) + this.options.scroll.scrollLeft / this.#geometry.dayWidth
    );
  }
  #rangeVisible(range: ProjectTimelineRange, visibleStart = this.#visibleStart()): boolean {
    const values = bounds(range);
    if (values.length === 0) return false;
    const first = ordinal(values[0] as string),
      last = ordinal(values[values.length - 1] as string) + 1;
    return (
      first < visibleStart + this.#usableWidth / this.#geometry.dayWidth && last > visibleStart
    );
  }
  #navigationChanged(): void {
    this.#contextOverlay?.cancel();
    this.#interaction.cancelActive();
    this.#calendar();
    this.#viewport.refreshMeasurements();
  }
  #position(usable: number): TimelineViewportPosition {
    if (usable <= 0) return { viewport: this.#geometry, left: this.options.scroll.scrollLeft };
    if (usable > 0 && (this.#pendingCenter !== undefined || usable !== this.#usableWidth)) {
      const center =
        this.#pendingCenter === 'today'
          ? ordinal(localDay(this.actions.now())) + 0.5
          : (this.#pendingCenter ??
            timelineViewportCenter(
              this.#geometry,
              this.options.scroll.scrollLeft,
              this.#usableWidth,
            ));
      this.#pendingCenter = undefined;
      return timelineViewportAt(center, this.#scale, usable);
    }
    return rebaseTimelineViewport(this.#geometry, this.options.scroll.scrollLeft, usable);
  }
  #calendar(): void {
    const usable = this.options.scroll.clientWidth - this.#summary.getBoundingClientRect().width;
    const position = this.#position(usable);
    const changed = position.viewport !== this.#geometry;
    this.#geometry = position.viewport;
    if (usable > 0) this.#usableWidth = usable;
    const window = this.#window(),
      trackWidth = this.#geometry.trackWidth;
    this.options.host.style.setProperty('--abyss-project-timeline-track-width', `${trackWidth}px`);
    if (usable > 0 && this.options.scroll.scrollLeft !== position.left)
      this.options.scroll.scrollLeft = position.left;
    this.#lastLeft = this.options.scroll.scrollLeft;
    this.#contextOverlay?.update(window);
    const todayDay = localDay(this.actions.now());
    const todayChanged = todayDay !== this.#todayDay;
    this.#todayDay = todayDay;
    const signature = `${window.startDay}:${window.scale}:${this.#lastLeft}:${usable}:${todayDay}`;
    if (signature === this.#calendarSignature) return;
    this.#calendarSignature = signature;
    this.options.host.style.setProperty(
      '--abyss-project-timeline-range-state-left',
      `${this.options.scroll.scrollLeft + 10}px`,
    );
    this.options.host.style.setProperty(
      '--abyss-project-timeline-range-state-right',
      `${Math.max(10, trackWidth - this.options.scroll.scrollLeft - usable + 10)}px`,
    );
    const first = ordinal(window.startDay),
      left = Math.max(0, this.options.scroll.scrollLeft);
    const startOffset = Math.min(
      window.dayCount - 1,
      Math.floor((left / trackWidth) * window.dayCount),
    );
    const endOffset = Math.min(
      window.dayCount - 1,
      Math.max(startOffset, Math.ceil(((left + usable) / trackWidth) * window.dayCount) - 1),
    );
    this.#axisLayout = projectTimelineAxisLayout(window, {
      visibleStartDay: day(first + startOffset),
      visibleEndDay: day(first + endOffset),
      visibleStartPercent: (left / trackWidth) * 100,
      todayDay: localDay(this.actions.now()),
      overscanCells: 1,
    });
    this.#patchCalendarHeading();
    this.#patchMountedCalendar(changed, todayChanged);
  }
  #patchCalendarHeading(): void {
    const window = this.#window();
    patchTimelineAxisCells(
      this.#hierarchy,
      this.#axisLayout.hierarchyCells,
      'abyss-project-timeline-axis-hierarchy-cell',
    );
    patchTimelineAxisCells(
      this.#cells,
      this.#axisLayout.cells,
      `abyss-project-timeline-axis-cell${this.#scale === 'day' ? ' is-day' : ''}`,
    );
    for (const [scale, button] of this.#buttons) {
      button.setAttribute('aria-pressed', String(scale === this.#scale));
      button.toggleClass('is-active', scale === this.#scale);
      button.title = scale === this.#scale ? 'Center Today' : 'Change Timeline scale';
    }
    patchTimelineToday(this.#dates, window, this.actions.now());
  }
  #patchMountedCalendar(changed: boolean, todayChanged: boolean): void {
    const window = this.#window(),
      visibleStart = this.#visibleStart();
    for (const mount of this.#mounts.values()) {
      patchTimelineGrid(mount.grid, this.#axisLayout);
      if (changed || todayChanged) patchTimelineToday(mount.track, window, this.actions.now());
      if (changed) {
        const dates = taskTimelineDates(this.actions.planning(mount.row.task));
        this.#patchBar(mount.bar, dates.range);
        this.#patchBar(
          mount.scheduled,
          dates.scheduled === undefined
            ? { kind: 'unscheduled' }
            : { kind: 'open-end', startDay: dates.scheduled },
        );
      }
      this.#patchState(
        mount,
        taskTimelineDates(this.actions.planning(mount.row.task)),
        visibleStart,
      );
    }
  }
  #bind(): void {
    const owner = this.options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return;
    this.#cancelFrame();
    this.#resize?.disconnect();
    this.#owner = owner;
    if (owner === null) return;
    this.#resize = new owner.ResizeObserver(() => {
      this.#schedule();
    });
    this.#resize.observe(this.options.scroll);
    this.#resize.observe(this.#summary);
  }
  readonly #scroll = (): void => {
    if (this.options.scroll.scrollLeft !== this.#lastLeft) this.#pendingCenter = undefined;
    this.#schedule();
  };
  readonly #schedule = (): void => {
    if (this.#destroyed || this.#suspended || this.#owner === null || this.#frame !== undefined)
      return;
    this.#frame = this.#owner.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (!this.#destroyed && !this.#suspended) {
        this.#calendar();
        this.#interaction.reconcileAfterRender();
      }
    });
  };
  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }
}
