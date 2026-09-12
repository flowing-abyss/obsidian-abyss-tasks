import { Menu, setIcon } from 'obsidian';
import type {
  ProjectColumn,
  ProjectDateDisplay,
  ProjectFieldCatalogItem,
  ProjectTableSettings,
} from '../../projects/projectFields';
import type {
  ProjectKanbanSettings,
  ProjectOverviewMode,
} from '../../projects/projectKanbanSettings';
import { buildDefaultProjectTableSettings } from '../../projects/projectTableSettings';
import type { StatusGroup } from '../../projects/status';
import {
  moveProjectColumn,
  setProjectColumnDateDisplay,
  setProjectColumnVisibility,
} from '../../settings/projectTableSettings';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import {
  openViewOptionsPopover,
  type ViewOption,
  type ViewOptionAction,
  type ViewOptionsRow,
} from '../../ui/ViewOptionsPopover';
import { configureProjectDateDisplayMenu, projectDateDisplayLabel } from './projectColumnMenu';
import { isProjectKanbanCustomized, projectKanbanOptionsRows } from './ProjectKanbanOptions';

export interface ProjectsTableToolbarOptions {
  readonly host: HTMLElement;
  readonly settings: () => ProjectTableSettings | ProjectKanbanSettings;
  readonly tableSettings: () => ProjectTableSettings;
  readonly mode: () => ProjectOverviewMode;
  readonly fields: () => readonly ProjectFieldCatalogItem[];
  readonly onSearch: (query: string) => void;
  readonly onStatusToggle: (key: string) => void;
  readonly onGroupBy: (field: string) => void;
  readonly onSortBy: (field: string) => void;
  readonly onReset: () => void;
  readonly onOverviewMode: (mode: ProjectOverviewMode) => void;
  readonly onViewOptionChange: (mutation: () => void) => Promise<boolean>;
}

function fieldLabel(
  fields: readonly ProjectFieldCatalogItem[],
  settings: ProjectTableSettings,
  id: string,
): string {
  if (id === 'none') return 'None';
  return (
    settings.columns.find((column) => column.id === id)?.label ??
    fields.find((field) => field.id === id)?.label ??
    id
  );
}

function isTableSettings(
  settings: ProjectTableSettings | ProjectKanbanSettings,
): settings is ProjectTableSettings {
  return 'columns' in settings;
}

function isCustomized(settings: ProjectTableSettings): boolean {
  const defaults = buildDefaultProjectTableSettings();
  return (
    settings.groupBy !== defaults.groupBy ||
    settings.sortBy.field !== defaults.sortBy.field ||
    settings.sortBy.dir !== defaults.sortBy.dir ||
    settings.showDescription !== defaults.showDescription ||
    settings.hiddenStatuses.length > 0
  );
}

export class ProjectsTableToolbar {
  readonly searchInput: HTMLInputElement;
  private readonly badges_abyssPrivate: HTMLElement;
  private readonly viewButton_abyssPrivate: HTMLButtonElement;
  private readonly modeButtons_abyssPrivate = new Map<ProjectOverviewMode, HTMLButtonElement>();
  private readonly statusButtons_abyssPrivate = new Map<string, HTMLButtonElement>();
  private popoverCleanup_abyssPrivate: (() => void) | undefined;

  constructor(private readonly options_abyssPrivate: ProjectsTableToolbarOptions) {
    const toolbar = options_abyssPrivate.host.createDiv({
      cls: 'abyss-projects-toolbar abyss-center-header',
    });
    toolbar.createEl('h2', { cls: 'abyss-projects-title abyss-center-title', text: 'Projects' });
    toolbar.createSpan({ cls: 'abyss-projects-toolbar-spacer' });
    this.badges_abyssPrivate = toolbar.createDiv({
      cls: 'abyss-project-status-filters',
      attr: { role: 'group', 'aria-label': 'Project status filters' },
    });
    const controls = toolbar.createDiv({
      cls: 'abyss-center-controls abyss-project-table-controls',
    });
    this.viewButton_abyssPrivate = controls.createEl('button', {
      cls: 'abyss-view-state-btn',
      attr: { type: 'button', 'aria-label': 'Sort & group options' },
    });
    setIcon(this.viewButton_abyssPrivate, 'arrow-up-down');
    this.viewButton_abyssPrivate.addEventListener('click', () => {
      this.togglePopover_abyssPrivate();
    });
    for (const [mode, label, icon] of [
      ['table', 'Table view', 'table-2'],
      ['kanban', 'Kanban view', 'columns-3'],
    ] as const) {
      const button = controls.createEl('button', {
        cls: `abyss-project-overview-mode abyss-project-overview-mode--${mode}`,
        attr: { type: 'button', 'aria-label': label, 'aria-pressed': 'false' },
      });
      setIcon(button, icon);
      button.addEventListener('click', () => {
        options_abyssPrivate.onOverviewMode(mode);
      });
      this.modeButtons_abyssPrivate.set(mode, button);
    }
    this.searchInput = controls.createEl('input', {
      cls: 'abyss-center-search',
      attr: { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter projects' },
    });
    this.searchInput.addEventListener('input', () => {
      options_abyssPrivate.onSearch(this.searchInput.value);
    });
    this.sync();
  }

  update(statuses: readonly StatusGroup[]): void {
    const hidden = new Set(this.options_abyssPrivate.settings().hiddenStatuses);
    const retained = new Set<string>();
    const desiredButtons: HTMLButtonElement[] = [];
    const focused = this.badges_abyssPrivate.ownerDocument.activeElement;
    for (const status of statuses) {
      retained.add(status.key);
      const button = this.statusButton_abyssPrivate(status.key);
      this.patchStatusButton_abyssPrivate(button, status, hidden.has(status.key));
      desiredButtons.push(button);
    }
    this.removeMissingStatusButtons_abyssPrivate(retained);
    this.reconcileStatusButtonOrder_abyssPrivate(desiredButtons);
    this.restoreStatusButtonFocus_abyssPrivate(focused);
    this.sync();
  }

  private statusButton_abyssPrivate(key: string): HTMLButtonElement {
    const existing = this.statusButtons_abyssPrivate.get(key);
    if (existing !== undefined) return existing;
    const button = this.badges_abyssPrivate.createEl('button', {
      cls: 'abyss-project-status-filter',
      attr: { type: 'button', 'data-status-key': key },
    });
    button.addEventListener('click', () => {
      this.options_abyssPrivate.onStatusToggle(key);
    });
    this.statusButtons_abyssPrivate.set(key, button);
    return button;
  }

  private patchStatusButton_abyssPrivate(
    button: HTMLButtonElement,
    status: StatusGroup,
    disabled: boolean,
  ): void {
    button.setText(status.label);
    button.toggleClass('is-disabled', disabled);
    button.setAttribute('aria-pressed', String(!disabled));
    button.style.removeProperty('--abyss-project-status-color');
    if (status.color !== undefined && status.color.length > 0) {
      button.style.setProperty('--abyss-project-status-color', status.color);
    }
  }

  private removeMissingStatusButtons_abyssPrivate(retained: ReadonlySet<string>): void {
    for (const [key, button] of this.statusButtons_abyssPrivate) {
      if (retained.has(key)) continue;
      button.remove();
      this.statusButtons_abyssPrivate.delete(key);
    }
  }

  private reconcileStatusButtonOrder_abyssPrivate(buttons: readonly HTMLButtonElement[]): void {
    let cursor = this.badges_abyssPrivate.firstChild;
    for (const button of buttons) {
      if (button === cursor) cursor = cursor.nextSibling;
      else this.badges_abyssPrivate.insertBefore(button, cursor);
    }
  }

  private restoreStatusButtonFocus_abyssPrivate(focused: Element | null): void {
    if (
      focused instanceof HTMLElement &&
      focused.isConnected &&
      this.badges_abyssPrivate.contains(focused) &&
      this.badges_abyssPrivate.ownerDocument.activeElement !== focused
    ) {
      focused.focus({ preventScroll: true });
    }
  }

  setSearchValue(value: string): void {
    if (this.searchInput.value !== value) this.searchInput.value = value;
  }

  destroy(): void {
    this.popoverCleanup_abyssPrivate?.();
    this.popoverCleanup_abyssPrivate = undefined;
  }

  private sync(): void {
    const mode = this.options_abyssPrivate.mode();
    for (const [candidate, button] of this.modeButtons_abyssPrivate) {
      const active = candidate === mode;
      button.toggleClass('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    const settings = this.options_abyssPrivate.settings();
    const customized = isTableSettings(settings)
      ? isCustomized(settings)
      : isProjectKanbanCustomized(settings, this.options_abyssPrivate.tableSettings());
    this.viewButton_abyssPrivate.classList.toggle('abyss-view-state-btn--active', customized);
  }

  private togglePopover_abyssPrivate(): void {
    if (this.popoverCleanup_abyssPrivate !== undefined) {
      this.popoverCleanup_abyssPrivate();
      return;
    }
    const settings = this.options_abyssPrivate.settings();
    const fields = this.options_abyssPrivate.fields();
    const rows = isTableSettings(settings)
      ? this.tableRows_abyssPrivate(settings, fields)
      : projectKanbanOptionsRows({
          settings,
          tableSettings: this.options_abyssPrivate.tableSettings(),
          fields,
          onChange: this.options_abyssPrivate.onViewOptionChange,
        });
    const customized = isTableSettings(settings)
      ? isCustomized(settings)
      : isProjectKanbanCustomized(settings, this.options_abyssPrivate.tableSettings());
    const close = openViewOptionsPopover({
      host: this.options_abyssPrivate.host,
      anchor: this.viewButton_abyssPrivate,
      rows,
      showReset: customized,
      onReset: this.options_abyssPrivate.onReset,
      onClose: () => {
        if (this.popoverCleanup_abyssPrivate === close) {
          this.popoverCleanup_abyssPrivate = undefined;
        }
      },
    });
    this.popoverCleanup_abyssPrivate = close;
  }

  private tableRows_abyssPrivate(
    settings: ProjectTableSettings,
    fields: readonly ProjectFieldCatalogItem[],
  ): ViewOptionsRow[] {
    const configured = new Set(settings.columns.map(({ id }) => id));
    configured.add(settings.groupBy);
    configured.add(settings.sortBy.field);
    const selectable = fields.filter((field) => configured.has(field.id));
    const arrow = settings.sortBy.dir === 'asc' ? '↑' : '↓';
    const sortDisplay =
      settings.sortBy.field === 'none'
        ? 'None'
        : `${fieldLabel(fields, settings, settings.sortBy.field)} ${arrow}`;
    const defaultSortField = buildDefaultProjectTableSettings().sortBy.field;
    return [
      {
        kind: 'single',
        icon: 'layout-list',
        label: 'Group by',
        displayValue: fieldLabel(fields, settings, settings.groupBy),
        activeValue: settings.groupBy,
        options: [
          { value: 'none', label: 'None' },
          ...selectable.map((field) => ({
            value: field.id,
            label: fieldLabel(fields, settings, field.id),
            isDefault: field.id === 'status',
          })),
        ],
        onSelect: (value) => {
          this.options_abyssPrivate.onGroupBy(value);
        },
      },
      {
        kind: 'single',
        icon: 'arrow-up-down',
        label: 'Sort by',
        displayValue: sortDisplay,
        activeValue: settings.sortBy.field,
        options: [
          { value: 'none', label: 'None' },
          ...selectable.map((field) => ({
            value: field.id,
            label:
              `${fieldLabel(fields, settings, field.id)} ${settings.sortBy.field === field.id ? arrow : ''}`.trim(),
            isDefault: field.id === defaultSortField,
          })),
        ],
        onSelect: (value) => {
          this.options_abyssPrivate.onSortBy(value);
        },
      },
      {
        kind: 'group',
        icon: 'table-2',
        label: 'Table',
        displayValue: '2 options',
        rows: [
          this.tableColumnsRow_abyssPrivate(settings, fields),
          this.tableDescriptionRow_abyssPrivate(settings),
        ],
      },
    ];
  }

  private tableColumnsRow_abyssPrivate(
    settings: ProjectTableSettings,
    fields: readonly ProjectFieldCatalogItem[],
  ): ViewOptionsRow {
    const selected = (): string[] =>
      settings.columns.filter(({ visible }) => visible).map(({ id }) => id);
    const options: ViewOption[] = settings.columns.map((column) => {
      const label = fieldLabel(fields, settings, column.id);
      const field = fields.find(({ id }) => id === column.id);
      const action =
        field === undefined
          ? undefined
          : this.tableDateAction_abyssPrivate(settings, column, field, label);
      return {
        value: column.id,
        label,
        ...(column.id === 'name' ? { disabled: true, required: true } : {}),
        ...(action === undefined ? {} : { action }),
      };
    });
    return {
      kind: 'multi',
      icon: 'columns-3',
      label: 'Columns',
      displayValue: () => `${selected().length} shown`,
      selected,
      options,
      onToggle: (columnId) =>
        this.applyViewMutation_abyssPrivate(() => {
          const column = settings.columns.find(({ id }) => id === columnId);
          if (column !== undefined) {
            setProjectColumnVisibility(settings, columnId, !column.visible);
          }
        }),
      onMove: (columnId, direction) =>
        this.applyViewMutation_abyssPrivate(() => {
          const index = settings.columns.findIndex(({ id }) => id === columnId);
          const target = settings.columns[index + (direction === 'up' ? -1 : 1)];
          if (target !== undefined) moveProjectColumn(settings, columnId, target.id);
        }),
    };
  }

  private tableDescriptionRow_abyssPrivate(settings: ProjectTableSettings): ViewOptionsRow {
    return {
      kind: 'single',
      icon: 'text',
      label: 'Description',
      displayValue: settings.showDescription ? 'Show' : 'Hide',
      activeValue: settings.showDescription ? 'show' : 'hide',
      options: [
        { value: 'hide', label: 'Hide' },
        { value: 'show', label: 'Show', isDefault: true },
      ],
      onSelect: (value) =>
        this.applyViewMutation_abyssPrivate(() => {
          settings.showDescription = value === 'show';
        }),
    };
  }

  private tableDateAction_abyssPrivate(
    settings: ProjectTableSettings,
    column: ProjectColumn,
    field: ProjectFieldCatalogItem,
    label: string,
  ): ViewOptionAction | undefined {
    if (field.type !== 'date' && field.type !== 'datetime') return undefined;
    const active = (): ProjectDateDisplay => column.dateDisplay ?? 'pretty';
    return {
      label: () => projectDateDisplayLabel(active()),
      ariaLabel: `Date display for ${label}`,
      onSelect: (event, run) => {
        const trigger = event.currentTarget;
        const menu = new Menu();
        configureProjectDateDisplayMenu(menu, {
          active: active(),
          onSelect: (display) => {
            run(() => this.setTableDateDisplay_abyssPrivate(settings, column.id, display));
          },
        });
        menu.onHide(() => {
          if (trigger instanceof HTMLElement && trigger.isConnected) {
            trigger.focus({ preventScroll: true });
          }
        });
        showMenuAtMouseEventWithFocus(menu, event);
      },
    };
  }

  private async applyViewMutation_abyssPrivate(mutation: () => void): Promise<void> {
    await this.options_abyssPrivate.onViewOptionChange(mutation);
  }

  private setTableDateDisplay_abyssPrivate(
    settings: ProjectTableSettings,
    columnId: string,
    display: ProjectDateDisplay,
  ): Promise<void> {
    return this.applyViewMutation_abyssPrivate(() => {
      setProjectColumnDateDisplay(settings, columnId, display);
    });
  }
}
