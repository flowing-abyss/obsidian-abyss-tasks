import { Component, setIcon, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { projectSearchText } from '../../markdown/searchText';
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
  type PreparedSearchQuery,
  type SearchWordSegmenter,
  type TaskDependencySummary,
  type TaskNodeRef,
  type TaskRef,
  type TaskSearchAddress,
  type TaskSearchContext,
  type TaskSnapshot,
  type TrackedTotal,
} from '../../tasks';
import { renderStatusMarker, updateStatusMarker } from '../../ui/StatusMarker';
import { markSearchText } from '../../ui/markSearchText';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText, type RenderTaskTextOptions } from '../../ui/renderTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderSourceNoteChip, shouldShowSourceNote } from '../../ui/sourceNoteChip';
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from '../../ui/taskDependencyPresentation';
import { renderTaskDescriptionText } from '../../ui/taskNodeText';
import { applyTaskPresentationIdentity } from '../../ui/taskPresentationIdentity';
import {
  TaskRenderScope,
  type TaskRenderOutcome,
  type TaskTextRender,
} from '../../ui/taskRenderScope';
import { taskNodeRef, type TaskSelectionNode } from '../../ui/taskSelection';
import type { TrackingTickerState } from '../../ui/timeTracking/TrackingTicker';
import { formatTrackedDuration } from '../../ui/timeTracking/formatTracked';
import { isForecastCalendarTask } from '../../views/calendarOccurrences';
import type { ListViewControls } from './ListViewControls';
import type { TaskCommands } from './TaskCommands';
import {
  isTaskSearchSemanticEvidence,
  renderTaskSearchTree,
  type TaskSearchSemanticEvidence,
} from './TaskSearchTree';

export interface TaskCardHighlight {
  readonly query: PreparedSearchQuery;
  readonly segment: SearchWordSegmenter;
}

export interface TaskCardSearchPresentation extends TaskCardHighlight {
  readonly context: TaskSearchContext;
  readonly onActivate: (address: TaskSearchAddress) => void;
}

export interface TaskCardInteractionContext {
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
  readonly onActivate?: ((task: TaskSnapshot) => void) | undefined;
}
interface TaskCardFlags {
  readonly selected: boolean;
  readonly showDelete: boolean;
  readonly rowKey?: string;
  readonly renderScope?: TaskRenderScope | undefined;
  readonly search?: TaskCardSearchPresentation | undefined;
  readonly highlight?: TaskCardHighlight | undefined;
  readonly onActivate?: ((task: TaskSnapshot) => void) | undefined;
  readonly isCurrent?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly reportFailure?: ((error: unknown) => void) | undefined;
}
export interface TaskCardMount {
  readonly settled: Promise<TaskRenderOutcome>;
  readonly element: HTMLElement;
  update(
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    flags: TaskCardFlags,
    search?: TaskCardSearchPresentation,
  ): void;
  destroy(): void;
}
interface CardState {
  readonly task: TaskSnapshot;
  readonly tagGroups: readonly EffectiveTagGroup[];
  readonly flags: TaskCardFlags;
}
interface CardContents {
  readonly settled: Promise<TaskRenderOutcome>;
  update(current: CardState): void;
  destroy(): void;
}
interface TaskTextMount {
  readonly settled: Promise<TaskRenderOutcome>;
  update(task: TaskSnapshot, flags: TaskCardFlags): void;
  destroy(): void;
}
interface CardContentContext {
  readonly track?: (render: TaskTextRender) => void;
  readonly flags?: TaskCardFlags;
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
  readonly isCurrent: () => boolean;
  readonly onRenderFailure: (error: unknown) => void;
  readonly tagGroups?: (() => readonly EffectiveTagGroup[]) | undefined;
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
  dependenciesForNode(target: TaskNodeRef): TaskDependencySummary | undefined;
  openStatusMenu(event: MouseEvent, task: TaskSelectionNode): void;
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

function canReuseTaskText(
  outcome: TaskRenderOutcome | undefined,
  flags: TaskCardFlags | undefined,
): boolean {
  // Ready text owns its wired DOM; pending text still needs its originating request.
  return outcome === undefined ? flags?.isCurrent?.() !== false : outcome.type === 'ready';
}

function sameTaskText(
  task: TaskSnapshot,
  flags: TaskCardFlags,
  rendered: TaskSnapshot | undefined,
  renderedFlags: TaskCardFlags | undefined,
): boolean {
  return (
    rendered === task &&
    renderedFlags?.search === flags.search &&
    renderedFlags?.highlight === flags.highlight
  );
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
    ...[flags, search]: [TaskCardFlags, TaskCardSearchPresentation?]
  ): TaskCardMount {
    return this.mountInto(container.createDiv(), task, tagGroups, flags, search);
  }

  mountInto(
    card: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    ...[flags, search]: [TaskCardFlags, TaskCardSearchPresentation?]
  ): TaskCardMount {
    const markdown = new Component();
    markdown.load();
    let current = { task, tagGroups, flags: search === undefined ? flags : { ...flags, search } };
    let live = true;
    let failed = false;
    card.addClass('abyss-task-card');
    card.tabIndex = -1;
    const context: CardContentContext = {
      component: markdown,
      currentTask: () => current.task,
      tagGroups: () => current.tagGroups,
      isCurrent: () => live,
      onRenderFailure: (error) => {
        if (!live || failed) return;
        failed = true;
        if (current.flags.isCurrent?.() === false) return;
        if (current.flags.reportFailure !== undefined) current.flags.reportFailure(error);
        else this.#reportFailure(error);
      },
      badges: [],
    };
    let content: CardContents | undefined;
    const destroy = (): void => {
      if (!live) return;
      live = false;
      content?.destroy();
      markdown.unload();
      card.remove();
    };
    try {
      content = this.#mountContents(card, context);
      content.update(current);
      this.#host.mountInteractions(card, task, flags.rowKey, {
        component: markdown,
        currentTask: context.currentTask,
        ...(flags.onActivate === undefined
          ? {}
          : {
              onActivate: (task: TaskSnapshot) => {
                current.flags.onActivate?.(task);
              },
            }),
      });
    } catch (error) {
      destroy();
      throw error;
    }
    return {
      element: card,
      get settled() {
        return content.settled;
      },
      update: (nextTask, nextGroups, nextFlags, search) => {
        if (!live) return;
        if (!this.#sameOccurrence(current, { task: nextTask, flags: nextFlags }))
          throw new Error('Cannot rebind a task card to a different source occurrence');
        current = {
          task: nextTask,
          tagGroups: nextGroups,
          flags: search === undefined ? nextFlags : { ...nextFlags, search },
        };
        failed = false;
        try {
          content.update(current);
        } catch (error) {
          destroy();
          throw error;
        }
      },
      destroy,
    };
  }

  #mountContents(card: HTMLElement, context: CardContentContext): CardContents {
    const mainRow = card.createDiv({ cls: 'abyss-task-card-main-row' });
    this.#renderStatus(mainRow, context.currentTask(), context.currentTask);
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const title = titleRow.createSpan({ cls: 'abyss-task-title' });
    const description = body.createDiv({ cls: 'abyss-task-desc' });
    const titleMount = this.#mountTextRegion(title, context, (task, owner) => {
      this.#renderTitle(title, task, owner);
    });
    const descriptionMount = this.#mountTextRegion(description, context, (task, owner) => {
      const search = owner.flags?.search;
      description.className = search === undefined ? 'abyss-task-desc' : 'abyss-search-contexts';
      description.hidden =
        search === undefined && (task.description === undefined || task.description === '');
      if (search === undefined) this.#renderDescriptionText(description, task, owner);
      else {
        description.empty();
        this.#renderSearchContext(description, task, search, {
          owner,
          scope: owner.flags?.renderScope,
          tagGroups: owner.tagGroups?.() ?? [],
        });
      }
    });
    let settled: Promise<TaskRenderOutcome> = Promise.resolve({ type: 'ready' });
    let titleReceipt: Promise<TaskRenderOutcome> | undefined;
    let descriptionReceipt: Promise<TaskRenderOutcome> | undefined;
    return {
      get settled() {
        if (
          titleReceipt !== titleMount.settled ||
          descriptionReceipt !== descriptionMount.settled
        ) {
          titleReceipt = titleMount.settled;
          descriptionReceipt = descriptionMount.settled;
          settled = Promise.all([titleReceipt, descriptionReceipt]).then(
            (outcomes) =>
              outcomes.find((outcome) => outcome.type === 'failed') ??
              outcomes.find((outcome) => outcome.type === 'cancelled') ?? { type: 'ready' },
          );
        }
        return settled;
      },
      update: (current) => {
        this.#identity(card, current);
        this.#refreshBadges(titleRow, title, current.task, { ...context, flags: current.flags });
        titleMount.update(current.task, current.flags);
        descriptionMount.update(current.task, current.flags);
        this.syncDeleteButton(
          card,
          current.flags.showDelete ? current.task : undefined,
          context.currentTask,
        );
      },
      destroy: () => {
        titleMount.destroy();
        descriptionMount.destroy();
        this.#releaseBadges(context.badges);
      },
    };
  }

  #mountTextRegion(
    element: HTMLElement,
    context: CardContentContext,
    render: (task: TaskSnapshot, owner: CardContentContext) => void,
  ): TaskTextMount {
    let live = true;
    let latest: TaskSnapshot | undefined;
    let flags: TaskCardFlags = { selected: false, showDelete: false };
    let rendered: TaskSnapshot | undefined;
    let renderedFlags: TaskCardFlags | undefined;
    let owner: Component | undefined;
    let generation = 0;
    let receipt: Promise<TaskRenderOutcome> = Promise.resolve({ type: 'ready' });
    let controller: AbortController | undefined;
    let outcome: TaskRenderOutcome | undefined;
    const release = (): void => {
      generation++;
      controller?.abort();
      if (owner !== undefined) context.component.removeChild(owner);
    };
    const refresh = (): void => {
      if (!live || latest === undefined) return;
      const reusable = canReuseTaskText(outcome, renderedFlags);
      if (reusable && sameTaskText(latest, flags, rendered, renderedFlags)) return;
      if (reusable && element.contains(element.ownerDocument.activeElement)) return;
      release();
      owner = context.component.addChild(new Component());
      const version = generation;
      rendered = latest;
      renderedFlags = flags;
      controller = new AbortController();
      const scope = new TaskRenderScope(controller.signal);
      render(latest, {
        ...context,
        component: owner,
        flags: {
          ...flags,
          signal: controller.signal,
        },
        track: (render) => {
          scope.track(render);
          flags.renderScope?.track(render);
        },
        isCurrent: () => live && generation === version && flags.isCurrent?.() !== false,
      });
      outcome = undefined;
      receipt = scope.finish().then((settled) => {
        if (live && generation === version) outcome = settled;
        return settled;
      });
    };
    context.component.registerDomEvent(element, 'focusout', (event) => {
      const win = element.ownerDocument.defaultView;
      if (
        win !== null &&
        event.relatedTarget instanceof win.Node &&
        element.contains(event.relatedTarget)
      )
        return;
      try {
        refresh();
      } catch (error) {
        context.onRenderFailure(error);
      }
    });
    return {
      get settled() {
        return receipt;
      },
      update: (task, nextFlags) => {
        latest = task;
        flags = nextFlags;
        refresh();
      },
      destroy: () => {
        live = false;
        release();
      },
    };
  }

  #refreshBadges(
    titleRow: HTMLElement,
    title: HTMLElement,
    task: TaskSnapshot,
    context: CardContentContext,
  ): void {
    this.#releaseBadges(context.badges);
    context.badges.length = 0;
    for (const child of Array.from(titleRow.children)) if (child !== title) child.remove();
    if (
      context.flags?.search === undefined &&
      task.recurrence !== undefined &&
      task.recurrence !== ''
    )
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(task.recurrence));
    this.#renderCountBadges(titleRow, task, context);
    // Only new decoration nodes move; the focused Markdown subtree stays connected.
    for (const child of Array.from(titleRow.children)) if (child !== title) title.before(child);
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
    mainRow.querySelector(':scope > .abyss-task-meta-right')?.remove();
    this.#renderCardMetadata(mainRow, current.task, current.tagGroups, {
      search: current.flags.search,
      highlight: current.flags.highlight,
      currentRoot: () => current.task,
    });
    const metadata = mainRow.querySelector(':scope > .abyss-task-meta-right');
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
    flags: {
      readonly selected: boolean;
      readonly showDelete: boolean;
      readonly rowKey?: string;
      readonly renderScope?: TaskRenderScope;
      readonly search?: TaskCardSearchPresentation | undefined;
      readonly highlight?: TaskCardHighlight | undefined;
      readonly onActivate?: (() => void) | undefined;
    },
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
    this.#renderBody(mainRow, task, tagGroups, flags);
    this.#renderCardMetadata(mainRow, task, tagGroups, {
      search: flags.search,
      highlight: flags.highlight,
    });
    this.#host.mountInteractions(card, task, flags.rowKey, {
      component: this.#host.component(),
      currentTask: () => task,
      ...(flags.onActivate === undefined ? {} : { onActivate: flags.onActivate }),
    });
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

  #renderBody(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    flags?: TaskCardFlags,
  ): void {
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const recurrence = task.recurrence;
    if (flags?.search === undefined && recurrence !== undefined && recurrence !== '') {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(recurrence));
    }
    this.#renderCountBadges(titleRow, task);
    const titleEl = titleRow.createSpan({ cls: 'abyss-task-title' });
    this.#renderTitle(titleEl, task, undefined, flags);
    if (flags?.search === undefined) this.#renderDescription(body, task);
    else
      this.#renderSearchContext(body, task, flags.search, {
        scope: flags.renderScope,
        tagGroups,
      });
  }

  #textLifetime(
    context?: CardContentContext,
    flags = context?.flags,
  ): Pick<
    RenderTaskTextOptions,
    'component' | 'signal' | 'isCurrent' | 'onRenderFailure' | 'linkEventOwner'
  > {
    return {
      component: context?.component ?? this.#host.component(),
      ...(flags?.signal === undefined ? {} : { signal: flags.signal }),
      ...(context === undefined
        ? {}
        : {
            isCurrent: context.isCurrent,
            onRenderFailure: context.onRenderFailure,
            linkEventOwner: context.component,
          }),
    };
  }

  #highlightOptions(
    text: string,
    mode: 'title' | 'prose',
    highlight: TaskCardHighlight | undefined,
  ): Pick<RenderTaskTextOptions, 'onRendered'> {
    if (highlight === undefined) return {};
    return {
      onRendered: (element) => {
        markSearchText(element, projectSearchText(text, mode), highlight.query, highlight.segment);
      },
    };
  }

  #renderTitle(
    titleEl: HTMLElement,
    task: TaskSnapshot,
    context?: CardContentContext,
    flags = context?.flags,
  ): void {
    const search = flags?.search ?? flags?.highlight;
    const titleRender = renderTaskText(titleEl, task.markdownTitle, {
      presentation: 'title',
      ...this.#highlightOptions(task.markdownTitle, 'title', search),
      app: this.#app,
      sourcePath: task.source.filePath,
      ...this.#textLifetime(context, flags),
      onEditLink: (occurrence, token) => {
        this.#commands.editTaskLink(task, occurrence, token);
      },
    });
    if (context?.track !== undefined) context.track(titleRender);
    else flags?.renderScope?.track(titleRender);
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
    this.#renderDescriptionText(descriptionElement, task, context);
  }

  #renderDescriptionText(
    descriptionElement: HTMLElement,
    task: TaskSnapshot,
    context?: CardContentContext,
  ): void {
    const description = (task.description ?? '').split('\n')[0] ?? '';
    const highlight = context?.flags?.highlight;
    const descriptionRender = renderTaskDescriptionText(descriptionElement, description, {
      app: this.#app,
      sourcePath: task.source.filePath,
      ...this.#textLifetime(context),
      ...this.#highlightOptions(description, 'prose', highlight),
    });
    if (context?.track !== undefined) context.track(descriptionRender);
    else context?.flags?.renderScope?.track(descriptionRender);
  }

  #renderSearchContext(
    host: HTMLElement,
    root: TaskSnapshot,
    search: TaskCardSearchPresentation,
    options: {
      readonly owner?: CardContentContext | undefined;
      readonly scope?: TaskRenderScope | undefined;
      readonly tagGroups: readonly EffectiveTagGroup[];
    },
  ): void {
    renderTaskSearchTree(host, {
      app: this.#app,
      root,
      search,
      textOptions: this.#textLifetime(options.owner),
      track: (render) => {
        if (options.owner?.track !== undefined) options.owner.track(render);
        else options.scope?.track(render);
      },
      editLink: (target, occurrence, token) => {
        this.#commands.editTaskLink(root, occurrence, token, target);
      },
      renderChildStatus: (host, child) => {
        renderStatusMarker(host, {
          task: child,
          registry: this.#statusRegistry,
          completionBlocked: dependencyCompletionBlocked(
            this.#host.dependenciesForNode(taskNodeRef(child)),
          ),
          onLeftClick: () => {
            runAsyncAction(this.#commands.toggleTask(child));
          },
          onContextMenu: (event) => {
            event.stopPropagation();
            this.#host.openStatusMenu(event, child);
          },
        });
      },
      renderSemantics: (host, node, evidence) => {
        this.#renderSearchSemantics(host, node, evidence, { tagGroups: options.tagGroups, search });
      },
    });
  }

  #renderCardMetadata(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    options: {
      readonly search?: TaskCardSearchPresentation | undefined;
      readonly highlight?: TaskCardHighlight | undefined;
      readonly currentRoot?: () => TaskSnapshot;
    },
  ): void {
    const { search, currentRoot } = options;
    if (search === undefined) this.#renderMetadata(mainRow, task, tagGroups, options);
    else
      this.#renderSearchSemantics(
        mainRow.createDiv({ cls: 'abyss-task-meta-right' }),
        task,
        search.context.tree.evidence.filter(isTaskSearchSemanticEvidence),
        { tagGroups, search, ...(currentRoot === undefined ? {} : { currentRoot }) },
      );
  }

  #renderSearchSemantics(
    host: HTMLElement,
    node: TaskSelectionNode,
    evidence: readonly TaskSearchSemanticEvidence[],
    options: {
      readonly tagGroups: readonly EffectiveTagGroup[];
      readonly search: TaskCardSearchPresentation;
      readonly currentRoot?: () => TaskSnapshot;
    },
  ): void {
    const groups = new Map<string, TaskSearchSemanticEvidence[]>();
    for (const record of evidence) {
      const id = `${record.field}:${record.text}`;
      const group = groups.get(id);
      if (group === undefined) groups.set(id, [record]);
      else if (!group.some((e) => e.provenance.key === record.provenance.key)) group.push(record);
    }
    for (const records of groups.values())
      this.#renderSearchSemanticGroup(host, node, records, options);
  }

  #markSemanticValue(element: HTMLElement, value: string, search?: TaskCardHighlight): void {
    if (search === undefined) return;
    markSearchText(
      element,
      { visible: { text: value, map: [] }, destinations: [] },
      search.query,
      search.segment,
    );
  }

  #renderSearchSemanticGroup(
    host: HTMLElement,
    node: TaskSelectionNode,
    records: readonly TaskSearchSemanticEvidence[],
    options: {
      readonly tagGroups: readonly EffectiveTagGroup[];
      readonly search: TaskCardSearchPresentation;
      readonly currentRoot?: () => TaskSnapshot;
    },
  ): void {
    const record = records[0];
    if (record === undefined) return;
    if (record.field === 'tag') {
      const element = this.#renderTagMetadata(
        host,
        record.text,
        options.tagGroups,
        'source' in node ? { task: node, currentTask: options.currentRoot } : undefined,
      );
      this.#markSemanticValue(element, record.text, options.search);
      return;
    }
    const keys = records.map((e) => e.provenance.key);
    const meaning = keys
      .map(
        (key) =>
          `${key === 'duration' && /^\d+$/u.test(record.text) ? 'Duration minutes' : key}: ${record.text}`,
      )
      .join('; ');
    const wrapper = host.createSpan({ attr: { role: 'group', 'aria-label': meaning } });
    this.#renderSearchMetadataValue(wrapper, node, {
      keys,
      text: record.text,
      search: options.search,
    });
  }

  #searchEvidenceDate(node: TaskSelectionNode, keys: readonly string[]): LocalDate | undefined {
    if (keys.includes('due')) return node.planning.due;
    if (keys.includes('scheduled')) return node.planning.scheduled;
    return undefined;
  }

  #renderSearchMetadataValue(
    wrapper: HTMLElement,
    node: TaskSelectionNode,
    value: {
      readonly keys: readonly string[];
      readonly text: string;
      readonly search: TaskCardSearchPresentation;
    },
  ): void {
    const date = this.#searchEvidenceDate(node, value.keys);
    if (date !== undefined) {
      wrapper.addClass('abyss-task-date');
      const dateClass = this.#host.getDateClass(date);
      if (dateClass !== '') wrapper.addClass(dateClass);
      this.#renderDateFilterPart(wrapper, date);
      this.#markFormattedSemanticValue(wrapper, '.abyss-task-date-part > span:last-child', value);
    } else if (value.keys.includes('time') && node.planning.time !== undefined) {
      this.#renderTimeFilterPart(wrapper, node.planning.time, 'abyss-task-date');
      this.#markFormattedSemanticValue(wrapper, '.abyss-task-date > span:last-child', value);
    } else {
      if (value.keys.includes('recurrence') && node.recurrence !== undefined)
        renderRecurrenceBadge(wrapper, recurrenceBadgeInput(node.recurrence));
      this.#markSemanticValue(wrapper.createSpan({ text: value.text }), value.text, value.search);
    }
  }

  #markFormattedSemanticValue(
    wrapper: HTMLElement,
    selector: string,
    value: { readonly text: string; readonly search: TaskCardSearchPresentation },
  ): void {
    const element = wrapper.querySelector<HTMLElement>(selector);
    if (element !== null && element.textContent === value.text)
      this.#markSemanticValue(element, value.text, value.search);
  }

  #renderMetadata(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    options: {
      readonly currentRoot?: () => TaskSnapshot;
      readonly highlight?: TaskCardHighlight | undefined;
    },
  ): void {
    const currentTask = options.currentRoot;
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
    for (const tag of tags.slice(0, 2)) {
      const element = this.#renderTagMetadata(metaRight, tag, tagGroups, { task, currentTask });
      this.#markSemanticValue(element, tag, options.highlight);
    }
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
    tag: string,
    tagGroups: readonly EffectiveTagGroup[],
    dropContext?: {
      readonly task: TaskSnapshot;
      readonly currentTask?: (() => TaskSnapshot) | undefined;
    },
  ): HTMLElement {
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
      if (dropContext === undefined) {
        event.stopPropagation();
        return;
      }
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
      if (dropContext === undefined) {
        event.stopPropagation();
        return;
      }
      this.#handleTagDrop(event, element, dropContext.currentTask?.() ?? dropContext.task, tag);
    });
    return element;
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
