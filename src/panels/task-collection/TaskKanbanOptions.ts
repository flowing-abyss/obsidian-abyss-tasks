import type { TaskStatusDef } from '../../settings/types';
import type { TaskKanbanSettings } from '../../task-lists/taskKanbanSettings';
import type { ViewOptionsRow } from '../../ui/ViewOptionsPopover';

interface TaskKanbanOptionsContext {
  read(): TaskKanbanSettings;
  update(patch: Partial<TaskKanbanSettings>): void;
  statuses(): readonly TaskStatusDef[];
  readonly sort: ViewOptionsRow;
}
function statusRow(context: TaskKanbanOptionsContext): ViewOptionsRow {
  return {
    kind: 'multi',
    icon: 'eye',
    label: 'Show',
    displayValue: () => (context.read().hiddenStatuses.length === 0 ? 'All statuses' : 'Custom'),
    selected: () =>
      context
        .statuses()
        .filter((status) => !context.read().hiddenStatuses.includes(status.id))
        .map((status) => status.id),
    options: context.statuses().map((status) => ({ value: status.id, label: status.name })),
    onToggle: (id) => {
      const hidden = context.read().hiddenStatuses;
      context.update({
        hiddenStatuses: hidden.includes(id)
          ? hidden.filter((value) => value !== id)
          : [...hidden, id],
      });
    },
    presets: [
      {
        label: 'All',
        active: () => context.read().hiddenStatuses.length === 0,
        onSelect: () => {
          context.update({ hiddenStatuses: [] });
        },
      },
    ],
  };
}
function descriptionRow(context: TaskKanbanOptionsContext): ViewOptionsRow {
  const labels: Record<string, string> = {
    '0': 'Hidden',
    '1': '1 line',
    '2': '2 lines',
    full: 'Full',
  };
  const values: Record<string, TaskKanbanSettings['descriptionLines']> = {
    '0': 0,
    '1': 1,
    '2': 2,
    full: 'full',
  };
  return {
    kind: 'single',
    icon: 'text',
    label: 'Description',
    displayValue: () => labels[String(context.read().descriptionLines)] ?? '1 line',
    activeValue: () => String(context.read().descriptionLines),
    options: Object.entries(labels).map(([value, label]) => ({
      value,
      label,
      isDefault: value === '1',
    })),
    onSelect: (value) => {
      context.update({ descriptionLines: values[value] ?? 1 });
    },
  };
}
export function taskKanbanOptionsRows(context: TaskKanbanOptionsContext): ViewOptionsRow[] {
  return [
    {
      kind: 'single',
      icon: 'layout-list',
      label: 'Group by',
      displayValue: () => (context.read().groupBy === 'priority' ? 'Priority' : 'None'),
      activeValue: () => context.read().groupBy,
      options: [
        { value: 'none', label: 'None', isDefault: true },
        { value: 'priority', label: 'Priority' },
      ],
      onSelect: (value) => {
        context.update({ groupBy: value === 'priority' ? 'priority' : 'none' });
      },
    },
    context.sort,
    statusRow(context),
    {
      kind: 'single',
      icon: 'columns-3',
      label: 'Empty columns',
      displayValue: () => (context.read().emptyColumns === 'compact' ? 'Compact' : 'Expanded'),
      activeValue: () => context.read().emptyColumns,
      options: [
        { value: 'compact', label: 'Compact', isDefault: true },
        { value: 'expanded', label: 'Expanded' },
      ],
      onSelect: (value) => {
        context.update({ emptyColumns: value === 'expanded' ? 'expanded' : 'compact' });
      },
    },
    descriptionRow(context),
    {
      kind: 'single',
      icon: 'list',
      label: 'Task metadata',
      displayValue: () => (context.read().showMetadata ? 'Show' : 'Hidden'),
      activeValue: () => (context.read().showMetadata ? 'show' : 'hide'),
      options: [
        { value: 'show', label: 'Show', isDefault: true },
        { value: 'hide', label: 'Hidden' },
      ],
      onSelect: (value) => {
        context.update({ showMetadata: value === 'show' });
      },
    },
  ];
}
