import { setIcon } from 'obsidian';
import type { AppState } from '../../app/AppState';
import {
  isListViewCustomized,
  isListViewOptionsCustomized,
  listSelectionToKey,
  normalizeStatusGroups,
  resolveListViewStateKey,
  statusGroupsEqual,
} from '../../app/listViewState';
import { noteNameOfPath } from '../../markdown/noteName';
import { normalizeTag } from '../../markdown/tagSyntax';
import { PRIORITY_LEVELS } from '../../priority';
import { getListViewDefaults } from '../../settings/defaults';
import { upsertTagFilter } from '../../settings/tagFilters';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { ACTIVE_STATUS_GROUPS, ALL_STATUS_GROUPS, TYPE_LABELS } from '../../status/statusConstants';
import { taskCollectionListState } from '../../task-lists/taskCollectionSettings';
import {
  defaultTaskKanbanSettings,
  normalizeTaskKanbanSettings,
  type TaskKanbanSettings,
} from '../../task-lists/taskKanbanSettings';
import {
  defaultTaskTimelineSettings,
  normalizeTaskTimelineSettings,
  type TaskTimelineSettings,
} from '../../task-lists/taskTimelineSettings';
import type { TaskStatusType } from '../../tasks';
import {
  openViewOptionsPopover,
  type ViewOptionsMultiRow,
  type ViewOptionsRow,
  type ViewOptionsSingleRow,
} from '../../ui/ViewOptionsPopover';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { taskKanbanOptionsRows } from '../task-collection/TaskKanbanOptions';
import { taskTimelineOptionsRows } from '../task-collection/TaskTimelineOptions';

interface ListViewControlsHost {
  root(): HTMLElement;
  formatDate(value: string): string;
}

export interface ListViewControlsStatePort {
  read(): ListViewState;
  write(next: ListViewState): void;
  relevance(): boolean;
  setRelevance(value: boolean): void;
  canUseRelevance(): boolean;
}

interface ListViewControlsOptions {
  readonly state: AppState;
  readonly statePort?: ListViewControlsStatePort;
  readonly settings: CalendarSettings;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly saveViewState: () => Promise<void>;
  readonly host: ListViewControlsHost;
}

export class ListViewControls {
  readonly #options: ListViewControlsOptions;
  #viewStatePopoverCleanup: ((restoreFocus?: boolean) => void) | null = null;

  constructor(options: ListViewControlsOptions) {
    this.#options = options;
  }

  closeViewStatePopover(): void {
    this.#viewStatePopoverCleanup?.();
  }

  #read(): ListViewState {
    return this.#options.statePort?.read() ?? this.#options.state.get('centerListViewState');
  }

  initializeListViewState(): void {
    if (this.#options.statePort !== undefined) return;
    const key = this.#savedStateKey();
    const viewState = this.#options.settings.listViewStates?.[key] ?? getListViewDefaults(key);
    this.#options.state.set('centerListViewState', viewState);
  }

  /** Renders filters in source order, optionally before a toolbar anchor. */
  renderPropertyChips(controls: HTMLElement, anchor?: HTMLElement): HTMLElement[] {
    const vs = this.#read();
    const chips: HTMLElement[] = [];
    for (const [i, f] of vs.filters.entries()) {
      const label = this.#filterChipLabel(f);
      const chip = controls.createSpan({ cls: 'abyss-filter-chip' });
      anchor?.before(chip);
      chip.createSpan({ cls: 'abyss-filter-chip-label', text: label });
      const x = chip.createEl('button', { cls: 'abyss-filter-chip-x', text: '×' });
      const idx = i;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#removePropertyFilter(idx);
      });
      chips.push(chip);
    }
    return chips;
  }

  #filterChipLabel(f: PropertyFilter): string {
    if (f.type === 'file') {
      return `📄 ${noteNameOfPath(f.filePath)}`;
    }
    if (f.type !== 'priority') return this.#nonPriorityFilterLabel(f);
    const level = PRIORITY_LEVELS.find((l) => l.value === f.value);
    if (level == null) return f.value;
    // D/None has no emoji and reads as "Normal" here (distinct from the
    // "None" label used in priority-picker menus).
    return level.emoji.length > 0 ? `${level.emoji} ${level.label}` : 'Normal';
  }

  #nonPriorityFilterLabel(
    filter: Exclude<PropertyFilter, { readonly type: 'file' } | { readonly type: 'priority' }>,
  ): string {
    if (filter.type === 'tag' || filter.type === 'tag-exclude') {
      const tag = normalizeTag(filter.value) ?? filter.value;
      return filter.type === 'tag-exclude' ? `−${tag}` : tag;
    }
    if (filter.type === 'time') return `⏰ ${filter.value}`;
    if (filter.type === 'status') {
      return this.#options.statusRegistry.bySymbol(filter.value)?.name ?? filter.value;
    }
    return `📅 ${this.#options.host.formatDate(filter.value)}`;
  }

  addPropertyFilter(filter: PropertyFilter): void {
    const vs = this.#read();
    if (filter.type === 'tag' || filter.type === 'tag-exclude') {
      const filters = upsertTagFilter(vs.filters, filter);
      if (JSON.stringify(filters) === JSON.stringify(vs.filters)) return;
      this.#updateViewState({ ...vs, filters });
      return;
    }
    const key = this.#propertyFilterKey(filter);
    const already = vs.filters.some((existing) => this.#propertyFilterKey(existing) === key);
    if (already) return;
    const next: ListViewState = { ...vs, filters: [...vs.filters, filter] };
    this.#updateViewState(next);
  }

  #propertyFilterKey(filter: PropertyFilter): string {
    return filter.type === 'file'
      ? `${filter.type}:${filter.filePath}`
      : `${filter.type}:${filter.value}`;
  }

  #removePropertyFilter(idx: number): void {
    const vs = this.#read();
    const next: ListViewState = { ...vs, filters: vs.filters.filter((_, i) => i !== idx) };
    this.#updateViewState(next);
  }

  #updateViewState(next: ListViewState): void {
    if (this.#options.statePort !== undefined) {
      this.#options.statePort.write(next);
      return;
    }
    this.#options.settings.listViewStates ??= {};
    this.#options.settings.listViewStates[this.#savedStateKey()] = next;
    runAsyncAction(this.#options.saveViewState(), 'Could not save list view state');
    this.#options.state.set('centerListViewState', next);
  }

  setView(view: 'list' | 'kanban' | 'timeline'): void {
    const current = this.#read();
    if ((current.view ?? 'list') === view) return;
    this.closeViewStatePopover();
    this.#updateViewState({ ...current, view });
  }

  updateKanban(patch: Partial<TaskKanbanSettings>): void {
    const current = this.#read();
    this.#updateViewState({
      ...current,
      kanban: { ...normalizeTaskKanbanSettings(current.kanban), ...patch },
    });
  }

  updateTimeline(patch: Partial<TaskTimelineSettings>): void {
    const current = this.#read();
    this.#updateViewState({
      ...current,
      timeline: { ...normalizeTaskTimelineSettings(current.timeline), ...patch },
    });
  }

  #organization(): ListViewState {
    return taskCollectionListState(this.#read());
  }

  #setSort(sortBy: ListViewState['sortBy']): void {
    if (this.#read().view === 'timeline') this.updateTimeline({ sortBy });
    else if (this.#read().view === 'kanban') this.updateKanban({ sortBy });
    else this.#updateViewState({ ...this.#read(), sortBy });
  }

  #reset(): void {
    const current = this.#read();
    if (current.view === 'timeline') {
      this.#updateViewState({ ...current, filters: [], timeline: defaultTaskTimelineSettings() });
    } else if (current.view === 'kanban') {
      this.#updateViewState({ ...current, filters: [], kanban: defaultTaskKanbanSettings() });
    } else {
      this.#options.statePort?.setRelevance(true);
      this.#updateViewState({ ...current, ...this.#defaults() });
    }
  }

  activeListKey(): string {
    return listSelectionToKey(this.#options.state.get('selectedList'));
  }

  #savedStateKey(): string {
    if (this.#options.statePort !== undefined) return 'all';
    return resolveListViewStateKey(
      this.#options.state.get('selectedList'),
      this.#options.settings.listViewStates,
      new Set(this.#options.settings.tagGroups.map((g) => g.id)),
    );
  }

  #defaults(): ListViewState {
    if (this.#options.statePort !== undefined)
      return { groupBy: 'none', sortBy: { field: 'date', dir: 'asc' }, filters: [] };
    return getListViewDefaults(this.#savedStateKey());
  }
  #customized(includeFilters: boolean): boolean {
    const view = this.#read();
    if (this.#options.statePort !== undefined)
      return (
        !this.#options.statePort.relevance() ||
        view.groupBy !== 'none' ||
        normalizeStatusGroups(view.statusGroups) !== undefined ||
        (includeFilters && view.filters.length > 0)
      );
    return includeFilters
      ? isListViewCustomized(view, this.#savedStateKey())
      : isListViewOptionsCustomized(view, this.#savedStateKey());
  }

  renderViewStateButton(container: HTMLElement): HTMLButtonElement {
    const isNonDefault = this.#customized(false);

    const btn = container.createEl('button', {
      cls: `abyss-view-state-btn${isNonDefault ? ' abyss-view-state-btn--active' : ''}`,
      attr: { 'aria-label': 'Sort & group options' },
    });
    setIcon(btn, 'arrow-up-down');
    btn.addEventListener('click', () => {
      this.#showViewStatePopover(btn);
    });
    return btn;
  }

  #layoutDefaults(): ListViewState {
    const view = this.#read().view;
    if (view === 'kanban')
      return { ...this.#defaults(), groupBy: 'none', sortBy: defaultTaskKanbanSettings().sortBy };
    if (view === 'timeline')
      return { ...this.#defaults(), groupBy: 'none', sortBy: defaultTaskTimelineSettings().sortBy };
    return this.#defaults();
  }
  #layoutRows(defaults: ListViewState): ViewOptionsRow[] {
    const common = {
      statuses: () => this.#options.statusRegistry.grouped().flatMap((group) => group.statuses),
      group: this.#groupByRowSpec(defaults),
      sort: this.#sortByRowSpec(defaults),
    };
    if (this.#read().view === 'kanban')
      return taskKanbanOptionsRows({
        ...common,
        read: () => normalizeTaskKanbanSettings(this.#read().kanban),
        update: (patch) => {
          this.updateKanban(patch);
        },
      });
    if (this.#read().view === 'timeline')
      return taskTimelineOptionsRows({
        ...common,
        read: () => normalizeTaskTimelineSettings(this.#read().timeline),
        update: (patch) => {
          this.updateTimeline(patch);
        },
      });
    return [common.group, common.sort, this.#statusGroupsRowSpec()];
  }

  #showViewStatePopover(anchor: HTMLElement): void {
    if (this.#viewStatePopoverCleanup != null) {
      this.#viewStatePopoverCleanup(true);
      return;
    }

    const defaults = this.#layoutDefaults();
    const close = openViewOptionsPopover({
      host: this.#options.host.root(),
      anchor,
      rows: this.#layoutRows(defaults),
      showReset: () => this.#customized(true),
      onReset: () => {
        this.#reset();
      },
      interactionOwnership: this.#options.interactionOwnership,
      onClose: () => {
        if (this.#viewStatePopoverCleanup === close) {
          this.#viewStatePopoverCleanup = null;
        }
      },
    });
    this.#viewStatePopoverCleanup = close;
  }

  #groupByRowSpec(defaults: ListViewState): ViewOptionsSingleRow {
    const labels: Record<string, string> = {
      none: 'None',
      date: 'Date',
      priority: 'Priority',
      tag: 'Tag',
      status: 'Status',
      'source-note': 'Source note',
      'outgoing-link': 'Outgoing link',
    };
    return {
      kind: 'single',
      icon: 'layout-list',
      label: 'Group by',
      displayValue: () => {
        const groupBy = this.#organization().groupBy;
        return labels[groupBy] ?? groupBy;
      },
      activeValue: () => this.#organization().groupBy,
      options: Object.entries(labels)
        .filter(([value]) => this.#read().view !== 'kanban' || value !== 'status')
        .map(([value, label]) => ({
          label,
          value,
          isDefault: value === defaults.groupBy,
          ...this.#noteDescription(value),
        })),
      onSelect: (value) => {
        if (this.#read().view === 'timeline') {
          this.updateTimeline({ groupBy: value as TaskTimelineSettings['groupBy'] });
        } else if (this.#read().view === 'kanban') {
          this.updateKanban({ groupBy: value as TaskKanbanSettings['groupBy'] });
        } else {
          this.#updateViewState({ ...this.#read(), groupBy: value as ListViewState['groupBy'] });
        }
      },
    };
  }

  #sortByRowSpec(defaults: ListViewState): ViewOptionsSingleRow {
    const fields: Array<ListViewState['sortBy']['field']> = [
      'date',
      'priority',
      'title',
      'tag',
      'status',
      'tracked',
      'source-note',
      'outgoing-link',
    ];
    return {
      kind: 'single',
      icon: 'arrow-up-down',
      label: 'Sort by',
      displayValue: () => {
        if (this.#options.statePort?.relevance() === true) return 'Relevance';
        const { sortBy } = this.#organization();
        return `${this.#capitalize(sortBy.field)} ${sortBy.dir === 'asc' ? '↑' : '↓'}`;
      },
      activeValue: () =>
        this.#options.statePort?.relevance() === true
          ? 'relevance'
          : this.#organization().sortBy.field,
      options: [
        ...(this.#options.statePort?.canUseRelevance() === true
          ? [{ label: 'Relevance', value: 'relevance' }]
          : []),
        ...fields.map((field) => ({
          label: () => {
            const { sortBy } = this.#organization();
            const arrow = sortBy.dir === 'asc' ? '↑' : '↓';
            return `${this.#capitalize(field)} ${sortBy.field === field ? arrow : ''}`.trim();
          },
          value: field,
          isDefault: field === defaults.sortBy.field,
          ...this.#noteDescription(field),
        })),
      ],
      onSelect: (value) => {
        if (value === 'relevance') {
          this.#options.statePort?.setRelevance(true);
          return;
        }
        this.#options.statePort?.setRelevance(false);
        const viewState = this.#organization();
        const field = value as ListViewState['sortBy']['field'];
        // Tracked time is asked for to find where the time went, so it opens on the busiest task;
        // every other field opens ascending. Choosing the field again flips it either way.
        const opening = field === 'tracked' ? 'desc' : 'asc';
        const flipped = viewState.sortBy.dir === 'asc' ? 'desc' : 'asc';
        const dir = viewState.sortBy.field === field ? flipped : opening;
        this.#setSort({ field, dir });
      },
    };
  }

  #noteDescription(value: string): { description?: string } {
    if (value === 'source-note')
      return { description: 'Source note: the file containing the task' };
    if (value === 'outgoing-link')
      return {
        description:
          'Outgoing link: wiki notes linked in the task title; a task appears in each linked note group',
      };
    return {};
  }

  #capitalize(value: string): string {
    if (value === 'source-note') return 'Source note';
    if (value === 'outgoing-link') return 'Outgoing link';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  #statusGroupsRowSpec(): ViewOptionsMultiRow {
    const apply = (groups: TaskStatusType[] | undefined): void => {
      this.#applyStatusGroupsChange(groups);
    };
    return {
      kind: 'multi',
      icon: 'eye',
      label: 'Show',
      displayValue: () => this.#statusGroupsLabel(this.#read().statusGroups),
      selected: () => this.#read().statusGroups ?? ALL_STATUS_GROUPS,
      options: ALL_STATUS_GROUPS.map((value) => ({ label: TYPE_LABELS[value], value })),
      onToggle: (rawValue) => {
        const value = rawValue as TaskStatusType;
        const viewState = this.#read();
        const current = viewState.statusGroups ?? ALL_STATUS_GROUPS;
        const next = current.includes(value)
          ? current.filter((group) => group !== value)
          : [...current, value];
        apply(next.length === 0 || next.length >= 4 ? undefined : next);
      },
      presets: [
        {
          label: 'Active',
          onSelect: () => {
            apply(ACTIVE_STATUS_GROUPS);
          },
          active: () => statusGroupsEqual(this.#read().statusGroups, ACTIVE_STATUS_GROUPS),
        },
        {
          label: 'All',
          onSelect: () => {
            apply(undefined);
          },
          active: () => normalizeStatusGroups(this.#read().statusGroups) === undefined,
        },
      ],
    };
  }

  #statusGroupsLabel(selected: TaskStatusType[] | undefined): string {
    const effective = normalizeStatusGroups(selected) ?? ALL_STATUS_GROUPS;
    if (effective.length >= 4) return 'All';
    if (statusGroupsEqual(effective, ACTIVE_STATUS_GROUPS)) return 'Active';
    return `${effective.length} selected`;
  }

  #applyStatusGroupsChange(groups: TaskStatusType[] | undefined): void {
    const viewState = this.#read();
    const withoutStatusGroups = { ...viewState };
    delete withoutStatusGroups.statusGroups;
    this.#updateViewState(
      groups === undefined ? withoutStatusGroups : { ...viewState, statusGroups: groups },
    );
  }
}
