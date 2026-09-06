import { setIcon } from 'obsidian';
import {
  sameTaskNodeRef,
  type DependencyDirection,
  type TaskDependencyEligibility,
  type TaskNodeRef,
  type TaskNodeSnapshot,
} from '../tasks';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { runAsyncAction } from './runAsyncAction';
import { dependencyDirectionLabel } from './taskDependencyPresentation';
import { taskNodeLine } from './taskSelection';

export interface DependencySearchOption {
  readonly task: TaskNodeSnapshot;
  readonly title: string;
  readonly context: string;
  readonly directions: readonly DependencyDirection[];
  readonly disabledReason?: string;
}

export function dependencySearchOptions(args: {
  readonly current: TaskNodeRef;
  readonly direction?: DependencyDirection;
  readonly query: string;
  readonly tasks: readonly TaskNodeSnapshot[];
  readonly eligibility: (blocker: TaskNodeRef, dependent: TaskNodeRef) => TaskDependencyEligibility;
}): readonly DependencySearchOption[] {
  const query = args.query.trim().toLocaleLowerCase();
  const directions: readonly DependencyDirection[] =
    args.direction === undefined ? ['blocked-by', 'blocks'] : [args.direction];
  let currentRoot = args.current;
  while (currentRoot.type === 'subtask') currentRoot = currentRoot.ref.parent;
  const filePath = currentRoot.ref.filePath;
  const titleCounts = new Map<string, number>();
  for (const task of args.tasks) {
    const key = JSON.stringify([task.root.source.filePath, task.node.title]);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  return args.tasks
    .flatMap((task): DependencySearchOption[] => {
      if (sameTaskNodeRef(task.target, args.current)) return [];
      const title = task.node.title;
      const context = dependencySearchContext(task, titleCounts);
      if (!`${title} ${context}`.toLocaleLowerCase().includes(query)) return [];
      const checks = directions.map((direction) => ({
        direction,
        result:
          direction === 'blocked-by'
            ? args.eligibility(task.target, args.current)
            : args.eligibility(args.current, task.target),
      }));
      if (
        checks.some(
          ({ result }) =>
            result.type === 'rejected' && ['self', 'duplicate', 'inverse'].includes(result.reason),
        )
      )
        return [];
      const allowed = checks
        .filter(({ result }) => result.type === 'allowed')
        .map(({ direction }) => direction);
      const rejected = checks.find(({ result }) => result.type === 'rejected')?.result;
      const disabledReason =
        allowed.length === 0 && rejected?.type === 'rejected'
          ? rejectionLabel(rejected.reason)
          : undefined;
      return [
        {
          task,
          title,
          context,
          directions: allowed,
          ...(disabledReason !== undefined && { disabledReason }),
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.task.root.source.filePath === filePath) -
        Number(left.task.root.source.filePath === filePath),
    );
}

function dependencySearchContext(
  task: TaskNodeSnapshot,
  titleCounts: ReadonlyMap<string, number>,
): string {
  const path = task.root.source.filePath;
  const repeated = (titleCounts.get(JSON.stringify([path, task.node.title])) ?? 0) > 1;
  return repeated ? `${path}:${taskNodeLine(task.root, task.node) + 1}` : path;
}

function rejectionLabel(
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
  readonly options: (
    query: string,
    direction: DependencyDirection,
  ) => readonly DependencySearchOption[];
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
}

let nextSearchId = 0;

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
}

export function mountDependencySearch(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
): DependencySearchHandle {
  const view = createSearchElements(container, callbacks);
  const { element, input, directionControls, createAffordance } = view;
  const ownerDocument = element.ownerDocument;
  const ownership = (callbacks.ownership ?? noInteractionOwnership).acquire({
    blocksShortcuts: true,
  });
  let closed = false;
  const actions = createSearchActions(view, callbacks, close, () => closed);
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
    ownerDocument.removeEventListener('focusin', outside);
    ownerDocument.removeEventListener('pointerdown', outside);
    ownership.release();
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
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  ownerDocument.addEventListener('focusin', outside);
  ownerDocument.addEventListener('pointerdown', outside);
  actions.refresh();
  callbacks.position?.(element);
  input.focus({ preventScroll: true });
  return { element, refresh: actions.refresh, close, destroy };
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
  const directionControls = callbacks.canChangeDirection
    ? element.createDiv({
        cls: 'abyss-dep-search-directions',
        attr: { role: 'group', 'aria-label': 'Dependency direction' },
      })
    : undefined;
  const search = element.createDiv({ cls: 'abyss-dep-search-field' });
  setIcon(search.createSpan({ attr: { 'aria-hidden': 'true' } }), 'search');
  const id = `abyss-dependency-options-${nextSearchId++}`;
  const input = search.createEl('input', {
    attr: {
      type: 'search',
      placeholder: 'Search tasks',
      'aria-label': 'Search tasks for dependency',
      role: 'combobox',
      'aria-controls': id,
      'aria-expanded': 'true',
      'aria-autocomplete': 'list',
    },
  });
  const error = element.createDiv({
    cls: 'abyss-dep-search-error',
    attr: { role: 'status', hidden: '' },
  });
  const list = element.createDiv({
    cls: 'abyss-dep-search-results',
    attr: { id, role: 'listbox', 'aria-label': 'Tasks' },
  });
  const createAffordance = element.createEl('button', {
    cls: 'abyss-dep-search-option abyss-dep-search-create',
    attr: { type: 'button', hidden: '' },
  });
  return { element, input, list, directionControls, createAffordance, error };
}

const changedSelection = 'Task changed. Select again or edit text.';

interface SearchActions {
  readonly refresh: () => void;
  readonly reset: () => void;
  readonly create: () => void;
  readonly choose: (direction: DependencyDirection) => void;
  readonly key: (event: KeyboardEvent) => void;
}

function createSearchActions(
  view: SearchElements,
  callbacks: DependencySearchOptions,
  close: () => void,
  isClosed: () => boolean,
): SearchActions {
  const { input, list, error, directionControls } = view;
  let options: readonly DependencySearchOption[] = [];
  let direction = callbacks.direction;
  let selected: TaskNodeRef | undefined;
  const commit = createSearchCommitter(view, close, isClosed);
  const activeIndex = (): number =>
    options.findIndex(
      (option) =>
        selected !== undefined &&
        sameTaskNodeRef(option.task.target, selected) &&
        isEligible(direction, option),
    );
  const select = (option: DependencySearchOption): void => {
    if (!isEligible(direction, option)) return;
    selected = option.task.target;
    updateActive(list, input, activeIndex());
    commit.run(() => callbacks.selectExisting(option, direction));
  };
  const refresh = (): void => {
    if (isClosed()) return;
    options = callbacks.options(input.value, direction);
    const active = activeIndex();
    if (selected !== undefined && active === -1) showError(error, changedSelection);
    else if (error.textContent === changedSelection) clearError(error);
    renderSearchOptions(view, options, direction, select);
    updateActive(list, input, active);
    setBusy(view.element, input, commit.busy());
  };
  const reset = (): void => {
    selected = undefined;
    clearError(error);
    refresh();
  };
  const create = (): void => {
    const text = input.value.trim();
    if (text.length > 0 && !commit.busy()) {
      reset();
      commit.run(() => callbacks.createNew(text, direction));
    }
  };
  const choose = (chosen: DependencyDirection): void => {
    if (commit.busy() || direction === chosen) return;
    direction = chosen;
    directionControls?.querySelectorAll<HTMLButtonElement>('[data-direction]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset['direction'] === direction));
    });
    reset();
    input.focus({ preventScroll: true });
  };
  const key = (event: KeyboardEvent): void => {
    if (commit.busy() || event.isComposing) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') {
      const option = options[activeIndex()];
      if (option !== undefined) select(option);
      else if (selected !== undefined) showError(error, changedSelection);
      else create();
      return;
    }
    const next = moveSelection(
      options,
      direction,
      activeIndex(),
      event.key === 'ArrowDown' ? 1 : -1,
    );
    if (next === undefined) return;
    selected = next.task.target;
    clearError(error);
    updateActive(list, input, activeIndex());
  };
  return { refresh, reset, create, choose, key };
}

function createSearchCommitter(
  view: SearchElements,
  close: () => void,
  isClosed: () => boolean,
): {
  busy(): boolean;
  run(action: () => Promise<DependencyPickerCommitResult>): void;
} {
  const { element, input, error } = view;
  let busy = false;
  const commit = async (action: () => Promise<DependencyPickerCommitResult>): Promise<void> => {
    try {
      const result = await action();
      if (result.type === 'committed') close();
      else if (result.type === 'validation-error') showError(error, result.message);
    } finally {
      busy = false;
      if (!isClosed()) {
        setBusy(element, input, false);
        input.focus({ preventScroll: true });
      }
    }
  };
  return {
    busy: () => busy,
    run(action: () => Promise<DependencyPickerCommitResult>): void {
      if (busy || isClosed()) return;
      clearError(error);
      busy = true;
      setBusy(element, input, true);
      runAsyncAction(commit(action), 'Could not add dependency');
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

function moveSelection(
  options: readonly DependencySearchOption[],
  direction: DependencyDirection,
  activeIndex: number,
  delta: number,
): DependencySearchOption | undefined {
  const eligible = options.flatMap((option, index) =>
    isEligible(direction, option) ? [index] : [],
  );
  if (eligible.length === 0) return undefined;
  const current = eligible.indexOf(activeIndex);
  let next = (current + delta + eligible.length) % eligible.length;
  if (current === -1) next = delta > 0 ? 0 : eligible.length - 1;
  return options[eligible[next] ?? -1];
}
