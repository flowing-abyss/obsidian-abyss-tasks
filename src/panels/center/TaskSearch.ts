import type { AppState } from '../../app/AppState';
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
  localDate,
  TaskSearchError,
  type TaskOrganizationRecord,
  type TaskReadProjectionApi,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchHit,
  type TaskSearchState,
  type TaskSnapshot,
} from '../../tasks';
import { isImeOwnedEvent } from '../../ui/ime';
import { SearchStatus } from '../../ui/searchStatus';
import { TaskRenderScope, type TaskRenderOutcome } from '../../ui/taskRenderScope';
import type { PanelNavigationActions } from '../../views/panelNavigation';
import {
  runTaskOrganization,
  TaskOrganizationFailure,
  type TaskOrganizationPhase,
} from '../task-list/runTaskOrganization';
import { TaskSearchPages, type TaskSearchPageModel } from '../task-list/TaskSearchPages';
import type { SearchViewState } from './SearchViewState';

interface TaskSearchHost {
  revealTask(task: TaskSnapshot): void;
  beginResults(): void;
  renderRows(
    host: HTMLElement,
    page: TaskSearchPageModel,
    scope: TaskRenderScope,
    onCard?: (card: HTMLElement, task: TaskSnapshot) => void,
  ): Promise<TaskRenderOutcome>;
  completeResults(): void;
  prepareDependencies(generation: number, signal: AbortSignal): Promise<void>;
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
type TaskSearchPage = Awaited<ReturnType<TaskSearchApi['read']>>;
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
  'generation' | 'records' | 'hits' | 'outgoingLinks'
>;
function validatePage(page: TaskSearchPage, cursor: TaskSearchCursor, offset: number): void {
  const end = offset + page.hits.length;
  const identity =
    page.cursor.id === cursor.id &&
    page.cursor.generation === cursor.generation &&
    page.offset === offset;
  const progress = page.done ? end === cursor.total : page.hits.length > 0;
  if (!identity || !progress || page.hits.length > 200 || end > cursor.total)
    throw new TaskOrganizationFailure('cursor', 'step');
}
function observedBackend(state: TaskSearchState | null): 'unknown' | 'inline' | 'worker' {
  if (state?.phase !== 'ready') return 'unknown';
  return state.compatibility ? 'inline' : 'worker';
}
/** One mounted query owns collection, compact organization, a bounded page and render receipts. */
export class TaskSearch {
  readonly #options: TaskSearchOptions;
  #root: HTMLElement | null = null;
  #owner: Window | null = null;
  #input: HTMLInputElement | null = null;
  #results: HTMLElement | null = null;
  #status: SearchStatus | null = null;
  #paging: HTMLElement | null = null;
  #timer: number | null = null;
  #pending: AbortController | null = null;
  #unsubscribe: (() => void) | null = null;
  #observed: TaskSearchState | null = null;
  #generation: number | null = null;
  #request = 0;
  #pages: TaskSearchPages | null = null;
  #organization: TaskSearchOrganization | null = null;
  #query = '';
  #filter = false;
  #composing = false;
  #restart = false;
  constructor(options: TaskSearchOptions) {
    this.#options = options;
  }
  refresh(): boolean {
    if (!this.#live()) return false;
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
    input.addEventListener('compositionstart', () => {
      this.#composing = true;
      this.#cancelPending();
    });
    input.addEventListener('compositionend', () => {
      this.#composing = false;
      this.#options.state.set('searchQuery', input.value);
      this.queryChanged(input.value);
    });
    input.addEventListener('input', () => {
      if (!this.#composing) this.#options.state.set('searchQuery', input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (isImeOwnedEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (root.isConnected) root.focus({ preventScroll: true });
    });
    this.#results = root.createDiv({ cls: 'abyss-center-scroll' });
    this.#attach(root);
    this.#schedule(input.value, 0);
    root.ownerDocument.defaultView?.setTimeout(() => {
      if (this.#input === input && input.isConnected) input.focus();
    }, 0);
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
    const footer = root.createDiv({ cls: 'abyss-search-footer' });
    this.#status = new SearchStatus(root, footer);
    this.#paging = footer.createDiv({ cls: 'abyss-search-paging' });
    const search = this.#options.search;
    if (search !== undefined) {
      this.#pages = new TaskSearchPages(search);
      this.#unsubscribe = search.subscribe((state) => {
        this.#changed(state);
      });
    }
  }
  #changed(state: TaskSearchState): void {
    this.#observed = state;
    if (this.#invalidates(state)) {
      this.#cancelPending();
      this.#generation = null;
      this.#organization = null;
      this.#restart = true;
      this.#status?.pending(++this.#request, this.#query);
    }
    if (
      (state.phase === 'failed' || state.phase === 'disposed') &&
      this.#currentQuery().trim() !== ''
    ) {
      this.#cancelPending();
      this.#status?.fail(
        this.#request,
        new TaskSearchError('unavailable', 'Task results unavailable'),
      );
    } else if (state.phase === 'ready' && this.#restart) {
      this.#restart = false;
      this.#schedule(this.#currentQuery(), 0);
    }
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
  #cancelPending(): void {
    if (this.#timer !== null) this.#root?.ownerDocument.defaultView?.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending?.abort();
    this.#pending = null;
  }
  #schedule(query: string, delay = 60): void {
    this.#cancelPending();
    this.#query = query;
    this.#restart = false;
    this.#organization = null;
    this.#generation = null;
    this.#pages?.dispose();
    const request = ++this.#request;
    this.#options.host.clearSelection();
    this.#status?.pending(request, query);
    this.#paging?.empty();
    if (query.trim().length === 0) {
      this.#empty(request);
      return;
    }
    this.#timer =
      this.#root?.ownerDocument.defaultView?.setTimeout(() => {
        this.#timer = null;
        void this.#run(request, query).catch((error: unknown) => {
          this.#handleFailure(request, error);
        });
      }, delay) ?? null;
  }
  #empty(request: number): void {
    this.#options.host.beginResults();
    const results = this.#results;
    if (results === null) return;
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
      this.#organization = organization;
      this.#pages?.set(organization);
      await this.#showPage(0, request, controller);
    } catch (error) {
      this.#handleFailure(request, error);
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }
  #handleFailure(request: number, error: unknown): void {
    if (request !== this.#request || !this.#live()) return;
    if (error instanceof TaskSearchError && (error.code === 'aborted' || error.code === 'stale')) {
      this.#restart = true;
      if (this.#observed?.phase === 'ready') {
        this.#restart = false;
        this.#schedule(this.#currentQuery(), 0);
      }
      return;
    }
    this.#status?.fail(request, error);
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
  #captureOrganization(): CapturedOrganization {
    const { settings } = this.#options;
    const captured = structuredClone({
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
        const page = await search.read(cursor, offset, 200, current.signal);
        this.#assertPreparation(current);
        validatePage(page, cursor, offset);
        for (const hit of page.hits) {
          this.#assertPreparation(current);
          collection.hits.push(hit);
          collection.roots.push(hit.address);
        }
        offset += page.hits.length;
        done = page.done;
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
    const cursor = await search.open({ kind: 'roots', query }, current.signal);
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
      { expectedGeneration: generation, roots: collection.roots },
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
  #normalizePreparationFailure(current: SearchPreparation, error: unknown): TaskSearchError {
    const invalid = this.#preparationInvalidation(current);
    if (invalid !== undefined) return invalid;
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
    const organization = await runTaskOrganization(
      organizeTaskSearch({
        ...captured,
        generation,
        records: collection.records,
        hits: collection.hits,
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
      const generation = await this.#collectCursor(query, current, collection, handoff);
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
  async #showPage(index: number, request: number, controller: AbortController): Promise<void> {
    const organization = this.#organization;
    if (organization === null || this.#pages === null) return;
    const page = await this.#pages.page(index, controller.signal);
    if (!this.canPublish(request, organization.generation, controller.signal)) return;
    if (page.occurrences.length > 0)
      await this.#options.host.prepareDependencies(organization.generation, controller.signal);
    if (!this.canPublish(request, organization.generation, controller.signal)) return;
    const rendered = await this.mountPage(page, controller.signal);
    if (!this.#renderReady(rendered)) return;
    if (!this.canPublish(request, organization.generation, controller.signal)) return;
    this.#renderPaging(page);
    this.#root?.setAttribute('data-search-logical-results', String(page.rootTotal));
    this.#status?.complete(request, organization.generation);
    this.#options.host.completeResults();
  }
  #renderReady(outcome: TaskRenderOutcome): boolean {
    if (outcome.type === 'failed') throw outcome.error;
    return outcome.type === 'ready';
  }
  private async mountPage(
    page: TaskSearchPageModel,
    signal: AbortSignal,
  ): Promise<TaskRenderOutcome> {
    const host = this.#results;
    if (host === null || signal.aborted) return { type: 'cancelled' };
    this.#options.host.beginResults();
    host.empty();
    host.toggleClass('abyss-search-empty', false);
    if (page.total === 0) host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
    const scope = new TaskRenderScope(signal);
    return this.#options.host.renderRows(
      host,
      page,
      scope,
      this.#filter
        ? undefined
        : (card, task) => {
            this.#mountNavigation(card, task);
          },
    );
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
  #renderPaging(page: TaskSearchPageModel): void {
    const paging = this.#paging;
    if (paging === null) return;
    paging.empty();
    paging.createSpan({
      text:
        page.total === page.rootTotal
          ? `${page.rootTotal} tasks · Page ${page.page + 1} of ${page.pageCount}`
          : `${page.rootTotal} tasks · ${page.total} occurrences · Page ${page.page + 1} of ${page.pageCount}`,
    });
    for (const [label, index, disabled] of [
      ['Previous page', page.page - 1, page.page === 0],
      ['Next page', page.page + 1, page.page + 1 >= page.pageCount],
    ] as const) {
      const button = paging.createEl('button', {
        text: label.startsWith('Previous') ? 'Previous' : 'Next',
        attr: { 'aria-label': label },
      });
      button.disabled = disabled;
      button.addEventListener('click', () => {
        if (disabled) return;
        this.#cancelPending();
        const request = ++this.#request;
        this.#options.host.clearSelection();
        this.#status?.pending(request, this.#query);
        const controller = new AbortController();
        this.#pending = controller;
        void this.#showPage(index, request, controller).catch((error) => {
          this.#handleFailure(request, error);
        });
      });
    }
  }
  clear(): void {
    this.#cancelPending();
    this.#request++;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#pages?.dispose();
    this.#pages = null;
    this.#status?.dispose();
    this.#status = null;
    this.#paging?.parentElement?.remove();
    this.#paging = null;
    this.#input = null;
    this.#results = null;
    this.#root = null;
    this.#owner = null;
    this.#observed = null;
    this.#generation = null;
    this.#organization = null;
    this.#restart = false;
  }
  #mountNavigation(card: HTMLElement, task: TaskSnapshot): void {
    card.addEventListener(
      'click',
      (e) => {
        const target = e.target as Element;
        if (
          target.closest(
            'button,a,.abyss-status-control,.abyss-status-marker,.abyss-task-tag,.abyss-task-date-part,.abyss-task-time-part,.abyss-task-source-note',
          ) !== null
        )
          return;
        e.stopPropagation();
        const todayStr = localDate(moment().format('YYYY-MM-DD'));
        const date = task.planning.due ?? task.planning.scheduled;
        let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
        if ((task.planning.due != null && task.planning.due < todayStr) || date === todayStr)
          list = 'today';
        else if (date != null && date > todayStr) list = 'upcoming';
        this.#options.navigation.openList(list);
        this.#options.state.set('taskStack', [task]);
        this.#options.host.revealTask(task);
      },
      { capture: true },
    );
  }
}
