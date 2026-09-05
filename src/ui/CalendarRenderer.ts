import { Modal, type App } from 'obsidian';
import { firstVisibleWeekDate, resolveWeekStartPosition } from '../domain/weekGridOffset';
import { visibleCalendarDates } from '../panels/visibleCalendarDates';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import {
  localDate,
  type CommentTimeContextProvider,
  type LocalDate,
  type RecurrencePolicy,
  type TaskApplicationApi,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../tasks';
import { type BaseView } from '../views/BaseView';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  calendarPatchCommand,
  calendarSourcePatchCommand,
  hasOtherCalendarRecurrenceOwner,
  isForecastCalendarTask,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarTaskSource,
} from '../views/calendarOccurrences';
import { ListView } from '../views/ListView';
import { MonthView } from '../views/MonthView';
import {
  createCalendarProjectionDiagnosticOwner,
  createForecastContextMenuOwner,
  type CalendarProjectionDiagnosticOwner,
  type ForecastContextMenuOwner,
} from '../views/timegrid/renderTaskMeta';
import { WeekView } from '../views/WeekView';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { mountAnchoredRecurrenceEditor } from './recurrence/RecurrenceEditor';
import { runAsyncAction } from './runAsyncAction';
import { showStatusMenuAt } from './statusMenu';
import {
  presentTaskCommandResult,
  presentTaskCreationResult,
  requestTaskCompletion,
} from './taskCommandResult';
import type { TaskDependencyLookup } from './taskDependencyPresentation';
import { TaskModal } from './TaskModal';
import { openInFile } from './taskNavigation';
import { Toolbar, type ViewEntry } from './Toolbar';

const VIEWS: ViewEntry[] = [
  { id: 'list', icon: '', label: 'List' },
  { id: 'month', icon: '', label: 'Month' },
  { id: 'week', icon: '', label: 'Week' },
];

type ActiveView = 'month' | 'week' | 'list';

interface CalendarCallbacks {
  readonly onToggle: (task: TaskSnapshot) => void;
  readonly onCellClick: (date: string) => void;
  readonly onWeekClick: (weekNumber: string, year: string) => void;
  readonly onDateClick: (date: string) => void;
  readonly onTaskBodyContextMenu: (
    event: MouseEvent,
    task: TaskSnapshot,
    anchor: HTMLElement,
  ) => void;
  readonly onContextMenu: (event: MouseEvent, task: TaskSnapshot) => void;
}

export class CalendarRenderer {
  private readonly completionConfirmationAbortController_abyssPrivate = new AbortController();
  private toolbar_abyssPrivate: Toolbar | null = null;
  private activeView_abyssPrivate: BaseView | null = null;
  private activeViewType_abyssPrivate: ActiveView;
  private viewContainer_abyssPrivate: HTMLElement | null = null;
  private selectedDate_abyssPrivate: ReturnType<typeof window.moment>;
  private filterActive_abyssPrivate = false;
  private overdueHighlightActive_abyssPrivate = false;
  private projectionIssues_abyssPrivate: readonly CalendarProjectionIssue[] = [];
  private activeStatGroup_abyssPrivate: string | null = null;
  private unsubscribe_abyssPrivate: (() => void) | null = null;
  private recurrenceEditorCleanup_abyssPrivate: (() => void) | null = null;
  private statusMenuCleanup_abyssPrivate: (() => void) | null = null;
  private readonly projectionDiagnosticOwner_abyssPrivate: CalendarProjectionDiagnosticOwner;
  private readonly forecastMenuOwner_abyssPrivate: ForecastContextMenuOwner;
  private readonly taskModal_abyssPrivate: TaskModal;
  private taskInputModal_abyssPrivate: TaskInputModal | null = null;
  private readonly rootEl_abyssPrivate: HTMLElement;
  private config_abyssPrivate: ResolvedConfig;
  private readonly app_abyssPrivate: App;
  private readonly queries_abyssPrivate: TaskQueryApi;
  private readonly tasks_abyssPrivate: TaskApplicationApi;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly taskPrefix_abyssPrivate: string;
  private readonly recurrencePolicy_abyssPrivate: RecurrencePolicy;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;

  constructor(
    ...args: [
      rootEl: HTMLElement,
      config: ResolvedConfig,
      app: App,
      queries: TaskQueryApi,
      tasks: TaskApplicationApi,
      statusRegistry: StatusRegistry,
      taskPrefix?: string,
      recurrencePolicy?: RecurrencePolicy,
      commentTimeContext?: CommentTimeContextProvider,
      interactionOwnership?: InteractionOwnershipPort,
    ]
  ) {
    const [
      rootEl,
      config,
      app,
      queries,
      tasks,
      statusRegistry,
      taskPrefix = '',
      recurrencePolicy = { removeScheduledDate: false },
      commentTimeContext,
      interactionOwnership = noInteractionOwnership,
    ] = args;
    this.rootEl_abyssPrivate = rootEl;
    this.config_abyssPrivate = config;
    this.app_abyssPrivate = app;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.taskPrefix_abyssPrivate = taskPrefix;
    this.recurrencePolicy_abyssPrivate = recurrencePolicy;
    this.interactionOwnership_abyssPrivate = interactionOwnership;
    this.projectionDiagnosticOwner_abyssPrivate = createCalendarProjectionDiagnosticOwner(
      rootEl.ownerDocument,
    );
    this.forecastMenuOwner_abyssPrivate = createForecastContextMenuOwner(
      rootEl.ownerDocument,
      interactionOwnership,
    );
    this.taskModal_abyssPrivate = new TaskModal(
      app,
      statusRegistry,
      undefined,
      queries,
      tasks,
      commentTimeContext,
      interactionOwnership,
    );
    this.activeViewType_abyssPrivate = config.defaultView;
    if (this.activeViewType_abyssPrivate === 'week') {
      this.selectedDate_abyssPrivate = resolveWeekStartPosition(
        config.startPosition,
        config.firstDayOfWeek,
        window.moment(),
      );
    } else {
      this.selectedDate_abyssPrivate =
        config.startPosition.length > 0
          ? window.moment(config.startPosition, 'YYYY-MM').date(1)
          : window.moment().date(1);
    }
  }

  mount(): void {
    this.rootEl_abyssPrivate.setAttribute('view', this.activeViewType_abyssPrivate);
    if (this.config_abyssPrivate.style.length > 0) {
      this.rootEl_abyssPrivate.addClass(this.config_abyssPrivate.style);
    }

    // Wrap everything in a span (matches existing CSS selectors)
    const span = this.rootEl_abyssPrivate.createSpan();

    this.toolbar_abyssPrivate = new Toolbar(span, VIEWS, {
      onPrev: () => {
        this.navigate_abyssPrivate(-1);
      },
      onNext: () => {
        this.navigate_abyssPrivate(1);
      },
      onToday: () => {
        this.goToday_abyssPrivate();
      },
      onViewSwitch: (id) => {
        this.switchView_abyssPrivate(id as ActiveView);
      },
      onFilterToggle: () => {
        this.filterActive_abyssPrivate = !this.filterActive_abyssPrivate;
        this.rootEl_abyssPrivate.classList.toggle('filter', this.filterActive_abyssPrivate);
        this.updateToolbar_abyssPrivate();
      },
      onOverdueHighlight: () => {
        this.overdueHighlightActive_abyssPrivate = !this.overdueHighlightActive_abyssPrivate;
        this.updateToolbar_abyssPrivate();
      },
      onStatFilter: (group) => {
        this.activeStatGroup_abyssPrivate = group;
        this.applyStatFilter_abyssPrivate(group);
      },
      onStyleChange: (style) => {
        if (this.config_abyssPrivate.style.length > 0) {
          this.rootEl_abyssPrivate.removeClass(this.config_abyssPrivate.style);
        }
        this.config_abyssPrivate = { ...this.config_abyssPrivate, style };
        this.rootEl_abyssPrivate.addClass(style);
        this.updateToolbar_abyssPrivate();
      },
    });

    this.viewContainer_abyssPrivate = span.createDiv();
    this.renderView_abyssPrivate();

    this.unsubscribe_abyssPrivate = this.queries_abyssPrivate.subscribe(() => {
      this.dismissStatusMenu_abyssPrivate();
      this.forecastMenuOwner_abyssPrivate.dismiss();
      this.dismissRecurrenceEditor_abyssPrivate();
      const tasks = this.calendarTasks_abyssPrivate();
      const viewContainer = this.viewContainer_abyssPrivate;
      if (viewContainer === null) return;
      this.activeView_abyssPrivate?.patch(viewContainer, tasks, this.buildConfig_abyssPrivate());
      this.projectionDiagnosticOwner_abyssPrivate.update(
        viewContainer,
        this.projectionIssues_abyssPrivate,
      );
      this.updateToolbar_abyssPrivate();
    });
  }

  private navigate_abyssPrivate(dir: -1 | 1): void {
    if (
      this.activeViewType_abyssPrivate === 'month' ||
      this.activeViewType_abyssPrivate === 'list'
    ) {
      this.selectedDate_abyssPrivate = window
        .moment(this.selectedDate_abyssPrivate)
        .add(dir, 'months');
    } else {
      this.selectedDate_abyssPrivate = window
        .moment(this.selectedDate_abyssPrivate)
        .add(dir * 7, 'days');
    }
    this.renderView_abyssPrivate();
  }

  private goToday_abyssPrivate(): void {
    if (this.activeViewType_abyssPrivate === 'week') {
      this.selectedDate_abyssPrivate = window.moment();
    } else {
      this.selectedDate_abyssPrivate = window.moment().date(1);
    }
    this.renderView_abyssPrivate();
  }

  private switchView_abyssPrivate(type: ActiveView): void {
    if (this.activeViewType_abyssPrivate === type) return;
    this.dismissStatusMenu_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.activeViewType_abyssPrivate = type;
    this.rootEl_abyssPrivate.setAttribute('view', type);
    this.activeView_abyssPrivate?.destroy();
    this.activeView_abyssPrivate = null;
    this.renderView_abyssPrivate();
  }

  private buildCallbacks_abyssPrivate(): CalendarCallbacks {
    return {
      onToggle: (task) => {
        this.toggleCalendarTask_abyssPrivate(task);
      },
      onCellClick: (date: string) => {
        this.openAddTaskModal_abyssPrivate(date);
      },
      onWeekClick: (weekNr: string, year: string) => {
        this.openWeek_abyssPrivate(weekNr, year);
      },
      onDateClick: (date: string) => {
        this.openAddTaskModal_abyssPrivate(date);
      },
      onTaskBodyContextMenu: (_event, task, anchor) => {
        if (isForecastCalendarTask(task)) return;
        this.openRecurrenceEditor_abyssPrivate(anchor, task);
      },
      onContextMenu: (event, task) => {
        this.openTaskStatusMenu_abyssPrivate(event, task);
      },
    };
  }

  private readonly dependenciesFor_abyssPrivate: TaskDependencyLookup = (task) => {
    const target = calendarMutationTarget(task);
    return target === undefined ? undefined : this.tasks_abyssPrivate.queries.dependencies(target);
  };

  private openWeek_abyssPrivate(weekNumber: string, year: string): void {
    this.selectedDate_abyssPrivate = window
      .moment()
      .isoWeekYear(parseInt(year, 10))
      .isoWeek(parseInt(weekNumber, 10))
      .startOf('isoWeek');
    this.switchView_abyssPrivate('week');
  }

  private toggleCalendarTask_abyssPrivate(task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    const target = calendarMutationTarget(task);
    if (target == null) return;
    runAsyncAction(
      requestTaskCompletion(
        task,
        () =>
          this.tasks_abyssPrivate
            .execute({ type: 'toggle-completion', target })
            .then(presentTaskCommandResult),
        this.interactionOwnership_abyssPrivate,
        this.completionConfirmationAbortController_abyssPrivate.signal,
      ),
      'Could not update task completion',
    );
  }

  private openTaskStatusMenu_abyssPrivate(event: MouseEvent, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    const target = calendarMutationTarget(task);
    if (target == null) return;
    this.dismissStatusMenu_abyssPrivate();
    const cleanup = (): void => {
      statusMenu.close();
    };
    const statusMenu = showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      onPickStatus: (symbol) => {
        this.pickTaskStatus_abyssPrivate(task, target, symbol);
      },
      onPickPriority: (priority) => {
        this.pickTaskPriority_abyssPrivate(task, priority);
      },
      onClose: () => {
        if (this.statusMenuCleanup_abyssPrivate === cleanup)
          this.statusMenuCleanup_abyssPrivate = null;
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
    this.statusMenuCleanup_abyssPrivate = cleanup;
  }

  private pickTaskStatus_abyssPrivate(
    task: TaskSnapshot,
    target: NonNullable<ReturnType<typeof calendarMutationTarget>>,
    symbol: string,
  ): void {
    const apply = (): Promise<void> =>
      this.tasks_abyssPrivate
        .execute({ type: 'set-status', target, symbol })
        .then(presentTaskCommandResult);
    if (this.statusRegistry_abyssPrivate.bySymbol(symbol)?.type !== 'done') {
      runAsyncAction(apply(), 'Could not update task status');
      return;
    }
    runAsyncAction(
      requestTaskCompletion(
        task,
        apply,
        this.interactionOwnership_abyssPrivate,
        this.completionConfirmationAbortController_abyssPrivate.signal,
      ),
      'Could not update task completion',
    );
  }

  private pickTaskPriority_abyssPrivate(
    task: TaskSnapshot,
    priority: TaskSnapshot['priority'],
  ): void {
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (command == null) return;
    runAsyncAction(
      this.tasks_abyssPrivate.execute(command).then(presentTaskCommandResult),
      'Could not update task priority',
    );
  }

  private openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    this.dismissRecurrenceEditor_abyssPrivate();
    const occurrence = calendarOccurrenceForTask(task);
    const source = occurrence?.source ?? {
      root: task,
      target: { type: 'task' as const, ref: task.ref },
      node: task,
    };
    const cleanup = (): void => {
      handle.dismiss();
    };
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: this.recurrencePolicy_abyssPrivate,
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        return command != null
          ? this.tasks_abyssPrivate.execute(command)
          : Promise.resolve({
              type: 'io-error',
              cause: 'unsupported-calendar-patch',
              contentState: 'unchanged',
            });
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
        }
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
    this.recurrenceEditorCleanup_abyssPrivate = cleanup;
  }

  private openForecastRecurrenceEditor_abyssPrivate(source: CalendarTaskSource): void {
    this.dismissRecurrenceEditor_abyssPrivate();
    const cleanup = (): void => {
      handle.dismiss();
    };
    const handle = mountAnchoredRecurrenceEditor({
      anchor: this.rootEl_abyssPrivate,
      source,
      policy: this.recurrencePolicy_abyssPrivate,
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarSourcePatchCommand(source, patch);
        return command != null
          ? this.tasks_abyssPrivate.execute(command)
          : Promise.resolve({
              type: 'io-error',
              cause: 'unsupported-calendar-patch',
              contentState: 'unchanged',
            });
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup_abyssPrivate === cleanup) {
          this.recurrenceEditorCleanup_abyssPrivate = null;
        }
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
    this.recurrenceEditorCleanup_abyssPrivate = cleanup;
  }

  private openForecastSource_abyssPrivate(
    source: CalendarTaskSource,
    referenceDate: LocalDate,
  ): void {
    this.taskModal_abyssPrivate.open(source.root, `Forecast for ${referenceDate}`);
  }

  private dismissRecurrenceEditor_abyssPrivate(): void {
    const cleanup = this.recurrenceEditorCleanup_abyssPrivate;
    this.recurrenceEditorCleanup_abyssPrivate = null;
    cleanup?.();
  }

  private buildConfig_abyssPrivate(): ResolvedConfig {
    return {
      ...this.config_abyssPrivate,
      startPosition:
        this.activeViewType_abyssPrivate === 'week'
          ? firstVisibleWeekDate(
              this.selectedDate_abyssPrivate,
              this.config_abyssPrivate.firstDayOfWeek,
            )
          : this.selectedDate_abyssPrivate.format('YYYY-MM'),
    };
  }

  private calendarTasks_abyssPrivate(): TaskSnapshot[] {
    if (this.activeViewType_abyssPrivate === 'list') {
      this.projectionIssues_abyssPrivate = [];
      return [...this.queries_abyssPrivate.list()];
    }
    const viewType = this.activeViewType_abyssPrivate === 'week' ? 'week' : 'month';
    const dates = visibleCalendarDates(
      viewType,
      this.selectedDate_abyssPrivate,
      this.config_abyssPrivate.firstDayOfWeek,
    );
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    if (firstDate === undefined || lastDate === undefined) return [];
    const sources = this.queries_abyssPrivate.forCalendarProjection(dates.map(localDate));
    const projection = projectCalendarOccurrences(
      sources,
      { from: localDate(firstDate), to: localDate(lastDate) },
      this.recurrencePolicy_abyssPrivate,
    );
    this.projectionIssues_abyssPrivate = projection.issues;
    return projection.occurrences.map(taskSnapshotForCalendarOccurrence);
  }

  private renderView_abyssPrivate(): void {
    if (this.viewContainer_abyssPrivate == null) return;
    this.dismissStatusMenu_abyssPrivate();
    this.forecastMenuOwner_abyssPrivate.dismiss();
    this.dismissRecurrenceEditor_abyssPrivate();
    const tasks = this.calendarTasks_abyssPrivate();
    const config = this.buildConfig_abyssPrivate();
    const cb = this.buildCallbacks_abyssPrivate();

    // Instantiate new view when type changes (callbacks are baked into constructor)
    if (this.activeView_abyssPrivate == null || !this.isSameViewType_abyssPrivate()) {
      this.activeView_abyssPrivate?.destroy();
      if (this.activeViewType_abyssPrivate === 'month') {
        this.activeView_abyssPrivate = new MonthView({
          app: this.app_abyssPrivate,
          onToggle: cb.onToggle,
          dependenciesFor: this.dependenciesFor_abyssPrivate,
          onCellClick: cb.onCellClick,
          onWeekClick: cb.onWeekClick,
          onTaskClick: () => {},
          onDrop: () => {},
          onOpenNote: (t) => {
            runAsyncAction(openInFile(this.app_abyssPrivate, t), 'Could not open task note');
          },
          forecastMenuOwner: this.forecastMenuOwner_abyssPrivate,
          onForecastClick: (source, referenceDate) => {
            this.openForecastSource_abyssPrivate(source, referenceDate);
          },
          onForecastContextMenu: (source) => {
            this.openForecastRecurrenceEditor_abyssPrivate(source);
          },
          statusRegistry: this.statusRegistry_abyssPrivate,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
        });
      } else if (this.activeViewType_abyssPrivate === 'week') {
        this.activeView_abyssPrivate = new WeekView({
          app: this.app_abyssPrivate,
          onToggle: cb.onToggle,
          dependenciesFor: this.dependenciesFor_abyssPrivate,
          onCellClick: cb.onCellClick,
          onTaskClick: () => {},
          onDrop: () => {},
          onOpenNote: (t) => {
            runAsyncAction(openInFile(this.app_abyssPrivate, t), 'Could not open task note');
          },
          forecastMenuOwner: this.forecastMenuOwner_abyssPrivate,
          onForecastClick: (source, referenceDate) => {
            this.openForecastSource_abyssPrivate(source, referenceDate);
          },
          onForecastContextMenu: (source) => {
            this.openForecastRecurrenceEditor_abyssPrivate(source);
          },
          statusRegistry: this.statusRegistry_abyssPrivate,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
        });
      } else {
        this.activeView_abyssPrivate = new ListView({
          app: this.app_abyssPrivate,
          onToggle: cb.onToggle,
          dependenciesFor: this.dependenciesFor_abyssPrivate,
          onDateClick: cb.onDateClick,
          statusRegistry: this.statusRegistry_abyssPrivate,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
        });
      }
    }

    this.activeView_abyssPrivate.render(this.viewContainer_abyssPrivate, tasks, config);
    this.projectionDiagnosticOwner_abyssPrivate.update(
      this.viewContainer_abyssPrivate,
      this.projectionIssues_abyssPrivate,
    );
    this.updateToolbar_abyssPrivate();
  }

  private isSameViewType_abyssPrivate(): boolean {
    if (this.activeView_abyssPrivate == null) return false;
    if (this.activeViewType_abyssPrivate === 'month')
      return this.activeView_abyssPrivate instanceof MonthView;
    if (this.activeViewType_abyssPrivate === 'week')
      return this.activeView_abyssPrivate instanceof WeekView;
    return this.activeView_abyssPrivate instanceof ListView;
  }

  private updateToolbar_abyssPrivate(): void {
    if (this.toolbar_abyssPrivate == null) return;
    const tasks = this.queries_abyssPrivate.list();
    const today = window.moment().format('YYYY-MM-DD');
    this.toolbar_abyssPrivate.update({
      currentView: this.activeViewType_abyssPrivate,
      currentTitle: this.currentTitle_abyssPrivate(),
      currentStyle: this.config_abyssPrivate.style,
      filterActive: this.filterActive_abyssPrivate,
      overdueHighlightActive: this.overdueHighlightActive_abyssPrivate,
      activeStatGroup: this.activeStatGroup_abyssPrivate,
      stats: {
        done: tasks.filter((t) => t.status === 'done').length,
        due: tasks.filter((t) => t.planning.due != null && t.status === 'open').length,
        overdue: tasks.filter(
          (t) =>
            t.planning.due != null &&
            t.status === 'open' &&
            window.moment(t.planning.due).isBefore(today, 'day'),
        ).length,
        start: tasks.filter((t) => t.planning.start != null && t.status === 'open').length,
        scheduled: tasks.filter((t) => t.planning.scheduled != null && t.status === 'open').length,
        recurrence: tasks.filter(
          (t) => t.recurrence !== undefined && t.recurrence.length > 0 && t.status === 'open',
        ).length,
        dailyNote: tasks.filter((t) => t.presentation.dailyNoteDate != null && t.status === 'open')
          .length,
      },
    });
  }

  private currentTitle_abyssPrivate(): string {
    if (this.activeViewType_abyssPrivate === 'week') {
      return `Week ${this.selectedDate_abyssPrivate.format('w')} · ${this.selectedDate_abyssPrivate.format('YYYY')}`;
    }
    return `${this.selectedDate_abyssPrivate.format('MMMM')} ${this.selectedDate_abyssPrivate.format('YYYY')}`;
  }

  private applyStatFilter_abyssPrivate(group: string | null): void {
    // Remove all focus classes
    Array.from(this.rootEl_abyssPrivate.classList)
      .filter((c) => c.startsWith('focus'))
      .forEach((c) => {
        this.rootEl_abyssPrivate.classList.remove(c);
      });
    if (group !== null && group.length > 0) {
      this.rootEl_abyssPrivate.classList.add(
        `focus${group.charAt(0).toUpperCase()}${group.slice(1)}`,
      );
    }
  }

  private openAddTaskModal_abyssPrivate(date: string): void {
    this.dismissTaskInputModal_abyssPrivate();
    const modal = new TaskInputModal(
      this.app_abyssPrivate,
      async (text) => {
        const body = text.trim();
        if (body.length === 0) return;
        const prefix = this.taskPrefix_abyssPrivate.trim();
        presentTaskCreationResult(
          await this.tasks_abyssPrivate.execute({
            type: 'create',
            destination: { type: 'configured-default' },
            markdownBody: prefix.length > 0 ? `${prefix} ${body}` : body,
            initial: { due: { type: 'set', value: localDate(date) } },
          }),
        );
      },
      this.interactionOwnership_abyssPrivate,
      () => {
        if (this.taskInputModal_abyssPrivate === modal) this.taskInputModal_abyssPrivate = null;
      },
    );
    this.taskInputModal_abyssPrivate = modal;
    modal.open();
  }

  destroy(): void {
    this.completionConfirmationAbortController_abyssPrivate.abort();
    this.projectionDiagnosticOwner_abyssPrivate.destroy();
    this.forecastMenuOwner_abyssPrivate.dismiss();
    this.dismissStatusMenu_abyssPrivate();
    this.dismissRecurrenceEditor_abyssPrivate();
    this.dismissTaskInputModal_abyssPrivate();
    this.taskModal_abyssPrivate.close();
    this.unsubscribe_abyssPrivate?.();
    this.activeView_abyssPrivate?.destroy();
    this.toolbar_abyssPrivate?.destroy();
    this.rootEl_abyssPrivate.empty();
  }

  private dismissStatusMenu_abyssPrivate(): void {
    this.statusMenuCleanup_abyssPrivate?.();
    this.statusMenuCleanup_abyssPrivate = null;
  }

  private dismissTaskInputModal_abyssPrivate(): void {
    const modal = this.taskInputModal_abyssPrivate;
    this.taskInputModal_abyssPrivate = null;
    modal?.close();
  }
}

class TaskInputModal extends Modal {
  private ownershipToken: { release(): void } | null = null;

  constructor(
    app: App,
    private readonly onSubmit: (text: string) => Promise<void>,
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
    private readonly onClosed: () => void = () => {},
  ) {
    super(app);
  }

  override onOpen(): void {
    this.ownershipToken?.release();
    this.ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    const { contentEl } = this;
    contentEl.empty();
    contentEl.setCssStyles({ display: 'block', padding: '16px 20px 12px' });
    const form = contentEl.createDiv({
      attr: {
        style:
          'display:flex;flex-direction:row;align-items:center;gap:10px;max-width:420px;margin:0 auto',
      },
    });
    const input = form.createEl('input', { type: 'text', placeholder: 'Task description' });
    input.setCssStyles({
      flex: '1',
      padding: '8px 12px',
      fontSize: '1.05em',
      border: '1px solid var(--interactive-accent)',
      borderRadius: '6px',
      background: 'var(--background-secondary)',
      color: 'var(--text-normal)',
      outline: 'none',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.close();
        runAsyncAction(this.onSubmit(input.value), 'Could not add task');
      }
    });
    input.focus();
    const btn = form.createEl('button', { text: 'Add' });
    btn.setCssStyles({
      flex: '0 0 auto',
      padding: '8px 16px',
      fontSize: '1.05em',
      border: 'none',
      borderRadius: '6px',
      background: 'var(--interactive-accent)',
      color: 'var(--text-on-accent)',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      this.close();
      runAsyncAction(this.onSubmit(input.value), 'Could not add task');
    });
  }

  override onClose(): void {
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    this.contentEl.empty();
    this.onClosed();
  }
}
