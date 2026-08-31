import { Menu, setIcon } from 'obsidian';
import type { ProjectStatus } from '../../settings/types';
import {
  renderCollectionControls,
  type CollectionControlAction,
} from '../../ui/collection/CollectionControls';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { ProjectsListContext } from './viewContext';

export interface ProjectsToolbarResult {
  readonly newProjectButton: HTMLButtonElement;
  readonly captureHost: HTMLElement;
  readonly liveRegion: HTMLElement;
  readonly filterButton: HTMLButtonElement;
  destroy(): void;
}

function renderPortfolioLayout(controls: HTMLElement, ctx: ProjectsListContext): void {
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
    const selected = ctx.settings.projects.view.portfolioLayout === layout;
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
      if (ctx.settings.projects.view.portfolioLayout === layout) return;
      ctx.settings.projects.view.portfolioLayout = layout;
      void ctx.onSaveSettings();
      ctx.onPortfolioLayoutChanged?.();
    });
  }
}

function saveFilterChange(ctx: ProjectsListContext): void {
  void ctx.onSaveSettings();
  ctx.onFiltersChanged?.();
}

function toggleStatus(ctx: ProjectsListContext, statusId: string): void {
  const visible = new Set(ctx.settings.projects.view.visibleStatusIds);
  if (visible.has(statusId)) visible.delete(statusId);
  else visible.add(statusId);
  ctx.settings.projects.view.visibleStatusIds = ctx.settings.projects.statuses
    .map(({ id }) => id)
    .filter((id) => visible.has(id));
  saveFilterChange(ctx);
}

function renderStatusFilter(
  controls: HTMLElement,
  status: ProjectStatus,
  ctx: ProjectsListContext,
): void {
  let pointerActivation = false;
  const selected = ctx.settings.projects.view.visibleStatusIds.includes(status.id);
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
    toggleStatus(ctx, status.id);
    const active = button.ownerDocument.activeElement;
    const focusIsUnclaimed =
      active === button ||
      active === button.ownerDocument.body ||
      !(active instanceof HTMLElement) ||
      !active.isConnected;
    if (restoreKeyboardFocus && focusIsUnclaimed) {
      const replacement = Array.from(
        projectsRoot?.querySelectorAll<HTMLElement>('[data-project-status-filter]') ?? [],
      ).find(({ dataset }) => dataset['projectStatusFilter'] === status.id);
      replacement?.focus({ preventScroll: true });
    }
  });
}

function renderUnmappedFilter(controls: HTMLElement, ctx: ProjectsListContext): void {
  let pointerActivation = false;
  const selected = ctx.settings.projects.view.includeUnmapped;
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
    ctx.settings.projects.view.includeUnmapped = !selected;
    saveFilterChange(ctx);
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
  });
}

export function renderProjectsToolbar(
  container: HTMLElement,
  ctx: ProjectsListContext,
): ProjectsToolbarResult {
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
    menu.addItem((item) => item.setTitle('Status').setDisabled(true));
    for (const status of ctx.settings.projects.statuses) {
      menu.addItem((item) => {
        item.setTitle(status.label);
        item.setChecked(ctx.settings.projects.view.visibleStatusIds.includes(status.id));
        item.onClick(() => toggleStatus(ctx, status.id));
      });
    }
    menu.addItem((item) => {
      item.setTitle('Unmapped');
      item.setChecked(ctx.settings.projects.view.includeUnmapped);
      item.onClick(() => {
        ctx.settings.projects.view.includeUnmapped = !ctx.settings.projects.view.includeUnmapped;
        saveFilterChange(ctx);
      });
    });
    showMenuAtMouseEventWithFocus(menu, event);
  };
  const actions: readonly CollectionControlAction[] = [
    { kind: 'filter', label: 'Filter', icon: 'list-filter', onActivate: showStatusFilterMenu },
  ];
  let newProjectButton!: HTMLButtonElement;
  const { element: controls } = renderCollectionControls(header, {
    query: '',
    searchLabel: 'Filter projects',
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
      for (const status of ctx.settings.projects.statuses) renderStatusFilter(filters, status, ctx);
      renderUnmappedFilter(filters, ctx);
    },
    renderLayout: (host) => {
      host.setAttribute('data-portfolio-zone', 'layout');
      renderPortfolioLayout(host, ctx);
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
    filterButton.setAttribute(
      'aria-label',
      overflowing
        ? `Filter project statuses (${String(hiddenCount)} hidden)`
        : 'Filter project statuses',
    );
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
