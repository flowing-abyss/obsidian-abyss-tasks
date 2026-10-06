import { Platform, Scope } from 'obsidian';
import { createBrowserTaskScheduler, type BrowserTaskScheduler } from '../browserTaskScheduler';
import { indexedRows, type TaskListRow } from '../panels/task-list/taskListRows';
import {
  TaskListSurface,
  type TaskListPresentation,
  type TaskRowMount,
} from '../panels/task-list/TaskListSurface';
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
import {
  bindLocalSearchScope,
  handleLocalSearchKey,
  isPlainSearchEscape,
  localSearchEditorOwnsEvent,
  localSearchEventIsOwned,
  localSearchKeyIsBlocked,
  localSearchSurfaceIsVisible,
  type LocalSearchScopeHost,
} from './localSearchKeys';
import { runAsyncAction } from './runAsyncAction';
import { SearchStatus } from './searchStatus';
import { dependencyDirectionLabel } from './taskDependencyPresentation';
import type {
  DependencyCandidate,
  DependencyCandidateRange,
  TaskDependencySearchProvider,
  TaskDependencySearchSession,
} from './TaskDependencySearchProvider';

export interface DependencySearchOption {
  readonly address: TaskSearchAddress;
  readonly offset: number;
  readonly title: string;
  readonly context: string;
  readonly directions: readonly DependencyDirection[];
  readonly disabledReason?: string;
}

interface DependencySearchCommitOption extends DependencySearchOption {
  readonly task: TaskNodeSnapshot;
}
interface DependencyDemand {
  readonly sessionId: number;
  readonly generation: number;
  readonly revision: number;
  readonly offsets: readonly number[];
  readonly anchorOffset: number;
}
interface DependencyFill {
  readonly demand: DependencyDemand;
  readonly candidates: readonly DependencyCandidate[];
  readonly omittedRevision: number;
  readonly exhausted: boolean;
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
    option: DependencySearchCommitOption,
    direction: DependencyDirection,
  ) => Promise<DependencyPickerCommitResult>;
  readonly createNew: (
    text: string,
    direction: DependencyDirection,
  ) => Promise<DependencyPickerCommitResult>;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly position?: (element: HTMLElement) => void;
  readonly ownership?: InteractionOwnershipPort;
  readonly localSearchScope?: LocalSearchScopeHost | undefined;
}

export interface DependencySearchHandle {
  readonly element: HTMLElement;
  refresh(): void;
  close(restoreFocus?: boolean): void;
  destroy(): void;
  detach(options?: { readonly forRender: boolean }): void;
  attach(): void;
}

let nextSearchId = 0;

export function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

function updateActive(list: HTMLElement, input: HTMLInputElement, activeOffset: number): void {
  list.querySelectorAll<HTMLElement>('[role="option"]').forEach((element) => {
    const active = element.getAttribute('aria-posinset') === String(activeOffset + 1);
    element.setAttribute('aria-selected', String(active));
    element.toggleClass('is-active', active);
  });
  const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
  if (active === null) input.removeAttribute('aria-activedescendant');
  else {
    input.setAttribute('aria-activedescendant', active.id);
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
}

export function mountDependencySearch(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
): DependencySearchHandle {
  const view = createSearchElements(container, callbacks);
  const { element, input, createAffordance } = view;
  let ownerDocument = element.ownerDocument;
  let ownership: { release(): void } | undefined;
  let closed = false;
  let needsPosition = false;
  let releaseScope: (() => void) | undefined;
  const actions = new DependencySearchController(view, callbacks, () => closed, detach);
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
  bindDirectionControls(view, callbacks.direction, actions.choose);
  input.addEventListener('input', actions.reset);
  input.addEventListener('keydown', actions.key);
  createAffordance.addEventListener('click', actions.create);
  const route = pickerKeyRouter(
    view,
    () => !closed && ownership !== undefined && element.ownerDocument === ownerDocument,
    close,
  );
  element.addEventListener('keydown', (event) => {
    route(event, 'dom');
  });
  function detach(options?: { readonly forRender: boolean }): void {
    releaseScope?.();
    releaseScope = undefined;
    // Synchronous inspector rendering retains its search cursor and interaction owner.
    if (options?.forRender === true) return;
    if (ownership === undefined) return;
    ownerDocument.removeEventListener('focusin', outside);
    ownerDocument.removeEventListener('pointerdown', outside);
    ownership.release();
    ownership = undefined;
    actions.detach();
    needsPosition = true;
  }
  function attach(): void {
    if (ownership !== undefined && ownerDocument !== element.ownerDocument) detach();
    if (closed || !localSearchSurfaceIsVisible(element)) return;
    ownerDocument = element.ownerDocument;
    if (ownership === undefined) {
      ownership = (callbacks.ownership ?? noInteractionOwnership).acquire({
        blocksShortcuts: true,
      });
      ownerDocument.addEventListener('focusin', outside);
      ownerDocument.addEventListener('pointerdown', outside);
    }
    if (needsPosition) {
      view.list.classList.add('has-candidates');
      callbacks.position?.(element);
      needsPosition = false;
    }
    releaseScope ??= acquirePickerScope(callbacks.localSearchScope, element, route);
    actions.attach();
  }
  callbacks.position?.(element);
  focusWithoutScroll(input);
  attach();
  return { element, refresh: actions.refresh, close, destroy, detach, attach };
}

function bindDirectionControls(
  view: SearchElements,
  chosen: DependencyDirection,
  choose: (direction: DependencyDirection) => void,
): void {
  for (const direction of ['blocked-by', 'blocks'] as const) {
    const button = view.directionControls?.createEl('button', {
      cls: 'abyss-dep-search-direction',
      text: dependencyDirectionLabel(direction),
      attr: {
        type: 'button',
        'data-direction': direction,
        'aria-pressed': String(direction === chosen),
      },
    });
    button?.addEventListener('click', () => {
      choose(direction);
    });
  }
}

function pickerKeyRouter(
  { element, input }: SearchElements,
  isAttached: () => boolean,
  close: () => void,
): (event: KeyboardEvent, origin: 'dom' | 'scope') => boolean {
  const primary = Platform.isMacOS ? 'meta' : 'ctrl';
  return (event: KeyboardEvent, origin: 'dom' | 'scope'): boolean => {
    if (
      !isAttached() ||
      !localSearchSurfaceIsVisible(element) ||
      !localSearchEventIsOwned(event, element, origin) ||
      localSearchKeyIsBlocked(event)
    )
      return false;
    const ownerDocument = element.ownerDocument;
    const active = ownerDocument.activeElement;
    if (active?.closest('.abyss-dep-search') !== element) return false;
    if (localSearchEditorOwnsEvent(event, ownerDocument, input)) return false;
    if (handleLocalSearchKey(event, { input, owner: element }, primary)) return true;
    if (!isPlainSearchEscape(event)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    return true;
  };
}

function acquirePickerScope(
  host: LocalSearchScopeHost | undefined,
  element: HTMLElement,
  route: (event: KeyboardEvent, origin: 'scope') => boolean,
): (() => void) | undefined {
  if (host === undefined) return undefined;
  const scope = new Scope(host.parent);
  const doc = element.ownerDocument;
  const unbind = bindLocalSearchScope(
    scope,
    (event) => element.ownerDocument === doc && route(event, 'scope'),
  );
  host.keymap.pushScope(scope);
  return () => {
    unbind();
    host.keymap.popScope(scope);
  };
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
    attr: { role: 'dialog', 'aria-label': dialogLabel, tabindex: '-1' },
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
    cls: 'abyss-dep-search-results has-candidates',
    attr: { id, role: 'listbox', 'aria-label': 'Tasks' },
  });
  return { element, input, list, directionControls, createAffordance, error };
}

const changedSelection = 'Task changed. Select again or edit text.';

class DependencySearchController {
  #options: readonly DependencySearchOption[] = [];
  #surface: TaskListSurface<number> | undefined;
  #scheduler: BrowserTaskScheduler | undefined;
  #document: Document | undefined;
  #candidates: readonly DependencyCandidate[] = [];
  readonly #omitted = new Set<number>();
  #omittedRevision = 0;
  #publishedOmittedRevision = 0;
  #demandRevision = 0;
  #demand:
    | {
        readonly demand: DependencyDemand;
        readonly signature: string;
        readonly controller: AbortController;
      }
    | undefined;
  #settledDemand: string | undefined;
  #publishing = false;
  #direction: DependencyDirection;
  #selected: TaskSearchAddress | undefined;
  #selectedOffset: number | undefined;
  #movement: AbortController | undefined;
  #queuedMove: string | undefined;
  #releaseMovePin: (() => void) | undefined;
  #moveScrollTop: number | undefined;
  #geometryCleanup: (() => void) | undefined;
  #geometryAvailable = false;
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
  #intentDirection: DependencyDirection | undefined;
  #query = '';
  #state: TaskSearchState | undefined;
  readonly #status: SearchStatus;
  readonly #commit: ReturnType<typeof createSearchCommitter>;
  constructor(
    private readonly view: SearchElements,
    private readonly callbacks: DependencySearchOptions,
    private readonly isClosed: () => boolean,
    private readonly detachOwner: () => void,
  ) {
    this.#direction = callbacks.direction;
    view.list.addEventListener(
      'scroll',
      () => {
        if (this.#releaseMovePin !== undefined && this.#moveScrollTop === view.list.scrollTop)
          return;
        this.#cancelDemand();
        this.#cancelMove();
        this.#queuedMove = undefined;
      },
      { passive: true },
    );
    this.#status = new SearchStatus(view.element, view.element, (message) => {
      showError(view.error, message);
    });
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
        sameSearchAddress(option.address, this.#selected) &&
        isEligible(this.#direction, option),
    );
  }
  #dropSurface(): void {
    const active = this.view.element.ownerDocument.activeElement;
    if (this.view.list.contains(active)) focusWithoutScroll(this.view.input);
    this.#cancelMove();
    this.#geometryCleanup?.();
    this.#geometryCleanup = undefined;
    this.#options = [];
    this.#surface?.destroy();
    this.#surface = undefined;
    this.#scheduler = undefined;
    this.#candidates = [];
    this.view.list.empty();
    this.view.input.removeAttribute('aria-activedescendant');
    this.view.createAffordance.hidden = this.view.input.value.trim() === '';
    this.view.createAffordance.setText(`Create “${this.view.input.value.trim()}” as sub-task`);
    this.view.createAffordance.setAttribute('aria-disabled', 'true');
    this.view.createAffordance.setAttribute('disabled', '');
    this.#settled = false;
  }
  #cancel(): void {
    this.#queuedMove = undefined;
    this.#request++;
    if (this.#resolving !== undefined) {
      this.#resolving = undefined;
      this.#commit.cancel();
    }
    this.#cancelDemand();
    this.#omitted.clear();
    this.#omittedRevision = 0;
    this.#publishedOmittedRevision = 0;
    this.#settledDemand = undefined;
    this.#pending?.abort();
    this.#pending = undefined;
    this.#owner?.abort();
    this.#owner = undefined;
    this.#session?.close();
    this.#session = undefined;
    this.#generation = undefined;
    this.#dropSurface();
    this.#document = undefined;
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
      this.#intentDirection === this.#direction &&
      this.#document === this.view.element.ownerDocument &&
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
    if (this.#intentGeneration !== this.#state?.generation) this.#selectedOffset = undefined;
    this.#current = current;
    this.#query = this.view.input.value;
    this.#intentGeneration = this.#state?.generation;
    this.#intentDirection = this.#direction;
    this.#cancel();
    this.#document = this.view.element.ownerDocument;
    const owner = new AbortController();
    this.#owner = owner;
    const request = this.#request;
    this.view.list.classList.add('has-candidates');
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
    this.#generation = session.generation;
    if (session.totalCandidates === 0) {
      await session.readRange(0, 1, owner.signal);
      if (!this.#live(request) || owner.signal.aborted) return;
      this.#completeEmpty();
      return;
    }
    this.#document = this.view.element.ownerDocument;
    const win = this.#document.defaultView;
    if (win === null) throw new TaskSearchError('disposed', 'Owner unavailable');
    this.#scheduler = createBrowserTaskScheduler(win);
    this.#surface = new TaskListSurface<number>({
      host: this.view.list,
      scroll: this.view.list,
      mount: (host, row) => this.#mountRow(host, row),
      mountedChanged: this.#mountedChanged,
      reportFailure: (error) => {
        this.#cancelDemand();
        this.#failure(request, error);
      },
    });
    this.view.list.classList.add('has-candidates');
    this.#bindGeometry();
    this.#surface.update(
      indexedRows<number>(
        Array.from({ length: session.totalCandidates }, (_, offset) => ({
          kind: 'task' as const,
          key: String(offset),
          taskKey: String(offset),
          task: offset,
        })),
      ),
      this.#presentation(false),
      'throw',
    );
  }
  #live(request: number): boolean {
    const current = this.callbacks.current();
    return (
      !this.isClosed() &&
      this.#attached &&
      request === this.#request &&
      this.#document === this.view.element.ownerDocument &&
      current !== undefined &&
      this.#current !== undefined &&
      sameTaskNodeRef(current, this.#current)
    );
  }
  #presentation(preserveAnchor: boolean): TaskListPresentation<number> {
    return {
      revision: String(this.#request),
      preserveAnchor,
      estimate: () => 48,
      measurementRevision: () => 'dependency',
    };
  }
  #mountRow(host: HTMLElement, row: TaskListRow<number>): TaskRowMount<number> {
    // Deferred selection-time remounts need labels even at the previous offsets.
    if (this.#resolving !== undefined) this.#settledDemand = undefined;
    const element = host.createEl('button', {
      cls: 'abyss-dep-search-option',
      attr: { type: 'button', tabindex: '-1', 'aria-hidden': 'true' },
    });
    element.inert = true;
    const offset = row.kind === 'task' ? row.task : -1;
    element.addEventListener('click', () => {
      const option = this.#options.find((option) => option.offset === offset);
      if (option !== undefined) this.#select(option);
    });
    return {
      element,
      update: () => {},
      destroy: () => {
        element.remove();
      },
    };
  }
  #bindGeometry(): void {
    this.#geometryCleanup?.();
    const win = this.#document?.defaultView;
    const surface = this.#surface;
    if (win == null || surface === undefined) return;
    this.#geometryAvailable = this.#positiveGeometry();
    const check = (): void => {
      if (surface !== this.#surface || !this.#attached) return;
      if (this.#document !== this.view.element.ownerDocument || !this.view.element.isConnected) {
        this.detachOwner();
        return;
      }
      const available = this.#positiveGeometry();
      if (available === this.#geometryAvailable) return;
      this.#geometryAvailable = available;
      if (available) surface.resume();
      else {
        this.#cancelDemand();
        this.#cancelMove();
        this.#settledDemand = undefined;
        surface.suspend();
      }
    };
    const observer = new win.ResizeObserver(check);
    observer.observe(this.view.list);
    win.addEventListener('resize', check);
    this.#geometryCleanup = () => {
      observer.disconnect();
      win.removeEventListener('resize', check);
    };
  }
  #positiveGeometry(): boolean {
    return (
      localSearchSurfaceIsVisible(this.view.list) &&
      this.view.list.isConnected &&
      this.view.list.clientHeight > 0 &&
      this.view.list.clientWidth > 0
    );
  }
  #captureDemand(): DependencyDemand | undefined {
    const session = this.#session,
      surface = this.#surface;
    if (
      session === undefined ||
      surface === undefined ||
      !this.#live(this.#request) ||
      this.#document !== this.view.element.ownerDocument ||
      !this.#positiveGeometry()
    )
      return;
    const offsets = surface
      .mountedKeys()
      .map(Number)
      .sort((a, b) => a - b);
    if (offsets.length === 0) return;
    const rect = this.view.list.getBoundingClientRect();
    const anchorOffset =
      offsets.find((offset) => {
        const holder = surface.element(String(offset))?.getBoundingClientRect();
        return holder !== undefined && holder.bottom > rect.top && holder.top < rect.bottom;
      }) ?? offsets[0];
    if (anchorOffset === undefined) return;
    return {
      sessionId: this.#request,
      generation: session.generation,
      revision: this.#demandRevision,
      offsets,
      anchorOffset,
    };
  }
  #signature(demand: DependencyDemand): string {
    return `${demand.sessionId}:${demand.generation}:${demand.anchorOffset}:${demand.offsets.join(',')}`;
  }
  readonly #mountedChanged = (): void => {
    if (this.#publishing) return;
    const request = this.#request;
    // Surface reconciliation owns this stack; projection starts after it has settled.
    queueMicrotask(() => {
      if (request !== this.#request) return;
      if (this.#releaseMovePin !== undefined) this.#moveScrollTop = this.view.list.scrollTop;
      this.#startDemand();
    });
  };
  #startDemand(): void {
    if (this.#movement !== undefined || this.#resolving !== undefined) return;
    const captured = this.#captureDemand();
    if (captured === undefined) return;
    const signature = this.#signature(captured);
    if (signature === this.#demand?.signature || signature === this.#settledDemand) return;
    this.#cancelDemand();
    const demand = { ...captured, revision: ++this.#demandRevision };
    const controller = new AbortController();
    this.#demand = { demand, signature, controller };
    const mounted = new Set(demand.offsets);
    this.#candidates = this.#candidates.filter((candidate) => mounted.has(candidate.offset));
    this.#options = this.#options.filter((option) => mounted.has(option.offset));
    this.#settled = false;
    this.view.createAffordance.setAttribute('aria-disabled', 'true');
    this.view.createAffordance.setAttribute('disabled', '');
    this.view.input.removeAttribute('aria-activedescendant');
    this.#status.pending(this.#request, this.#query);
    void this.#runDemand(demand, controller.signal).catch((error: unknown) => {
      if (!this.#demandLive(demand, controller.signal)) {
        // A changed current target or adopted document can invalidate an await before refresh.
        if (this.#demand?.demand === demand) {
          this.#cancel();
          this.#status.cancel(demand.sessionId);
        }
        return;
      }
      this.#cancelDemand();
      this.#failure(demand.sessionId, error);
    });
  }
  #demandLive(demand: DependencyDemand, signal: AbortSignal): boolean {
    return (
      !signal.aborted &&
      this.#demand?.demand === demand &&
      this.#live(demand.sessionId) &&
      this.#generation === demand.generation &&
      this.#document === this.view.element.ownerDocument
    );
  }
  #checkDemand(demand: DependencyDemand, signal: AbortSignal): void {
    if (!this.#demandLive(demand, signal)) throw new TaskSearchError('aborted', 'Search cancelled');
  }
  #cancelDemand(): void {
    if (this.#demand?.signature === this.#settledDemand) this.#settledDemand = undefined;
    this.#demand?.controller.abort();
    this.#demand = undefined;
  }
  async #fillDemand(demand: DependencyDemand, signal: AbortSignal): Promise<DependencyFill> {
    this.#checkDemand(demand, signal);
    const session = this.#session;
    if (session === undefined) throw new TaskSearchError('aborted', 'Search cancelled');
    const candidates = [...this.#candidates];
    const runs = dependencyRuns(demand.offsets);
    await this.#fillMountedRuns(demand, signal, runs, candidates);
    // Demanded sparse runs are visited first; each remaining gap is traversed at most once.
    for (const interval of dependencyFillIntervals(
      runs,
      demand.anchorOffset,
      session.totalCandidates,
    )) {
      await this.#fillUnknownInterval(demand, signal, candidates, interval);
    }
    return {
      demand,
      candidates,
      omittedRevision: this.#omittedRevision,
      exhausted: this.#omitted.size === session.totalCandidates,
    };
  }
  async #readDemandInterval(
    demand: DependencyDemand,
    signal: AbortSignal,
    start: number,
    limit: number,
  ): Promise<readonly DependencyCandidate[]> {
    this.#checkDemand(demand, signal);
    const range = await this.#session?.readRange(start, limit, signal);
    this.#checkDemand(demand, signal);
    validateDemandRange(range, demand.generation, start, limit);
    const included = this.#admitCandidates(range.candidates);
    await this.#scheduler?.yield(signal);
    this.#checkDemand(demand, signal);
    return included;
  }
  #admitCandidates(candidates: readonly DependencyCandidate[]): DependencyCandidate[] {
    const included: DependencyCandidate[] = [];
    for (const candidate of candidates) {
      if (!omittedDependency(candidate)) included.push(candidate);
      else if (!this.#omitted.has(candidate.offset)) {
        this.#omitted.add(candidate.offset);
        this.#omittedRevision++;
      }
    }
    return included;
  }
  *#unknownRanges(
    interval: { start: number; end: number; direction: 1 | -1 },
    reused?: ReadonlySet<number>,
  ): Generator<{ offset: number; limit: number }> {
    const { start, end, direction } = interval;
    let offset = start;
    const inside = (): boolean => (direction === 1 ? offset <= end : offset >= end);
    const known = (): boolean => this.#omitted.has(offset) || reused?.has(offset) === true;
    while (inside()) {
      if (known()) {
        offset += direction;
        continue;
      }
      const first = offset;
      let limit = 1;
      offset += direction;
      while (limit < 200 && inside() && !known()) {
        limit++;
        offset += direction;
      }
      yield { offset: direction === 1 ? first : first - limit + 1, limit };
    }
  }
  async #fillMountedRuns(
    demand: DependencyDemand,
    signal: AbortSignal,
    runs: ReadonlyArray<{ start: number; end: number }>,
    candidates: DependencyCandidate[],
  ): Promise<void> {
    const reused = new Set(candidates.map((candidate) => candidate.offset));
    for (const run of runs) {
      for (const { offset, limit } of this.#unknownRanges({ ...run, direction: 1 }, reused)) {
        candidates.push(...(await this.#readDemandInterval(demand, signal, offset, limit)));
      }
    }
  }
  async #fillUnknownInterval(
    demand: DependencyDemand,
    signal: AbortSignal,
    candidates: DependencyCandidate[],
    interval: { start: number; end: number; direction: 1 | -1 },
  ): Promise<void> {
    const { direction } = interval;
    let remaining = dependencyFillDeficit(demand, candidates, direction);
    if (remaining <= 0) return;
    for (const { offset, limit } of this.#unknownRanges(interval)) {
      const included = await this.#readDemandInterval(demand, signal, offset, limit);
      remaining -= included.length;
      retainDependencyFill(demand, candidates, included, direction);
      if (remaining <= 0) break;
    }
  }
  #publishFilled(fill: DependencyFill, signal: AbortSignal): void {
    this.#checkDemand(fill.demand, signal);
    if (fill.demand.offsets.length === 0) return;
    this.#settledDemand = this.#signature(fill.demand);
    const surface = this.#surface;
    if (surface === undefined) return;
    if (fill.omittedRevision !== this.#publishedOmittedRevision) {
      this.#publishing = true;
      try {
        const rows = surface.rows.rows.filter(
          (row) => row.kind === 'task' && !this.#omitted.has(row.task),
        );
        surface.update(indexedRows<number>(rows), this.#presentation(true), 'throw');
        this.#publishedOmittedRevision = fill.omittedRevision;
      } finally {
        this.#publishing = false;
      }
    }
  }
  async #runDemand(demand: DependencyDemand, signal: AbortSignal): Promise<void> {
    let exhausted: boolean;
    {
      const fill = await this.#fillDemand(demand, signal);
      this.#publishFilled(fill, signal);
      this.#checkDemand(demand, signal);
      const next = this.#captureDemand();
      const mounted = new Set(next?.offsets ?? []);
      this.#candidates = fill.candidates
        .filter((candidate) => mounted.has(candidate.offset))
        .sort((a, b) => a.offset - b.offset);
      exhausted = fill.exhausted;
    }
    await this.#projectDemand(demand, signal, exhausted);
    this.#checkDemand(demand, signal);
    this.#demand = undefined;
    const settled = this.#captureDemand();
    if (
      settled?.offsets.every((offset) =>
        this.#candidates.some((candidate) => candidate.offset === offset),
      ) === true
    )
      this.#settledDemand = this.#signature(settled);
    else this.#mountedChanged();
  }
  async #projectDemand(
    demand: DependencyDemand,
    signal: AbortSignal,
    exhausted: boolean,
  ): Promise<void> {
    const options = await this.#session?.options(this.#candidates, signal);
    this.#checkDemand(demand, signal);
    this.#options = options ?? [];
    this.#refreshSelectedOffset();
    for (const option of this.#options) this.#renderOption(option);
    this.#revealMovement();
    if (exhausted) this.#completeEmpty();
    this.#settled = this.#mountedReady();
    if (this.#settled) this.view.createAffordance.removeAttribute('aria-disabled');
    refreshSearchSelection(this.view, this.#options[this.#activeIndex()], this.#selected);
    if (this.#settled) this.#status.complete(this.#request, demand.generation);
    this.#surface?.refreshMeasurements();
    setBusy(this.view.element, this.view.input, this.#commit.busy());
    this.#finishMovement();
  }
  #revealMovement(): void {
    // Hydrated labels replace placeholder heights before movement gives up its pin.
    if (this.#releaseMovePin !== undefined && this.#selectedOffset !== undefined) {
      this.#publishing = true;
      try {
        this.#surface?.reveal(String(this.#selectedOffset));
        this.#moveScrollTop = this.view.list.scrollTop;
      } finally {
        this.#publishing = false;
      }
    }
  }
  #finishMovement(): void {
    if (!this.#settled) return;
    this.#releaseMovePin?.();
    this.#releaseMovePin = undefined;
    const queued = this.#queuedMove;
    this.#queuedMove = undefined;
    if (queued !== undefined) this.#move(queued);
  }
  #mountedReady(): boolean {
    return (
      this.#surface
        ?.mountedKeys()
        .every((key) => this.#options.some((option) => String(option.offset) === key)) === true
    );
  }
  #refreshSelectedOffset(): void {
    const selected = this.#options.find(
      (option) => this.#selected !== undefined && sameSearchAddress(option.address, this.#selected),
    );
    if (selected !== undefined) this.#selectedOffset = selected.offset;
  }
  #renderOption(option: DependencySearchOption): void {
    const holder = this.#surface?.element(String(option.offset));
    if (holder === undefined) return;
    holder.empty();
    holder.inert = false;
    holder.removeAttribute('aria-hidden');
    holder.setAttribute('role', 'option');
    holder.id = `${this.view.list.id}-${this.#request}-${option.offset}`;
    holder.setAttribute('aria-posinset', String(option.offset + 1));
    holder.setAttribute('aria-setsize', String(this.#session?.totalCandidates ?? 0));
    holder.setAttribute('aria-disabled', String(!isEligible(this.#direction, option)));
    holder.createSpan({ cls: 'abyss-dep-search-title', text: option.title });
    holder.createSpan({ cls: 'abyss-dep-search-context', text: option.context });
    if (option.disabledReason !== undefined)
      holder.createSpan({ cls: 'abyss-dep-search-reason', text: option.disabledReason });
  }
  #completeEmpty(): void {
    this.view.list.classList.remove('has-candidates');
    this.view.list.createDiv({
      cls: 'abyss-dep-search-empty',
      text: 'No matching tasks',
      attr: { role: 'status' },
    });
    this.#settled = true;
    this.view.createAffordance.removeAttribute('aria-disabled');
    this.#status.complete(this.#request, this.#generation ?? 0);
    setBusy(this.view.element, this.view.input, this.#commit.busy());
  }
  #canReopen(): boolean {
    return (
      !this.#restartedStale &&
      this.#owner?.signal.aborted === false &&
      this.#sameIntent(this.callbacks.current())
    );
  }
  #failure(request: number, error: unknown): void {
    if (!this.#live(request)) return;
    const recoverable =
      error instanceof TaskSearchError && ['stale', 'cursor-expired'].includes(error.code);
    if (recoverable && this.#canReopen()) {
      this.#restartedStale = true;
      this.#refresh();
      return;
    }
    this.#cancelDemand();
    this.#owner?.abort();
    // Retain the stopped intent so unchanged refreshes cannot replenish its one-shot recovery.
    if (!recoverable) this.#owner = undefined;
    this.#session?.close();
    this.#session = undefined;
    this.#dropSurface();
    if (
      error instanceof TaskSearchError &&
      ['aborted', 'stale', 'cursor-expired'].includes(error.code)
    ) {
      this.#status.cancel(request);
      return;
    }
    this.#status.fail(request, error);
  }
  reset = (): void => {
    this.#selected = undefined;
    this.#selectedOffset = undefined;
    clearError(this.view.error);
    updateActive(this.view.list, this.view.input, -1);
    this.refresh();
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
    this.#selected = option.address;
    this.#selectedOffset = option.offset;
    updateActive(this.view.list, this.view.input, option.offset);
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
          if (this.#resolving === pending) {
            this.#resolving = undefined;
            this.#mountedChanged();
          }
        }
        if (task === undefined || !this.#live(request) || direction !== this.#direction)
          return { type: 'failed' };
        submitted = true;
        return this.callbacks.selectExisting({ ...candidate, task }, direction);
      },
      () => submitted || this.#live(request),
    );
  };
  key = (event: KeyboardEvent): void => {
    if (
      isImeOwnedEvent(event) ||
      !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (this.#commit.busy() || this.#movement !== undefined) return;
    if (!this.#settled) {
      if (event.key !== 'Enter') this.#queuedMove = event.key;
      return;
    }
    if (event.key === 'Enter') {
      const option = this.#options[this.#activeIndex()];
      if (option !== undefined) this.#select(option);
      else if (this.#selected !== undefined) showError(this.view.error, changedSelection);
      else this.create();
      return;
    }
    this.#move(event.key);
  };
  #cancelMove(): void {
    if (this.#movement !== undefined) this.#settledDemand = undefined;
    this.#movement?.abort();
    this.#movement = undefined;
    this.#releaseMovePin?.();
    this.#releaseMovePin = undefined;
  }
  #moveEdge(rows: ReadonlyArray<TaskListRow<number>>, backwards: boolean, total: number): number {
    const row = backwards ? rows[rows.length - 1] : rows[0];
    if (row?.kind === 'task') return row.task;
    return backwards ? total - 1 : 0;
  }
  #moveStart(key: string, delta: number, total: number): number {
    const rows = this.#surface?.rows.rows ?? [];
    if (key === 'Home') return this.#moveEdge(rows, false, total);
    if (key === 'End') return this.#moveEdge(rows, true, total);
    return this.#adjacentOffset(rows, delta, total);
  }
  #adjacentOffset(rows: ReadonlyArray<TaskListRow<number>>, delta: number, total: number): number {
    if (this.#selectedOffset === undefined) return this.#moveEdge(rows, delta < 0, total);
    const index = this.#surface?.rows.indexOf(String(this.#selectedOffset)) ?? -1;
    const row = rows[index + delta];
    if (index >= 0 && row?.kind === 'task') return row.task;
    return this.#selectedOffset + delta;
  }
  #move(key: string): void {
    const session = this.#session;
    if (session === undefined || !this.#positiveGeometry()) return;
    this.#cancelMove();
    const backwards = key === 'End' || key === 'ArrowUp';
    const delta = backwards ? -1 : 1;
    const start = this.#moveStart(key, delta, session.totalCandidates);
    const mounted = this.#options.find(
      (option) => option.offset === start && isEligible(this.#direction, option),
    );
    if (mounted !== undefined) {
      this.#selected = mounted.address;
      this.#selectedOffset = mounted.offset;
      this.#surface?.reveal(String(mounted.offset));
      clearError(this.view.error);
      updateActive(this.view.list, this.view.input, mounted.offset);
      return;
    }
    if (start < 0 || start >= session.totalCandidates) return;
    this.#cancelDemand();
    const movement = new AbortController();
    this.#movement = movement;
    const request = this.#request;
    this.#settled = false;
    this.view.input.removeAttribute('aria-activedescendant');
    this.#status.pending(request, this.#query);
    void this.#scanMove(session, start, delta, movement).catch((error: unknown) => {
      if (movement.signal.aborted || this.#movement !== movement) return;
      this.#cancelMove();
      if (!this.#live(request)) {
        this.#cancel();
        this.#status.cancel(request);
        return;
      }
      this.#failure(request, error);
    });
  }
  #placeMove(candidate: DependencyCandidate, check: () => void): void {
    this.#selected = candidate.hit.address;
    this.#selectedOffset = candidate.offset;
    this.#releaseMovePin = this.#surface?.pin(String(candidate.offset));
    this.#surface?.reveal(String(candidate.offset));
    check();
    clearError(this.view.error);
    this.#movement = undefined;
    this.#settledDemand = undefined;
    this.#mountedChanged();
  }
  #checkMove(
    session: TaskDependencySearchSession,
    request: number,
    movement: AbortController,
  ): void {
    if (
      movement.signal.aborted ||
      this.#movement !== movement ||
      !this.#live(request) ||
      session !== this.#session
    )
      throw new TaskSearchError('aborted', 'Search cancelled');
  }
  async #scanMove(
    session: TaskDependencySearchSession,
    start: number,
    delta: 1 | -1,
    movement: AbortController,
  ): Promise<void> {
    const request = this.#request;
    const check = (): void => {
      this.#checkMove(session, request, movement);
    };
    const end = delta === 1 ? session.totalCandidates - 1 : 0;
    for (const { offset, limit } of this.#unknownRanges({ start, end, direction: delta })) {
      check();
      const range = await session.readRange(offset, limit, movement.signal);
      check();
      validateDemandRange(range, session.generation, offset, limit);
      const next = allowedDependencyMove(this.#admitCandidates(range.candidates), delta);
      if (next !== undefined) {
        this.#placeMove(next, check);
        return;
      }
      await this.#scheduler?.yield(movement.signal);
    }
    check();
    this.#movement = undefined;
    this.#settledDemand = undefined;
    this.#mountedChanged();
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
  active: DependencySearchOption | undefined,
  selected: TaskSearchAddress | undefined,
): void {
  if (selected !== undefined && active === undefined) showError(view.error, changedSelection);
  else if (view.error.textContent === changedSelection) clearError(view.error);
  updateActive(view.list, view.input, active?.offset ?? -1);
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

function sameSearchAddress(left: TaskSearchAddress, right: TaskSearchAddress): boolean {
  return (
    left.epoch === right.epoch &&
    left.version === right.version &&
    left.rootId === right.rootId &&
    left.childLines.length === right.childLines.length &&
    left.childLines.every((line, index) => line === right.childLines[index])
  );
}

function retainDependencyFill(
  demand: DependencyDemand,
  candidates: DependencyCandidate[],
  included: readonly DependencyCandidate[],
  direction: 1 | -1,
): void {
  if (direction === 1) {
    candidates.push(...included);
    return;
  }
  // Backward replacements precede demanded candidates; forward surplus stays last.
  // Before this batch, demanded plus backward candidates occupy fewer than K slots.
  candidates.length = Math.min(candidates.length, demand.offsets.length + 200 - included.length);
  candidates.unshift(...included);
}

function dependencyFillDeficit(
  demand: DependencyDemand,
  candidates: readonly DependencyCandidate[],
  direction: 1 | -1,
): number {
  const total = demand.offsets.length - candidates.length;
  if (direction === 1) return total;
  const before =
    demand.offsets.filter((offset) => offset < demand.anchorOffset).length -
    candidates.filter((candidate) => candidate.offset < demand.anchorOffset).length;
  return Math.max(total, before);
}

function dependencyRuns(offsets: readonly number[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const offset of offsets) {
    const prior = runs[runs.length - 1];
    if (prior !== undefined && prior.end + 1 === offset) prior.end = offset;
    else runs.push({ start: offset, end: offset });
  }
  return runs;
}
function omittedDependency(candidate: DependencyCandidate): boolean {
  return (
    candidate.eligibility.type === 'rejected' &&
    ['self', 'duplicate', 'inverse'].includes(candidate.eligibility.reason)
  );
}

function* dependencyFillIntervals(
  runs: ReadonlyArray<{ start: number; end: number }>,
  anchor: number,
  total: number,
): Generator<{ start: number; end: number; direction: 1 | -1 }> {
  const main = runs.findIndex((run) => run.start <= anchor && run.end >= anchor);
  for (let index = main; index >= 0 && index < runs.length; index++) {
    const run = runs[index];
    if (run !== undefined)
      yield { start: run.end + 1, end: (runs[index + 1]?.start ?? total) - 1, direction: 1 };
  }
  for (let index = main; index >= 0; index--) {
    const run = runs[index];
    if (run !== undefined)
      yield { start: run.start - 1, end: (runs[index - 1]?.end ?? -1) + 1, direction: -1 };
  }
}
function validateDemandRange(
  range: DependencyCandidateRange | undefined,
  generation: number,
  start: number,
  limit: number,
): asserts range is DependencyCandidateRange {
  if (
    range?.generation !== generation ||
    range.offset !== start ||
    range.candidates.length !== limit ||
    range.candidates.some((candidate, index) => candidate.offset !== start + index)
  )
    throw new TaskSearchError('unavailable', 'Invalid dependency demand range');
}

function allowedDependencyMove(
  candidates: readonly DependencyCandidate[],
  delta: number,
): DependencyCandidate | undefined {
  const ordered = delta > 0 ? candidates : [...candidates].reverse();
  return ordered.find((candidate) => candidate.eligibility.type === 'allowed');
}
