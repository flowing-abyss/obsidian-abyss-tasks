import type { ProjectTableSettings } from './projectFields';
import type { ProjectKanbanSettings } from './projectKanbanSettings';
import {
  buildProjectTableModel,
  prepareProjectSearch,
  type ProjectTableGroup,
  type ProjectTableModelInput,
} from './projectTableModel';
import { orderedGroups, type StatusGroup } from './status';
import type { Project } from './types';

export type ProjectKanbanModelInput = Omit<ProjectTableModelInput, 'settings'> & {
  settings: ProjectKanbanSettings;
};

export interface ProjectKanbanColumn {
  status: StatusGroup;
  groups: ProjectTableGroup[];
  uniqueVisibleCount: number;
}

export interface ProjectKanbanModel {
  columns: ProjectKanbanColumn[];
  availableStatusGroups: StatusGroup[];
  uniqueVisibleCount: number;
}

function statusKey(project: Project): string {
  if (project.statusId !== null && project.statusId.length > 0) return `id:${project.statusId}`;
  if (project.rawStatus !== null && project.rawStatus.length > 0) return `raw:${project.rawStatus}`;
  return 'none';
}

/** Applies saved path ranks while preserving incoming order for unranked projects. */
export function applyProjectPathOrder(
  projects: readonly Project[],
  paths: readonly string[],
): Project[] {
  const rank = new Map<string, number>();
  for (const path of paths) {
    if (!rank.has(path)) rank.set(path, rank.size);
  }
  return projects
    .map((project, index) => ({ project, index, rank: rank.get(project.path) }))
    .sort((left, right) => {
      if (left.rank === undefined && right.rank === undefined) return left.index - right.index;
      if (left.rank === undefined) return 1;
      if (right.rank === undefined) return -1;
      return left.rank - right.rank;
    })
    .map(({ project }) => project);
}

/** Reorders one path without discarding saved paths hidden from the current projection. */
export function reorderProjectPaths(
  paths: readonly string[],
  movingPath: string,
  beforePath?: string,
): string[] {
  const ranked = [...new Set(paths)];
  if (beforePath === movingPath) return ranked;
  const unique = ranked.filter((path) => path !== movingPath);
  const targetIndex = unique.indexOf(beforePath ?? movingPath);
  if (targetIndex < 0) unique.push(movingPath);
  else unique.splice(targetIndex, 0, movingPath);
  return unique;
}

function ranksPath(manualOrder: Readonly<Record<string, string[]>>, path: string): boolean {
  for (const key in manualOrder) {
    if (manualOrder[key]?.includes(path) === true) return true;
  }
  return false;
}

/**
 * The manual order without `path`: drops a bucket it empties and keeps already-empty buckets.
 * Undefined when no bucket ranks `path`.
 */
export function forgetProjectPath(
  manualOrder: Readonly<Record<string, string[]>>,
  path: string,
): Record<string, string[]> | undefined {
  if (!ranksPath(manualOrder, path)) return undefined;
  const next: Record<string, string[]> = {};
  for (const key in manualOrder) {
    const bucket = manualOrder[key] ?? [];
    if (!bucket.includes(path)) {
      next[key] = bucket;
      continue;
    }
    const kept = bucket.filter((candidate) => candidate !== path);
    if (kept.length > 0) next[key] = kept;
  }
  return next;
}

/**
 * The manual order with `newPath` at `oldPath`'s rank in every bucket and no stale `newPath`.
 * Undefined when nothing changes.
 */
export function renameProjectPath(
  manualOrder: Readonly<Record<string, string[]>>,
  oldPath: string,
  newPath: string,
): Record<string, string[]> | undefined {
  if (oldPath === newPath) return undefined;
  if (!ranksPath(manualOrder, oldPath) && !ranksPath(manualOrder, newPath)) return undefined;
  const next: Record<string, string[]> = {};
  for (const key in manualOrder) {
    const bucket = manualOrder[key] ?? [];
    next[key] =
      bucket.includes(oldPath) || bucket.includes(newPath)
        ? renamedBucket(bucket, oldPath, newPath)
        : bucket;
  }
  return next;
}

/** A path that exists at rename time is never its destination, so a bucket's `newPath` is stale. */
function renamedBucket(bucket: readonly string[], oldPath: string, newPath: string): string[] {
  const renamed: string[] = [];
  for (const path of bucket) {
    if (path === oldPath) renamed.push(newPath);
    else if (path !== newPath) renamed.push(path);
  }
  return renamed;
}

function tableSettings(settings: ProjectKanbanSettings): ProjectTableSettings {
  return {
    columns: settings.fields.map((field) => ({ ...field })),
    showDescription: settings.descriptionLines !== 0,
    groupBy: settings.groupBy === 'status' ? 'none' : settings.groupBy,
    sortBy: { ...settings.sortBy },
    hiddenStatuses: [],
  };
}

/** Projects the shared project table model independently inside ordered status columns. */
export function buildProjectKanbanModel(input: ProjectKanbanModelInput): ProjectKanbanModel {
  const { settings, ...sharedInput } = input;
  const search = prepareProjectSearch(
    input.search === undefined ? '' : input.search,
    input.segment,
  );
  const availableStatusGroups = orderedGroups([...input.statuses], [...input.projects]);
  const byStatus = new Map<string, Project[]>();
  for (const project of input.projects) {
    const key = statusKey(project);
    const projects = byStatus.get(key) ?? [];
    projects.push(project);
    byStatus.set(key, projects);
  }
  const hidden = new Set(settings.hiddenStatuses);
  const columns = availableStatusGroups
    .filter((status) => !hidden.has(status.key))
    .map((status): ProjectKanbanColumn => {
      const sourceProjects = byStatus.get(status.key) ?? [];
      const projects =
        settings.sortBy.field === 'none'
          ? applyProjectPathOrder(sourceProjects, settings.manualOrder[status.key] ?? [])
          : [...sourceProjects];
      const model = buildProjectTableModel({
        ...sharedInput,
        search,
        projects,
        settings: tableSettings(settings),
      });
      return {
        status,
        groups: model.groups,
        uniqueVisibleCount: model.uniqueVisibleCount,
      };
    });
  return {
    columns,
    availableStatusGroups,
    uniqueVisibleCount: columns.reduce((total, column) => total + column.uniqueVisibleCount, 0),
  };
}
