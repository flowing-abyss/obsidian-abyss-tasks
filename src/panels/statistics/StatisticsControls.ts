import { DropdownComponent, SuggestModal, type App } from 'obsidian';
import {
  type StatisticsAction,
  type StatisticsDataset,
  type StatisticsPeriod,
  type StatisticsRequest,
  type StatisticsScope,
  type StatisticsWork,
} from '../../statistics';
import { WorkBudget } from '../../statistics/statisticsWork';
export type StatisticsChoices = Pick<
  StatisticsRequest,
  'view' | 'period' | 'scope' | 'group' | 'page' | 'weekStart' | 'focusKey' | 'cohortsExpanded'
>;
const PERIODS: ReadonlyArray<readonly [StatisticsPeriod, string]> = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
  ['year', 'This year'],
  ['6m', 'Last 6 months'],
  ['12m', 'Last 12 months'],
  ['all', 'All time'],
];
export function statisticsButton(
  host: HTMLElement,
  label: string,
  action: () => void,
): HTMLButtonElement {
  const button = host.createEl('button', { text: label, attr: { type: 'button' } });
  button.addEventListener('click', action);
  return button;
}
function restoreControlFocus(host: HTMLElement, focused: Element | null): void {
  if (focused === null) return;
  for (const attribute of ['data-statistics-family', 'data-statistics-view', 'aria-label']) {
    const value = focused.getAttribute(attribute);
    if (value === null) continue;
    [...host.querySelectorAll<HTMLElement>('button, select')]
      .find((element) => element.getAttribute(attribute) === value)
      ?.focus({ preventScroll: true });
    return;
  }
}
export class StatisticsControls {
  private document_abyssPrivate: Document | undefined;
  private closing_abyssPrivate = false;
  private dataset_abyssPrivate: StatisticsDataset | undefined;
  private inventory_abyssPrivate: Array<readonly [StatisticsScope, string, string]> = [];
  private picker_abyssPrivate: ScopePicker | undefined;
  private groupPicker_abyssPrivate: GroupPicker | undefined;
  private groups_abyssPrivate: readonly FocusAction[] = [];
  private labels_abyssPrivate = new Map<string, string>();
  constructor(
    private readonly app_abyssPrivate: App,
    private readonly change_abyssPrivate: (next: Partial<StatisticsChoices>) => void,
  ) {}
  render(host: HTMLElement, choices: StatisticsChoices): void {
    this.document_abyssPrivate = host.ownerDocument;
    this.closing_abyssPrivate = false;
    const focused = host.querySelector(':focus');
    host.empty();
    if (choices.view !== 'aging' && choices.view !== 'dependencies')
      this.select_abyssPrivate(host, 'Period', PERIODS, {
        value: choices.period,
        change: (value) => {
          const period = PERIODS.find(([key]) => key === value)?.[0];
          if (period !== undefined)
            this.change_abyssPrivate({ period, page: undefined, weekStart: undefined });
        },
      });
    restoreControlFocus(host, focused);
  }
  private select_abyssPrivate(
    host: HTMLElement,
    label: string,
    options: ReadonlyArray<readonly [string, string]>,
    selected: { value: string; change: (value: string) => void },
  ): void {
    const wrapper = host.createEl('label');
    const dropdown = new DropdownComponent(wrapper);
    dropdown.selectEl.setAttribute('aria-label', label);
    for (const [key, title] of options) dropdown.addOption(key, title);
    dropdown.setValue(selected.value).onChange(selected.change);
  }
  async prepare(dataset: StatisticsDataset, work: StatisticsWork): Promise<void> {
    if (this.dataset_abyssPrivate === dataset) return;
    const budget = new WorkBudget(work);
    const scopes: Array<readonly [StatisticsScope, string, string]> = [
      [{ type: 'all' }, 'Entire vault', 'entire vault'],
    ];
    await this.projects_abyssPrivate(scopes, dataset, budget);
    const tags = new Set<string>();
    for (const task of dataset.tasks) {
      for (const tag of task.tags) {
        tags.add(tag);
        await budget.step();
      }
      await budget.step();
    }
    for (const tag of tags) {
      scopes.push([{ type: 'tag', tag }, `#${tag}`, tag.toLowerCase()]);
      await budget.step();
    }
    for (const priority of ['A', 'B', 'C', 'D', 'E', 'F'] as const)
      scopes.push([
        { type: 'priority', priority },
        `Priority ${priority}`,
        `priority ${priority.toLowerCase()}`,
      ]);
    scopes.push(
      [{ type: 'unassigned' }, 'No project', 'no project'],
      [{ type: 'archive' }, 'Unknown project · archive', 'unknown project archive'],
    );
    const labels = new Map<string, string>();
    for (const [scope, label] of scopes) {
      labels.set(JSON.stringify(scope), label);
      await budget.step();
    }
    budget.check();
    this.labels_abyssPrivate = labels;
    this.dataset_abyssPrivate = dataset;
    this.inventory_abyssPrivate = scopes;
    this.picker_abyssPrivate?.updateInventory(scopes);
  }
  private async projects_abyssPrivate(
    scopes: ScopeOption[],
    dataset: StatisticsDataset,
    budget: WorkBudget,
  ): Promise<void> {
    const names = new Map<string, number>();
    for (const project of dataset.projects) {
      names.set(project.name, (names.get(project.name) ?? 0) + 1);
      await budget.step();
    }
    for (const project of dataset.projects) {
      const label =
        (names.get(project.name) ?? 0) > 1 ? `${project.name} · ${project.path}` : project.name;
      scopes.push([
        { type: 'project', path: project.path },
        label,
        `${project.name} ${project.path}`.toLowerCase(),
      ]);
      await budget.step();
    }
  }
  scopeLabel(scope: StatisticsScope): string {
    const label = this.labels_abyssPrivate.get(JSON.stringify(scope));
    if (label !== undefined) return label;
    switch (scope.type) {
      case 'project':
        return `${scope.path} · unavailable`;
      case 'tag':
        return `#${scope.tag} · no matches`;
      case 'priority':
        return `Priority ${scope.priority}`;
      case 'unassigned':
        return 'No project';
      case 'archive':
        return 'Unknown project · archive';
      case 'all':
        return 'Entire vault';
    }
  }
  openScope(_scope: StatisticsScope): void {
    const previous = this.picker_abyssPrivate;
    this.picker_abyssPrivate = undefined;
    previous?.close();
    // The caller establishes a visible return target before the native modal captures focus.
    const returnTarget = this.document_abyssPrivate?.activeElement as HTMLElement | null;
    const sidebar = returnTarget?.closest('.abyss-left');
    const restore = (): void => {
      const current = sidebar?.querySelector<HTMLElement>('[aria-label="Scope"]') ?? returnTarget;
      if (!this.closing_abyssPrivate && current?.isConnected === true)
        current.focus({ preventScroll: true });
    };
    const picker: ScopePicker = new ScopePicker(
      this.app_abyssPrivate,
      this.inventory_abyssPrivate,
      (scope) => {
        this.change_abyssPrivate({ scope, page: undefined, focusKey: undefined });
      },
      () => {
        if (this.picker_abyssPrivate !== picker) return;
        this.picker_abyssPrivate = undefined;
        restore();
      },
    );
    this.picker_abyssPrivate = picker;
    picker.open();
  }
  prepareGroups(groups: readonly FocusAction[]): void {
    this.groups_abyssPrivate = groups;
    this.groupPicker_abyssPrivate?.updateInventory(groups);
  }
  openGroup(): void {
    this.groupPicker_abyssPrivate?.close();
    const target = this.document_abyssPrivate?.activeElement as HTMLElement | null;
    const root = target?.closest('.abyss-statistics');
    const picker: GroupPicker = new GroupPicker(
      this.app_abyssPrivate,
      this.groups_abyssPrivate,
      (action) => {
        this.change_abyssPrivate({ focusKey: action.focusKey });
      },
      () => {
        if (this.groupPicker_abyssPrivate !== picker) return;
        this.groupPicker_abyssPrivate = undefined;
        const current = root?.querySelector<HTMLElement>('[aria-label="Find group"]') ?? target;
        if (!this.closing_abyssPrivate && current?.isConnected === true)
          current.focus({ preventScroll: true });
      },
    );
    this.groupPicker_abyssPrivate = picker;
    picker.open();
  }
  destroy(): void {
    this.closing_abyssPrivate = true;
    this.picker_abyssPrivate?.close();
    this.picker_abyssPrivate = undefined;
    this.groupPicker_abyssPrivate?.close();
    this.groupPicker_abyssPrivate = undefined;
    this.groups_abyssPrivate = [];
  }
}
type ScopeOption = readonly [StatisticsScope, string, string];
/** Native searchable picker bounds suggestion DOM while every exact path/tag stays searchable. */
class ScopePicker extends SuggestModal<ScopeOption> {
  constructor(
    app: App,
    private inventory_abyssPrivate: readonly ScopeOption[],
    private readonly choose_abyssPrivate: (scope: StatisticsScope) => void,
    private readonly closed_abyssPrivate: () => void,
  ) {
    super(app);
    this.limit = 50;
    this.setPlaceholder('Search scope by project name, path, tag or priority');
  }
  updateInventory(inventory: readonly ScopeOption[]): void {
    this.inventory_abyssPrivate = inventory;
    this.inputEl.trigger('input');
  }
  override getSuggestions(query: string): ScopeOption[] {
    const normalized = query.trim().toLowerCase(),
      result: ScopeOption[] = [];
    for (const option of this.inventory_abyssPrivate) {
      const exact = exactScopeText(option[0]);
      if (exact?.toLowerCase() === normalized) {
        result.unshift(option);
        if (result.length > this.limit) result.pop();
      } else if (result.length < this.limit && option[2].includes(normalized)) result.push(option);
    }
    return result;
  }
  override renderSuggestion(option: ScopeOption, element: HTMLElement): void {
    element.setText(option[1]);
  }
  override onClose(): void {
    super.onClose();
    this.closed_abyssPrivate();
  }
  override onChooseSuggestion(option: ScopeOption): void {
    this.choose_abyssPrivate(option[0]);
  }
}

function exactScopeText(scope: StatisticsScope): string | undefined {
  if (scope.type === 'project') return scope.path;
  if (scope.type === 'tag') return scope.tag;
  return undefined;
}

type FocusAction = Extract<StatisticsAction, { type: 'focus' }>;
class GroupPicker extends SuggestModal<FocusAction> {
  constructor(
    app: App,
    private groups_abyssPrivate: readonly FocusAction[],
    private readonly choose_abyssPrivate: (action: FocusAction) => void,
    private readonly closed_abyssPrivate: () => void,
  ) {
    super(app);
    this.limit = 50;
    this.setPlaceholder('Find group by name, path, tag or priority');
  }
  updateInventory(groups: readonly FocusAction[]): void {
    this.groups_abyssPrivate = groups;
    this.inputEl.trigger('input');
  }
  override getSuggestions(query: string): FocusAction[] {
    const normalized = query.trim().toLowerCase(),
      result: FocusAction[] = [];
    for (const group of this.groups_abyssPrivate) {
      const key = group.focusKey ?? '';
      const identity = key.slice(key.indexOf(':') + 1).toLowerCase();
      if (identity === normalized) {
        result.unshift(group);
        if (result.length > this.limit) result.pop();
      } else if (
        result.length < this.limit &&
        `${group.label} ${identity}`.toLowerCase().includes(normalized)
      )
        result.push(group);
    }
    return result;
  }
  override renderSuggestion(action: FocusAction, element: HTMLElement): void {
    element.setText(action.label);
  }
  override onChooseSuggestion(action: FocusAction): void {
    this.choose_abyssPrivate(action);
  }
  override onClose(): void {
    super.onClose();
    this.closed_abyssPrivate();
  }
}
