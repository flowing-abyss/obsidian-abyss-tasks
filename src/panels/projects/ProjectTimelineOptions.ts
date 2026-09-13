import type { ProjectFieldCatalogItem, ProjectTableSettings } from '../../projects/projectFields';
import {
  buildDefaultProjectTimelineSettings,
  type ProjectTimelineSettings,
} from '../../projects/projectTimelineSettings';
import type { ViewOption, ViewOptionsRow } from '../../ui/ViewOptionsPopover';

export interface ProjectTimelineOptionsContext {
  readonly settings: () => ProjectTimelineSettings;
  readonly tableSettings: () => ProjectTableSettings;
  readonly fields: () => readonly ProjectFieldCatalogItem[];
  readonly onChange: (mutation: () => void) => Promise<boolean>;
  readonly onScaleChange: (scale: ProjectTimelineSettings['scale']) => Promise<boolean>;
}

function labelFor(context: ProjectTimelineOptionsContext, id: string): string {
  if (id === 'none') return 'None';
  return (
    context.tableSettings().columns.find((column) => column.id === id)?.label ??
    context.fields().find((field) => field.id === id)?.label ??
    id
  );
}

function updateSort(settings: ProjectTimelineSettings, field: string): void {
  if (settings.sortBy.field === field) {
    settings.sortBy.dir = settings.sortBy.dir === 'asc' ? 'desc' : 'asc';
  } else {
    settings.sortBy = { field, dir: 'asc' };
  }
}

function groupOptions(context: ProjectTimelineOptionsContext): ViewOption[] {
  return [
    { value: 'none', label: 'None' },
    ...context.fields().map((field) => ({ value: field.id, label: labelFor(context, field.id) })),
  ];
}

function sortDisplay(context: ProjectTimelineOptionsContext): string {
  const { field, dir } = context.settings().sortBy;
  if (field === 'none') return 'None';
  const arrow = dir === 'asc' ? '↑' : '↓';
  return `${labelFor(context, field)} ${arrow}`;
}

function sortOptionLabel(context: ProjectTimelineOptionsContext, option: ViewOption): string {
  const settings = context.settings();
  if (settings.sortBy.field !== option.value) return String(option.label);
  return `${String(option.label)} ${settings.sortBy.dir === 'asc' ? '↑' : '↓'}`;
}

function single(
  context: ProjectTimelineOptionsContext,
  row: Omit<Extract<ViewOptionsRow, { kind: 'single' }>, 'onSelect'> & {
    readonly mutate: (value: string) => void;
  },
): ViewOptionsRow {
  const { mutate, ...options } = row;
  return {
    ...options,
    kind: 'single',
    onSelect: async (value) => {
      await context.onChange(() => {
        mutate(value);
      });
    },
  };
}

function timelinePresentationRows(context: ProjectTimelineOptionsContext): ViewOptionsRow[] {
  return [
    {
      kind: 'single',
      icon: 'calendar-range',
      label: 'Scale',
      displayValue: () =>
        ({ week: 'Week', month: 'Month', quarter: 'Quarter' })[context.settings().scale],
      activeValue: () => context.settings().scale,
      options: [
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
        { value: 'quarter', label: 'Quarter' },
      ],
      onSelect: async (value) => {
        if (value === 'week' || value === 'month' || value === 'quarter') {
          await context.onScaleChange(value);
        }
      },
    },
    single(context, {
      kind: 'single',
      icon: 'list-tree',
      label: 'Metadata',
      displayValue: () => (context.settings().showMetadata ? 'Shown' : 'Hidden'),
      activeValue: () => String(context.settings().showMetadata),
      options: [
        { value: 'true', label: 'Shown' },
        { value: 'false', label: 'Hidden' },
      ],
      mutate: (value) => {
        context.settings().showMetadata = value === 'true';
      },
    }),
    single(context, {
      kind: 'single',
      icon: 'chart-no-axes-column-increasing',
      label: 'Progress',
      displayValue: () =>
        ({ hidden: 'Hidden', bar: 'Bars', full: 'Bars and numbers' })[context.settings().progress],
      activeValue: () => context.settings().progress,
      options: [
        { value: 'hidden', label: 'Hidden' },
        { value: 'bar', label: 'Bars' },
        { value: 'full', label: 'Bars and numbers' },
      ],
      mutate: (value) => {
        if (value === 'hidden' || value === 'bar' || value === 'full') {
          context.settings().progress = value;
        }
      },
    }),
    single(context, {
      kind: 'single',
      icon: 'calendar-off-2',
      label: 'Unscheduled projects',
      displayValue: () => (context.settings().showUnscheduled ? 'Shown' : 'Hidden'),
      activeValue: () => String(context.settings().showUnscheduled),
      options: [
        { value: 'true', label: 'Shown' },
        { value: 'false', label: 'Hidden' },
      ],
      mutate: (value) => {
        context.settings().showUnscheduled = value === 'true';
      },
    }),
  ];
}

/** Builds Timeline-specific rows in the shared project options popover. */
export function projectTimelineOptionsRows(
  context: ProjectTimelineOptionsContext,
): ViewOptionsRow[] {
  const options = groupOptions(context);
  return [
    single(context, {
      kind: 'single',
      icon: 'layout-list',
      label: 'Group by',
      displayValue: () => labelFor(context, context.settings().groupBy),
      activeValue: () => context.settings().groupBy,
      options,
      mutate: (value) => {
        context.settings().groupBy = value;
      },
    }),
    single(context, {
      kind: 'single',
      icon: 'arrow-up-down',
      label: 'Sort by',
      displayValue: () => sortDisplay(context),
      activeValue: () => context.settings().sortBy.field,
      options: options.map((option) => ({
        ...option,
        label: () => sortOptionLabel(context, option),
      })),
      mutate: (value) => {
        updateSort(context.settings(), value);
      },
    }),
    {
      kind: 'group',
      icon: 'gantt-chart',
      label: 'Timeline',
      displayValue: '4 options',
      rows: timelinePresentationRows(context),
    },
  ];
}

export function isProjectTimelineCustomized(
  settings: ProjectTimelineSettings,
  table: ProjectTableSettings,
): boolean {
  return JSON.stringify(settings) !== JSON.stringify(buildDefaultProjectTimelineSettings(table));
}
