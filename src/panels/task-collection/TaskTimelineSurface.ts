import { Notice } from 'obsidian';
import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import {
  projectTimelineAxisLayout,
  projectTimelineTrackWidth,
  type ProjectTimelineAxisLayout,
} from '../../projects/projectTimelineAxis';
import type { ProjectTimelineEditIntent } from '../../projects/projectTimelineEdits';
import {
  projectTimelineBarGeometry,
  projectTimelineFitWindow,
  projectTimelineWindow,
  type ProjectTimelineRange,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';
import type { ProjectTimelineScale } from '../../projects/projectTimelineSettings';
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
    host: HTMLElement,
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
  readonly left: number;
  readonly anchor: string;
  readonly fitted?: ProjectTimelineWindow;
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
function date(day: string): Date {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const value = new Date(0);
  value.setFullYear(year, month - 1, dayOfMonth);
  value.setHours(0, 0, 0, 0);
  return value;
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
  readonly #heading: HTMLElement;
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
  #anchor: Date;
  #scale: ProjectTimelineScale;
  #fitted: ProjectTimelineWindow | undefined;
  #axisLayout: ProjectTimelineAxisLayout = { cells: [], hierarchyCells: [], gridBoundaries: [] };
  #pendingScroll: TaskTimelineScrollPosition | undefined;
  #centerDay: string | undefined;
  #destroyed = false;
  #suspended = false;

  constructor(
    readonly options: TaskListSurfaceOptions<T>,
    readonly actions: TaskTimelineActions<T>,
  ) {
    this.#anchor = actions.now();
    this.#scale = actions.settings().scale;
    options.host.addClass(
      'abyss-task-timeline',
      'abyss-project-timeline',
      'abyss-project-timeline-scroll',
    );
    this.#heading = options.host.createDiv({ cls: 'abyss-task-timeline-heading' });
    this.#axis = this.#heading.createDiv({ cls: 'abyss-project-timeline-axis' });
    this.#summary = this.#axis.createDiv({ cls: 'abyss-project-timeline-axis-summary' });
    this.#buttons = createTimelineNavigation(this.#summary, {
      previous: () => {
        this.#navigate(-1);
      },
      next: () => {
        this.#navigate(1);
      },
      today: () => {
        this.#anchor = actions.now();
        this.#fitted = undefined;
        this.#centerDay = localDay(this.#anchor);
        this.#navigationChanged();
      },
      scale: (scale) => {
        actions.changeScale(scale);
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
      viewportInset: () => this.#heading.getBoundingClientRect().height,
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
    this.#centerDay = localDay(this.#anchor);
    this.#migrationCleanup = this.#watchViewport();
  }
  #mountContext(): TimelineContextOverlay | undefined {
    return this.actions.mountContext?.(this.#dates, {
      scroll: this.options.scroll,
      window: () => this.#window(),
      now: () => this.actions.now(),
      revealDay: (day) => {
        this.#anchor = date(day);
        this.#fitted = undefined;
        this.#centerDay = day;
        this.#navigationChanged();
      },
    });
  }
  #watchViewport(): () => void {
    this.options.scroll.addEventListener('scroll', this.#schedule, { passive: true });
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
      left: this.options.scroll.scrollLeft,
      anchor: localDay(this.#anchor),
      ...(this.#fitted === undefined ? {} : { fitted: this.#fitted }),
    };
  }
  restoreScroll(position: TaskTimelineScrollPosition): void {
    this.#pendingScroll = position;
    this.#anchor = date(position.anchor);
    this.#fitted = position.fitted;
    this.#centerDay = undefined;
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
      this.#scale = settings.scale;
      this.#fitted = this.#fit(rows);
      this.#interaction.cancelActive();
    }
    this.options.host.dataset['descriptionLines'] = String(settings.descriptionLines);
    this.options.host.toggleClass('abyss-task-timeline--hide-metadata', !settings.showMetadata);
    this.#calendar();
    this.#viewport.update(rows, presentation, failure);
    if (this.#pendingScroll !== undefined) {
      this.options.scroll.scrollLeft = this.#pendingScroll.left;
      this.#pendingScroll = undefined;
      this.#calendar();
    }
    this.#interaction.reconcileAfterRender();
  }
  reveal(key: string): HTMLElement | undefined;
  reveal(key: string, options: { readonly waitForReady: true }): RevealResult;
  reveal(key: string, options?: { readonly waitForReady: true }): RevealResult {
    const result =
      options === undefined ? this.#viewport.reveal(key) : this.#viewport.reveal(key, options);
    let element: RevealResult;
    if (result === 'pending') element = 'pending';
    else if (result !== undefined) element = this.element(key);
    return element;
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
    this.options.scroll.removeEventListener('scroll', this.#schedule);
    this.#viewport.destroy();
    this.#contextOverlay?.destroy();
    this.#heading.remove();
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
  #patchState(mount: TimelineMount<T>, dates: ReturnType<typeof taskTimelineDates>): void {
    mount.state.hidden = mount.bar.hidden !== true;
    mount.state.disabled = dates.range.kind === 'unscheduled';
    if (dates.range.kind === 'malformed') {
      mount.state.className = 'abyss-project-timeline-state is-malformed';
      mount.state.setText(`Start ${String(dates.range.start)} · Due ${String(dates.range.end)}`);
      return;
    }
    if (dates.range.kind === 'unscheduled') {
      mount.state.className = 'abyss-project-timeline-state is-unscheduled';
      mount.state.setText('Unscheduled');
      mount.state.hidden =
        dates.scheduled !== undefined &&
        this.actions.settings().showScheduled &&
        mount.scheduled.hidden !== true;
      return;
    }
    const before = (bounds(dates.range)[0] ?? '') < this.#window().startDay;
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
      this.#anchor = date(first);
      this.#fitted = undefined;
      this.#centerDay = first;
      this.#navigationChanged();
    } else this.actions.openDates(mount.row.key, mount.state);
  }
  #window(): ProjectTimelineWindow {
    return this.#fitted ?? projectTimelineWindow(this.#anchor, this.#scale);
  }
  #fit(rows: TaskListRows<T>): ProjectTimelineWindow | undefined {
    let first: string | undefined, last: string | undefined;
    for (const value of this.#dateValues(rows)) {
      if (first === undefined || value < first) first = value;
      if (last === undefined || value > last) last = value;
    }
    return first === undefined || last === undefined
      ? undefined
      : projectTimelineFitWindow(first, last, this.#scale);
  }
  *#dateValues(rows: TaskListRows<T>): Iterable<string> {
    if (this.#contextOverlay !== undefined) yield* bounds(this.#contextOverlay.range());
    for (const row of rows.slice(0, rows.rowCount)) {
      if (row.kind !== 'task') continue;
      const dates = taskTimelineDates(this.actions.planning(row.task));
      yield* bounds(dates.range);
      if (this.actions.settings().showScheduled && dates.scheduled !== undefined)
        yield dates.scheduled;
    }
  }
  #navigate(direction: -1 | 1): void {
    const window = this.#window();
    const middle = ordinal(window.startDay) + Math.floor(window.dayCount / 2);
    this.#anchor = date(day(middle));
    this.#fitted = undefined;
    if (this.#scale === 'day' || this.#scale === 'week')
      this.#anchor = date(day(middle + window.dayCount * direction));
    else
      this.#anchor.setFullYear(
        this.#anchor.getFullYear() + { month: 1, quarter: 3, year: 4 }[this.#scale] * direction,
      );
    this.#centerDay = localDay(this.#anchor);
    this.#navigationChanged();
  }
  #navigationChanged(): void {
    this.#contextOverlay?.cancel();
    this.#interaction.cancelActive();
    this.#calendar();
    this.#viewport.refreshMeasurements();
  }
  #calendar(): void {
    const window = this.#window();
    const summaryWidth = this.#summary.getBoundingClientRect().width;
    const usable = Math.max(1, this.options.scroll.clientWidth - summaryWidth);
    const trackWidth = projectTimelineTrackWidth(window, usable);
    this.options.host.style.setProperty('--abyss-project-timeline-track-width', `${trackWidth}px`);
    if (this.#centerDay !== undefined) {
      this.options.scroll.scrollLeft = Math.max(
        0,
        ((ordinal(this.#centerDay) - ordinal(window.startDay) + 0.5) * trackWidth) /
          window.dayCount -
          usable / 2,
      );
      this.#centerDay = undefined;
    }
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
    patchTimelineAxisCells(
      this.#hierarchy,
      this.#axisLayout.hierarchyCells,
      'abyss-project-timeline-axis-hierarchy-cell',
      true,
    );
    patchTimelineAxisCells(
      this.#cells,
      this.#axisLayout.cells,
      `abyss-project-timeline-axis-cell${this.#scale === 'day' ? ' is-day' : ''}`,
      false,
    );
    for (const [scale, button] of this.#buttons) {
      button.setAttribute('aria-pressed', String(scale === this.#scale));
      button.toggleClass('is-active', scale === this.#scale);
    }
    patchTimelineToday(this.#dates, window, this.actions.now());
    this.#contextOverlay?.update(window);
    for (const mount of this.#mounts.values()) this.#patch(mount);
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
