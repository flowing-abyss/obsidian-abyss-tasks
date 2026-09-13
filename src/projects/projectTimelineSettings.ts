import type {
  ProjectColumn,
  ProjectColumnAlignment,
  ProjectDateDisplay,
  ProjectTableProgressDisplay,
  ProjectTableSettings,
} from './projectFields';

export type ProjectTimelineScale = 'day' | 'week' | 'month' | 'quarter' | 'year';

const LEGACY_TIMELINE_FIELDS: readonly ProjectColumn[] = [
  { id: 'status', visible: true },
  { id: 'start', visible: true },
  { id: 'end', visible: true },
];

export interface ProjectTimelineSettings {
  groupBy: string;
  sortBy: ProjectTableSettings['sortBy'];
  hiddenStatuses: string[];
  scale: ProjectTimelineScale;
  fields?: ProjectColumn[];
  showEmptyFields?: boolean;
  descriptionLines?: 0 | 1 | 2 | 'full';
  showMetadata: boolean;
  progress: 'hidden' | ProjectTableProgressDisplay;
  showUnscheduled: boolean;
}

export function projectTimelineFields(settings: ProjectTimelineSettings): readonly ProjectColumn[] {
  return settings.fields ?? LEGACY_TIMELINE_FIELDS;
}

export function projectTimelineDescriptionLines(
  settings: ProjectTimelineSettings,
): NonNullable<ProjectTimelineSettings['descriptionLines']> {
  return settings.descriptionLines ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function normalizedSort(
  value: unknown,
  fallback: ProjectTableSettings['sortBy'],
): ProjectTableSettings['sortBy'] {
  if (!isRecord(value) || typeof value['field'] !== 'string') return { ...fallback };
  const dir = value['dir'] === 'asc' || value['dir'] === 'desc' ? value['dir'] : fallback.dir;
  return { field: value['field'], dir };
}

function normalizedScale(value: unknown): ProjectTimelineScale {
  return value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'quarter' ||
    value === 'year'
    ? value
    : 'month';
}

function normalizedAlignment(value: unknown): ProjectColumnAlignment | undefined {
  return value === 'center' || value === 'right' ? value : undefined;
}

function normalizedDateDisplay(value: unknown): ProjectDateDisplay | undefined {
  return value === 'raw' || value === 'relative' || value === 'pretty' ? value : undefined;
}

function applyNormalizedFieldOptions(
  field: ProjectColumn,
  value: Readonly<Record<string, unknown>>,
): void {
  if (typeof value['label'] === 'string') field.label = value['label'];
  const width = value['width'];
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) field.width = width;
  const alignment = normalizedAlignment(value['alignment']);
  if (alignment !== undefined) field.alignment = alignment;
  const dateDisplay = normalizedDateDisplay(value['dateDisplay']);
  if (dateDisplay !== undefined) field.dateDisplay = dateDisplay;
}

function normalizedField(value: unknown): ProjectColumn | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    return undefined;
  }
  const field: ProjectColumn = {
    id: value['id'],
    visible: typeof value['visible'] === 'boolean' ? value['visible'] : true,
  };
  applyNormalizedFieldOptions(field, value);
  return field;
}

function normalizedDescriptionLines(value: unknown): ProjectTimelineSettings['descriptionLines'] {
  return value === 0 || value === 1 || value === 2 || value === 'full' ? value : undefined;
}

function normalizedProgress(value: unknown): ProjectTimelineSettings['progress'] {
  return value === 'hidden' || value === 'bar' ? value : 'full';
}

export function buildDefaultProjectTimelineSettings(
  table: ProjectTableSettings,
): ProjectTimelineSettings {
  return {
    groupBy: table.groupBy,
    sortBy: { ...table.sortBy },
    hiddenStatuses: [...table.hiddenStatuses],
    scale: 'month',
    fields: LEGACY_TIMELINE_FIELDS.map((field) => ({ ...field })),
    showEmptyFields: true,
    descriptionLines: 0,
    showMetadata: true,
    progress: 'full',
    showUnscheduled: true,
  };
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizedFieldsSetting(
  raw: Readonly<Record<string, unknown>>,
  defaults: ProjectTimelineSettings,
): ProjectColumn[] | undefined {
  if (!hasOwn(raw, 'fields')) return undefined;
  const fields = raw['fields'];
  if (!Array.isArray(fields) || !fields.every(validField)) return defaults.fields;
  return fields.map(normalizedField).filter((field) => field !== undefined);
}

function normalizedBooleanSetting(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean | undefined,
): boolean | undefined {
  if (!hasOwn(raw, key)) return undefined;
  const value = raw[key];
  return typeof value === 'boolean' ? value : fallback;
}

function normalizedDescriptionSetting(
  raw: Readonly<Record<string, unknown>>,
  fallback: ProjectTimelineSettings['descriptionLines'],
): ProjectTimelineSettings['descriptionLines'] {
  if (!hasOwn(raw, 'descriptionLines')) return undefined;
  return normalizedDescriptionLines(raw['descriptionLines']) ?? fallback;
}

export function normalizeProjectTimelineSettings(
  raw: unknown,
  table: ProjectTableSettings,
): ProjectTimelineSettings {
  const defaults = buildDefaultProjectTimelineSettings(table);
  if (!isRecord(raw)) return defaults;
  const fields = normalizedFieldsSetting(raw, defaults);
  const showEmptyFields = normalizedBooleanSetting(
    raw,
    'showEmptyFields',
    defaults.showEmptyFields,
  );
  const descriptionLines = normalizedDescriptionSetting(raw, defaults.descriptionLines);
  return {
    groupBy: typeof raw['groupBy'] === 'string' ? raw['groupBy'] : defaults.groupBy,
    sortBy: normalizedSort(raw['sortBy'], defaults.sortBy),
    hiddenStatuses: uniqueStrings(raw['hiddenStatuses']) ?? defaults.hiddenStatuses,
    scale: normalizedScale(raw['scale']),
    ...(fields === undefined ? {} : { fields }),
    ...(showEmptyFields === undefined ? {} : { showEmptyFields }),
    ...(descriptionLines === undefined ? {} : { descriptionLines }),
    showMetadata:
      typeof raw['showMetadata'] === 'boolean' ? raw['showMetadata'] : defaults.showMetadata,
    progress: normalizedProgress(raw['progress']),
    showUnscheduled:
      typeof raw['showUnscheduled'] === 'boolean'
        ? raw['showUnscheduled']
        : defaults.showUnscheduled,
  };
}

function optional(value: unknown, valid: (candidate: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

function validField(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    typeof value['id'] === 'string' && value['id'].length > 0,
    optional(value['visible'], (candidate) => typeof candidate === 'boolean'),
    optional(value['label'], (candidate) => typeof candidate === 'string'),
    optional(
      value['width'],
      (candidate) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0,
    ),
    optional(value['alignment'], (candidate) => normalizedAlignment(candidate) !== undefined),
    optional(value['dateDisplay'], (candidate) => normalizedDateDisplay(candidate) !== undefined),
  ].every(Boolean);
}

export function isMalformedProjectTimelineSettings(raw: unknown): boolean {
  if (!isRecord(raw)) return true;
  const sort = raw['sortBy'];
  return ![
    optional(raw['groupBy'], (value) => typeof value === 'string'),
    optional(
      sort,
      (value) =>
        isRecord(value) &&
        typeof value['field'] === 'string' &&
        (value['dir'] === 'asc' || value['dir'] === 'desc'),
    ),
    optional(
      raw['hiddenStatuses'],
      (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
    ),
    optional(raw['scale'], (value) =>
      ['day', 'week', 'month', 'quarter', 'year'].includes(String(value)),
    ),
    optional(raw['fields'], (value) => Array.isArray(value) && value.every(validField)),
    optional(raw['showEmptyFields'], (value) => typeof value === 'boolean'),
    optional(
      raw['descriptionLines'],
      (value) => value === 0 || value === 1 || value === 2 || value === 'full',
    ),
    optional(raw['showMetadata'], (value) => typeof value === 'boolean'),
    optional(raw['progress'], (value) => value === 'hidden' || value === 'bar' || value === 'full'),
    optional(raw['showUnscheduled'], (value) => typeof value === 'boolean'),
  ].every(Boolean);
}
