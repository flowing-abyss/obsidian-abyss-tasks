import type { ProjectColumn, ProjectColumnAlignment, ProjectTableSettings } from './projectFields';

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

function normalizedWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizedAlignment(value: unknown): ProjectColumnAlignment | undefined {
  return value === 'center' || value === 'right' ? value : undefined;
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
  const width = normalizedWidth(value['width']);
  if (width !== undefined) column.width = width;
  const alignment = normalizedAlignment(value['alignment']);
  if (alignment !== undefined) column.alignment = alignment;
  return column;
}

export function buildDefaultProjectTableSettings(): ProjectTableSettings {
  return {
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    showDescription: true,
    groupBy: 'status',
    sortBy: { field: 'start', dir: 'asc' },
    hiddenStatuses: [],
  };
}

function isLegacyDescriptionId(id: string): boolean {
  return id.toLocaleLowerCase() === 'property:description';
}

function normalizeColumns(value: unknown, defaults: readonly ProjectColumn[]): ProjectColumn[] {
  const saved = Array.isArray(value)
    ? value.map(normalizeColumn).filter((column) => column !== undefined)
    : [];
  const presentationColumns = saved.filter(({ id }) => !isLegacyDescriptionId(id));
  const existingIds = new Set(presentationColumns.map(({ id }) => id));
  const columns = [
    ...presentationColumns,
    ...defaults.filter(({ id }) => !existingIds.has(id)).map((column) => ({ ...column })),
  ];
  const nameIndex = columns.findIndex(({ id }) => id === 'name');
  const name = columns.splice(nameIndex, 1)[0] ?? { id: 'name', visible: true };
  name.visible = true;
  columns.unshift(name);
  return columns;
}

function normalizeSort(
  value: unknown,
  fallback: ProjectTableSettings['sortBy'],
): ProjectTableSettings['sortBy'] {
  if (!isRecord(value) || typeof value['field'] !== 'string') return { ...fallback };
  return {
    field: value['field'],
    dir: value['dir'] === 'desc' ? 'desc' : 'asc',
  };
}

/** Deep-fills table defaults while retaining valid saved custom columns and presentation details. */
export function normalizeProjectTableSettings(value: unknown): ProjectTableSettings {
  const defaults = buildDefaultProjectTableSettings();
  if (!isRecord(value)) return defaults;

  const columns = normalizeColumns(value['columns'], defaults.columns);
  const hiddenStatuses = Array.isArray(value['hiddenStatuses'])
    ? value['hiddenStatuses'].filter((status): status is string => typeof status === 'string')
    : [];
  const legacyDescription = Array.isArray(value['columns'])
    ? value['columns']
        .map(normalizeColumn)
        .find((column) => column !== undefined && isLegacyDescriptionId(column.id))
    : undefined;
  const remapDescription = (field: string): string =>
    isLegacyDescriptionId(field) ? 'description' : field;
  const sortBy = normalizeSort(value['sortBy'], defaults.sortBy);

  return {
    columns,
    showDescription:
      typeof value['showDescription'] === 'boolean'
        ? value['showDescription']
        : (legacyDescription?.visible ?? defaults.showDescription),
    groupBy:
      typeof value['groupBy'] === 'string' ? remapDescription(value['groupBy']) : defaults.groupBy,
    sortBy: { ...sortBy, field: remapDescription(sortBy.field) },
    hiddenStatuses,
  };
}
