import type { AppState } from '../../app/AppState';
import { moment } from '../../obsidianMoment';
import { searchTaskList } from '../../task-lists/TaskListSelector';
import { localDate, type TaskQueryApi, type TaskSnapshot } from '../../tasks';
import { isImeOwnedEvent } from '../../ui/ime';
import type { PanelNavigationActions } from '../../views/panelNavigation';

interface TaskSearchHost {
  beginResults(): void;
  renderRows(
    host: HTMLElement,
    tasks: TaskSnapshot[],
    onCard: (card: HTMLElement, task: TaskSnapshot) => void,
  ): void;
  completeResults(): void;
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
    if (this.#frame !== null) {
      this.#root?.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
    }
    this.#frame =
      this.#root?.ownerDocument.defaultView?.requestAnimationFrame(() => {
        this.#frame = null;
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
        this.#renderResults(results, query);
      }) ?? null;
  }

  clear(): void {
    if (this.#frame !== null) {
      this.#root?.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    this.#input = null;
    this.#results = null;
    this.#root = null;
  }

  #renderResults(host: HTMLElement, query: string): void {
    this.#host.beginResults();
    host.empty();
    host.toggleClass('abyss-search-empty', query.length === 0);

    if (query.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'Type to search tasks…' });
      this.#host.completeResults();
      return;
    }

    const matchingTasks = [...searchTaskList(this.#queries.list(), query)];
    if (matchingTasks.length === 0) {
      host.createDiv({ cls: 'abyss-center-empty', text: 'No results' });
      this.#host.completeResults();
      return;
    }
    this.#host.renderRows(host, matchingTasks, (card, task) => {
      this.#mountNavigation(card, task);
    });
    this.#host.completeResults();
  }

  /**
   * A click on a Search result opens Today, Upcoming, or Inbox with the task selected, except on
   * its status control. The capture listener joins after the card's own listeners.
   */
  #mountNavigation(card: HTMLElement, task: TaskSnapshot): void {
    card.addEventListener(
      'click',
      (e) => {
        const statusControl = card.querySelector('.abyss-status-control, .abyss-status-marker');
        if (statusControl?.contains(e.target as Node) === true) return;
        e.stopPropagation();
        const todayStr = localDate(moment().format('YYYY-MM-DD'));
        const d = task.planning.due ?? task.planning.scheduled;
        let list: 'inbox' | 'today' | 'upcoming' = 'inbox';
        if ((task.planning.due != null && task.planning.due < todayStr) || d === todayStr) {
          list = 'today';
        } else if (d != null && d > todayStr) {
          list = 'upcoming';
        }
        this.#navigation.openList(list);
        this.#state.set('taskStack', [task]);
      },
      { capture: true },
    );
  }
}
