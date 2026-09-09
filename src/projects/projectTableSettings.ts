import type { ProjectColumn, ProjectTableSettings } from './projectFields';

const DEFAULT_COLUMNS: readonly ProjectColumn[] = [
  { id: 'name', visible: true },
  { id: 'status', visible: true },
  { id: 'progress', visible: true },
  { id: 'start', visible: true },
  { id: 'end', visible: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeColumn(value: unknown): ProjectColumn | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    return undefined;
  }
  const column: ProjectColumn = {
    id: value['id'],
    visible: typeof value['visible'] === 'boolean' ? value['visible'] : true,
  };
  if (typeof value['label'] === 'string') column.label = value['label'];
  if (typeof value['width'] === 'number' && Number.isFinite(value['width']) && value['width'] > 0) {
    column.width = value['width'];
  }
  return column;
}

export function buildDefaultProjectTableSettings(): ProjectTableSettings {
  return {
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    groupBy: 'status',
    sortBy: { field: 'end', dir: 'asc' },
    hiddenStatuses: [],
  };
}

function normalizeColumns(value: unknown, defaults: readonly ProjectColumn[]): ProjectColumn[] {
  const saved = Array.isArray(value)
    ? value.map(normalizeColumn).filter((column) => column !== undefined)
    : [];
  const existingIds = new Set(saved.map(({ id }) => id));
  const columns = [
    ...saved,
    ...defaults.filter(({ id }) => !existingIds.has(id)).map((column) => ({ ...column })),
  ];
  const nameIndex = columns.findIndex(({ id }) => id === 'name');
  const name = columns.splice(nameIndex, 1)[0] ?? { id: 'name', visible: true };
  name.visible = true;
  columns.unshift(name);
  return columns;
}

/** Deep-fills table defaults while retaining valid saved custom columns and presentation details. */
export function normalizeProjectTableSettings(value: unknown): ProjectTableSettings {
  const defaults = buildDefaultProjectTableSettings();
  if (!isRecord(value)) return defaults;

  const columns = normalizeColumns(value['columns'], defaults.columns);
  const sortBy = isRecord(value['sortBy']) ? value['sortBy'] : undefined;
  const direction = sortBy?.['dir'] === 'desc' ? 'desc' : 'asc';
  const sortField = typeof sortBy?.['field'] === 'string' ? sortBy['field'] : defaults.sortBy.field;
  const hiddenStatuses = Array.isArray(value['hiddenStatuses'])
    ? value['hiddenStatuses'].filter((status): status is string => typeof status === 'string')
    : [];

  return {
    columns,
    groupBy: typeof value['groupBy'] === 'string' ? value['groupBy'] : defaults.groupBy,
    sortBy: { field: sortField, dir: direction },
    hiddenStatuses,
  };
}
