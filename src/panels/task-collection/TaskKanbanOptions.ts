import type { TaskStatusDef } from '../../settings/types';
import { ACTIVE_STATUS_GROUPS } from '../../status/statusConstants';
import type { TaskKanbanSettings } from '../../task-lists/taskKanbanSettings';
import type { ViewOptionsRow } from '../../ui/ViewOptionsPopover';

type TaskCardOptionsSettings = Pick<
  TaskKanbanSettings,
  'hiddenStatuses' | 'descriptionLines' | 'showMetadata'
>;
interface TaskCardOptionsContext {
  read(): TaskCardOptionsSettings;
  update(patch: Partial<TaskCardOptionsSettings>): void;
  statuses(): readonly TaskStatusDef[];
}
interface TaskKanbanOptionsContext {
  read(): TaskKanbanSettings;
  update(patch: Partial<TaskKanbanSettings>): void;
  statuses(): readonly TaskStatusDef[];
  readonly sort: ViewOptionsRow;
  readonly group: ViewOptionsRow;
}
export function taskStatusOptionsRow(context: TaskCardOptionsContext): ViewOptionsRow {
  const offered = new Map(context.statuses().map((status) => [status.id, { ...status }]));
  const inactive = (): string[] =>
    context
      .statuses()
      .filter((status) => !ACTIVE_STATUS_GROUPS.includes(status.type))
      .map((status) => status.id);
  const activeOnly = (): boolean => {
    const hidden = context.read().hiddenStatuses;
    const expected = inactive();
    return (
      expected.length > 0 &&
      context
        .statuses()
        .every((status) => hidden.includes(status.id) === expected.includes(status.id))
    );
  };
  return {
    kind: 'multi',
    preserveOrder: true,
    icon: 'eye',
    label: 'Show',
    displayValue: () => {
      if (context.read().hiddenStatuses.length === 0) return 'All statuses';
      return activeOnly() ? 'Active' : 'Custom';
    },
    selected: () =>
      context
        .statuses()
        .filter((status) => !context.read().hiddenStatuses.includes(status.id))
        .map((status) => status.id),
    options: context.statuses().map((status) => ({ value: status.id, label: status.name })),
    onToggle: (id) => {
      const previous = offered.get(id);
      const current = context.statuses().find((status) => status.id === id);
      if (
        previous === undefined ||
        previous.name !== current?.name ||
        previous.symbol !== current.symbol ||
        previous.type !== current.type
      )
        return;
      const hidden = context.read().hiddenStatuses;
      context.update({
        hiddenStatuses: hidden.includes(id)
          ? hidden.filter((value) => value !== id)
          : [...hidden, id],
      });
    },
    presets: [
      {
        label: 'Active',
        active: activeOnly,
        onSelect: () => {
          context.update({ hiddenStatuses: inactive() });
        },
      },
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
export function taskDescriptionOptionsRow(context: TaskCardOptionsContext): ViewOptionsRow {
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
    context.group,
    context.sort,
    taskStatusOptionsRow(context),
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
    taskDescriptionOptionsRow(context),
    taskMetadataOptionsRow(context),
  ];
}

export function taskMetadataOptionsRow(context: TaskCardOptionsContext): ViewOptionsRow {
  return {
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
  };
}
