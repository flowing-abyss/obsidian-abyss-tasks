import type { ProjectAction } from '../../projects/types';
import type {
  CalendarSettings,
  ProjectTasksTablePreference,
  ProjectTasksViewState,
} from '../../settings/types';
import {
  resizeTableColumn,
  safeFieldLabel,
  setTableGroupCollapsed,
} from '../../ui/table/TablePreferences';
import { renderVirtualTable, type VirtualTableHandle } from '../../ui/table/VirtualTable';
import { isNextAction } from './NextActionControl';

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
  readonly groupBy?: ProjectTasksViewState['groupBy'];
}
function columns(preference: ProjectTasksTablePreference) {
  const labels = new Map<string, string>(DEFAULT_COLUMNS);
  return preference.columns
    .filter(({ visible }) => visible)
    .map(({ propertyId, width }) => ({
      id: propertyId,
      label: labels.get(propertyId) ?? safeFieldLabel(propertyId),
      width,
    }));
}
function taskCellValue(action: ProjectAction, id: string): string {
  if (id === 'task') return action.task.title;
  if (id === 'status') return action.task.status;
  if (id === 'priority') return action.task.priority ?? '';
  return id === 'due' ? (action.task.planning.due ?? '') : '';
}

function groups(
  actions: readonly ProjectAction[],
  groupBy: ProjectTasksViewState['groupBy'],
  preference: ProjectTasksTablePreference,
) {
  if (groupBy === 'none') return undefined;
  const buckets = new Map<string, { label: string; rows: ProjectAction[] }>();
  for (const action of actions) {
    let value: string;
    let label: string;
    if (groupBy === 'date') {
      value =
        action.task.planning.due ??
        action.task.planning.scheduled ??
        action.task.planning.start ??
        'none';
      label = value === 'none' ? 'No date' : value;
    } else if (groupBy === 'priority') {
      value = action.task.priority ?? 'D';
      label = `Priority ${value}`;
    } else if (groupBy === 'tag') {
      value = action.task.tags[0] ?? 'none';
      label = value === 'none' ? 'No tag' : value;
    } else {
      value = action.task.statusSymbol;
      label = action.task.status;
    }
    const key = `${groupBy}:${value}`;
    const bucket = buckets.get(key) ?? { label, rows: [] };
    bucket.rows.push(action);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: bucket.label,
    rows: bucket.rows,
    collapsed: preference.collapsedGroups.includes(key),
  }));
}

function makeCellFocusable(cell: HTMLElement, value: string, activate: () => void): void {
  cell.tabIndex = 0;
  if (value) {
    cell.title = value;
    cell.setAttribute('aria-label', value);
  }
  cell.addEventListener('keydown', (event) => {
    if (event.target !== cell || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
}
/** Project Task Table consumes the already-selected canonical action projection. */
export function renderProjectTasksTable(
  parent: HTMLElement,
  actions: readonly ProjectAction[],
  options: ProjectTasksTableOptions,
): VirtualTableHandle {
  const preference = options.preference ?? options.settings.projects.view.tasks.table;
  const tableColumns = columns(preference);
  const grouped = groups(actions, options.groupBy ?? 'none', preference);
  return renderVirtualTable(parent, {
    columns: tableColumns,
    rows: [...actions],
    ...(grouped ? { groups: grouped } : {}),
    key: ({ task }) => `${task.ref.filePath}:${task.ref.line}:${task.ref.revision}`,
    label: 'Project tasks table',
    onColumnResize: (propertyId, width) =>
      options.onPreferenceChange?.(resizeTableColumn(preference, propertyId, width)),
    onGroupToggle: (groupKey, collapsed) =>
      options.onPreferenceChange?.(setTableGroupCollapsed(preference, groupKey, collapsed)),
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
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      for (const column of tableColumns) {
        const cell = row.createDiv({
          cls: 'abyss-virtual-table-cell',
          attr: { role: 'cell', tabindex: '0', 'data-table-column': column.id },
        });
        if (column.id === 'nextAction') {
          makeCellFocusable(cell, 'Next action', activate);
          if (isNextAction(action.task))
            cell.createSpan({
              text: 'List',
              attr: {
                'data-next-action': 'true',
                title: 'Next action',
                'aria-label': 'Next action',
              },
            });
          continue;
        }
        const value = taskCellValue(action, column.id);
        makeCellFocusable(cell, value, activate);
        if (value) cell.createSpan({ text: value, attr: { title: value } });
      }
      return row;
    },
  });
}
