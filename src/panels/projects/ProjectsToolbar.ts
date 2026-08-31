import { Menu, Notice, setIcon } from 'obsidian';
import type {
  PortfolioGroupBy,
  PortfolioSort,
  ProjectStatus,
  ProjectsTablePreference,
} from '../../settings/types';
import {
  renderCollectionControls,
  type CollectionControlAction,
} from '../../ui/collection/CollectionControls';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import {
  moveTableColumn,
  safeFieldLabel,
  tableVisibleFields,
  toggleTableColumn,
} from '../../ui/table/TablePreferences';
import { ProjectWorkspaceSession } from './ProjectWorkspaceSession';
import type { ProjectsListContext } from './viewContext';

const UNMAPPED_FILTER = '__unmapped__';

export interface ProjectsToolbarResult {
  readonly newProjectButton: HTMLButtonElement;
  readonly captureHost: HTMLElement;
  readonly liveRegion: HTMLElement;
  readonly filterButton: HTMLButtonElement;
  destroy(): void;
}

function reportPreferenceError(error: unknown): void {
  const conflict = error instanceof Error && error.name === 'CollectionPreferenceConflictError';
  new Notice(
    conflict
      ? 'Project view changed elsewhere. Your change was not saved; review the settled view.'
      : 'Project view preference was not saved. Nothing changed; try again.',
  );
}

function collectionState(ctx: ProjectsListContext): ProjectWorkspaceSession {
  if (ctx.collectionState) return ctx.collectionState;
  const state = new ProjectWorkspaceSession();
  state.bindCollectionPreferences(ctx.settings, ctx.onSaveSettings);
  return state;
}

function renderPortfolioLayout(
  controls: HTMLElement,
  ctx: ProjectsListContext,
  state: ProjectWorkspaceSession,
): void {
  const switcher = controls.createDiv({
    cls: 'abyss-cal-view-switcher abyss-projects-view-switcher',
    attr: { 'aria-label': 'Project view' },
  });
  const layouts: Array<readonly ['overview' | 'board' | 'timeline', string]> = [
    ['overview', 'Overview'],
    ['board', 'Board'],
    ['timeline', 'Timeline'],
  ];
  for (const [layout, label] of layouts) {
    const selected = state.portfolioPreference().layout === layout;
    const button = switcher.createEl('button', {
      cls: `abyss-cal-view-btn${selected ? ' is-active' : ''}`,
      text: label,
      attr: {
        type: 'button',
        'data-project-portfolio-layout': layout,
        'aria-current': selected ? 'page' : 'false',
      },
    });
    if (layout === 'timeline' && ctx.timelineAvailable === false) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    button.addEventListener('click', () => {
      if (state.portfolioPreference().layout === layout) return;
      void state
        .updatePortfolioPreference((current) => ({ ...current, layout }))
        .then(() => ctx.onPortfolioLayoutChanged?.())
        .catch(reportPreferenceError);
    });
  }
}

function toggleStatus(
  ctx: ProjectsListContext,
  state: ProjectWorkspaceSession,
  statusId: string,
): Promise<boolean> {
  const current = state.portfolioPreference();
  const visible = new Set(current.filters);
  if (visible.has(statusId)) visible.delete(statusId);
  else visible.add(statusId);
  const configured = new Set(ctx.settings.projects.statuses.map(({ id }) => id));
  const known = ctx.settings.projects.statuses.map(({ id }) => id).filter((id) => visible.has(id));
  const dormant = current.filters.filter((id) => id !== UNMAPPED_FILTER && !configured.has(id));
  const filters = [
    ...known,
    ...dormant,
    ...(visible.has(UNMAPPED_FILTER) ? [UNMAPPED_FILTER] : []),
  ];
  return state
    .updatePortfolioPreference((preference) => ({ ...preference, filters }))
    .then(() => {
      ctx.onFiltersChanged?.();
      return true;
    })
    .catch((error: unknown) => {
      reportPreferenceError(error);
      return false;
    });
}

function toggleUnmapped(ctx: ProjectsListContext, state: ProjectWorkspaceSession): Promise<void> {
  const selected = state.portfolioPreference().filters.includes(UNMAPPED_FILTER);
  return state
    .updatePortfolioPreference((current) => ({
      ...current,
      filters: selected
        ? current.filters.filter((id) => id !== UNMAPPED_FILTER)
        : [...current.filters, UNMAPPED_FILTER],
    }))
    .then(() => ctx.onFiltersChanged?.())
    .catch(reportPreferenceError);
}

function addStatusFilterMenuItems(
  menu: Menu,
  ctx: ProjectsListContext,
  state: ProjectWorkspaceSession,
): void {
  menu.addItem((item) => item.setTitle('Status').setDisabled(true));
  for (const status of ctx.settings.projects.statuses) {
    menu.addItem((item) => {
      item.setTitle(status.label);
      item.setChecked(state.portfolioPreference().filters.includes(status.id));
      item.onClick(() => void toggleStatus(ctx, state, status.id));
    });
  }
  menu.addItem((item) => {
    item.setTitle('Unmapped');
    item.setChecked(state.portfolioPreference().filters.includes(UNMAPPED_FILTER));
    item.onClick(() => void toggleUnmapped(ctx, state));
  });
}

const TABLE_FIELDS: readonly [string, string][] = [
  ['project', 'Project'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['progress', 'Progress'],
  ['nextAction', 'Next action'],
  ['start', 'Start'],
  ['end', 'End'],
];

function updateTable(
  state: ProjectWorkspaceSession,
  mutate: (table: ProjectsTablePreference) => ProjectsTablePreference,
): Promise<void> {
  return state
    .updatePortfolioPreference((current) => {
      const table = current.layoutPreferences['overview']?.table;
      if (!table) return current;
      const next = mutate(table);
      return {
        ...current,
        visibleFields: tableVisibleFields(next),
        layoutPreferences: {
          ...current.layoutPreferences,
          overview: { ...current.layoutPreferences['overview'], table: next },
        },
      };
    })
    .then(() => undefined);
}

function portfolioFields(
  table: ProjectsTablePreference | undefined,
  available: readonly (readonly [string, string])[] = TABLE_FIELDS,
): readonly (readonly [string, string])[] {
  const labels = new Map(available);
  for (const { propertyId } of table?.columns ?? []) {
    if (!labels.has(propertyId)) labels.set(propertyId, safeFieldLabel(propertyId));
  }
  return [...labels];
}

function addPortfolioFieldMenuItem(
  menu: Menu,
  field: readonly [string, string],
  table: ProjectsTablePreference | undefined,
  state: ProjectWorkspaceSession,
  onChanged: (() => void) | undefined,
): void {
  const [id, label] = field;
  menu.addItem((item) =>
    item
      .setTitle(label)
      .setChecked(
        table?.columns.some((column) => column.propertyId === id && column.visible) ?? false,
      )
      .onClick(
        () =>
          void updateTable(state, (current) => toggleTableColumn(current, id))
            .then(onChanged)
            .catch(reportPreferenceError),
      ),
  );
  const index = table?.columns.findIndex((column) => column.propertyId === id) ?? -1;
  menu.addItem((item) =>
    item
      .setTitle(`Move ${label} earlier`)
      .setDisabled(index <= 0)
      .onClick(
        () =>
          void updateTable(state, (current) => moveTableColumn(current, id, -1))
            .then(onChanged)
            .catch(reportPreferenceError),
      ),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Move ${label} later`)
      .setDisabled(index < 0 || index >= (table?.columns.length ?? 0) - 1)
      .onClick(
        () =>
          void updateTable(state, (current) => moveTableColumn(current, id, 1))
            .then(onChanged)
            .catch(reportPreferenceError),
      ),
  );
}

function updatePortfolioGroup(
  state: ProjectWorkspaceSession,
  group: PortfolioGroupBy,
): Promise<void> {
  return state
    .updatePortfolioPreference((current) => ({ ...current, group }))
    .then(() => undefined);
}

function updatePortfolioSort(
  state: ProjectWorkspaceSession,
  field: PortfolioSort['field'],
): Promise<void> {
  return state
    .updatePortfolioPreference((current) => ({
      ...current,
      sort: {
        field,
        dir: current.sort.field === field && current.sort.dir === 'asc' ? 'desc' : 'asc',
      },
    }))
    .then(() => undefined);
}

function renderStatusFilter(
  controls: HTMLElement,
  status: ProjectStatus,
  ctx: ProjectsListContext,
  state: ProjectWorkspaceSession,
): void {
  let pointerActivation = false;
  const selected = state.portfolioPreference().filters.includes(status.id);
  const button = controls.createEl('button', {
    cls: `abyss-filter-chip abyss-project-status-filter${selected ? ' is-active' : ''}`,
    attr: {
      type: 'button',
      'data-project-status-filter': status.id,
      'aria-pressed': selected ? 'true' : 'false',
    },
  });
  const dot = button.createSpan({ cls: 'abyss-status-dot' });
  if (status.color) dot.style.background = status.color;
  button.createSpan({ cls: 'abyss-filter-chip-label', text: status.label });
  button.addEventListener('pointerdown', () => {
    pointerActivation = true;
  });
  button.addEventListener('click', () => {
    const ownsFocus = button.ownerDocument.activeElement === button;
    const restoreKeyboardFocus = ownsFocus && !pointerActivation;
    pointerActivation = false;
    const projectsRoot = button.closest<HTMLElement>('.abyss-projects-panel, .abyss-projects-list');
    void toggleStatus(ctx, state, status.id).then((settled) => {
      const active = button.ownerDocument.activeElement;
      const focusIsUnclaimed =
        active === button ||
        active === button.ownerDocument.body ||
        !(active instanceof HTMLElement) ||
        !active.isConnected;
      if (settled && restoreKeyboardFocus && focusIsUnclaimed) {
        const replacement = Array.from(
          projectsRoot?.querySelectorAll<HTMLElement>('[data-project-status-filter]') ?? [],
        ).find(({ dataset }) => dataset['projectStatusFilter'] === status.id);
        replacement?.focus({ preventScroll: true });
      }
    });
  });
}

function renderUnmappedFilter(
  controls: HTMLElement,
  ctx: ProjectsListContext,
  state: ProjectWorkspaceSession,
): void {
  let pointerActivation = false;
  const selected = state.portfolioPreference().filters.includes(UNMAPPED_FILTER);
  const button = controls.createEl('button', {
    cls: `abyss-filter-chip abyss-project-status-filter${selected ? ' is-active' : ''}`,
    attr: {
      type: 'button',
      'data-project-unmapped-filter': '',
      'aria-pressed': selected ? 'true' : 'false',
    },
  });
  button.createSpan({ cls: 'abyss-status-dot' });
  button.createSpan({ cls: 'abyss-filter-chip-label', text: 'Unmapped' });
  button.addEventListener('pointerdown', () => {
    pointerActivation = true;
  });
  button.addEventListener('click', () => {
    const ownsFocus = button.ownerDocument.activeElement === button;
    const restoreKeyboardFocus = ownsFocus && !pointerActivation;
    pointerActivation = false;
    const projectsRoot = button.closest<HTMLElement>('.abyss-projects-panel, .abyss-projects-list');
    void state
      .updatePortfolioPreference((current) => ({
        ...current,
        filters: selected
          ? current.filters.filter((id) => id !== UNMAPPED_FILTER)
          : [...current.filters, UNMAPPED_FILTER],
      }))
      .then(() => {
        ctx.onFiltersChanged?.();
        const active = button.ownerDocument.activeElement;
        const focusIsUnclaimed =
          active === button ||
          active === button.ownerDocument.body ||
          !(active instanceof HTMLElement) ||
          !active.isConnected;
        if (restoreKeyboardFocus && focusIsUnclaimed) {
          projectsRoot
            ?.querySelector<HTMLElement>('[data-project-unmapped-filter]')
            ?.focus({ preventScroll: true });
        }
      })
      .catch(reportPreferenceError);
  });
}

export function renderProjectsToolbar(
  container: HTMLElement,
  ctx: ProjectsListContext,
): ProjectsToolbarResult {
  const state = collectionState(ctx);
  const header = container.createDiv({ cls: 'abyss-center-header abyss-projects-toolbar' });
  header.createEl('h2', { cls: 'abyss-center-title abyss-projects-title', text: 'Projects' });
  let filters!: HTMLElement;
  let filterButton!: HTMLButtonElement;
  const showStatusFilterMenu = (event: MouseEvent): void => {
    const menu = new Menu();
    filterButton.setAttribute('aria-expanded', 'true');
    menu.onHide(() => {
      if (filterButton.isConnected) {
        filterButton.setAttribute('aria-expanded', 'false');
        filterButton.focus({ preventScroll: true });
      }
    });
    addStatusFilterMenuItems(menu, ctx, state);
    showMenuAtMouseEventWithFocus(menu, event);
  };
  const actions: readonly CollectionControlAction[] = [
    { kind: 'filter', label: 'Filter', icon: 'list-filter', onActivate: showStatusFilterMenu },
    {
      kind: 'group',
      label: 'Group',
      icon: 'layout-list',
      onActivate: (event) => {
        const menu = new Menu();
        for (const [value, label] of [
          ['none', 'None'],
          ['status', 'Status'],
          ['priority', 'Priority'],
        ] as const) {
          menu.addItem((item) =>
            item
              .setTitle(label)
              .setChecked(state.portfolioPreference().group === value)
              .onClick(
                () =>
                  void updatePortfolioGroup(state, value)
                    .then(ctx.onPortfolioLayoutChanged)
                    .catch(reportPreferenceError),
              ),
          );
        }
        showMenuAtMouseEventWithFocus(menu, event);
      },
    },
    {
      kind: 'sort',
      label: 'Sort',
      icon: 'arrow-up-down',
      onActivate: (event) => {
        const menu = new Menu();
        for (const [field, label] of [
          ['title', 'Title'],
          ['status', 'Status'],
          ['priority', 'Priority'],
          ['progress', 'Progress'],
          ['start', 'Start'],
          ['end', 'End'],
        ] as const) {
          menu.addItem((item) =>
            item
              .setTitle(label)
              .setChecked(state.portfolioPreference().sort.field === field)
              .onClick(
                () =>
                  void updatePortfolioSort(state, field)
                    .then(ctx.onPortfolioLayoutChanged)
                    .catch(reportPreferenceError),
              ),
          );
        }
        showMenuAtMouseEventWithFocus(menu, event);
      },
    },
    {
      kind: 'fields',
      label: 'Fields',
      icon: 'columns-3',
      onActivate: (event) => {
        const menu = new Menu();
        const table = state.portfolioPreference().layoutPreferences['overview']?.table;
        for (const [id, label] of portfolioFields(table, ctx.portfolioFields)) {
          addPortfolioFieldMenuItem(menu, [id, label], table, state, ctx.onPortfolioLayoutChanged);
        }
        showMenuAtMouseEventWithFocus(menu, event);
      },
    },
  ];
  let newProjectButton!: HTMLButtonElement;
  const { element: controls } = renderCollectionControls(header, {
    query: '',
    searchLabel: 'Filter projects',
    toolbarLabel: 'Project portfolio controls',
    search: false,
    renderLeading: (host) => {
      filters = host.createDiv({
        cls: 'abyss-project-status-filters',
        attr: {
          role: 'group',
          'aria-label': 'Project status filters',
          'data-portfolio-zone': 'filters',
        },
      });
      for (const status of ctx.settings.projects.statuses) {
        renderStatusFilter(filters, status, ctx, state);
      }
      renderUnmappedFilter(filters, ctx, state);
    },
    renderLayout: (host) => {
      host.setAttribute('data-portfolio-zone', 'layout');
      renderPortfolioLayout(host, ctx, state);
    },
    actions,
    onQueryInput: () => undefined,
    renderAdd: (host) => {
      host.classList.add('abyss-projects-add-zone');
      host.setAttribute('data-portfolio-zone', 'add');
      newProjectButton = host.createEl('button', {
        cls: 'abyss-projects-new abyss-project-open-btn',
        attr: { type: 'button', 'aria-label': 'New project', title: 'New project' },
      });
      setIcon(newProjectButton, 'plus');
    },
  });
  filterButton = controls.querySelector<HTMLButtonElement>('[data-collection-filter]')!;
  filterButton.setAttribute('aria-haspopup', 'menu');
  filterButton.setAttribute('aria-expanded', 'false');
  for (const kind of ['group', 'sort', 'fields'] as const) {
    controls
      .querySelector<HTMLButtonElement>(`[data-collection-${kind}]`)
      ?.setAttribute('aria-haspopup', 'menu');
  }
  const captureHost = header.createDiv({ cls: 'abyss-projects-new-input-host' });
  const liveRegion = header.createDiv({
    cls: 'abyss-sr-only abyss-project-create-live',
    attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });

  let requiredFilterWidth = 0;
  const updateOverflow = (): void => {
    if (!filters.classList.contains('is-overflowing')) {
      requiredFilterWidth = filters.scrollWidth;
    }
    const computedFontSize = Number.parseFloat(
      header.ownerDocument.defaultView?.getComputedStyle(header.ownerDocument.documentElement)
        .fontSize ?? '',
    );
    const compactThreshold = 30 * (Number.isFinite(computedFontSize) ? computedFontSize : 16);
    const compact = header.clientWidth > 0 && header.clientWidth <= compactThreshold;
    const overflowing =
      compact || (requiredFilterWidth > filters.clientWidth && filters.clientWidth > 0);
    filters.toggleClass('is-overflowing', overflowing);
    const chips = Array.from(
      filters.querySelectorAll<HTMLButtonElement>('.abyss-project-status-filter'),
    );
    let hiddenCount = 0;
    for (const chip of chips) {
      const hidden = overflowing;
      chip.toggleClass('is-overflow-hidden', hidden);
      if (hidden) hiddenCount += 1;
    }
    const activeCount = state
      .portfolioPreference()
      .filters.filter((id) => id !== UNMAPPED_FILTER).length;
    const label = overflowing
      ? `Filter project statuses (${String(activeCount)} active; ${String(hiddenCount)} hidden)`
      : `Filter project statuses (${String(activeCount)} active)`;
    filterButton.setAttribute('aria-label', label);
    filterButton.setAttribute('title', label);
    filterButton
      .querySelector('.abyss-collection-action-label')
      ?.setText(`Filter (${String(activeCount)})`);
  };
  const ResizeObserverCtor = header.ownerDocument.defaultView?.ResizeObserver;
  const observer = ResizeObserverCtor ? new ResizeObserverCtor(updateOverflow) : undefined;
  observer?.observe(header);
  observer?.observe(filters);
  updateOverflow();
  return {
    newProjectButton,
    captureHost,
    liveRegion,
    filterButton,
    destroy: () => observer?.disconnect(),
  };
}
