import type { ProjectStatus } from '../../settings/types';

/** Applies the shared configured status appearance without owning its content or interaction. */
export function applyProjectStatusPresentation(
  host: HTMLElement,
  status: Pick<ProjectStatus, 'display' | 'color'> | undefined,
): void {
  host.addClass('abyss-project-table-status-pill');
  host.toggleClass('is-text', status?.display === 'text');
  host.toggleClass('is-dot', status?.display === 'dot');
  host.style.removeProperty('--abyss-project-status-color');
  if (status?.color !== undefined && status.color.length > 0) {
    host.style.setProperty('--abyss-project-status-color', status.color);
  }
}
