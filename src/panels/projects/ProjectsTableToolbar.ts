import { setIcon } from 'obsidian';
import type { ProjectFieldCatalogItem, ProjectTableSettings } from '../../projects/projectFields';
import { buildDefaultProjectTableSettings } from '../../projects/projectTableSettings';
import type { StatusGroup } from '../../projects/status';
import { openViewOptionsPopover, type ViewOptionsRow } from '../../ui/ViewOptionsPopover';

export interface ProjectsTableToolbarOptions {
  readonly host: HTMLElement;
  readonly settings: ProjectTableSettings;
  readonly fields: () => readonly ProjectFieldCatalogItem[];
  readonly onSearch: (query: string) => void;
  readonly onStatusToggle: (key: string) => void;
  readonly onGroupBy: (field: string) => void;
  readonly onSortBy: (field: string) => void;
  readonly onReset: () => void;
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
    this.searchInput = controls.createEl('input', {
      cls: 'abyss-center-search',
      attr: { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter projects' },
    });
    this.searchInput.addEventListener('input', () => {
      options_abyssPrivate.onSearch(this.searchInput.value);
    });
    this.syncViewButton();
  }

  update(statuses: readonly StatusGroup[]): void {
    this.badges_abyssPrivate.empty();
    const hidden = new Set(this.options_abyssPrivate.settings.hiddenStatuses);
    for (const status of statuses) {
      const disabled = hidden.has(status.key);
      const button = this.badges_abyssPrivate.createEl('button', {
        cls: `abyss-project-status-filter${disabled ? ' is-disabled' : ''}`,
        text: status.label,
        attr: {
          type: 'button',
          'aria-pressed': String(!disabled),
          'data-status-key': status.key,
        },
      });
      if (status.color !== undefined && status.color.length > 0) {
        button.style.setProperty('--abyss-project-status-color', status.color);
      }
      button.addEventListener('click', () => {
        this.options_abyssPrivate.onStatusToggle(status.key);
      });
    }
    this.syncViewButton();
  }

  destroy(): void {
    this.popoverCleanup_abyssPrivate?.();
    this.popoverCleanup_abyssPrivate = undefined;
  }

  private syncViewButton(): void {
    this.viewButton_abyssPrivate.classList.toggle(
      'abyss-view-state-btn--active',
      isCustomized(this.options_abyssPrivate.settings),
    );
  }

  private togglePopover_abyssPrivate(): void {
    if (this.popoverCleanup_abyssPrivate !== undefined) {
      this.popoverCleanup_abyssPrivate();
      return;
    }
    const { settings } = this.options_abyssPrivate;
    const fields = this.options_abyssPrivate.fields();
    const configured = new Set(settings.columns.map(({ id }) => id));
    configured.add(settings.groupBy);
    configured.add(settings.sortBy.field);
    const selectable = fields.filter((field) => configured.has(field.id));
    const arrow = settings.sortBy.dir === 'asc' ? '↑' : '↓';
    const rows: ViewOptionsRow[] = [
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
        displayValue: `${fieldLabel(fields, settings, settings.sortBy.field)} ${arrow}`,
        activeValue: settings.sortBy.field,
        options: selectable.map((field) => ({
          value: field.id,
          label:
            `${fieldLabel(fields, settings, field.id)} ${settings.sortBy.field === field.id ? arrow : ''}`.trim(),
          isDefault: field.id === 'end',
        })),
        onSelect: (value) => {
          this.options_abyssPrivate.onSortBy(value);
        },
      },
    ];
    const close = openViewOptionsPopover({
      host: this.options_abyssPrivate.host,
      anchor: this.viewButton_abyssPrivate,
      rows,
      showReset: isCustomized(settings),
      onReset: this.options_abyssPrivate.onReset,
      onClose: () => {
        if (this.popoverCleanup_abyssPrivate === close) {
          this.popoverCleanup_abyssPrivate = undefined;
        }
      },
    });
    this.popoverCleanup_abyssPrivate = close;
  }
}
