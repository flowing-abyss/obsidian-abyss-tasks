import { setIcon } from 'obsidian';
import type { ProjectStatus } from '../../settings/types';
import type { ProjectsListContext } from './viewContext';

export interface ProjectsToolbarResult {
  readonly newProjectButton: HTMLButtonElement;
}

function renderPortfolioLayout(controls: HTMLElement, ctx: ProjectsListContext): void {
  const switcher = controls.createDiv({
    cls: 'abyss-cal-view-switcher abyss-projects-view-switcher',
    attr: { 'aria-label': 'Project view' },
  });
  const layouts: Array<readonly ['overview' | 'board' | 'timeline', string]> = [
    ['overview', 'Overview'],
    ['board', 'Board'],
  ];
  if (ctx.timelineAvailable === true) layouts.push(['timeline', 'Timeline']);
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
    button.addEventListener('click', () => {
      if (ctx.settings.projects.view.portfolioLayout === layout) return;
      ctx.settings.projects.view.portfolioLayout = layout;
      void ctx.onSaveSettings();
      ctx.onPortfolioLayoutChanged?.();
    });
  }
}

function renderStatusFilter(
  controls: HTMLElement,
  status: ProjectStatus,
  ctx: ProjectsListContext,
): void {
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
  button.addEventListener('click', () => {
    const visible = new Set(ctx.settings.projects.view.visibleStatusIds);
    if (visible.has(status.id)) visible.delete(status.id);
    else visible.add(status.id);
    ctx.settings.projects.view.visibleStatusIds = ctx.settings.projects.statuses
      .map(({ id }) => id)
      .filter((id) => visible.has(id));
    void ctx.onSaveSettings();
    ctx.onFiltersChanged?.();
  });
}

function renderUnmappedFilter(controls: HTMLElement, ctx: ProjectsListContext): void {
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
  button.addEventListener('click', () => {
    ctx.settings.projects.view.includeUnmapped = !selected;
    void ctx.onSaveSettings();
    ctx.onFiltersChanged?.();
  });
}

export function renderProjectsToolbar(
  container: HTMLElement,
  ctx: ProjectsListContext,
): ProjectsToolbarResult {
  const header = container.createDiv({ cls: 'abyss-center-header abyss-projects-toolbar' });
  header.createEl('h2', { cls: 'abyss-center-title abyss-projects-title', text: 'Projects' });
  const controls = header.createDiv({ cls: 'abyss-center-controls' });

  renderPortfolioLayout(controls, ctx);

  const filters = controls.createDiv({
    cls: 'abyss-project-status-filters',
    attr: { 'aria-label': 'Project status filters' },
  });
  for (const status of ctx.settings.projects.statuses) renderStatusFilter(filters, status, ctx);
  renderUnmappedFilter(filters, ctx);

  const newProjectButton = controls.createEl('button', {
    cls: 'abyss-projects-new abyss-project-open-btn',
    attr: { type: 'button', 'aria-label': 'New project', title: 'New project' },
  });
  setIcon(newProjectButton, 'plus');
  return { newProjectButton };
}
