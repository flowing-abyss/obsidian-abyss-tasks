import { ProjectPropertyAdapter } from '../../projects/properties/ProjectPropertyAdapter';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type { CalendarSettings, ProjectsTablePreference } from '../../settings/types';
import { EntityPresentation } from '../../ui/entity/EntityPresentation';
import { renderVirtualTable, type VirtualTableHandle } from '../../ui/table/VirtualTable';

const DEFAULT_COLUMNS = [
  ['project', 'Project'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['progress', 'Progress'],
  ['nextAction', 'Next action'],
  ['start', 'Start'],
  ['end', 'End'],
] as const;

export interface ProjectsTableOptions {
  readonly settings: CalendarSettings;
  readonly onOpen: (path: string) => void;
  readonly preference?: ProjectsTablePreference;
  readonly onPreferenceChange?: (next: ProjectsTablePreference) => void;
}

function columns(preference: ProjectsTablePreference) {
  const byId = new Map(preference.columns.map((column) => [column.propertyId, column]));
  return DEFAULT_COLUMNS.filter(([id]) => byId.get(id)?.visible !== false).map(([id, label]) => ({
    id,
    label,
    width: byId.get(id)?.width,
  }));
}

/** Portfolio overview adapter. Projection-only: snapshots stay owned by ProjectWorkspaceCoordinator. */
export function renderProjectsTable(
  parent: HTMLElement,
  snapshots: readonly ProjectWorkspaceSnapshot[],
  options: ProjectsTableOptions,
): VirtualTableHandle {
  const preference = options.preference ?? options.settings.projects.view.table;
  const adapter = new ProjectPropertyAdapter();
  const table = renderVirtualTable(parent, {
    columns: columns(preference),
    rows: [...snapshots],
    key: ({ project }) => project.path,
    label: 'Projects overview table',
    renderRow: (snapshot, host) => {
      const row = host.createDiv({
        cls: 'abyss-virtual-table-row',
        attr: { role: 'row', tabindex: '0', 'data-project-table-row': snapshot.project.path },
      });
      const open = (): void => options.onOpen(snapshot.project.path);
      row.addEventListener('dblclick', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      for (const column of columns(preference)) {
        const cell = row.createDiv({
          cls: 'abyss-virtual-table-cell',
          attr: { role: 'cell', 'data-table-column': column.id },
        });
        let value = '';
        switch (column.id) {
          case 'project':
            new EntityPresentation({
              identity: snapshot.project.name,
              priority: snapshot.project.priority,
            }).render(cell);
            continue;
          case 'status':
            value =
              options.settings.projects.statuses.find(({ id }) => id === snapshot.project.statusId)
                ?.label ??
              snapshot.project.rawStatus ??
              '';
            break;
          case 'priority':
            value = snapshot.project.priority ?? '';
            break;
          case 'progress':
            value =
              snapshot.taskRollup.progress === null
                ? ''
                : `${Math.round(snapshot.taskRollup.progress * 100)}%`;
            break;
          case 'nextAction':
            value = snapshot.tasks.some(({ task }) => task.tags?.includes('#task/next_action'))
              ? 'Next action'
              : '';
            break;
          case 'start':
            value = adapter.display(snapshot.project.range.start?.raw);
            break;
          case 'end':
            value = adapter.display(snapshot.project.range.end?.raw);
            break;
        }
        if (value) cell.createSpan({ text: value, attr: { title: value } });
      }
      return row;
    },
  });
  return table;
}
