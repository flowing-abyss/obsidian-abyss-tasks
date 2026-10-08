import type { AppState, ListSelection } from '../../app/AppState';
import {
  BrowserTaskScheduleError,
  createBrowserTaskScheduler,
  type BrowserTaskScheduler,
} from '../../browserTaskScheduler';
import { moment } from '../../obsidianMoment';
import type { CalendarSettings } from '../../settings/types';
import { collectTaskLinkValuesSteps, type TaskLinkResolver } from '../../task-lists/taskLinkValues';
import {
  organizeTaskSearch,
  type TaskSearchOrganization,
  type TaskSearchOrganizationInput,
} from '../../task-lists/taskSearchOrganization';
import {
  createSearchWordSegmenter,
  localDate,
  prepareSearchQuery,
  taskSearchContext,
  TaskSearchError,
  type TaskOrganizationRecord,
  type TaskReadProjectionApi,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchHit,
  type TaskSearchState,
  type TaskSnapshot,
} from '../../tasks';
import type { LocalSearchFocusTarget } from '../../ui/localSearchKeys';
import { SearchStatus } from '../../ui/searchStatus';
import type { TaskRenderOutcome } from '../../ui/taskRenderScope';
import type { PanelNavigationActions } from '../../views/panelNavigation';
import {
  runTaskOrganization,
  TaskOrganizationFailure,
  type TaskOrganizationPhase,
} from '../task-list/runTaskOrganization';
import type { TaskSearchRowsIdentity } from '../task-list/TaskSearchRows';
import type { SearchViewState } from './SearchViewState';
import type { TaskCardHighlight, TaskCardSearchPresentation } from './TaskCardRenderer';
import { navigateTaskListTarget } from './TaskListNavigation';
import type { TaskListInclusion, TaskRevealReceipt } from './TaskSearchReveal';

export interface TaskSearchRowOptions {
  readonly identity: TaskSearchRowsIdentity;
  readonly groupBy: string;
  readonly preserveAnchor: boolean;
  readonly isCurrent: () => boolean;
  readonly reportFailure: (error: unknown) => void;
  readonly onActivate?: ((address: TaskSearchAddress) => void) | undefined;
  readonly highlight?: TaskCardHighlight | undefined;
  readonly presentation?:
    ((task: TaskSnapshot, address: TaskSearchAddress) => TaskCardSearchPresentation) | undefined;
}

interface TaskSearchHost {
  destination(task: TaskSnapshot): ListSelection;
  installReveal(receipt: TaskRevealReceipt): void;
  currentReveal(): TaskRevealReceipt | undefined;
  currentInclusion?(): TaskListInclusion | undefined;
  expireReveal(): void;
  revealTask(key: string, identity: TaskSearchRowsIdentity): Promise<void>;
  beginResults(): void;
  discardResults?(): void;
  renderRows(
    host: HTMLElement,
    organization: TaskSearchOrganization,
    options: TaskSearchRowOptions,
  ): Promise<TaskRenderOutcome>;
  completeResults(): void;
  clearSelection(): void;
  renderControls(host: HTMLElement): void;
}
export interface TaskSearchOptions {
  readonly organizationScheduler?:
    ((owner: Window) => Pick<BrowserTaskScheduler, 'now' | 'yield'>) | undefined;
  readonly state: AppState;
  readonly search: TaskSearchApi | undefined;
  readonly reads: TaskReadProjectionApi | undefined;
  readonly settings: CalendarSettings;
  readonly view: () => SearchViewState;
  readonly resolveLink: TaskLinkResolver;
  readonly navigation: PanelNavigationActions;
  readonly host: TaskSearchHost;
}
type TaskSearchCursor = Awaited<ReturnType<TaskSearchApi['open']>>;
type TaskSearchBatch = Awaited<ReturnType<TaskSearchApi['read']>>;
type OrganizationIterator = ReturnType<
  ReturnType<TaskReadProjectionApi['organization']>[typeof Symbol.asyncIterator]
>;
interface SearchPreparation {
  readonly root: HTMLElement | null;
  readonly results: HTMLElement | null;
  readonly owner: Document['defaultView'] | undefined;
  readonly request: number;
  readonly signal: AbortSignal;
  generation: number | undefined;
  phase: TaskOrganizationPhase;
  secondaryCleanup: boolean;
}
interface SearchCollection {
  hits: TaskSearchHit[];
  roots: TaskSearchAddress[];
  records: TaskOrganizationRecord[];
}
type CapturedOrganization = Omit<
  TaskSearchOrganizationInput,
  'generation' | 'records' | 'hits' | 'outgoingLinks' | 'observedTags'
>;
function validateBatch(batch: TaskSearchBatch, cursor: TaskSearchCursor, offset: number): void {
  const end = offset + batch.hits.length;
  const identity =
    batch.cursor.id === cursor.id &&
    batch.cursor.generation === cursor.generation &&
    batch.offset === offset;
  const progress = batch.done ? end === cursor.total : batch.hits.length > 0;
  if (!identity || !progress || batch.hits.length > 200 || end > cursor.total)
    throw new TaskOrganizationFailure('cursor', 'step');
}
function observedBackend(state: TaskSearchState | null): 'unknown' | 'inline' | 'worker' {
  if (state?.phase !== 'ready') return 'unknown';
  return state.compatibility ? 'inline' : 'worker';
}
class TaskRevealChanged extends Error {}

/** One mounted query owns collection, compact organization, one compact order and mounted render receipts. */
export class TaskSearch {
  readonly #segment = createSearchWordSegmenter();
  readonly #options: TaskSearchOptions;
  #root: HTMLElement | null = null;
  #owner: Window | null = null;
  #input: HTMLInputElement | null = null;
  #results: HTMLElement | null = null;
  #status: SearchStatus | null = null;
  #timer: { owner: Window; id: number } | null = null;
  #cancelFocus: (() => void) | null = null;
  #pending: AbortController | null = null;
  #activation: AbortController | null = null;
  #activationId = 0;
  #activationIntent = 0;
  #unsubscribeIntent: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #observed: TaskSearchState | null = null;
  #generation: number | null = null;
  #request = 0;
  #query = '';
  #filter = false;
  #composing = false;
  #restart = false;
  #failedRenderRequest = -1;
  #organization: TaskSearchOrganization | undefined;
  constructor(options: TaskSearchOptions) {
    this.#options = options;
  }
  #inclusion(): TaskListInclusion | undefined {
    const creation = this.#options.host.currentInclusion?.();
    const navigation = this.#options.host.currentReveal();
    return (
      creation ??
      (navigation === undefined
        ? undefined
        : { id: navigation.id, kind: 'navigation', address: navigation.address })
    );
  }
  refresh(reason: 'view' | 'source' | 'projects' | 'links' = 'view'): boolean {
    if (!this.#live()) return false;
    if (reason === 'projects') this.#cancelActivation();
    if (reason === 'source' || reason === 'projects') return true;
    if (reason === 'links') {
      const view = this.#options.view();
      if (
        view.list.groupBy !== 'outgoing-link' &&
        (view.relevance || view.list.sortBy.field !== 'outgoing-link')
      )
        return true;
    }
    this.#schedule(this.#currentQuery());
    return true;
  }
  refreshFilter(root: HTMLElement, results: HTMLElement): boolean {
    if (!this.#filter || this.#root !== root || this.#results !== results) return false;
    return this.refresh();
  }
  render(root: HTMLElement): void {
    this.clear();
    this.#root = root;
    this.#filter = false;
    const header = root.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: 'Search' });
    const controls = header.createDiv({ cls: 'abyss-center-controls' });
    this.#options.host.renderControls(controls);
    const input = header.createEl('input', {
      cls: 'abyss-center-search abyss-search-global',
      attr: { type: 'text', placeholder: 'Search all tasks…', 'aria-label': 'Search all tasks' },
    });
    input.value = this.#options.state.get('searchQuery');
    this.#input = input;
    input.addEventListener('focus', () => {
      if (this.#input !== input) return;
      this.#cancelFocus?.();
      this.#cancelFocus = null;
    });
    input.addEventListener('compositionstart', () => {
      this.#composing = true;
      if (this.#root?.dataset['searchPhase'] === 'pending') this.#cancelPending();
    });
    input.addEventListener('compositionend', () => {
      this.#composing = false;
      this.#options.state.set('searchQuery', input.value);
      this.queryChanged(input.value);
    });
    input.addEventListener('input', () => {
      if (!this.#composing) this.#options.state.set('searchQuery', input.value);
    });
    this.#results = root.createDiv({ cls: 'abyss-center-scroll' });
    this.#attach(root);
    this.#schedule(input.value, 0);
    const owner = root.ownerDocument.defaultView;
    if (owner !== null) {
      const timer = owner.setTimeout(() => {
        this.#cancelFocus = null;
        if (this.#owner === owner && this.#input === input && input.isConnected) input.focus();
      }, 0);
      this.#cancelFocus = () => {
        owner.clearTimeout(timer);
      };
    }
  }
  localSearchTarget(): LocalSearchFocusTarget | undefined {
    if (this.#root?.isConnected !== true || this.#input?.isConnected !== true) return undefined;
    return { input: this.#input, owner: this.#root };
  }
  renderFilter(root: HTMLElement, results: HTMLElement, query: string): void {
    this.clear();
    this.#root = root;
    this.#results = results;
    this.#filter = true;
    this.#attach(root);
    this.#schedule(query);
  }
  #attach(root: HTMLElement): void {
    this.#owner = root.ownerDocument.defaultView;
    this.#status = new SearchStatus(root, root, (message) => {
      this.#options.host.beginResults();
      this.#options.host.discardResults?.();
      this.#organization = undefined;
      this.#results?.empty();
      this.#results?.toggleClass('abyss-search-empty', true);
      this.#results?.createDiv({ cls: 'abyss-center-empty', text: message });
    });
    const search = this.#options.search;
    if (search !== undefined) {
      this.#unsubscribeIntent = this.#options.state.onCommit(() => {
        if (
          this.#activation !== null &&
          this.#activationIntent !== this.#options.state.taskSelectionIntentGeneration
        )
          this.#cancelActivation();
      });
      this.#unsubscribe = search.subscribe((state) => {
        this.#changed(state);
      });
    }
  }
  #changed(state: TaskSearchState): void {
    this.#observed = state;
    this.#markChangedActivation(state);
    if (this.#invalidates(state)) {
      this.#cancelPending();
      this.#generation = null;
      this.#restart = true;
      this.#status?.pending(++this.#request, this.#query);
    }
    if (
      (state.phase === 'failed' || state.phase === 'disposed') &&
      (this.#currentQuery().trim() !== '' || this.#inclusion() !== undefined)
    ) {
      this.#cancelPending();
      this.#handleFailure(
        this.#request,
        new TaskSearchError('unavailable', 'Task results unavailable'),
      );
    } else if (state.phase === 'ready' && this.#restart) {
      this.#restart = false;
      this.#schedule(this.#currentQuery(), 0);
    }
  }
  #markChangedActivation(state: TaskSearchState): void {
    if (this.#activation !== null && this.#invalidates(state))
      this.#status?.announceChanged(this.#request);
  }
  #invalidates(state: TaskSearchState): boolean {
    return (
      this.#generation !== null &&
      (state.generation !== this.#generation ||
        state.phase === 'recovering' ||
        state.phase === 'failed' ||
        state.phase === 'disposed')
    );
  }
  queryChanged(query: string): void {
    if (!this.#live() || this.#filter || this.#composing) return;
    if (this.#input !== null) this.#input.value = query;
    this.#schedule(query);
  }
  onWindowMigrated(): void {
    const owner = this.#root?.ownerDocument.defaultView ?? null;
    if (owner === this.#owner) return;
    this.#cancelPending();
    this.#cancelFocus?.();
    this.#cancelFocus = null;
    this.#owner = owner;
    if (!this.#live()) return;
    const organization = this.#organization;
    if (organization !== undefined && this.#canRebindOrganization(organization)) {
      const controller = new AbortController();
      const request = this.#request;
      this.#pending = controller;
      void this.#publishRows(organization, request, controller, false).catch((error: unknown) => {
        this.#handleFailure(request, error);
      });
    } else this.#schedule(this.#currentQuery(), 0);
  }
  #canRebindOrganization(organization: TaskSearchOrganization): boolean {
    return (
      this.#root?.dataset['searchPhase'] === 'complete' &&
      this.#observed?.phase === 'ready' &&
      this.#observed.generation === organization.generation
    );
  }
  #currentQuery(): string {
    return this.#options.state.get(this.#filter ? 'centerFilter' : 'searchQuery');
  }
  #live(): boolean {
    return (
      this.#root?.isConnected === true &&
      this.#results?.isConnected === true &&
      this.#root.ownerDocument.defaultView === this.#owner
    );
  }
  #cancelActivation(): void {
    this.#activation?.abort();
    this.#activation = null;
  }
  #cancelPending(): void {
    if (this.#timer !== null) this.#timer.owner.clearTimeout(this.#timer.id);
    this.#timer = null;
    this.#cancelActivation();
    this.#pending?.abort();
    this.#pending = null;
  }
  #schedule(query: string, delay = 60): void {
    this.#cancelPending();
    const changedQuery = this.#query !== query;
    this.#query = query;
    this.#restart = false;
    this.#generation = null;
    const request = ++this.#request;
    if (changedQuery) {
      this.#organization = undefined;
      this.#options.host.clearSelection();
    }
    this.#status?.pending(request, query);
    if (query.trim().length === 0 && this.#inclusion() === undefined) {
      this.#empty(request);
      return;
    }
    const owner = this.#owner;
    if (owner === null) return;
    const id = owner.setTimeout(() => {
      this.#timer = null;
      if (request !== this.#request || !this.#live()) return;
      void this.#run(request, query).catch((error: unknown) => {
        this.#handleFailure(request, error);
      });
    }, delay);
    this.#timer = { owner, id };
  }
  #empty(request: number): void {
    this.#organization = undefined;
    this.#options.host.beginResults();
    const results = this.#results;
    if (results === null) return;
    this.#options.host.discardResults?.();
    results.empty();
    results.toggleClass('abyss-search-empty', true);
    results.createDiv({ cls: 'abyss-center-empty', text: 'Type to search tasks…' });
    this.#root?.setAttribute('data-search-logical-results', '0');
    this.#status?.complete(request, this.#observed?.generation ?? 0);
    this.#options.host.completeResults();
  }
  async #run(request: number, query: string): Promise<void> {
    const controller = new AbortController();
    this.#pending = controller;
    try {
      const organization = await this.collectOrganization(query, controller.signal);
      if (!this.canPublish(request, organization.generation, controller.signal)) return;
      await this.#publishRows(organization, request, controller);
    } catch (error) {
      this.#handleFailure(request, error);
    }
  }
  #handleFailure(request: number, error: unknown): void {
    if (request !== this.#request || !this.#live()) return;
    if (error instanceof TaskRevealChanged) {
      this.#endChangedReveal();
      return;
    }
    if (error instanceof TaskSearchError && (error.code === 'aborted' || error.code === 'stale')) {
      this.#restart = true;
      if (this.#observed?.phase === 'ready') {
        this.#restart = false;
        this.#schedule(this.#currentQuery(), 0);
      }
      return;
    }
    this.#failResults(request, error);
  }
  #failResults(request: number, error: unknown): void {
    this.#options.host.clearSelection();
    this.#options.host.discardResults?.();
    this.#root?.removeAttribute('data-search-logical-results');
    this.#status?.fail(request, error);
  }
  #endChangedReveal(): void {
    this.#options.host.expireReveal();
  }
  #joinPreparation(current: SearchPreparation, generation: number): void {
    current.generation = generation;
  }
  #cleanupFailed(current: SearchPreparation): void {
    current.secondaryCleanup = true;
  }
  #organizationPhase(current: SearchPreparation): void {
    current.phase = 'organization';
  }
  #preparationInvalidation(current: SearchPreparation): TaskSearchError | undefined {
    if (
      current.signal.aborted ||
      current.request !== this.#request ||
      !this.#samePreparationOwner(current)
    )
      return new TaskSearchError('aborted', 'Search cancelled');
    if (current.generation === undefined) return undefined;
    const observed = this.#observed;
    if (
      observed?.generation !== current.generation ||
      observed.phase === 'recovering' ||
      observed.phase === 'failed' ||
      observed.phase === 'disposed'
    )
      return new TaskSearchError('stale', 'Task generation changed');
    return undefined;
  }
  #samePreparationOwner(current: SearchPreparation): boolean {
    return (
      current.root === this.#root &&
      current.results === this.#results &&
      current.owner != null &&
      current.root?.ownerDocument.defaultView === current.owner &&
      this.#live()
    );
  }
  #assertPreparation(current: SearchPreparation): void {
    const error = this.#preparationInvalidation(current);
    if (error !== undefined) throw error;
  }
  #organizationScope(): 'nodes' | 'roots' {
    const selection = this.#options.state.get('selectedList');
    return this.#filter && !(typeof selection === 'object' && selection.type === 'project')
      ? 'nodes'
      : 'roots';
  }
  #captureOrganization(): CapturedOrganization {
    const { settings } = this.#options;
    const captured = structuredClone({
      scope: this.#organizationScope(),
      selection: this.#filter ? this.#options.state.get('selectedList') : null,
      view: this.#options.view(),
      settings: {
        inbox: settings.inbox,
        taskStatuses: settings.taskStatuses,
        tagGroups: settings.tagGroups,
        archivedTags: settings.archivedTags,
        archivedTagPrefixes: settings.archivedTagPrefixes,
      },
    });
    return { ...captured, today: localDate(moment().format('YYYY-MM-DD')), nowMs: Date.now() };
  }
  #organizationScheduler(current: SearchPreparation): Pick<BrowserTaskScheduler, 'now' | 'yield'> {
    if (current.owner == null) throw new TaskSearchError('aborted', 'Search cancelled');
    try {
      return (this.#options.organizationScheduler ?? createBrowserTaskScheduler)(current.owner);
    } catch {
      throw new TaskOrganizationFailure('scheduler', 'construction');
    }
  }
  async #handoff(
    current: SearchPreparation,
    scheduler: Pick<BrowserTaskScheduler, 'yield'>,
    signal: AbortSignal,
  ): Promise<void> {
    this.#assertPreparation(current);
    try {
      await scheduler.yield(signal);
    } catch (error) {
      if (error instanceof BrowserTaskScheduleError)
        throw new TaskOrganizationFailure('scheduler', error.kind, error.cleanupFailed);
      throw new TaskOrganizationFailure('scheduler', 'rejection');
    }
    this.#assertPreparation(current);
  }
  async #readCursor(
    cursor: TaskSearchCursor,
    current: SearchPreparation,
    collection: SearchCollection,
    handoff: () => Promise<void>,
  ): Promise<void> {
    const search = this.#options.search;
    if (search === undefined) throw new TaskSearchError('unavailable', 'Search capability missing');
    this.#assertPreparation(current);
    if (this.#observed?.phase !== 'ready')
      throw new TaskSearchError('stale', 'Task generation changed');
    this.#generation = cursor.generation;
    await handoff();
    let offset = 0;
    for (;;) {
      this.#assertPreparation(current);
      let done: boolean;
      {
        const batch = await search.read(cursor, offset, 200, current.signal);
        this.#assertPreparation(current);
        validateBatch(batch, cursor, offset);
        for (const hit of batch.hits) {
          this.#assertPreparation(current);
          collection.hits.push(hit);
          collection.roots.push({ ...hit.address, childLines: [] });
        }
        offset += batch.hits.length;
        done = batch.done;
      }
      await handoff();
      if (done) return;
    }
  }
  async #drainCursor(
    query: string,
    current: SearchPreparation,
    collection: SearchCollection,
    handoff: () => Promise<void>,
  ): Promise<number> {
    const search = this.#options.search;
    if (search === undefined) throw new TaskSearchError('unavailable', 'Search capability missing');
    const cursor = await search.open({ kind: this.#organizationScope(), query }, current.signal);
    this.#joinPreparation(current, cursor.generation);
    let failed = false,
      failure: unknown;
    try {
      await this.#readCursor(cursor, current, collection, handoff);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        search.release(cursor);
      } catch {
        this.#cleanupFailed(current);
        if (!failed) {
          failed = true;
          failure = new TaskOrganizationFailure('cleanup', 'cleanup', true);
        }
      }
    }
    if (failed) throw failure;
    return cursor.generation;
  }
  async #collectCursor(
    query: string,
    current: SearchPreparation,
    collection: SearchCollection,
    handoff: () => Promise<void>,
  ): Promise<number> {
    current.phase = 'cursor';
    try {
      return await this.#drainCursor(query, current, collection, handoff);
    } catch (error) {
      if (!(error instanceof TaskSearchError) || error.code !== 'cursor-expired') throw error;
      this.#assertPreparation(current);
      collection.hits = [];
      collection.roots = [];
      current.generation = undefined;
      return this.#drainCursor(query, current, collection, handoff);
    }
  }
  #projectionRequest(
    generation: number,
    collection: SearchCollection,
  ): Parameters<TaskReadProjectionApi['organization']>[0] {
    const inclusion = this.#inclusion();
    const selection = this.#options.state.get('selectedList');
    const request: Parameters<TaskReadProjectionApi['organization']>[0] = {
      expectedGeneration: generation,
      // Membership keeps its captured root scope; only the exact reveal may admit a child.
      scope: (inclusion?.address.childLines.length ?? 0) > 0 ? 'nodes' : this.#organizationScope(),
      ...(this.#filter && typeof selection === 'object' && selection.type === 'project'
        ? { filePath: selection.path }
        : {}),
    };
    return inclusion?.kind === 'navigation'
      ? request
      : {
          ...request,
          roots:
            inclusion === undefined ? collection.roots : [...collection.roots, inclusion.address],
        };
  }
  async #collectProjection(
    generation: number,
    current: SearchPreparation,
    collection: SearchCollection,
    handoff: () => Promise<void>,
  ): Promise<void> {
    current.phase = 'projection';
    const reads = this.#options.reads;
    if (reads === undefined) throw new TaskSearchError('unavailable', 'Search capability missing');
    const batches = reads.organization(
      this.#projectionRequest(generation, collection),
      current.signal,
    );
    const iterator = batches[Symbol.asyncIterator]();
    let complete = false,
      failed = false,
      failure: unknown;
    try {
      await this.#readProjection(iterator, current, collection, handoff);
      complete = true;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (!complete)
        try {
          await iterator.return?.();
        } catch {
          this.#cleanupFailed(current);
          if (!failed) {
            failed = true;
            failure = new TaskOrganizationFailure('cleanup', 'cleanup', true);
          }
        }
    }
    if (failed) throw failure;
  }
  async #readProjection(
    iterator: OrganizationIterator,
    current: SearchPreparation,
    collection: SearchCollection,
    handoff: () => Promise<void>,
  ): Promise<void> {
    for (;;) {
      this.#assertPreparation(current);
      const next = await iterator.next();
      this.#assertPreparation(current);
      if (next.done === true) return;
      const batch = next.value;
      if (batch.generation !== current.generation)
        throw new TaskSearchError('stale', 'Task generation changed');
      if (batch.items.length > 200) throw new TaskOrganizationFailure('projection', 'step');
      for (const record of batch.items) {
        this.#assertPreparation(current);
        collection.records.push(record);
      }
      await handoff();
    }
  }
  #normalizePreparationFailure(
    current: SearchPreparation,
    error: unknown,
  ): TaskSearchError | TaskRevealChanged {
    const invalid = this.#preparationInvalidation(current);
    if (invalid !== undefined) return invalid;
    if (error instanceof TaskRevealChanged) return error;
    if (
      error instanceof TaskSearchError &&
      (error.code === 'invalid-query' ||
        error.code === 'cursor-expired' ||
        error.code === 'unavailable')
    )
      return error;
    const failure =
      error instanceof TaskOrganizationFailure
        ? error
        : new TaskOrganizationFailure(current.phase, 'step');
    console.error('[abyss-tasks] task organization failed', {
      phase: failure.phase,
      category: failure.kind,
      request: current.request,
      generation: current.generation,
      backend: observedBackend(this.#observed),
      cleanupFailed: current.secondaryCleanup || failure.cleanupFailed,
    });
    return new TaskSearchError('unavailable', 'Task organization failed');
  }
  #revealInput(
    collection: SearchCollection,
  ): Pick<TaskSearchOrganizationInput, 'hits' | 'reveal' | 'revealKind'> {
    const receipt = this.#inclusion();
    return {
      hits: receipt?.kind === 'navigation' ? null : collection.hits,
      reveal: receipt?.address,
      revealKind: receipt?.kind,
    };
  }
  async #organizeCollected(
    current: SearchPreparation,
    collection: SearchCollection,
    captured: CapturedOrganization,
    scheduler: Pick<BrowserTaskScheduler, 'now' | 'yield'>,
  ): Promise<TaskSearchOrganization> {
    const generation = current.generation;
    if (generation === undefined) throw new TaskOrganizationFailure('organization', 'step');
    const execution = {
      signal: current.signal,
      scheduler,
      assertCurrent: (): void => {
        this.#assertPreparation(current);
      },
      budget: { targetMs: 4, maxSteps: 8192, clockCheckEvery: 32 },
    };
    current.phase = 'outgoing-links';
    const needsOutgoing =
      captured.view.list.groupBy === 'outgoing-link' ||
      (!captured.view.relevance && captured.view.list.sortBy.field === 'outgoing-link');
    const outgoingLinks = needsOutgoing
      ? await runTaskOrganization(
          collectTaskLinkValuesSteps(collection.records, this.#options.resolveLink),
          { ...execution, phase: 'outgoing-links' },
        )
      : new Map();
    this.#organizationPhase(current);
    this.#assertPreparation(current);
    const selection = captured.selection;
    const observedTags =
      selection !== null && typeof selection === 'object' && selection.type === 'group'
        ? this.#options.reads?.observedTags()
        : undefined;
    this.#assertPreparation(current);
    const organization = await runTaskOrganization(
      organizeTaskSearch({
        ...captured,
        ...(observedTags === undefined ? {} : { observedTags }),
        generation,
        records: collection.records,
        ...this.#revealInput(collection),
        outgoingLinks,
      }),
      { ...execution, phase: 'organization' },
    );
    this.#assertPreparation(current);
    return organization;
  }
  private async collectOrganization(
    query: string,
    signal: AbortSignal,
  ): Promise<TaskSearchOrganization> {
    const current: SearchPreparation = {
      root: this.#root,
      results: this.#results,
      owner: this.#root?.ownerDocument.defaultView,
      request: this.#request,
      signal,
      generation: undefined,
      phase: 'context',
      secondaryCleanup: false,
    };
    const continuation = new AbortController();
    const abort = (): void => {
      continuation.abort();
    };
    const collection: SearchCollection = { hits: [], roots: [], records: [] };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      this.#assertPreparation(current);
      const captured = this.#captureOrganization();
      const scheduler = this.#organizationScheduler(current);
      const handoff = (): Promise<void> => this.#handoff(current, scheduler, continuation.signal);
      let generation: number;
      if (this.#inclusion()?.kind !== 'navigation') {
        generation = await this.#collectCursor(query, current, collection, handoff);
        if (this.#inclusion() !== undefined) await this.#proveReveal(current);
      } else {
        await this.#options.search?.prepare(signal);
        if (this.#observed?.phase !== 'ready')
          throw new TaskSearchError('stale', 'Task generation changed');
        generation = this.#observed.generation;
        this.#joinPreparation(current, generation);
        this.#generation = generation;
        this.#assertPreparation(current);
        await this.#proveReveal(current);
      }
      await this.#collectProjection(generation, current, collection, handoff);
      return await this.#organizeCollected(current, collection, captured, scheduler);
    } catch (error) {
      throw this.#normalizePreparationFailure(current, error);
    } finally {
      continuation.abort();
      signal.removeEventListener('abort', abort);
      collection.hits = [];
      collection.roots = [];
      collection.records = [];
    }
  }
  async #proveReveal(current: SearchPreparation): Promise<void> {
    const reveal = this.#inclusion();
    if (reveal === undefined) throw new TaskSearchError('aborted', 'Reveal cancelled');
    try {
      const result = await this.#options.search?.resolveHits(
        [{ address: reveal.address, score: 0 }],
        current.signal,
      );
      this.#assertPreparation(current);
      if (result?.length !== 1) throw new TaskRevealChanged();
    } catch (error) {
      this.#assertPreparation(current);
      if (error instanceof TaskSearchError && error.code === 'stale') throw new TaskRevealChanged();
      throw error;
    }
  }
  async #publishRows(
    organization: TaskSearchOrganization,
    request: number,
    controller: AbortController,
    complete = true,
  ): Promise<void> {
    const host = this.#results;
    const observed = this.#publicationState(organization, request, controller.signal);
    if (host === null || observed === undefined) return;
    this.#organization = organization;
    const identity: TaskSearchRowsIdentity = {
      request,
      generation: organization.generation,
      semanticsRevision: observed.semanticsRevision,
      query: this.#query,
      signal: controller.signal,
    };
    const options = this.#rowOptions(identity);
    this.#options.host.beginResults();
    host.querySelector(':scope > .abyss-center-empty')?.remove();
    host.toggleClass('abyss-search-empty', false);
    const rendered = await this.#renderRows(host, organization, options);
    if (!options.isCurrent() || rendered.type !== 'ready') return;
    if (organization.occurrences.length === 0)
      host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
    await this.#revealOccurrence(organization, identity);
    if (!options.isCurrent()) return;
    this.#completeRows(organization, request, complete);
  }
  #completeRows(organization: TaskSearchOrganization, request: number, complete: boolean): void {
    this.#root?.setAttribute(
      'data-search-logical-results',
      String(organization.scope === 'roots' ? organization.rootTotal : organization.nodeTotal),
    );
    this.#status?.complete(request, organization.generation);
    if (complete) this.#options.host.completeResults();
  }
  async #revealOccurrence(
    organization: TaskSearchOrganization,
    identity: TaskSearchRowsIdentity,
  ): Promise<void> {
    const occurrence =
      organization.revealIndex === undefined
        ? undefined
        : organization.occurrences[organization.revealIndex];
    if (occurrence !== undefined && this.#inclusion()?.kind !== 'creation')
      await this.#options.host.revealTask(occurrence.key, identity);
  }
  #publicationState(
    organization: TaskSearchOrganization,
    request: number,
    signal: AbortSignal,
  ): TaskSearchState | undefined {
    const observed = this.#observed;
    return observed?.generation === organization.generation &&
      this.canPublish(request, organization.generation, signal)
      ? observed
      : undefined;
  }
  #rowOptions(identity: TaskSearchRowsIdentity): TaskSearchRowOptions {
    const isCurrent = (): boolean =>
      this.canPublish(identity.request, identity.generation, identity.signal);
    const activate = (address: TaskSearchAddress): void => {
      if (!isCurrent()) return;
      void this.activate(address).catch((error: unknown) => {
        this.#handleFailure(identity.request, error);
      });
    };
    const highlight =
      this.#query.trim() === ''
        ? undefined
        : { query: prepareSearchQuery(this.#query, this.#segment), segment: this.#segment };
    return {
      identity,
      groupBy: this.#options.view().list.groupBy,
      preserveAnchor: true,
      isCurrent,
      reportFailure: (error) => {
        if (isCurrent()) this.#renderFailed(identity.request, error);
      },
      onActivate: this.#filter ? undefined : activate,
      highlight: this.#filter ? highlight : undefined,
      presentation: this.#presentation(activate, highlight),
    };
  }
  async #renderRows(
    host: HTMLElement,
    organization: TaskSearchOrganization,
    options: TaskSearchRowOptions,
  ): Promise<TaskRenderOutcome> {
    try {
      const outcome = await this.#options.host.renderRows(host, organization, options);
      if (options.isCurrent() && outcome.type === 'failed')
        this.#renderFailed(options.identity.request, outcome.error);
      return outcome;
    } catch (error) {
      if (options.isCurrent()) this.#renderFailed(options.identity.request, error);
      return { type: 'cancelled' };
    }
  }
  #presentation(
    activate: (address: TaskSearchAddress) => void,
    highlight: TaskCardHighlight | undefined,
  ): TaskSearchRowOptions['presentation'] {
    if (this.#filter || highlight === undefined) return undefined;
    const { query } = highlight;
    const contexts = new WeakMap<TaskSnapshot, TaskCardSearchPresentation>();
    return (task, address) => {
      let presentation = contexts.get(task);
      if (presentation === undefined) {
        presentation = {
          context: taskSearchContext(task, address, query, this.#segment),
          query,
          segment: this.#segment,
          onActivate: activate,
        };
        contexts.set(task, presentation);
      }
      return presentation;
    };
  }
  #renderFailed(request: number, error: unknown): void {
    if (this.#failedRenderRequest === request) return;
    this.#failedRenderRequest = request;
    this.#options.host.discardResults?.();
    console.error('[abyss-tasks] task search render failed', {
      request,
      generation: this.#generation,
      kind: error instanceof Error ? error.name : typeof error,
    });
    this.#failResults(request, error);
  }
  private canPublish(request: number, generation: number, signal: AbortSignal): boolean {
    return (
      this.#live() &&
      request === this.#request &&
      !signal.aborted &&
      this.#observed?.phase === 'ready' &&
      this.#observed.generation === generation
    );
  }
  clear(): void {
    this.#cancelPending();
    this.#cancelFocus?.();
    this.#cancelFocus = null;
    this.#request++;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeIntent?.();
    this.#unsubscribeIntent = null;
    this.#status?.dispose();
    this.#status = null;
    this.#root?.removeAttribute('data-search-logical-results');
    this.#input = null;
    this.#results = null;
    this.#root = null;
    this.#owner = null;
    this.#observed = null;
    this.#generation = null;
    this.#restart = false;
    this.#organization = undefined;
  }
  /** Shared card/context activation; exact hydration remains valid through delayed guard acceptance. */
  async activate(address: TaskSearchAddress): Promise<void> {
    const search = this.#options.search;
    const generation = this.#activationGeneration();
    if (search === undefined || generation === undefined) return;
    this.#activation?.abort();
    const controller = new AbortController();
    this.#activation = controller;
    const id = ++this.#activationId;
    const request = this.#request;
    const intent = this.#options.state.taskSelectionIntentGeneration;
    this.#activationIntent = intent;
    const current = (): boolean =>
      this.#activation === controller &&
      this.#options.state.taskSelectionIntentGeneration === intent &&
      this.canPublish(request, generation, controller.signal);
    try {
      await navigateTaskListTarget(
        { type: 'address', address },
        {
          search,
          state: this.#options.state,
          navigation: this.#options.navigation,
          request: { signal: controller.signal, isCurrent: current },
          destination: (root) => this.#options.host.destination(root),
          installReveal: (address, selection) => {
            this.#options.host.installReveal({ id, address, selection });
          },
          onCommitted: () => {
            this.#activation = null;
          },
        },
      );
    } catch (error) {
      if (current()) this.#activationFailed(request, error);
    }
  }
  #activationGeneration(): number | undefined {
    return this.#live() && this.#observed?.phase === 'ready'
      ? this.#observed.generation
      : undefined;
  }
  #activationFailed(request: number, error: unknown): void {
    if (error instanceof TaskSearchError && error.code === 'stale') {
      this.#status?.announceChanged(this.#request);
      this.#schedule(this.#currentQuery(), 0);
    } else this.#handleFailure(request, error);
  }
}
