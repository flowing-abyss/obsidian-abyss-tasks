import { exactLinkToken, linkValueLabel } from '../markdown/links';
import type { ProjectStatus } from '../settings/types';
import { formatTrackedDuration, totalMs } from '../tasks';
import {
  findProjectFieldById,
  isGroupableProjectField,
  isProjectStatusField,
  projectFieldValue,
  type ProjectFieldCatalogItem,
  type ProjectTableSettings,
} from './projectFields';
import type {
  ProjectPropertyDefinition,
  ProjectValuePresentation,
} from './projectPropertyDefinitions';
import { sameProjectPropertyName } from './projectPropertyNames';
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
  /** The instant every running timer is measured against, so one pass reads one clock. */
  nowMs?: number;
}

type ProjectTableLinkResolver = (target: string, sourcePath: string) => string | undefined;

const MS_PER_MINUTE = 60_000;

/** Tracked time a project has reached at one instant, so a whole table sorts against one clock. */
function projectTrackedMs(stats: ProjectStats, nowMs: number): number {
  return totalMs(stats.tracked, nowMs);
}

/**
 * Tracked time as the compact label the tracking surfaces already use. Part minutes have not been
 * earned yet, so anything below a whole minute reads as nothing at all and untracked projects stay
 * quiet instead of filling a column with zeros.
 */
export function projectTrackedDisplayValue(stats: ProjectStats, nowMs: number): string {
  const ms = projectTrackedMs(stats, nowMs);
  return ms < MS_PER_MINUTE ? '' : formatTrackedDuration(ms);
}

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
  nowMs: number,
): string[] {
  if (isProjectStatusField(field)) return [statusLabel(project, statuses)];
  if (field.type === 'progress') return [projectProgressDisplayValue(project.stats)];
  if (field.type === 'tracked') return [projectTrackedDisplayValue(project.stats, nowMs)];
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

/** A project with nothing to show pins last in both directions, the way an empty value does. */
function sortableTrackedMs(stats: ProjectStats, nowMs: number): number | null {
  const ms = projectTrackedMs(stats, nowMs);
  return ms < MS_PER_MINUTE ? null : ms;
}

function sortableValue(
  project: Project,
  field: ProjectFieldCatalogItem | undefined,
  nowMs: number,
): unknown {
  if (field === undefined) return null;
  if (field.type === 'progress') return projectProgress(project.stats).percent;
  if (field.type === 'tracked') return sortableTrackedMs(project.stats, nowMs);
  const value = projectFieldValue(project, field);
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (field.type === 'checkbox') return typeof value === 'boolean' ? value : null;
  return value;
}

/** What one ordering pass compares against, including the clock every running timer is read at. */
interface SortContext {
  readonly field: ProjectFieldCatalogItem | undefined;
  readonly direction: 'asc' | 'desc';
  readonly statuses: readonly ProjectStatus[];
  readonly nowMs: number;
}

function comparePopulatedValues(
  leftProject: Project,
  rightProject: Project,
  context: SortContext,
): number {
  const { field, statuses, nowMs } = context;
  if (field === undefined) return 0;
  if (isProjectStatusField(field)) {
    return compareStatusValues(leftProject, rightProject, statuses);
  }
  const left = sortableValue(leftProject, field, nowMs);
  const right = sortableValue(rightProject, field, nowMs);
  if (field.type === 'number' || field.type === 'progress' || field.type === 'tracked') {
    return Number(left) - Number(right);
  }
  if (field.type === 'checkbox') return Number(left) - Number(right);
  return compareStrings(textualSortValue(left), textualSortValue(right));
}

function sortProjects(projects: readonly Project[], context: SortContext): Project[] {
  const { field, direction, nowMs } = context;
  return [...projects].sort((left, right) => {
    const leftValue = sortableValue(left, field, nowMs);
    const rightValue = sortableValue(right, field, nowMs);
    const nullableOrder = compareNullable(leftValue, rightValue);
    if (nullableOrder !== 0) return nullableOrder;
    const byField = comparePopulatedValues(left, right, context);
    if (byField !== 0) return direction === 'asc' ? byField : -byField;
    return stableProjectOrder(left, right);
  });
}

/** The visible text a search runs against, read at the same clock as the rest of the pass. */
interface SearchContext {
  readonly fields: readonly ProjectFieldCatalogItem[];
  readonly statuses: readonly ProjectStatus[];
  readonly nowMs: number;
}

function matchesSearch(project: Project, search: string, context: SearchContext): boolean {
  if (search.length === 0) return true;
  if (project.name.toLocaleLowerCase().includes(search)) return true;
  return context.fields.some((field) =>
    projectTableDisplayValues(project, field, context.statuses, context.nowMs).some((value) =>
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

function orderGroupProjects(
  groups: Iterable<ProjectTableGroup>,
  sortedProjects: readonly Project[],
): void {
  const groupsByPath = new Map<string, Set<ProjectTableGroup>>();
  for (const group of groups) {
    for (const { path } of group.projects) {
      groupsByPath.get(path)?.add(group) ?? groupsByPath.set(path, new Set([group]));
    }
    group.projects = [];
  }
  for (const project of sortedProjects) {
    for (const group of groupsByPath.get(project.path) ?? []) group.projects.push(project);
  }
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
  const definition = Object.entries(propertyDefinitions ?? {}).find(([id]) =>
    sameProjectPropertyName(id, groupField.id),
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
  orderGroupProjects(byKey.values(), sortedProjects);
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
  // One clock for the whole pass, so every running timer is compared and shown at the same instant.
  const nowMs = input.nowMs ?? Date.now();
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
      matchesSearch(project, search, {
        fields: visibleFields,
        statuses: input.statuses,
        nowMs,
      }),
  );
  const sortedProjects =
    input.settings.sortBy.field === 'none'
      ? [...visibleProjects]
      : sortProjects(visibleProjects, {
          field: findProjectFieldById(input.fields, input.settings.sortBy.field),
          direction: input.settings.sortBy.dir,
          statuses: input.statuses,
          nowMs,
        });
  // Saved state can still name a field the options no longer offer, which then groups everything.
  const savedGroupField = findProjectFieldById(input.fields, input.settings.groupBy);
  const groupField =
    savedGroupField !== undefined && isGroupableProjectField(savedGroupField)
      ? savedGroupField
      : undefined;
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
