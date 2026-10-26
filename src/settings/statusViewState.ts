import type { CalendarSettings, ProjectsSettings, TaskStatusDef } from './types';

/** Keep live list objects shared with navigation while removing only this definition's references. */
export function removeTaskStatusViewState(
  settings: CalendarSettings,
  status: Pick<TaskStatusDef, 'id' | 'symbol'>,
): void {
  for (const view of Object.values(settings.listViewStates ?? {})) {
    view.filters = view.filters.filter(
      (filter) => filter.type !== 'status' || filter.value !== status.symbol,
    );
    if (view.kanban !== undefined) {
      view.kanban.hiddenStatuses = view.kanban.hiddenStatuses.filter((id) => id !== status.id);
      view.kanban.collapsedColumns = view.kanban.collapsedColumns.filter(
        (key) => key !== `status:${status.id}`,
      );
    }
    if (view.timeline !== undefined)
      view.timeline.hiddenStatuses = view.timeline.hiddenStatuses.filter((id) => id !== status.id);
  }
}

/** Raw frontmatter values and collapse keys for other fields retain their independent meaning. */
export function removeProjectStatusViewState(projects: ProjectsSettings, id: string): void {
  const key = `id:${id}`;
  const group = JSON.stringify(['status', key]);
  for (const view of [projects.table, projects.kanban, projects.timeline]) {
    if (view !== undefined)
      view.hiddenStatuses = view.hiddenStatuses.filter((value) => value !== key);
  }
  for (const view of [projects.table, projects.timeline]) {
    if (view?.collapsedGroups !== undefined)
      view.collapsedGroups = view.collapsedGroups.filter((value) => value !== group);
  }
  if (projects.kanban !== undefined) {
    projects.kanban.collapsedColumns = projects.kanban.collapsedColumns.filter(
      (value) => value !== key,
    );
    delete projects.kanban.manualOrder[key];
  }
}
