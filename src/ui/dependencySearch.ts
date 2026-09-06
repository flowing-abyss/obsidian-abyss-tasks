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

export function mountDependencySearch(
  container: HTMLElement,
  options: DependencySearchOptions,
): DependencySearchHandle {
  return createDependencySearch(container, options);
}

function updateDirectionControls(
  directionControls: HTMLElement | undefined,
  direction: DependencyDirection,
): void {
  directionControls?.querySelectorAll<HTMLButtonElement>('[data-direction]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset['direction'] === direction));
  });
}

function updateCreateAffordance(input: HTMLInputElement, createAffordance: HTMLElement): void {
  const text = input.value.trim();
  createAffordance.hidden = text.length === 0;
  createAffordance.setText(text.length === 0 ? '' : `Create “${text}” as sub-task`);
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

interface SearchState {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  readonly directionControls: HTMLElement | undefined;
  readonly createAffordance: HTMLElement;
  readonly error: HTMLElement;
  readonly ownership: { release(): void };
  readonly callbacks: DependencySearchOptions;
  readonly close: (restoreFocus?: boolean) => void;
  options: readonly DependencySearchOption[];
  direction: DependencyDirection;
  activeIndex: number;
  busy: boolean;
  closed: boolean;
}

function createDependencySearch(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
): DependencySearchHandle {
  const state = createSearchState(container, callbacks, close);
  const { element, input } = state;
  const ownerDocument = element.ownerDocument;
  const outside = (event: Event): void => {
    if (!element.contains(event.target as Node)) close(false);
  };
  function close(restoreFocus = true): void {
    if (state.closed) return;
    destroy();
    callbacks.onClose(restoreFocus);
  }
  function destroy(): void {
    if (state.closed) return;
    state.closed = true;
    ownerDocument.removeEventListener('focusin', outside);
    ownerDocument.removeEventListener('pointerdown', outside);
    state.ownership.release();
    element.remove();
  }
  initializeDirectionControls(state);
  input.addEventListener('input', () => {
    state.activeIndex = -1;
    clearError(state.error);
    refreshSearch(state);
  });
  input.addEventListener('keydown', (event) => {
    onInputKey(state, event);
  });
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  ownerDocument.addEventListener('focusin', outside);
  ownerDocument.addEventListener('pointerdown', outside);
  refreshSearch(state);
  callbacks.position?.(element);
  input.focus({ preventScroll: true });
  return {
    element,
    refresh: () => {
      refreshSearch(state);
    },
    close,
    destroy,
  };
}

function createSearchState(
  container: HTMLElement,
  callbacks: DependencySearchOptions,
  close: (restoreFocus?: boolean) => void,
): SearchState {
  const ownership = (callbacks.ownership ?? noInteractionOwnership).acquire({
    blocksShortcuts: true,
  });
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
  const createAffordance = element.createDiv({
    cls: 'abyss-dep-search-create',
    attr: { hidden: '' },
  });
  return {
    element,
    input,
    list,
    directionControls,
    createAffordance,
    error,
    ownership,
    callbacks,
    close,
    options: [],
    direction: callbacks.direction,
    activeIndex: -1,
    busy: false,
    closed: false,
  };
}

function initializeDirectionControls(state: SearchState): void {
  const controls = state.directionControls;
  if (controls === undefined) return;
  for (const direction of ['blocked-by', 'blocks'] as const) {
    const button = controls.createEl('button', {
      cls: 'abyss-dep-search-direction',
      text: dependencyDirectionLabel(direction),
      attr: {
        type: 'button',
        'data-direction': direction,
        'aria-pressed': String(direction === state.direction),
      },
    });
    button.addEventListener('click', () => {
      if (state.busy || direction === state.direction) return;
      state.direction = direction;
      state.activeIndex = -1;
      clearError(state.error);
      updateDirectionControls(state.directionControls, state.direction);
      refreshSearch(state);
      state.input.focus({ preventScroll: true });
    });
  }
}

function refreshSearch(state: SearchState): void {
  if (state.closed) return;
  state.options = state.callbacks.options(state.input.value, state.direction);
  state.activeIndex = -1;
  state.list.empty();
  state.options.forEach((option, index) => {
    renderSearchOption(state, option, index);
  });
  if (state.options.length === 0)
    state.list.createDiv({
      cls: 'abyss-dep-search-empty',
      text: 'No matching tasks',
      attr: { role: 'status' },
    });
  updateCreateAffordance(state.input, state.createAffordance);
  updateActive(state.list, state.input, state.activeIndex);
  setBusy(state.element, state.input, state.busy);
}

function renderSearchOption(
  state: SearchState,
  option: DependencySearchOption,
  index: number,
): void {
  const button = state.list.createEl('button', {
    cls: 'abyss-dep-search-option',
    attr: {
      type: 'button',
      role: 'option',
      id: `${state.list.id}-${index}`,
      'aria-selected': 'false',
      'aria-disabled': String(!isEligible(state.direction, option)),
      tabindex: '-1',
    },
  });
  button.disabled = state.busy || !isEligible(state.direction, option);
  button.createSpan({ cls: 'abyss-dep-search-title', text: option.title });
  button.createSpan({ cls: 'abyss-dep-search-context', text: option.context });
  if (option.disabledReason !== undefined)
    button.createSpan({ cls: 'abyss-dep-search-reason', text: option.disabledReason });
  button.addEventListener('click', () => {
    state.activeIndex = index;
    updateActive(state.list, state.input, state.activeIndex);
    submitExisting(state, option);
  });
}

function onInputKey(state: SearchState, event: KeyboardEvent): void {
  if (state.busy || event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    moveSelection(state, event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  submitInput(state);
}

function submitInput(state: SearchState): void {
  const option = state.options[state.activeIndex];
  if (isEligible(state.direction, option)) {
    submitExisting(state, option);
    return;
  }
  const text = state.input.value.trim();
  if (text.length > 0) submitCreate(state, text);
}

function moveSelection(state: SearchState, delta: number): void {
  const eligible = state.options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => isEligible(state.direction, option))
    .map(({ index }) => index);
  if (eligible.length === 0) return;
  const current = eligible.indexOf(state.activeIndex);
  let next = (current + delta + eligible.length) % eligible.length;
  if (current === -1) next = delta > 0 ? 0 : eligible.length - 1;
  state.activeIndex = eligible[next] ?? -1;
  updateActive(state.list, state.input, state.activeIndex);
}

function submitExisting(state: SearchState, option: DependencySearchOption): void {
  if (!isEligible(state.direction, option)) return;
  submit(state, () => state.callbacks.selectExisting(option, state.direction));
}

function submitCreate(state: SearchState, text: string): void {
  submit(state, () => state.callbacks.createNew(text, state.direction));
}

function submit(state: SearchState, action: () => Promise<DependencyPickerCommitResult>): void {
  if (state.busy) return;
  clearError(state.error);
  state.busy = true;
  setBusy(state.element, state.input, state.busy);
  runAsyncAction(commitSearch(state, action), 'Could not add dependency');
}

async function commitSearch(
  state: SearchState,
  action: () => Promise<DependencyPickerCommitResult>,
): Promise<void> {
  try {
    const result = await action();
    if (result.type === 'committed') state.close();
    else if (result.type === 'validation-error') showError(state.error, result.message);
  } finally {
    state.busy = false;
    if (!state.closed) {
      setBusy(state.element, state.input, state.busy);
      state.input.focus({ preventScroll: true });
    }
  }
}
