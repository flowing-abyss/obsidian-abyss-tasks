import type { ListViewState } from '../settings/types';

export interface TaskKanbanSettings {
  groupBy: Exclude<ListViewState['groupBy'], 'status'>;
  sortBy: ListViewState['sortBy'];
  hiddenStatuses: string[];
  collapsedColumns: string[];
  emptyColumns: 'compact' | 'expanded';
  descriptionLines: 0 | 1 | 2 | 'full';
  showMetadata: boolean;
}

const groupFields: ReadonlyArray<TaskKanbanSettings['groupBy']> = [
  'none',
  'date',
  'priority',
  'tag',
  'source-note',
  'outgoing-link',
];
const sortFields: ReadonlyArray<ListViewState['sortBy']['field']> = [
  'date',
  'priority',
  'title',
  'tag',
  'status',
  'tracked',
  'source-note',
  'outgoing-link',
];
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}
export function defaultTaskKanbanSettings(): TaskKanbanSettings {
  return {
    groupBy: 'none',
    sortBy: { field: 'priority', dir: 'asc' },
    hiddenStatuses: [],
    collapsedColumns: [],
    emptyColumns: 'compact',
    descriptionLines: 1,
    showMetadata: true,
  };
}
export function normalizeTaskKanbanSettings(value: unknown): TaskKanbanSettings {
  const raw = record(value);
  const sort = record(raw['sortBy']);
  const description = raw['descriptionLines'];
  return {
    groupBy: groupFields.includes(raw['groupBy'] as TaskKanbanSettings['groupBy'])
      ? (raw['groupBy'] as TaskKanbanSettings['groupBy'])
      : 'none',
    sortBy: {
      field: sortFields.includes(sort['field'] as ListViewState['sortBy']['field'])
        ? (sort['field'] as ListViewState['sortBy']['field'])
        : 'priority',
      dir: sort['dir'] === 'desc' ? 'desc' : 'asc',
    },
    hiddenStatuses: strings(raw['hiddenStatuses']),
    collapsedColumns: strings(raw['collapsedColumns']),
    emptyColumns: raw['emptyColumns'] === 'expanded' ? 'expanded' : 'compact',
    descriptionLines:
      description === 0 || description === 2 || description === 'full' ? description : 1,
    showMetadata: raw['showMetadata'] !== false,
  };
}
export function isMalformedTaskKanbanSettings(value: unknown): boolean {
  if (value === undefined) return false;
  const raw = record(value);
  if (raw !== value) return true;
  const normalized = normalizeTaskKanbanSettings(raw);
  return Object.entries(normalized).some(([key, expected]) => {
    const actual = raw[key];
    if (actual === undefined) return false;
    if (key === 'sortBy') {
      const sort = record(actual);
      return (
        sort !== actual ||
        !sortFields.includes(sort['field'] as ListViewState['sortBy']['field']) ||
        (sort['dir'] !== 'asc' && sort['dir'] !== 'desc')
      );
    }
    return JSON.stringify(actual) !== JSON.stringify(expected);
  });
}
/** Layout organization is derived; switching never overwrites the saved List preferences. */
export function taskCollectionListState(view: ListViewState): ListViewState {
  if (view.view !== 'kanban') return view;
  const board = normalizeTaskKanbanSettings(view.kanban);
  const result = { ...view, groupBy: board.groupBy, sortBy: board.sortBy };
  delete result.statusGroups;
  return result;
}
export function taskKanbanCustomized(view: ListViewState): boolean {
  return (
    JSON.stringify(normalizeTaskKanbanSettings(view.kanban)) !==
    JSON.stringify(defaultTaskKanbanSettings())
  );
}
