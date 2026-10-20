import type { App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import type { CalendarSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import {
  localDate,
  type LocalDate,
  type TaskApplicationApi,
  type TaskNodeRef,
  type TaskPriority,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../../tasks';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import type { TaskDependencyLookup } from '../../ui/taskDependencyPresentation';
import { startTaskNodeDrag } from '../../ui/taskNodeDrag';
import { taskSelectionPath } from '../../ui/taskSelection';
import type { MountCalendarAgendaEntry } from '../../views/ConstrainedCalendarView';
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
  stepCalendarDate,
  type CalendarMoment,
} from './calendarDateNavigation';
import { CalendarPublicationHold } from './calendarPublicationHold';
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
  readonly mountAgendaEntry: MountCalendarAgendaEntry;
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
}

/**
 * The calendar mode of the centre panel: the session's date and view type, the mounted view and
 * its patch subscription, the navigation bar, and the keyboard focus retention. It renders into the
 * panel element it is given and reaches `CenterPanel` only through {@link CalendarModeHost}; it
 * shares the `AppState` and the panel navigation port with the shell.
 */
export class CalendarMode {
  private selectedDate_abyssPrivate: LocalDate | undefined;
  private constrained_abyssPrivate = false;
  private stopWidthObservation_abyssPrivate: (() => void) | undefined;
  private contentCache_abyssPrivate: CalendarContent | undefined;
  private viewType_abyssPrivate: CalViewType = 'month';
  private date_abyssPrivate: CalendarMoment = moment().date(1);
  private viewInstance_abyssPrivate: CalendarViewInstance | null = null;
  private pendingFollowDate_abyssPrivate: string | undefined;
  private publicationHold_abyssPrivate: CalendarPublicationHold | undefined;
  private unsubscribe_abyssPrivate: (() => void) | null = null;
  private forecastOwnerDocument_abyssPrivate: Document | undefined;
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
      holdPublication: () =>
        this.publicationHold_abyssPrivate?.holdKeyboardPublication() ?? (() => {}),
      follow: (updated, nextSegmentDate) => {
        this.followShiftedTask_abyssPrivate(updated, nextSegmentDate);
      },
    });
  }

  view(): CalViewType {
    return this.viewType_abyssPrivate;
  }

  captureDate(): LocalDate | undefined {
    if (this.viewType_abyssPrivate === 'today')
      return localDate(this.date_abyssPrivate.format('YYYY-MM-DD'));
    return this.constrained_abyssPrivate ? this.selectedDate_abyssPrivate : undefined;
  }

  /** Selects a view and its policy date without rendering; the navigator triggers the render. */
  setView(view: CalViewType): void {
    if (view === this.viewType_abyssPrivate) return;
    this.viewType_abyssPrivate = view;
    this.date_abyssPrivate = dateForView(view, moment(this.selectedDate_abyssPrivate));
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
    this.pendingFollowDate_abyssPrivate = undefined;
    this.publicationHold_abyssPrivate?.dispose();
    this.publicationHold_abyssPrivate = undefined;
    this.stopWidthObservation_abyssPrivate?.();
    this.stopWidthObservation_abyssPrivate = undefined;
    this.contentCache_abyssPrivate = undefined;
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
    this.pendingFollowDate_abyssPrivate = undefined;
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
    if (this.forecastOwnerDocument_abyssPrivate !== root.ownerDocument) {
      this.forecastMenuOwner_abyssPrivate?.dismiss({ restoreFocus: false });
      this.forecastMenuOwner_abyssPrivate = null;
      this.forecastOwnerDocument_abyssPrivate = root.ownerDocument;
    }
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
    };
    const mountView = (): void => {
      this.mountView_abyssPrivate(context);
    };
    pending.mountView = mountView;
    this.observeWidth_abyssPrivate(root, context);
    mountView();
    this.unsubscribe_abyssPrivate = this.deps_abyssPrivate.queries.subscribe(() => {
      this.contentCache_abyssPrivate = undefined;
      this.publicationHold_abyssPrivate?.request();
    });
  }

  private resolveSelectedDate_abyssPrivate(): LocalDate[] {
    const dates = visibleCalendarDates(
      this.viewType_abyssPrivate,
      this.date_abyssPrivate,
      this.deps_abyssPrivate.settings.firstDayOfWeek,
    ).map(localDate);
    if (
      this.selectedDate_abyssPrivate === undefined ||
      !dates.includes(this.selectedDate_abyssPrivate)
    ) {
      const today = localDate(moment().format('YYYY-MM-DD'));
      const primary =
        this.viewType_abyssPrivate === 'month'
          ? dates.filter((date) => date.startsWith(this.date_abyssPrivate.format('YYYY-MM')))
          : dates;
      this.selectedDate_abyssPrivate = primary.includes(today) ? today : primary[0];
    }
    return dates;
  }

  private selectDate_abyssPrivate(date: LocalDate): void {
    if (this.selectedDate_abyssPrivate === date) return;
    this.selectedDate_abyssPrivate = date;
    const host = this.deps_abyssPrivate.host;
    host.dismissRecurrenceEditor();
    host.unmountActiveCapture();
    this.viewInstance_abyssPrivate?.selectDate?.(date);
    host.remountActiveCapture();
    host.syncTaskStackSelection();
  }

  private observeWidth_abyssPrivate(root: HTMLElement, context: CalendarRenderContext): void {
    const owner = root.ownerDocument.defaultView;
    if (owner === null) {
      this.constrained_abyssPrivate = false;
      return;
    }
    const classify = (): boolean => {
      const width = root.getBoundingClientRect().width;
      const measuredRem = Number.parseFloat(
        owner.getComputedStyle(root.ownerDocument.documentElement).fontSize,
      );
      const rem = Number.isFinite(measuredRem) && measuredRem > 0 ? measuredRem : 16;
      return width > 0
        ? width <= 38 * rem
        : root.ownerDocument.body.matches('.is-mobile, .is-phone');
    };
    this.constrained_abyssPrivate = classify();
    let disposed = false;
    let frame: number | undefined;
    const schedule = (): void => {
      if (disposed || frame !== undefined) return;
      frame = owner.requestAnimationFrame(() => {
        frame = undefined;
        if (disposed) return;
        const constrained = classify();
        if (constrained === this.constrained_abyssPrivate) return;
        this.constrained_abyssPrivate = constrained;
        if (this.viewType_abyssPrivate !== 'today')
          this.mountView_abyssPrivate(context, this.contentCache_abyssPrivate);
      });
    };
    const Observer = owner.ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(schedule) : undefined;
    observer?.observe(root);
    owner.addEventListener('resize', schedule);
    this.stopWidthObservation_abyssPrivate = () => {
      disposed = true;
      observer?.disconnect();
      owner.removeEventListener('resize', schedule);
      if (frame !== undefined) owner.cancelAnimationFrame(frame);
    };
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
        firstDayOfWeek: () => this.deps_abyssPrivate.settings.firstDayOfWeek,
        onStep: (direction) => {
          this.cancelKeyboardInteraction();
          this.date_abyssPrivate = stepCalendarDate(
            this.viewType_abyssPrivate,
            this.date_abyssPrivate,
            direction,
          );
          this.selectedDate_abyssPrivate = undefined;
          bar.updateTitle();
          mountView();
        },
        onToday: () => {
          this.cancelKeyboardInteraction();
          this.date_abyssPrivate = dateForView(this.viewType_abyssPrivate, moment());
          this.selectedDate_abyssPrivate = localDate(moment().format('YYYY-MM-DD'));
          bar.updateTitle();
          mountView();
        },
        onSelectMonth: (month) => {
          this.cancelKeyboardInteraction();
          bar.closePicker(true);
          this.date_abyssPrivate = this.date_abyssPrivate.clone().month(month).date(1);
          this.selectedDate_abyssPrivate = undefined;
          bar.updateTitle();
          mountView();
        },
        onSelectYear: (year) => {
          this.cancelKeyboardInteraction();
          bar.closePicker(true);
          this.date_abyssPrivate = this.date_abyssPrivate.clone().year(year).date(1);
          this.selectedDate_abyssPrivate = undefined;
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

  private mountView_abyssPrivate(
    context: CalendarRenderContext,
    retainedContent?: CalendarContent,
  ): void {
    this.publicationHold_abyssPrivate?.dispose();
    this.pendingFollowDate_abyssPrivate = undefined;
    this.prepareViewUpdate_abyssPrivate(context);
    this.deps_abyssPrivate.host.unmountActiveCapture();
    const renderGeneration = this.focusRetention_abyssPrivate.beginRender();
    const grid = context.viewContainer.querySelector<HTMLElement>('.abyss-tg-grid-row');
    const preservedScrollTop = grid?.scrollTop ?? this.pendingScrollTop_abyssPrivate;
    this.pendingScrollTop_abyssPrivate = undefined;
    this.viewInstance_abyssPrivate?.destroy();
    context.viewContainer.empty();
    const content = retainedContent ?? this.content_abyssPrivate();
    this.contentCache_abyssPrivate = content;
    const { config, issues, occurrences } = content;
    const dates = this.resolveSelectedDate_abyssPrivate();
    // A rebuilt grid with no position to restore would start at midnight, so it scrolls to now
    // even when this (view, date) pair was visited before. Only a same-date refresh that keeps its
    // position skips the scroll. The key check stays on the left so every mount records its key.
    const shouldScrollToNow =
      this.shouldScrollToNow_abyssPrivate() || preservedScrollTop === undefined;
    const compactView =
      this.constrained_abyssPrivate && this.viewType_abyssPrivate !== 'today'
        ? this.viewType_abyssPrivate
        : undefined;
    context.viewContainer.toggleClass('abyss-cal-body--compact', compactView !== undefined);
    const publicationHold = new CalendarPublicationHold(context.viewContainer, () => {
      const followDate = this.pendingFollowDate_abyssPrivate;
      if (followDate !== undefined) {
        this.pendingFollowDate_abyssPrivate = undefined;
        this.date_abyssPrivate = moment(followDate);
        this.deps_abyssPrivate.host.rerender();
        return;
      }
      this.patchView_abyssPrivate(context, () => {
        this.mountView_abyssPrivate(context);
      });
    });
    this.publicationHold_abyssPrivate = publicationHold;
    const view = createCalendarView(
      this.viewType_abyssPrivate,
      this.viewDependencies_abyssPrivate(context.forecastMenuOwner, publicationHold),
      this.createHandlers_abyssPrivate(context.viewContainer, publicationHold),
      {
        openDay: (date) => {
          this.openDay_abyssPrivate(date);
        },
        openWeek: (date) => {
          this.openWeek_abyssPrivate(date);
        },
      },
      compactView !== undefined
        ? {
            view: compactView,
            dates,
            selectedDate: () =>
              this.selectedDate_abyssPrivate ??
              localDate(this.date_abyssPrivate.format('YYYY-MM-DD')),
            onSelectDate: (date) => {
              this.selectDate_abyssPrivate(date);
            },
          }
        : undefined,
    );
    this.viewInstance_abyssPrivate = view;
    view.render(context.viewContainer, occurrences, config, shouldScrollToNow, preservedScrollTop);
    this.finishViewUpdate_abyssPrivate(context, issues, renderGeneration);
  }

  private patchView_abyssPrivate(context: CalendarRenderContext, mountView: () => void): void {
    if (this.viewInstance_abyssPrivate == null) {
      mountView();
      return;
    }
    this.prepareViewUpdate_abyssPrivate(context);
    const renderGeneration = this.focusRetention_abyssPrivate.beginRender();
    const content = this.content_abyssPrivate();
    this.contentCache_abyssPrivate = content;
    const { config, issues, occurrences } = content;
    this.deps_abyssPrivate.host.unmountActiveCapture();
    this.viewInstance_abyssPrivate.patch(context.viewContainer, occurrences, config);
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
    publicationHold: CalendarPublicationHold,
  ): CalendarViewDependencies {
    const { app, statusRegistry, interactionOwnership, host } = this.deps_abyssPrivate;
    return {
      app,
      statusRegistry,
      interactionOwnership: publicationHold.ownership(interactionOwnership),
      dependenciesFor: host.dependenciesFor,
      mountAgendaEntry: host.mountAgendaEntry,
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
    return shouldScroll && !this.focusRetention_abyssPrivate.hasPending();
  }

  private openDay_abyssPrivate(date: string): void {
    this.cancelKeyboardInteraction();
    this.viewType_abyssPrivate = 'today';
    this.date_abyssPrivate = moment(date);
    this.selectedDate_abyssPrivate = localDate(date);
    this.deps_abyssPrivate.host.rerender();
  }

  private openWeek_abyssPrivate(date: string): void {
    this.cancelKeyboardInteraction();
    this.viewType_abyssPrivate = 'week';
    this.date_abyssPrivate = moment(date);
    this.selectedDate_abyssPrivate = localDate(date);
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
    if (followDate === undefined) return;
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
    this.pendingFollowDate_abyssPrivate = followDate;
    this.publicationHold_abyssPrivate?.request();
  }

  private createSelectionAndCaptureHandlers_abyssPrivate(
    viewContainer: HTMLElement,
    publicationHold: CalendarPublicationHold,
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
    const commands = this.commands_abyssPrivate;
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
        runAsyncAction(
          publicationHold.run(() => commands.rescheduleFromDrag(dragData, targetDate)),
        );
      },
      onDropTime: (dragData, date, time) => {
        runAsyncAction(publicationHold.run(() => commands.setTimeFromDrag(dragData, date, time)));
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

  private createHandlers_abyssPrivate(
    viewContainer: HTMLElement,
    publicationHold: CalendarPublicationHold,
  ): CalendarHandlers {
    const commands = this.commands_abyssPrivate;
    const { host } = this.deps_abyssPrivate;
    return {
      ...this.createSelectionAndCaptureHandlers_abyssPrivate(viewContainer, publicationHold),
      onTimeChange: (task, minutes) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.setTime(current, minutes),
        );
      },
      onDurationChange: (task, minutes) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.setDuration(current, minutes),
        );
      },
      onTimedMove: (task, target) => {
        return this.runTaskAction_abyssPrivate(
          publicationHold,
          task,
          (current) => commands.commitTimedMove(current, target, task),
          true,
        );
      },
      onTimedDuration: (task, target) => {
        return this.runTaskAction_abyssPrivate(
          publicationHold,
          task,
          (current) => commands.commitTimedDuration(current, target, task),
          true,
        );
      },
      onTimedBoundary: (task, target) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.commitTimedBoundary(current, target),
        );
      },
      onSpanMove: (task, target) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.commitSpanMove(current, target),
        );
      },
      onSpanBoundary: (task, target) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.commitTimedBoundary(current, target),
        );
      },
      onStartChange: (task, start) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.setStart(current, start),
        );
      },
      onDueChange: (task, due) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.setDue(current, due),
        );
      },
      onExtendToSpan: (task, due) => {
        return this.runTaskAction_abyssPrivate(publicationHold, task, (current) =>
          commands.extendToSpan(current, due),
        );
      },
      onKeyboardIntent: (task, intent) => {
        this.focusRetention_abyssPrivate.handleIntent(task, intent);
      },
      onToggle: (task) => {
        runAsyncAction(publicationHold.run(() => host.toggleTask(task)));
      },
      onSetStatus: (task, status) => {
        runAsyncAction(publicationHold.run(() => host.setTaskStatus(task, status)));
      },
      onSetPriority: (task, priority) => {
        runAsyncAction(publicationHold.run(() => host.setPriority(task, priority)));
      },
    };
  }

  private runTaskAction_abyssPrivate(
    publicationHold: CalendarPublicationHold,
    task: TaskSnapshot,
    action: (current: TaskSnapshot) => Promise<void>,
    seriesTiming = false,
  ): Promise<void> {
    const forecast = isForecastCalendarTask(task);
    if (forecast && !seriesTiming) return Promise.resolve();
    const apply = (current: TaskSnapshot): Promise<void> => {
      // A submitted pointer gesture owns navigation; cancellation leaves keyboard following intact.
      if (this.publicationHold_abyssPrivate === publicationHold)
        this.pendingFollowDate_abyssPrivate = undefined;
      return action(current);
    };
    return publicationHold.run(() => {
      const current = this.focusRetention_abyssPrivate.settlePointerTask(task);
      return current instanceof Promise ? current.then(apply) : apply(current);
    });
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
    if (container.querySelector(`.abyss-calendar-agenda[data-calendar-date="${date}"]`) !== null) {
      this.deps_abyssPrivate.host.openCapture({ type: 'calendar-agenda', date });
      return;
    }
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
