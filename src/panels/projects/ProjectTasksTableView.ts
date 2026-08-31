import type { ProjectAction } from '../../projects/types';
import type { CalendarSettings, ProjectTasksTablePreference } from '../../settings/types';
import { renderVirtualTable, type VirtualTableHandle } from '../../ui/table/VirtualTable';

const DEFAULT_COLUMNS = [
  ['task', 'Task'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['due', 'Due'],
  ['nextAction', 'Next action'],
] as const;
export interface ProjectTasksTableOptions {
  readonly settings: CalendarSettings;
  readonly path: string;
  readonly onActivate: (action: ProjectAction) => void;
  readonly preference?: ProjectTasksTablePreference;
  readonly onPreferenceChange?: (next: ProjectTasksTablePreference) => void;
}
function columns(preference: ProjectTasksTablePreference) {
  const byId = new Map(preference.columns.map((column) => [column.propertyId, column]));
  return DEFAULT_COLUMNS.filter(([id]) => byId.get(id)?.visible !== false).map(([id, label]) => ({
    id,
    label,
    width: byId.get(id)?.width,
  }));
}
function taskCellValue(action: ProjectAction, id: string): string {
  if (id === 'task') return action.task.title;
  if (id === 'status') return action.task.status;
  if (id === 'priority') return action.task.priority ?? '';
  return id === 'due' ? (action.task.planning.due ?? '') : '';
}
/** Project Task Table consumes the already-selected canonical action projection. */
export function renderProjectTasksTable(
  parent: HTMLElement,
  actions: readonly ProjectAction[],
  options: ProjectTasksTableOptions,
): VirtualTableHandle {
  const preference = options.preference ?? options.settings.projects.view.tasks.table;
  return renderVirtualTable(parent, {
    columns: columns(preference),
    rows: [...actions],
    key: ({ task }) => `${task.ref.filePath}:${task.ref.line}:${task.ref.revision}`,
    label: 'Project tasks table',
    renderRow: (action, host) => {
      const row = host.createDiv({
        cls: 'abyss-virtual-table-row',
        attr: {
          role: 'row',
          tabindex: '0',
          'data-project-task-table-row': `${action.task.ref.filePath}:${action.task.ref.line}`,
        },
      });
      const activate = (): void => options.onActivate(action);
      row.addEventListener('dblclick', activate);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      for (const column of columns(preference)) {
        const cell = row.createDiv({
          cls: 'abyss-virtual-table-cell',
          attr: { role: 'cell', 'data-table-column': column.id },
        });
        if (column.id === 'nextAction') {
          if (action.task.tags?.includes('#task/next_action'))
            cell.createSpan({
              text: '✓',
              attr: {
                'data-next-action': 'true',
                title: 'Next action',
                'aria-label': 'Next action',
              },
            });
          continue;
        }
        const value = taskCellValue(action, column.id);
        if (value) cell.createSpan({ text: value, attr: { title: value } });
      }
      return row;
    },
  });
}
