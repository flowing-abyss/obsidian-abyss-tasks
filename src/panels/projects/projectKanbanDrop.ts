import {
  normalizeProjectCellAssignment,
  type ProjectCellChange,
} from '../../projects/projectEdits';
import {
  findFrontmatterProperty,
  findProjectFieldById,
  isAvailableProjectField,
  type ProjectField,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import {
  buildProjectKanbanModel,
  reorderProjectPaths,
  type ProjectKanbanModel,
  type ProjectKanbanModelInput,
} from '../../projects/projectKanbanModel';
import type { ProjectKanbanSettings } from '../../projects/projectKanbanSettings';
import { projectTableGroupLinkIdentity } from '../../projects/projectTableModel';
import { resolveStatus } from '../../projects/status';
import type { Project } from '../../projects/types';
import { evaluateQuery } from '../../query/evaluateQuery';
import { planProjectGroupDrop, type ProjectTableDragGroup } from './projectTableDrag';

export interface ProjectKanbanFieldGuard {
  readonly fieldId: string;
  readonly fieldType: ProjectField['type'];
  readonly sourceProperty: string;
  readonly sourceKey?: string;
  readonly expectedValue: unknown;
  readonly expectedExists: boolean;
}

export interface ProjectKanbanDropSource {
  readonly projectPath: string;
  readonly statusKey: string;
  readonly group: ProjectTableDragGroup;
  readonly statusGuard: ProjectKanbanFieldGuard;
  readonly groupGuard?: ProjectKanbanFieldGuard;
  readonly settingsGuard: {
    readonly groupBy: string;
    readonly sortField: string;
    readonly sortDirection: 'asc' | 'desc';
  };
}

export interface ProjectKanbanDropTarget {
  status: ProjectTableDragGroup;
  group?: ProjectTableDragGroup & { readonly projected?: boolean };
  beforePath?: string;
}

export interface ProjectKanbanDropInput extends Omit<
  ProjectKanbanModelInput,
  'projects' | 'settings'
> {
  project: Project;
  projects: readonly Project[];
  settings: ProjectKanbanSettings;
  source: ProjectKanbanDropSource;
  target: ProjectKanbanDropTarget;
  statusProperty?: string;
  membershipQuery?: string;
  tagsReliable?: boolean;
  search?: string;
  rebase?: (value: unknown, sourcePath: string, destinationPath: string) => unknown;
}

export type ProjectKanbanInsertion =
  | {
      readonly kind: 'before';
      readonly groupKey: string;
      readonly beforePath: string;
      readonly beforeGroupKey?: string;
    }
  | {
      readonly kind: 'after';
      readonly groupKey: string;
      readonly afterPath: string;
      readonly beforeGroupKey?: string;
    }
  | { readonly kind: 'empty'; readonly groupKey: string; readonly beforeGroupKey?: string }
  | { readonly kind: 'none'; readonly groupKey: string };

export type ProjectKanbanDropPlan =
  | { readonly allowed: false; readonly message: string }
  | {
      readonly allowed: true;
      readonly message: string;
      readonly changes: readonly ProjectCellChange[];
      readonly proposedProject: Project;
      readonly model: ProjectKanbanModel;
      readonly insertion: ProjectKanbanInsertion;
      readonly manualOrder?: { readonly statusKey: string; readonly paths: readonly string[] };
    };

interface CaptureProjectKanbanDropSourceInput {
  readonly project: Project;
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly settings: Pick<ProjectKanbanSettings, 'groupBy' | 'sortBy'>;
  readonly statusProperty: string;
  readonly statusKey: string;
  readonly group: ProjectTableDragGroup;
}

function guardFor(
  project: Project,
  field: ProjectField,
  sourceProperty: string,
): ProjectKanbanFieldGuard {
  const source = findFrontmatterProperty(project.frontmatter, sourceProperty);
  return {
    fieldId: field.id,
    fieldType: field.type,
    sourceProperty,
    ...(source === undefined ? {} : { sourceKey: source.key }),
    expectedValue: copyValue(source?.value),
    expectedExists: source !== undefined,
  };
}

function copyValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyValue) : value;
}

/** Captures immutable source capabilities when the native drag starts. */
export function captureProjectKanbanDropSource(
  input: CaptureProjectKanbanDropSourceInput,
): ProjectKanbanDropSource {
  const status = findProjectFieldById(input.fields, 'status');
  if (status === undefined || !isAvailableProjectField(status) || status.type !== 'status') {
    throw new Error('Status is read-only');
  }
  const groupField =
    input.settings.groupBy === 'none' || input.settings.groupBy === 'status'
      ? undefined
      : findProjectFieldById(input.fields, input.settings.groupBy);
  const source: ProjectKanbanDropSource = {
    projectPath: input.project.path,
    statusKey: input.statusKey,
    group: input.group,
    statusGuard: guardFor(input.project, status, input.statusProperty),
    settingsGuard: {
      groupBy: input.settings.groupBy,
      sortField: input.settings.sortBy.field,
      sortDirection: input.settings.sortBy.dir,
    },
  };
  if (groupField === undefined || !isAvailableProjectField(groupField)) return source;
  return {
    ...source,
    groupGuard: guardFor(input.project, groupField, groupField.property ?? ''),
  };
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function validateGuard(
  project: Project,
  field: ProjectField,
  guard: ProjectKanbanFieldGuard,
): void {
  if (field.id !== guard.fieldId || field.type !== guard.fieldType) {
    throw new Error(`${field.label} capability changed during drag`);
  }
  const property = field.type === 'status' ? guard.sourceProperty : field.property;
  const rebound = field.property !== guard.sourceProperty;
  if (rebound || property === undefined || property.length === 0) {
    throw new Error(`${field.label} source changed during drag`);
  }
  const source = findFrontmatterProperty(project.frontmatter, property);
  if (!guardMatches(source, guard)) {
    throw new Error(`${field.label} changed while the project was being dragged`);
  }
}

function guardMatches(
  source: { readonly key: string; readonly value: unknown } | undefined,
  guard: ProjectKanbanFieldGuard,
): boolean {
  const wrongPresence = (source !== undefined) !== guard.expectedExists;
  const wrongValue = !equalValue(source?.value, guard.expectedValue);
  const wrongKey = guard.sourceKey !== undefined && source?.key !== guard.sourceKey;
  return !wrongPresence && !wrongValue && !wrongKey;
}

function changeFor(
  project: Project,
  field: ProjectField,
  guard: ProjectKanbanFieldGuard,
  value: unknown,
): ProjectCellChange {
  validateGuard(project, field, guard);
  return {
    path: project.path,
    field,
    value,
    expectedValue: guard.expectedValue,
    expectedExists: guard.expectedExists,
    sourceProperty: guard.sourceProperty,
    ...(guard.sourceKey === undefined ? {} : { sourceKey: guard.sourceKey }),
  };
}

function statusValue(input: ProjectKanbanDropInput): string | undefined {
  const { key } = input.target.status;
  if (key === 'none') return undefined;
  if (key.startsWith('raw:')) throw new Error('Unknown project status columns are read-only');
  const status = key.startsWith('id:')
    ? input.statuses.find(({ id }) => id === key.slice(3))
    : undefined;
  if (status === undefined) throw new Error('Project status target is unavailable');
  return status.name;
}

function applyChanges(
  source: Project,
  changes: readonly ProjectCellChange[],
  statusProperty: string,
  statuses: ProjectKanbanDropInput['statuses'],
): Project {
  const frontmatter = { ...source.frontmatter };
  for (const change of changes) {
    const assignment = normalizeProjectCellAssignment(change);
    const property = change.sourceKey ?? change.sourceProperty ?? change.field.property;
    if (property === undefined) continue;
    if (assignment.exists) frontmatter[property] = assignment.value;
    else delete frontmatter[property];
  }
  return {
    ...source,
    frontmatter,
    ...resolveStatus({ statusProperty, statuses: [...statuses] }, frontmatter),
  };
}

function currentStatusKey(project: Project): string {
  if (project.statusId !== null) return `id:${project.statusId}`;
  return project.rawStatus === null ? 'none' : `raw:${project.rawStatus}`;
}

interface InsertionInput {
  readonly model: ProjectKanbanModel;
  readonly statusKey: string;
  readonly groupKey: string;
  readonly path: string;
  readonly existingGroupKeys: ReadonlySet<string>;
}

function groupPlacement(
  groupKey: string,
  nextGroup: string | undefined,
  existingGroupKeys: ReadonlySet<string>,
): { readonly beforeGroupKey?: string } {
  return existingGroupKeys.has(groupKey) || nextGroup === undefined
    ? {}
    : { beforeGroupKey: nextGroup };
}

function insertionFor(input: InsertionInput): ProjectKanbanInsertion {
  const groups =
    input.model.columns.find(({ status }) => status.key === input.statusKey)?.groups ?? [];
  const groupIndex = groups.findIndex(({ key }) => key === input.groupKey);
  const group = groups[groupIndex];
  const nextGroup = groups[groupIndex + 1]?.key;
  const placement = groupPlacement(input.groupKey, nextGroup, input.existingGroupKeys);
  if (group === undefined) return { kind: 'none', groupKey: input.groupKey };
  const index = group.projects.findIndex((project) => project.path === input.path);
  if (index < 0) return { kind: 'none', groupKey: input.groupKey };
  const next = group.projects[index + 1];
  if (next !== undefined)
    return { kind: 'before', groupKey: input.groupKey, beforePath: next.path };
  const previous = group.projects[index - 1];
  return previous === undefined
    ? { kind: 'empty', groupKey: input.groupKey, ...placement }
    : { kind: 'after', groupKey: input.groupKey, afterPath: previous.path, ...placement };
}

function forecastGroupKey(model: ProjectKanbanModel, input: ProjectKanbanDropInput): string {
  if (input.target.group !== undefined) return input.target.group.key;
  const column = model.columns.find(({ status }) => status.key === input.target.status.key);
  return (
    column?.groups.find(({ projects }) => projects.some(({ path }) => path === input.project.path))
      ?.key ?? 'all'
  );
}

function destinationOrder(input: ProjectKanbanDropInput): string[] {
  const saved = input.settings.manualOrder[input.target.status.key] ?? [];
  const destination = input.projects
    .filter((project) => currentStatusKey(project) === input.target.status.key)
    .map(({ path }) => path);
  return [...new Set([...saved, ...destination])];
}

interface DropFields {
  readonly status: ProjectField;
  readonly group?: ProjectField;
}

function validateDropSource(input: ProjectKanbanDropInput, model: ProjectKanbanModel): DropFields {
  if (input.project.path !== input.source.projectPath) throw new Error('Dragged project changed');
  if (currentStatusKey(input.project) !== input.source.statusKey) {
    throw new Error('Project status changed while the project was being dragged');
  }
  validateSettingsGuard(input);
  validateSourceOccurrence(input, model);
  const status = statusField(input);
  const group = groupField(input);
  return group === undefined ? { status } : { status, group };
}

function validateSourceOccurrence(input: ProjectKanbanDropInput, model: ProjectKanbanModel): void {
  const occurrence = model.columns
    .find(({ status }) => status.key === input.source.statusKey)
    ?.groups.find(({ key }) => key === input.source.group.key)
    ?.projects.some(({ path }) => path === input.source.projectPath);
  if (occurrence !== true)
    throw new Error('Project group changed while the card was being dragged');
}

function validateTarget(input: ProjectKanbanDropInput, model: ProjectKanbanModel): void {
  const column = model.columns.find(({ status }) => status.key === input.target.status.key);
  if (column === undefined) throw new Error('Project status column is no longer visible');
  const expected = input.target.group;
  if (expected === undefined) return;
  if (expected.projected === true) return;
  const group = column.groups.find(({ key }) => key === expected.key);
  if (group === undefined) throw new Error('Project target group is no longer visible');
  const wrongValue = !equalValue(group.value, expected.value);
  const wrongSource = expected.sourcePath !== undefined && group.sourcePath !== expected.sourcePath;
  if (wrongValue || wrongSource) throw new Error('Project target group changed during drag');
}

function validateSettingsGuard(input: ProjectKanbanDropInput): void {
  const settings = input.source.settingsGuard;
  if (
    input.settings.groupBy !== settings.groupBy ||
    input.settings.sortBy.field !== settings.sortField ||
    input.settings.sortBy.dir !== settings.sortDirection
  ) {
    throw new Error('Project board settings changed during drag');
  }
}

function statusField(input: ProjectKanbanDropInput): ProjectField {
  const status = findProjectFieldById(input.fields, 'status');
  if (status === undefined || !isAvailableProjectField(status) || status.type !== 'status') {
    throw new Error('Status is read-only');
  }
  return status;
}

function groupField(input: ProjectKanbanDropInput): ProjectField | undefined {
  const grouped = input.settings.groupBy !== 'none' && input.settings.groupBy !== 'status';
  if (!grouped || input.target.group === undefined || input.target.group.projected === true) {
    return undefined;
  }
  const group = findProjectFieldById(input.fields, input.settings.groupBy);
  if (group === undefined || !isAvailableProjectField(group)) {
    throw new Error('Project grouping field is read-only');
  }
  if (group.type === 'name' || group.type === 'progress') {
    throw new Error(`${group.label} cannot be changed by moving a card`);
  }
  return group;
}

function groupChange(
  input: ProjectKanbanDropInput,
  field: ProjectField | undefined,
): ProjectCellChange | undefined {
  if (
    field === undefined ||
    input.target.group === undefined ||
    input.target.group.projected === true
  ) {
    return undefined;
  }
  const guard = input.source.groupGuard;
  if (guard === undefined) throw new Error(`${field.label} capability changed during drag`);
  const value = planProjectGroupDrop({
    field,
    currentValue: guard.expectedValue,
    projectPath: input.project.path,
    source: input.source.group,
    target: input.target.group,
    statuses: input.statuses,
    groupIdentity: (raw, sourcePath) =>
      projectTableGroupLinkIdentity(raw, sourcePath, input.resolveLink),
    ...(input.rebase === undefined ? {} : { rebase: input.rebase }),
  });
  const change = changeFor(input.project, field, guard, value);
  return equalValue(change.expectedValue, value) ? undefined : change;
}

function plannedChanges(input: ProjectKanbanDropInput, fields: DropFields): ProjectCellChange[] {
  const changes: ProjectCellChange[] = [];
  const value = statusValue(input);
  const status = changeFor(input.project, fields.status, input.source.statusGuard, value);
  if (!equalValue(status.expectedValue, value)) changes.push(status);
  const group = groupChange(input, fields.group);
  if (group !== undefined) changes.push(group);
  return changes;
}

function validateMovement(
  input: ProjectKanbanDropInput,
  changes: readonly ProjectCellChange[],
): void {
  if (changes.length === 0 && input.settings.sortBy.field !== 'none') {
    throw new Error('Sorted cards already have their computed position');
  }
  const grouped = input.settings.groupBy !== 'none' && input.settings.groupBy !== 'status';
  if (
    input.source.statusKey === input.target.status.key &&
    input.settings.sortBy.field !== 'none' &&
    !grouped
  ) {
    throw new Error('Cards can only be reordered within a column in Manual sort');
  }
}

function projectionSettings(input: ProjectKanbanDropInput): {
  readonly settings: ProjectKanbanSettings;
  readonly manualOrder?: { readonly statusKey: string; readonly paths: readonly string[] };
} {
  if (input.settings.sortBy.field !== 'none') return { settings: input.settings };
  const paths = reorderProjectPaths(
    destinationOrder(input),
    input.project.path,
    input.target.beforePath,
  );
  const manualOrder = { statusKey: input.target.status.key, paths };
  return {
    manualOrder,
    settings: {
      ...input.settings,
      manualOrder: { ...input.settings.manualOrder, [input.target.status.key]: paths },
    },
  };
}

function plan(input: ProjectKanbanDropInput): Exclude<ProjectKanbanDropPlan, { allowed: false }> {
  const currentModel = buildProjectKanbanModel({
    ...input,
    projects: input.projects,
    settings: input.settings,
  });
  const fields = validateDropSource(input, currentModel);
  const changes = plannedChanges(input, fields);
  validateTarget(input, currentModel);
  validateMovement(input, changes);
  const statusProperty = input.statusProperty ?? input.source.statusGuard.sourceProperty;
  const proposedProject = applyChanges(input.project, changes, statusProperty, input.statuses);
  const projection = projectionSettings(input);
  const projects = input.projects.map((project) =>
    project.path === proposedProject.path ? proposedProject : project,
  );
  const model = buildProjectKanbanModel({
    ...input,
    projects,
    settings: projection.settings,
  });
  validateProjectedTarget(input, model);
  const groupKey = forecastGroupKey(model, input);
  const existingGroupKeys = new Set(
    currentModel.columns
      .find(({ status }) => status.key === input.target.status.key)
      ?.groups.map(({ key }) => key) ?? [],
  );
  const reliable = forecastIsReliable(input, proposedProject);
  const insertion = reliable
    ? insertionFor({
        model,
        statusKey: input.target.status.key,
        groupKey,
        path: input.project.path,
        existingGroupKeys,
      })
    : { kind: 'none' as const, groupKey };
  return {
    allowed: true,
    message: `Drop to move ${input.project.name}`,
    changes,
    proposedProject,
    model,
    insertion,
    ...(projection.manualOrder === undefined ? {} : { manualOrder: projection.manualOrder }),
  };
}

function validateProjectedTarget(input: ProjectKanbanDropInput, model: ProjectKanbanModel): void {
  const expected = input.target.group;
  if (expected?.projected !== true) return;
  const group = model.columns
    .find(({ status }) => status.key === input.target.status.key)
    ?.groups.find(({ key }) => key === expected.key);
  const containsProject = group?.projects.some(({ path }) => path === input.source.projectPath);
  const wrongValue = group === undefined || !equalValue(group.value, expected.value);
  const wrongSource = group?.sourcePath !== expected.sourcePath;
  if (containsProject !== true || wrongValue || wrongSource) {
    throw new Error('Project preview target changed during drag');
  }
}

function forecastIsReliable(input: ProjectKanbanDropInput, proposed: Project): boolean {
  const query = input.membershipQuery;
  if (query === undefined || query.length === 0) return true;
  if (query.includes('#') && input.tagsReliable !== true) return false;
  return evaluateQuery(query, proposed.path, proposed.tags, proposed.frontmatter);
}

/** Plans one atomic note assignment and its detached board forecast. */
export function planProjectKanbanDrop(input: ProjectKanbanDropInput): ProjectKanbanDropPlan {
  try {
    return plan(input);
  } catch (error) {
    return { allowed: false, message: error instanceof Error ? error.message : String(error) };
  }
}
