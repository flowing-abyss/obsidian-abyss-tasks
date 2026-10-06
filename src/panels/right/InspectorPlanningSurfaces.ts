import type { App } from 'obsidian';
import { setIcon, setTooltip, type Component } from 'obsidian';
import { formatDurationFromMinutes, parseDurationToMinutes } from '../../parser/TaskParser';
import { DEFAULT_SETTINGS } from '../../settings/defaults';
import type { CalendarSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { colorForTag } from '../../tags/tagColor';
import { collectTaskTags } from '../../tags/taskTagCatalog';
import type { TaskQueryApi } from '../../tasks';
import {
  localDate,
  sameTaskNodeRef,
  subtreeRunning,
  type LocalDate,
  type PlanningTarget,
  type TaskCommandResult,
  type TaskNodeRef,
  type TaskPatch,
  type TaskPriority,
  type TaskRef,
  type TaskSnapshot,
} from '../../tasks';
import { anchoredPlacement, type AnchoredPlacementInput } from '../../ui/anchoredPlacement';
import { isImeOwnedEvent } from '../../ui/ime';
import { type InteractionOwnershipPort } from '../../ui/interactionOwnership';
import {
  mountRecurrenceEditor,
  type RecurrenceEditorHandle,
} from '../../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { bindSegmentedInputCommit, isUsableDateInputValue } from '../../ui/segmentedInputCommit';
import { setStatusMarkerCompletionBlocked, updateStatusMarker } from '../../ui/StatusMarker';
import { showStatusMenuAt, type StatusMenuHandle } from '../../ui/statusMenu';
import { showTagDropdown } from '../../ui/tagDropdown';
import { type RightPanelDraftState } from '../../ui/taskDraftContinuity';
import { openInFile } from '../../ui/taskNavigation';
import { taskNodeLine, taskNodeRef } from '../../ui/taskSelection';
import {
  type TimeBadgeHandle,
  type TrackedNode,
  type TrackingSurface,
} from '../../ui/timeTracking/TimeBadge';
import type {
  AddDateField,
  InspectorTaskOwner,
  PlanningControlKey,
  SchedulingDateField,
  TaskLike,
} from './inspectorTypes';
const DURATION_INPUT_EXAMPLE = '1h30m';

interface InspectorPlanningHost {
  readonly showInTaskList?: ((task: TaskLike) => void) | undefined;
  readonly root: () => HTMLElement;
  readonly mounted: () => boolean;
  readonly component: () => Component;
  readonly taskOwner: (task: TaskLike) => InspectorTaskOwner;
  readonly stack: () => readonly TaskLike[];
  readonly rebuildPlanningTargetStack: (
    root: TaskSnapshot,
    target: PlanningTarget,
  ) => readonly TaskLike[];
  readonly dependencyTask: (stack?: readonly TaskLike[]) => TaskLike | undefined;
  readonly trackingNode: () => TrackedNode | undefined;
  readonly timeBadge: () => TimeBadgeHandle | undefined;
  readonly formatDate: (d: string) => string;
  readonly onTypedInputReleased: () => void;
  readonly closeAttachedSearch: () => void;
  readonly closeSearchSurface: (surface: HTMLElement) => void;
}
interface InspectorPlanningCommands {
  readonly setStatus: (task: TaskLike, symbol: string) => Promise<void>;
  readonly updatePriority: (task: TaskLike, priority: TaskPriority) => Promise<TaskCommandResult>;
  readonly updateDate: (
    task: TaskLike,
    field: SchedulingDateField,
    date: LocalDate,
  ) => Promise<void>;
  readonly clearDate: (task: TaskLike) => Promise<void>;
  readonly clearPlanningDate: (task: TaskLike, field: AddDateField) => Promise<void>;
  readonly updateTime: (task: TaskLike, time: string) => Promise<void>;
  readonly updateDuration: (task: TaskSnapshot, minutes: number) => Promise<void>;
  readonly clearDuration: (task: TaskSnapshot) => Promise<void>;
  readonly removeTag: (task: TaskLike, tag: string) => Promise<void>;
  readonly addTags: (task: TaskLike, tags: readonly string[]) => Promise<'committed' | 'failed'>;
  readonly executePlanningPatch: (task: TaskLike, patch: TaskPatch) => Promise<TaskCommandResult>;
  readonly archiveRootTask: (ref: TaskRef) => Promise<void>;
  readonly deleteTask: (task: TaskLike) => Promise<void>;
  readonly promoteSubtask: (task: TaskLike) => Promise<void>;
}
interface InspectorPlanningSurfacesOptions {
  readonly app: App;
  readonly settings: CalendarSettings | undefined;
  readonly statusRegistry: StatusRegistry;
  readonly queries: Pick<TaskQueryApi, 'observedTags'> | undefined;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly timeTracking: TrackingSurface | undefined;
  readonly host: InspectorPlanningHost;
  readonly commands: InspectorPlanningCommands;
}

function timeChipPresentation(
  time: string | undefined,
  duration: number | undefined,
): { readonly text: string; readonly label: string } {
  if (time == null) return { text: '⏰ Time', label: 'Set time and duration' };
  if (duration == null) {
    return { text: `⏰ ${time}`, label: `Change time, currently ${time}, no duration` };
  }
  return {
    text: `⏰ ${time} · ${formatDurationFromMinutes(duration)}`,
    label: `Change time, currently ${time}, duration ${String(duration)} minutes`,
  };
}

function dimensionOrFallback(primary: number, secondary: number, fallback: number): number {
  return finiteNonzeroOr(primary, finiteNonzeroOr(secondary, fallback));
}

function finiteNonzeroOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

function visiblePickerBoundary(panel: DOMRect, overlay: DOMRect, window: Window | null): DOMRect {
  const left = Math.max(0, panel.left, overlay.left);
  const top = Math.max(0, panel.top, overlay.top);
  const right = Math.min(window?.innerWidth ?? Infinity, panel.right, overlay.right);
  const bottom = Math.min(window?.innerHeight ?? Infinity, panel.bottom, overlay.bottom);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function setPopoverLength(popover: HTMLElement, property: string, value: number): void {
  popover.style.setProperty(`--abyss-pop-${property}`, `${value}px`);
}

function constrainDependencyPicker(
  popover: HTMLElement,
  input: Pick<AnchoredPlacementInput, 'anchor' | 'boundary' | 'gap' | 'edgeGap'>,
): DOMRect {
  const { anchor, gap, edgeGap } = input;
  const boundary = visiblePickerBoundary(
    input.boundary,
    popover.closest('.abyss-modal')?.getBoundingClientRect() ?? input.boundary,
    popover.ownerDocument.defaultView,
  );
  setPopoverLength(popover, 'width', Math.max(0, boundary.width - 2 * edgeGap));
  const chrome =
    popover.scrollHeight -
    (popover.querySelector<HTMLElement>('[role="listbox"]')?.offsetHeight ?? 0);
  setPopoverLength(
    popover,
    'height',
    Math.max(
      0,
      Math.min(
        boundary.height - 2 * edgeGap,
        Math.max(
          chrome,
          anchor.top - boundary.top - edgeGap - gap,
          boundary.bottom - edgeGap - anchor.bottom - gap,
        ),
      ),
    ),
  );
  return boundary;
}

function datePopoverValue(task: TaskLike, field: SchedulingDateField): string | undefined {
  if (field === 'due') return task.planning.due ?? task.planning.scheduled;
  return field === 'scheduled' ? task.planning.scheduled : task.planning.start;
}

function restorePopupRole(anchor: HTMLElement, previous: string | null): void {
  if (previous !== null && previous !== '') anchor.setAttribute('aria-haspopup', previous);
  else anchor.removeAttribute('aria-haspopup');
}

/** The controls to focus after a rebuild, in order, for focus that was on (or opened from) `key`. */
function planningReturnKeys(
  key: PlanningControlKey,
  addDateField: AddDateField | undefined,
): readonly PlanningControlKey[] {
  if (key === 'scheduled' || key === 'start') return [key, 'add-date', 'date'];
  if (key === 'add-date')
    return addDateField === undefined ? ['add-date', 'date'] : ['add-date', addDateField, 'date'];
  if (key === 'tracking-toggle') return ['tracking-toggle', 'tracking-sessions'];
  return [key];
}

/** The control that opened a repeat editor: one object per open, which a restore carries on. */
interface RecurrenceIntent {
  readonly key: PlanningControlKey;
}

const PRIORITY_CHIP_LABELS: Readonly<Record<string, string>> = {
  A: '🚩 Highest',
  B: '🚩 High',
  C: '🚩 Medium',
  D: 'Priority',
  E: '🚩 Low',
  F: '🚩 Lowest',
};

/** The priority chip's label, `data-priority`, and classes, for a render and a pending change. */
function applyPriorityChipPresentation(chip: HTMLElement, priority: string): void {
  chip.textContent = PRIORITY_CHIP_LABELS[priority] ?? 'Priority';
  chip.setAttribute('data-priority', priority);
  chip.className = `abyss-chip abyss-priority-chip abyss-priority-chip--${priority}${priority === 'D' ? ' abyss-chip-empty' : ''}`;
}

/**
 * The priority the chip shows, including a choice whose write is still pending. A popover marks it,
 * and a failed or refused choice rolls the chip back to the priority shown at its click.
 */
function shownPriority(chip: HTMLElement, task: TaskLike): string {
  return chip.getAttribute('data-priority') ?? task.priority;
}
function markPriorityOptions(popover: HTMLElement, priority: string): void {
  popover.querySelectorAll<HTMLElement>('.abyss-priority-option').forEach((option) => {
    const active = option.getAttribute('data-priority') === priority;
    option.toggleClass('is-active', active);
    option.setAttribute('aria-selected', String(active));
    const check = option.querySelector<HTMLElement>('.abyss-priority-option-check');
    if (check === null) return;
    if (active) setIcon(check, 'check');
    else check.empty();
  });
}

function clearOptionalTimer(ownerWindow: Window | null, timer: number | undefined): void {
  if (timer !== undefined) ownerWindow?.clearTimeout(timer);
}

export class InspectorPlanningSurfaces {
  readonly #app: InspectorPlanningSurfacesOptions['app'];
  readonly #settings: InspectorPlanningSurfacesOptions['settings'];
  readonly #statusRegistry: InspectorPlanningSurfacesOptions['statusRegistry'];
  readonly #queries: InspectorPlanningSurfacesOptions['queries'];
  readonly #interactionOwnership: InspectorPlanningSurfacesOptions['interactionOwnership'];
  readonly #timeTracking: InspectorPlanningSurfacesOptions['timeTracking'];
  readonly #host: InspectorPlanningSurfacesOptions['host'];
  readonly #commands: InspectorPlanningCommands;
  constructor(options: InspectorPlanningSurfacesOptions) {
    this.#app = options.app;
    this.#settings = options.settings;
    this.#statusRegistry = options.statusRegistry;
    this.#queries = options.queries;
    this.#interactionOwnership = options.interactionOwnership;
    this.#timeTracking = options.timeTracking;
    this.#host = options.host;
    this.#commands = options.commands;
  }

  readonly #anchoredSurfaceCleanups = new Map<HTMLElement, () => void>();

  #typedInput:
    | {
        readonly surface: HTMLElement;
        readonly input: HTMLInputElement;
        readonly target: TaskNodeRef;
        readonly opener: HTMLElement;
        openingFocusPending: boolean;
        submitted: boolean;
      }
    | undefined;

  hasFocusedTypedInputFor(target: TaskNodeRef): boolean {
    const entry = this.#typedInput;
    return (
      entry !== undefined &&
      !entry.submitted &&
      entry.surface.isConnected &&
      entry.input.isConnected &&
      (entry.input.ownerDocument.activeElement === entry.input ||
        (entry.openingFocusPending && this.#canFocusOpeningInput(entry.input, entry.opener))) &&
      sameTaskNodeRef(entry.target, target)
    );
  }

  #canFocusOpeningInput(input: HTMLInputElement, opener: HTMLElement): boolean {
    const active = input.ownerDocument.activeElement;
    return (
      active === input ||
      active === opener ||
      active === input.ownerDocument.body ||
      active === this.#host.root() ||
      active === null
    );
  }

  #resumeTypedInput(surface: HTMLElement): void {
    if (this.#typedInput?.surface === surface && surface.isConnected) {
      this.#typedInput.submitted = false;
    }
  }

  #releaseTypedInput(surface: HTMLElement): void {
    if (this.#typedInput?.surface !== surface) return;
    this.#typedInput = undefined;
    this.#host.onTypedInputReleased();
  }

  #recurrenceDraftEditor:
    | {
        readonly target: TaskNodeRef;
        readonly handle: RecurrenceEditorHandle;
        readonly surface: HTMLElement;
      }
    | undefined;

  captureRecurrenceDraft(active: Element | null): RightPanelDraftState | undefined {
    const recurrence = this.#recurrenceDraftEditor;
    if (recurrence == null) return undefined;
    const editor = recurrence.handle.captureDraftState();
    const hadFocus = active !== null && recurrence.surface.contains(active);
    if (!editor.dirty && !hadFocus) return undefined;
    return { kind: 'recurrence-editor', target: recurrence.target, editor, hadFocus };
  }

  readonly #dependencyStatusMarkers = new Map<HTMLElement, InspectorTaskOwner>();

  #dependencyStatusMenu: StatusMenuHandle | undefined;

  /**
   * The planning controls of the current render, so a rebuild can refocus one. A control that
   * `registerPlanningControl` records maps both ways, key to control and control to
   * key. A tag's × maps one way, control to `add-tag`, through
   * `#registerTagRemoveControl`.
   */
  readonly #planningControls = new Map<PlanningControlKey, HTMLElement>();

  readonly #planningControlKeys = new Map<Element, PlanningControlKey>();

  /** The control each open anchored surface was opened from, while the surface is open. */
  readonly #surfaceOpeners = new Map<HTMLElement, HTMLElement>();

  /** The field of the date popover "+ date" opened, until the next render. */
  #addDateField: AddDateField | undefined;

  /**
   * The control that opened the latest repeat editor. It is kept until the next open, a selection
   * change that does not continue the owned selection, or destroy. A restore continues it.
   */
  #recurrenceIntent: RecurrenceIntent | undefined;

  registerPlanningControl(key: PlanningControlKey, control: HTMLElement): void {
    this.#planningControls.set(key, control);
    this.#planningControlKeys.set(control, key);
  }

  /** A tag's × hands focus to + tag after the rebuild; it is not a return target itself. */
  #registerTagRemoveControl(remove: HTMLElement): void {
    this.#planningControlKeys.set(remove, 'add-tag');
  }

  /** The badge keeps its buttons across renders, so each render registers the same elements. */
  registerTrackingControls(): void {
    const controls = this.#host.timeBadge()?.controls();
    if (controls === undefined) return;
    this.registerPlanningControl('tracking-toggle', controls.toggle);
    this.registerPlanningControl('tracking-sessions', controls.body);
  }

  resetMetadataControls(): void {
    for (const [element, key] of this.#planningControlKeys) {
      if (key === 'more-actions') continue;
      this.#planningControlKeys.delete(element);
      this.#planningControls.delete(key);
    }
  }

  resetRenderedControls(): void {
    this.#dependencyStatusMarkers.clear();
    this.#planningControls.clear();
    this.#planningControlKeys.clear();
    this.#addDateField = undefined;
  }

  /** The control the current render registered for `key`. */
  #planningControl(key: PlanningControlKey): HTMLElement | undefined {
    return this.#planningControls.get(key);
  }

  /** The planning control that holds focus, or that opened the surface holding it. */
  #focusedPlanningKey(): PlanningControlKey | undefined {
    const focused = this.#host.root().ownerDocument.activeElement;
    if (focused === null) return undefined;
    const direct = this.#planningControlKeys.get(focused);
    if (direct !== undefined) return direct;
    for (const [surface, opener] of this.#surfaceOpeners) {
      if (surface.contains(focused)) return this.#planningControlKeys.get(opener);
    }
    return undefined;
  }

  planningFocusKeys(): readonly PlanningControlKey[] | undefined {
    const key = this.#focusedPlanningKey();
    return key === undefined ? undefined : planningReturnKeys(key, this.#addDateField);
  }

  /** Refocuses the status marker that held focus, or else the first rebuilt control still usable. */
  restoreRenderFocus(
    statusFocus: TaskNodeRef | undefined,
    controls: readonly PlanningControlKey[] | undefined,
  ): void {
    if (statusFocus !== undefined) {
      this.#restoreStatusFocus(statusFocus);
      return;
    }
    for (const key of controls ?? []) {
      const control = this.#planningControls.get(key);
      if (control?.isConnected !== true || control.matches(':disabled')) continue;
      control.focus({ preventScroll: true });
      return;
    }
  }

  /**
   * Records which control opened the repeat editor, or carries on the live intent a restore passes,
   * and resolves its rebuilt twin at close time.
   */
  #beginRecurrenceIntent(
    anchor: HTMLElement,
    live?: RecurrenceIntent,
  ): () => HTMLElement | undefined {
    const intent: RecurrenceIntent = live ?? {
      key: this.#planningControlKeys.get(anchor) ?? 'repeat',
    };
    this.#recurrenceIntent = intent;
    return () =>
      this.#host.mounted() && this.#recurrenceIntent === intent
        ? this.#planningControls.get(intent.key)
        : undefined;
  }

  /**
   * An outside click or Escape closes the repeat editor. After an outside click, focus goes back to
   * its opener only when the click left focus on the body, on the inspector container, or inside
   * the editor. Escape's anchor focus follows either branch.
   */
  #dismissRecurrencePopover(popover: HTMLElement, handle: RecurrenceEditorHandle): void {
    if (this.focusIsNeutral() || popover.contains(this.#host.root().ownerDocument.activeElement)) {
      handle.dismiss();
      return;
    }
    this.#removeAnchoredSurface(popover);
  }

  /** Whether focus is nowhere, on the body, or on the inspector container: no control holds it. */
  focusIsNeutral(): boolean {
    const ownerDocument = this.#host.root().ownerDocument;
    const active = ownerDocument.activeElement;
    return active === null || active === ownerDocument.body || active === this.#host.root();
  }

  statusFocusTarget(
    stack: readonly TaskLike[],
    resolve: (stack: readonly TaskLike[]) => TaskLike | undefined = this.#host.dependencyTask,
  ): TaskNodeRef | undefined {
    const focused = this.#host.root().ownerDocument.activeElement;
    if (focused === null) return undefined;
    for (const [marker, owner] of this.#dependencyStatusMarkers) {
      const task = owner.current;
      if (task === undefined) continue;
      if (!(marker === focused || marker.closest('.abyss-status-control') === focused)) continue;
      const current = resolve(task === stack[stack.length - 1] ? stack : [...stack, task]);
      return current === undefined ? undefined : taskNodeRef(current);
    }
    return undefined;
  }

  #restoreStatusFocus(target: TaskNodeRef): void {
    for (const [marker, owner] of this.#dependencyStatusMarkers) {
      const task = owner.current;
      if (task === undefined) continue;
      if (!sameTaskNodeRef(taskNodeRef(task), target)) continue;
      (marker.closest<HTMLElement>('.abyss-status-control') ?? marker).focus({
        preventScroll: true,
      });
      return;
    }
  }

  renderTimeChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const duration = 'source' in task ? task.planning.duration : undefined;
    const time = task.planning.time;
    const presentation = timeChipPresentation(time, duration);
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-time${time == null ? ' abyss-chip-empty' : ''}`,
      text: presentation.text,
      attr: {
        'aria-label': presentation.label,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
    });
    this.registerPlanningControl('time', chip);
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showTimePopover(chip, current);
    });
  }

  renderDateChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const d = task.planning.due ?? task.planning.scheduled;
    let field: 'due' | 'scheduled' = 'due';
    if (task.planning.due == null && task.planning.scheduled != null) field = 'scheduled';
    const chip = container.createEl('button', {
      cls: `abyss-chip${d != null ? '' : ' abyss-chip-empty'}`,
      text: d != null ? `📅 ${this.#host.formatDate(d)}` : '📅 Date',
    });
    this.registerPlanningControl('date', chip);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showDatePopover(chip, current, field);
    });
  }

  /** "Plan" (⏳/`scheduled`) chip — same round-pill/popover pattern as the due-date chip. */
  renderScheduledChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const value = task.planning.scheduled;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-scheduled${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `⏳ ${this.#host.formatDate(value)}` : '⏳ Plan',
    });
    setTooltip(chip, 'Set plan date');
    this.registerPlanningControl('scheduled', chip);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showDatePopover(chip, current, 'scheduled');
    });
  }

  /** "Start" (🛫/`start`) chip — same round-pill/popover pattern as the due-date chip. */
  renderStartChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const value = task.planning.start;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-start${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `🛫 ${this.#host.formatDate(value)}` : '🛫 Start',
    });
    setTooltip(chip, 'Set start date');
    this.registerPlanningControl('start', chip);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showDatePopover(chip, current, 'start');
    });
  }

  /**
   * Compact "+"-style control offering to add whichever of Start/Plan are currently unset —
   * mirrors the "+ tag" button's pattern (small affordance that reveals a chooser) rather than
   * an always-visible placeholder pill. Renders nothing once both are already set (nothing left
   * to offer), and remains extensible for future addable properties (e.g. recurrence).
   */
  renderAddDateMenu(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const options: Array<{ field: AddDateField; label: string }> = [];
    if (task.planning.start == null) options.push({ field: 'start', label: '🛫 Start' });
    if (task.planning.scheduled == null) options.push({ field: 'scheduled', label: '⏳ Plan' });
    if (options.length === 0) return;

    const addBtn = container.createEl('button', {
      cls: 'abyss-chip abyss-chip-add abyss-chip-add-date',
      text: '+ date',
      attr: {
        'aria-label': 'Add start or plan date',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    this.registerPlanningControl('add-date', addBtn);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showAddDateMenu(addBtn, current, options);
    });
  }

  /** Small menu anchored to the "+ date" button — clicking an option opens showDatePopover. */
  #showAddDateMenu(
    anchor: HTMLElement,
    task: TaskLike,
    options: Array<{ field: AddDateField; label: string }>,
  ): void {
    const existing = this.#host.root().querySelector('.abyss-add-date-menu');
    if (existing != null) {
      this.#removeAnchoredSurface(existing as HTMLElement);
      return;
    }
    this.#host
      .root()
      .querySelectorAll<HTMLElement>('.abyss-add-date-menu')
      .forEach((element) => {
        this.#removeAnchoredSurface(element);
      });
    this.#host
      .root()
      .querySelectorAll<HTMLElement>('.abyss-context-menu')
      .forEach((element) => {
        this.#removeAnchoredSurface(element);
      });

    const menu = this.#host.root().createDiv({
      cls: 'abyss-context-menu abyss-add-date-menu abyss-add-date-menu--compact abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Add date' },
    });
    for (const opt of options) {
      this.#createContextMenuItem(
        menu,
        'abyss-context-item abyss-add-date-menu-item',
        opt.label,
        () => {
          this.#addDateField = opt.field;
          this.#removeAnchoredSurface(menu);
          this.#showDatePopover(anchor, task, opt.field);
        },
      );
    }

    this.positionAnchoredSurface(menu, anchor, 'below-start');
    this.#dismissMenuOnOutsideClick(menu, anchor);
    menu.querySelector<HTMLElement>('.abyss-context-item')?.focus({ preventScroll: true });
  }

  #createContextMenuItem(
    menu: HTMLElement,
    className: string,
    text: string,
    action: () => void,
  ): HTMLElement {
    const item = menu.createDiv({
      cls: className,
      text,
      attr: { role: 'menuitem', tabindex: '0' },
    });
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return item;
  }

  #createContextMenuSeparator(menu: HTMLElement): void {
    menu.createDiv({
      cls: 'abyss-context-separator',
      attr: { role: 'separator' },
    });
  }

  renderPriorityChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const chip = container.createEl('button', {
      attr: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
    });
    applyPriorityChipPresentation(chip, task.priority);
    this.registerPlanningControl('priority', chip);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showPriorityPopover(chip, current);
    });
  }

  renderRecurrenceChip(container: HTMLElement, task: TaskLike): void {
    const owner = this.#host.taskOwner(task);
    const recurrence = task.recurrence;
    const hasRecurrence = recurrence !== undefined && recurrence !== '';
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-repeat-chip${hasRecurrence ? '' : ' abyss-chip-add abyss-chip-empty'}`,
    });
    setTooltip(chip, hasRecurrence ? 'Edit repeat' : 'Add repeat');
    this.registerPlanningControl('repeat', chip);
    if (hasRecurrence) {
      renderRecurrenceBadge(chip, recurrenceBadgeInput(recurrence));
      chip.createSpan({ cls: 'abyss-repeat-chip-label', text: recurrence });
    } else {
      chip.setText('+ repeat');
    }
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      this.#showRecurrencePopover(chip, current, this.#host.stack());
    });
  }

  #showRecurrencePopover(
    anchor: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
    restoring?: { readonly intent: RecurrenceIntent | undefined },
  ): void {
    const existing = this.#host.root().querySelector<HTMLElement>('.abyss-recurrence-popover');
    this.clearPopovers();
    if (existing != null) return;
    // A restore leaves focus where it is; a restored draft that held focus refocuses its control.
    if (restoring === undefined) anchor.focus();
    const root = stack[0];
    const target = taskNodeRef(task);
    if (root == null || !('source' in root)) return;

    const { popover, inline } = this.#createRecurrencePopover();
    const dismissalFocus = this.#beginRecurrenceIntent(anchor, restoring?.intent);
    const handle = mountRecurrenceEditor({
      container: popover,
      source: { root, target },
      policy: {
        removeScheduledDate: this.#settings?.recurrence.removeScheduledDate === true,
      },
      ownershipConflict: this.#hasRecurrenceOwnershipConflict(task, stack),
      onSubmit: (patch) => this.#commands.executePlanningPatch(task, patch),
      onClose: () => {
        this.#removeAnchoredSurface(popover);
      },
      dismissalFocus,
    });
    this.#recurrenceDraftEditor = { target, handle, surface: popover };
    const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title !== null && title.id !== '') popover.setAttribute('aria-labelledby', title.id);
    this.#placeRecurrencePopover(popover, anchor, inline);
    const placementCleanup = this.#anchoredSurfaceCleanups.get(popover);
    const editorCleanup = (): void => {
      handle.destroy();
      if (this.#recurrenceDraftEditor?.surface === popover) this.#recurrenceDraftEditor = undefined;
      placementCleanup?.();
      if (this.#anchoredSurfaceCleanups.get(popover) === editorCleanup) {
        this.#anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.#anchoredSurfaceCleanups.set(popover, editorCleanup);
    this.#dismissMenuOnOutsideClick(popover, anchor, () => {
      this.#dismissRecurrencePopover(popover, handle);
    });
    if (restoring === undefined) this.#deferRecurrenceFocus(handle);
  }

  #placeRecurrencePopover(popover: HTMLElement, anchor: HTMLElement, inline: boolean): void {
    if (!inline) this.positionAnchoredSurface(popover, anchor, 'below-start');
  }

  #createRecurrencePopover(): { popover: HTMLElement; inline: boolean } {
    const surfaceRoot = this.#host.root();
    const chips = surfaceRoot.querySelector<HTMLElement>(':scope > .abyss-chips-row');
    const inline = surfaceRoot.closest('.abyss-modal') !== null && chips !== null;
    const popover = surfaceRoot.createDiv({
      cls: `abyss-popover abyss-recurrence-popover ${inline ? 'abyss-recurrence-popover-inline' : 'abyss-popover-anchored'}`,
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
    if (inline) chips.after(popover);
    return { popover, inline };
  }

  #deferRecurrenceFocus(handle: RecurrenceEditorHandle): void {
    this.#host.root().ownerDocument.defaultView?.setTimeout(() => {
      handle.focus();
    }, 0);
  }

  #hasRecurrenceOwnershipConflict(task: TaskLike, stack: readonly TaskLike[]): boolean {
    if (stack.slice(0, -1).some((ancestor) => ancestor.recurrence !== undefined)) return true;
    const queue = [...task.subtasks];
    for (let index = 0; index < queue.length; index++) {
      const descendant = queue[index];
      if (descendant === undefined) break;
      if (descendant.recurrence !== undefined) return true;
      queue.push(...descendant.subtasks);
    }
    return false;
  }

  renderTagChip(container: HTMLElement, task: TaskLike, tag: string): void {
    const owner = this.#host.taskOwner(task);
    const chip = container.createSpan({ cls: 'abyss-chip abyss-chip-tag' });
    const color = this.#getTagColor(tag);
    if (color !== undefined && color !== '') {
      chip.setCssProps({ '--abyss-chip-tag-color': color });
    }
    chip.createSpan({ text: tag });
    const x = chip.createEl('button', { cls: 'abyss-chip-remove', text: '×' });
    this.#registerTagRemoveControl(x);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current === undefined) return;
      runAsyncAction(this.#commands.removeTag(current, tag));
    });
  }

  #getTagColor(tag: string): string | undefined {
    if (this.#settings == null) return undefined;
    return colorForTag(tag, this.#settings.tagGroups);
  }

  clearPopovers(): void {
    // The sessions popover is owned by the badge, not by the anchored-surface map, so it is told
    // to close rather than merely detached; otherwise it would keep its document listeners.
    this.#host.timeBadge()?.closePopover();
    this.#host
      .root()
      .querySelectorAll<HTMLElement>('.abyss-popover')
      .forEach((element) => {
        this.#removeAnchoredSurface(element);
      });
  }

  #removeAnchoredSurface(surface: HTMLElement): void {
    // Read before the cleanup: the recurrence cleanup empties the editor and drops focus to body.
    const heldFocus = surface.contains(surface.ownerDocument.activeElement);
    const opener = this.#surfaceOpeners.get(surface);
    this.#host.closeSearchSurface(surface);
    this.#anchoredSurfaceCleanups.get(surface)?.();
    if (heldFocus && opener?.isConnected === true) opener.focus({ preventScroll: true });
    surface.remove();
  }

  clearAnchoredSurfaces(): void {
    this.#host.closeAttachedSearch();
    for (const [surface, cleanup] of this.#anchoredSurfaceCleanups) {
      cleanup();
      surface.remove();
    }
    this.#anchoredSurfaceCleanups.clear();
    this.#recurrenceDraftEditor = undefined;
  }

  closeDependencyStatusMenu(): void {
    const menu = this.#dependencyStatusMenu;
    this.#dependencyStatusMenu = undefined;
    menu?.close();
  }

  openStatusMenu(event: MouseEvent, task: TaskLike): StatusMenuHandle {
    this.clearAnchoredSurfaces();
    return showStatusMenuAt(event, {
      task,
      registry: this.#statusRegistry,
      owner: this.#host.component(),
      onPickStatus: (symbol) => {
        runAsyncAction(this.#commands.setStatus(task, symbol));
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.#commands.updatePriority(task, priority));
      },
      interactionOwnership: this.#interactionOwnership,
    });
  }

  /**
   * Small date-picker popover shared by the due/plan/start chips. `field` selects which
   * metadata date is being edited — the popover markup, positioning, and clear-button
   * behavior are identical for all three; only the read/write pair differs.
   */
  #showDatePopover(anchor: HTMLElement, task: TaskLike, field: SchedulingDateField = 'due'): void {
    const already = this.#host.root().querySelector('.abyss-date-popover');
    this.clearPopovers();
    if (already != null) return;

    const previousPopupRole = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-haspopup', 'dialog');
    const pop = this.#host.root().createDiv({
      cls: 'abyss-popover abyss-date-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': `Set ${field === 'scheduled' ? 'plan' : field} date` },
    });

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-date-input',
      attr: { type: 'date', value: datePopoverValue(task, field) ?? '' },
    });
    const ownerWindow = input.ownerDocument.defaultView;
    const entry = {
      surface: pop,
      input,
      target: taskNodeRef(task),
      opener: anchor,
      openingFocusPending: ownerWindow !== null,
      submitted: false,
    };
    this.#typedInput = entry;
    const draft = bindSegmentedInputCommit({
      input,
      boundary: pop,
      commit: () => {
        if (!isUsableDateInputValue(input.value)) return;
        entry.submitted = true;
        runAsyncAction(this.#commands.updateDate(task, field, localDate(input.value)));
        this.#removeAnchoredSurface(pop);
      },
    });
    const focusTimer = ownerWindow?.setTimeout(() => {
      if (this.#typedInput !== entry) return;
      try {
        const stack = this.#host.stack();
        const selected = stack[stack.length - 1];
        if (
          this.#host.mounted() &&
          selected !== undefined &&
          this.hasFocusedTypedInputFor(taskNodeRef(selected)) &&
          this.#canFocusOpeningInput(input, anchor)
        )
          input.focus();
      } finally {
        if (this.#typedInput === entry) {
          entry.openingFocusPending = false;
          this.#host.onTypedInputReleased();
        }
      }
    }, 0);

    this.#renderPopoverClear(inputRow, 'Clear date', () => {
      entry.submitted = true;
      draft.cancel();
      if (field === 'due') runAsyncAction(this.#commands.clearDate(task));
      else runAsyncAction(this.#commands.clearPlanningDate(task, field));
      this.#removeAnchoredSurface(pop);
    });
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.#dismissMenuOnOutsideClick(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        clearOptionalTimer(ownerWindow, focusTimer);
        entry.openingFocusPending = false;
        draft.cancel();
        restorePopupRole(anchor, previousPopupRole);
        this.#releaseTypedInput(pop);
      },
    });
  }

  #showPriorityPopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.#host.root().querySelector('.abyss-priority-popover');
    this.clearPopovers();
    if (already != null) return;

    const pop = this.#host.root().createDiv({
      cls: 'abyss-popover abyss-priority-popover abyss-popover-anchored',
      attr: { role: 'listbox', 'aria-label': 'Priority' },
    });

    const options: Array<{ value: TaskPriority; label: string }> = [
      { value: 'A', label: 'Highest' },
      { value: 'B', label: 'High' },
      { value: 'C', label: 'Medium' },
      { value: 'D', label: 'None' },
      { value: 'E', label: 'Low' },
      { value: 'F', label: 'Lowest' },
    ];
    for (const opt of options) {
      const btn = pop.createEl('button', {
        cls: 'abyss-priority-option',
        attr: { 'data-priority': opt.value, role: 'option' },
      });
      btn.createSpan({ cls: 'abyss-priority-option-check' });
      const flagEl = btn.createSpan({ cls: 'abyss-priority-option-flag' });
      setIcon(flagEl, 'flag');
      btn.createSpan({ cls: 'abyss-priority-option-label', text: opt.label });
      btn.addEventListener('click', () => {
        const previous = shownPriority(anchor, task);
        applyPriorityChipPresentation(anchor, opt.value);
        this.#removeAnchoredSurface(pop);
        runAsyncAction(this.#commitPriorityChoice(anchor, task, opt.value, previous));
      });
    }
    markPriorityOptions(pop, shownPriority(anchor, task));
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.#dismissMenuOnOutsideClick(pop, anchor);
    pop
      .querySelector<HTMLElement>('.abyss-priority-option.is-active')
      ?.focus({ preventScroll: true });
  }

  /**
   * Writes a chosen priority; a failure or a refusal puts back the priority the chip showed. A
   * popover opened again while the write was pending marks that priority again, and focus stays.
   */
  async #commitPriorityChoice(
    chip: HTMLElement,
    task: TaskLike,
    priority: TaskPriority,
    previous: string,
  ): Promise<void> {
    const result = await this.#commands.updatePriority(task, priority);
    if (result.type === 'ok' || !chip.isConnected) return;
    applyPriorityChipPresentation(chip, previous);
    const popover = this.#host.root().querySelector<HTMLElement>('.abyss-priority-popover');
    if (popover !== null) markPriorityOptions(popover, previous);
  }

  positionAnchoredSurface(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    this.#anchoredSurfaceCleanups.get(popover)?.();
    const ownerDocument = this.#host.root().ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const overlay = anchor.closest('.abyss-modal');
    let disposed = false;
    const position = (): void => {
      if (!disposed) this.#placeAnchoredSurface(popover, anchor, preferred);
    };
    position();
    const listen = (method: 'addEventListener' | 'removeEventListener'): void => {
      ownerWindow?.[method]('resize', position);
      ownerWindow?.[method]('scroll', position);
      ownerDocument[method]('scroll', position, true);
    };
    listen('addEventListener');
    // A surface changes size once it is placed (the inspector's scrollbar goes, its content
    // wraps), so every anchored surface is placed again when it or its surroundings resize. The
    // observer places it on the next frame: a placement inside its callback resizes what it
    // observes again, which the browser reports as a ResizeObserver loop.
    let frame: number | undefined;
    const schedule = (): void => {
      if (disposed || frame !== undefined || ownerWindow === null) return;
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = undefined;
        position();
      });
    };
    const ResizeObserver = ownerWindow?.ResizeObserver;
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined;
    for (const element of new Set([
      popover,
      anchor,
      this.#host.root(),
      overlay,
      popover.offsetParent,
      ...popover.children,
    ])) {
      if (element !== null) observer?.observe(element);
    }
    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) ownerWindow?.cancelAnimationFrame(frame);
      observer?.disconnect();
      listen('removeEventListener');
      if (this.#anchoredSurfaceCleanups.get(popover) === cleanup) {
        this.#anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.#anchoredSurfaceCleanups.set(popover, cleanup);
  }

  #placeAnchoredSurface(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    const computed = popover.ownerDocument.defaultView?.getComputedStyle(popover);
    const geometry = {
      boundary: this.#host.root().getBoundingClientRect(),
      anchor: anchor.getBoundingClientRect(),
      edgeGap: this.#cssLengthToPx(
        computed?.getPropertyValue('--abyss-popover-edge-gap') ?? '',
        popover,
        8,
      ),
      gap: this.#cssLengthToPx(
        computed?.getPropertyValue('--abyss-popover-anchor-gap') ?? '',
        popover,
        4,
      ),
    };
    if (popover.matches('.abyss-dep-search'))
      geometry.boundary = constrainDependencyPicker(popover, geometry);
    const floating = popover.getBoundingClientRect();
    const placement = anchoredPlacement({
      ...geometry,
      preferred,
      floating: {
        width: dimensionOrFallback(
          floating.width,
          popover.offsetWidth,
          finiteNonzeroOr(parseFloat(computed?.minWidth ?? ''), 160),
        ),
        height: dimensionOrFallback(floating.height, popover.offsetHeight, 0),
      },
    });
    // Convert viewport placement into the actual offset parent's padding box,
    // independently of the visible panel/modal boundary used to contain it.
    const block = popover.offsetParent ?? this.#host.root();
    const rect = block.getBoundingClientRect();
    setPopoverLength(popover, 'top', placement.top - rect.top - block.clientTop + block.scrollTop);
    setPopoverLength(
      popover,
      'left',
      placement.left - rect.left - block.clientLeft + block.scrollLeft,
    );
    popover.dataset['side'] = placement.side;
  }

  #cssLengthToPx(value: string, relativeTo: HTMLElement, fallback: number): number {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    if (trimmed.endsWith('em')) {
      const parsedFontSize = parseFloat(
        relativeTo.ownerDocument.defaultView?.getComputedStyle(
          trimmed.endsWith('rem') ? relativeTo.ownerDocument.documentElement : relativeTo,
        ).fontSize ?? '',
      );
      const fontSize = finiteNonzeroOr(parsedFontSize, 16);
      return parseFloat(trimmed) * fontSize;
    }
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  showTagInput(container: HTMLElement, task: TaskLike, anchor: HTMLElement): void {
    const existing = this.#host.root().querySelector<HTMLElement>('.abyss-tag-dropdown-wrap');
    if (existing != null) {
      this.#removeAnchoredSurface(existing);
      return;
    }
    const surface = showTagDropdown(
      container,
      collectTaskTags(
        this.#queries?.observedTags() ?? [],
        this.#settings ?? DEFAULT_SETTINGS,
        task.tags,
      ),
      (tag) => this.#getTagColor(tag),
      async (tags) => {
        const entry = this.#typedInput;
        if (entry?.surface === surface) entry.submitted = true;
        try {
          const result = await this.#commands.addTags(task, tags);
          if (result === 'failed') this.#resumeTypedInput(surface);
          return result;
        } catch (error) {
          this.#resumeTypedInput(surface);
          throw error;
        }
      },
      () => {
        this.#removeAnchoredSurface(surface);
      },
    );
    const input = surface.querySelector<HTMLInputElement>('.abyss-tag-input');
    if (input !== null) {
      this.#typedInput = {
        surface,
        input,
        target: taskNodeRef(task),
        opener: anchor,
        openingFocusPending: false,
        submitted: false,
      };
    }
    anchor.addClass('abyss-chip-add--hidden');
    this.#dismissMenuOnOutsideClick(
      surface,
      anchor,
      () => {
        this.#removeAnchoredSurface(surface);
      },
      {
        focusLeaveDelay: 200,
        onCleanup: () => {
          anchor.removeClass('abyss-chip-add--hidden');
          this.#releaseTypedInput(surface);
        },
      },
    );
  }

  #showTimePopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.#host.root().querySelector('.abyss-time-popover');
    this.clearPopovers();
    if (already != null) return;

    const pop = this.#host.root().createDiv({
      cls: 'abyss-popover abyss-time-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': 'Set time and duration' },
    });

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-time-input',
      attr: { type: 'time', value: task.planning.time ?? '' },
    });
    this.#host.root().ownerDocument.defaultView?.setTimeout(() => {
      input.focus();
    }, 0);
    // The popover stays open while its write runs, so one keyboard value is written once.
    let written = false;
    const draft = bindSegmentedInputCommit({
      input,
      boundary: inputRow,
      commit: () => {
        if (written || input.validity.badInput) return;
        written = true;
        this.#finishPopoverUpdate(pop, this.#commands.updateTime(task, input.value));
      },
    });

    this.#renderPopoverClear(inputRow, 'Clear time', () => {
      draft.cancel();
      this.#finishPopoverUpdate(pop, this.#commands.updateTime(task, ''));
    });

    const disarmDuration = 'source' in task ? this.#renderDurationInputs(pop, task) : undefined;

    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.#dismissMenuOnOutsideClick(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        draft.cancel();
        disarmDuration?.();
      },
    });
  }

  #renderDurationInputs(popover: HTMLElement, task: TaskSnapshot): () => void {
    const row = popover.createDiv({ cls: 'abyss-popover-input-row' });
    const input = row.createEl('input', {
      cls: 'abyss-duration-input',
      attr: {
        type: 'text',
        placeholder: DURATION_INPUT_EXAMPLE,
        'aria-label': 'Duration',
        value:
          task.planning.duration == null ? '' : formatDurationFromMinutes(task.planning.duration),
      },
    });
    let armed = true;
    input.addEventListener('change', () => {
      // Chromium fires change for an edited field it removes; a closed popover writes nothing.
      if (!armed) return;
      const minutes = parseDurationToMinutes(input.value);
      const update =
        minutes === undefined || minutes === 0
          ? this.#commands.clearDuration(task)
          : this.#commands.updateDuration(task, minutes);
      this.#finishPopoverUpdate(popover, update);
    });
    this.#renderPopoverClear(row, 'Clear duration', () => {
      this.#finishPopoverUpdate(popover, this.#commands.clearDuration(task));
    });
    return () => {
      armed = false;
    };
  }

  #finishPopoverUpdate(popover: HTMLElement, update: Promise<void>): void {
    runAsyncAction(
      update.then(() => {
        this.#removeAnchoredSurface(popover);
      }),
    );
  }

  #renderPopoverClear(row: HTMLElement, label: string, action: () => void): void {
    const button = row.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { 'aria-label': label },
    });
    setIcon(button, 'x');
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', action);
  }

  renderContextMenu(task: TaskLike, anchor: HTMLElement): void {
    const existing = this.#host.root().querySelector<HTMLElement>('.abyss-task-context-menu');
    if (existing != null) {
      this.#removeAnchoredSurface(existing);
      return;
    }
    // Close any other open context menus
    this.#host
      .root()
      .querySelectorAll<HTMLElement>('.abyss-context-menu')
      .forEach((element) => {
        this.#removeAnchoredSurface(element);
      });

    const menu = this.#host.root().createDiv({
      cls: 'abyss-context-menu abyss-task-context-menu abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Task actions' },
    });

    const editRepeat = this.#createContextMenuItem(
      menu,
      'abyss-context-item',
      'Edit repeat…',
      () => {
        this.#removeAnchoredSurface(menu);
        this.#showRecurrencePopover(anchor, task, this.#recurrenceStackFor(task));
      },
    );

    this.#addTrackingMenuItem(menu, task);
    const contextTarget = taskNodeRef(task);
    const contextOwner = this.#host.taskOwner(task);
    this.#createContextMenuSeparator(menu);
    this.#createContextMenuItem(menu, 'abyss-context-item', 'Open in note', () => {
      this.#removeAnchoredSurface(menu);
      const root = this.#host.stack()[0];
      if (root != null && 'source' in root)
        runAsyncAction(openInFile(this.#app, root, taskNodeLine(root, task)));
    });
    if (this.#host.showInTaskList !== undefined)
      this.#createContextMenuItem(menu, 'abyss-context-item', 'Show in task list', () => {
        this.#removeAnchoredSurface(menu);
        if (
          contextOwner.current !== undefined &&
          sameTaskNodeRef(taskNodeRef(contextOwner.current), contextTarget)
        )
          this.#host.showInTaskList?.(contextOwner.current);
      });
    this.#createContextMenuSeparator(menu);
    if (contextTarget.type === 'task') {
      this.#createContextMenuItem(menu, 'abyss-context-item', 'Archive', () => {
        this.#removeAnchoredSurface(menu);
        runAsyncAction(this.#commands.archiveRootTask(contextTarget.ref));
      });
    }
    if (contextTarget.type === 'subtask') {
      this.#createContextMenuItem(menu, 'abyss-context-item', 'Make independent task', () => {
        this.#removeAnchoredSurface(menu);
        runAsyncAction(this.#commands.promoteSubtask(task));
      });
    }
    this.#createContextMenuItem(
      menu,
      'abyss-context-item abyss-context-danger',
      taskNodeRef(task).type === 'subtask' ? 'Delete sub-task' : 'Delete task',
      () => {
        this.#removeAnchoredSurface(menu);
        runAsyncAction(this.#commands.deleteTask(task));
      },
    );

    this.positionAnchoredSurface(menu, anchor, 'below-end');
    this.#dismissMenuOnOutsideClick(menu, anchor);
    editRepeat.focus({ preventScroll: true });
  }

  /**
   * Start or pause the timer on the node the menu belongs to, which is the task or the sub-task
   * the inspector is showing. A finished node is refused unless something under it is still
   * running, which is the one case that still needs a way to stop.
   *
   * There is no forecast guard here, unlike the card menus: the inspector selection is a node the
   * index holds, never a projected calendar occurrence, so every node reaching this menu has a
   * line to write to.
   */
  #addTrackingMenuItem(menu: HTMLElement, task: TaskLike): void {
    const tracking = this.#timeTracking;
    if (tracking === undefined) return;
    const running = subtreeRunning(task);
    if (!running && (task.status === 'done' || task.status === 'cancelled')) return;
    this.#createContextMenuItem(
      menu,
      'abyss-context-item',
      running ? 'Pause tracking' : 'Start tracking',
      () => {
        this.#removeAnchoredSurface(menu);
        const target = this.#host.trackingNode()?.ref ?? taskNodeRef(task);
        runAsyncAction(
          running ? tracking.actions.pause() : tracking.actions.start(target),
          'Could not change time tracking',
        );
      },
    );
  }

  #recurrenceStackFor(task: TaskLike): readonly TaskLike[] {
    const root = this.#host.stack()[0];
    const target = taskNodeRef(task);
    if (root == null || !('source' in root)) return [];
    return this.#host.rebuildPlanningTargetStack(root, target);
  }

  /**
   * Registers an anchored surface's dismissal (outside click, Escape, focus departure) and records
   * its opener, so a close or a rebuild can return focus to it.
   */
  #dismissMenuOnOutsideClick(
    menu: HTMLElement,
    anchor: HTMLElement,
    dismissSurface: () => void = () => {
      this.#removeAnchoredSurface(menu);
    },
    options: { focusLeaveDelay?: number; onCleanup?: () => void } = {},
  ): void {
    const ownerDocument = this.#host.root().ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placementCleanup = this.#anchoredSurfaceCleanups.get(menu);
    const ownershipToken = this.#interactionOwnership.acquire({
      blocksShortcuts: true,
    });
    let listening = false;
    let cleaned = false;
    let focusLeaveTimer: number | undefined;
    anchor.setAttribute('aria-expanded', 'true');
    const dismiss = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) {
        dismissSurface();
      }
    };
    const dismissOnEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || isImeOwnedEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dismissSurface();
      anchor.focus({ preventScroll: true });
    };
    const dismissAfterFocusLeaves = (): void => {
      if (options.focusLeaveDelay === undefined) return;
      if (focusLeaveTimer !== undefined) ownerWindow?.clearTimeout(focusLeaveTimer);
      focusLeaveTimer = ownerWindow?.setTimeout(() => {
        focusLeaveTimer = undefined;
        const activeElement = ownerDocument.activeElement;
        if (!menu.contains(activeElement) && activeElement !== anchor) dismissSurface();
      }, options.focusLeaveDelay);
    };
    ownerDocument.addEventListener('keydown', dismissOnEscape, true);
    if (options.focusLeaveDelay !== undefined) {
      menu.addEventListener('focusout', dismissAfterFocusLeaves);
    }
    let registrationTimer = ownerWindow?.setTimeout(() => {
      registrationTimer = undefined;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      placementCleanup?.();
      clearOptionalTimer(ownerWindow, registrationTimer);
      clearOptionalTimer(ownerWindow, focusLeaveTimer);
      if (listening) ownerDocument.removeEventListener('click', dismiss, true);
      ownerDocument.removeEventListener('keydown', dismissOnEscape, true);
      if (options.focusLeaveDelay !== undefined) {
        menu.removeEventListener('focusout', dismissAfterFocusLeaves);
      }
      anchor.setAttribute('aria-expanded', 'false');
      ownershipToken.release();
      options.onCleanup?.();
      if (this.#anchoredSurfaceCleanups.get(menu) === cleanup) {
        this.#anchoredSurfaceCleanups.delete(menu);
        this.#surfaceOpeners.delete(menu);
      }
    };
    this.#anchoredSurfaceCleanups.set(menu, cleanup);
    this.#surfaceOpeners.set(menu, anchor);
  }

  registerStatusMarker(marker: HTMLElement, task: TaskLike): void {
    this.#dependencyStatusMarkers.set(marker, this.#host.taskOwner(task));
  }
  updateTaskOwners(): void {
    for (const [marker, owner] of this.#dependencyStatusMarkers) {
      if (owner.current === undefined || !marker.isConnected)
        this.#dependencyStatusMarkers.delete(marker);
      else updateStatusMarker(marker, { task: owner.current, registry: this.#statusRegistry });
    }
  }

  refreshStatusMarkers(isBlocked: (task: TaskLike) => boolean): void {
    for (const [marker, owner] of this.#dependencyStatusMarkers) {
      const current = owner.current;
      if (current !== undefined) setStatusMarkerCompletionBlocked(marker, isBlocked(current));
    }
  }
  openDependencyStatusMenu(event: MouseEvent, task: TaskLike): void {
    this.closeDependencyStatusMenu();
    this.#dependencyStatusMenu = this.openStatusMenu(event, task);
  }
  clearRecurrenceIntent(): void {
    this.#recurrenceIntent = undefined;
  }
  releasePlacement(surface: HTMLElement): void {
    this.#anchoredSurfaceCleanups.get(surface)?.();
  }
  consumeRecurrenceDraft(): void {
    const editor = this.#recurrenceDraftEditor;
    if (editor !== undefined) this.#removeAnchoredSurface(editor.surface);
  }

  restoreRecurrenceDraft(
    draft: Extract<RightPanelDraftState, { kind: 'recurrence-editor' }>,
    task: TaskLike,
    stack: readonly TaskLike[],
  ): { anchorFound: boolean; focus: HTMLElement | undefined } {
    const intent = this.#recurrenceIntent;
    const anchor = this.#planningControl(intent?.key ?? 'repeat');
    if (anchor === undefined) return { anchorFound: false, focus: undefined };
    this.#showRecurrencePopover(anchor, task, stack, { intent });
    const editor = this.#recurrenceDraftEditor;
    if (editor == null) return { anchorFound: true, focus: undefined };
    editor.handle.restoreDraftState(draft.editor);
    return {
      anchorFound: true,
      focus: draft.hadFocus
        ? (editor.surface.querySelector<HTMLElement>(':focus') ?? undefined)
        : undefined,
    };
  }
}
