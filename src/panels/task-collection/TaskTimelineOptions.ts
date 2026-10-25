import type { TaskStatusDef } from '../../settings/types';
import type { TaskTimelineSettings } from '../../task-lists/taskTimelineSettings';
import type { ViewOptionsRow } from '../../ui/ViewOptionsPopover';
import { TIMELINE_SCALES } from '../timeline/timelinePresentation';
import {
  taskDescriptionOptionsRow,
  taskMetadataOptionsRow,
  taskStatusOptionsRow,
} from './TaskKanbanOptions';
interface Context {
  read(): TaskTimelineSettings;
  update(patch: Partial<TaskTimelineSettings>): void;
  statuses(): readonly TaskStatusDef[];
  readonly group: ViewOptionsRow;
  readonly sort: ViewOptionsRow;
}
function visibilityRow(
  context: Context,
  field: 'showScheduled' | 'showUnscheduled',
  label: string,
  icon: string,
): ViewOptionsRow {
  return {
    kind: 'single',
    label,
    icon,
    displayValue: () => (context.read()[field] ? 'Show' : 'Hidden'),
    activeValue: () => String(context.read()[field]),
    options: [
      { value: 'true', label: 'Show', isDefault: true },
      { value: 'false', label: 'Hidden' },
    ],
    onSelect: (value) => {
      context.update({ [field]: value === 'true' });
    },
  };
}
export function taskTimelineOptionsRows(context: Context): ViewOptionsRow[] {
  return [
    context.group,
    context.sort,
    taskStatusOptionsRow(context),
    {
      kind: 'single',
      icon: 'calendar-range',
      label: 'Scale',
      displayValue: () =>
        TIMELINE_SCALES.find(([value]) => value === context.read().scale)?.[1] ?? 'Month',
      activeValue: () => context.read().scale,
      options: TIMELINE_SCALES.map(([value, label]) => ({
        value,
        label,
        isDefault: value === 'month',
      })),
      onSelect: (value) => {
        const scale = TIMELINE_SCALES.find(([candidate]) => candidate === value)?.[0];
        if (scale !== undefined) context.update({ scale });
      },
    },
    taskDescriptionOptionsRow(context),
    taskMetadataOptionsRow(context),
    visibilityRow(context, 'showScheduled', 'Scheduled', 'diamond'),
    visibilityRow(context, 'showUnscheduled', 'Undated tasks', 'calendar-off'),
  ];
}
