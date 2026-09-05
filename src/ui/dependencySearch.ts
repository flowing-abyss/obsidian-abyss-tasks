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

interface DependencySearchOptions {
  readonly options: (query: string) => readonly DependencySearchOption[];
  readonly select: (
    option: DependencySearchOption,
    direction: DependencyDirection,
  ) => Promise<boolean>;
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
  private readonly actions: HTMLElement;
  private readonly ownership: { release(): void };
  private options: readonly DependencySearchOption[] = [];
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
    this.element = container.createDiv({
      cls: 'abyss-popover abyss-popover-anchored abyss-dependency-search',
      attr: { role: 'dialog', 'aria-label': 'Add dependency' },
    });
    const search = this.element.createDiv({ cls: 'abyss-dependency-search-field' });
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
    this.list = this.element.createDiv({
      cls: 'abyss-dependency-search-results',
      attr: { id, role: 'listbox', 'aria-label': 'Tasks' },
    });
    this.actions = this.element.createDiv({
      cls: 'abyss-dependency-search-directions',
      attr: { role: 'group', 'aria-label': 'Dependency direction', hidden: '' },
    });
    this.input.addEventListener('input', () => {
      this.activeIndex = -1;
      this.actions.empty();
      this.actions.hidden = true;
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

  private readonly onOutsideFocus = (event: Event): void => {
    if (this.element.contains(event.target as Node)) return;
    this.close(false);
  };

  refresh(): void {
    if (this.closed) return;
    const choosingDirection = this.actions.contains(this.element.ownerDocument.activeElement);
    this.actions.empty();
    this.actions.hidden = true;
    this.options = this.callbacks.options(this.input.value);
    this.activeIndex = Math.min(this.activeIndex, this.options.length - 1);
    this.list.empty();
    this.options.forEach((option, index) => {
      this.renderOption(option, index);
    });
    if (this.options.length === 0)
      this.list.createDiv({
        cls: 'abyss-dependency-search-empty',
        text: 'No matching tasks',
        attr: { role: 'status' },
      });
    this.updateActive();
    if (choosingDirection) this.input.focus();
  }

  private renderOption(option: DependencySearchOption, index: number): void {
    const button = this.list.createEl('button', {
      cls: 'abyss-dependency-search-option',
      attr: {
        type: 'button',
        role: 'option',
        id: `${this.list.id}-${index}`,
        'aria-selected': 'false',
        'aria-disabled': String(option.directions.length === 0),
        tabindex: '-1',
      },
    });
    button.disabled = this.busy || option.directions.length === 0;
    button.createSpan({ cls: 'abyss-dependency-search-title', text: option.title });
    button.createSpan({ cls: 'abyss-dependency-search-context', text: option.context });
    if (option.disabledReason !== undefined)
      button.createSpan({ cls: 'abyss-dependency-search-reason', text: option.disabledReason });
    button.addEventListener('click', () => {
      this.activeIndex = index;
      this.updateActive();
      this.choose(option);
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
    if (this.busy) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const option =
        this.options[this.activeIndex] ??
        this.options.find((candidate) => candidate.directions.length > 0);
      if (option !== undefined) this.choose(option);
    }
  }

  private moveSelection(delta: number): void {
    let index = this.activeIndex + delta;
    while (
      index >= 0 &&
      index < this.options.length &&
      this.options[index]?.directions.length === 0
    )
      index += delta;
    if (index >= 0 && index < this.options.length) this.activeIndex = index;
    this.updateActive();
  }

  private choose(option: DependencySearchOption): void {
    if (this.busy || option.directions.length === 0) return;
    this.actions.empty();
    const first = option.directions[0];
    if (option.directions.length === 1 && first !== undefined) {
      this.submit(option, first);
      return;
    }
    this.actions.hidden = false;
    for (const direction of option.directions) {
      const button = this.actions.createEl('button', {
        text: dependencyDirectionLabel(direction),
        attr: {
          type: 'button',
          'data-direction': direction,
          'aria-label': `${dependencyDirectionLabel(direction)} ${option.title}`,
        },
      });
      button.addEventListener('click', () => {
        this.submit(option, direction);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          button.click();
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          (button.nextElementSibling as HTMLButtonElement | null)?.focus();
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          (button.previousElementSibling as HTMLButtonElement | null)?.focus();
        }
      });
    }
    this.actions.querySelector('button')?.focus();
  }

  private submit(option: DependencySearchOption, direction: DependencyDirection): void {
    if (this.busy) return;
    runAsyncAction(this.commit(option, direction), 'Could not add dependency');
  }

  private async commit(
    option: DependencySearchOption,
    direction: DependencyDirection,
  ): Promise<void> {
    const invoking = this.element.ownerDocument.activeElement as HTMLElement | null;
    this.busy = true;
    this.setBusy();
    try {
      if (await this.callbacks.select(option, direction)) this.close();
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.setBusy();
        if (invoking?.isConnected === true) invoking.focus();
        else this.input.focus();
      }
    }
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
