import { exactLinkToken, linkValueLabel } from '../markdown/links';
import type { ProjectStatus } from '../settings/types';
import {
  findProjectFieldById,
  isProjectStatusField,
  projectFieldValue,
  type ProjectFieldCatalogItem,
  type ProjectTableSettings,
} from './projectFields';
import type {
  ProjectPropertyDefinition,
  ProjectValuePresentation,
} from './projectPropertyDefinitions';
import {
  compileProjectPropertyPresets,
  compiledProjectPropertyPresentation,
  type CompiledProjectPropertyPresets,
} from './projectPropertyPresets';
import { projectTableLinkTargetParts } from './projectTableLinkTarget';
import { orderedGroups, projectStatusDisplayName, type StatusGroup } from './status';
import type { Project, ProjectStats } from './types';

export interface ProjectProgress {
  done: number;
  total: number;
  percent: number | null;
}

export interface ProjectTableGroup {
  key: string;
  label: string;
  value: unknown;
  sourcePath?: string;
  presentation?: ProjectValuePresentation;
  projects: Project[];
}

interface ProjectTableValueGroup {
  key: string;
  label: string;
  value: unknown;
  sourcePath?: string;
  presentation?: ProjectValuePresentation;
}

function displayNameOr(displayName: string | undefined, fallback: string): string {
  const trimmed = displayName?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
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
  resolveLink?: (target: string, sourcePath: string) => string | undefined;
  propertyDefinitions?: Readonly<Record<string, ProjectPropertyDefinition>>;
}

type ProjectTableLinkResolver = (target: string, sourcePath: string) => string | undefined;

export function projectProgress(stats: ProjectStats): ProjectProgress {
  const total = Math.max(0, stats.total - stats.cancelled);
  return {
    done: stats.done,
    total,
    percent: total === 0 ? null : Math.round((stats.done / total) * 100),
  };
}

export function statusGroupKey(project: Project): string {
  if (project.statusId !== null && project.statusId.length > 0) return `id:${project.statusId}`;
  if (project.rawStatus !== null && project.rawStatus.length > 0) return `raw:${project.rawStatus}`;
  return 'none';
}

function statusLabel(project: Project, statuses: readonly ProjectStatus[]): string {
  if (project.statusId !== null) {
    const status = statuses.find(({ id }) => id === project.statusId);
    return status === undefined ? project.statusId : projectStatusDisplayName(status);
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

/** Resolves one complete cell link to a stable group identity in its original note context. */
export function projectTableGroupLinkIdentity(
  value: string,
  sourcePath: string,
  resolveLink: ProjectTableLinkResolver | undefined,
): string | undefined {
  const link = exactLinkToken(value);
  if (link === undefined) return undefined;
  const target = projectTableLinkTargetParts(link);
  if (target.externalTarget !== undefined) return `link:external:${target.externalTarget}`;
  const resolved = resolveLink?.(target.resolverTarget, sourcePath);
  return resolved === undefined
    ? `link:unresolved:${sourcePath.toLocaleLowerCase()}:${target.resolverTarget.toLocaleLowerCase()}`
    : `link:${resolved.toLocaleLowerCase()}`;
}

function displayScalar(value: unknown): string {
  if (isEmptyValue(value)) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return linkValueLabel(stringValue(value));
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
  if (isProjectStatusField(field)) return [statusLabel(project, statuses)];
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
    linkValueLabel(stringValue(entry)),
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
  if (isProjectStatusField(field)) {
    return compareStatusValues(leftProject, rightProject, statuses);
  }
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
      value: project.statusId ?? project.rawStatus,
      sourcePath: project.path,
    },
  ];
}

function progressValueGroup(project: Project): ProjectTableValueGroup[] {
  const progress = projectProgress(project.stats);
  if (progress.percent === null) {
    return [{ key: 'empty', label: 'No value', value: null, sourcePath: project.path }];
  }
  const label = projectProgressDisplayValue(project.stats);
  return [
    {
      key: `value:${label.toLocaleLowerCase()}`,
      label,
      value: label,
      sourcePath: project.path,
    },
  ];
}

function propertyValueGroup(
  value: unknown,
  project: Project,
  resolveLink: ProjectTableLinkResolver | undefined,
  compiledPresets: CompiledProjectPropertyPresets | undefined,
): ProjectTableValueGroup {
  if (isEmptyValue(value)) {
    return { key: 'empty', label: 'No value', value, sourcePath: project.path };
  }
  const text = stringValue(value);
  const link = exactLinkToken(text);
  let key = `value:${text.toLocaleLowerCase()}`;
  if (link !== undefined) {
    key = projectTableGroupLinkIdentity(text, project.path, resolveLink) ?? key;
  }
  const presentation = compiledProjectPropertyPresentation(compiledPresets, value);
  return {
    key,
    label: displayNameOr(presentation?.displayName, link?.display ?? text),
    value,
    sourcePath: project.path,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function propertyValueGroups(
  project: Project,
  field: ProjectFieldCatalogItem,
  resolveLink: ProjectTableLinkResolver | undefined,
  compiledPresets: CompiledProjectPropertyPresets | undefined,
): ProjectTableValueGroup[] {
  const raw = projectFieldValue(project, field);
  const values = Array.isArray(raw) ? raw : [raw];
  const groups = new Map<string, ProjectTableValueGroup>();
  for (const value of values) {
    const group = propertyValueGroup(value, project, resolveLink, compiledPresets);
    if (!groups.has(group.key)) groups.set(group.key, group);
  }
  return groups.size > 0
    ? [...groups.values()]
    : [{ key: 'empty', label: 'No value', value: null, sourcePath: project.path }];
}

interface GroupValuesInput {
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly statuses: readonly ProjectStatus[];
  readonly resolveLink: ProjectTableModelInput['resolveLink'];
  readonly compiledPresets: CompiledProjectPropertyPresets | undefined;
}

function groupValues(input: GroupValuesInput): ProjectTableValueGroup[] {
  const { project, field, statuses, resolveLink, compiledPresets } = input;
  if (isProjectStatusField(field)) return statusValueGroup(project, statuses);
  if (field.type === 'progress') return progressValueGroup(project);
  return propertyValueGroups(project, field, resolveLink, compiledPresets);
}

interface MakeGroupsInput {
  projects: readonly Project[];
  groupField: ProjectFieldCatalogItem | undefined;
  sortedProjects: readonly Project[];
  availableStatuses: readonly StatusGroup[];
  statuses: readonly ProjectStatus[];
  resolveLink: ProjectTableModelInput['resolveLink'];
  propertyDefinitions?: ProjectTableModelInput['propertyDefinitions'];
}

function makeGroups(input: MakeGroupsInput): ProjectTableGroup[] {
  const {
    projects,
    groupField,
    sortedProjects,
    availableStatuses,
    statuses,
    resolveLink,
    propertyDefinitions,
  } = input;
  if (groupField === undefined || groupField.id === 'none') {
    return [{ key: 'all', label: '', value: null, projects: [...sortedProjects] }];
  }
  const definition = Object.entries(propertyDefinitions ?? {}).find(
    ([id]) => id.localeCompare(groupField.id, undefined, { sensitivity: 'accent' }) === 0,
  )?.[1];
  const compiledPresets = compileProjectPropertyPresets(definition);
  const byKey = new Map<string, ProjectTableGroup>();
  for (const project of projects) {
    for (const group of groupValues({
      project,
      field: groupField,
      statuses,
      resolveLink,
      compiledPresets,
    })) {
      const current = byKey.get(group.key) ?? { ...group, projects: [] };
      current.projects.push(project);
      byKey.set(group.key, current);
    }
  }
  for (const group of byKey.values()) {
    const paths = new Set(group.projects.map(({ path }) => path));
    group.projects = sortedProjects.filter(({ path }) => paths.has(path));
  }
  if (isProjectStatusField(groupField)) {
    return availableStatuses
      .map(({ key, label, statusId }) => {
        const existing = byKey.get(key);
        return {
          key,
          label,
          value: existing?.value ?? statusId,
          ...(existing?.sourcePath === undefined ? {} : { sourcePath: existing.sourcePath }),
          projects: existing?.projects ?? [],
        };
      })
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
  const sortedProjects =
    input.settings.sortBy.field === 'none'
      ? [...visibleProjects]
      : sortProjects(
          visibleProjects,
          findProjectFieldById(input.fields, input.settings.sortBy.field),
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
      resolveLink: input.resolveLink,
      ...(input.propertyDefinitions === undefined
        ? {}
        : { propertyDefinitions: input.propertyDefinitions }),
    }),
    uniqueVisibleCount: visibleProjects.length,
    availableStatusGroups,
  };
}
