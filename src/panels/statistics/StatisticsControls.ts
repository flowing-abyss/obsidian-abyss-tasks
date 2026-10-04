import { DropdownComponent, SuggestModal, type App } from 'obsidian';
import {
  STATISTICS_VIEWS,
  type StatisticsDataset,
  type StatisticsPeriod,
  type StatisticsRequest,
  type StatisticsScope,
  type StatisticsViewId,
  type StatisticsWork,
} from '../../statistics';
import { WorkBudget } from '../../statistics/statisticsWork';
export type StatisticsChoices = Pick<
  StatisticsRequest,
  'view' | 'period' | 'scope' | 'group' | 'page' | 'weekStart' | 'focusKey'
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
  private readonly families_abyssPrivate = new Map<string, StatisticsViewId>();
  private dataset_abyssPrivate: StatisticsDataset | undefined;
  private inventory_abyssPrivate: Array<readonly [StatisticsScope, string, string]> = [];
  private picker_abyssPrivate: ScopePicker | undefined;
  private scope_abyssPrivate: HTMLButtonElement | undefined;
  private labels_abyssPrivate = new Map<string, string>();
  constructor(
    private readonly app_abyssPrivate: App,
    private readonly change_abyssPrivate: (next: Partial<StatisticsChoices>) => void,
  ) {}
  render(host: HTMLElement, choices: StatisticsChoices, dataset?: StatisticsDataset): void {
    const focused = host.querySelector(':focus');
    host.empty();
    const bar = host.createDiv({ cls: 'abyss-statistics-controls' });
    this.scopes_abyssPrivate(bar, choices.scope, dataset);
    if (choices.view === 'aging' || choices.view === 'dependencies')
      bar.createSpan({ text: 'Current state' });
    else
      this.select_abyssPrivate(bar, 'Period', PERIODS, {
        value: choices.period,
        change: (value) => {
          const period = PERIODS.find(([key]) => key === value)?.[0];
          if (period !== undefined)
            this.change_abyssPrivate({ period, page: undefined, weekStart: undefined });
        },
      });
    const family = STATISTICS_VIEWS.find((view) => view.id === choices.view)?.family ?? 'Flow';
    this.families_abyssPrivate.set(family, choices.view);
    const tabs = host.createDiv({
      cls: 'abyss-statistics-tabs',
      attr: { 'aria-label': 'Statistics analysis' },
    });
    for (const name of ['Flow', 'Time', 'Projects'] as const) {
      const button = statisticsButton(tabs, name, () => {
        this.change_abyssPrivate({
          view:
            this.families_abyssPrivate.get(name) ??
            STATISTICS_VIEWS.find((view) => view.family === name)?.id ??
            'rhythm',
          page: undefined,
          focusKey: undefined,
        });
      });
      button.dataset['statisticsFamily'] = name;
      button.setAttribute('aria-pressed', String(name === family));
    }
    const subnav = host.createDiv({
      cls: 'abyss-statistics-tabs',
      attr: { 'aria-label': `${family} views` },
    });
    for (const view of STATISTICS_VIEWS.filter((view) => view.family === family)) {
      const button = statisticsButton(subnav, view.title, () => {
        this.change_abyssPrivate({ view: view.id, page: undefined, focusKey: undefined });
      });
      button.dataset['statisticsView'] = view.id;
      button.setAttribute('aria-pressed', String(view.id === choices.view));
    }
    if (choices.view === 'allocation')
      this.select_abyssPrivate(
        bar,
        'Group by',
        [
          ['project', 'Project'],
          ['tag', 'Tags'],
          ['priority', 'Priority'],
        ],
        {
          value: choices.group,
          change: (value) => {
            if (value === 'project' || value === 'tag' || value === 'priority')
              this.change_abyssPrivate({ group: value, page: undefined });
          },
        },
      );
    restoreControlFocus(host, focused);
  }
  private select_abyssPrivate(
    host: HTMLElement,
    label: string,
    options: ReadonlyArray<readonly [string, string]>,
    selected: { value: string; change: (value: string) => void },
  ): void {
    const wrapper = host.createEl('label', { text: label });
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
  private focus_abyssPrivate(): void {
    if (this.scope_abyssPrivate?.isConnected === true) this.scope_abyssPrivate.focus();
  }
  destroy(): void {
    this.scope_abyssPrivate = undefined;
    this.picker_abyssPrivate?.close();
    this.picker_abyssPrivate = undefined;
  }
  private scopes_abyssPrivate(
    host: HTMLElement,
    current: StatisticsScope,
    _dataset?: StatisticsDataset,
  ): void {
    const key = JSON.stringify(current);
    const title =
      this.labels_abyssPrivate.get(key) ??
      (current.type === 'project' ? `${current.path} · unavailable` : 'Entire vault');
    const button = statisticsButton(host, `Scope · ${title}`, () => {
      this.picker_abyssPrivate?.close();
      this.picker_abyssPrivate = new ScopePicker(
        this.app_abyssPrivate,
        this.inventory_abyssPrivate,
        (scope) => {
          this.change_abyssPrivate({ scope, page: undefined, focusKey: undefined });
          this.focus_abyssPrivate();
        },
        () => {
          this.focus_abyssPrivate();
        },
      );
      this.picker_abyssPrivate.open();
    });
    this.scope_abyssPrivate = button;
    button.setAttribute('aria-label', 'Scope');
    button.setAttribute('aria-haspopup', 'dialog');
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
