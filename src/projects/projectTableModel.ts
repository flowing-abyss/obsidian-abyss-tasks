import type { ProjectStatus } from '../settings/types';
import {
  findProjectFieldById,
  projectFieldValue,
  type ProjectFieldCatalogItem,
  type ProjectTableSettings,
} from './projectFields';
import { orderedGroups, type StatusGroup } from './status';
import type { Project, ProjectStats } from './types';

export interface ProjectProgress {
  done: number;
  total: number;
  percent: number | null;
}

interface ProjectTableGroup {
  key: string;
  label: string;
  value: unknown;
  projects: Project[];
}

interface ProjectTableValueGroup {
  key: string;
  label: string;
  value: unknown;
}

export interface ProjectTableModel {
  groups: ProjectTableGroup[];
  uniqueVisibleCount: number;
  availableStatusGroups: StatusGroup[];
}

export interface ProjectTableModelInput {
  projects: readonly Project[];
  fields: readonly ProjectFieldCatalogItem[];
  statuses: readonly ProjectStatus[];
  settings: ProjectTableSettings;
  search?: string;
}

export function projectProgress(stats: ProjectStats): ProjectProgress {
  const total = Math.max(0, stats.total - stats.cancelled);
  return {
    done: stats.done,
    total,
    percent: total === 0 ? null : Math.round((stats.done / total) * 100),
  };
}

function statusGroupKey(project: Project): string {
  if (project.statusId !== null && project.statusId.length > 0) return `id:${project.statusId}`;
  if (project.rawStatus !== null && project.rawStatus.length > 0) return `raw:${project.rawStatus}`;
  return 'none';
}

function statusLabel(project: Project, statuses: readonly ProjectStatus[]): string {
  if (project.statusId !== null) {
    return statuses.find(({ id }) => id === project.statusId)?.label ?? project.statusId;
  }
  return project.rawStatus ?? 'No status';
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function linkLabel(value: string): string {
  if (!value.startsWith('[[') || !value.endsWith(']]')) return value;
  const inner = value.slice(2, -2);
  const separator = inner.indexOf('|');
  if (separator >= 0) return inner.slice(separator + 1);
  return inner.slice(inner.lastIndexOf('/') + 1);
}

function displayScalar(value: unknown): string {
  if (isEmptyValue(value)) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return linkLabel(stringValue(value));
}

export function projectProgressDisplayValue(stats: ProjectStats): string {
  const progress = projectProgress(stats);
  return progress.percent === null
    ? '—'
    : `${progress.percent}% (${progress.done}/${progress.total})`;
}

/** Returns the exact text values exposed by a project table cell. */
export function projectTableDisplayValues(
  project: Project,
  field: ProjectFieldCatalogItem,
  statuses: readonly ProjectStatus[],
): string[] {
  if (field.type === 'status') return [statusLabel(project, statuses)];
  if (field.type === 'progress') return [projectProgressDisplayValue(project.stats)];
  const value = projectFieldValue(project, field);
  const values = Array.isArray(value) ? value : [value];
  return values.length === 0 ? ['—'] : values.map((entry) => displayScalar(entry));
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareStatusValues(
  leftProject: Project,
  rightProject: Project,
  statuses: readonly ProjectStatus[],
): number {
  const order = new Map(statuses.map(({ id }, index) => [id, index]));
  const leftOrder =
    leftProject.statusId === null ? statuses.length : order.get(leftProject.statusId);
  const rightOrder =
    rightProject.statusId === null ? statuses.length : order.get(rightProject.statusId);
  const orderResult = (leftOrder ?? statuses.length) - (rightOrder ?? statuses.length);
  return orderResult !== 0
    ? orderResult
    : compareStrings(statusLabel(leftProject, statuses), statusLabel(rightProject, statuses));
}

function textualSortValue(value: unknown): string {
  const displayed = (Array.isArray(value) ? value : [value]).map((entry) =>
    linkLabel(stringValue(entry)),
  );
  return [...new Set(displayed)].sort(compareStrings).join('\0');
}

/** Empty values compare after populated values. Direction is applied only to populated values. */
function compareNullable(left: unknown, right: unknown): number {
  const leftEmpty = isEmptyValue(left);
  const rightEmpty = isEmptyValue(right);
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;
  return 0;
}

function stableProjectOrder(left: Project, right: Project): number {
  const byName = compareStrings(left.name, right.name);
  return byName !== 0 ? byName : compareStrings(left.path, right.path);
}

function sortableValue(project: Project, field: ProjectFieldCatalogItem | undefined): unknown {
  if (field === undefined) return null;
  if (field.type === 'progress') return projectProgress(project.stats).percent;
  const value = projectFieldValue(project, field);
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (field.type === 'checkbox') return typeof value === 'boolean' ? value : null;
  return value;
}

function comparePopulatedValues(
  leftProject: Project,
  rightProject: Project,
  field: ProjectFieldCatalogItem | undefined,
  statuses: readonly ProjectStatus[],
): number {
  if (field === undefined) return 0;
  if (field.type === 'status') return compareStatusValues(leftProject, rightProject, statuses);
  const left = sortableValue(leftProject, field);
  const right = sortableValue(rightProject, field);
  if (field.type === 'number' || field.type === 'progress') {
    return Number(left) - Number(right);
  }
  if (field.type === 'checkbox') return Number(left) - Number(right);
  return compareStrings(textualSortValue(left), textualSortValue(right));
}

function sortProjects(
  projects: readonly Project[],
  field: ProjectFieldCatalogItem | undefined,
  direction: 'asc' | 'desc',
  statuses: readonly ProjectStatus[],
): Project[] {
  return [...projects].sort((left, right) => {
    const leftValue = sortableValue(left, field);
    const rightValue = sortableValue(right, field);
    const nullableOrder = compareNullable(leftValue, rightValue);
    if (nullableOrder !== 0) return nullableOrder;
    const byField = comparePopulatedValues(left, right, field, statuses);
    if (byField !== 0) return direction === 'asc' ? byField : -byField;
    return stableProjectOrder(left, right);
  });
}

function matchesSearch(
  project: Project,
  search: string,
  fields: readonly ProjectFieldCatalogItem[],
  statuses: readonly ProjectStatus[],
): boolean {
  if (search.length === 0) return true;
  if (project.name.toLocaleLowerCase().includes(search)) return true;
  return fields.some((field) =>
    projectTableDisplayValues(project, field, statuses).some((value) =>
      value.toLocaleLowerCase().includes(search),
    ),
  );
}

function statusValueGroup(
  project: Project,
  statuses: readonly ProjectStatus[],
): ProjectTableValueGroup[] {
  return [
    {
      key: statusGroupKey(project),
      label: statusLabel(project, statuses),
      value: project.statusId,
    },
  ];
}

function progressValueGroup(project: Project): ProjectTableValueGroup[] {
  const progress = projectProgress(project.stats);
  if (progress.percent === null) return [{ key: 'empty', label: 'No value', value: null }];
  const label = projectProgressDisplayValue(project.stats);
  return [{ key: `value:${label.toLocaleLowerCase()}`, label, value: label }];
}

function propertyValueGroups(
  project: Project,
  field: ProjectFieldCatalogItem,
): ProjectTableValueGroup[] {
  const raw = projectFieldValue(project, field);
  const values = Array.isArray(raw) ? raw : [raw];
  const groups = new Map<string, ProjectTableValueGroup>();
  for (const value of values) {
    const empty = isEmptyValue(value);
    const label = empty ? 'No value' : linkLabel(stringValue(value));
    const key = empty ? 'empty' : `value:${stringValue(value).toLocaleLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, label, value });
  }
  return groups.size > 0
    ? [...groups.values()]
    : [{ key: 'empty', label: 'No value', value: null }];
}

function groupValues(
  project: Project,
  field: ProjectFieldCatalogItem,
  statuses: readonly ProjectStatus[],
): ProjectTableValueGroup[] {
  if (field.type === 'status') return statusValueGroup(project, statuses);
  if (field.type === 'progress') return progressValueGroup(project);
  return propertyValueGroups(project, field);
}

interface MakeGroupsInput {
  projects: readonly Project[];
  groupField: ProjectFieldCatalogItem | undefined;
  sortedProjects: readonly Project[];
  availableStatuses: readonly StatusGroup[];
  statuses: readonly ProjectStatus[];
}

function makeGroups(input: MakeGroupsInput): ProjectTableGroup[] {
  const { projects, groupField, sortedProjects, availableStatuses, statuses } = input;
  if (groupField === undefined || groupField.id === 'none') {
    return [{ key: 'all', label: '', value: null, projects: [...sortedProjects] }];
  }
  const byKey = new Map<string, ProjectTableGroup>();
  for (const project of projects) {
    for (const group of groupValues(project, groupField, statuses)) {
      const current = byKey.get(group.key) ?? { ...group, projects: [] };
      current.projects.push(project);
      byKey.set(group.key, current);
    }
  }
  for (const group of byKey.values()) {
    const paths = new Set(group.projects.map(({ path }) => path));
    group.projects = sortedProjects.filter(({ path }) => paths.has(path));
  }
  if (groupField.type === 'status') {
    return availableStatuses
      .map(({ key, label, statusId }) => ({
        key,
        label,
        value: statusId,
        projects: byKey.get(key)?.projects ?? [],
      }))
      .filter(({ projects: groupProjects }) => groupProjects.length > 0);
  }
  return [...byKey.values()].sort((left, right) => {
    const emptyOrder = compareNullable(left.value, right.value);
    return emptyOrder !== 0 ? emptyOrder : compareStrings(left.label, right.label);
  });
}

export function buildProjectTableModel(input: ProjectTableModelInput): ProjectTableModel {
  const availableStatusGroups = orderedGroups([...input.statuses], [...input.projects]);
  const hidden = new Set(input.settings.hiddenStatuses);
  const visibleFields = input.settings.columns
    .filter(({ visible }) => visible)
    .map(({ id }) => findProjectFieldById(input.fields, id))
    .filter((field) => field !== undefined);
  const search = input.search?.trim().toLocaleLowerCase() ?? '';
  const visibleProjects = input.projects.filter(
    (project) =>
      !hidden.has(statusGroupKey(project)) &&
      matchesSearch(project, search, visibleFields, input.statuses),
  );
  const sortField = findProjectFieldById(input.fields, input.settings.sortBy.field);
  const sortedProjects = sortProjects(
    visibleProjects,
    sortField,
    input.settings.sortBy.dir,
    input.statuses,
  );
  const groupField = findProjectFieldById(input.fields, input.settings.groupBy);
  return {
    groups: makeGroups({
      projects: visibleProjects,
      groupField,
      sortedProjects,
      availableStatuses: availableStatusGroups,
      statuses: input.statuses,
    }),
    uniqueVisibleCount: visibleProjects.length,
    availableStatusGroups,
  };
}
