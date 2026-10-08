import type { App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import type { CalendarSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import type {
  LocalDate,
  TaskApplicationApi,
  TaskNodeRef,
  TaskPriority,
  TaskQueryApi,
  TaskSnapshot,
} from '../../tasks';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import type { TaskDependencyLookup } from '../../ui/taskDependencyPresentation';
import { startTaskNodeDrag } from '../../ui/taskNodeDrag';
import { taskSelectionPath } from '../../ui/taskSelection';
import { calendarNativeDragPayload } from '../../views/calendarNativeDrag';
import {
  calendarOccurrenceForTask,
  isForecastCalendarTask,
  type CalendarProjectionIssue,
  type CalendarTaskSource,
} from '../../views/calendarOccurrences';
import type { PanelNavigationActions } from '../../views/panelNavigation';
import {
  createCalendarProjectionDiagnosticOwner,
  createForecastContextMenuOwner,
  type CalendarProjectionDiagnosticOwner,
  type ForecastContextMenuOwner,
} from '../../views/timegrid/renderTaskMeta';
import type { ShowInTaskList } from '../right/inspectorTypes';
import { CalendarNavigationBar } from './CalendarNavigationBar';
import type { CalendarCapturePlacement } from './calendarCapturePlacement';
import { CalendarCommands } from './calendarCommands';
import { calendarContent, type CalendarContent } from './calendarContent';
import {
  calendarScrollKey,
  dateForView,
  isoWeekStart,
  stepCalendarDate,
  type CalendarMoment,
} from './calendarDateNavigation';
import {
  createCalendarView,
  type CalendarHandlers,
  type CalendarViewDependencies,
  type CalendarViewInstance,
} from './calendarViewFactory';
import type { CalViewType } from './calendarViewType';
import { TimedBlockFocusRetention } from './timedBlockFocusRetention';
import { visibleCalendarDates } from './visibleCalendarDates';

/** What calendar mode needs from the panel that owns it. Every member reads panel state lazily. */
export interface CalendarModeHost {
  /** Full panel render, used by open-day, open-week, and following a keyboard shift. */
  readonly rerender: () => void;
  readonly onShowParent?: ShowInTaskList | undefined;
  readonly openTask: (task: TaskSnapshot, initialTarget?: TaskNodeRef) => void;
  readonly openForecastTask: (source: CalendarTaskSource, referenceDate: LocalDate) => void;
  readonly toggleTask: (task: TaskSnapshot) => Promise<void>;
  readonly setTaskStatus: (task: TaskSnapshot, symbol: string) => Promise<void>;
  readonly setPriority: (task: TaskSnapshot, priority: TaskPriority) => Promise<void>;
  readonly dependenciesFor: TaskDependencyLookup;
  readonly tagGroups: () => readonly EffectiveTagGroup[];
  readonly openForecastRecurrenceEditor: (anchor: HTMLElement, source: CalendarTaskSource) => void;
  readonly dismissRecurrenceEditor: () => void;
  readonly openCapture: (placement: CalendarCapturePlacement) => void;
  readonly unmountActiveCapture: () => void;
  readonly remountActiveCapture: () => void;
  readonly syncTaskStackSelection: () => void;
  readonly onRenderComplete: (root: HTMLElement) => void;
}

export interface CalendarModeDependencies {
  readonly state: AppState;
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly queries: TaskQueryApi;
  readonly tasks: TaskApplicationApi | undefined;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly navigation: Pick<PanelNavigationActions, 'openCalendarView'>;
  readonly host: CalendarModeHost;
}

interface CalendarRenderContext {
  readonly root: HTMLElement;
  readonly viewContainer: HTMLElement;
  readonly forecastMenuOwner: ForecastContextMenuOwner;
  readonly projectionDiagnosticOwner: CalendarProjectionDiagnosticOwner;
  readonly handlers: CalendarHandlers;
}

/**
 * The calendar mode of the centre panel: the session's date and view type, the mounted view and
 * its patch subscription, the navigation bar, and the keyboard focus retention. It renders into the
 * panel element it is given and reaches `CenterPanel` only through {@link CalendarModeHost}; it
 * shares the `AppState` and the panel navigation port with the shell.
 */
export class CalendarMode {
  private viewType_abyssPrivate: CalViewType = 'month';
  private date_abyssPrivate: CalendarMoment = moment().date(1);
  private viewInstance_abyssPrivate: CalendarViewInstance | null = null;
  private unsubscribe_abyssPrivate: (() => void) | null = null;
  private forecastMenuOwner_abyssPrivate: ForecastContextMenuOwner | null = null;
  private projectionDiagnosticOwner_abyssPrivate: CalendarProjectionDiagnosticOwner | null = null;
  private navigationBar_abyssPrivate: CalendarNavigationBar | null = null;
  // The (view, date) pair that last scrolled the time grid to the current time.
  private lastScrolledKey_abyssPrivate: string | null = null;
  // The outgoing time grid's scroll position, carried across a full calendar render.
  private pendingScrollTop_abyssPrivate: number | undefined = undefined;
  // The panel element of the last render; the focus retention resolves blocks inside it.
  private root_abyssPrivate: HTMLElement | null = null;
  private readonly commands_abyssPrivate: CalendarCommands;
  private readonly focusRetention_abyssPrivate: TimedBlockFocusRetention;

  constructor(private readonly deps_abyssPrivate: CalendarModeDependencies) {
    this.commands_abyssPrivate = new CalendarCommands({
      tasks: deps_abyssPrivate.tasks,
      queries: deps_abyssPrivate.queries,
      nativeDrag: () => deps_abyssPrivate.state.get('draggingTaskNode'),
    });
    this.focusRetention_abyssPrivate = new TimedBlockFocusRetention(deps_abyssPrivate.tasks, {
      isCalendarActive: () => deps_abyssPrivate.state.get('mode') === 'calendar',
      root: () => this.root_abyssPrivate,
      follow: (updated, nextSegmentDate) => {
        this.followShiftedTask_abyssPrivate(updated, nextSegmentDate);
      },
    });
  }

  view(): CalViewType {
    return this.viewType_abyssPrivate;
  }

  /** Selects a view and its policy date without rendering; the navigator triggers the render. */
  setView(view: CalViewType): void {
    this.viewType_abyssPrivate = view;
    this.date_abyssPrivate = dateForView(view, moment());
  }

  /** Full calendar render into the panel element. */
  render(root: HTMLElement): void {
    this.root_abyssPrivate = root;
    this.focusRetention_abyssPrivate.captureActiveFocus(root);
    this.pendingScrollTop_abyssPrivate =
      root.querySelector<HTMLElement>('.abyss-tg-grid-row')?.scrollTop;
    root.empty();
    this.unmount();
    this.renderShell_abyssPrivate(root);
  }

  /** Releases the mounted calendar; the owner empties the element. */
  unmount(): void {
    this.forecastMenuOwner_abyssPrivate?.dismiss();
    this.projectionDiagnosticOwner_abyssPrivate?.destroy();
    this.projectionDiagnosticOwner_abyssPrivate = null;
    this.navigationBar_abyssPrivate?.destroy();
    this.navigationBar_abyssPrivate = null;
    this.unsubscribe_abyssPrivate?.();
    this.unsubscribe_abyssPrivate = null;
    this.viewInstance_abyssPrivate?.destroy();
    this.viewInstance_abyssPrivate = null;
  }

  destroy(): void {
    this.unmount();
    this.focusRetention_abyssPrivate.cancel();
  }

  cancelKeyboardInteraction(): void {
    this.focusRetention_abyssPrivate.cancel();
  }

  /** A timed block inside the panel received focus. */
  retainTimedBlockFocus(block: HTMLElement): void {
    this.focusRetention_abyssPrivate.retain(block);
  }

  hasPendingTimedBlockFocus(): boolean {
    return this.focusRetention_abyssPrivate.hasPending();
  }

  private renderShell_abyssPrivate(root: HTMLElement): void {
    const forecastMenuOwner =
      this.forecastMenuOwner_abyssPrivate ??
      createForecastContextMenuOwner(
        root.ownerDocument,
        this.deps_abyssPrivate.interactionOwnership,
      );
    this.forecastMenuOwner_abyssPrivate = forecastMenuOwner;
    const projectionDiagnosticOwner = createCalendarProjectionDiagnosticOwner(root.ownerDocument);
    this.projectionDiagnosticOwner_abyssPrivate = projectionDiagnosticOwner;
    // The bar is mounted before the body exists, so it receives the mount through one slot that
    // is filled before any event can fire.
    const pending: { mountView: () => void } = { mountView: () => undefined };
    const navigationBar = this.createNavigationBar_abyssPrivate(root, () => {
      pending.mountView();
    });
    this.navigationBar_abyssPrivate = navigationBar;
    navigationBar.mount(root);
    const viewContainer = root.createDiv({ cls: 'abyss-cal-body' });
    navigationBar.updateTitle();
    const context: CalendarRenderContext = {
      root,
      viewContainer,
      forecastMenuOwner,
      projectionDiagnosticOwner,
      handlers: this.createHandlers_abyssPrivate(viewContainer),
    };
    const mountView = (): void => {
      this.mountView_abyssPrivate(context);
    };
    pending.mountView = mountView;
    mountView();
    this.unsubscribe_abyssPrivate = this.deps_abyssPrivate.queries.subscribe(() => {
      this.patchView_abyssPrivate(context, mountView);
    });
  }

  private createNavigationBar_abyssPrivate(
    root: HTMLElement,
    mountView: () => void,
  ): CalendarNavigationBar {
    const bar = new CalendarNavigationBar({
      owner: root,
      interactionOwnership: this.deps_abyssPrivate.interactionOwnership,
      callbacks: {
        view: () => this.viewType_abyssPrivate,
        date: () => this.date_abyssPrivate,
        onStep: (direction) => {
          this.cancelKeyboardInteraction();
          this.date_abyssPrivate = stepCalendarDate(
            this.viewType_abyssPrivate,
            this.date_abyssPrivate,
            direction,
          );
          bar.updateTitle();
          mountView();
        },
        onToday: () => {
          this.cancelKeyboardInteraction();
          this.date_abyssPrivate = dateForView(this.viewType_abyssPrivate, moment());
          bar.updateTitle();
          mountView();
        },
        onSelectMonth: (month) => {
          this.cancelKeyboardInteraction();
          bar.closePicker(true);
          this.date_abyssPrivate = this.date_abyssPrivate.clone().month(month).date(1);
          bar.updateTitle();
          mountView();
        },
        onSelectYear: (year) => {
          this.cancelKeyboardInteraction();
          bar.closePicker(true);
          this.date_abyssPrivate = this.date_abyssPrivate.clone().year(year).date(1);
          bar.updateTitle();
          mountView();
        },
        onSelectView: (view, trigger) => {
          const doc = trigger.ownerDocument;
          const held = doc.activeElement === trigger;
          this.deps_abyssPrivate.navigation.openCalendarView(view);
          if (
            held &&
            (doc.activeElement === trigger ||
              doc.activeElement === doc.body ||
              doc.activeElement === doc.documentElement)
          )
            this.navigationBar_abyssPrivate?.focusView(view);
        },
      },
    });
    return bar;
  }

  private mountView_abyssPrivate(context: CalendarRenderContext): void {
    this.prepareViewUpdate_abyssPrivate(context);
    this.deps_abyssPrivate.host.unmountActiveCapture();
    const renderGeneration = this.focusRetention_abyssPrivate.beginRender();
    const grid = context.viewContainer.querySelector<HTMLElement>('.abyss-tg-grid-row');
    const preservedScrollTop = grid?.scrollTop ?? this.pendingScrollTop_abyssPrivate;
    this.pendingScrollTop_abyssPrivate = undefined;
    this.viewInstance_abyssPrivate?.destroy();
    context.viewContainer.empty();
    const { config, issues, tasks } = this.content_abyssPrivate();
    // A rebuilt grid with no position to restore would start at midnight, so it scrolls to now
    // even when this (view, date) pair was visited before. Only a same-date refresh that keeps its
    // position skips the scroll. The key check stays on the left so every mount records its key.
    const shouldScrollToNow =
      this.shouldScrollToNow_abyssPrivate() || preservedScrollTop === undefined;
    const view = createCalendarView(
      this.viewType_abyssPrivate,
      this.viewDependencies_abyssPrivate(context.forecastMenuOwner),
      context.handlers,
      {
        openDay: (date) => {
          this.openDay_abyssPrivate(date);
        },
        openWeek: (week, year) => {
          this.openWeek_abyssPrivate(week, year);
        },
      },
    );
    this.viewInstance_abyssPrivate = view;
    view.render(context.viewContainer, tasks, config, shouldScrollToNow, preservedScrollTop);
    this.finishViewUpdate_abyssPrivate(context, issues, renderGeneration);
  }

  private patchView_abyssPrivate(context: CalendarRenderContext, mountView: () => void): void {
    if (this.viewInstance_abyssPrivate == null) {
      mountView();
      return;
    }
    this.prepareViewUpdate_abyssPrivate(context);
    const renderGeneration = this.focusRetention_abyssPrivate.beginRender();
    const { config, issues, tasks } = this.content_abyssPrivate();
    this.deps_abyssPrivate.host.unmountActiveCapture();
    this.viewInstance_abyssPrivate.patch(context.viewContainer, tasks, config);
    this.finishViewUpdate_abyssPrivate(context, issues, renderGeneration);
  }

  private prepareViewUpdate_abyssPrivate(context: CalendarRenderContext): void {
    this.deps_abyssPrivate.host.dismissRecurrenceEditor();
    context.forecastMenuOwner.dismiss();
    this.focusRetention_abyssPrivate.captureActiveFocus(context.root);
    this.focusRetention_abyssPrivate.beforeViewUpdate();
  }

  private finishViewUpdate_abyssPrivate(
    context: CalendarRenderContext,
    issues: readonly CalendarProjectionIssue[],
    renderGeneration: number,
  ): void {
    context.projectionDiagnosticOwner.update(context.viewContainer, issues);
    const { host } = this.deps_abyssPrivate;
    host.remountActiveCapture();
    host.syncTaskStackSelection();
    host.onRenderComplete(context.viewContainer);
    this.focusRetention_abyssPrivate.deferFocus(context.viewContainer, renderGeneration);
  }

  private viewDependencies_abyssPrivate(
    forecastMenuOwner: ForecastContextMenuOwner,
  ): CalendarViewDependencies {
    const { app, statusRegistry, interactionOwnership, host } = this.deps_abyssPrivate;
    return {
      app,
      statusRegistry,
      interactionOwnership,
      dependenciesFor: host.dependenciesFor,
      tagGroups: host.tagGroups,
      forecastMenuOwner,
    };
  }

  private content_abyssPrivate(): CalendarContent {
    return calendarContent({
      queries: this.deps_abyssPrivate.queries,
      settings: this.deps_abyssPrivate.settings,
      view: this.viewType_abyssPrivate,
      date: this.date_abyssPrivate,
    });
  }

  private shouldScrollToNow_abyssPrivate(): boolean {
    const key = calendarScrollKey(this.viewType_abyssPrivate, this.date_abyssPrivate);
    const shouldScroll = key !== this.lastScrolledKey_abyssPrivate;
    this.lastScrolledKey_abyssPrivate = key;
    return shouldScroll;
  }

  private openDay_abyssPrivate(date: string): void {
    this.cancelKeyboardInteraction();
    this.viewType_abyssPrivate = 'today';
    this.date_abyssPrivate = moment(date);
    this.deps_abyssPrivate.host.rerender();
  }

  private openWeek_abyssPrivate(week: string, year: string): void {
    this.cancelKeyboardInteraction();
    this.viewType_abyssPrivate = 'week';
    this.date_abyssPrivate = isoWeekStart(week, year, moment());
    this.deps_abyssPrivate.host.rerender();
  }

  private followShiftedTask_abyssPrivate(
    updated: TaskSnapshot,
    nextSegmentDate: string | undefined,
  ): void {
    const anchor =
      updated.planning.start != null && updated.planning.due != null
        ? updated.planning.due
        : (updated.planning.scheduled ?? updated.planning.due);
    const followDate = nextSegmentDate ?? anchor;
    if (followDate === undefined || followDate === '') return;
    const firstDayOfWeek = this.deps_abyssPrivate.settings.firstDayOfWeek;
    const outsideWeek = !visibleCalendarDates(
      'week',
      this.date_abyssPrivate,
      firstDayOfWeek,
    ).includes(followDate);
    if (
      this.viewType_abyssPrivate !== 'today' &&
      (this.viewType_abyssPrivate !== 'week' || !outsideWeek)
    )
      return;
    this.date_abyssPrivate = moment(followDate);
    this.deps_abyssPrivate.host.rerender();
  }

  private createSelectionAndCaptureHandlers_abyssPrivate(
    viewContainer: HTMLElement,
  ): Pick<
    CalendarHandlers,
    | 'onTaskClick'
    | 'onTaskSelect'
    | 'onShowParent'
    | 'onForecastClick'
    | 'onForecastContextMenu'
    | 'onNativeDragStart'
    | 'onDrop'
    | 'onDropTime'
    | 'onCreateAtTime'
    | 'onCreateAtDate'
    | 'onCreateAtDateAllDay'
  > {
    const { state, host } = this.deps_abyssPrivate;
    return {
      onShowParent: host.onShowParent,
      onTaskClick: (task) => {
        const occurrence = calendarOccurrenceForTask(task);
        if (occurrence?.kind === 'forecast') return;
        if (occurrence === undefined) {
          host.openTask(task);
          return;
        }
        if (taskSelectionPath(occurrence.source.root, occurrence.source.node) !== undefined)
          host.openTask(occurrence.source.root, occurrence.source.target);
      },
      onTaskSelect: (task) => {
        const occurrence = calendarOccurrenceForTask(task);
        if (occurrence?.kind === 'forecast') return;
        if (occurrence == null) {
          state.set('taskStack', [task]);
          return;
        }
        const path = taskSelectionPath(occurrence.source.root, occurrence.source.node);
        if (path !== undefined) state.set('taskStack', path);
      },
      onForecastClick: (source, referenceDate) => {
        host.openForecastTask(source, referenceDate);
      },
      onForecastContextMenu: (source, _referenceDate, anchor) => {
        host.openForecastRecurrenceEditor(anchor, source);
      },
      onNativeDragStart: (task, source) => {
        const payload = calendarNativeDragPayload(task);
        if (payload?.source !== 'center-card' || payload.calendar === undefined) return undefined;
        startTaskNodeDrag(state, viewContainer, source, {
          payload,
          onEnd: () => {
            source.removeClass('is-dragging');
          },
        });
        return state.get('draggingTaskNode') === null ? undefined : payload.calendar.nativePayload;
      },
      onDrop: (dragData, targetDate) => {
        runAsyncAction(this.commands_abyssPrivate.rescheduleFromDrag(dragData, targetDate));
      },
      onDropTime: (dragData, date, time) => {
        runAsyncAction(this.commands_abyssPrivate.setTimeFromDrag(dragData, date, time));
      },
      onCreateAtTime: (date, time) => {
        this.createTaskAtTime_abyssPrivate(viewContainer, date, time);
      },
      onCreateAtDate: (date) => {
        this.createTaskAtDate_abyssPrivate(viewContainer, date, false);
      },
      onCreateAtDateAllDay: (date) => {
        this.createTaskAtDate_abyssPrivate(viewContainer, date, true);
      },
    };
  }

  private createHandlers_abyssPrivate(viewContainer: HTMLElement): CalendarHandlers {
    const commands = this.commands_abyssPrivate;
    const { host } = this.deps_abyssPrivate;
    return {
      ...this.createSelectionAndCaptureHandlers_abyssPrivate(viewContainer),
      onTimeChange: (task, minutes) => {
        this.runTaskAction_abyssPrivate(task, () => commands.setTime(task, minutes));
      },
      onDurationChange: (task, minutes) => {
        this.runTaskAction_abyssPrivate(task, () => commands.setDuration(task, minutes));
      },
      onTimedMove: (task, target) => {
        this.runTaskAction_abyssPrivate(task, () => commands.commitTimedMove(task, target));
      },
      onTimedDuration: (task, target) => {
        this.runTaskAction_abyssPrivate(task, () => commands.commitTimedDuration(task, target));
      },
      onTimedBoundary: (task, target) => {
        this.runTaskAction_abyssPrivate(task, () => commands.commitTimedBoundary(task, target));
      },
      onSpanMove: (task, target) => {
        this.runTaskAction_abyssPrivate(task, () => commands.commitSpanMove(task, target));
      },
      onSpanBoundary: (task, target) => {
        this.runTaskAction_abyssPrivate(task, () => commands.commitTimedBoundary(task, target));
      },
      onStartChange: (task, start) => {
        this.runTaskAction_abyssPrivate(task, () => commands.setStart(task, start));
      },
      onDueChange: (task, due) => {
        this.runTaskAction_abyssPrivate(task, () => commands.setDue(task, due));
      },
      onExtendToSpan: (task, due) => {
        this.runTaskAction_abyssPrivate(task, () => commands.extendToSpan(task, due));
      },
      onKeyboardIntent: (task, intent) => {
        this.focusRetention_abyssPrivate.handleIntent(task, intent);
      },
      onToggle: (task) => {
        runAsyncAction(host.toggleTask(task));
      },
      onSetStatus: (task, status) => {
        runAsyncAction(host.setTaskStatus(task, status));
      },
      onSetPriority: (task, priority) => {
        runAsyncAction(host.setPriority(task, priority));
      },
    };
  }

  private runTaskAction_abyssPrivate(task: TaskSnapshot, action: () => Promise<void>): void {
    if (isForecastCalendarTask(task)) return;
    runAsyncAction(action());
  }

  private createTaskAtTime_abyssPrivate(container: HTMLElement, date: string, time: string): void {
    const day = container.querySelector<HTMLElement>(
      `.abyss-tg-day-column[data-tg-date="${date}"]`,
    );
    const hourColumn = day?.querySelector<HTMLElement>('.abyss-tg-hour-column');
    if (hourColumn != null) {
      this.deps_abyssPrivate.host.openCapture({ type: 'calendar-timed', date, time });
    }
  }

  private createTaskAtDate_abyssPrivate(
    container: HTMLElement,
    date: string,
    allDay: boolean,
  ): void {
    const selector = allDay
      ? `.abyss-tg-allday-cell[data-tg-date="${date}"]`
      : `[data-mg-date="${date}"]`;
    const cell = container.querySelector<HTMLElement>(selector);
    if (cell == null) return;
    const placement: CalendarCapturePlacement = allDay
      ? { type: 'calendar-all-day', date }
      : { type: 'calendar-month', date };
    this.deps_abyssPrivate.host.openCapture(placement);
  }
}
