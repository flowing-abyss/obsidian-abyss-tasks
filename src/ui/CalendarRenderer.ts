import { Modal, type App } from 'obsidian';
import { firstVisibleWeekDate, resolveWeekStartPosition } from '../domain/weekGridOffset';
import { visibleCalendarDates } from '../panels/visibleCalendarDates';
import type { ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { DependencyProjectionPort } from '../tasks';
import {
  localDate,
  type CommentTimeContextProvider,
  type LocalDate,
  type RecurrencePolicy,
  type TaskApplicationApi,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../tasks';
import { BaseView } from '../views/BaseView';
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
import { showStatusMenuAt } from './statusMenu';
import {
  presentTaskCommandResult,
  presentTaskCreationResult,
  requestTaskCompletion,
} from './taskCommandResult';
import { TaskModal } from './TaskModal';
import { openInFile } from './taskNavigation';
import { Toolbar, type ViewEntry } from './Toolbar';

const VIEWS: ViewEntry[] = [
  { id: 'list', icon: '', label: 'List' },
  { id: 'month', icon: '', label: 'Month' },
  { id: 'week', icon: '', label: 'Week' },
];

type ActiveView = 'month' | 'week' | 'list';

export class CalendarRenderer {
  private readonly completionConfirmationAbortController = new AbortController();
  private toolbar: Toolbar | null = null;
  private activeView: BaseView | null = null;
  private activeViewType: ActiveView;
  private viewContainer: HTMLElement | null = null;
  private selectedDate: ReturnType<typeof window.moment>;
  private filterActive = false;
  private overdueHighlightActive = false;
  private projectionIssues: readonly CalendarProjectionIssue[] = [];
  private activeStatGroup: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private recurrenceEditorCleanup: (() => void) | null = null;
  private statusMenuCleanup: (() => void) | null = null;
  private projectionDiagnosticOwner: CalendarProjectionDiagnosticOwner;
  private forecastMenuOwner: ForecastContextMenuOwner;
  private taskModal: TaskModal;
  private taskInputModal: TaskInputModal | null = null;

  constructor(
    private rootEl: HTMLElement,
    private config: ResolvedConfig,
    private app: App,
    private queries: TaskQueryApi,
    private tasks: TaskApplicationApi,
    private statusRegistry: StatusRegistry,
    private taskPrefix = '',
    private recurrencePolicy: RecurrencePolicy = { removeScheduledDate: false },
    private commentTimeContext?: CommentTimeContextProvider,
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
    private readonly dependencyProjection?: DependencyProjectionPort,
  ) {
    this.projectionDiagnosticOwner = createCalendarProjectionDiagnosticOwner(rootEl.ownerDocument);
    this.forecastMenuOwner = createForecastContextMenuOwner(
      rootEl.ownerDocument,
      interactionOwnership,
    );
    this.taskModal = new TaskModal(
      app,
      statusRegistry,
      undefined,
      queries,
      tasks,
      commentTimeContext,
      interactionOwnership,
      dependencyProjection,
    );
    this.activeViewType = config.defaultView;
    if (this.activeViewType === 'week') {
      this.selectedDate = resolveWeekStartPosition(
        config.startPosition,
        config.firstDayOfWeek,
        window.moment(),
      );
    } else {
      this.selectedDate = config.startPosition
        ? window.moment(config.startPosition, 'YYYY-MM').date(1)
        : window.moment().date(1);
    }
  }

  mount(): void {
    this.rootEl.setAttribute('view', this.activeViewType);
    if (this.config.style) this.rootEl.addClass(this.config.style);

    // Wrap everything in a span (matches existing CSS selectors)
    const span = this.rootEl.createEl('span');

    this.toolbar = new Toolbar(span, VIEWS, {
      onPrev: () => this.navigate(-1),
      onNext: () => this.navigate(1),
      onToday: () => this.goToday(),
      onViewSwitch: (id) => this.switchView(id as ActiveView),
      onFilterToggle: () => {
        this.filterActive = !this.filterActive;
        this.rootEl.classList.toggle('filter', this.filterActive);
        this.updateToolbar();
      },
      onOverdueHighlight: () => {
        this.overdueHighlightActive = !this.overdueHighlightActive;
        this.updateToolbar();
      },
      onStatFilter: (group) => {
        this.activeStatGroup = group;
        this.applyStatFilter(group);
      },
      onStyleChange: (style) => {
        if (this.config.style) this.rootEl.removeClass(this.config.style);
        this.config = { ...this.config, style };
        this.rootEl.addClass(style);
        this.updateToolbar();
      },
    });

    this.viewContainer = span.createDiv();
    this.renderView();

    this.unsubscribe = this.queries.subscribe(() => {
      this.dismissStatusMenu();
      this.forecastMenuOwner.dismiss();
      this.dismissRecurrenceEditor();
      const tasks = this.calendarTasks();
      this.activeView?.patch(this.viewContainer!, tasks, this.buildConfig());
      this.projectionDiagnosticOwner.update(this.viewContainer!, this.projectionIssues);
      this.updateToolbar();
    });
  }

  private navigate(dir: -1 | 1): void {
    if (this.activeViewType === 'month' || this.activeViewType === 'list') {
      this.selectedDate = window.moment(this.selectedDate).add(dir, 'months');
    } else {
      this.selectedDate = window.moment(this.selectedDate).add(dir * 7, 'days');
    }
    this.renderView();
  }

  private goToday(): void {
    if (this.activeViewType === 'week') {
      this.selectedDate = window.moment();
    } else {
      this.selectedDate = window.moment().date(1);
    }
    this.renderView();
  }

  private switchView(type: ActiveView): void {
    if (this.activeViewType === type) return;
    this.dismissStatusMenu();
    this.dismissRecurrenceEditor();
    this.activeViewType = type;
    this.rootEl.setAttribute('view', type);
    this.activeView?.destroy();
    this.activeView = null;
    this.renderView();
  }

  private buildCallbacks() {
    return {
      onToggle: (task: TaskSnapshot) => {
        if (isForecastCalendarTask(task)) return;
        const target = calendarMutationTarget(task);
        if (!target) return;
        void requestTaskCompletion(
          task,
          () =>
            this.tasks
              .execute({ type: 'toggle-completion', target })
              .then(presentTaskCommandResult),
          this.interactionOwnership,
          this.completionConfirmationAbortController.signal,
        );
      },
      onCellClick: (date: string) => this.openAddTaskModal(date),
      onWeekClick: (weekNr: string, year: string) => {
        this.selectedDate = window
          .moment()
          .isoWeekYear(parseInt(year, 10))
          .isoWeek(parseInt(weekNr, 10))
          .startOf('isoWeek');
        this.switchView('week');
      },
      onDateClick: (date: string) => this.openAddTaskModal(date),
      onTaskBodyContextMenu: (_ev: MouseEvent, task: TaskSnapshot, anchor: HTMLElement) => {
        if (isForecastCalendarTask(task)) return;
        this.openRecurrenceEditor(anchor, task);
      },
      onContextMenu: (ev: MouseEvent, task: TaskSnapshot) => {
        if (isForecastCalendarTask(task)) return;
        const target = calendarMutationTarget(task);
        if (!target) return;
        this.dismissStatusMenu();
        let cleanup: () => void;
        const statusMenu = showStatusMenuAt(ev, {
          task,
          registry: this.statusRegistry,
          onPickStatus: (symbol) => {
            const apply = (): Promise<void> =>
              this.tasks
                .execute({ type: 'set-status', target, symbol })
                .then(presentTaskCommandResult);
            if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
              void requestTaskCompletion(
                task,
                apply,
                this.interactionOwnership,
                this.completionConfirmationAbortController.signal,
              );
            } else {
              void apply();
            }
          },
          onPickPriority: (priority) => {
            const command = calendarPatchCommand(task, {
              priority: { type: 'set', value: priority },
            });
            if (command) void this.tasks.execute(command).then(presentTaskCommandResult);
          },
          onClose: () => {
            if (this.statusMenuCleanup === cleanup) this.statusMenuCleanup = null;
          },
          interactionOwnership: this.interactionOwnership,
        });
        cleanup = () => statusMenu.close();
        this.statusMenuCleanup = cleanup;
      },
    };
  }

  private openRecurrenceEditor(anchor: HTMLElement, task: TaskSnapshot): void {
    if (isForecastCalendarTask(task)) return;
    this.dismissRecurrenceEditor();
    const occurrence = calendarOccurrenceForTask(task);
    const source = occurrence?.source ?? {
      root: task,
      target: { type: 'task' as const, ref: task.ref },
      node: task,
    };
    let cleanup: () => void;
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: this.recurrencePolicy,
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        return command
          ? this.tasks.execute(command)
          : Promise.resolve({
              type: 'io-error',
              cause: 'unsupported-calendar-patch',
              contentState: 'unchanged',
            });
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
      interactionOwnership: this.interactionOwnership,
    });
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private openForecastRecurrenceEditor(source: CalendarTaskSource): void {
    this.dismissRecurrenceEditor();
    let cleanup: () => void;
    const handle = mountAnchoredRecurrenceEditor({
      anchor: this.rootEl,
      source,
      policy: this.recurrencePolicy,
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarSourcePatchCommand(source, patch);
        return command
          ? this.tasks.execute(command)
          : Promise.resolve({
              type: 'io-error',
              cause: 'unsupported-calendar-patch',
              contentState: 'unchanged',
            });
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
      interactionOwnership: this.interactionOwnership,
    });
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private openForecastSource(source: CalendarTaskSource, referenceDate: LocalDate): void {
    this.taskModal.open(source.root, `Forecast for ${referenceDate}`);
  }

  private dismissRecurrenceEditor(): void {
    const cleanup = this.recurrenceEditorCleanup;
    this.recurrenceEditorCleanup = null;
    cleanup?.();
  }

  private buildConfig(): ResolvedConfig {
    return {
      ...this.config,
      startPosition:
        this.activeViewType === 'week'
          ? firstVisibleWeekDate(this.selectedDate, this.config.firstDayOfWeek)
          : this.selectedDate.format('YYYY-MM'),
    };
  }

  private calendarTasks(): TaskSnapshot[] {
    if (this.activeViewType === 'list') {
      this.projectionIssues = [];
      return [...this.queries.list()];
    }
    const viewType = this.activeViewType === 'week' ? 'week' : 'month';
    const dates = visibleCalendarDates(viewType, this.selectedDate, this.config.firstDayOfWeek);
    const sources = this.queries.forCalendarProjection(dates.map(localDate));
    const projection = projectCalendarOccurrences(
      sources,
      { from: localDate(dates[0]!), to: localDate(dates[dates.length - 1]!) },
      this.recurrencePolicy,
    );
    this.projectionIssues = projection.issues;
    return projection.occurrences.map(taskSnapshotForCalendarOccurrence);
  }

  private renderView(): void {
    if (!this.viewContainer) return;
    this.dismissStatusMenu();
    this.forecastMenuOwner.dismiss();
    this.dismissRecurrenceEditor();
    const tasks = this.calendarTasks();
    const config = this.buildConfig();
    const cb = this.buildCallbacks();

    // Instantiate new view when type changes (callbacks are baked into constructor)
    if (!this.activeView || !this.isSameViewType()) {
      this.activeView?.destroy();
      if (this.activeViewType === 'month') {
        this.activeView = new MonthView({
          app: this.app,
          onToggle: cb.onToggle,
          onCellClick: cb.onCellClick,
          onWeekClick: cb.onWeekClick,
          onTaskClick: () => {},
          onDrop: () => {},
          onOpenNote: (t) => void openInFile(this.app, t),
          forecastMenuOwner: this.forecastMenuOwner,
          onForecastClick: (source, referenceDate) =>
            this.openForecastSource(source, referenceDate),
          onForecastContextMenu: (source) => this.openForecastRecurrenceEditor(source),
          statusRegistry: this.statusRegistry,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
          dependencyDecision: (task) => this.dependencyProjection?.evaluateCompletion(task),
        });
      } else if (this.activeViewType === 'week') {
        this.activeView = new WeekView({
          app: this.app,
          onToggle: cb.onToggle,
          onCellClick: cb.onCellClick,
          onTaskClick: () => {},
          onDrop: () => {},
          onOpenNote: (t) => void openInFile(this.app, t),
          forecastMenuOwner: this.forecastMenuOwner,
          onForecastClick: (source, referenceDate) =>
            this.openForecastSource(source, referenceDate),
          onForecastContextMenu: (source) => this.openForecastRecurrenceEditor(source),
          statusRegistry: this.statusRegistry,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
          dependencyDecision: (task) => this.dependencyProjection?.evaluateCompletion(task),
        });
      } else {
        this.activeView = new ListView({
          app: this.app,
          onToggle: cb.onToggle,
          onDateClick: cb.onDateClick,
          statusRegistry: this.statusRegistry,
          onTaskBodyContextMenu: cb.onTaskBodyContextMenu,
          onContextMenu: cb.onContextMenu,
          dependencyDecision: (task) => this.dependencyProjection?.evaluateCompletion(task),
        });
      }
    }

    this.activeView.render(this.viewContainer, tasks, config);
    this.projectionDiagnosticOwner.update(this.viewContainer, this.projectionIssues);
    this.updateToolbar();
  }

  private isSameViewType(): boolean {
    if (!this.activeView) return false;
    if (this.activeViewType === 'month') return this.activeView instanceof MonthView;
    if (this.activeViewType === 'week') return this.activeView instanceof WeekView;
    return this.activeView instanceof ListView;
  }

  private updateToolbar(): void {
    if (!this.toolbar) return;
    const tasks = this.queries.list();
    const today = window.moment().format('YYYY-MM-DD');
    this.toolbar.update({
      currentView: this.activeViewType,
      currentTitle: this.currentTitle(),
      currentStyle: this.config.style ?? 'style1',
      filterActive: this.filterActive,
      overdueHighlightActive: this.overdueHighlightActive,
      activeStatGroup: this.activeStatGroup,
      stats: {
        done: tasks.filter((t) => t.status === 'done').length,
        due: tasks.filter((t) => t.planning.due && t.status === 'open').length,
        overdue: tasks.filter(
          (t) =>
            t.planning.due &&
            t.status === 'open' &&
            window.moment(t.planning.due).isBefore(today, 'day'),
        ).length,
        start: tasks.filter((t) => t.planning.start && t.status === 'open').length,
        scheduled: tasks.filter((t) => t.planning.scheduled && t.status === 'open').length,
        recurrence: tasks.filter((t) => t.recurrence && t.status === 'open').length,
        dailyNote: tasks.filter((t) => t.presentation.dailyNoteDate && t.status === 'open').length,
      },
    });
  }

  private currentTitle(): string {
    if (this.activeViewType === 'week') {
      return `Week ${this.selectedDate.format('w')} · ${this.selectedDate.format('YYYY')}`;
    }
    return `${this.selectedDate.format('MMMM')} ${this.selectedDate.format('YYYY')}`;
  }

  private applyStatFilter(group: string | null): void {
    // Remove all focus classes
    Array.from(this.rootEl.classList)
      .filter((c) => c.startsWith('focus'))
      .forEach((c) => this.rootEl.classList.remove(c));
    if (group) {
      this.rootEl.classList.add('focus' + group.charAt(0).toUpperCase() + group.slice(1));
    }
  }

  private openAddTaskModal(date: string): void {
    this.dismissTaskInputModal();
    let modal!: TaskInputModal;
    modal = new TaskInputModal(
      this.app,
      async (text) => {
        const body = text.trim();
        if (!body) return;
        const prefix = this.taskPrefix.trim();
        presentTaskCreationResult(
          await this.tasks.execute({
            type: 'create',
            destination: { type: 'configured-default' },
            markdownBody: prefix ? `${prefix} ${body}` : body,
            initial: { due: { type: 'set', value: localDate(date) } },
          }),
        );
      },
      this.interactionOwnership,
      () => {
        if (this.taskInputModal === modal) this.taskInputModal = null;
      },
    );
    this.taskInputModal = modal;
    modal.open();
  }

  destroy(): void {
    this.completionConfirmationAbortController.abort();
    this.projectionDiagnosticOwner.destroy();
    this.forecastMenuOwner.dismiss();
    this.dismissStatusMenu();
    this.dismissRecurrenceEditor();
    this.dismissTaskInputModal();
    this.taskModal.close();
    this.unsubscribe?.();
    this.activeView?.destroy();
    this.toolbar?.destroy();
    this.rootEl.empty();
  }

  private dismissStatusMenu(): void {
    this.statusMenuCleanup?.();
    this.statusMenuCleanup = null;
  }

  private dismissTaskInputModal(): void {
    const modal = this.taskInputModal;
    this.taskInputModal = null;
    modal?.close();
  }
}

class TaskInputModal extends Modal {
  private ownershipToken: { release(): void } | null = null;

  constructor(
    app: App,
    private onSubmit: (text: string) => Promise<void>,
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
    private readonly onClosed: () => void = () => {},
  ) {
    super(app);
  }

  onOpen(): void {
    this.ownershipToken?.release();
    this.ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    const { contentEl } = this;
    contentEl.empty();
    // eslint-disable-next-line obsidianmd/no-static-styles-assignment
    contentEl.style.cssText = 'display:block;padding:16px 20px 12px';
    const form = contentEl.createDiv({
      attr: {
        style:
          'display:flex;flex-direction:row;align-items:center;gap:10px;max-width:420px;margin:0 auto',
      },
    });
    const input = form.createEl('input', { type: 'text', placeholder: 'Task description' });
    // eslint-disable-next-line obsidianmd/no-static-styles-assignment
    input.style.cssText =
      'flex:1;padding:8px 12px;font-size:1.05em;border:1px solid var(--interactive-accent);border-radius:6px;background:var(--background-secondary);color:var(--text-normal);outline:none';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.close();
        void this.onSubmit(input.value);
      }
    });
    input.focus();
    const btn = form.createEl('button', { text: 'Add' });
    // eslint-disable-next-line obsidianmd/no-static-styles-assignment
    btn.style.cssText =
      'flex:0 0 auto;padding:8px 16px;font-size:1.05em;border:none;border-radius:6px;background:var(--interactive-accent);color:var(--text-on-accent);cursor:pointer';
    btn.addEventListener('click', () => {
      this.close();
      void this.onSubmit(input.value);
    });
  }

  onClose(): void {
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    this.contentEl.empty();
    this.onClosed();
  }
}
