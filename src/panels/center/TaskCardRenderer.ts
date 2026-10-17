import { Component, setIcon, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { countLinksIn } from '../../markdown/links';
import { projectSearchText } from '../../markdown/searchText';
import type { CalendarSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import type { TaskOccurrencePresentation } from '../../task-lists/taskOccurrencePresentation';
import { todayTaskCategory } from '../../task-lists/todayTaskCategory';
import {
  rootTaskNodeSnapshot,
  subtreeTotal,
  taskNodeAddress,
  taskNodeSourceLine,
  taskOccupiedDates,
  totalMs,
  type LocalDate,
  type PreparedSearchQuery,
  type SearchWordSegmenter,
  type SubtaskSnapshot,
  type TaskDependencySummary,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskOccurrenceCompletion,
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
import {
  RetainedTaskText,
  type PreparedTaskTextUpdate,
  type RetainedTaskTextInput,
} from '../../ui/retainedTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderSourceNoteChip, shouldShowSourceNote } from '../../ui/sourceNoteChip';
import {
  dependencyCompletionBlocked,
  renderDependencyIndicator,
  type TaskDependencyLookup,
} from '../../ui/taskDependencyPresentation';
import { renderTaskTagContent } from '../../ui/taskMetadataContent';
import { renderTaskDescriptionText } from '../../ui/taskNodeText';
import { renderTaskParentButton } from '../../ui/taskParentButton';
import {
  applyTaskNodePresentationIdentity,
  applyTaskPresentationIdentity,
} from '../../ui/taskPresentationIdentity';
import type { TaskRenderOutcome, TaskRenderScope, TaskTextRender } from '../../ui/taskRenderScope';
import { taskNodeRef, type TaskSelectionNode } from '../../ui/taskSelection';
import type { TrackingTickerState } from '../../ui/timeTracking/TrackingTicker';
import { formatTrackedDuration } from '../../ui/timeTracking/formatTracked';
import { isForecastCalendarTask } from '../../views/calendarOccurrences';
import { bindTaskSelection } from '../../views/timegrid/renderTaskMeta';
import type { ListViewControls } from './ListViewControls';
import type { TaskCommands } from './TaskCommands';
import type { TaskListNavigationRequest } from './TaskListNavigation';
import {
  isTaskSearchSemanticEvidence,
  mountTaskSearchTree,
  renderTaskSearchTree,
  type TaskSearchSemanticEvidence,
  type TaskSearchTreeMount,
  type TaskSearchTreeRenderOptions,
} from './TaskSearchTree';

export interface TaskCardHighlight {
  readonly query: PreparedSearchQuery;
  readonly segment: SearchWordSegmenter;
}

export interface TaskCardSearchPresentation extends TaskCardHighlight {
  readonly mode: 'search' | 'filter';
  readonly context: TaskSearchContext;
  readonly onActivate: (address: TaskSearchAddress) => void;
}

export interface CalendarCardPolicy {
  readonly kind: 'materialized' | 'forecast';
  readonly planning: TaskSnapshot['planning'];
  onActivate(): void;
  onForecastContextMenu(event: MouseEvent, element: HTMLElement): void;
}

export interface TaskCardInteractionContext {
  readonly calendar?: CalendarCardPolicy;
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
  readonly currentProjection?: () => TaskNodeSnapshot;
  readonly onActivate?: ((task: TaskSnapshot) => void) | undefined;
}
interface TaskCardFlags {
  readonly calendar?: CalendarCardPolicy;
  readonly projection?: TaskNodeSnapshot | undefined;
  readonly occurrence?: TaskOccurrencePresentation;
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
  accepts(task: TaskSnapshot, flags: TaskCardFlags): boolean;
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
interface CardContentContext {
  readonly track?: (render: TaskTextRender) => void;
  readonly flags?: TaskCardFlags;
  readonly component: Component;
  readonly currentTask: () => TaskSnapshot;
  readonly currentProjection: () => TaskNodeSnapshot;
  readonly currentOccurrence: () => TaskOccurrencePresentation | undefined;
  readonly currentCalendar: () => CalendarCardPolicy | undefined;
  readonly isCurrent: () => boolean;
  readonly onRenderFailure: (error: unknown) => void;
  readonly tagGroups?: (() => readonly EffectiveTagGroup[]) | undefined;
  readonly badges: Array<readonly [string, HTMLElement]>;
}
interface TaskCardRendererHost {
  currentDate(): LocalDate;
  component(): Component;
  showTaskInList(target: TaskNodeRef, request: TaskListNavigationRequest): Promise<void>;
  dependenciesFor: TaskDependencyLookup;
  mountInteractions(
    card: HTMLElement,
    task: TaskSnapshot,
    rowKey?: string,
    context?: TaskCardInteractionContext,
  ): void;
  reportFailure?(error: unknown): void;
  dependenciesForNode(target: TaskNodeRef): TaskDependencySummary | undefined;
  openChildContextMenu(event: MouseEvent, child: SubtaskSnapshot, row: HTMLElement): void;
  openStatusMenu(
    event: MouseEvent,
    task: TaskSelectionNode,
    completion?: TaskOccurrenceCompletion,
  ): void;
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
  readonly rootAddress: string;
  readonly total: TrackedTotal;
  readonly values: HTMLElement[];
}

/** How a card badge names the root a running entry belongs to, for the tick that repaints it. */
function trackingRootAddress(ref: TaskRef): string {
  return taskNodeAddress({ type: 'task', ref });
}

function cardNode(
  task: TaskSnapshot,
  flags?: Pick<TaskCardFlags, 'projection'>,
): TaskSelectionNode {
  return flags?.projection?.node ?? task;
}
function cardMetadataNode(
  task: TaskSelectionNode,
  options: {
    readonly projection?: TaskNodeSnapshot | undefined;
    readonly calendar?: CalendarCardPolicy | undefined;
  },
): TaskSelectionNode {
  const node = options.projection?.node ?? task;
  return options.calendar?.kind === 'forecast'
    ? { ...node, planning: options.calendar.planning }
    : node;
}
function cardDates(
  planning: TaskSelectionNode['planning'],
  occurrence?: TaskOccurrencePresentation,
): {
  readonly date: LocalDate | undefined;
  readonly interval: TaskOccurrencePresentation['interval'];
} {
  const date = occurrence?.displayDate ?? planning.due ?? planning.scheduled ?? planning.start;
  if (occurrence?.interval !== undefined) return { date, interval: occurrence.interval };
  const occupied = taskOccupiedDates(planning);
  return { date, interval: occupied.kind === 'interval' ? occupied : undefined };
}
function cardDescription(task: TaskSnapshot, flags?: Pick<TaskCardFlags, 'projection'>): string {
  return (cardNode(task, flags).description ?? '').split('\n')[0] ?? '';
}
function cardDescriptionContinues(
  task: TaskSnapshot,
  flags?: Pick<TaskCardFlags, 'projection'>,
): boolean {
  return (cardNode(task, flags).description ?? '')
    .split('\n')
    .slice(1)
    .some((line) => line.trim().length > 0);
}

/** Card readiness covers the committed fields, including a focus-deferred replacement. */
function settleCardFields(
  card: HTMLElement,
  context: CardContentContext,
  updates: readonly PreparedTaskTextUpdate[],
  tree: Promise<TaskRenderOutcome> | undefined,
): TaskTextRender {
  const commitFields = (): boolean => {
    if (!updates.every((update) => update.canCommit())) return false;
    return updates.every((update) => update.commit());
  };
  commitFields();
  let done = false;
  let ready = false;
  let resolve!: (outcome: TaskRenderOutcome) => void;
  const settled = new Promise<TaskRenderOutcome>((r) => {
    resolve = r;
  });
  const finish = (outcome: TaskRenderOutcome): void => {
    if (done) return;
    done = true;
    card.removeEventListener('focusout', blur);
    resolve(outcome);
  };
  const commit = (): void => {
    if (done || !ready || !context.isCurrent()) return;
    if (commitFields()) finish({ type: 'ready' });
  };
  const blur = (): void => {
    card.ownerDocument.defaultView?.queueMicrotask(commit);
  };
  card.addEventListener('focusout', blur);
  const failed = (error: unknown): void => {
    finish({ type: 'failed', error });
    context.onRenderFailure(error);
  };
  void Promise.all([
    ...updates.map((update) => update.ready),
    ...(tree === undefined ? [] : [tree]),
  ]).then((outcomes) => {
    if (done) return;
    const failure = outcomes.find((outcome) => outcome.type !== 'ready');
    if (failure !== undefined) finish(failure);
    else {
      ready = true;
      commit();
    }
  }, failed);
  return {
    settled,
    cancel: () => {
      for (const update of updates) update.cancel();
      finish({ type: 'cancelled' });
    },
  };
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
      currentProjection: () => current.flags.projection ?? rootTaskNodeSnapshot(current.task),
      currentOccurrence: () => current.flags.occurrence,
      currentCalendar: () => current.flags.calendar,
      tagGroups: () => current.tagGroups,
      isCurrent: () => live && current.flags.isCurrent?.() !== false,
      onRenderFailure: (error) => {
        if (!live || failed) return;
        failed = true;
        if (current.flags.isCurrent?.() === false) return;
        (current.flags.reportFailure ?? this.#reportFailure.bind(this))(error);
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
      this.#mountInteractions(card, task, context, () => current);
    } catch (error) {
      destroy();
      throw error;
    }
    return {
      element: card,
      accepts: (task, flags) => live && this.#sameOccurrence(current, { task, flags }),
      get settled() {
        return content.settled;
      },
      update: (task, tagGroups, flags, search) => {
        if (!live) return;
        if (!this.#sameOccurrence(current, { task, flags }))
          throw new Error('Cannot rebind a task card to a different source occurrence');
        current = { task, tagGroups, flags: search === undefined ? flags : { ...flags, search } };
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

  #mountInteractions(
    card: HTMLElement,
    task: TaskSnapshot,
    context: CardContentContext,
    current: () => CardState,
  ): void {
    const flags = current().flags;
    if (flags.calendar !== undefined) {
      bindTaskSelection(
        card,
        task,
        undefined,
        () => {
          if (context.isCurrent()) current().flags.calendar?.onActivate();
        },
        context.component,
      );
      context.component.registerDomEvent(card, 'contextmenu', (event) => {
        const calendar = current().flags.calendar;
        if (calendar?.kind !== 'forecast') return;
        event.preventDefault();
        event.stopPropagation();
        if (context.isCurrent()) calendar.onForecastContextMenu(event, card);
      });
    }
    if (flags.calendar?.kind !== 'forecast')
      this.#host.mountInteractions(card, task, flags.rowKey, {
        ...(flags.calendar === undefined ? {} : { calendar: flags.calendar }),
        component: context.component,
        currentTask: context.currentTask,
        currentProjection: context.currentProjection,
        ...(flags.onActivate === undefined
          ? {}
          : {
              onActivate: (task: TaskSnapshot) => {
                current().flags.onActivate?.(task);
              },
            }),
      });
  }

  #mountContents(card: HTMLElement, context: CardContentContext): CardContents {
    const mainRow = card.createDiv({ cls: 'abyss-task-card-main-row' });
    this.#renderStatus(mainRow, context.currentTask(), context);
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    const title = titleRow.createSpan({ cls: 'abyss-task-title' });
    const description = body.createDiv({ cls: 'abyss-task-desc' });
    const searchContexts = card.createDiv({ cls: 'abyss-search-contexts' });
    searchContexts.remove();
    const text = this.#mountCardText(card, context, { title, description, searchContexts });
    const header = this.#mountHeader(card, context, { titleRow, title });
    return {
      get settled() {
        return text.settled;
      },
      update: (current) => {
        header(current);
        text.update(current);
        this.syncDeleteButton(
          card,
          current.flags.showDelete && current.flags.calendar?.kind !== 'forecast'
            ? context.currentProjection().node
            : undefined,
          () => context.currentProjection().node,
        );
      },
      destroy: () => {
        text.destroy();
        this.#releaseBadges(context.badges);
      },
    };
  }
  #headerKey(current: CardState): string {
    const node = cardNode(current.task, current.flags);
    const dependencies =
      'source' in node
        ? this.#host.dependenciesFor(node)
        : this.#host.dependenciesForNode(taskNodeRef(node));
    const search = current.flags.search;
    const evidence = search?.context.tree.evidence.filter(isTaskSearchSemanticEvidence) ?? [];
    return JSON.stringify([
      this.#host.currentDate(),
      this.#settings.sourceNoteDisplay,
      this.#settings.taskFilePath,
      current.tagGroups,
      current.flags.occurrence,
      current.flags.calendar?.planning,
      search?.mode,
      dependencies?.activeBlockedByCount,
      dependencies?.activeBlocksCount,
      evidence,
      evidence.length === 0 ? undefined : search?.query.tokens,
      this.#suppressTodayMetadata(node),
    ]);
  }
  #mountHeader(
    card: HTMLElement,
    context: CardContentContext,
    hosts: { titleRow: HTMLElement; title: HTMLElement },
  ): (current: CardState) => void {
    let previous: CardState | undefined;
    let key = '';
    let owner: Component | undefined;
    return (current) => {
      const next = this.#headerKey(current);
      const changed =
        previous?.task !== current.task ||
        previous.flags.projection?.node !== current.flags.projection?.node ||
        next !== key;
      if (changed) {
        if (owner !== undefined) context.component.removeChild(owner);
        owner = context.component.addChild(new Component());
        this.#identity(card, current, owner);
        this.#refreshBadges(hosts.titleRow, hosts.title, current.task, {
          ...context,
          flags: current.flags,
        });
        if (current.flags.calendar?.kind !== 'forecast')
          this.#renderParentButton(hosts.titleRow, context, owner);
      } else {
        card.toggleClass('is-selected', current.flags.selected);
        this.#refreshStatus(card, context.currentProjection().node, current.flags.occurrence);
      }
      previous = current;
      key = next;
    };
  }
  #retainedTextInput(
    current: CardState,
    context: CardContentContext,
    kind: 'title' | 'description',
  ): RetainedTaskTextInput {
    const node = cardNode(current.task, current.flags);
    const highlight = current.flags.search ?? current.flags.highlight;
    return {
      source: {
        target: { type: kind, target: taskNodeRef(node) },
        markdown:
          kind === 'title' ? node.markdownTitle : cardDescription(current.task, current.flags),
        path: current.task.source.filePath,
        presentation: kind,
      },
      decoration: {
        kind: kind === 'title' ? 'complete' : 'preview',
        continuation:
          kind === 'description' && cardDescriptionContinues(current.task, current.flags),
        ...(highlight === undefined ? {} : { query: highlight.query, segment: highlight.segment }),
      },
      callbacks: {
        app: this.#app,
        isCurrent: context.isCurrent,
        onRenderFailure: context.onRenderFailure,
        ...(current.flags.calendar?.kind === 'forecast'
          ? {}
          : {
              onEditLink: (occurrence, token) => {
                if (kind === 'title') this.#commands.editTaskLink(node, occurrence, token);
                else
                  this.#commands.editTaskLink(node, occurrence, token, {
                    type: kind,
                    target: taskNodeRef(node),
                  });
              },
            }),
      },
    };
  }
  #mountCardText(
    card: HTMLElement,
    context: CardContentContext,
    hosts: { title: HTMLElement; description: HTMLElement; searchContexts: HTMLElement },
  ): CardContents {
    const title = new RetainedTaskText(hosts.title, context.component);
    let description = new RetainedTaskText(hosts.description, context.component);
    let tree: TaskSearchTreeMount | undefined;
    let receipt: TaskTextRender = { settled: Promise.resolve({ type: 'ready' }), cancel: () => {} };
    const searchDescription = (current: CardState, search: TaskCardSearchPresentation): void => {
      hosts.description.className = 'abyss-search-contexts';
      hosts.description.hidden = false;
      if (!hosts.searchContexts.isConnected) card.append(hosts.searchContexts);
      const options = this.#searchTreeOptions(current.task, search, {
        owner: { ...context, flags: current.flags },
        tagGroups: current.tagGroups,
      });
      if (tree === undefined) {
        description.destroy();
        hosts.description.empty();
        tree = mountTaskSearchTree(hosts.searchContexts, hosts.description, options);
      } else tree.update(options);
    };
    const ordinaryDescription = (current: CardState): PreparedTaskTextUpdate => {
      if (tree !== undefined) {
        tree.destroy();
        tree = undefined;
        description = new RetainedTaskText(hosts.description, context.component);
      }
      hosts.searchContexts.remove();
      hosts.description.className = 'abyss-task-desc';
      hosts.description.hidden =
        cardDescription(current.task, current.flags) === '' &&
        !cardDescriptionContinues(current.task, current.flags);
      return description.prepare(this.#retainedTextInput(current, context, 'description'));
    };
    return {
      get settled() {
        return receipt.settled;
      },
      update: (current) => {
        receipt.cancel();
        const updates = [title.prepare(this.#retainedTextInput(current, context, 'title'))];
        if (current.flags.search !== undefined) searchDescription(current, current.flags.search);
        else updates.push(ordinaryDescription(current));
        receipt = settleCardFields(card, context, updates, tree?.settled);
        current.flags.renderScope?.track(receipt);
      },
      destroy: () => {
        receipt.cancel();
        title.destroy();
        description.destroy();
        tree?.destroy();
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
    const node = cardNode(task, context.flags);
    this.#renderCardRecurrence(titleRow, node, context.flags);
    renderDependencyIndicator(
      titleRow,
      'source' in node
        ? this.#host.dependenciesFor(node)
        : this.#host.dependenciesForNode(taskNodeRef(node)),
    );
    this.#renderCountBadges(titleRow, node, context);
    // Only new decoration nodes move; the focused Markdown subtree stays connected.
    for (const child of Array.from(titleRow.children)) if (child !== title) title.before(child);
  }

  #renderCardRecurrence(
    titleRow: HTMLElement,
    node: TaskSelectionNode,
    flags?: TaskCardFlags,
  ): void {
    if (flags?.search?.mode !== 'search' && node.recurrence !== undefined && node.recurrence !== '')
      renderRecurrenceBadge(
        titleRow,
        recurrenceBadgeInput(node.recurrence, flags?.calendar?.kind === 'forecast'),
      );
  }

  #renderParentButton(titleRow: HTMLElement, context: CardContentContext, owner: Component): void {
    const projection = context.currentProjection();
    if (projection.target.type !== 'subtask') return;
    const parent =
      projection.path.length > 1 ? projection.path[projection.path.length - 2] : projection.root;
    if (parent === undefined) return;
    const button = renderTaskParentButton(titleRow, parent, owner, {
      show: (target, request) => this.#host.showTaskInList(target, request),
      isCurrent: context.isCurrent,
      reportFailure: (error) => {
        this.#reportFailure(error);
      },
    });
    titleRow.prepend(button);
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
      taskNodeAddress(taskNodeRef(cardNode(left.task, left.flags))) ===
        taskNodeAddress(taskNodeRef(cardNode(right.task, right.flags))) &&
      left.flags.calendar?.kind === right.flags.calendar?.kind &&
      left.flags.rowKey === right.flags.rowKey
    );
  }

  #identity(card: HTMLElement, current: CardState, component: Component): void {
    const { task, flags } = current;
    if (flags.calendar?.kind !== 'forecast') applyTaskPresentationIdentity(card, task.ref);
    if (flags.calendar !== undefined) card.dataset['occurrenceState'] = flags.calendar.kind;
    const projection = flags.projection ?? rootTaskNodeSnapshot(task);
    if (flags.calendar?.kind !== 'forecast')
      applyTaskNodePresentationIdentity(card, projection.target);
    card.dataset['filePath'] = task.source.filePath;
    card.dataset['line'] = String(taskNodeSourceLine(projection.target));
    if (flags.rowKey !== undefined) card.dataset['rowKey'] = flags.rowKey;
    card.toggleClass('is-selected', flags.selected);
    this.#refreshStatus(card, projection.node, flags.occurrence);
    this.#refreshMetadata(card, current, component);
  }

  #refreshMetadata(card: HTMLElement, current: CardState, component: Component): void {
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (mainRow === null) return;
    mainRow.querySelector(':scope > .abyss-task-meta-right')?.remove();
    this.#renderCardMetadata(mainRow, current.task, current.tagGroups, {
      search: current.flags.search,
      highlight: current.flags.highlight,
      component,
      projection: current.flags.projection,
      occurrence: current.flags.occurrence,
      calendar: current.flags.calendar,
    });
    const metadata = mainRow.querySelector(':scope > .abyss-task-meta-right');
    if (metadata !== null) mainRow.querySelector('.abyss-task-delete-btn')?.before(metadata);
  }

  #refreshStatus(
    card: HTMLElement,
    task: TaskSelectionNode,
    occurrence?: TaskOccurrencePresentation,
  ): void {
    const marker = card.querySelector<HTMLElement>('.abyss-status-marker');
    const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row');
    if (marker === null || mainRow === null) return;
    const projection =
      'source' in task
        ? this.#host.dependenciesFor(task)
        : this.#host.dependenciesForNode(taskNodeRef(task));
    updateStatusMarker(marker, {
      task,
      registry: this.#statusRegistry,
      completionBlocked: dependencyCompletionBlocked(projection),
      completion: occurrence?.completion ?? { kind: 'allowed' },
      completionHint:
        occurrence?.completion.kind === 'continuation'
          ? `Complete from the row for ${this.#host.formatDate(occurrence.completion.due)}, or in the task details.`
          : '',
    });
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
    const body = this.#renderBody(mainRow, task, flags);
    this.#renderCardMetadata(mainRow, task, tagGroups, {
      search: flags.search,
      highlight: flags.highlight,
    });
    if (flags.search !== undefined)
      this.#renderSearchContext(
        card.createDiv({ cls: 'abyss-search-contexts' }),
        task,
        flags.search,
        {
          baseTextHost: body.createDiv({ cls: 'abyss-search-contexts' }),
          scope: flags.renderScope,
          flags,
          tagGroups,
        },
      );
    this.#host.mountInteractions(card, task, flags.rowKey, {
      component: this.#host.component(),
      currentTask: () => task,
      ...(flags.onActivate === undefined ? {} : { onActivate: flags.onActivate }),
    });
    this.syncDeleteButton(card, flags.showDelete ? task : undefined);
    return card;
  }

  #renderStatus(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    current?: Pick<
      CardContentContext,
      'currentProjection' | 'currentOccurrence' | 'currentCalendar' | 'isCurrent'
    >,
  ): void {
    if (current?.currentCalendar()?.kind === 'forecast') return;
    const projection = this.#host.dependenciesFor(task);
    renderStatusMarker(mainRow, {
      task,
      registry: this.#statusRegistry,
      completionBlocked: dependencyCompletionBlocked(projection),
      onLeftClick: () => {
        if (current?.isCurrent() === false) return;
        runAsyncAction(
          this.#commands.toggleTask(
            current?.currentProjection().node ?? task,
            current?.currentOccurrence()?.completion,
          ),
        );
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        if (current?.isCurrent() === false) return;
        this.#host.openStatusMenu(
          event,
          current?.currentProjection().node ?? task,
          current?.currentOccurrence()?.completion,
        );
      },
    });
  }

  #renderBody(mainRow: HTMLElement, task: TaskSnapshot, flags?: TaskCardFlags): HTMLElement {
    const body = mainRow.createDiv({ cls: 'abyss-task-body' });
    const titleRow = body.createDiv({ cls: 'abyss-task-title-row' });
    renderDependencyIndicator(titleRow, this.#host.dependenciesFor(task));
    const recurrence = task.recurrence;
    if (flags?.search?.mode !== 'search' && recurrence !== undefined && recurrence !== '') {
      renderRecurrenceBadge(titleRow, recurrenceBadgeInput(recurrence));
    }
    this.#renderCountBadges(titleRow, task);
    const titleEl = titleRow.createSpan({ cls: 'abyss-task-title' });
    this.#renderTitle(titleEl, task, undefined, flags);
    if (flags?.search === undefined) this.#renderDescription(body, task);
    return body;
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
    const node = cardNode(task, flags);
    const titleRender = renderTaskText(titleEl, node.markdownTitle, {
      presentation: 'title',
      ...this.#highlightOptions(node.markdownTitle, 'title', search),
      app: this.#app,
      sourcePath: task.source.filePath,
      ...this.#textLifetime(context, flags),
      onEditLink: (occurrence, token) => {
        this.#commands.editTaskLink(node, occurrence, token);
      },
    });
    if (context?.track !== undefined) context.track(titleRender);
    else flags?.renderScope?.track(titleRender);
  }

  #renderCountBadges(
    titleRow: HTMLElement,
    task: TaskSelectionNode,
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
    const linkCount =
      'presentation' in task
        ? task.presentation.linkCount
        : countLinksIn([
            task.markdownTitle,
            task.description,
            ...task.comments.map((comment) => comment.text),
          ]);
    if (linkCount > 0) this.#renderCountBadge(titleRow, 'paperclip', String(linkCount));
    if (context?.flags?.calendar?.kind !== 'forecast')
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
    task: TaskSelectionNode,
    context?: CardContentContext,
  ): void {
    if (!this.#trackingEnabled || ('source' in task && isForecastCalendarTask(task))) return;
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
    let target = taskNodeRef(task);
    while (target.type === 'subtask') target = target.ref.parent;
    const rootAddress = trackingRootAddress(target.ref);
    const address = taskNodeAddress(taskNodeRef(task));
    badge.dataset['trackingRoot'] = rootAddress;
    this.#registerBadge({ address, rootAddress, total, value }, context);
  }

  #registerBadge(
    badge: { address: string; rootAddress: string; total: TrackedTotal; value: HTMLElement },
    context: CardContentContext | undefined,
  ): void {
    const { address, rootAddress, total, value } = badge;
    const badges = context === undefined ? this.#runningBadges : this.#ownedBadges;
    const existing = badges.get(address);
    badges.set(address, { rootAddress, total, values: [...(existing?.values ?? []), value] });
    context?.badges.push([address, value]);
  }

  paintTracking({ nowMs, active }: TrackingTickerState): void {
    this.#renderNowMs = nowMs;
    const roots = new Set(active.map((entry) => entry.rootAddress));
    for (const badges of [this.#runningBadges, this.#ownedBadges]) {
      for (const badge of badges.values())
        if (roots.has(badge.rootAddress)) this.#paintBadge(badge, nowMs);
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
    flags = context?.flags,
  ): void {
    const description = cardDescription(task, flags);
    const hasContinuation = cardDescriptionContinues(task, flags);
    const highlight = this.#highlightOptions(description, 'prose', flags?.highlight);
    const descriptionRender = renderTaskDescriptionText(descriptionElement, description, {
      app: this.#app,
      sourcePath: task.source.filePath,
      ...this.#textLifetime(context, flags),
      onRendered: (element) => {
        highlight.onRendered?.(element);
        if (hasContinuation) {
          // Keep the cue in the final text block, outside links and inline formatting.
          // Include raw HTML block containers: a cue after any of these starts a new line.
          const blocks = element.querySelectorAll<HTMLElement>(
            'address, article, aside, blockquote, dd, details, dialog, div, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, legend, li, main, nav, p, pre, section, summary, td, th',
          );
          (blocks[blocks.length - 1] ?? element).appendText(' …');
        }
      },
    });
    if (context?.track !== undefined) context.track(descriptionRender);
    else flags?.renderScope?.track(descriptionRender);
  }

  #renderSearchContext(
    host: HTMLElement,
    root: TaskSnapshot,
    search: TaskCardSearchPresentation,
    options: {
      readonly baseTextHost: HTMLElement;
      readonly owner?: CardContentContext | undefined;
      readonly scope?: TaskRenderScope | undefined;
      readonly flags?: TaskCardFlags | undefined;
      readonly tagGroups: readonly EffectiveTagGroup[];
    },
  ): void {
    const owner = options.owner;
    renderTaskSearchTree(
      host,
      options.baseTextHost,
      this.#searchTreeOptions(root, search, {
        owner,
        tagGroups: options.tagGroups,
        scope: options.scope,
      }),
    );
  }

  #searchTreeOptions(
    root: TaskSnapshot,
    search: TaskCardSearchPresentation,
    options: {
      readonly owner: CardContentContext | undefined;
      readonly tagGroups: readonly EffectiveTagGroup[];
      readonly scope?: TaskRenderScope | undefined;
    },
  ): TaskSearchTreeRenderOptions {
    const { owner, tagGroups, scope } = options;
    const datePresentationDay = this.#host.currentDate();
    return {
      app: this.#app,
      root,
      base: owner?.currentProjection().node ?? root,
      search,
      textOptions: this.#textLifetime(owner),
      track: (render) => {
        if (owner?.track !== undefined) owner.track(render);
        else scope?.track(render);
      },
      editLink: (target, occurrence, token) => {
        this.#commands.editTaskLink(root, occurrence, token, target);
      },
      onChildContextMenu: (event, child, row) => {
        this.#host.openChildContextMenu(event, child, row);
      },
      renderChildStatus: (host, child, current) => {
        const presentation = {
          task: child,
          registry: this.#statusRegistry,
          completionBlocked: dependencyCompletionBlocked(
            this.#host.dependenciesForNode(taskNodeRef(child)),
          ),
          onLeftClick: () => {
            const node = current();
            if (node !== undefined) runAsyncAction(this.#commands.toggleTask(node));
          },
          onContextMenu: (event: MouseEvent) => {
            event.stopPropagation();
            const node = current();
            if (node !== undefined) this.#host.openStatusMenu(event, node);
          },
        };
        const marker = host.querySelector<HTMLElement>(
          ':scope > .abyss-status-marker, :scope > .abyss-status-control > .abyss-status-marker',
        );
        if (marker === null) {
          const created = renderStatusMarker(host, presentation);
          host.prepend(created.closest('.abyss-status-control') ?? created);
        } else updateStatusMarker(marker, presentation);
      },
      metadataKey: (node, evidence) =>
        JSON.stringify([
          datePresentationDay,
          tagGroups,
          this.#settings.sourceNoteDisplay,
          this.#settings.taskFilePath,
          this.#suppressTodayMetadata(node),
          evidence,
          evidence.length === 0 ? undefined : search.query.tokens,
        ]),
      renderMetadata: (host, node, evidence, component) => {
        const metadata = this.#renderMetadata(host, node, tagGroups, {
          search,
          component,
        });
        if (metadata !== undefined)
          this.#renderSearchSemantics(metadata.host, node, evidence, {
            search,
            renderedValues: metadata.values,
          });
      },
    };
  }

  #renderCardMetadata(
    mainRow: HTMLElement,
    task: TaskSnapshot,
    tagGroups: readonly EffectiveTagGroup[],
    options: {
      readonly search?: TaskCardSearchPresentation | undefined;
      readonly highlight?: TaskCardHighlight | undefined;
      readonly component?: Component | undefined;
      readonly projection?: TaskNodeSnapshot | undefined;
      readonly calendar?: CalendarCardPolicy | undefined;
      readonly occurrence?: TaskOccurrencePresentation | undefined;
    },
  ): void {
    const metadata = this.#renderMetadata(mainRow, task, tagGroups, options);
    if (options.search !== undefined && metadata !== undefined)
      this.#renderSearchSemantics(
        metadata.host,
        cardNode(task, options),
        options.search.context.tree.evidence.filter(isTaskSearchSemanticEvidence),
        {
          search: options.search,
          renderedValues: metadata.values,
          recurrenceDecorated: options.search.mode === 'filter',
        },
      );
  }

  #renderSearchSemantics(
    host: HTMLElement,
    node: TaskSelectionNode,
    evidence: readonly TaskSearchSemanticEvidence[],
    options: {
      readonly search: TaskCardSearchPresentation;
      readonly renderedValues: ReadonlyMap<string, HTMLElement>;
      readonly recurrenceDecorated?: boolean;
    },
  ): void {
    const groups = new Map<string, TaskSearchSemanticEvidence[]>();
    for (const record of evidence) {
      if (record.field === 'tag') continue;
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
      readonly search: TaskCardSearchPresentation;
      readonly renderedValues: ReadonlyMap<string, HTMLElement>;
      readonly recurrenceDecorated?: boolean;
    },
  ): void {
    const { search, renderedValues } = options;
    const record = records[0];
    if (record === undefined) return;
    const keys = records.map((e) => e.provenance.key);
    const meaning = keys
      .map(
        (key) =>
          `${key === 'duration' && /^\d+$/u.test(record.text) ? 'Duration minutes' : key}: ${record.text}`,
      )
      .join('; ');
    const rendered = keys
      .map((key) => renderedValues.get(`${key}:${record.text}`))
      .find((element) => element !== undefined);
    if (rendered !== undefined) {
      rendered.setAttribute('role', 'group');
      rendered.setAttribute('aria-label', meaning);
      const text = rendered.querySelector<HTMLElement>(':scope > span:last-child');
      if (text?.textContent === record.text) this.#markSemanticValue(text, record.text, search);
      return;
    }
    const wrapper = host.createSpan({ attr: { role: 'group', 'aria-label': meaning } });
    this.#renderSearchMetadataValue(wrapper, node, {
      keys,
      text: record.text,
      search,
      recurrenceDecorated: options.recurrenceDecorated === true,
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
      readonly recurrenceDecorated: boolean;
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
      if (
        !value.recurrenceDecorated &&
        value.keys.includes('recurrence') &&
        node.recurrence !== undefined
      )
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
    task: TaskSelectionNode,
    tagGroups: readonly EffectiveTagGroup[],
    options: {
      readonly component?: Component | undefined;
      readonly projection?: TaskNodeSnapshot | undefined;
      readonly calendar?: CalendarCardPolicy | undefined;
      readonly occurrence?: TaskOccurrencePresentation | undefined;
      readonly highlight?: TaskCardHighlight | undefined;
      readonly search?: TaskCardSearchPresentation | undefined;
    },
  ): { readonly host: HTMLElement; readonly values: ReadonlyMap<string, HTMLElement> } | undefined {
    const node = cardMetadataNode(task, options);
    const currentTask = (): TaskSelectionNode => node;
    const dates = cardDates(node.planning, options.occurrence);
    const tags = node.tags;
    const suppressToday = options.search?.mode !== 'search' && this.#suppressTodayMetadata(node);
    const metaRight = mainRow.createDiv({ cls: 'abyss-task-meta-right' });
    const values = this.#renderDateMetadata(metaRight, node, dates, suppressToday);
    if ('source' in task) this.#renderSourceMetadata(metaRight, task);
    for (const tag of tags) {
      const element = this.#renderTagMetadata(metaRight, tag, tagGroups, {
        readOnly: options.calendar?.kind === 'forecast',
        component: options.component,
        task: node,
        currentTask,
      });
      this.#markSemanticValue(element, tag, options.search ?? options.highlight);
    }
    if (metaRight.childElementCount === 0 && options.search === undefined) {
      metaRight.remove();
      return;
    }
    return { host: metaRight, values };
  }

  #suppressTodayMetadata(node: TaskSelectionNode): boolean {
    const today = this.#host.currentDate();
    return (
      this.#state.get('mode') === 'tasks' &&
      this.#state.get('selectedList') === 'today' &&
      todayTaskCategory(node, today) === 'today'
    );
  }

  #renderSourceMetadata(host: HTMLElement, task: TaskSnapshot): void {
    if (shouldShowSourceNote(task, this.#settings.sourceNoteDisplay, this.#settings.taskFilePath))
      renderSourceNoteChip(host, task, (filePath) => {
        this.#listControls.addPropertyFilter({ type: 'file', filePath });
      });
  }

  #renderDateMetadata(
    host: HTMLElement,
    task: TaskSelectionNode,
    dates: ReturnType<typeof cardDates>,
    suppressToday: boolean,
  ): ReadonlyMap<string, HTMLElement> {
    const values = new Map<string, HTMLElement>();
    const { date, interval } = dates;
    const time = task.planning.time;
    const renderDate = (host: HTMLElement, value: LocalDate, showIcon = true): void => {
      const element = this.#renderDateFilterPart(host, value, showIcon);
      for (const key of ['due', 'scheduled', 'start'] as const)
        if (task.planning[key] === value) values.set(`${key}:${value}`, element);
    };
    const renderTime = (host: HTMLElement, value: string, className: string): void => {
      values.set(`time:${value}`, this.#renderTimeFilterPart(host, value, className));
    };
    if (interval !== undefined) {
      const dateElement = host.createSpan({ cls: 'abyss-task-date' });
      const icon = dateElement.createSpan({
        cls: 'abyss-date-icon',
        attr: { 'aria-hidden': 'true' },
      });
      const glyph = icon.createSvg('svg', {
        attr: {
          viewBox: '0 0 24 24',
          width: '16',
          height: '16',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '1',
          'aria-hidden': 'true',
        },
      });
      glyph.createSvg('path', { attr: { d: 'M4 6v12M4 12h16M20 6v12' } });
      renderDate(dateElement, interval.start, false);
      dateElement.createSpan({ text: '–' });
      renderDate(dateElement, interval.due, false);
      if (time != null) renderTime(dateElement, time, 'abyss-task-time-part');
      return values;
    }
    if (date != null && !suppressToday) {
      const dateElement = host.createSpan({
        cls: `abyss-task-date ${this.#host.getDateClass(date)}`.trim(),
      });
      renderDate(dateElement, date);
      if (time != null) renderTime(dateElement, time, 'abyss-task-time-part');
      return values;
    }
    if (time != null) renderTime(host, time, 'abyss-task-date');
    return values;
  }

  #renderDateFilterPart(host: HTMLElement, date: LocalDate, showIcon = true): HTMLElement {
    const part = host.createSpan({ cls: 'abyss-task-date-part abyss-cursor-pointer' });
    if (showIcon) {
      const icon = part.createSpan({ cls: 'abyss-date-icon' });
      setIcon(icon, 'calendar');
    }
    part.createSpan({ text: this.#host.formatDate(date) });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'date', value: date });
    });
    return part;
  }

  #renderTimeFilterPart(host: HTMLElement, time: string, className: string): HTMLElement {
    const part = host.createSpan({ cls: `${className} abyss-cursor-pointer` });
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'clock');
    part.createSpan({ text: time });
    part.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'time', value: time });
    });
    return part;
  }

  #renderTagMetadata(
    host: HTMLElement,
    tag: string,
    tagGroups: readonly EffectiveTagGroup[],
    dropContext?: {
      readonly component?: Component | undefined;
      readonly task: TaskSelectionNode;
      readonly readOnly?: boolean;
      readonly currentTask?: (() => TaskSelectionNode) | undefined;
    },
  ): HTMLElement {
    const component = dropContext?.component ?? this.#host.component();
    const element = renderTaskTagContent(host, tag, this.#host.getTagColor(tag, tagGroups));
    element.addClass('abyss-cursor-pointer');
    component.registerDomEvent(element, 'click', (event) => {
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'tag', value: tag });
    });
    component.registerDomEvent(element, 'contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#listControls.addPropertyFilter({ type: 'tag-exclude', value: tag });
    });
    if (dropContext?.readOnly === true) return element;
    component.registerDomEvent(element, 'dragover', (event) => {
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
    component.registerDomEvent(element, 'dragleave', () => {
      element.classList.remove('abyss-drop-target');
    });
    component.registerDomEvent(element, 'drop', (event) => {
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
    task: TaskSelectionNode,
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
    task: TaskSelectionNode | undefined,
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
      attr: { 'aria-label': 'Delete task' },
    });
    setIcon(deleteButton, 'x');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = currentTask();
      if (target !== undefined) runAsyncAction(this.#commands.deleteTask(target));
    });
  }
}
