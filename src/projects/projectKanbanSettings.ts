import type { ProjectColumn, ProjectColumnAlignment, ProjectTableSettings } from './projectFields';

export type ProjectOverviewMode = 'table' | 'kanban';

export interface ProjectKanbanSettings {
  fields: ProjectColumn[];
  showEmptyFields: boolean;
  descriptionLines: 0 | 1 | 2;
  progress: 'hidden' | 'bar' | 'full';
  showEmptyProgress: boolean;
  emptyColumns: 'expanded' | 'compact';
  groupBy: string;
  sortBy: ProjectTableSettings['sortBy'];
  hiddenStatuses: string[];
  collapsedColumns: string[];
  manualOrder: Record<string, string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function normalizedWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizedAlignment(value: unknown): ProjectColumnAlignment | undefined {
  return value === 'center' || value === 'right' ? value : undefined;
}

function normalizeField(value: unknown): ProjectColumn | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    return undefined;
  }
  const field: ProjectColumn = {
    id: value['id'],
    visible: typeof value['visible'] === 'boolean' ? value['visible'] : true,
  };
  if (typeof value['label'] === 'string') field.label = value['label'];
  const width = normalizedWidth(value['width']);
  if (width !== undefined) field.width = width;
  const alignment = normalizedAlignment(value['alignment']);
  if (alignment !== undefined) field.alignment = alignment;
  if (value['dateDisplay'] === 'relative') field.dateDisplay = 'relative';
  return field;
}

function normalizeManualOrder(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, paths]) => {
      const normalized = uniqueStrings(paths);
      return normalized === undefined ? [] : [[key, normalized]];
    }),
  );
}

function normalizeSort(
  value: unknown,
  fallback: ProjectTableSettings['sortBy'],
): ProjectTableSettings['sortBy'] {
  if (!isRecord(value) || typeof value['field'] !== 'string') return { ...fallback };
  return {
    field: value['field'],
    dir: value['dir'] === 'asc' || value['dir'] === 'desc' ? value['dir'] : fallback.dir,
  };
}

function normalizedDescriptionLines(
  value: unknown,
  fallback: ProjectKanbanSettings['descriptionLines'],
): ProjectKanbanSettings['descriptionLines'] {
  return value === 0 || value === 1 || value === 2 ? value : fallback;
}

function normalizedProgress(
  value: unknown,
  fallback: ProjectKanbanSettings['progress'],
): ProjectKanbanSettings['progress'] {
  return value === 'hidden' || value === 'bar' || value === 'full' ? value : fallback;
}

function normalizedEmptyColumns(
  value: unknown,
  fallback: ProjectKanbanSettings['emptyColumns'],
): ProjectKanbanSettings['emptyColumns'] {
  return value === 'expanded' || value === 'compact' ? value : fallback;
}

function normalizedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Initializes board preferences without sharing mutable table state. */
export function buildDefaultProjectKanbanSettings(
  table: ProjectTableSettings,
): ProjectKanbanSettings {
  return {
    fields: [
      { id: 'start', visible: true },
      { id: 'end', visible: true },
    ],
    showEmptyFields: false,
    descriptionLines: 1,
    progress: 'full',
    showEmptyProgress: false,
    emptyColumns: 'compact',
    groupBy: table.groupBy,
    sortBy: { ...table.sortBy },
    hiddenStatuses: [...table.hiddenStatuses],
    collapsedColumns: [],
    manualOrder: {},
  };
}

/** Normalizes active board preferences; persistence separately retains malformed raw values. */
export function normalizeProjectKanbanSettings(
  raw: unknown,
  table: ProjectTableSettings,
): ProjectKanbanSettings {
  const defaults = buildDefaultProjectKanbanSettings(table);
  if (!isRecord(raw)) return defaults;
  const fields = Array.isArray(raw['fields'])
    ? raw['fields'].map(normalizeField).filter((field) => field !== undefined)
    : defaults.fields;
  return {
    fields,
    showEmptyFields: normalizedBoolean(raw['showEmptyFields'], defaults.showEmptyFields),
    descriptionLines: normalizedDescriptionLines(
      raw['descriptionLines'],
      defaults.descriptionLines,
    ),
    progress: normalizedProgress(raw['progress'], defaults.progress),
    showEmptyProgress: normalizedBoolean(raw['showEmptyProgress'], defaults.showEmptyProgress),
    emptyColumns: normalizedEmptyColumns(raw['emptyColumns'], defaults.emptyColumns),
    groupBy: typeof raw['groupBy'] === 'string' ? raw['groupBy'] : defaults.groupBy,
    sortBy: normalizeSort(raw['sortBy'], defaults.sortBy),
    hiddenStatuses: uniqueStrings(raw['hiddenStatuses']) ?? defaults.hiddenStatuses,
    collapsedColumns: uniqueStrings(raw['collapsedColumns']) ?? defaults.collapsedColumns,
    manualOrder: normalizeManualOrder(raw['manualOrder']) ?? defaults.manualOrder,
  };
}

function validOptional(value: unknown, validate: (candidate: unknown) => boolean): boolean {
  return value === undefined || validate(value);
}

function isValidField(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    typeof value['id'] === 'string' && value['id'].length > 0,
    validOptional(value['visible'], (candidate) => typeof candidate === 'boolean'),
    validOptional(value['label'], (candidate) => typeof candidate === 'string'),
    validOptional(value['width'], (candidate) => normalizedWidth(candidate) !== undefined),
    validOptional(value['alignment'], (candidate) => normalizedAlignment(candidate) !== undefined),
    validOptional(value['dateDisplay'], (candidate) => candidate === 'relative'),
  ].every(Boolean);
}

function isValidStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValidFields(value: unknown): boolean {
  return Array.isArray(value) && value.every(isValidField);
}

function isValidSort(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value['field'] === 'string' && (value['dir'] === 'asc' || value['dir'] === 'desc');
}

function isValidManualOrder(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isValidStringArray);
}

/** Reports malformed known board fields while allowing additive unknown keys. */
export function isMalformedProjectKanbanSettings(raw: unknown): boolean {
  if (!isRecord(raw)) return true;
  return ![
    validOptional(raw['fields'], isValidFields),
    validOptional(raw['showEmptyFields'], (value) => typeof value === 'boolean'),
    validOptional(raw['descriptionLines'], (value) => value === 0 || value === 1 || value === 2),
    validOptional(
      raw['progress'],
      (value) => value === 'hidden' || value === 'bar' || value === 'full',
    ),
    validOptional(raw['showEmptyProgress'], (value) => typeof value === 'boolean'),
    validOptional(raw['emptyColumns'], (value) => value === 'expanded' || value === 'compact'),
    validOptional(raw['groupBy'], (value) => typeof value === 'string'),
    validOptional(raw['sortBy'], isValidSort),
    validOptional(raw['hiddenStatuses'], isValidStringArray),
    validOptional(raw['collapsedColumns'], isValidStringArray),
    validOptional(raw['manualOrder'], isValidManualOrder),
  ].every(Boolean);
}
