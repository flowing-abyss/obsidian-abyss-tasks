import type { AppState } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import { searchTaskList } from '../../task-lists/TaskListSelector';
import { localDate, type TaskQueryApi, type TaskSnapshot } from '../../tasks';
import { isImeOwnedEvent } from '../../ui/ime';
import type { PanelNavigationActions } from '../../views/panelNavigation';

interface TaskSearchHost {
  revealTask(task: TaskSnapshot): void;
  beginResults(): void;
  renderRows(
    host: HTMLElement,
    tasks: TaskSnapshot[],
    onCard: (card: HTMLElement, task: TaskSnapshot) => void | (() => void),
  ): void;
  completeResults(): void;
  failResults(error: unknown): void;
}

interface TaskSearchOptions {
  readonly state: AppState;
  readonly queries: Pick<TaskQueryApi, 'list'>;
  readonly navigation: PanelNavigationActions;
  readonly host: TaskSearchHost;
}

/** Owns Search's live input, coalesced result frame and card navigation. */
export class TaskSearch {
  readonly #state: AppState;
  readonly #queries: Pick<TaskQueryApi, 'list'>;
  readonly #navigation: PanelNavigationActions;
  readonly #host: TaskSearchHost;
  #root: HTMLElement | null = null;
  #input: HTMLInputElement | null = null;
  #results: HTMLElement | null = null;
  #frame: number | null = null;
  #revision = 0;

  constructor(options: TaskSearchOptions) {
    this.#state = options.state;
    this.#queries = options.queries;
    this.#navigation = options.navigation;
    this.#host = options.host;
  }

  refresh(): boolean {
    if (
      this.#state.get('mode') !== 'search' ||
      this.#input?.isConnected !== true ||
      this.#results?.isConnected !== true
    )
      return false;
    this.#scheduleResults(this.#state.get('searchQuery'));
    return true;
  }

  render(root: HTMLElement): void {
    this.clear();
    this.#root = root;
    const header = root.createDiv({ cls: 'abyss-center-header' });
    header.createEl('h2', { cls: 'abyss-center-title', text: 'Search' });
    const input = header.createEl('input', {
      cls: 'abyss-center-search abyss-search-global',
      attr: { type: 'text', placeholder: 'Search all tasks…', 'aria-label': 'Search all tasks' },
    });
    input.value = this.#state.get('searchQuery');
    input.addEventListener('input', () => {
      this.#state.set('searchQuery', input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (isImeOwnedEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (root.isConnected) root.focus({ preventScroll: true });
    });
    this.#input = input;

    const results = root.createDiv({ cls: 'abyss-center-scroll' });
    this.#results = results;
    this.#renderResults(results, input.value);

    root.ownerDocument.defaultView?.setTimeout(() => {
      if (this.#input === input && input.isConnected) input.focus();
    }, 0);
  }

  queryChanged(query: string): void {
    const input = this.#input;
    const results = this.#results;
    if (
      this.#state.get('mode') !== 'search' ||
      input === null ||
      !input.isConnected ||
      results?.isConnected !== true
    ) {
      return;
    }
    if (input.value !== query) input.value = query;
    this.#scheduleResults(query);
  }

  #scheduleResults(query: string): void {
    const revision = ++this.#revision;
    const input = this.#input;
    const results = this.#results;
    if (this.#frame !== null) {
      this.#root?.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
    }
    this.#frame =
      this.#root?.ownerDocument.defaultView?.requestAnimationFrame(() => {
        if (revision !== this.#revision || input !== this.#input || results !== this.#results)
          return;
        this.#frame = null;
        if (
          this.#state.get('mode') !== 'search' ||
          input === null ||
          !input.isConnected ||
          results?.isConnected !== true
        ) {
          return;
        }
        this.#renderResults(results, query);
      }) ?? null;
  }

  clear(): void {
    this.#revision++;
    if (this.#frame !== null) {
      this.#root?.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    this.#input = null;
    this.#results = null;
    this.#root = null;
  }

  #renderResults(host: HTMLElement, query: string): void {
    const revision = this.#revision;
    const input = this.#input;
    const isCurrent = (): boolean =>
      revision === this.#revision &&
      input === this.#input &&
      host === this.#results &&
      this.#state.get('mode') === 'search' &&
      host.isConnected &&
      input?.isConnected === true;
    try {
      this.#host.beginResults();
      if (!isCurrent()) return;
      host.querySelector(':scope > .abyss-center-empty')?.remove();
      host.toggleClass('abyss-search-empty', query.length === 0);
      const matchingTasks =
        query.length === 0 ? [] : [...searchTaskList(this.#queries.list(), query)];
      if (!isCurrent()) return;
      this.#host.renderRows(host, matchingTasks, (card, task) => {
        if (!isCurrent()) return;
        return this.#mountNavigation(card, task);
      });
      if (!isCurrent()) return;
      if (matchingTasks.length === 0)
        host.createDiv({
          cls: 'abyss-center-empty',
          text: query.length === 0 ? 'Type to search tasks…' : 'No results',
        });
      this.#host.completeResults();
    } catch (error) {
      if (isCurrent()) this.#host.failResults(error);
    }
  }

  /**
   * A click on a Search result opens Today, Upcoming, or Inbox with the task selected, except on
   * its status control. The capture listener joins after the card's own listeners.
   */
  #mountNavigation(card: HTMLElement, task: TaskSnapshot): () => void {
    const revision = this.#revision;
    const results = this.#results;
    const handler = (e: MouseEvent): void => {
      if (revision !== this.#revision || this.#results !== results || !card.isConnected) return;
      const statusControl = card.querySelector('.abyss-status-control, .abyss-status-marker');
      if (statusControl?.contains(e.target as Node) === true) return;
      e.stopPropagation();
      this.#navigation.openList(this.#listForTask(task));
      this.#state.set('taskStack', [task]);
      this.#host.revealTask(task);
    };
    card.addEventListener('click', handler, true);
    return () => {
      card.removeEventListener('click', handler, true);
    };
  }

  #listForTask(task: TaskSnapshot): 'inbox' | 'today' | 'upcoming' {
    const todayStr = localDate(moment().format('YYYY-MM-DD'));
    const d = task.planning.due ?? task.planning.scheduled;
    let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
    if ((task.planning.due != null && task.planning.due < todayStr) || d === todayStr) {
      list = 'today';
    } else if (d != null && d > todayStr) {
      list = 'upcoming';
    }
    return list;
  }
}
