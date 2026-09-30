import type { OwnedInferredPropertyClear } from '../../projects/projectEdits';
import {
  findProjectFieldById,
  type ProjectColumn,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import type { ProjectKanbanColumn, ProjectKanbanModel } from '../../projects/projectKanbanModel';
import type { ProjectKanbanSettings } from '../../projects/projectKanbanSettings';
import {
  projectProgress,
  type ProjectTableGroup,
  type ProjectTableModel,
} from '../../projects/projectTableModel';
import type { ProjectTimelineModel } from '../../projects/projectTimelineModel';
import {
  projectTimelineFields,
  type ProjectTimelineSettings,
} from '../../projects/projectTimelineSettings';
import type { Project } from '../../projects/types';
import { projectCardFields } from './projectCardFields';
import {
  projectKanbanCardFields,
  projectKanbanDescription,
  projectKanbanOccurrenceId,
} from './projectKanbanCards';
import type { VisibleProjectColumn } from './projectTableColumns';
import type { ProjectTableSelectableCell } from './projectTableSelection';

/** One selectable cell of an overview view: the identity selection keys it by, and what it edits. */
interface ProjectOverviewCell {
  readonly identity: ProjectTableSelectableCell;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
}

/**
 * A view's selectable cells in display order, with the identities selection reads, the row and
 * column orders that range selection and paste read, and a lookup by occurrence and column.
 */
export interface ProjectOverviewCells {
  readonly cells: readonly ProjectOverviewCell[];
  readonly identities: readonly ProjectTableSelectableCell[];
  readonly rowIds: readonly string[];
  readonly columnIds: readonly string[];
  cell(occurrenceId: string, columnId: string): ProjectOverviewCell | undefined;
}

/** The field a cell edits, which an owned clear receipt may retype while keeping its id. */
export type ProjectOverviewFieldResolver = (
  project: Project,
  field: ProjectFieldCatalogItem,
) => { readonly field: ProjectFieldCatalogItem; readonly ownedClear?: OwnedInferredPropertyClear };

/** One Table row in display order: a group header, or a project occurrence when it has a project. */
export interface ProjectTableRow {
  readonly key: string;
  readonly group: ProjectTableGroup;
  readonly project?: Project;
}

interface OverviewCellsInput<TModel, TSettings> {
  readonly model: TModel;
  readonly settings: TSettings;
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly collapsedGroups: ReadonlySet<string>;
  readonly effectiveField: ProjectOverviewFieldResolver;
}

interface ProjectTableCellsInput {
  readonly model: ProjectTableModel;
  /** Whether the saved `groupBy` groups, which alone gives the Table header rows and collapse. */
  readonly grouped: boolean;
  readonly columns: readonly VisibleProjectColumn[];
  readonly collapsedGroups: ReadonlySet<string>;
  readonly effectiveField: ProjectOverviewFieldResolver;
}

interface CellPlace {
  readonly occurrenceId: string;
  readonly groupKey: string;
  readonly project: Project;
}

export const NO_PROJECT_OVERVIEW_CELLS: ProjectOverviewCells = {
  cells: [],
  identities: [],
  rowIds: [],
  columnIds: [],
  cell: () => undefined,
};

function cellKey(occurrenceId: string, columnId: string): string {
  return `${occurrenceId}\u0000${columnId}`;
}

/** A Table cell keeps its column's id; a card or row cell takes the id of the field it edits. */
function overviewCell(
  place: CellPlace,
  rawField: ProjectFieldCatalogItem,
  effectiveField: ProjectOverviewFieldResolver,
  columnId?: string,
): ProjectOverviewCell {
  const { field, ownedClear } = effectiveField(place.project, rawField);
  return {
    identity: {
      occurrenceId: place.occurrenceId,
      projectPath: place.project.path,
      groupKey: place.groupKey,
      columnId: columnId ?? field.id,
    },
    project: place.project,
    field,
    ownedClear,
  };
}

function indexedCells(
  cells: readonly ProjectOverviewCell[],
  rowIds: readonly string[],
  columnIds: readonly string[],
): ProjectOverviewCells {
  const index = new Map<string, ProjectOverviewCell>();
  for (const cell of cells)
    index.set(cellKey(cell.identity.occurrenceId, cell.identity.columnId), cell);
  return {
    cells,
    identities: cells.map(({ identity }) => identity),
    rowIds,
    columnIds,
    cell: (occurrenceId, columnId) => index.get(cellKey(occurrenceId, columnId)),
  };
}

/** Kanban and Timeline rows and columns are their cells' ids in first-seen order. */
function firstSeenCells(cells: readonly ProjectOverviewCell[]): ProjectOverviewCells {
  const rowIds = new Set<string>();
  const columnIds = new Set<string>();
  for (const { identity } of cells) {
    rowIds.add(identity.occurrenceId);
    columnIds.add(identity.columnId);
  }
  return indexedCells(cells, [...rowIds], [...columnIds]);
}

export function visibleProjectColumns(
  columns: readonly ProjectColumn[],
  fields: readonly ProjectFieldCatalogItem[],
): VisibleProjectColumn[] {
  return columns.flatMap((column) => {
    if (!column.visible) return [];
    const field = findProjectFieldById(fields, column.id);
    return field === undefined ? [] : [{ column, field }];
  });
}

export function projectTableOccurrenceId(groupKey: string, path: string): string {
  return `${encodeURIComponent(groupKey)}:${encodeURIComponent(path)}`;
}

interface TableCellsCollection {
  readonly rows: ProjectTableRow[];
  readonly rowIds: string[];
  readonly cells: ProjectOverviewCell[];
}

/** Appends a group's project rows, and a cell per visible column in each of them. */
function appendTableGroup(
  group: ProjectTableGroup,
  input: ProjectTableCellsInput,
  collection: TableCellsCollection,
): void {
  for (const project of group.projects) {
    const occurrenceId = projectTableOccurrenceId(group.key, project.path);
    collection.rows.push({ key: occurrenceId, group, project });
    collection.rowIds.push(occurrenceId);
    const place = { occurrenceId, groupKey: group.key, project };
    for (const { column, field } of input.columns) {
      collection.cells.push(overviewCell(place, field, input.effectiveField, column.id));
    }
  }
}

/** The Table's rows in display order and the cells of every expanded project row. */
export function projectTableCells(input: ProjectTableCellsInput): {
  readonly rows: readonly ProjectTableRow[];
  readonly cells: ProjectOverviewCells;
} {
  const collection: TableCellsCollection = { rows: [], rowIds: [], cells: [] };
  for (const group of input.model.groups) {
    if (input.grouped) collection.rows.push({ key: `group:${group.key}`, group });
    if (input.grouped && input.collapsedGroups.has(group.key)) continue;
    appendTableGroup(group, input, collection);
  }
  const columnIds = input.columns.map(({ column }) => column.id);
  return {
    rows: collection.rows,
    cells: indexedCells(collection.cells, collection.rowIds, columnIds),
  };
}

/** A collapsed column and a compact empty column show no cards. */
function kanbanColumnExpanded(
  column: ProjectKanbanColumn,
  settings: ProjectKanbanSettings,
): boolean {
  if (settings.collapsedColumns.includes(column.status.key)) return false;
  return column.uniqueVisibleCount !== 0 || settings.emptyColumns !== 'compact';
}

function kanbanDescriptionShown(
  project: Project,
  description: ProjectFieldCatalogItem,
  settings: ProjectKanbanSettings,
): boolean {
  return (
    settings.descriptionLines !== 0 && projectKanbanDescription(project, description).length > 0
  );
}

function kanbanProgressShown(project: Project, settings: ProjectKanbanSettings): boolean {
  if (settings.progress === 'hidden') return false;
  return projectProgress(project.stats).percent !== null || settings.showEmptyProgress;
}

/** Appends a card's cells top to bottom: Name, Description, the card fields, and Progress. */
function appendKanbanCard(
  place: CellPlace,
  input: OverviewCellsInput<ProjectKanbanModel, ProjectKanbanSettings>,
  cells: ProjectOverviewCell[],
): void {
  const { settings, fields, effectiveField } = input;
  const name = findProjectFieldById(fields, 'name');
  if (name !== undefined) cells.push(overviewCell(place, name, effectiveField));
  const description = findProjectFieldById(fields, 'description');
  if (description !== undefined && kanbanDescriptionShown(place.project, description, settings)) {
    cells.push(overviewCell(place, description, effectiveField));
  }
  for (const item of projectKanbanCardFields(place.project, settings, fields)) {
    cells.push(overviewCell(place, item.field, effectiveField));
  }
  const progress = findProjectFieldById(fields, 'progress');
  if (progress !== undefined && kanbanProgressShown(place.project, settings)) {
    cells.push(overviewCell(place, progress, effectiveField));
  }
}

/** Appends the cards of a column's expanded groups; a group's key pairs status and group. */
function appendKanbanColumn(
  column: ProjectKanbanColumn,
  input: OverviewCellsInput<ProjectKanbanModel, ProjectKanbanSettings>,
  cells: ProjectOverviewCell[],
): void {
  const statusKey = column.status.key;
  for (const group of column.groups) {
    if (input.collapsedGroups.has(`${statusKey}\u0000${group.key}`)) continue;
    for (const project of group.projects) {
      const occurrenceId = projectKanbanOccurrenceId(statusKey, group.key, project.path);
      appendKanbanCard({ occurrenceId, groupKey: group.key, project }, input, cells);
    }
  }
}

/** The cards of expanded columns and groups, column by column, each card's cells top to bottom. */
export function projectKanbanCells(
  input: OverviewCellsInput<ProjectKanbanModel, ProjectKanbanSettings>,
): ProjectOverviewCells {
  const cells: ProjectOverviewCell[] = [];
  for (const column of input.model.columns) {
    if (kanbanColumnExpanded(column, input.settings)) appendKanbanColumn(column, input, cells);
  }
  return firstSeenCells(cells);
}

/** Appends a row's summary cells left to right: Name, the metadata fields, and Progress. */
function appendTimelineRow(
  place: CellPlace,
  input: OverviewCellsInput<ProjectTimelineModel, ProjectTimelineSettings>,
  cells: ProjectOverviewCell[],
): void {
  const { settings, fields, effectiveField } = input;
  const name = findProjectFieldById(fields, 'name');
  if (name !== undefined) cells.push(overviewCell(place, name, effectiveField));
  if (settings.showMetadata) {
    const columns = projectTimelineFields(settings);
    for (const item of projectCardFields(place.project, settings, fields, columns)) {
      cells.push(overviewCell(place, item.field, effectiveField));
    }
  }
  const progress = findProjectFieldById(fields, 'progress');
  if (progress !== undefined && settings.progress !== 'hidden') {
    cells.push(overviewCell(place, progress, effectiveField));
  }
}

/** The rows of expanded groups, top to bottom. */
export function projectTimelineCells(
  input: OverviewCellsInput<ProjectTimelineModel, ProjectTimelineSettings>,
): ProjectOverviewCells {
  const cells: ProjectOverviewCell[] = [];
  for (const group of input.model.groups) {
    if (input.collapsedGroups.has(group.key)) continue;
    for (const { occurrenceId, project } of group.rows) {
      appendTimelineRow({ occurrenceId, groupKey: group.key, project }, input, cells);
    }
  }
  return firstSeenCells(cells);
}
