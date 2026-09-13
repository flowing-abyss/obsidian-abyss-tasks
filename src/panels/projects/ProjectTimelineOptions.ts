import type { ProjectFieldCatalogItem, ProjectTableSettings } from '../../projects/projectFields';
import {
  buildDefaultProjectTimelineSettings,
  projectTimelineDescriptionLines,
  projectTimelineFields,
  type ProjectTimelineSettings,
} from '../../projects/projectTimelineSettings';
import type { ViewOption, ViewOptionsRow } from '../../ui/ViewOptionsPopover';
import { projectCardFieldsOptionsRow } from './projectCardFields';

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
    context.settings().fields?.find((field) => field.id === id)?.label ??
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

const SCALE_LABELS = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
} as const;

function scaleRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return {
    kind: 'single',
    icon: 'calendar-range',
    label: 'Scale',
    displayValue: () => SCALE_LABELS[context.settings().scale],
    activeValue: () => context.settings().scale,
    options: Object.entries(SCALE_LABELS).map(([value, label]) => ({ value, label })),
    onSelect: async (value) => {
      if (value in SCALE_LABELS) {
        await context.onScaleChange(value as ProjectTimelineSettings['scale']);
      }
    },
  };
}

function metadataRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return single(context, {
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
  });
}

function descriptionLines(value: string): NonNullable<ProjectTimelineSettings['descriptionLines']> {
  const values: Readonly<Record<string, NonNullable<ProjectTimelineSettings['descriptionLines']>>> =
    {
      '0': 0,
      '1': 1,
      '2': 2,
      full: 'full',
    };
  return values[value] ?? 0;
}

function descriptionDisplay(context: ProjectTimelineOptionsContext): string {
  const lines = projectTimelineDescriptionLines(context.settings());
  if (lines === 0) return 'Hidden';
  if (lines === 1) return '1 line';
  return lines === 2 ? '2 lines' : 'Full';
}

function descriptionRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return single(context, {
    kind: 'single',
    icon: 'text',
    label: 'Description',
    displayValue: () => descriptionDisplay(context),
    activeValue: () => String(projectTimelineDescriptionLines(context.settings())),
    options: [
      { value: '0', label: 'Hidden', isDefault: true },
      { value: '1', label: '1 line' },
      { value: '2', label: '2 lines' },
      { value: 'full', label: 'Full' },
    ],
    mutate: (value) => {
      context.settings().descriptionLines = descriptionLines(value);
    },
  });
}

function progressRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return single(context, {
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
  });
}

function emptyFieldsRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return single(context, {
    kind: 'single',
    icon: 'rows-3',
    label: 'Empty fields',
    displayValue: () => ((context.settings().showEmptyFields ?? true) ? 'Show' : 'Hide'),
    activeValue: () => ((context.settings().showEmptyFields ?? true) ? 'show' : 'hide'),
    options: [
      { value: 'hide', label: 'Hide' },
      { value: 'show', label: 'Show', isDefault: true },
    ],
    mutate: (value) => {
      context.settings().showEmptyFields = value === 'show';
    },
  });
}

function unscheduledRow(context: ProjectTimelineOptionsContext): ViewOptionsRow {
  return single(context, {
    kind: 'single',
    icon: 'calendar-days',
    label: 'Unscheduled',
    displayValue: () => (context.settings().showUnscheduled ? 'Shown' : 'Hidden'),
    activeValue: () => String(context.settings().showUnscheduled),
    options: [
      { value: 'true', label: 'Shown' },
      { value: 'false', label: 'Hidden' },
    ],
    mutate: (value) => {
      context.settings().showUnscheduled = value === 'true';
    },
  });
}

function timelinePresentationRows(context: ProjectTimelineOptionsContext): ViewOptionsRow[] {
  return [
    scaleRow(context),
    metadataRow(context),
    projectCardFieldsOptionsRow(context, {
      label: 'Metadata fields',
      fallbackFields: projectTimelineFields(context.settings()),
    }),
    descriptionRow(context),
    progressRow(context),
    emptyFieldsRow(context),
    unscheduledRow(context),
  ];
}

/** Builds Timeline-specific rows in the shared project options popover. */
export function projectTimelineOptionsRows(
  context: ProjectTimelineOptionsContext,
): ViewOptionsRow[] {
  const groupingOptions = groupOptions(context);
  return [
    single(context, {
      kind: 'single',
      icon: 'layout-list',
      label: 'Group by',
      displayValue: () => labelFor(context, context.settings().groupBy),
      activeValue: () => context.settings().groupBy,
      options: groupingOptions,
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
      options: groupingOptions.map((option) => ({
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
      displayValue: '7 options',
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
