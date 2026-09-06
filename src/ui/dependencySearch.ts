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

type DependencyPickerCommitResult =
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
  return new DependencySearchController(container, options);
}

class DependencySearchController implements DependencySearchHandle {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly directionControls: HTMLElement | undefined;
  private readonly createAffordance: HTMLElement;
  private readonly error: HTMLElement;
  private readonly ownership: { release(): void };
  private options: readonly DependencySearchOption[] = [];
  private direction: DependencyDirection;
  private activeIndex = -1;
  private busy = false;
  private closed = false;

  constructor(
    container: HTMLElement,
    private readonly callbacks: DependencySearchOptions,
  ) {
    this.ownership = (callbacks.ownership ?? noInteractionOwnership).acquire({
      blocksShortcuts: true,
    });
    const dialogLabel = callbacks.canChangeDirection
      ? 'Add dependency'
      : `Add dependency: ${dependencyDirectionLabel(callbacks.direction)}`;
    this.element = container.createDiv({
      cls: 'abyss-popover abyss-popover-anchored abyss-dep-search',
      attr: { role: 'dialog', 'aria-label': dialogLabel },
    });
    this.direction = callbacks.direction;
    this.directionControls = callbacks.canChangeDirection
      ? this.createDirectionControls()
      : undefined;
    const search = this.element.createDiv({ cls: 'abyss-dep-search-field' });
    setIcon(search.createSpan({ attr: { 'aria-hidden': 'true' } }), 'search');
    const id = `abyss-dependency-options-${nextSearchId++}`;
    this.input = search.createEl('input', {
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
    this.error = this.element.createDiv({
      cls: 'abyss-dep-search-error',
      attr: { role: 'status', hidden: '' },
    });
    this.list = this.element.createDiv({
      cls: 'abyss-dep-search-results',
      attr: { id, role: 'listbox', 'aria-label': 'Tasks' },
    });
    this.createAffordance = this.element.createDiv({
      cls: 'abyss-dep-search-create',
      attr: { hidden: '' },
    });
    this.input.addEventListener('input', () => {
      this.activeIndex = -1;
      this.clearError();
      this.refresh();
    });
    this.input.addEventListener('keydown', (event) => {
      this.onInputKey(event);
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    this.element.ownerDocument.addEventListener('focusin', this.onOutsideFocus);
    this.element.ownerDocument.addEventListener('pointerdown', this.onOutsideFocus);
    this.refresh();
    this.input.focus();
  }

  private createDirectionControls(): HTMLElement {
    const controls = this.element.createDiv({
      cls: 'abyss-dep-search-directions',
      attr: { role: 'group', 'aria-label': 'Dependency direction' },
    });
    for (const direction of ['blocked-by', 'blocks'] as const) {
      const button = controls.createEl('button', {
        cls: 'abyss-dep-search-direction',
        text: dependencyDirectionLabel(direction),
        attr: {
          type: 'button',
          'data-direction': direction,
          'aria-pressed': String(direction === this.direction),
        },
      });
      button.addEventListener('click', () => {
        if (this.busy || direction === this.direction) return;
        this.direction = direction;
        this.activeIndex = -1;
        this.clearError();
        this.updateDirectionControls();
        this.refresh();
        this.input.focus();
      });
    }
    return controls;
  }

  private updateDirectionControls(): void {
    this.directionControls
      ?.querySelectorAll<HTMLButtonElement>('[data-direction]')
      .forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset['direction'] === this.direction));
      });
  }

  private readonly onOutsideFocus = (event: Event): void => {
    if (this.element.contains(event.target as Node)) return;
    this.close(false);
  };

  refresh(): void {
    if (this.closed) return;
    this.options = this.callbacks.options(this.input.value, this.direction);
    this.activeIndex = -1;
    this.list.empty();
    this.options.forEach((option, index) => {
      this.renderOption(option, index);
    });
    if (this.options.length === 0)
      this.list.createDiv({
        cls: 'abyss-dep-search-empty',
        text: 'No matching tasks',
        attr: { role: 'status' },
      });
    this.updateCreateAffordance();
    this.updateActive();
    this.setBusy();
  }

  private updateCreateAffordance(): void {
    const text = this.input.value.trim();
    this.createAffordance.hidden = text.length === 0;
    this.createAffordance.setText(text.length === 0 ? '' : `Create “${text}” as sub-task`);
  }

  private renderOption(option: DependencySearchOption, index: number): void {
    const button = this.list.createEl('button', {
      cls: 'abyss-dep-search-option',
      attr: {
        type: 'button',
        role: 'option',
        id: `${this.list.id}-${index}`,
        'aria-selected': 'false',
        'aria-disabled': String(!this.isEligible(option)),
        tabindex: '-1',
      },
    });
    button.disabled = this.busy || !this.isEligible(option);
    button.createSpan({ cls: 'abyss-dep-search-title', text: option.title });
    button.createSpan({ cls: 'abyss-dep-search-context', text: option.context });
    if (option.disabledReason !== undefined)
      button.createSpan({ cls: 'abyss-dep-search-reason', text: option.disabledReason });
    button.addEventListener('click', () => {
      this.activeIndex = index;
      this.updateActive();
      this.submitExisting(option);
    });
  }

  private updateActive(): void {
    this.list.querySelectorAll<HTMLElement>('[role="option"]').forEach((element, index) => {
      const active = index === this.activeIndex;
      element.setAttribute('aria-selected', String(active));
      element.toggleClass('is-active', active);
    });
    const active = this.list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) this.input.removeAttribute('aria-activedescendant');
    else {
      this.input.setAttribute('aria-activedescendant', active.id);
      if (typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
    }
  }

  private onInputKey(event: KeyboardEvent): void {
    if (this.busy || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    this.submitInput();
  }

  private submitInput(): void {
    const option = this.options[this.activeIndex];
    if (this.isEligible(option)) {
      this.submitExisting(option);
      return;
    }
    const text = this.input.value.trim();
    if (text.length > 0) this.submitCreate(text);
  }

  private moveSelection(delta: number): void {
    const eligible = this.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => this.isEligible(option))
      .map(({ index }) => index);
    if (eligible.length === 0) return;
    const current = eligible.indexOf(this.activeIndex);
    let next = (current + delta + eligible.length) % eligible.length;
    if (current === -1) next = delta > 0 ? 0 : eligible.length - 1;
    this.activeIndex = eligible[next] ?? -1;
    this.updateActive();
  }

  private isEligible(option: DependencySearchOption | undefined): option is DependencySearchOption {
    return option?.directions.includes(this.direction) === true;
  }

  private submitExisting(option: DependencySearchOption): void {
    if (!this.isEligible(option)) return;
    this.submit(() => this.callbacks.selectExisting(option, this.direction));
  }

  private submitCreate(text: string): void {
    this.submit(() => this.callbacks.createNew(text, this.direction));
  }

  private submit(action: () => Promise<DependencyPickerCommitResult>): void {
    if (this.busy) return;
    this.clearError();
    this.busy = true;
    this.setBusy();
    runAsyncAction(this.commit(action), 'Could not add dependency');
  }

  private async commit(action: () => Promise<DependencyPickerCommitResult>): Promise<void> {
    try {
      const result = await action();
      if (result.type === 'committed') this.close();
      else if (result.type === 'validation-error') this.showError(result.message);
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.setBusy();
        this.input.focus();
      }
    }
  }

  private showError(message: string): void {
    this.error.setText(message);
    this.error.hidden = false;
  }

  private clearError(): void {
    this.error.empty();
    this.error.hidden = true;
  }

  private setBusy(): void {
    this.element.setAttribute('aria-busy', String(this.busy));
    this.input.readOnly = this.busy;
    this.element.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = this.busy || button.getAttribute('aria-disabled') === 'true';
    });
  }

  close(restoreFocus = true): void {
    if (this.closed) return;
    this.destroy();
    this.callbacks.onClose(restoreFocus);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.element.ownerDocument.removeEventListener('focusin', this.onOutsideFocus);
    this.element.ownerDocument.removeEventListener('pointerdown', this.onOutsideFocus);
    this.ownership.release();
    this.element.remove();
  }
}
