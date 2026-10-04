import {
  sameTaskNodeRef,
  TaskSearchError,
  type DependencyDirection,
  type TaskDependencyEligibility,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchState,
} from '../tasks';
import { isImeOwnedEvent } from './ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { runAsyncAction } from './runAsyncAction';
import { SearchStatus } from './searchStatus';
import { dependencyDirectionLabel } from './taskDependencyPresentation';
import type {
  DependencyCandidatePage,
  TaskDependencySearchProvider,
  TaskDependencySearchSession,
} from './TaskDependencySearchProvider';

export interface DependencySearchOption {
  readonly address: TaskSearchAddress;
  readonly offset: number;
  readonly task: TaskNodeSnapshot;
  readonly title: string;
  readonly context: string;
  readonly directions: readonly DependencyDirection[];
  readonly disabledReason?: string;
}

export function rejectionLabel(
  reason: Extract<TaskDependencyEligibility, { type: 'rejected' }>['reason'],
): string {
  const labels = {
    self: 'Current task',
    duplicate: 'Already linked',
    inverse: 'Already linked',
    cycle: 'Would create a cycle',
    stale: 'Task changed',
    ambiguous: 'Multiple tasks use this ID',
    unavailable: 'Task unavailable',
  };
  return labels[reason];
}

export type DependencyPickerCommitResult =
  | { readonly type: 'committed' }
  | { readonly type: 'validation-error'; readonly message: string }
  | { readonly type: 'failed' };

export interface DependencySearchOptions {
  readonly direction: DependencyDirection;
  readonly canChangeDirection: boolean;
  readonly provider: TaskDependencySearchProvider;
  readonly search: TaskSearchApi;
  readonly current: () => TaskNodeRef | undefined;
  readonly selectExisting: (
    option: DependencySearchOption,
    direction: DependencyDirection,
  ) => Promise<DependencyPickerCommitResult>;
  readonly createNew: (
    text: string,
    direction: DependencyDirection,
  ) => Promise<DependencyPickerCommitResult>;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly position?: (element: HTMLElement) => void;
  readonly ownership?: InteractionOwnershipPort;
}

export interface DependencySearchHandle {
  readonly element: HTMLElement;
  refresh(): void;
  close(restoreFocus?: boolean): void;
  destroy(): void;
  detach(): void;
  attach(): void;
}

let nextSearchId = 0;

export function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

function updateActive(list: HTMLElement, input: HTMLInputElement, activeIndex: number): void {
  list.querySelectorAll<HTMLElement>('[role="option"]').forEach((element, index) => {
    const active = index === activeIndex;
    element.setAttribute('aria-selected', String(active));
    element.toggleClass('is-active', active);
  });
  const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
  if (active === null) input.removeAttribute('aria-activedescendant');
  else {
    input.setAttribute('aria-activedescendant', active.id);
    if (typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  }
}

function isEligible(
  direction: DependencyDirection,
  option: DependencySearchOption | undefined,
): option is DependencySearchOption {
  return option?.directions.includes(direction) === true;
}

function showError(error: HTMLElement, message: string): void {
  error.setText(message);
  error.hidden = false;
}

function clearError(error: HTMLElement): void {
  error.empty();
  error.hidden = true;
}

function setBusy(element: HTMLElement, input: HTMLInputElement, busy: boolean): void {
  element.setAttribute('aria-busy', String(busy));
  input.readOnly = busy;
  element.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = busy || button.getAttribute('aria-disabled') === 'true';
  });
}

interface SearchElements {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  readonly directionControls: HTMLElement | undefined;
  readonly createAffordance: HTMLElement;
  readonly error: HTMLElement;
  readonly paging: HTMLElement;
}

export function mountDependencySearch(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
): DependencySearchHandle {
  const view = createSearchElements(container, callbacks);
  const { element, input, directionControls, createAffordance } = view;
  let ownerDocument = element.ownerDocument;
  let ownership: { release(): void } | undefined;
  let closed = false;
  const actions = new DependencySearchController(view, callbacks, () => closed);
  const outside = (event: Event): void => {
    if (!element.contains(event.target as Node)) close(false);
  };
  function close(restoreFocus = true): void {
    if (closed) return;
    destroy();
    callbacks.onClose(restoreFocus);
  }
  function destroy(): void {
    if (closed) return;
    closed = true;
    detach();
    actions.dispose();
    element.remove();
  }
  for (const direction of ['blocked-by', 'blocks'] as const) {
    const button = directionControls?.createEl('button', {
      cls: 'abyss-dep-search-direction',
      text: dependencyDirectionLabel(direction),
      attr: {
        type: 'button',
        'data-direction': direction,
        'aria-pressed': String(direction === callbacks.direction),
      },
    });
    button?.addEventListener('click', () => {
      actions.choose(direction);
    });
  }
  input.addEventListener('input', actions.reset);
  input.addEventListener('keydown', actions.key);
  createAffordance.addEventListener('click', actions.create);
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || isImeOwnedEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  function detach(): void {
    if (ownership === undefined) return;
    ownerDocument.removeEventListener('focusin', outside);
    ownerDocument.removeEventListener('pointerdown', outside);
    ownership.release();
    ownership = undefined;
    actions.detach();
  }
  function attach(): void {
    if (closed || ownership !== undefined) return;
    ownerDocument = element.ownerDocument;
    ownership = (callbacks.ownership ?? noInteractionOwnership).acquire({ blocksShortcuts: true });
    ownerDocument.addEventListener('focusin', outside);
    ownerDocument.addEventListener('pointerdown', outside);
    actions.attach();
  }
  callbacks.position?.(element);
  focusWithoutScroll(input);
  attach();
  return { element, refresh: actions.refresh, close, destroy, detach, attach };
}

function createSearchElements(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
): SearchElements {
  const dialogLabel = callbacks.canChangeDirection
    ? 'Add dependency'
    : `Add dependency: ${dependencyDirectionLabel(callbacks.direction)}`;
  const element = container.createDiv({
    cls: 'abyss-popover abyss-popover-anchored abyss-dep-search',
    attr: { role: 'dialog', 'aria-label': dialogLabel },
  });
  const search = element.createDiv({ cls: 'abyss-dep-search-field' });
  const id = `abyss-dependency-options-${nextSearchId++}`;
  const input = search.createEl('input', {
    attr: {
      type: 'search',
      placeholder: 'Search tasks or add task',
      'aria-label': 'Search tasks for dependency',
      role: 'combobox',
      'aria-controls': id,
      'aria-expanded': 'true',
      'aria-autocomplete': 'list',
    },
  });
  const createAffordance = element.createEl('button', {
    cls: 'abyss-dep-add abyss-dep-search-option abyss-dep-search-create',
    attr: { type: 'button', hidden: '' },
  });
  const directionControls = callbacks.canChangeDirection
    ? element.createDiv({
        cls: 'abyss-dep-search-directions',
        attr: { role: 'group', 'aria-label': 'Dependency direction' },
      })
    : undefined;
  const error = element.createDiv({
    cls: 'abyss-dep-search-error',
    attr: { role: 'status', hidden: '' },
  });
  const list = element.createDiv({
    cls: 'abyss-dep-search-results',
    attr: { id, role: 'listbox', 'aria-label': 'Tasks' },
  });
  const paging = element.createDiv({ cls: 'abyss-search-paging' });
  return { element, input, list, directionControls, createAffordance, error, paging };
}

const changedSelection = 'Task changed. Select again or edit text.';

class DependencySearchController {
  #options: readonly DependencySearchOption[] = [];
  #page: DependencyCandidatePage | undefined;
  #history: number[] = [];
  #direction: DependencyDirection;
  #selected: TaskNodeRef | undefined;
  #current: TaskNodeRef | undefined;
  #session: TaskDependencySearchSession | undefined;
  #owner: AbortController | undefined;
  #pending: AbortController | undefined;
  #resolving: AbortController | undefined;
  #unsubscribe: (() => void) | undefined;
  #request = 0;
  #settled = false;
  #restartedStale = false;
  #attached = false;
  #generation: number | undefined;
  #intentGeneration: number | undefined;
  #query = '';
  #state: TaskSearchState | undefined;
  readonly #status: SearchStatus;
  readonly #commit: ReturnType<typeof createSearchCommitter>;
  constructor(
    private readonly view: SearchElements,
    private readonly callbacks: DependencySearchOptions,
    private readonly isClosed: () => boolean,
  ) {
    this.#direction = callbacks.direction;
    this.#status = new SearchStatus(view.element, view.element);
    this.#commit = createSearchCommitter(
      view,
      () => {
        view.input.value = '';
        this.reset();
      },
      isClosed,
    );
  }
  #activeIndex(): number {
    return this.#options.findIndex(
      (option) =>
        this.#selected !== undefined &&
        sameTaskNodeRef(option.task.target, this.#selected) &&
        isEligible(this.#direction, option),
    );
  }
  #dropPage(): void {
    if (this.view.list.contains(this.view.element.ownerDocument.activeElement))
      focusWithoutScroll(this.view.input);
    this.#options = [];
    this.#page = undefined;
    this.view.list.empty();
    this.view.paging.empty();
    this.view.input.removeAttribute('aria-activedescendant');
    this.view.createAffordance.hidden = this.view.input.value.trim() === '';
    this.view.createAffordance.setText(`Create “${this.view.input.value.trim()}” as sub-task`);
    this.view.createAffordance.setAttribute('aria-disabled', 'true');
    this.#settled = false;
  }
  #cancel(): void {
    this.#request++;
    if (this.#resolving !== undefined) {
      this.#resolving = undefined;
      this.#commit.cancel();
    }
    this.#pending?.abort();
    this.#pending = undefined;
    this.#owner?.abort();
    this.#owner = undefined;
    this.#session?.close();
    this.#session = undefined;
    this.#generation = undefined;
    this.#dropPage();
  }
  detach = (): void => {
    this.#attached = false;
    this.#cancel();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  };
  attach = (): void => {
    if (this.#attached || this.isClosed()) return;
    this.#attached = true;
    this.#unsubscribe = this.callbacks.search.subscribe((state) => {
      this.#changed(state);
    });
    this.refresh();
  };
  dispose(): void {
    this.detach();
    this.#status.dispose();
    this.#selected = undefined;
  }
  #changed(state: TaskSearchState): void {
    const prior = this.#state;
    this.#state = state;
    if (!this.#attached || prior === undefined) return;
    if (state.phase === 'failed' || state.phase === 'disposed') {
      this.#cancel();
      this.#status.pending(this.#request, this.view.input.value);
      this.#status.fail(this.#request, new TaskSearchError('unavailable', 'Search unavailable'));
    } else if (
      (this.#generation !== undefined && this.#generation !== state.generation) ||
      prior.generation !== state.generation ||
      state.phase === 'recovering'
    ) {
      this.refresh();
    }
  }
  refresh = (): void => {
    const current = this.callbacks.current();
    if (this.#sameIntent(current)) return;
    this.#restartedStale = false;
    this.#refresh();
  };
  #sourceUnavailable(): boolean {
    return this.#state?.phase === 'recovering' || this.#state?.phase === 'failed';
  }
  #sameIntent(current: TaskNodeRef | undefined): boolean {
    return (
      this.#owner !== undefined &&
      current !== undefined &&
      this.#current !== undefined &&
      sameTaskNodeRef(current, this.#current) &&
      this.#query === this.view.input.value &&
      this.#intentGeneration === this.#state?.generation &&
      !this.#sourceUnavailable()
    );
  }
  #refresh(): void {
    if (!this.#attached || this.isClosed()) return;
    const current = this.callbacks.current();
    if (
      this.#current !== undefined &&
      (current === undefined || !sameTaskNodeRef(current, this.#current))
    )
      this.#selected = undefined;
    this.#current = current;
    this.#query = this.view.input.value;
    this.#intentGeneration = this.#state?.generation;
    this.#cancel();
    this.#history = [];
    const owner = new AbortController();
    this.#owner = owner;
    const request = this.#request;
    this.#status.pending(request, this.view.input.value);
    void this.#open(request, owner).catch((error: unknown) => {
      this.#failure(request, error);
    });
  }
  async #paint(signal: AbortSignal): Promise<void> {
    const win = this.view.element.ownerDocument.defaultView;
    if (win === null) throw new TaskSearchError('disposed', 'Owner unavailable');
    await new Promise<void>((resolve, reject) => {
      let timer = 0;
      const finish = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const frame = win.requestAnimationFrame(() => {
        timer = win.setTimeout(finish, 0);
      });
      const abort = (): void => {
        win.cancelAnimationFrame(frame);
        win.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new TaskSearchError('aborted', 'Search cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async #open(request: number, owner: AbortController): Promise<void> {
    await this.#paint(owner.signal);
    const current = this.#current;
    if (current === undefined) throw new TaskSearchError('stale', 'Task changed');
    const session = await this.callbacks.provider.open(
      this.#query,
      current,
      this.#direction,
      owner.signal,
    );
    if (!this.#live(request)) {
      session.close();
      return;
    }
    this.#session = session;
    this.#generation = this.#state?.generation;
    await this.#load(0, request, owner.signal);
  }
  #live(request: number): boolean {
    const current = this.callbacks.current();
    return (
      !this.isClosed() &&
      this.#attached &&
      request === this.#request &&
      current !== undefined &&
      this.#current !== undefined &&
      sameTaskNodeRef(current, this.#current)
    );
  }
  async #load(
    offset: number,
    request: number,
    signal: AbortSignal,
    edge?: 'first' | 'last',
  ): Promise<void> {
    const page = await this.#session?.page(offset, signal);
    if (page === undefined || !this.#live(request)) return;
    this.#page = page;
    this.#options = page.options;
    if (edge !== undefined) this.#selected = this.#edge(edge)?.task.target ?? this.#selected;
    this.view.createAffordance.removeAttribute('aria-disabled');
    renderSearchOptions(this.view, page.options, this.#direction, this.#select);
    this.view.list.querySelectorAll('[role="option"]').forEach((element) => {
      element.setAttribute('aria-setsize', String(page.totalCandidates));
    });
    refreshSearchSelection(this.view, this.#activeIndex(), this.#selected);
    this.#settled = true;
    this.#status.complete(request, this.#generation ?? 0);
    this.#renderPaging(page);
    setBusy(this.view.element, this.view.input, this.#commit.busy());
  }
  #failure(request: number, error: unknown): void {
    if (!this.#live(request)) return;
    if (
      error instanceof TaskSearchError &&
      (error.code === 'stale' || error.code === 'cursor-expired')
    ) {
      showError(this.view.error, changedSelection);
      this.#dropPage();
      if (!this.#restartedStale) {
        this.#restartedStale = true;
        this.#refresh();
      } else this.#status.cancel(request);
      return;
    }
    this.#status.fail(request, error);
  }
  reset = (): void => {
    this.#selected = undefined;
    clearError(this.view.error);
    this.#restartedStale = false;
    this.#refresh();
  };
  choose = (chosen: DependencyDirection): void => {
    if (this.#commit.busy() || chosen === this.#direction) return;
    this.#direction = chosen;
    showSearchDirection(this.view, chosen);
    this.reset();
  };
  create = (): void => {
    if (
      !this.#settled ||
      this.#commit.busy() ||
      !this.#live(this.#request) ||
      this.view.input.value.trim() === ''
    )
      return;
    this.#selected = undefined;
    updateActive(this.view.list, this.view.input, -1);
    const text = this.view.input.value,
      direction = this.#direction;
    this.#commit.run(() => this.callbacks.createNew(text, direction));
  };
  readonly #select = (option: DependencySearchOption): void => {
    if (
      !this.#settled ||
      this.#commit.busy() ||
      !isEligible(this.#direction, option) ||
      !this.#live(this.#request)
    )
      return;
    this.#selected = option.task.target;
    updateActive(this.view.list, this.view.input, this.#activeIndex());
    const request = this.#request,
      session = this.#session,
      direction = this.#direction;
    const pending = new AbortController();
    this.#pending = pending;
    this.#resolving = pending;
    const candidate = {
      address: option.address,
      offset: option.offset,
      title: option.title,
      context: option.context,
      directions: option.directions,
    };
    let submitted = false;
    this.#commit.run(
      async () => {
        let task: TaskNodeSnapshot | undefined;
        try {
          task = await session?.resolve(candidate.address, pending.signal);
        } catch (error) {
          return this.#selectionFailure(request, error);
        } finally {
          if (this.#pending === pending) this.#pending = undefined;
          if (this.#resolving === pending) this.#resolving = undefined;
        }
        if (task === undefined || !this.#live(request) || direction !== this.#direction)
          return { type: 'failed' };
        submitted = true;
        return this.callbacks.selectExisting({ ...candidate, task }, direction);
      },
      () => submitted || this.#live(request),
    );
  };
  #edge(edge: 'first' | 'last'): DependencySearchOption | undefined {
    const eligible = this.#options.filter((option) => isEligible(this.#direction, option));
    return edge === 'first' ? eligible[0] : eligible[eligible.length - 1];
  }
  #renderPaging(page: DependencyCandidatePage): void {
    const paging = this.view.paging;
    paging.empty();
    paging.createSpan({
      text: page.budgetExhausted ? 'More matches available' : `${page.totalCandidates} candidates`,
    });
    for (const [label, delta, disabled] of [
      ['Previous page', -1, this.#history.length === 0],
      ['Next page', 1, !page.hasMore],
    ] as const) {
      const button = paging.createEl('button', {
        text: delta < 0 ? 'Previous' : 'Next',
        attr: { 'aria-label': label, 'aria-disabled': String(disabled) },
      });
      button.disabled = disabled;
      button.addEventListener('click', () => {
        if (!disabled) this.#navigate(delta);
      });
    }
  }
  #navigate(delta: number, edge?: 'first' | 'last'): void {
    const page = this.#page;
    if (!this.#settled || this.#commit.busy() || page === undefined) return;
    let offset: number | undefined;
    if (delta > 0 && page.hasMore) {
      this.#history.push(page.startOffset);
      offset = page.nextOffset;
    } else if (delta < 0) offset = this.#history.pop();
    if (offset === undefined) return;
    this.#pending?.abort();
    const pending = new AbortController();
    this.#pending = pending;
    const request = ++this.#request;
    this.#dropPage();
    this.#status.pending(request, this.view.input.value);
    void this.#load(offset, request, pending.signal, edge).catch((error: unknown) => {
      this.#failure(request, error);
    });
  }
  key = (event: KeyboardEvent): void => {
    if (
      this.#commit.busy() ||
      isImeOwnedEvent(event) ||
      !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.#settled) return;
    if (event.key === 'Enter') {
      const option = this.#options[this.#activeIndex()];
      if (option !== undefined) this.#select(option);
      else if (this.#selected !== undefined) showError(this.view.error, changedSelection);
      else this.create();
      return;
    }
    this.#move(event.key);
  };
  #adjacent(delta: number): DependencySearchOption | undefined {
    let index = this.#activeIndex();
    if (index === -1) index = delta > 0 ? -1 : this.#options.length;
    if (delta > 0)
      return this.#options.find((option, i) => i > index && isEligible(this.#direction, option));
    return this.#options
      .slice(0, index)
      .reverse()
      .find((option) => isEligible(this.#direction, option));
  }
  #move(key: string): void {
    const delta = key === 'ArrowUp' ? -1 : 1;
    const edgeKey = key === 'Home' || key === 'End';
    const edge = key === 'Home' ? 'first' : 'last';
    const next = edgeKey ? this.#edge(edge) : this.#adjacent(delta);
    if (next === undefined) {
      if (!edgeKey) this.#navigate(delta, delta > 0 ? 'first' : 'last');
      return;
    }
    this.#selected = next.task.target;
    clearError(this.view.error);
    updateActive(this.view.list, this.view.input, this.#activeIndex());
  }
  #selectionFailure(request: number, error: unknown): DependencyPickerCommitResult {
    if (!this.#live(request)) return { type: 'failed' };
    if (error instanceof TaskSearchError && ['stale', 'aborted'].includes(error.code))
      return { type: 'validation-error', message: changedSelection };
    this.#status.fail(request, error);
    return { type: 'failed' };
  }
}

function refreshSearchSelection(
  view: SearchElements,
  active: number,
  selected: TaskNodeRef | undefined,
): void {
  if (selected !== undefined && active === -1) showError(view.error, changedSelection);
  else if (view.error.textContent === changedSelection) clearError(view.error);
  updateActive(view.list, view.input, active);
}

function showSearchDirection(view: SearchElements, direction: DependencyDirection): void {
  focusWithoutScroll(view.input);
  view.directionControls
    ?.querySelectorAll<HTMLButtonElement>('[data-direction]')
    .forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset['direction'] === direction));
    });
}

function createSearchCommitter(
  view: SearchElements,
  reset: () => void,
  isClosed: () => boolean,
): {
  busy(): boolean;
  cancel(): void;
  run(action: () => Promise<DependencyPickerCommitResult>, current?: () => boolean): void;
} {
  const { element, input, error } = view;
  let busy = false;
  let revision = 0;
  const commit = async (
    action: () => Promise<DependencyPickerCommitResult>,
    current: () => boolean,
    operation: number,
  ): Promise<void> => {
    try {
      const result = await action();
      if (isClosed() || operation !== revision || !current()) return;
      if (result.type === 'committed') reset();
      else if (result.type === 'validation-error') showError(error, result.message);
    } finally {
      if (operation === revision) {
        busy = false;
        if (!isClosed()) {
          setBusy(element, input, false);
          if (current()) focusWithoutScroll(input);
        }
      }
    }
  };
  return {
    busy: () => busy,
    cancel(): void {
      revision++;
      busy = false;
      setBusy(element, input, false);
    },
    run(action: () => Promise<DependencyPickerCommitResult>, current = () => true): void {
      if (busy || isClosed()) return;
      clearError(error);
      busy = true;
      setBusy(element, input, true);
      runAsyncAction(commit(action, current, ++revision), 'Could not add dependency');
    },
  };
}

function renderSearchOptions(
  { list, input, createAffordance }: SearchElements,
  options: readonly DependencySearchOption[],
  direction: DependencyDirection,
  select: (option: DependencySearchOption) => void,
): void {
  list.empty();
  options.forEach((option, index) => {
    const button = list.createEl('button', {
      cls: 'abyss-dep-search-option',
      attr: {
        type: 'button',
        role: 'option',
        id: `${list.id}-${index}`,
        'aria-selected': 'false',
        'aria-posinset': String(option.offset + 1),
        'aria-setsize': String(options.length),
        'aria-disabled': String(!isEligible(direction, option)),
        tabindex: '-1',
      },
    });
    button.createSpan({ cls: 'abyss-dep-search-title', text: option.title });
    button.createSpan({ cls: 'abyss-dep-search-context', text: option.context });
    if (option.disabledReason !== undefined)
      button.createSpan({ cls: 'abyss-dep-search-reason', text: option.disabledReason });
    button.addEventListener('click', () => {
      select(option);
    });
  });
  if (options.length === 0)
    list.createDiv({
      cls: 'abyss-dep-search-empty',
      text: 'No matching tasks',
      attr: { role: 'status' },
    });
  const text = input.value.trim();
  createAffordance.hidden = text.length === 0;
  createAffordance.setText(text.length === 0 ? '' : `Create “${text}” as sub-task`);
}
