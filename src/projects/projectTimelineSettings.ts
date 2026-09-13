import type { ProjectTableProgressDisplay, ProjectTableSettings } from './projectFields';

export type ProjectTimelineScale = 'week' | 'month' | 'quarter';

export interface ProjectTimelineSettings {
  groupBy: string;
  sortBy: ProjectTableSettings['sortBy'];
  hiddenStatuses: string[];
  scale: ProjectTimelineScale;
  showMetadata: boolean;
  progress: 'hidden' | ProjectTableProgressDisplay;
  showUnscheduled: boolean;
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
  return value === 'week' || value === 'quarter' ? value : 'month';
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
    showMetadata: true,
    progress: 'full',
    showUnscheduled: true,
  };
}

export function normalizeProjectTimelineSettings(
  raw: unknown,
  table: ProjectTableSettings,
): ProjectTimelineSettings {
  const defaults = buildDefaultProjectTimelineSettings(table);
  if (!isRecord(raw)) return defaults;
  return {
    groupBy: typeof raw['groupBy'] === 'string' ? raw['groupBy'] : defaults.groupBy,
    sortBy: normalizedSort(raw['sortBy'], defaults.sortBy),
    hiddenStatuses: uniqueStrings(raw['hiddenStatuses']) ?? defaults.hiddenStatuses,
    scale: normalizedScale(raw['scale']),
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
    optional(raw['scale'], (value) => value === 'week' || value === 'month' || value === 'quarter'),
    optional(raw['showMetadata'], (value) => typeof value === 'boolean'),
    optional(raw['progress'], (value) => value === 'hidden' || value === 'bar' || value === 'full'),
    optional(raw['showUnscheduled'], (value) => typeof value === 'boolean'),
  ].every(Boolean);
}
