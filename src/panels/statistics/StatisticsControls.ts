import { DropdownComponent, SuggestModal, type App } from 'obsidian';
import {
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
  private labels_abyssPrivate = new Map<string, string>();
  constructor(
    private readonly app_abyssPrivate: App,
    private readonly change_abyssPrivate: (next: Partial<StatisticsChoices>) => void,
  ) {}
  render(host: HTMLElement, choices: StatisticsChoices, groupHost = host): void {
    this.document_abyssPrivate = host.ownerDocument;
    this.closing_abyssPrivate = false;
    const focused = host.querySelector(':focus');
    const groupFocused = groupHost === host ? null : groupHost.querySelector(':focus');
    host.empty();
    if (groupHost !== host) groupHost.empty();
    if (choices.view !== 'aging' && choices.view !== 'dependencies')
      this.select_abyssPrivate(host, 'Period', PERIODS, {
        value: choices.period,
        change: (value) => {
          const period = PERIODS.find(([key]) => key === value)?.[0];
          if (period !== undefined)
            this.change_abyssPrivate({ period, page: undefined, weekStart: undefined });
        },
      });
    if (choices.view === 'allocation') {
      const group = groupHost.createDiv({
        cls: 'abyss-cal-view-switcher abyss-statistics-group',
        attr: { role: 'group', 'aria-label': 'Group by' },
      });
      for (const [key, label] of [
        ['project', 'Project'],
        ['tag', 'Tags'],
        ['priority', 'Priority'],
      ] as const) {
        const button = statisticsButton(group, label, () => {
          this.change_abyssPrivate({ group: key, page: undefined });
        });
        button.className = 'abyss-cal-view-btn';
        button.classList.toggle('is-active', choices.group === key);
        button.setAttribute('aria-label', `Group by ${label}`);
        button.setAttribute('aria-pressed', String(choices.group === key));
      }
    }
    restoreControlFocus(host, focused);
    if (groupHost !== host) restoreControlFocus(groupHost, groupFocused);
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
    return (
      this.labels_abyssPrivate.get(JSON.stringify(scope)) ??
      (scope.type === 'project' ? `${scope.path} · unavailable` : 'Entire vault')
    );
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
  destroy(): void {
    this.closing_abyssPrivate = true;
    this.picker_abyssPrivate?.close();
    this.picker_abyssPrivate = undefined;
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
