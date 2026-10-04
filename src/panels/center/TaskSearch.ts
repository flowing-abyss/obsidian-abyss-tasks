import type { AppState, ListSelection } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import type { CalendarSettings } from '../../settings/types';
import { outgoingTaskLinkValues, type TaskLinkResolver } from '../../task-lists/taskLinkValues';
import {
  organizeTaskSearch,
  type TaskSearchOrganization,
} from '../../task-lists/taskSearchOrganization';
import {
  localDate,
  TaskSearchError,
  type TaskOrganizationRecord,
  type TaskReadProjectionApi,
  type TaskSearchApi,
  type TaskSearchHit,
  type TaskSearchState,
  type TaskSnapshot,
} from '../../tasks';
import { isImeOwnedEvent } from '../../ui/ime';
import { SearchStatus } from '../../ui/searchStatus';
import { TaskRenderScope, type TaskRenderOutcome } from '../../ui/taskRenderScope';
import type { PanelNavigationActions } from '../../views/panelNavigation';
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
interface TaskSearchOptions {
  readonly state: AppState;
  readonly search: TaskSearchApi | undefined;
  readonly reads: TaskReadProjectionApi | undefined;
  readonly settings: CalendarSettings;
  readonly view: () => SearchViewState;
  readonly resolveLink: TaskLinkResolver;
  readonly navigation: PanelNavigationActions;
  readonly host: TaskSearchHost;
}
/** One mounted query owns collection, compact organization, a bounded page and render receipts. */
export class TaskSearch {
  readonly #options: TaskSearchOptions;
  #root: HTMLElement | null = null;
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
    const footer = root.createDiv({ cls: 'abyss-search-footer' });
    this.#status = new SearchStatus(root, footer, () => {
      const search = this.#options.search;
      if (search === undefined) return;
      void search
        .retry()
        .then(() => {
          if (this.#live()) this.#schedule(this.#currentQuery(), 0);
        })
        .catch((error: unknown) => {
          this.#status?.fail(this.#request, error);
        });
    });
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
    if (state.phase === 'failed' || state.phase === 'disposed') {
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
    return this.#root?.isConnected === true && this.#results?.isConnected === true;
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
    this.#organization = null;
    this.#generation = null;
    this.#pages?.dispose();
    const request = ++this.#request;
    this.#options.host.clearSelection();
    this.#status?.pending(request, query);
    this.#paging?.empty();
    if (query.length === 0) {
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
      let organization: TaskSearchOrganization;
      try {
        organization = await this.collectOrganization(query, controller.signal);
      } catch (error) {
        if (!(error instanceof TaskSearchError) || error.code !== 'cursor-expired') throw error;
        organization = await this.collectOrganization(query, controller.signal);
      }
      if (!this.canPublish(request, organization.generation, controller.signal)) return;
      this.#organization = organization;
      this.#pages?.set(organization);
      await this.#showPage(0, request, controller);
    } catch (error) {
      this.#handleFailure(request, error);
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
  private async collectOrganization(
    query: string,
    signal: AbortSignal,
  ): Promise<TaskSearchOrganization> {
    const { search, reads } = this.#options;
    if (search === undefined || reads === undefined)
      throw new TaskSearchError('unavailable', 'Search capability missing');
    const cursor = await search.open({ kind: 'roots', query }, signal);
    this.#generation = cursor.generation;
    const hits: TaskSearchHit[] = [];
    try {
      let offset = 0;
      let done = false;
      while (!done) {
        const page = await search.read(cursor, offset, 200, signal);
        hits.push(...page.hits);
        offset += page.hits.length;
        done = page.done;
      }
    } finally {
      search.release(cursor);
    }
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of reads.organization(
      { expectedGeneration: cursor.generation, roots: hits.map((hit) => hit.address) },
      signal,
    )) {
      if (batch.generation !== cursor.generation)
        throw new TaskSearchError('stale', 'Task generation changed');
      records.push(...batch.items);
    }
    await this.#yield(signal);
    const outgoingLinks = new Map(
      records.map((record) => [
        `${record.source.filePath}:${record.source.line}`,
        outgoingTaskLinkValues(record, this.#options.resolveLink),
      ]),
    );
    const selection: ListSelection | null = this.#filter
      ? this.#options.state.get('selectedList')
      : null;
    await this.#yield(signal);
    const organization = organizeTaskSearch({
      generation: cursor.generation,
      records,
      hits,
      selection,
      view: this.#options.view(),
      settings: this.#options.settings,
      today: localDate(moment().format('YYYY-MM-DD')),
      nowMs: Date.now(),
      outgoingLinks,
    });
    await this.#yield(signal);
    return organization;
  }
  #yield(signal: AbortSignal): Promise<void> {
    const win = this.#root?.ownerDocument.defaultView;
    return new Promise((resolve, reject) => {
      if (win == null || signal.aborted) {
        reject(new TaskSearchError('aborted', 'Search cancelled'));
        return;
      }
      const cancel = (): void => {
        win.clearTimeout(timer);
        reject(new TaskSearchError('aborted', 'Search cancelled'));
      };
      const timer = win.setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, 0);
      signal.addEventListener('abort', cancel, { once: true });
    });
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
