import { Component, Menu, setIcon, TFile, type App, type MenuItem } from 'obsidian';
import type { AppState } from '../app/AppState';
import {
  isListViewCustomized,
  listSelectionToKey,
  normalizeStatusGroups,
  statusGroupsEqual,
} from '../app/listViewState';
import { firstVisibleWeekDate } from '../domain/weekGridOffset';
import type { LinkToken } from '../parser/links';
import { PRIORITY_LEVELS } from '../priority';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import { DEFAULT_VIEW_CONFIG, getListViewDefaults } from '../settings/defaults';
import type {
  CalendarSettings,
  ListViewState,
  PropertyFilter,
  ResolvedConfig,
} from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { ACTIVE_STATUS_GROUPS, ALL_STATUS_GROUPS, TYPE_LABELS } from '../status/statusConstants';
import { searchTaskList, selectTaskList } from '../task-lists/TaskListSelector';
import {
  daysBetweenLocalDates,
  durationMinutes,
  localDate,
  localTime,
  shiftLocalDate,
  type CommentTimeContextProvider,
  type LocalDate,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskPriority,
  type TaskQueryApi,
  type TaskRef,
  type TaskSnapshot,
  type TaskStatusType,
} from '../tasks';
import { showDatePickerPopover } from '../ui/DatePickerPopover';
import { LinkEditModal } from '../ui/LinkEditModal';
import { renderStatusMarker } from '../ui/StatusMarker';
import { TagPickerModal } from '../ui/TagPickerModal';
import { TaskModal } from '../ui/TaskModal';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { mountAnchoredRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { renderSourceNoteChip, shouldShowSourceNote } from '../ui/sourceNoteChip';
import { buildStatusSubmenu, showStatusMenuAt } from '../ui/statusMenu';
import {
  presentTaskCommandResult,
  presentTaskCreationResult,
  requestTaskCompletion,
} from '../ui/taskCommandResult';
import { openInFile } from '../ui/taskNavigation';
import { rootTaskRef, taskNodeLine } from '../ui/taskSelection';
import { TimedBlockKeyboardQueue } from '../ui/timedBlockKeyboardQueue';
import { MonthGridView } from '../views/MonthGridView';
import { TodayView } from '../views/TodayView';
import { WeekTimeGridView } from '../views/WeekTimeGridView';
import {
  calendarMutationTarget,
  calendarOccurrenceForTask,
  calendarPatchCommand,
  calendarRootTaskRef,
  calendarSourcePatchCommand,
  hasOtherCalendarRecurrenceOwner,
  isForecastCalendarTask,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
  type CalendarProjectionIssue,
  type CalendarTaskSource,
} from '../views/calendarOccurrences';
import type { InteractiveSpanBoundaryTarget, SpanMoveTarget } from '../views/spanInteractions';
import {
  groupTasksByDate,
  groupTasksByPriority,
  groupTasksByStatus,
  groupTasksByTag,
} from '../views/taskGrouping';
import type { TimedDragTarget, TimedVerticalResizeTarget } from '../views/timegrid/dragGeometry';
import {
  minutesToPixels,
  minutesToTimeString,
  timeStringToMinutes,
} from '../views/timegrid/layout';
import {
  createCalendarProjectionDiagnosticOwner,
  createForecastContextMenuOwner,
  type CalendarProjectionDiagnosticOwner,
  type ForecastContextMenuOwner,
} from '../views/timegrid/renderTaskMeta';
import type { TimedBlockKeyboardIntent } from '../views/timegrid/renderTimedBlocks';
import type { TimedBoundaryTarget } from '../views/timegrid/timedInteractions';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { visibleCalendarDates, type CalViewType } from './visibleCalendarDates';

type CreateTaskCommand = Extract<
  Parameters<TaskApplicationApi['execute']>[0],
  { readonly type: 'create' }
>;

interface TimedBlockFocusLocator {
  readonly filePath: string;
  readonly line: number;
  readonly segmentDate?: string;
  readonly sequence: number;
  readonly queueSequence?: number;
  readonly originElement?: HTMLElement;
}

interface PendingTimedBlockRestoration {
  readonly queueSequence: number;
  readonly focusSequence: number;
  readonly renderGeneration: number;
}

function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  if (!target || !('ownerDocument' in target)) return false;
  const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
  const realm = ownerDocument?.defaultView;
  return realm !== null && realm !== undefined && target instanceof realm.HTMLElement;
}

function projectNameFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/**
 * Colors a priority-submenu flag icon to match the rest of the UI (status
 * popover flags, flag settings, etc.) by tagging the item's undocumented
 * `.dom` element — Obsidian doesn't expose per-item icon styling otherwise.
 */
function applyPriorityFlagColor(si: MenuItem, value: TaskPriority): void {
  const dom = (si as unknown as { dom?: HTMLElement }).dom;
  if (dom) {
    dom.addClass('tc-menu-priority-flag');
    dom.setAttribute('data-tc-priority', value);
  }
}

/** Obsidian's MenuItem.setSubmenu() is undocumented; reach it via one shared cast. */
function getSubmenu(item: MenuItem): Menu {
  return (item as unknown as { setSubmenu(): Menu }).setSubmenu();
}

export class CenterPanel {
  private el!: HTMLElement;
  private offs: Array<() => void> = [];
  private calViewType: CalViewType = 'month';
  private calDate = window.moment().date(1);
  private calViewInstance: TodayView | WeekTimeGridView | MonthGridView | null = null;
  private calUnsubscribe: (() => void) | null = null;
  private calendarPickerCleanup: ((restoreFocus?: boolean) => void) | null = null;
  private taskDatePickerCleanup: (() => void) | null = null;
  private taskCardRenderGeneration = 0;
  private taskDateFocusContinuityKey: string | null = null;
  private pendingTaskDateFocus: {
    key: string;
    armedRenderGeneration: number;
    changed: boolean;
  } | null = null;
  private recurrenceEditorCleanup: (() => void) | null = null;
  private viewStatePopoverCleanup: ((restoreFocus?: boolean) => void) | null = null;
  private forecastMenuOwner: ForecastContextMenuOwner | null = null;
  private projectionDiagnosticOwner: CalendarProjectionDiagnosticOwner | null = null;
  // Full renders replace the view instance, so keep the last scroll-to-now key at panel scope.
  // Query notifications use the incremental patch path and never consult this state.
  private lastScrolledCalKey: string | null = null;
  // A deliberate full refresh empties the outer calendar before mountView can inspect its grid.
  // Carry scrollTop across that boundary; query patches retain the grid node and need no fallback.
  private pendingCalScrollTop: number | undefined = undefined;
  private keyboardQueue: TimedBlockKeyboardQueue | null = null;
  private pendingTimedBlockFocus: TimedBlockFocusLocator | undefined;
  private settledKeyboardSequences = new Set<number>();
  private restoredKeyboardSequences = new Set<number>();
  private committedKeyboardSequences = new Set<number>();
  private pendingTimedBlockRestorations = new Map<number, PendingTimedBlockRestoration>();
  private nextTimedBlockRestoration = 0;
  private nextTimedBlockFocusSequence = 0;
  private calendarRenderGeneration = 0;
  private taskModal: TaskModal | null = null;
  private selectedTaskKeys = new Set<string>();
  private selectionAnchorKey: string | null = null;
  private selectionFocusKey: string | null = null;
  private currentListKey: string = 'today';
  private filterDebounce = 0;
  private refocusSearch = false;
  // Set true while a status-group toggle click is in flight, so that the
  // full re-render triggered by updateViewState re-opens the popover with
  // the "Status group" row still expanded (multi-select shouldn't close on pick).
  private reopenStatusGroupPopover = false;
  private onSaveSettings: () => Promise<void>;
  private md = new Component();
  private searchInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;
  private searchResultsFrame: number | null = null;

  private projectsPanel: ProjectsPanel | null = null;

  constructor(
    private state: AppState,
    private app: App,
    private settings: CalendarSettings,
    private queries: TaskQueryApi,
    private statusRegistry: StatusRegistry,
    onSaveSettings: () => Promise<void> = async () => {},
    private projectStore: ProjectStore | null = null,
    private projectManager: ProjectManager | null = null,
    private tasks?: TaskApplicationApi,
    private commentTimeContext?: CommentTimeContextProvider,
  ) {
    this.onSaveSettings = onSaveSettings;
    if (tasks) {
      this.keyboardQueue = new TimedBlockKeyboardQueue(tasks, {
        onCommitted: (task, intent, sequence, changed) => {
          this.handleKeyboardCommit(task, intent, sequence, changed);
        },
        onSettled: (_taskKey, sequence, summary) => {
          if (this.pendingTimedBlockFocus?.queueSequence === sequence) {
            if (
              (summary.anyChanged || summary.sourceChanged) &&
              !this.committedKeyboardSequences.has(sequence)
            ) {
              this.committedKeyboardSequences.add(sequence);
              this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
            }
            const pendingRestoration = this.hasPendingTimedBlockRestoration(sequence);
            if (
              (!summary.anyChanged && !summary.sourceChanged && !pendingRestoration) ||
              this.restoredKeyboardSequences.has(sequence)
            ) {
              this.clearTimedBlockFocus(sequence);
            } else {
              this.settledKeyboardSequences.add(sequence);
            }
          }
        },
        present: (result) => {
          presentTaskCommandResult(result);
          if (result.type !== 'ok' || result.outcome.type !== 'task') {
            this.clearTimedBlockFocus();
          }
        },
      });
    }
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.forecastMenuOwner = createForecastContextMenuOwner(container.ownerDocument);
    this.taskModal = new TaskModal(
      this.app,
      this.statusRegistry,
      this.settings,
      this.queries,
      this.tasks,
      this.commentTimeContext,
    );

    // Initialize per-list state before first render
    const initialKey = listSelectionToKey(this.state.get('selectedList'));
    this.currentListKey = initialKey;
    const initialVs: ListViewState =
      this.settings.listViewStates?.[initialKey] ?? getListViewDefaults(initialKey);
    this.state.set('centerListViewState', initialVs);

    this.offs.push(
      this.state.on('selectedList', (newSel) => {
        // Save current state for the old list key
        const oldKey = this.currentListKey;
        const currentVs = this.state.get('centerListViewState');
        if (!this.settings.listViewStates) this.settings.listViewStates = {};
        this.settings.listViewStates[oldKey] = currentVs;
        void this.onSaveSettings();

        // Load state for new list
        const newKey = listSelectionToKey(newSel);
        this.currentListKey = newKey;
        const saved = this.settings.listViewStates?.[newKey];
        const nextVs = saved ?? getListViewDefaults(newKey);
        this.state.set('centerListViewState', nextVs);
        this.state.set('centerFilter', '');

        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = null;
        this.selectionFocusKey = null;
      }),
      this.state.on('centerListViewState', () => this.render()),
      this.state.on('mode', () => {
        this.cancelKeyboardInteraction();
        this.render();
      }),
      this.state.on('centerFilter', () => this.render()),
      this.state.on('searchQuery', (query) => this.handleSearchQueryChanged(query)),
      this.state.on('taskStack', () => {
        const stack = this.state.get('taskStack');
        const root = stack[0];
        const current = stack[stack.length - 1];
        this.el.querySelectorAll<HTMLElement>('.tc-task-card').forEach((card) => {
          const isSelected =
            root !== undefined &&
            current !== undefined &&
            card.dataset['filePath'] === rootTaskRef(root).filePath &&
            card.dataset['line'] === String(taskNodeLine(root as TaskSnapshot, current));
          card.classList.toggle('is-selected', isSelected);
        });
      }),
    );
    this.render();
    this.el.setAttribute('tabindex', '0');
    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        (this.selectedTaskKeys.size > 0 ||
          this.selectionAnchorKey !== null ||
          this.selectionFocusKey !== null)
      ) {
        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = null;
        this.selectionFocusKey = null;
        this.updateSelectionVisuals();
        return;
      }

      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (this.state.get('mode') !== 'tasks') return;
      const target = e.target;
      if (
        isRealmHTMLElement(target) &&
        target.closest(
          'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .tc-status-marker, .tc-popover',
        )
      ) {
        return;
      }

      const keys = this.visibleTaskKeys();
      if (keys.length === 0) return;
      e.preventDefault();

      const targetCard = isRealmHTMLElement(target)
        ? target.closest<HTMLElement>('.tc-task-card')
        : null;
      const targetKey =
        targetCard && this.el.contains(targetCard)
          ? `${targetCard.dataset['filePath'] ?? ''}:${targetCard.dataset['line'] ?? ''}`
          : null;
      const detailCard = this.visibleTaskCards().find((card) =>
        card.classList.contains('is-selected'),
      );
      const detailKey = detailCard
        ? `${detailCard.dataset['filePath'] ?? ''}:${detailCard.dataset['line'] ?? ''}`
        : null;
      const currentKey = [this.selectionFocusKey, targetKey, detailKey].find(
        (candidate): candidate is string => candidate !== null && keys.includes(candidate),
      );
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const currentIndex = currentKey ? keys.indexOf(currentKey) : -1;
      let nextIndex: number;
      if (currentIndex === -1) {
        nextIndex = e.key === 'ArrowDown' ? 0 : keys.length - 1;
      } else {
        nextIndex = Math.max(0, Math.min(keys.length - 1, currentIndex + delta));
      }
      const nextKey = keys[nextIndex];
      if (!nextKey) return;

      if (e.shiftKey) {
        const anchor =
          this.selectionAnchorKey && keys.includes(this.selectionAnchorKey)
            ? this.selectionAnchorKey
            : currentKey;
        this.selectionAnchorKey = anchor ?? nextKey;
        this.selectionFocusKey = nextKey;
        this.replaceRangeSelection(this.selectionAnchorKey, nextKey, keys);
      } else {
        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = nextKey;
        this.selectionFocusKey = nextKey;
        this.updateSelectionVisuals();
        const task = this.taskForKey(nextKey);
        if (task) this.state.set('taskStack', [task]);
      }
      this.focusTaskKey(nextKey);
    };
    this.el.addEventListener('keydown', onKeyDown);
    this.offs.push(() => this.el.removeEventListener('keydown', onKeyDown));
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      const taskDateFocusKey = this.taskDateFocusContinuityKey;
      if (taskDateFocusKey !== null && this.taskDateTriggerKey(target) !== taskDateFocusKey) {
        this.abandonTaskDateFocus();
      }
      if (!isRealmHTMLElement(target)) return;
      const ownerDocument = this.el.ownerDocument;
      // Calendar remount removal can leave body as activeElement without emitting focusin. An
      // actual body focusin has already revoked task-date ownership above; timed-block restoration
      // still treats body/documentElement as transient renderer state.
      if (target === ownerDocument.body || target === ownerDocument.documentElement) return;
      const block = target.closest<HTMLElement>('.tc-tg-block');
      if (block && this.el.contains(block)) {
        this.retainTimedBlockFocus(block);
      } else if (this.pendingTimedBlockFocus) {
        this.cancelKeyboardInteraction();
      }
    };
    const ownerDocument = this.el.ownerDocument;
    ownerDocument.addEventListener('focusin', onFocusIn);
    this.offs.push(() => ownerDocument.removeEventListener('focusin', onFocusIn));
    const onPointerDown = (event: PointerEvent): void => {
      const taskDateFocusKey = this.taskDateFocusContinuityKey;
      if (taskDateFocusKey !== null && this.taskDateTriggerKey(event.target) !== taskDateFocusKey) {
        this.abandonTaskDateFocus();
      }
    };
    ownerDocument.addEventListener('pointerdown', onPointerDown, true);
    this.offs.push(() => ownerDocument.removeEventListener('pointerdown', onPointerDown, true));
    const ownerWindow = ownerDocument.defaultView;
    const onOwnerWindowBlur = (): void => {
      this.abandonTaskDateFocus();
      if (this.pendingTimedBlockFocus) this.cancelKeyboardInteraction();
    };
    ownerWindow?.addEventListener('blur', onOwnerWindowBlur);
    this.offs.push(() => ownerWindow?.removeEventListener('blur', onOwnerWindowBlur));
  }

  refresh(): void {
    if (
      this.state.get('mode') === 'search' &&
      this.searchInputEl?.isConnected &&
      this.searchResultsEl?.isConnected
    ) {
      this.scheduleSearchResults(this.state.get('searchQuery'));
      return;
    }
    this.render();
  }

  destroy(): void {
    this.cancelKeyboardInteraction();
    this.abandonTaskDateFocus();
    this.clearSearchShell();
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    this.taskModal?.close();
    window.clearTimeout(this.filterDebounce);
    this.offs.forEach((f) => f());
    this.destroyCalendarView();
    this.destroyProjectsPanel();
    this.md.unload();
    this.el?.empty();
  }

  private destroyProjectsPanel(): void {
    this.projectsPanel?.destroy();
    this.projectsPanel = null;
  }

  /** Renders a project's tasks (reusing the card component) plus an add bar that writes into the note. */
  private renderProjectTasks(host: HTMLElement, path: string): void {
    const tasks = [...this.queries.list({ filePath: path })];
    const scroll = host.createDiv({ cls: 'tc-center-scroll tc-project-tasks-scroll' });
    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'tc-center-empty', text: 'No tasks yet' });
    } else {
      for (const task of tasks) this.renderTaskCard(scroll, task);
    }

    const bar = host.createDiv({ cls: 'tc-add-task-bar' });
    const trigger = bar.createDiv({ cls: 'tc-add-task-trigger' });
    trigger.createEl('span', { cls: 'tc-add-task-plus', text: '+' });
    trigger.createEl('span', { cls: 'tc-add-task-label', text: 'Add task' });
    bar.addEventListener('click', () => {
      if (bar.querySelector('.tc-quick-capture')) return;
      trigger.remove();
      const form = bar.createDiv({ cls: 'tc-quick-capture' });
      const input = form.createEl('input', {
        cls: 'tc-quick-capture-input',
        attr: { type: 'text', placeholder: 'Task name…' },
      });
      let committed = false;
      const commit = (): void => {
        if (committed) return;
        committed = true;
        const text = input.value.trim();
        if (text) void this.createInProject(path, text);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          // Cancel: block the pending blur→commit so nothing is written.
          committed = true;
          this.projectsPanel?.refresh();
        }
      });
      input.addEventListener('blur', () => {
        window.setTimeout(() => {
          if (activeDocument.activeElement !== input) commit();
        }, 150);
      });
      window.setTimeout(() => input.focus(), 0);
    });
    this.completeTaskCardRender();
  }

  private destroyCalendarView(): void {
    this.forecastMenuOwner?.dismiss();
    this.projectionDiagnosticOwner?.destroy();
    this.projectionDiagnosticOwner = null;
    this.clearCalendarPicker();
    this.calUnsubscribe?.();
    this.calUnsubscribe = null;
    this.calViewInstance?.destroy();
    this.calViewInstance = null;
  }

  private clearCalendarPicker(restoreFocus = false): void {
    this.calendarPickerCleanup?.(restoreFocus);
  }

  private armCalendarPicker(picker: HTMLElement, anchor: HTMLElement): void {
    const ownerDocument = this.el.ownerDocument;
    let registrationTimer: number | undefined;
    let listening = false;
    const dismiss = (event: MouseEvent): void => {
      if (!picker.contains(event.target as Node) && event.target !== anchor) cleanup();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cleanup(true);
    };
    const cleanup = (restoreFocus = false): void => {
      if (registrationTimer !== undefined) {
        window.clearTimeout(registrationTimer);
        registrationTimer = undefined;
      }
      if (listening) {
        ownerDocument.removeEventListener('click', dismiss, true);
        listening = false;
      }
      picker.removeEventListener('keydown', onKeyDown);
      picker.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (this.calendarPickerCleanup === cleanup) this.calendarPickerCleanup = null;
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    this.calendarPickerCleanup = cleanup;
    anchor.setAttribute('aria-expanded', 'true');
    picker.addEventListener('keydown', onKeyDown);
    const selectedOption = picker.querySelector<HTMLElement>('button.is-active');
    const firstOption = picker.querySelector<HTMLElement>('button:not(:disabled)');
    (selectedOption ?? firstOption)?.focus({ preventScroll: true });
    registrationTimer = window.setTimeout(() => {
      registrationTimer = undefined;
      if (this.calendarPickerCleanup !== cleanup || !picker.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
  }

  private render(): void {
    this.clearTaskDatePicker();
    this.dismissRecurrenceEditor();
    this.viewStatePopoverCleanup?.();
    this.clearSearchShell();

    const mode = this.state.get('mode');

    if (mode !== 'search') {
      this.md.unload();
      this.md = new Component();
      this.md.load();
    }

    if (mode !== 'projects') this.destroyProjectsPanel();

    if (mode === 'calendar') {
      // Explicit refreshes (configuration/theme/view changes) remain full renders.
      this.captureActiveTimedBlockFocus();
      this.pendingCalScrollTop = this.el.querySelector<HTMLElement>('.tc-tg-grid-row')?.scrollTop;
      this.el.empty();
      this.el.addClass('tc-center--calendar');
      this.destroyCalendarView();
      this.renderCalendarMode();
      return;
    }

    this.el.removeClass('tc-center--calendar');
    this.destroyCalendarView();
    this.el.empty();

    if (mode === 'search') {
      this.renderSearch();
      return;
    }

    if (mode === 'projects') {
      this.el.addClass('tc-center--projects');
      if (this.projectStore && this.projectManager) {
        // Rebuild the panel fresh; it owns its own subscriptions and cleans them
        // up in destroy(), so recreating on each render is leak-free.
        this.destroyProjectsPanel();
        this.projectsPanel = new ProjectsPanel(
          this.state,
          this.projectStore,
          this.projectManager,
          this.settings,
          this.app,
          { renderTasks: (host, path) => this.renderProjectTasks(host, path) },
        );
        // Mount into a dedicated child so ProjectsPanel's own class/DOM never
        // lands on the shared center element (which would leak layout into tasks mode).
        const host = this.el.createDiv({ cls: 'tc-projects-host' });
        this.projectsPanel.mount(host);
      } else {
        this.el.createDiv({ cls: 'tc-center-empty', text: 'Projects unavailable' });
      }
      return;
    }
    this.el.removeClass('tc-center--projects');

    // Header: title + right-aligned [chips] [↕] [search]
    const header = this.el.createDiv({ cls: 'tc-center-header' });
    header.createEl('h2', { cls: 'tc-center-title', text: this.getTitle() });

    const controls = header.createDiv({ cls: 'tc-center-controls' });
    this.renderPropertyChips(controls);
    this.renderViewStateButton(controls);

    const searchInput = controls.createEl('input', {
      cls: 'tc-center-search',
      attr: { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter tasks' },
    });
    searchInput.value = this.state.get('centerFilter');
    // Restore focus + caret after a debounced filter re-render so typing stays smooth.
    if (this.refocusSearch) {
      this.refocusSearch = false;
      window.setTimeout(() => {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }, 0);
    }
    // Debounce: each keystroke would otherwise re-render the whole list (running the
    // markdown pipeline per task) — costly at hundreds of tasks. Apply after a pause.
    searchInput.addEventListener('input', () => {
      window.clearTimeout(this.filterDebounce);
      this.filterDebounce = window.setTimeout(() => {
        this.refocusSearch = true;
        this.state.set('centerFilter', searchInput.value);
      }, 150);
    });

    const tasks = this.getFilteredTasks();
    const scroll = this.el.createDiv({ cls: 'tc-center-scroll' });

    if (tasks.length === 0) {
      scroll.createDiv({ cls: 'tc-center-empty', text: 'No tasks' });
    } else {
      this.renderWithGrouping(scroll, tasks);
    }

    this.renderAddTaskBar();
    this.reconcileTaskSelection(this.visibleTaskKeys());
    this.updateSelectionVisuals();
    this.completeTaskCardRender();
  }

  private renderCalendarMode(): void {
    const forecastMenuOwner =
      this.forecastMenuOwner ?? createForecastContextMenuOwner(this.el.ownerDocument);
    this.forecastMenuOwner = forecastMenuOwner;
    const projectionDiagnosticOwner = createCalendarProjectionDiagnosticOwner(
      this.el.ownerDocument,
    );
    this.projectionDiagnosticOwner = projectionDiagnosticOwner;
    const nav = this.el.createDiv({ cls: 'tc-cal-nav' });

    const leftGroup = nav.createDiv({ cls: 'tc-cal-nav-left' });
    const prevBtn = leftGroup.createEl('button', {
      cls: 'tc-cal-nav-btn',
      attr: { 'aria-label': 'Previous' },
    });
    setIcon(prevBtn, 'chevron-left');

    const titleGroup = leftGroup.createDiv({ cls: 'tc-cal-nav-title-group' });
    const monthBtn = titleGroup.createEl('button', {
      cls: 'tc-cal-nav-month',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    const yearBtn = titleGroup.createEl('button', {
      cls: 'tc-cal-nav-year',
      attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });

    const nextBtn = leftGroup.createEl('button', {
      cls: 'tc-cal-nav-btn',
      attr: { 'aria-label': 'Next' },
    });
    setIcon(nextBtn, 'chevron-right');

    const rightGroup = nav.createDiv({ cls: 'tc-cal-nav-right' });
    const todayBtn = rightGroup.createEl('button', { cls: 'tc-cal-nav-today', text: 'Today' });

    const viewSwitcher = rightGroup.createDiv({ cls: 'tc-cal-view-switcher' });
    const CAL_VIEWS = ['today', 'week', 'month'] as const;
    for (const v of CAL_VIEWS) {
      const btn = viewSwitcher.createEl('button', {
        cls: `tc-cal-view-btn${this.calViewType === v ? ' is-active' : ''}`,
        text: v === 'today' ? 'Day' : v.charAt(0).toUpperCase() + v.slice(1),
      });
      btn.addEventListener('click', () => {
        this.cancelKeyboardInteraction();
        this.calViewType = v;
        if (v === 'week') this.calDate = window.moment().startOf('isoWeek');
        else if (v === 'today') this.calDate = window.moment();
        else this.calDate = window.moment().date(1);
        this.render();
      });
    }

    const viewContainer = this.el.createDiv({ cls: 'tc-cal-body' });

    const updateTitle = (): void => {
      if (this.calViewType === 'week') {
        monthBtn.textContent = `Week ${this.calDate.format('w')}`;
        yearBtn.textContent = this.calDate.format('YYYY');
      } else if (this.calViewType === 'today') {
        monthBtn.textContent = this.calDate.format('MMMM D');
        yearBtn.textContent = this.calDate.format('YYYY');
      } else {
        monthBtn.textContent = this.calDate.format('MMMM');
        yearBtn.textContent = this.calDate.format('YYYY');
      }
    };
    updateTitle();

    const handleTaskClick = (t: TaskSnapshot): void => {
      if (calendarRootTaskRef(t) === undefined) return;
      this.taskModal?.open(t);
    };
    const handleForecastClick = (source: CalendarTaskSource, referenceDate: LocalDate): void => {
      this.taskModal?.open(source.root);
      const modal = activeDocument.querySelector<HTMLElement>('.tc-modal');
      if (!modal) return;
      const context = modal.createDiv({
        cls: 'tc-forecast-source-context',
        text: `Forecast for ${referenceDate}`,
      });
      modal.prepend(context);
    };
    const handleForecastContextMenu = (source: CalendarTaskSource): void => {
      this.openForecastRecurrenceEditor(viewContainer, source);
    };
    const handleDrop = (dragData: string, targetDate: string): void => {
      void this.rescheduleTask(dragData, targetDate);
    };
    const handleDropTime = (dragData: string, date: string, time: string): void => {
      void this.setTaskTimeFromDrop(dragData, date, time);
    };
    const handleTimeChange = (t: TaskSnapshot, newStartMinutes: number): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskTime(t, newStartMinutes);
    };
    const handleDurationChange = (t: TaskSnapshot, newDurationMinutes: number): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskDuration(t, newDurationMinutes);
    };
    const handleTimedMove = (t: TaskSnapshot, target: TimedDragTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedMove(t, target);
    };
    const handleTimedDuration = (t: TaskSnapshot, target: TimedVerticalResizeTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedDuration(t, target);
    };
    const handleTimedBoundary = (t: TaskSnapshot, target: TimedBoundaryTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedBoundary(t, target);
    };
    const handleSpanMove = (t: TaskSnapshot, target: SpanMoveTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitSpanMove(t, target);
    };
    const handleSpanBoundary = (t: TaskSnapshot, target: InteractiveSpanBoundaryTarget): void => {
      if (isForecastCalendarTask(t)) return;
      void this.commitTimedBoundary(t, target);
    };
    const handleStartChange = (t: TaskSnapshot, newStart: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.updateTaskStart(t, newStart);
    };
    const handleDueChange = (t: TaskSnapshot, newDue: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.rescheduleTaskDue(t, newDue);
    };
    const handleExtendToSpan = (t: TaskSnapshot, newDue: string): void => {
      if (isForecastCalendarTask(t)) return;
      void this.extendTaskToSpan(t, newDue);
    };
    const handleKeyboardIntent = (task: TaskSnapshot, intent: TimedBlockKeyboardIntent): void => {
      if (calendarRootTaskRef(task) === undefined) return;
      if (!this.keyboardQueue) return;
      const active = this.el.ownerDocument.activeElement;
      const originElement = isRealmHTMLElement(active)
        ? (active.closest<HTMLElement>('.tc-tg-block') ?? undefined)
        : undefined;
      const previousQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      const focusSequence = ++this.nextTimedBlockFocusSequence;
      const provisionalFocus: TimedBlockFocusLocator = {
        filePath: task.source.filePath,
        line: task.source.line,
        segmentDate: originElement?.dataset['tgSegmentDate'],
        sequence: focusSequence,
        originElement,
      };
      this.pendingTimedBlockFocus = provisionalFocus;
      const queueSequence = this.keyboardQueue.enqueue(task, intent);
      if (queueSequence === undefined) {
        if (this.pendingTimedBlockFocus?.sequence === focusSequence) {
          this.clearTimedBlockFocus();
        }
        if (previousQueueSequence !== undefined) {
          this.clearKeyboardSequenceState(previousQueueSequence);
        }
        return;
      }
      if (this.pendingTimedBlockFocus?.sequence !== focusSequence) return;
      if (previousQueueSequence !== undefined && previousQueueSequence !== queueSequence) {
        this.clearKeyboardSequenceState(previousQueueSequence);
      }
      this.settledKeyboardSequences.delete(queueSequence);
      if (previousQueueSequence !== queueSequence) {
        this.restoredKeyboardSequences.delete(queueSequence);
        this.committedKeyboardSequences.delete(queueSequence);
      }
      this.pendingTimedBlockFocus = {
        ...provisionalFocus,
        queueSequence,
      };
    };
    const handleCreateAtTime = (date: string, time: string): void => {
      const dayColumn = viewContainer.querySelector<HTMLElement>(
        `.tc-tg-day-column[data-tg-date="${date}"]`,
      );
      const hourColumnEl = dayColumn?.querySelector<HTMLElement>('.tc-tg-hour-column');
      if (!hourColumnEl) return;
      this.showTimeGridQuickAdd(hourColumnEl, date, time);
    };
    const handleCreateAtDate = (date: string): void => {
      const cell = viewContainer.querySelector<HTMLElement>(`[data-mg-date="${date}"]`);
      if (!cell) return;
      this.showFillCellQuickAdd(cell, date, 'tc-mg-quick-add');
    };
    const handleCreateAtDateAllDay = (date: string): void => {
      // Scoped to .tc-tg-allday-cell specifically: HourGrid.ts's day-column element also
      // carries data-tg-date (for edge-resize date resolution), so a bare attribute selector
      // would risk matching the wrong element.
      const cell = viewContainer.querySelector<HTMLElement>(
        `.tc-tg-allday-cell[data-tg-date="${date}"]`,
      );
      if (!cell) return;
      this.showFillCellQuickAdd(cell, date, 'tc-tg-allday-quick-add');
    };

    const startPositionFor = (viewType: CalViewType, firstDayOfWeek: number): string => {
      if (viewType === 'week') {
        return firstVisibleWeekDate(this.calDate, firstDayOfWeek);
      }
      if (viewType === 'today') return this.calDate.format('YYYY-MM-DD');
      return this.calDate.format('YYYY-MM');
    };

    const currentCalendarContent = (): {
      readonly config: ResolvedConfig;
      readonly issues: readonly CalendarProjectionIssue[];
      readonly tasks: TaskSnapshot[];
    } => {
      const firstDayOfWeek =
        this.settings.desktop.firstDayOfWeek ?? DEFAULT_VIEW_CONFIG.firstDayOfWeek;
      const config: ResolvedConfig = {
        ...DEFAULT_VIEW_CONFIG,
        ...this.settings.desktop,
        isMobile: false,
        sourceNoteDisplay: this.settings.sourceNoteDisplay,
        customFilePath: this.settings.customFilePath,
        startPosition: startPositionFor(this.calViewType, firstDayOfWeek),
      };
      const visibleDates = visibleCalendarDates(
        this.calViewType,
        this.calDate,
        config.firstDayOfWeek,
      );
      const projection = this.queries.forCalendarProjection(
        visibleDates as unknown as readonly LocalDate[],
      );
      const occurrences = projectCalendarOccurrences(
        projection,
        {
          from: localDate(visibleDates[0]!),
          to: localDate(visibleDates[visibleDates.length - 1]!),
        },
        { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      );
      return {
        config,
        issues: occurrences.issues,
        tasks: occurrences.occurrences.map(taskSnapshotForCalendarOccurrence),
      };
    };

    const mountView = (): void => {
      this.dismissRecurrenceEditor();
      forecastMenuOwner.dismiss();
      this.captureActiveTimedBlockFocus();
      const pendingQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      if (pendingQueueSequence !== undefined) {
        this.restoredKeyboardSequences.delete(pendingQueueSequence);
      }
      const renderGeneration = ++this.calendarRenderGeneration;
      // Full mounts replace the grid, so carry its native scroll position when this is an
      // explicit same-date refresh. Query notifications never enter this path: patchView retains
      // the grid itself. The fallback covers render() emptying the outer center before this
      // closure can inspect its former viewContainer.
      const outgoingGridRow = viewContainer.querySelector<HTMLElement>('.tc-tg-grid-row');
      const preservedScrollTop = outgoingGridRow
        ? outgoingGridRow.scrollTop
        : this.pendingCalScrollTop;
      this.pendingCalScrollTop = undefined;

      this.calViewInstance?.destroy();
      viewContainer.empty();
      const { config, issues, tasks } = currentCalendarContent();

      // Only scroll-to-now when this (viewType, date) pair is new. Explicit same-date refreshes
      // must not jump back to center; query patches do not invoke this full-mount path.
      const scrollKey = `${this.calViewType}:${this.calDate.format('YYYY-MM-DD')}`;
      const shouldScrollToNow = scrollKey !== this.lastScrolledCalKey;
      this.lastScrolledCalKey = scrollKey;

      if (this.calViewType === 'today') {
        this.calViewInstance = new TodayView({
          app: this.app,
          forecastMenuOwner,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          onDrop: handleDrop,
          onDropTime: handleDropTime,
          onCreateAtTime: handleCreateAtTime,
          onCreateAtDate: handleCreateAtDateAllDay,
          onTimeChange: handleTimeChange,
          onDurationChange: handleDurationChange,
          onTimedMove: handleTimedMove,
          onTimedDuration: handleTimedDuration,
          onTimedBoundary: handleTimedBoundary,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onStartChange: handleStartChange,
          onDueChange: handleDueChange,
          onExtendToSpan: handleExtendToSpan,
          onKeyboardIntent: handleKeyboardIntent,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          onEditRepeat: (t, anchor) => this.openRecurrenceEditor(anchor, t),
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      } else if (this.calViewType === 'week') {
        this.calViewInstance = new WeekTimeGridView({
          app: this.app,
          forecastMenuOwner,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          onDrop: handleDrop,
          onDropTime: handleDropTime,
          onCreateAtTime: handleCreateAtTime,
          onCreateAtDate: handleCreateAtDateAllDay,
          onDayHeaderClick: (date) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'today';
            this.calDate = window.moment(date);
            this.render();
          },
          onTimeChange: handleTimeChange,
          onDurationChange: handleDurationChange,
          onTimedMove: handleTimedMove,
          onTimedDuration: handleTimedDuration,
          onTimedBoundary: handleTimedBoundary,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onStartChange: handleStartChange,
          onDueChange: handleDueChange,
          onExtendToSpan: handleExtendToSpan,
          onKeyboardIntent: handleKeyboardIntent,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          onEditRepeat: (t, anchor) => this.openRecurrenceEditor(anchor, t),
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      } else {
        this.calViewInstance = new MonthGridView({
          app: this.app,
          forecastMenuOwner,
          onDayClick: (date) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'today';
            this.calDate = window.moment(date);
            this.render();
          },
          onCreateAtDate: handleCreateAtDate,
          onTaskClick: handleTaskClick,
          onForecastClick: handleForecastClick,
          onForecastContextMenu: handleForecastContextMenu,
          onDrop: handleDrop,
          onSpanMove: handleSpanMove,
          onSpanBoundary: handleSpanBoundary,
          onToggle: (t) => {
            void this.toggleTask(t);
          },
          onSetStatus: (t, status) => {
            void this.setTaskStatus(t, status);
          },
          onSetPriority: (t, priority) => {
            void this.setPriority(t, priority);
          },
          onEditRepeat: (t, anchor) => this.openRecurrenceEditor(anchor, t),
          onWeekClick: (wk, yr) => {
            this.cancelKeyboardInteraction();
            this.calViewType = 'week';
            this.calDate = window
              .moment()
              .isoWeekYear(parseInt(yr, 10))
              .isoWeek(parseInt(wk, 10))
              .startOf('isoWeek');
            this.render();
          },
          statusRegistry: this.statusRegistry,
          tagGroups: this.settings.tagGroups,
        });
      }
      this.calViewInstance.render(
        viewContainer,
        tasks,
        config,
        shouldScrollToNow,
        preservedScrollTop,
      );
      projectionDiagnosticOwner.update(viewContainer, issues);
      this.deferTimedBlockFocus(viewContainer, renderGeneration);
    };

    const patchView = (): void => {
      if (!this.calViewInstance) {
        mountView();
        return;
      }
      this.dismissRecurrenceEditor();
      forecastMenuOwner.dismiss();
      this.captureActiveTimedBlockFocus();
      const pendingQueueSequence = this.pendingTimedBlockFocus?.queueSequence;
      if (pendingQueueSequence !== undefined) {
        this.restoredKeyboardSequences.delete(pendingQueueSequence);
      }
      const renderGeneration = ++this.calendarRenderGeneration;
      const { config, issues, tasks } = currentCalendarContent();
      this.calViewInstance.patch(viewContainer, tasks, config);
      projectionDiagnosticOwner.update(viewContainer, issues);
      this.deferTimedBlockFocus(viewContainer, renderGeneration);
    };

    mountView();

    // Month/year/prev/next/today nav — unchanged from the existing implementation
    monthBtn.addEventListener('click', () => {
      const existing = this.el.querySelector('.tc-month-picker');
      if (existing) {
        this.clearCalendarPicker();
        return;
      }
      this.clearCalendarPicker();
      const picker = this.el.createDiv({
        cls: 'tc-month-picker tc-popover',
        attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select month' },
      });
      const MONTH_NAMES = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      MONTH_NAMES.forEach((m, i) => {
        const selected = i === this.calDate.month();
        const btn = picker.createEl('button', {
          cls: 'tc-month-picker-btn',
          text: m,
          attr: { 'aria-pressed': String(selected) },
        });
        if (selected) btn.addClass('is-active');
        btn.addEventListener('click', () => {
          this.cancelKeyboardInteraction();
          this.clearCalendarPicker(true);
          this.calDate = this.calDate.clone().month(i).date(1);
          updateTitle();
          mountView();
        });
      });
      monthBtn.after(picker);
      this.armCalendarPicker(picker, monthBtn);
    });

    yearBtn.addEventListener('click', () => {
      const existing = this.el.querySelector('.tc-year-picker');
      if (existing) {
        this.clearCalendarPicker();
        return;
      }
      this.clearCalendarPicker();
      const picker = this.el.createDiv({
        cls: 'tc-year-picker tc-popover',
        attr: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Select year' },
      });
      const currentYear = this.calDate.year();
      for (let y = currentYear - 5; y <= currentYear + 5; y++) {
        const selected = y === currentYear;
        const btn = picker.createEl('button', {
          cls: 'tc-year-picker-btn',
          text: String(y),
          attr: { 'aria-pressed': String(selected) },
        });
        if (selected) btn.addClass('is-active');
        btn.addEventListener('click', () => {
          this.cancelKeyboardInteraction();
          this.clearCalendarPicker(true);
          this.calDate = this.calDate.clone().year(y).date(1);
          updateTitle();
          mountView();
        });
      }
      yearBtn.after(picker);
      this.armCalendarPicker(picker, yearBtn);
    });

    prevBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week')
        this.calDate = this.calDate.clone().subtract(7, 'days').startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = this.calDate.clone().subtract(1, 'day');
      else this.calDate = this.calDate.clone().subtract(1, 'months').date(1);
      updateTitle();
      mountView();
    });

    nextBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week')
        this.calDate = this.calDate.clone().add(7, 'days').startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = this.calDate.clone().add(1, 'day');
      else this.calDate = this.calDate.clone().add(1, 'months').date(1);
      updateTitle();
      mountView();
    });

    todayBtn.addEventListener('click', () => {
      this.cancelKeyboardInteraction();
      if (this.calViewType === 'week') this.calDate = window.moment().startOf('isoWeek');
      else if (this.calViewType === 'today') this.calDate = window.moment();
      else this.calDate = window.moment().date(1);
      updateTitle();
      mountView();
    });

    this.calUnsubscribe = this.queries.subscribe(() => patchView());
  }

  private cancelKeyboardInteraction(): void {
    this.keyboardQueue?.cancel();
    this.pendingTimedBlockFocus = undefined;
    this.settledKeyboardSequences.clear();
    this.restoredKeyboardSequences.clear();
    this.committedKeyboardSequences.clear();
    this.pendingTimedBlockRestorations.clear();
    this.calendarRenderGeneration += 1;
  }

  private captureActiveTimedBlockFocus(): void {
    if (this.pendingTimedBlockFocus?.queueSequence !== undefined) return;
    const active = this.el.ownerDocument.activeElement;
    if (!isRealmHTMLElement(active) || !this.el.contains(active)) return;
    const block = active.closest<HTMLElement>('.tc-tg-block');
    if (!block) return;
    this.retainTimedBlockFocus(block);
  }

  private retainTimedBlockFocus(block: HTMLElement): void {
    const filePath = block.dataset['tcTaskFile'];
    const lineText = block.dataset['tcTaskLine'];
    if (filePath === undefined || lineText === undefined) return;
    const line = Number(lineText);
    if (!Number.isInteger(line)) return;
    const segmentDate = block.dataset['tgSegmentDate'];

    const pending = this.pendingTimedBlockFocus;
    const isDifferentPreCommitOrigin =
      pending?.queueSequence !== undefined &&
      !this.committedKeyboardSequences.has(pending.queueSequence) &&
      pending.originElement !== undefined &&
      block !== pending.originElement;
    if (isDifferentPreCommitOrigin) {
      this.keyboardQueue?.cancel();
      this.clearTimedBlockFocus(pending.queueSequence);
      this.pendingTimedBlockFocus = {
        filePath,
        line,
        segmentDate,
        sequence: ++this.nextTimedBlockFocusSequence,
        originElement: block,
      };
      return;
    }
    if (
      pending?.filePath === filePath &&
      pending.line === line &&
      pending.segmentDate === segmentDate
    )
      return;
    if (pending?.queueSequence !== undefined) {
      this.keyboardQueue?.cancel();
      this.clearKeyboardSequenceState(pending.queueSequence);
    }
    this.pendingTimedBlockFocus = {
      filePath,
      line,
      segmentDate,
      sequence: ++this.nextTimedBlockFocusSequence,
      originElement: block,
    };
  }

  private deferTimedBlockFocus(container: HTMLElement, renderGeneration: number): void {
    const scheduled = this.pendingTimedBlockFocus;
    if (!scheduled) return;
    const focusSequence = scheduled.sequence;
    const queueSequence = scheduled.queueSequence;
    if (queueSequence !== undefined && !this.committedKeyboardSequences.has(queueSequence)) return;

    const scheduledCandidate = Array.from(
      container.querySelectorAll<HTMLElement>('.tc-tg-block'),
    ).find(
      (block) =>
        block.dataset['tcTaskFile'] === scheduled.filePath &&
        block.dataset['tcTaskLine'] === String(scheduled.line) &&
        (scheduled.segmentDate === undefined ||
          block.dataset['tgSegmentDate'] === scheduled.segmentDate),
    );
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const restorationId =
      queueSequence !== undefined &&
      scheduledCandidate?.isConnected === true &&
      scheduledCandidate !== scheduled.originElement
        ? ++this.nextTimedBlockRestoration
        : undefined;
    if (restorationId !== undefined && queueSequence !== undefined) {
      this.pendingTimedBlockRestorations.set(restorationId, {
        queueSequence,
        focusSequence,
        renderGeneration,
      });
    }

    window.setTimeout(() => {
      if (
        restorationId !== undefined &&
        !this.pendingTimedBlockRestorations.delete(restorationId)
      ) {
        return;
      }
      if (renderGeneration !== this.calendarRenderGeneration) return;
      const pending = this.pendingTimedBlockFocus;
      if (!pending || pending.sequence !== focusSequence || this.state.get('mode') !== 'calendar')
        return;
      if (
        pending.queueSequence !== undefined &&
        !this.committedKeyboardSequences.has(pending.queueSequence)
      ) {
        return;
      }
      const candidate = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block')).find(
        (block) =>
          block.dataset['tcTaskFile'] === pending.filePath &&
          block.dataset['tcTaskLine'] === String(pending.line) &&
          (pending.segmentDate === undefined ||
            block.dataset['tgSegmentDate'] === pending.segmentDate),
      );
      if (
        !candidate?.isConnected ||
        !isRealmHTMLElement(candidate) ||
        candidate.ownerDocument !== this.el.ownerDocument
      ) {
        return;
      }
      candidate.focus();
      candidate.classList.add('is-selected');
      if (
        candidate.ownerDocument.activeElement !== candidate ||
        this.pendingTimedBlockFocus?.sequence !== pending.sequence
      ) {
        return;
      }
      if (pending.queueSequence === undefined) {
        this.clearTimedBlockFocus();
        return;
      }
      this.restoredKeyboardSequences.add(pending.queueSequence);
      if (this.settledKeyboardSequences.has(pending.queueSequence)) {
        this.clearTimedBlockFocus(pending.queueSequence);
      }
    }, 0);
  }

  private clearTimedBlockFocus(queueSequence?: number): void {
    const pending = this.pendingTimedBlockFocus;
    if (queueSequence !== undefined && pending?.queueSequence !== queueSequence) return;
    const ownedSequence = pending?.queueSequence ?? queueSequence;
    if (ownedSequence !== undefined) {
      this.clearKeyboardSequenceState(ownedSequence);
    }
    this.pendingTimedBlockFocus = undefined;
  }

  private hasPendingTimedBlockRestoration(queueSequence: number): boolean {
    const pending = this.pendingTimedBlockFocus;
    if (!pending || pending.queueSequence !== queueSequence) return false;
    return Array.from(this.pendingTimedBlockRestorations.values()).some(
      (restoration) =>
        restoration.queueSequence === queueSequence &&
        restoration.focusSequence === pending.sequence &&
        restoration.renderGeneration === this.calendarRenderGeneration,
    );
  }

  private clearKeyboardSequenceState(queueSequence: number): void {
    this.settledKeyboardSequences.delete(queueSequence);
    this.restoredKeyboardSequences.delete(queueSequence);
    this.committedKeyboardSequences.delete(queueSequence);
    for (const [id, restoration] of this.pendingTimedBlockRestorations) {
      if (restoration.queueSequence === queueSequence) {
        this.pendingTimedBlockRestorations.delete(id);
      }
    }
  }

  private handleKeyboardCommit(
    updated: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    queueSequence: number,
    changed: boolean,
  ): void {
    let pending = this.pendingTimedBlockFocus;
    if (
      !pending ||
      pending.queueSequence !== queueSequence ||
      this.state.get('mode') !== 'calendar'
    ) {
      return;
    }
    this.committedKeyboardSequences.add(queueSequence);
    const sourceChanged =
      pending.filePath !== updated.source.filePath || pending.line !== updated.source.line;
    let nextSegmentDate = pending.segmentDate;
    if (changed && intent.type === 'shift-schedule' && pending.segmentDate !== undefined) {
      try {
        nextSegmentDate = shiftLocalDate(localDate(pending.segmentDate), intent.days);
      } catch {
        nextSegmentDate = pending.segmentDate;
      }
    }
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    if (changed || sourceChanged || segmentChanged) {
      this.restoredKeyboardSequences.delete(queueSequence);
    }
    if (sourceChanged || segmentChanged) {
      pending = {
        ...pending,
        filePath: updated.source.filePath,
        line: updated.source.line,
        segmentDate: nextSegmentDate,
        sequence: ++this.nextTimedBlockFocusSequence,
      };
      this.pendingTimedBlockFocus = pending;
    }
    if (
      changed ||
      sourceChanged ||
      segmentChanged ||
      !this.restoredKeyboardSequences.has(queueSequence)
    ) {
      this.deferTimedBlockFocus(this.el, this.calendarRenderGeneration);
    }
    if (intent.type !== 'shift-schedule') return;

    const anchor =
      updated.planning.start && updated.planning.due
        ? updated.planning.due
        : (updated.planning.scheduled ?? updated.planning.due);
    const followDate = nextSegmentDate ?? anchor;
    if (!followDate) return;

    const firstDayOfWeek =
      this.settings.desktop.firstDayOfWeek ?? DEFAULT_VIEW_CONFIG.firstDayOfWeek;
    const shouldFollow =
      this.calViewType === 'today' ||
      (this.calViewType === 'week' &&
        !visibleCalendarDates('week', this.calDate, firstDayOfWeek).includes(followDate));
    if (!shouldFollow) return;
    this.calDate = window.moment(followDate);
    this.render();
  }

  private renderSearch(): void {
    const header = this.el.createDiv({ cls: 'tc-center-header' });
    header.createEl('h2', { cls: 'tc-center-title', text: 'Search' });
    const input = header.createEl('input', {
      cls: 'tc-center-search tc-search-global',
      attr: { type: 'text', placeholder: 'Search all tasks…', 'aria-label': 'Search all tasks' },
    });
    input.value = this.state.get('searchQuery');
    input.addEventListener('input', () => this.state.set('searchQuery', input.value));
    this.searchInputEl = input;

    const results = this.el.createDiv({ cls: 'tc-center-scroll' });
    this.searchResultsEl = results;
    this.renderSearchResults(results, input.value);

    window.setTimeout(() => {
      if (this.searchInputEl === input && input.isConnected) input.focus();
    }, 0);
  }

  private handleSearchQueryChanged(query: string): void {
    if (
      this.state.get('mode') !== 'search' ||
      !this.searchInputEl?.isConnected ||
      !this.searchResultsEl?.isConnected
    ) {
      this.render();
      return;
    }
    if (this.searchInputEl.value !== query) this.searchInputEl.value = query;
    this.scheduleSearchResults(query);
  }

  private scheduleSearchResults(query: string): void {
    if (this.searchResultsFrame !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame);
    }
    this.searchResultsFrame = window.requestAnimationFrame(() => {
      this.searchResultsFrame = null;
      const input = this.searchInputEl;
      const results = this.searchResultsEl;
      if (this.state.get('mode') !== 'search' || !input?.isConnected || !results?.isConnected) {
        return;
      }
      this.renderSearchResults(results, query);
    });
  }

  private clearSearchShell(): void {
    if (this.searchResultsFrame !== null) {
      window.cancelAnimationFrame(this.searchResultsFrame);
      this.searchResultsFrame = null;
    }
    this.searchInputEl = null;
    this.searchResultsEl = null;
  }

  private renderSearchResults(host: HTMLElement, query: string): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();
    host.empty();
    host.toggleClass('tc-search-empty', query.length === 0);

    if (!query) {
      host.createEl('p', { cls: 'tc-empty-state', text: 'Type to search tasks…' });
      this.completeTaskCardRender();
      return;
    }

    const matchingTasks = [...searchTaskList(this.queries.list(), query)];
    if (matchingTasks.length === 0) {
      host.createDiv({ cls: 'tc-center-empty', text: 'No results' });
      this.completeTaskCardRender();
      return;
    }
    this.renderFlat(host, matchingTasks);

    // Navigate to task in tasks mode when clicking a search result
    host.querySelectorAll<HTMLElement>('.tc-task-card').forEach((cardEl, idx) => {
      const task = matchingTasks[idx];
      if (!task) return;
      cardEl.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          const todayStr = localDate(window.moment().format('YYYY-MM-DD'));
          const d = task.planning.due ?? task.planning.scheduled;
          let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
          if ((task.planning.due && task.planning.due < todayStr) || d === todayStr) {
            list = 'today';
          } else if (d && d > todayStr) {
            list = 'upcoming';
          }
          this.state.set('selectedList', list);
          this.state.set('mode', 'tasks');
          this.state.set('taskStack', [task]);
        },
        { capture: true },
      );
    });
    this.completeTaskCardRender();
  }

  private renderWithGrouping(container: HTMLElement, tasks: TaskSnapshot[]): void {
    const vs = this.state.get('centerListViewState');
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');

    if (vs.groupBy === 'none') {
      this.renderFlat(container, tasks);
      return;
    }

    let groups: Array<{ label: string; tasks: TaskSnapshot[] }>;
    if (vs.groupBy === 'date') {
      groups = groupTasksByDate(tasks, today, tomorrow);
    } else if (vs.groupBy === 'priority') {
      groups = groupTasksByPriority(tasks);
    } else if (vs.groupBy === 'status') {
      groups = groupTasksByStatus(tasks, this.statusRegistry);
    } else {
      groups = groupTasksByTag(tasks);
    }

    let firstGroup = true;
    for (const group of groups) {
      if (group.tasks.length === 0) continue;
      const cls = firstGroup ? 'tc-group-header tc-group-header--first' : 'tc-group-header';
      container.createDiv({ cls, text: `${group.label}  ${group.tasks.length}` });
      firstGroup = false;
      for (const task of group.tasks) this.renderTaskCard(container, task);
    }
  }

  private renderFlat(container: HTMLElement, tasks: TaskSnapshot[]): void {
    for (const task of tasks) this.renderTaskCard(container, task);
  }

  private renderTaskCard(container: HTMLElement, task: TaskSnapshot): void {
    const stack = this.state.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    const isSelected =
      root !== undefined &&
      'source' in root &&
      current !== undefined &&
      taskNodeLine(root, current) === task.source.line &&
      root.source.filePath === task.source.filePath;

    const card = container.createDiv({
      cls: `tc-task-card${isSelected ? ' is-selected' : ''}`,
      attr: { tabindex: '-1' },
    });
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);

    const mainRow = card.createDiv({ cls: 'tc-task-card-main-row' });

    renderStatusMarker(mainRow, {
      task,
      registry: this.statusRegistry,
      onLeftClick: () => void this.toggleTask(task),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        const anchor = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : card;
        showStatusMenuAt(ev, {
          task,
          registry: this.statusRegistry,
          owner: this.md,
          onPickStatus: (c) => void this.setTaskStatus(task, c),
          onPickPriority: (p) => void this.setPriority(task, p),
          onEditRepeat: () => this.openRecurrenceEditor(anchor, task),
        });
      },
    });

    // Pre-compute metadata needed in both body and meta-right
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const sel = this.state.get('selectedList');
    const d = task.planning.due ?? task.planning.scheduled; // only explicit dates show a badge
    const tags = task.tags ?? [];
    const subtaskCount = task.subtasks?.length ?? 0;
    const commentCount = task.comments?.length ?? 0;
    const doneCount = task.subtasks?.filter((s) => s.status === 'done').length ?? 0;
    const suppressToday = sel === 'today' && d === today;

    const body = mainRow.createDiv({ cls: 'tc-task-body' });
    const titleRow = body.createDiv({ cls: 'tc-task-title-row' });

    if (task.recurrence) {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(task.recurrence));
    }

    // Count badges BEFORE title text so they're seen while reading left-to-right
    if (subtaskCount > 0) {
      const badge = titleRow.createEl('span', { cls: 'tc-task-count-badge' });
      setIcon(badge, 'check-square');
      badge.createEl('span', { text: `${doneCount}/${subtaskCount}` });
    }
    if (commentCount > 0) {
      const badge = titleRow.createEl('span', { cls: 'tc-task-count-badge' });
      setIcon(badge, 'message-square');
      badge.createEl('span', { text: String(commentCount) });
    }
    // Attached materials: link count precomputed by TaskIndex (no per-render parsing).
    const linkCount = task.presentation.linkCount ?? 0;
    if (linkCount > 0) {
      const badge = titleRow.createEl('span', { cls: 'tc-task-count-badge' });
      setIcon(badge, 'paperclip');
      badge.createEl('span', { text: String(linkCount) });
    }

    const titleEl = titleRow.createEl('span', { cls: 'tc-task-title' });
    renderTaskText(titleEl, task.markdownTitle, {
      app: this.app,
      sourcePath: task.source.filePath,
      component: this.md,
      onEditLink: (occ, token) => this.editTaskLink(task, occ, token),
    });
    if (task.description) {
      const descEl = card.createDiv({ cls: 'tc-task-desc' });
      // Render the first description line as markdown so links are clickable here too.
      // No onEditLink: the card is a compact preview; link editing happens in the panel.
      renderTaskText(descEl, task.description.split('\n')[0] ?? '', {
        app: this.app,
        sourcePath: task.source.filePath,
        component: this.md,
      });
    }

    const showSourceNote = shouldShowSourceNote(
      task,
      this.settings.sourceNoteDisplay,
      this.settings.customFilePath,
    );
    const hasRightMeta =
      showSourceNote || (d && !suppressToday) || task.planning.time || tags.length > 0;
    if (hasRightMeta) {
      const metaRight = mainRow.createDiv({ cls: 'tc-task-meta-right' });

      // Date + optional time: date part and time part are separately clickable
      if (d && !suppressToday) {
        const dateEl = metaRight.createEl('span', {
          cls: `tc-task-date ${this.getDateClass(d)}`.trim(),
        });
        // Date part: calendar icon + date text — click to filter by date
        const datePart = dateEl.createEl('span', { cls: 'tc-task-date-part tc-cursor-pointer' });
        const calIcon = datePart.createEl('span', { cls: 'tc-date-icon' });
        setIcon(calIcon, 'calendar');
        datePart.createEl('span', { text: this.formatDate(d) });
        datePart.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addPropertyFilter({ type: 'date', value: d });
        });
        // Time part: clock icon + time text — click to filter by time
        if (task.planning.time) {
          const timePart = dateEl.createEl('span', { cls: 'tc-task-time-part tc-cursor-pointer' });
          const clockIcon = timePart.createEl('span', { cls: 'tc-date-icon' });
          setIcon(clockIcon, 'clock');
          timePart.createEl('span', { text: task.planning.time });
          timePart.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addPropertyFilter({ type: 'time', value: task.planning.time! });
          });
        }
      } else if (!d && task.planning.time) {
        const timeEl = metaRight.createEl('span', { cls: 'tc-task-date tc-cursor-pointer' });
        const clockIcon = timeEl.createEl('span', { cls: 'tc-date-icon' });
        setIcon(clockIcon, 'clock');
        timeEl.createEl('span', { text: task.planning.time });
        timeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addPropertyFilter({ type: 'time', value: task.planning.time! });
        });
      }

      // Source note chip before tags
      if (showSourceNote) {
        renderSourceNoteChip(metaRight, task, (filePath) => {
          this.addPropertyFilter({ type: 'file', filePath });
        });
      }

      // Tags last (max 2, with group color)
      for (const tag of tags.slice(0, 2)) {
        const tagEl = metaRight.createEl('span', { cls: 'tc-task-tag', text: tag });
        const color = this.getTagColor(tag);
        if (color) {
          tagEl.setCssProps({ '--tc-tag-color': color });
          tagEl.addClass('tc-task-tag--colored');
        }
        tagEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addPropertyFilter({ type: 'tag', value: tag });
        });
        tagEl.addClass('tc-cursor-pointer');
        // Drop target: dragging a tag onto a chip replaces it
        tagEl.addEventListener('dragover', (e) => {
          const dragging = this.state.get('draggingTag');
          if (!dragging || dragging === tag) return;
          e.preventDefault();
          e.stopPropagation();
          tagEl.classList.add('tc-drop-target');
        });
        tagEl.addEventListener('dragleave', () => {
          tagEl.classList.remove('tc-drop-target');
        });
        tagEl.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          tagEl.classList.remove('tc-drop-target');
          const dragging = this.state.get('draggingTag');
          if (!dragging || dragging === tag) return;
          void this.patchTaskTags(task, [dragging], [tag]);
        });
      }
    }

    card.addEventListener('click', (e) => {
      const key = this.taskKey(task);

      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click: toggle this task in selection
        if (this.selectedTaskKeys.has(key)) {
          this.selectedTaskKeys.delete(key);
        } else {
          this.selectedTaskKeys.add(key);
        }
        this.selectionAnchorKey = key;
        this.selectionFocusKey = key;
        this.updateSelectionVisuals();
        this.focusTaskKey(key);
        return;
      }

      if (e.shiftKey) {
        const keys = this.visibleTaskKeys();
        const anchor =
          this.selectionAnchorKey && keys.includes(this.selectionAnchorKey)
            ? this.selectionAnchorKey
            : key;
        this.selectionAnchorKey = anchor;
        this.selectionFocusKey = key;
        this.replaceRangeSelection(anchor, key, keys);
        this.focusTaskKey(key);
        return;
      }

      // Plain click: clear selection, open in RightPanel
      this.selectedTaskKeys.clear();
      this.selectionAnchorKey = key;
      this.selectionFocusKey = key;
      this.updateSelectionVisuals();
      this.focusTaskKey(key);
      this.state.set('taskStack', [task]);
    });

    // Delete button (visible on hover)
    const deleteBtn = mainRow.createEl('button', {
      cls: 'tc-task-delete-btn',
      attr: { title: 'Delete task', 'aria-label': 'Delete task' },
    });
    setIcon(deleteBtn, 'x');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.deleteTask(task);
    });

    // Drag source
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', () => {
      this.state.set('draggingTask', task);
      card.classList.add('tc-dragging');
    });
    card.addEventListener('dragend', () => {
      this.state.set('draggingTask', null);
      card.classList.remove('tc-dragging');
    });

    // Drop target for tag→task drag, and for project→task drag (drop a project
    // onto a task to move that task into the project note).
    card.addEventListener('dragover', (e) => {
      const project = this.state.get('draggingProject');
      const canDropProject =
        !!project && project !== task.source.filePath && !!this.projectManager && !!this.tasks;
      if (!this.state.get('draggingTag') && !canDropProject) return;
      e.preventDefault();
      card.classList.add('tc-drop-target');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('tc-drop-target');
    });
    card.addEventListener('drop', (e) => {
      card.classList.remove('tc-drop-target');
      const tag = this.state.get('draggingTag');
      const project = this.state.get('draggingProject');
      if (tag) {
        e.preventDefault();
        void this.assignTagFromInbox(task, tag);
      } else if (project && project !== task.source.filePath && this.projectManager && this.tasks) {
        e.preventDefault();
        const ref = task.ref;
        if (ref) {
          void moveTaskToProjectWithRecovery(
            this.app,
            this.tasks,
            this.projectManager,
            ref,
            project,
          );
        }
      }
    });

    // Right-click context menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const key = this.taskKey(task);

      // If right-clicking an unselected card while others are selected → clear and show single menu
      if (this.selectedTaskKeys.size > 0 && !this.selectedTaskKeys.has(key)) {
        this.selectedTaskKeys.clear();
        this.selectionAnchorKey = null;
        this.selectionFocusKey = null;
        this.updateSelectionVisuals();
      }

      // ── BULK MENU (2+ tasks selected) ─────────────────────
      if (this.selectedTaskKeys.size >= 2) {
        this.showBulkContextMenu(e, card);
        return;
      }

      // ── SINGLE TASK MENU ─────────────────────────────────
      const today = localDate(window.moment().format('YYYY-MM-DD'));
      const tomorrow = shiftLocalDate(today, 1);
      const isToday = task.planning.due === today;
      const menu = new Menu();

      // ── Today toggle ──────────────────────────────────────
      menu.addItem((item) =>
        item
          .setTitle('Today')
          .setIcon('calendar')
          .setSection('today')
          .setChecked(isToday)
          .onClick(() => void this.toggleTaskDuePreset(task, today)),
      );

      if (tomorrow) {
        menu.addItem((item) =>
          item
            .setTitle('Tomorrow')
            .setIcon('calendar-plus')
            .setSection('today')
            .setChecked(task.planning.due === tomorrow)
            .onClick(() => void this.toggleTaskDuePreset(task, tomorrow)),
        );
      }

      // ── Pinned tags ────────────────────────────────────────
      if (this.settings.pinnedTags.length > 0) {
        for (const pinnedTag of this.settings.pinnedTags) {
          const hasTag = this.getTaskTags(task).has(pinnedTag);
          menu.addItem((item) =>
            item
              .setTitle(pinnedTag)
              .setIcon('tag')
              .setSection('tags')
              .setChecked(hasTag)
              .onClick(
                () =>
                  void this.patchTaskTags(
                    task,
                    hasTag ? [] : [pinnedTag],
                    hasTag ? [pinnedTag] : [],
                  ),
              ),
          );
        }
      }

      // ── Priority (submenu) ────────────────────────────────
      menu.addItem((item) => {
        item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
        const sub = getSubmenu(item);
        this.buildPrioritySubmenu(sub, task);
      });

      // ── Status (submenu) ──────────────────────────────────
      menu.addItem((item) => {
        item.setTitle('Status').setIcon('check-square').setSection('priority');
        const sub = getSubmenu(item);
        buildStatusSubmenu(sub, task, this.statusRegistry, (c) => void this.setTaskStatus(task, c));
      });

      menu.addItem((item) =>
        item
          .setTitle('Filter by this priority')
          .setIcon('filter')
          .setSection('priority')
          .onClick(() => this.addPropertyFilter({ type: 'priority', value: task.priority })),
      );

      menu.addItem((item) =>
        item
          .setTitle('Filter by this status')
          .setIcon('filter')
          .setSection('priority')
          .onClick(() => this.addPropertyFilter({ type: 'status', value: task.statusSymbol })),
      );

      // ── Set tag… ───────────────────────────────────────────
      menu.addItem((item) =>
        item
          .setTitle('Set date…')
          .setIcon('calendar-cog')
          .setSection('actions')
          .onClick(() => this.openTaskDatePicker(card, [task])),
      );

      menu.addItem((item) =>
        item
          .setTitle('Set tag…')
          .setIcon('hash')
          .setSection('actions')
          .onClick(() => this.openTagPicker(task)),
      );

      menu.addItem((item) => {
        item
          .setTitle('Edit repeat…')
          .setSection('actions')
          .onClick(() => this.openRecurrenceEditor(card, task));
        const dom = (item as unknown as { dom?: HTMLElement }).dom;
        const iconSlot = dom?.querySelector<HTMLElement>('.menu-item-icon');
        if (task.recurrence && iconSlot) {
          renderRecurrenceBadge(iconSlot, recurrenceBadgeInput(task.recurrence));
        }
      });

      // ── Open in note ──────────────────────────────────────
      menu.addItem((item) =>
        item
          .setTitle('Open in note')
          .setIcon('file-text')
          .setSection('actions')
          .onClick(() => void openInFile(this.app, task)),
      );

      // ── Delete ─────────────────────────────────────────────
      menu.addItem((item) =>
        item
          .setTitle('Delete')
          .setIcon('trash-2')
          .setSection('danger')
          .onClick(() => void this.deleteTask(task)),
      );

      showMenuAtMouseEventWithFocus(menu, e);
    });
  }

  private bulkTagIndicator(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  private makeBulkTagRemoveHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () =>
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [], [pinnedTag])));
  }

  private makeBulkTagAddHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () =>
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, [pinnedTag], [])));
  }

  private addBulkTagItem(menu: Menu, pinnedTag: string, selectedTasks: TaskSnapshot[]): void {
    const count = selectedTasks.filter((task) => task.tags?.includes(pinnedTag) === true).length;
    const allHave = count === selectedTasks.length;
    const indicator = this.bulkTagIndicator(count, selectedTasks.length);
    const clickHandler = allHave
      ? this.makeBulkTagRemoveHandler(selectedTasks, pinnedTag)
      : this.makeBulkTagAddHandler(selectedTasks, pinnedTag);
    menu.addItem((item) =>
      item
        .setTitle(`${indicator}${pinnedTag}  (${count}/${selectedTasks.length})`)
        .setIcon('tag')
        .setSection('tags')
        .onClick(clickHandler),
    );
  }

  private async deleteBulkTasks(selectedTasks: TaskSnapshot[]): Promise<void> {
    const sorted = [...selectedTasks].sort((a, b) => b.source.line - a.source.line);
    for (const t of sorted) await this.deleteTask(t);
    this.selectedTaskKeys.clear();
    this.selectionAnchorKey = null;
    this.selectionFocusKey = null;
    this.updateSelectionVisuals();
  }

  private buildPrioritySubmenu(sub: Menu, task: TaskSnapshot): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .setChecked(task.priority === level.value)
          .onClick(() => void this.setPriority(task, level.value));
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private buildBulkPrioritySubmenu(sub: Menu, selectedTasks: TaskSnapshot[]): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(
            () => void Promise.all(selectedTasks.map((t) => this.setPriority(t, level.value))),
          );
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  private getTaskTags(task: TaskSnapshot): Set<string> {
    return new Set(task.tags ?? []);
  }

  private async patchTaskTags(
    task: TaskSnapshot,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const ref = task.ref;
    if (!ref || !this.tasks) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref },
        patch: { tags: { add, remove } },
      }),
    );
  }

  private async assignTagFromInbox(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings.inbox.tag;
    const remove =
      this.settings.inbox.removeTagOnAssign && this.getTaskTags(task).has(inboxTag)
        ? [inboxTag]
        : [];
    await this.patchTaskTags(task, [tag], remove);
  }

  private openTagPicker(task: TaskSnapshot): void {
    const currentTags = this.getTaskTags(task);
    const handleCommit = (toAdd: string[], toRemove: string[]): void => {
      void this.patchTaskTags(task, toAdd, toRemove);
    };
    new TagPickerModal(
      this.app,
      (tag) => this.getTagColor(tag),
      currentTags,
      new Set(),
      handleCommit,
    ).open();
  }

  private openBulkTagPicker(selectedTasks: TaskSnapshot[]): void {
    const tagSets = selectedTasks.map((t) => this.getTaskTags(t));
    const allTags = new Set(tagSets.flatMap((s) => [...s]));
    const hasAll = (tag: string): boolean => tagSets.every((s) => s.has(tag));
    const currentTags = new Set([...allTags].filter(hasAll));
    const partialTags = new Set([...allTags].filter((tag) => !hasAll(tag)));
    const handleBulkCommit = (toAdd: string[], toRemove: string[]): void => {
      void Promise.all(selectedTasks.map((task) => this.patchTaskTags(task, toAdd, toRemove)));
    };
    new TagPickerModal(
      this.app,
      (tag) => this.getTagColor(tag),
      currentTags,
      partialTags,
      handleBulkCommit,
    ).open();
  }

  private showBulkContextMenu(e: MouseEvent, _card: HTMLElement): void {
    const selectedKeys = this.visibleTaskKeys().filter((key) => this.selectedTaskKeys.has(key));
    const allTasks = [...this.queries.list()];
    const selectedTasks = selectedKeys
      .map((k) => {
        const lastColon = k.lastIndexOf(':');
        const fp = k.slice(0, lastColon);
        const lineNum = parseInt(k.slice(lastColon + 1), 10);
        return allTasks.find((t) => t.source.filePath === fp && t.source.line === lineNum);
      })
      .filter((t) => t !== undefined);

    const menu = new Menu();
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    const allHaveToday = selectedTasks.every((t) => t.planning.due === today);

    // Header (non-interactive label)
    menu.addItem((item) =>
      item
        .setTitle(`${selectedTasks.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );

    // Today toggle
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(allHaveToday)
        .onClick(() => void this.applyBulkDuePreset(selectedTasks, today)),
    );

    if (tomorrow) {
      const allHaveTomorrow = selectedTasks.every((task) => task.planning.due === tomorrow);
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(allHaveTomorrow)
          .onClick(() => void this.applyBulkDuePreset(selectedTasks, tomorrow)),
      );
    }

    // Pinned tags
    for (const pinnedTag of this.settings.pinnedTags) {
      this.addBulkTagItem(menu, pinnedTag, selectedTasks);
    }

    // Priority (submenu)
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.buildBulkPrioritySubmenu(sub, selectedTasks);
    });

    // Status (submenu) — applies to all selected tasks
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, selectedTasks[0]!, this.statusRegistry, (c) => {
        void Promise.all(selectedTasks.map((t) => this.setTaskStatus(t, c)));
      });
    });

    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => this.openTaskDatePicker(_card, selectedTasks)),
    );

    // Set tag…
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => this.openBulkTagPicker(selectedTasks)),
    );

    // Delete all
    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => void this.deleteBulkTasks(selectedTasks)),
    );

    showMenuAtMouseEventWithFocus(menu, e);
  }

  private renderPropertyChips(container: HTMLElement): void {
    const vs = this.state.get('centerListViewState');
    for (let i = 0; i < vs.filters.length; i++) {
      const f = vs.filters[i]!;
      const label = this.filterChipLabel(f);
      const chip = container.createEl('span', { cls: 'tc-filter-chip' });
      chip.createEl('span', { cls: 'tc-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'tc-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePropertyFilter(idx);
      });
    }
  }

  private filterChipLabel(f: PropertyFilter): string {
    if (f.type === 'tag') return f.value;
    if (f.type === 'file') return `📄 ${f.filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''}`;
    if (f.type === 'time') return `⏰ ${f.value}`;
    if (f.type === 'status') return this.statusRegistry.bySymbol(f.value)?.name ?? f.value;
    if (f.type === 'date') return `📅 ${this.formatDate(f.value)}`;
    const level = PRIORITY_LEVELS.find((l) => l.value === f.value);
    if (!level) return f.value;
    // D/None has no emoji and reads as "Normal" here (distinct from the
    // "None" label used in priority-picker menus).
    return level.emoji ? `${level.emoji} ${level.label}` : 'Normal';
  }

  private addPropertyFilter(filter: PropertyFilter): void {
    const vs = this.state.get('centerListViewState');
    const already = vs.filters.some((f) => {
      if (f.type !== filter.type) return false;
      if (f.type === 'file' && filter.type === 'file') return f.filePath === filter.filePath;
      if (f.type === 'tag' && filter.type === 'tag') return f.value === filter.value;
      if (f.type === 'time' && filter.type === 'time') return f.value === filter.value;
      if (f.type === 'priority' && filter.type === 'priority') return f.value === filter.value;
      if (f.type === 'status' && filter.type === 'status') return f.value === filter.value;
      if (f.type === 'date' && filter.type === 'date') return f.value === filter.value;
      return false;
    });
    if (already) return;
    const next: ListViewState = { ...vs, filters: [...vs.filters, filter] };
    this.updateViewState(next);
  }

  private removePropertyFilter(idx: number): void {
    const vs = this.state.get('centerListViewState');
    const next: ListViewState = { ...vs, filters: vs.filters.filter((_, i) => i !== idx) };
    this.updateViewState(next);
  }

  private updateViewState(next: ListViewState): void {
    if (!this.settings.listViewStates) this.settings.listViewStates = {};
    this.settings.listViewStates[this.currentListKey] = next;
    void this.onSaveSettings();
    this.state.set('centerListViewState', next);
  }

  private renderViewStateButton(container: HTMLElement): void {
    const vs = this.state.get('centerListViewState');
    const defaults = getListViewDefaults(this.currentListKey);
    const isNonDefault =
      vs.groupBy !== defaults.groupBy ||
      vs.sortBy.field !== defaults.sortBy.field ||
      vs.sortBy.dir !== defaults.sortBy.dir ||
      !statusGroupsEqual(vs.statusGroups, defaults.statusGroups);

    const btn = container.createEl('button', {
      cls: `tc-view-state-btn${isNonDefault ? ' tc-view-state-btn--active' : ''}`,
      attr: { 'aria-label': 'Sort & group options' },
    });
    setIcon(btn, 'arrow-up-down');
    btn.addEventListener('click', () => this.showViewStatePopover(btn));

    if (this.reopenStatusGroupPopover) {
      this.reopenStatusGroupPopover = false;
      this.showViewStatePopover(btn, true);
    }
  }

  private showViewStatePopover(anchor: HTMLElement, autoOpenStatusGroupRow = false): void {
    if (this.viewStatePopoverCleanup) {
      this.viewStatePopoverCleanup(true);
      return;
    }

    const vs = this.state.get('centerListViewState');
    const popover = this.el.createDiv({
      cls: 'tc-view-state-popover tc-popover',
      attr: { role: 'dialog', 'aria-label': 'Sort and group options' },
    });
    const ownerDocument = popover.ownerDocument;

    let dismissListening = false;
    let dismissTimer: number | undefined;
    let closed = false;
    const close = (restoreFocus = false): void => {
      if (closed) return;
      closed = true;
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
      if (dismissListening) {
        ownerDocument.removeEventListener('click', dismiss, true);
        dismissListening = false;
      }
      popover.remove();
      if (this.viewStatePopoverCleanup === close) this.viewStatePopoverCleanup = null;
      if (restoreFocus && anchor.isConnected) anchor.focus();
    };
    this.viewStatePopoverCleanup = close;
    const dismiss = (e: MouseEvent): void => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        close(false);
      }
    };
    popover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    });

    const bindExpandableRow = (rowMain: HTMLElement, subList: HTMLElement): void => {
      const toggle = (): void => {
        const isOpen = !subList.hasClass('tc-hidden');
        popover.querySelectorAll<HTMLElement>('.tc-view-state-sublist').forEach((el) => {
          el.addClass('tc-hidden');
        });
        popover.querySelectorAll<HTMLElement>('.tc-view-state-row-main').forEach((el) => {
          el.removeClass('is-open');
          el.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          subList.removeClass('tc-hidden');
          rowMain.addClass('is-open');
          rowMain.setAttribute('aria-expanded', 'true');
        }
      };
      rowMain.addEventListener('click', toggle);
      rowMain.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      });
    };

    const makeRow = (
      icon: string,
      label: string,
      displayValue: string,
      activeValue: string,
      defaultValue: string,
      options: Array<{ label: string; value: string }>,
      onSelect: (value: string) => void,
    ): void => {
      const row = popover.createDiv({ cls: 'tc-view-state-row' });
      const rowMain = row.createDiv({
        cls: 'tc-view-state-row-main',
        attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' },
      });
      const iconEl = rowMain.createEl('span', { cls: 'tc-view-state-row-icon' });
      setIcon(iconEl, icon);
      rowMain.createEl('span', { cls: 'tc-view-state-row-label', text: label });
      rowMain.createEl('span', { cls: 'tc-view-state-row-value', text: displayValue });
      const chevEl = rowMain.createEl('span', { cls: 'tc-view-state-row-chevron' });
      setIcon(chevEl, 'chevron-right');

      const subList = row.createDiv({ cls: 'tc-view-state-sublist tc-hidden' });
      bindExpandableRow(rowMain, subList);

      for (const opt of options) {
        const isActive = opt.value === activeValue;
        const isDefault = opt.value === defaultValue;
        const optEl = subList.createEl('button', {
          cls: 'tc-view-state-option',
          attr: { 'aria-pressed': String(isActive) },
        });
        const checkEl = optEl.createEl('span', { cls: 'tc-view-state-option-check' });
        if (isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'tc-view-state-option-label', text: opt.label });
        if (isDefault) {
          optEl.createEl('span', { cls: 'tc-view-state-option-default', text: 'Default' });
        }
        optEl.addEventListener('click', () => {
          close();
          onSelect(opt.value);
        });
      }
    };

    // Like makeRow, but options toggle membership in a set rather than
    // selecting a single value, and the popover stays open after a click
    // so multiple options can be picked. `presets`, if given, render as
    // plain (non-checkable) shortcut buttons above a divider, ahead of the
    // toggle options — they just set the whole selection in one click.
    const makeMultiRow = (
      icon: string,
      label: string,
      displayValue: string,
      selected: readonly string[],
      options: Array<{ label: string; value: string }>,
      onToggle: (value: string) => void,
      initiallyOpen = false,
      presets: Array<{ label: string; onClick: () => void; isActive?: boolean }> = [],
    ): void => {
      const row = popover.createDiv({ cls: 'tc-view-state-row' });
      const rowMain = row.createDiv({
        cls: 'tc-view-state-row-main',
        attr: { role: 'button', tabindex: '0', 'aria-expanded': String(initiallyOpen) },
      });
      const iconEl = rowMain.createEl('span', { cls: 'tc-view-state-row-icon' });
      setIcon(iconEl, icon);
      rowMain.createEl('span', { cls: 'tc-view-state-row-label', text: label });
      rowMain.createEl('span', { cls: 'tc-view-state-row-value', text: displayValue });
      const chevEl = rowMain.createEl('span', { cls: 'tc-view-state-row-chevron' });
      setIcon(chevEl, 'chevron-right');

      const subList = row.createDiv({ cls: 'tc-view-state-sublist tc-hidden' });
      if (initiallyOpen) {
        subList.removeClass('tc-hidden');
        rowMain.addClass('is-open');
      }
      bindExpandableRow(rowMain, subList);

      for (const preset of presets) {
        const optEl = subList.createEl('button', {
          cls: 'tc-view-state-option',
          attr: { 'aria-pressed': String(preset.isActive === true) },
        });
        const checkEl = optEl.createEl('span', { cls: 'tc-view-state-option-check' });
        if (preset.isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'tc-view-state-option-label', text: preset.label });
        optEl.addEventListener('click', () => preset.onClick());
      }
      if (presets.length > 0) {
        subList.createDiv({ cls: 'tc-view-state-sublist-divider' });
      }

      for (const opt of options) {
        const isActive = selected.includes(opt.value);
        const optEl = subList.createEl('button', {
          cls: 'tc-view-state-option',
          attr: { 'aria-pressed': String(isActive) },
        });
        const checkEl = optEl.createEl('span', { cls: 'tc-view-state-option-check' });
        if (isActive) setIcon(checkEl, 'check');
        optEl.createEl('span', { cls: 'tc-view-state-option-label', text: opt.label });
        optEl.addEventListener('click', () => {
          onToggle(opt.value);
        });
      }
    };

    const GROUP_BY_OPTIONS = [
      { label: 'None', value: 'none' },
      { label: 'Date', value: 'date' },
      { label: 'Priority', value: 'priority' },
      { label: 'Tag', value: 'tag' },
      { label: 'Status', value: 'status' },
    ];
    const GROUP_LABELS: Record<string, string> = {
      none: 'None',
      date: 'Date',
      priority: 'Priority',
      tag: 'Tag',
      status: 'Status',
    };

    const sortDirArrow = vs.sortBy.dir === 'asc' ? '↑' : '↓';
    const sortFieldArrow = (field: string): string =>
      vs.sortBy.field === field ? sortDirArrow : '';
    const SORT_BY_OPTIONS = [
      { label: `Date ${sortFieldArrow('date')}`.trim(), value: 'date' },
      { label: `Priority ${sortFieldArrow('priority')}`.trim(), value: 'priority' },
      { label: `Title ${sortFieldArrow('title')}`.trim(), value: 'title' },
      { label: `Tag ${sortFieldArrow('tag')}`.trim(), value: 'tag' },
      { label: `Status ${sortFieldArrow('status')}`.trim(), value: 'status' },
    ];
    const sortLabel = `${vs.sortBy.field.charAt(0).toUpperCase() + vs.sortBy.field.slice(1)} ${vs.sortBy.dir === 'asc' ? '↑' : '↓'}`;

    const STATUS_GROUP_OPTIONS: Array<{ label: string; value: TaskStatusType }> =
      ALL_STATUS_GROUPS.map((value) => ({ label: TYPE_LABELS[value], value }));

    // Unified "Show" display value: All (undefined/all 4), Active (exactly
    // the open+in-progress pair), otherwise a count of the selected groups.
    const showDisplayValue = (selected: TaskStatusType[] | undefined): string => {
      const effective = normalizeStatusGroups(selected) ?? ALL_STATUS_GROUPS;
      if (effective.length >= 4) return 'All';
      if (statusGroupsEqual(effective, ACTIVE_STATUS_GROUPS)) return 'Active';
      return `${effective.length} selected`;
    };

    const defaults = getListViewDefaults(this.currentListKey);

    makeRow(
      'layout-list',
      'Group by',
      GROUP_LABELS[vs.groupBy] ?? vs.groupBy,
      vs.groupBy,
      defaults.groupBy,
      GROUP_BY_OPTIONS,
      (val) => {
        this.updateViewState({ ...vs, groupBy: val as ListViewState['groupBy'] });
      },
    );

    makeRow(
      'arrow-up-down',
      'Sort by',
      sortLabel,
      vs.sortBy.field,
      defaults.sortBy.field,
      SORT_BY_OPTIONS,
      (val) => {
        const field = val as ListViewState['sortBy']['field'];
        const dir: 'asc' | 'desc' =
          vs.sortBy.field === field && vs.sortBy.dir === 'asc' ? 'desc' : 'asc';
        this.updateViewState({ ...vs, sortBy: { field, dir } });
      },
    );

    // Single unified "Show" control — replaces the old separate Show
    // single-select and Status group multi-select, which contradicted each
    // other. "Active"/"All" are one-click presets; the 4 toggles below them
    // are the actual source of truth (presets just set their state).
    const applyStatusGroupsChange = (nextStatusGroups: TaskStatusType[] | undefined): void => {
      this.reopenStatusGroupPopover = true;
      close();
      this.updateViewState({ ...vs, statusGroups: nextStatusGroups });
    };

    makeMultiRow(
      'eye',
      'Show',
      showDisplayValue(vs.statusGroups),
      vs.statusGroups ?? ALL_STATUS_GROUPS,
      STATUS_GROUP_OPTIONS,
      (val) => {
        const value = val as TaskStatusType;
        const current = vs.statusGroups ?? ALL_STATUS_GROUPS;
        const next = current.includes(value)
          ? current.filter((g) => g !== value)
          : [...current, value];
        // All 4 selected (or none, treated the same as "all") is the default — store
        // undefined so the state stays clean and matches getListViewDefaults.
        const nextStatusGroups = next.length === 0 || next.length >= 4 ? undefined : next;
        applyStatusGroupsChange(nextStatusGroups);
      },
      autoOpenStatusGroupRow,
      [
        {
          label: 'Active',
          onClick: () => applyStatusGroupsChange(ACTIVE_STATUS_GROUPS),
          isActive: statusGroupsEqual(vs.statusGroups, ACTIVE_STATUS_GROUPS),
        },
        {
          label: 'All',
          onClick: () => applyStatusGroupsChange(undefined),
          isActive: normalizeStatusGroups(vs.statusGroups) === undefined,
        },
      ],
    );

    // Reset to defaults row — only shown when state differs from defaults.
    // Same predicate as the left-panel customization dot.
    if (isListViewCustomized(vs, this.currentListKey)) {
      const resetRow = popover.createDiv({ cls: 'tc-view-state-reset' });
      const resetBtn = resetRow.createEl('button', {
        cls: 'tc-view-state-reset-btn',
        text: 'Reset to defaults',
      });
      resetBtn.addEventListener('click', () => {
        close();
        this.updateViewState(getListViewDefaults(this.currentListKey));
      });
    }

    anchor.after(popover);
    popover.querySelector<HTMLElement>('.tc-view-state-row-main')?.focus();
    dismissTimer = window.setTimeout(() => {
      dismissTimer = undefined;
      if (!popover.isConnected) return;
      ownerDocument.addEventListener('click', dismiss, true);
      dismissListening = true;
    }, 0);
  }

  /**
   * Click-to-create quick-add for the hour grid (Today/Week): an inline input positioned
   * absolutely inside `hourColumnEl`, at the same `top` a timed block for `time` would use
   * (mirrors renderTimedBlocksForDay's own `block.style.top` positioning — the technique Task 1
   * fixed for the month/year pickers: an absolutely-positioned child anchored via inline
   * top/left inside a `position: relative`/`position: absolute` container, not one that shoves
   * surrounding layout). On Enter, sends the body plus typed due/time initial fields through
   * TaskApplicationApi; the shared task pipeline owns Markdown encoding and persistence.
   */
  private showTimeGridQuickAdd(hourColumnEl: HTMLElement, date: string, time: string): void {
    hourColumnEl.querySelectorAll('.tc-tg-quick-add').forEach((el) => el.remove());
    const pop = hourColumnEl.createDiv({ cls: 'tc-tg-quick-add' });
    pop.style.top = `${minutesToPixels(timeStringToMinutes(time))}px`;
    const input = pop.createEl('input', {
      cls: 'tc-tg-quick-add-input',
      attr: { type: 'text', placeholder: `Task at ${time}…` },
    });

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      pop.remove();
      if (text) {
        void this.executeCreate(
          this.withDefaultTaskPrefix(text),
          { type: 'configured-default' },
          {
            due: { type: 'set', value: localDate(date) },
            time: { type: 'set', value: localTime(time) },
          },
        );
      }
    };
    const cancel = (): void => {
      committed = true;
      pop.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (activeDocument.activeElement !== input) commit();
      }, 150);
    });
    window.setTimeout(() => input.focus(), 0);
  }

  /**
   * Click-to-create quick-add that fills a cell (`inset: 2px`-style, matching the cell's own
   * padding, so it never gets clipped by the cell's `overflow: hidden`) — same
   * anchored-absolute-child-of-a-positioned-container technique as showTimeGridQuickAdd/Task 1's
   * month-year picker fix, just sized to the cell instead of offset below it. Shared by Month's
   * day-cell "+" button and the all-day/"no-time" row's empty-space click-to-create (Task 18) —
   * both just need a plain (untimed) task name typed against a given date, so only the CSS class
   * (for each cell shape's own styling) varies between callers.
   */
  private showFillCellQuickAdd(cell: HTMLElement, date: string, popCls: string): void {
    cell.querySelectorAll(`.${popCls}`).forEach((el) => el.remove());
    const pop = cell.createDiv({ cls: popCls });
    const input = pop.createEl('input', {
      cls: `${popCls}-input`,
      attr: { type: 'text', placeholder: 'Task name…' },
    });

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      pop.remove();
      if (text) {
        void this.executeCreate(
          this.withDefaultTaskPrefix(text),
          { type: 'configured-default' },
          {
            due: { type: 'set', value: localDate(date) },
          },
        );
      }
    };
    const cancel = (): void => {
      committed = true;
      pop.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (activeDocument.activeElement !== input) commit();
      }, 150);
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private renderAddTaskBar(): void {
    const bar = this.el.createDiv({ cls: 'tc-add-task-bar' });
    const trigger = bar.createDiv({ cls: 'tc-add-task-trigger' });
    trigger.createEl('span', { cls: 'tc-add-task-plus', text: '+' });
    trigger.createEl('span', { cls: 'tc-add-task-label', text: 'Add task' });
    bar.addEventListener('click', () => {
      if (bar.querySelector('.tc-quick-capture')) return;
      trigger.remove();
      this.showQuickCapture(bar);
    });
  }

  private showQuickCapture(container: HTMLElement): void {
    const form = container.createDiv({ cls: 'tc-quick-capture' });
    const input = form.createEl('input', {
      cls: 'tc-quick-capture-input',
      attr: { type: 'text', placeholder: 'Task name…' },
    });

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      if (text) void this.createTask(text).then(() => this.render());
      else this.render();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') this.render();
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (activeDocument.activeElement !== input) commit();
      }, 150);
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private async createTask(text: string): Promise<void> {
    const sel = this.state.get('selectedList');
    const today = localDate(window.moment().format('YYYY-MM-DD'));

    // Today and upcoming use the configured destination and typed scheduling fields.
    if (sel === 'today' || sel === 'upcoming') {
      await this.executeCreate(
        this.withDefaultTaskPrefix(text),
        {
          type: 'configured-default',
        },
        {
          due: { type: 'set', value: localDate(today) },
        },
      );
      return;
    }

    // Project context keeps its project-specific destination and insertion policy.
    if (typeof sel === 'object' && sel.type === 'project') {
      await this.createInProject(sel.path, text);
      return;
    }

    // Dateless contexts preserve their tag rules while sharing the same create command.
    let markdownBody: string;
    let fallbackPath: string;

    if (sel === 'inbox') {
      markdownBody =
        this.settings.inbox.mode !== 'untagged' ? `${text} ${this.settings.inbox.tag}` : text;
      fallbackPath = this.settings.customFilePath || 'Inbox.md';
    } else if (typeof sel === 'object' && sel.type === 'tag') {
      markdownBody = `${text} ${sel.tag}`;
      fallbackPath = this.settings.customFilePath || 'Inbox.md';
    } else if (typeof sel === 'object' && sel.type === 'group') {
      const group = this.settings.tagGroups.find((g) => g.id === sel.groupId);
      const tag = group?.mode === 'prefix' ? `#${group.prefix ?? ''}` : (group?.tags?.[0] ?? '');
      markdownBody = tag ? `${text} ${tag}` : text;
      fallbackPath = this.settings.customFilePath || 'Inbox.md';
    } else {
      await this.executeCreate(
        this.withDefaultTaskPrefix(text),
        {
          type: 'configured-default',
        },
        {
          due: { type: 'set', value: localDate(today) },
        },
      );
      return;
    }

    if (this.settings.addToToday) {
      await this.executeCreate(markdownBody, { type: 'configured-default' });
      return;
    }

    const path = this.resolveFallbackTaskPath(fallbackPath);
    await this.executeCreate(markdownBody, {
      type: 'explicit',
      destination: { filePath: path, insertion: { type: 'append' } },
      provision: 'if-missing',
    });
  }

  private async deleteTask(task: TaskSnapshot): Promise<void> {
    const ref = task.ref;
    if (!ref || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'delete', ref });
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'deleted') return;
    const stack = this.state.get('taskStack');
    const current = stack[0] ? rootTaskRef(stack[0]) : undefined;
    if (current && this.sameTaskRef(current, ref)) {
      this.state.set('taskStack', []);
    }
  }

  private async createInProject(path: string, markdownBody: string): Promise<void> {
    const { taskInsertionMode, taskInsertionSection } = this.settings.projects;
    await this.executeCreate(markdownBody, {
      type: 'explicit',
      destination: {
        filePath: path,
        insertion:
          taskInsertionMode === 'section' && taskInsertionSection.trim().length > 0
            ? { type: 'section', heading: taskInsertionSection }
            : { type: 'append' },
      },
    });
  }

  private withDefaultTaskPrefix(markdownBody: string): string {
    const prefix = this.settings.taskPrefix.trim();
    return prefix ? `${prefix} ${markdownBody}` : markdownBody;
  }

  private async executeCreate(
    markdownBody: string,
    destination: CreateTaskCommand['destination'],
    initial?: CreateTaskCommand['initial'],
  ): Promise<TaskCommandResult | undefined> {
    if (!this.tasks) return undefined;
    const result = await this.tasks.execute({
      type: 'create',
      destination,
      markdownBody,
      ...(initial !== undefined && { initial }),
    });
    presentTaskCreationResult(result, {
      announceSuccess: destination.type === 'configured-default',
    });
    return result;
  }

  private resolveFallbackTaskPath(configuredPath: string): string {
    const existing = this.app.vault.getAbstractFileByPath(configuredPath);
    if (existing instanceof TFile) return existing.path;
    const withExtension = configuredPath.endsWith('.md') ? configuredPath : `${configuredPath}.md`;
    const markdownFile = this.app.vault.getAbstractFileByPath(withExtension);
    return markdownFile instanceof TFile ? markdownFile.path : withExtension;
  }

  private sameTaskRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private getFilteredTasks(): TaskSnapshot[] {
    return [
      ...selectTaskList({
        tasks: this.queries.list(),
        selection: this.state.get('selectedList'),
        viewState: this.state.get('centerListViewState'),
        settings: this.settings,
        today: window.moment().format('YYYY-MM-DD') as LocalDate,
        textQuery: this.state.get('centerFilter'),
      }),
    ];
  }

  private getTitle(): string {
    const sel = this.state.get('selectedList');
    if (sel === 'inbox') return 'Inbox';
    if (sel === 'today') return 'Today';
    if (sel === 'upcoming') return 'Upcoming';
    if (typeof sel === 'object' && sel.type === 'tag') return sel.tag;
    if (typeof sel === 'object' && sel.type === 'project') return projectNameFromPath(sel.path);
    if (typeof sel === 'object' && sel.type === 'group') {
      const group = this.settings.tagGroups.find((g) => g.id === sel.groupId);
      return group?.name ?? 'Group';
    }
    return 'Tasks';
  }

  private formatDate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    const m = window.moment(d, 'YYYY-MM-DD');
    const diff = m.diff(window.moment(), 'days');
    if (diff > -7 && diff < 7) return m.format('ddd D MMM');
    return m.format('D MMM');
  }

  private getDateClass(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    if (d < today) return 'is-overdue';
    if (d === today) return 'is-today';
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === tomorrow) return 'is-tomorrow';
    const dayAfter = window.moment().add(2, 'days').format('YYYY-MM-DD');
    if (d === dayAfter) return 'is-soon';
    return '';
  }

  private getTagColor(tag: string): string | undefined {
    const noHash = tag.replace(/^#/, '');
    for (const group of this.settings.tagGroups) {
      if (group.mode === 'prefix' && group.prefix) {
        if (noHash === group.prefix || noHash.startsWith(`${group.prefix}/`)) {
          return group.color;
        }
      } else if (group.mode === 'manual' && group.tags) {
        if (group.tags.includes(tag) || group.tags.includes(noHash)) {
          return group.color;
        }
      }
    }
    return undefined;
  }

  private async rescheduleTask(dragData: string, targetDate: string): Promise<void> {
    const parts = dragData.split(':::');
    if (parts.length < 2) return;
    const [filePath, lineStr] = parts;
    const line = parseInt(lineStr ?? '0', 10);
    if (!filePath || isNaN(line)) return;

    const task = [...this.queries.list({ filePath })].find((t) => t.source.line === line);
    if (!task) return;

    const ref = task.ref;
    if (!ref || !this.tasks) return;
    try {
      const date = localDate(targetDate);
      const anchor =
        task.planning.start && task.planning.due
          ? task.planning.due
          : (task.planning.scheduled ?? task.planning.due);
      let command: Parameters<TaskApplicationApi['execute']>[0];
      if (!task.planning.time) command = { type: 'reschedule', ref, date };
      else if (!anchor) command = { type: 'convert-to-all-day', ref, date };
      else {
        command = {
          type: 'move-to-all-day',
          ref,
          days: daysBetweenLocalDates(anchor, date),
        };
      }
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Calendar controls supply the date; malformed gesture input remains a no-op.
    }
  }

  private async setTaskTimeFromDrop(dragData: string, date: string, time: string): Promise<void> {
    const parts = dragData.split(':::');
    if (parts.length < 2) return;
    const [filePath, lineStr] = parts;
    const line = parseInt(lineStr ?? '0', 10);
    if (!filePath || isNaN(line)) return;

    const task = [...this.queries.list({ filePath })].find((t) => t.source.line === line);
    if (!task) return;

    const ref = task.ref;
    if (!ref || !this.tasks) return;
    try {
      const targetDate = localDate(date);
      const targetTime = localTime(time);
      presentTaskCommandResult(
        await this.tasks.execute(
          task.planning.start && task.planning.due
            ? {
                type: 'move-time-slot',
                ref,
                days: daysBetweenLocalDates(task.planning.due, targetDate),
                time: targetTime,
              }
            : { type: 'set-time-slot', ref, date: targetDate, time: targetTime },
        ),
      );
    } catch {
      // A malformed drag payload is ignored without touching the task.
    }
  }

  private async commitTimedMove(task: TaskSnapshot, target: TimedDragTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!this.tasks || !ref) return;
    try {
      const command: Parameters<TaskApplicationApi['execute']>[0] =
        target.destination === 'all-day'
          ? { type: 'move-to-all-day', ref, days: target.dayDelta }
          : {
              type: 'move-time-slot',
              ref,
              days: target.dayDelta,
              time: localTime(minutesToTimeString(target.startMinutes)),
            };
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Geometry and command validation share the same target; malformed values remain no-ops.
    }
  }

  private async commitTimedDuration(
    task: TaskSnapshot,
    target: TimedVerticalResizeTarget,
  ): Promise<void> {
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        time: {
          type: 'set',
          value: localTime(minutesToTimeString(target.startMinutes)),
        },
        duration: { type: 'set', value: durationMinutes(target.durationMinutes) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous duration if a forged target fails validation.
    }
  }

  private async commitSpanMove(task: TaskSnapshot, target: SpanMoveTarget): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!this.tasks || !ref || target.days === 0) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({ type: 'shift-schedule', ref, days: target.days }),
      );
    } catch {
      // The shared resolver validates the exact frozen delta again at the command boundary.
    }
  }

  private async commitTimedBoundary(
    task: TaskSnapshot,
    target: TimedBoundaryTarget,
  ): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!this.tasks || !ref) return;
    try {
      const command: Parameters<TaskApplicationApi['execute']>[0] =
        target.boundary === 'create-span'
          ? { type: 'extend-span', ref, due: localDate(target.date) }
          : {
              type: 'set-span-boundary',
              ref,
              boundary: target.boundary,
              date: localDate(target.date),
            };
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Boundary geometry is validated again by the application command.
    }
  }

  private async updateTaskTime(task: TaskSnapshot, newStartMinutes: number): Promise<void> {
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        time: { type: 'set', value: localTime(minutesToTimeString(newStartMinutes)) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid time when gesture arithmetic is out of range.
    }
  }

  private async updateTaskDuration(task: TaskSnapshot, newDurationMinutes: number): Promise<void> {
    if (!this.tasks) return;
    try {
      const command = calendarPatchCommand(task, {
        duration: { type: 'set', value: durationMinutes(newDurationMinutes) },
      });
      if (!command) return;
      presentTaskCommandResult(await this.tasks.execute(command));
    } catch {
      // Keep the previous valid duration when gesture arithmetic is invalid.
    }
  }

  private async updateTaskStart(task: TaskSnapshot, newStart: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!ref || !this.tasks) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({
          type: 'set-span-boundary',
          ref,
          boundary: 'start',
          date: localDate(newStart),
        }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  private async rescheduleTaskDue(task: TaskSnapshot, newDue: string): Promise<void> {
    const ref = calendarRootTaskRef(task);
    if (!ref || !this.tasks) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({
          type: 'set-span-boundary',
          ref,
          boundary: 'due',
          date: localDate(newDue),
        }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  // The semantic command freezes the effective scheduled/due anchor when start is absent and
  // validates the final span atomically; presentation supplies only the dragged-to edge.
  private async extendTaskToSpan(task: TaskSnapshot, newDue: string): Promise<void> {
    if (!(task.planning.start ?? task.planning.scheduled ?? task.planning.due)) return;
    const ref = calendarRootTaskRef(task);
    if (!ref || !this.tasks) return;
    try {
      presentTaskCommandResult(
        await this.tasks.execute({ type: 'extend-span', ref, due: localDate(newDue) }),
      );
    } catch {
      // Calendar controls supply the boundary; malformed input remains a no-op.
    }
  }

  private editTaskLink(task: TaskSnapshot, occ: number, token: LinkToken): void {
    const target = calendarMutationTarget(task);
    if (!target || !this.tasks) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        void this.tasks!.execute({
          type: 'edit-link',
          target: { type: 'title', target },
          occurrence: occ,
          replacement: newRaw,
        }).then(presentTaskCommandResult);
      },
      task.source.filePath,
    ).open();
  }

  private async toggleDueToday(task: TaskSnapshot): Promise<void> {
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    await this.toggleTaskDuePreset(task, today);
  }

  private async toggleTaskDuePreset(task: TaskSnapshot, value: LocalDate): Promise<void> {
    await this.setTaskDue(task, task.planning.due === value ? null : value);
  }

  private async setTaskDue(task: TaskSnapshot, value: LocalDate | null): Promise<boolean> {
    const command = calendarPatchCommand(task, {
      due: value === null ? { type: 'clear' } : { type: 'set', value },
    });
    if (!command || !this.tasks) return false;
    const result = await this.tasks.execute(command);
    presentTaskCommandResult(result);
    return result.type === 'ok' && result.changed;
  }

  private async applyDueInOrder(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<boolean> {
    let changed = false;
    for (const task of tasks) {
      const taskChanged = await this.setTaskDue(task, value);
      changed = taskChanged || changed;
    }
    return changed;
  }

  private async applyBulkDuePreset(
    tasks: readonly TaskSnapshot[],
    value: LocalDate,
  ): Promise<void> {
    const shouldClear = tasks.every((task) => task.planning.due === value);
    if (!shouldClear) {
      await this.applyDueInOrder(tasks, value);
      return;
    }
    for (const task of tasks) await this.setTaskDue(task, null);
  }

  private openTaskDatePicker(anchor: HTMLElement, tasks: readonly TaskSnapshot[]): void {
    this.clearTaskDatePicker();
    const focusKey = this.taskDateTriggerKey(anchor);
    const firstDue = tasks[0]?.planning.due;
    const initialValue =
      firstDue && tasks.every((task) => task.planning.due === firstDue) ? firstDue : undefined;
    let cleanup: (() => void) | undefined;
    cleanup = showDatePickerPopover({
      owner: this.el,
      anchor,
      boundary: this.el,
      ...(initialValue !== undefined && { initialValue }),
      onPick: (inputValue) => {
        try {
          const value = localDate(inputValue);
          const pendingFocus = focusKey
            ? {
                key: focusKey,
                armedRenderGeneration: this.taskCardRenderGeneration,
                changed: false,
              }
            : undefined;
          if (pendingFocus) {
            this.pendingTaskDateFocus = pendingFocus;
            this.taskDateFocusContinuityKey = pendingFocus.key;
          }
          const update =
            tasks.length === 1
              ? this.setTaskDue(tasks[0]!, value)
              : this.applyDueInOrder(tasks, value);
          if (pendingFocus) {
            const settleFocus = (changed: boolean): void => {
              if (this.pendingTaskDateFocus !== pendingFocus) return;
              if (!changed) {
                this.clearTaskDateFocusContinuity(pendingFocus.key);
                return;
              }
              pendingFocus.changed = true;
              this.releaseSettledTaskDateFocus(pendingFocus);
            };
            const abandonFocus = (): void => settleFocus(false);
            void update.then(settleFocus, abandonFocus);
          }
        } catch {
          // Native date inputs are normally valid; malformed programmatic values remain a no-op.
        }
      },
      onClose: () => {
        this.taskDatePickerCleanup = null;
      },
      ...(focusKey !== undefined && {
        restoreFocus: () => this.focusTaskDateTrigger(focusKey),
      }),
    });
    this.taskDatePickerCleanup = cleanup;
  }

  private clearTaskDatePicker(): void {
    this.taskDatePickerCleanup?.();
  }

  private taskDateTriggerKey(target: EventTarget | null): string | undefined {
    if (!target || !('ownerDocument' in target)) return undefined;
    const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerWindow || !(target instanceof ownerWindow.Element)) return undefined;
    const card = target.closest<HTMLElement>('.tc-task-card');
    const filePath = card?.dataset['filePath'];
    const line = card?.dataset['line'];
    return card && this.el.contains(card) && filePath !== undefined && line !== undefined
      ? `${filePath}:${line}`
      : undefined;
  }

  private focusTaskDateTrigger(key: string): boolean {
    const card = Array.from(this.el.querySelectorAll<HTMLElement>('.tc-task-card')).find(
      (candidate) =>
        `${candidate.dataset['filePath'] ?? ''}:${candidate.dataset['line'] ?? ''}` === key,
    );
    if (!card?.isConnected) return false;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  private completeTaskCardRender(): void {
    this.taskCardRenderGeneration += 1;
    const continuityKey = this.taskDateFocusContinuityKey;
    const restored = continuityKey !== null && this.focusTaskDateTrigger(continuityKey);
    if (continuityKey !== null && !restored) {
      this.clearTaskDateFocusContinuity(continuityKey);
      return;
    }
    const pending = this.pendingTaskDateFocus;
    if (pending?.changed) this.releaseSettledTaskDateFocus(pending, restored);
  }

  private releaseSettledTaskDateFocus(
    pending: NonNullable<CenterPanel['pendingTaskDateFocus']>,
    restored = this.focusTaskDateTrigger(pending.key),
  ): void {
    if (
      this.pendingTaskDateFocus !== pending ||
      !pending.changed ||
      this.taskCardRenderGeneration <= pending.armedRenderGeneration
    ) {
      return;
    }
    this.pendingTaskDateFocus = null;
    if (!restored && this.taskDateFocusContinuityKey === pending.key) {
      this.taskDateFocusContinuityKey = null;
    }
  }

  private clearTaskDateFocusContinuity(key: string): void {
    if (this.pendingTaskDateFocus?.key === key) {
      this.pendingTaskDateFocus = null;
    }
    if (this.taskDateFocusContinuityKey === key) this.taskDateFocusContinuityKey = null;
  }

  private abandonTaskDateFocus(): void {
    this.pendingTaskDateFocus = null;
    this.taskDateFocusContinuityKey = null;
  }

  private taskKey(task: TaskSnapshot): string {
    return `${task.source.filePath}:${task.source.line}`;
  }

  private visibleTaskCards(): HTMLElement[] {
    if (this.state.get('mode') !== 'tasks') return [];
    const scroll = Array.from(this.el.children).find((child) =>
      child.classList.contains('tc-center-scroll'),
    );
    return scroll ? Array.from(scroll.querySelectorAll<HTMLElement>('.tc-task-card')) : [];
  }

  private visibleTaskKeys(): string[] {
    return this.visibleTaskCards().map(
      (card) => `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`,
    );
  }

  private replaceRangeSelection(anchor: string, focus: string, keys: readonly string[]): void {
    const anchorIndex = keys.indexOf(anchor);
    const focusIndex = keys.indexOf(focus);
    this.selectedTaskKeys.clear();
    if (anchorIndex !== -1 && focusIndex !== -1) {
      const from = Math.min(anchorIndex, focusIndex);
      const to = Math.max(anchorIndex, focusIndex);
      for (const key of keys.slice(from, to + 1)) this.selectedTaskKeys.add(key);
    }
    this.updateSelectionVisuals();
  }

  private reconcileTaskSelection(keys: readonly string[]): void {
    const visible = new Set(keys);
    for (const key of this.selectedTaskKeys) {
      if (!visible.has(key)) this.selectedTaskKeys.delete(key);
    }
    const firstSelected = keys.find((key) => this.selectedTaskKeys.has(key)) ?? null;
    if (!this.selectionAnchorKey || !visible.has(this.selectionAnchorKey)) {
      this.selectionAnchorKey = firstSelected;
    }
    if (!this.selectionFocusKey || !visible.has(this.selectionFocusKey)) {
      this.selectionFocusKey = firstSelected;
    }
  }

  private focusTaskKey(key: string): void {
    const index = this.visibleTaskKeys().indexOf(key);
    const card = index === -1 ? undefined : this.visibleTaskCards()[index];
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest' });
  }

  private taskForKey(key: string): TaskSnapshot | undefined {
    const separator = key.lastIndexOf(':');
    if (separator === -1) return undefined;
    const filePath = key.slice(0, separator);
    const line = Number(key.slice(separator + 1));
    if (!Number.isInteger(line)) return undefined;
    return this.queries
      .list()
      .find((task) => task.source.filePath === filePath && task.source.line === line);
  }

  private updateSelectionVisuals(): void {
    // Sync tc-multi-selected class on each card
    this.el.querySelectorAll<HTMLElement>('.tc-task-card').forEach((card) => {
      const key = `${card.dataset['filePath'] ?? ''}:${card.dataset['line'] ?? ''}`;
      card.classList.toggle('tc-multi-selected', this.selectedTaskKeys.has(key));
    });

    // Update or remove badge
    const existing = this.el.querySelector('.tc-selection-badge');
    if (this.selectedTaskKeys.size >= 2) {
      if (existing) {
        existing.textContent = `${this.selectedTaskKeys.size} selected`;
      } else {
        const list = this.el.querySelector('.tc-center-scroll');
        if (list) {
          const badge = list.createDiv({ cls: 'tc-selection-badge' });
          badge.textContent = `${this.selectedTaskKeys.size} selected`;
          list.prepend(badge);
        }
      }
    } else {
      existing?.remove();
    }
  }

  private async setPriority(
    task: TaskSnapshot,
    priority: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  ): Promise<void> {
    if (isForecastCalendarTask(task)) return;
    const command = calendarPatchCommand(task, {
      priority: { type: 'set', value: priority },
    });
    if (!command || !this.tasks) return;
    presentTaskCommandResult(await this.tasks.execute(command));
  }

  private toggleTask(task: TaskSnapshot): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    return requestTaskCompletion(task, () => this.commitTaskToggle(task));
  }

  private async commitTaskToggle(task: TaskSnapshot): Promise<void> {
    const target = calendarMutationTarget(task);
    if (!target || !this.tasks) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'toggle-completion',
        target,
      }),
    );
  }

  private setTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    if (isForecastCalendarTask(task)) return Promise.resolve();
    if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(task, () => this.commitTaskStatus(task, symbol));
    }
    return this.commitTaskStatus(task, symbol);
  }

  private async commitTaskStatus(task: TaskSnapshot, symbol: string): Promise<void> {
    const target = calendarMutationTarget(task);
    if (!target || !this.tasks) return;
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'set-status',
        target,
        symbol,
      }),
    );
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
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        const command = calendarPatchCommand(task, patch);
        if (!this.tasks || !command) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        return this.tasks.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
    });
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private openForecastRecurrenceEditor(anchor: HTMLElement, source: CalendarTaskSource): void {
    this.dismissRecurrenceEditor();
    let cleanup: () => void;
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source,
      policy: { removeScheduledDate: this.settings.recurrence.removeScheduledDate },
      ownershipConflict: hasOtherCalendarRecurrenceOwner(source),
      onSubmit: (patch) => {
        if (!this.tasks) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'application-unavailable',
            contentState: 'unchanged' as const,
          });
        }
        const command = calendarSourcePatchCommand(source, patch);
        if (!command) {
          return Promise.resolve({
            type: 'io-error' as const,
            cause: 'unsupported-calendar-patch',
            contentState: 'unchanged' as const,
          });
        }
        return this.tasks.execute(command);
      },
      onClose: () => {
        if (this.recurrenceEditorCleanup === cleanup) {
          this.recurrenceEditorCleanup = null;
        }
      },
    });
    cleanup = () => handle.dismiss();
    this.recurrenceEditorCleanup = cleanup;
  }

  private dismissRecurrenceEditor(): void {
    const cleanup = this.recurrenceEditorCleanup;
    this.recurrenceEditorCleanup = null;
    cleanup?.();
  }
}
