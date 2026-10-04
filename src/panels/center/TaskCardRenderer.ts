import { Component, setIcon, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import type { CalendarSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import {
  localDate,
  subtreeTotal,
  taskNodeAddress,
  totalMs,
  type LocalDate,
  type TaskRef,
  type TaskSnapshot,
  type TrackedTotal,
} from '../../tasks';
import { renderStatusMarker, updateStatusMarker } from '../../ui/StatusMarker';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../../ui/renderTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderSourceNoteChip, shouldShowSourceNote } from '../../ui/sourceNoteChip';
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from '../../ui/taskDependencyPresentation';
import { applyTaskPresentationIdentity } from '../../ui/taskPresentationIdentity';
import type { TrackingTickerState } from '../../ui/timeTracking/TrackingTicker';
import { formatTrackedDuration } from '../../ui/timeTracking/formatTracked';
import { isForecastCalendarTask } from '../../views/calendarOccurrences';
import type { ListViewControls } from './ListViewControls';
import type { TaskCommands } from './TaskCommands';

export interface TaskCardInteractionContext {
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
}
interface TaskCardFlags {
  readonly selected: boolean;
  readonly showDelete: boolean;
  readonly rowKey?: string;
}
export interface TaskCardMount {
  readonly element: HTMLElement;
  update(task: TaskSnapshot, tagGroups: readonly EffectiveTagGroup[], flags: TaskCardFlags): void;
  destroy(): void;
}
interface CardState {
  readonly task: TaskSnapshot;
  readonly tagGroups: readonly EffectiveTagGroup[];
  readonly flags: TaskCardFlags;
}
interface CardContentContext {
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
  readonly isCurrent: () => boolean;
  readonly onRenderFailure: (error: unknown) => void;
  readonly badges: Array<readonly [string, HTMLElement]>;
}
interface TaskCardRendererHost {
  component(): Component;
  dependenciesFor: TaskDependencyLookup;
  mountInteractions(
    card: HTMLElement,
    task: TaskSnapshot,
    rowKey?: string,
    context?: TaskCardInteractionContext,
  ): void;
  reportFailure?(error: unknown): void;
  openStatusMenu(event: MouseEvent, task: TaskSnapshot): void;
  formatDate(date: LocalDate): string;
  getDateClass(date: LocalDate): string;
  getTagColor(tag: string, groups: readonly EffectiveTagGroup[]): string | undefined;
}

interface TaskCardRendererOptions {
  readonly app: App;
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly statusRegistry: StatusRegistry;
  readonly commands: Pick<
    TaskCommands,
    'toggleTask' | 'deleteTask' | 'patchTaskTags' | 'editTaskLink'
  >;
  readonly listControls: Pick<ListViewControls, 'addPropertyFilter'>;
  readonly trackingEnabled: boolean;
  readonly host: TaskCardRendererHost;
}

/** All rendered badges for one physical root, repainted without querying the index. */
interface RunningCardBadge {
  readonly total: TrackedTotal;
  readonly values: HTMLElement[];
}

/** How a card badge names the root a running entry belongs to, for the tick that repaints it. */
function trackingRootAddress(ref: TaskRef): string {
  return taskNodeAddress({ type: 'task', ref });
}

export class TaskCardRenderer {
  readonly #app: App;
  readonly #state: AppState;
  readonly #settings: CalendarSettings;
  readonly #statusRegistry: StatusRegistry;
  readonly #commands: TaskCardRendererOptions['commands'];
  readonly #listControls: TaskCardRendererOptions['listControls'];
  readonly #trackingEnabled: boolean;
  readonly #host: TaskCardRendererHost;
  readonly #runningBadges = new Map<string, RunningCardBadge>();
  readonly #ownedBadges = new Map<string, RunningCardBadge>();
  #renderNowMs = 0;

  constructor(options: TaskCardRendererOptions) {
    this.#app = options.app;
    this.#state = options.state;
    this.#settings = options.settings;
    this.#statusRegistry = options.statusRegistry;
    this.#commands = options.commands;
    this.#listControls = options.listControls;
    this.#trackingEnabled = options.trackingEnabled;
    this.#host = options.host;
  }

  beginRender(nowMs: number): void {
    this.clear();
    this.#renderNowMs = nowMs;
  }

  clear(): void {
    this.#runningBadges.clear();
  }

  mount(
    container: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    flags: TaskCardFlags,
  ): TaskCardMount {
    const markdown = new Component();
    markdown.load();
    let current = { task, tagGroups, flags };
    let live = true;
    let generation = 0,
      pending = false;
    let content: Component | undefined;
    const registrations: Array<readonly [string, HTMLElement]> = [];
    const card = container.createDiv({ cls: 'abyss-task-card', attr: { tabindex: '-1' } });
    const releaseContent = (): void => {
      generation++;
      if (content !== undefined) markdown.removeChild(content);
      this.#releaseBadges(registrations);
      registrations.length = 0;
    };
    const rebuild = (): void => {
      releaseContent();
      pending = false;
      content = markdown.addChild(new Component());
      const version = generation;
      let failed = false;
      const context: CardContentContext = {
        component: content,
        currentTask: () => current.task,
        isCurrent: () => live && generation === version,
        onRenderFailure: (error) => {
          if (!live || generation !== version || failed) return;
          failed = true;
          this.#reportFailure(error);
        },
        badges: registrations,
      };
      this.#renderOwned(card, current, context);
    };

    const destroy = (): void => {
      if (!live) return;
      live = false;
      releaseContent();
      markdown.unload();
      card.remove();
    };
    try {
      this.#identity(card, current);
      rebuild();
      this.#host.mountInteractions(card, task, flags.rowKey, {
        component: markdown,
        currentTask: () => current.task,
      });
      this.#bindRefresh(markdown, card, () => live && pending, rebuild);
    } catch (error) {
      destroy();
      throw error;
    }
    return {
      element: card,
      update: (nextTask, nextGroups, nextFlags) => {
        if (!live) return;
        if (!this.#sameOccurrence(current, { task: nextTask, flags: nextFlags }))
          throw new Error('Cannot rebind a task card to a different source occurrence');
        const changed =
          pending ||
          nextTask !== current.task ||
          nextGroups !== current.tagGroups ||
          nextFlags.showDelete !== current.flags.showDelete;
        pending = false;
        current = { task: nextTask, tagGroups: nextGroups, flags: nextFlags };
        this.#identity(card, current);
        if (!changed) return;
        pending = this.#retainFocusedContent(card, current.task, registrations);
        if (!pending) rebuild();
      },
      destroy,
    };
  }

  #statusOwnsFocus(card: HTMLElement): boolean {
    const focused = card.ownerDocument.activeElement;
    return (
      focused !== null &&
      card.contains(focused) &&
      focused.matches('.abyss-status-marker, .abyss-status-control')
    );
  }

  #retainFocusedContent(
    card: HTMLElement,
    task: TaskSnapshot,
    registrations: ReadonlyArray<readonly [string, HTMLElement]>,
  ): boolean {
    const focused = card.ownerDocument.activeElement;
    if (
      focused === card ||
      focused === null ||
      !card.contains(focused) ||
      this.#statusOwnsFocus(card)
    )
      return false;
    const total = subtreeTotal(task);
    for (const [address] of registrations) {
      const badge = this.#ownedBadges.get(address);
      if (badge === undefined) continue;
      const next = { total, values: badge.values };
      this.#ownedBadges.set(address, next);
      this.#paintBadge(next, this.#renderNowMs);
    }
    return true;
  }

  #releaseBadges(registrations: ReadonlyArray<readonly [string, HTMLElement]>): void {
    for (const [address, element] of registrations) {
      const badge = this.#ownedBadges.get(address);
      if (badge === undefined) continue;
      const index = badge.values.indexOf(element);
      if (index >= 0) badge.values.splice(index, 1);
      if (badge.values.length === 0) this.#ownedBadges.delete(address);
    }
  }

  #renderOwned(
    card: HTMLElement,
    current: { task: TaskSnapshot; tagGroups: readonly EffectiveTagGroup[]; flags: TaskCardFlags },
    context: CardContentContext,
  ): void {
    const retained = this.#statusOwnsFocus(card)
      ? card.querySelector<HTMLElement>('.abyss-task-card-main-row')
      : null;
    if (retained === null) card.empty();
    else
      for (const element of retained.querySelectorAll(
        ':scope > .abyss-task-body, :scope > .abyss-task-meta-right, :scope > .abyss-task-delete-btn',
      ))
        element.remove();
    const mainRow = retained ?? card.createDiv({ cls: 'abyss-task-card-main-row' });
    if (retained === null) this.#renderStatus(mainRow, current.task, context.currentTask);
    this.#renderBody(mainRow, current.task, context);
    this.#renderMetadata(mainRow, current.task, current.tagGroups, context.currentTask);
    this.syncDeleteButton(
      card,
      current.flags.showDelete ? current.task : undefined,
      context.currentTask,
    );
  }

  #bindRefresh(
    component: Component,
    card: HTMLElement,
    pending: () => boolean,
    rebuild: () => void,
  ): void {
    component.registerDomEvent(card, 'focusout', (event) => {
      const next = event.relatedTarget;
      const owner = card.ownerDocument.defaultView;
      if (!pending() || (owner !== null && next instanceof owner.Node && card.contains(next)))
        return;
      try {
        rebuild();
      } catch (error) {
        this.#reportFailure(error);
      }
    });
  }

  #sameOccurrence(
    left: { task: TaskSnapshot; flags: TaskCardFlags },
    right: { task: TaskSnapshot; flags: TaskCardFlags },
  ): boolean {
    return (
      left.task.source.filePath === right.task.source.filePath &&
      left.task.source.line === right.task.source.line &&
      left.flags.rowKey === right.flags.rowKey
    );
  }

  #identity(card: HTMLElement, current: CardState): void {
    const { task, flags } = current;
    applyTaskPresentationIdentity(card, task.ref);
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);
    if (flags.rowKey !== undefined) card.dataset['rowKey'] = flags.rowKey;
    card.toggleClass('is-selected', flags.selected);
    this.#refreshStatus(card, task);
    this.#refreshMetadata(card, current);
  }

  #refreshMetadata(card: HTMLElement, current: CardState): void {
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (mainRow === null) return;
    mainRow.querySelector('.abyss-task-meta-right')?.remove();
    this.#renderMetadata(mainRow, current.task, current.tagGroups, () => current.task);
    const metadata = mainRow.querySelector('.abyss-task-meta-right');
    if (metadata !== null) mainRow.querySelector('.abyss-task-delete-btn')?.before(metadata);
  }

  #refreshStatus(card: HTMLElement, task: TaskSnapshot): void {
    const marker = card.querySelector<HTMLElement>('.abyss-status-marker');
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (marker === null || mainRow === null) return;
    const projection = this.#host.dependenciesFor(task);
    updateStatusMarker(marker, {
      task,
      registry: this.#statusRegistry,
      completionBlocked: dependencyCompletionBlocked(projection),
    });
    mainRow.querySelector('.abyss-dep-indicator')?.remove();
    const indicator = renderDependencyIndicator(mainRow, projection);
    mainRow.toggleClass('abyss-task-card-main-row--has-dep', indicator !== undefined);
    if (indicator !== undefined)
      (marker.closest('.abyss-status-control') ?? marker).after(indicator);
  }

  #reportFailure(error: unknown): void {
    if (this.#host.reportFailure !== undefined) {
      this.#host.reportFailure(error);
      return;
    }
    runAsyncAction(
      Promise.reject(error instanceof Error ? error : new Error(String(error))),
      'Could not render task card',
    );
  }

  render(
    container: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    flags: { readonly selected: boolean; readonly showDelete: boolean; readonly rowKey?: string },
  ): HTMLElement {
    const isSelected = flags.selected;
    const card = container.createDiv({
      cls: `abyss-task-card${isSelected ? ' is-selected' : ''}`,
      attr: { tabindex: '-1' },
    });
    applyTaskPresentationIdentity(card, task.ref);
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(task.source.line);
    if (flags.rowKey !== undefined) card.dataset['rowKey'] = flags.rowKey;

    const mainRow = card.createDiv({ cls: 'abyss-task-card-main-row' });
    this.#renderStatus(mainRow, task);
    this.#renderBody(mainRow, task);
    this.#renderMetadata(mainRow, task, tagGroups);
    this.#host.mountInteractions(card, task, flags.rowKey);
    this.syncDeleteButton(card, flags.showDelete ? task : undefined);
    return card;
  }

  #renderStatus(mainRow: HTMLElement, task: TaskSnapshot, currentTask = () => task): void {
    const projection = this.#host.dependenciesFor(task);
    renderStatusMarker(mainRow, {
      task,
      registry: this.#statusRegistry,
      completionBlocked: dependencyCompletionBlocked(projection),
      onLeftClick: () => {
        runAsyncAction(this.#commands.toggleTask(currentTask()));
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.#host.openStatusMenu(event, currentTask());
      },
    });
    mainRow.toggleClass(
      'abyss-task-card-main-row--has-dep',
      renderDependencyIndicator(mainRow, projection) !== undefined,
    );
  }

  #renderBody(mainRow: HTMLElement, task: TaskSnapshot, context?: CardContentContext): void {
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const recurrence = task.recurrence;
    if (recurrence !== undefined && recurrence !== '') {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(recurrence));
    }
    this.#renderCountBadges(titleRow, task, context);
    const titleEl = titleRow.createSpan({ cls: 'abyss-task-title' });
    renderTaskText(titleEl, task.markdownTitle, {
      presentation: 'title',
      app: this.#app,
      sourcePath: task.source.filePath,
      component: context?.component ?? this.#host.component(),
      ...(context === undefined
        ? {}
        : { isCurrent: context.isCurrent, onRenderFailure: context.onRenderFailure }),
      onEditLink: (occurrence, token) => {
        this.#commands.editTaskLink(task, occurrence, token);
      },
    });
    this.#renderDescription(body, task, context);
  }

  #renderCountBadges(
    titleRow: HTMLElement,
    task: TaskSnapshot,
    context?: CardContentContext,
  ): void {
    const subtaskCount = task.subtasks.length;
    if (subtaskCount > 0) {
      const doneCount = task.subtasks.filter((subtask) => subtask.status === 'done').length;
      this.#renderCountBadge(titleRow, 'check-square', `${doneCount}/${subtaskCount}`);
    }
    if (task.comments.length > 0) {
      this.#renderCountBadge(titleRow, 'message-square', String(task.comments.length));
    }
    if (task.presentation.linkCount > 0) {
      this.#renderCountBadge(titleRow, 'paperclip', String(task.presentation.linkCount));
    }
    this.#renderTrackedBadge(titleRow, task, context);
  }

  #renderCountBadge(
    host: HTMLElement,
    icon: string,
    text: string,
    cls = 'abyss-task-count-badge',
  ): { readonly badge: HTMLElement; readonly value: HTMLElement } {
    const badge = host.createSpan({ cls });
    setIcon(badge, icon);
    return { badge, value: badge.createSpan({ text }) };
  }

  /**
   * Tracked time on a card, as a passive reading of the snapshot the render was handed. A running
   * subtree keeps its total here so the shared tick is one addition per running root and one DOM
   * write per displayed minute, never a walk of the list or a question to the index.
   */
  #renderTrackedBadge(
    titleRow: HTMLElement,
    task: TaskSnapshot,
    context?: CardContentContext,
  ): void {
    if (!this.#trackingEnabled || isForecastCalendarTask(task)) return;
    const total = subtreeTotal(task);
    const running = total.openStartsMs.length > 0;
    const tracked = totalMs(total, this.#renderNowMs);
    if (!running && tracked <= 0) return;
    const { badge, value } = this.#renderCountBadge(
      titleRow,
      'timer',
      formatTrackedDuration(tracked),
      `abyss-task-count-badge abyss-task-time-badge${running ? ' is-tracking' : ''}`,
    );
    if (!running) return;
    const address = trackingRootAddress(task.ref);
    badge.dataset['trackingRoot'] = address;
    this.#registerBadge({ address, total, value }, context);
  }

  #registerBadge(
    badge: { address: string; total: TrackedTotal; value: HTMLElement },
    context: CardContentContext | undefined,
  ): void {
    const { address, total, value } = badge;
    const badges = context === undefined ? this.#runningBadges : this.#ownedBadges;
    const existing = badges.get(address);
    badges.set(address, { total, values: [...(existing?.values ?? []), value] });
    context?.badges.push([address, value]);
  }

  paintTracking({ nowMs, active }: TrackingTickerState): void {
    this.#renderNowMs = nowMs;
    const roots = new Set(active.map((entry) => entry.rootAddress));
    for (const badges of [this.#runningBadges, this.#ownedBadges]) {
      for (const address of roots) {
        const badge = badges.get(address);
        if (badge !== undefined) this.#paintBadge(badge, nowMs);
      }
    }
  }

  #paintBadge(badge: RunningCardBadge, nowMs: number): void {
    const tracked = formatTrackedDuration(totalMs(badge.total, nowMs));
    for (const value of badge.values) {
      if (value.isConnected && value.textContent !== tracked) value.setText(tracked);
    }
  }

  #renderDescription(host: HTMLElement, task: TaskSnapshot, context?: CardContentContext): void {
    const description = task.description;
    if (description === undefined || description === '') return;
    const descriptionElement = host.createDiv({ cls: 'abyss-task-desc' });
    renderTaskText(descriptionElement, description.split('\n')[0] ?? '', {
      app: this.#app,
      sourcePath: task.source.filePath,
      component: context?.component ?? this.#host.component(),
      ...(context === undefined
        ? {}
        : { isCurrent: context.isCurrent, onRenderFailure: context.onRenderFailure }),
    });
  }

  #renderMetadata(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    currentTask?: () => TaskSnapshot,
  ): void {
    const today = localDate(moment().format('YYYY-MM-DD'));
    const sel = this.#state.get('selectedList');
    const d = task.planning.due ?? task.planning.scheduled;
    const tags = task.tags;
    const suppressToday = sel === 'today' && d === today;
    const showSourceNote = shouldShowSourceNote(
      task,
      this.#settings.sourceNoteDisplay,
      this.#settings.taskFilePath,
    );
    const hasRightMeta =
      showSourceNote ||
      (d != null && !suppressToday) ||
      task.planning.time != null ||
      tags.length > 0;
    if (!hasRightMeta) return;
    const metaRight = mainRow.createDiv({ cls: 'abyss-task-meta-right' });
    this.#renderDateMetadata(metaRight, task, d, suppressToday);
    if (showSourceNote) {
      renderSourceNoteChip(metaRight, task, (filePath) => {
        this.#listControls.addPropertyFilter({ type: 'file', filePath });
      });
    }
    for (const tag of tags.slice(0, 2))
      this.#renderTagMetadata(metaRight, { task, currentTask }, tag, tagGroups);
  }

  #renderDateMetadata(
    host: HTMLElement,
    task: TaskSnapshot,
    date: LocalDate | undefined,
    suppressToday: boolean,
  ): void {
    const time = task.planning.time;
    if (date != null && !suppressToday) {
      const dateElement = host.createSpan({
        cls: `abyss-task-date ${this.#host.getDateClass(date)}`.trim(),
      });
      this.#renderDateFilterPart(dateElement, date);
      if (time != null) this.#renderTimeFilterPart(dateElement, time, 'abyss-task-time-part');
      return;
    }
    if (date == null && time != null) this.#renderTimeFilterPart(host, time, 'abyss-task-date');
  }

  #renderDateFilterPart(host: HTMLElement, date: LocalDate): void {
    const part = host.createSpan({ cls: 'abyss-task-date-part abyss-cursor-pointer' });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'calendar');
    part.createSpan({ text: this.#host.formatDate(date) });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'date', value: date });
    });
  }

  #renderTimeFilterPart(host: HTMLElement, time: string, className: string): void {
    const part = host.createSpan({ cls: `${className} abyss-cursor-pointer` });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'clock');
    part.createSpan({ text: time });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'time', value: time });
    });
  }

  #renderTagMetadata(
    host: HTMLElement,
    context: { task: TaskSnapshot; currentTask: (() => TaskSnapshot) | undefined },
    tag: string,
    tagGroups: readonly EffectiveTagGroup[],
  ): void {
    const element = host.createSpan({ cls: 'abyss-task-tag abyss-cursor-pointer', text: tag });
    const color = this.#host.getTagColor(tag, tagGroups);
    if (color !== undefined && color !== '') {
      element.setCssProps({ '--abyss-tag-color': color });
      element.addClass('abyss-task-tag--colored');
    }
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'tag', value: tag });
    });
    element.addEventListener('dragover', (event) => {
      const dragging = this.#state.get('draggingTag');
      if (dragging === null || dragging === '' || dragging === tag) return;
      event.preventDefault();
      event.stopPropagation();
      element.classList.add('abyss-drop-target');
    });
    element.addEventListener('dragleave', () => {
      element.classList.remove('abyss-drop-target');
    });
    element.addEventListener('drop', (event) => {
      this.#handleTagDrop(event, element, context.currentTask?.() ?? context.task, tag);
    });
  }

  #handleTagDrop(
    event: DragEvent,
    element: HTMLElement,
    task: TaskSnapshot,
    replacedTag: string,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('abyss-drop-target');
    const dragging = this.#state.get('draggingTag');
    if (dragging === null || dragging === '' || dragging === replacedTag) return;
    runAsyncAction(this.#commands.patchTaskTags(task, [dragging], [replacedTag]));
  }

  syncDeleteButton(
    card: HTMLElement,
    task: TaskSnapshot | undefined,
    currentTask = () => task,
  ): void {
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (mainRow == null) return;
    const existing = mainRow.querySelector<HTMLButtonElement>('.abyss-task-delete-btn');
    if (task === undefined) {
      existing?.remove();
      mainRow.removeClass('abyss-task-card-main-row--has-delete');
      return;
    }
    mainRow.addClass('abyss-task-card-main-row--has-delete');
    if (existing != null) return;
    const deleteButton = mainRow.createEl('button', {
      cls: 'abyss-task-delete-btn',
      attr: { title: 'Delete task', 'aria-label': 'Delete task' },
    });
    setIcon(deleteButton, 'x');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = currentTask();
      if (target !== undefined) runAsyncAction(this.#commands.deleteTask(target));
    });
  }
}
