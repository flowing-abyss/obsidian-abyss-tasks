import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { ProjectKanbanSettings } from '../../projects/projectKanbanSettings';
import type { Project } from '../../projects/types';
import { projectCardDescription, projectCardFields } from './projectCardFields';

export function projectKanbanCardKey(groupKey: string, projectPath: string): string {
  return `${groupKey}\u0000${projectPath}`;
}

export function projectKanbanOccurrenceId(
  statusKey: string,
  groupKey: string,
  projectPath: string,
): string {
  return `${statusKey}\u0000${groupKey}\u0000${projectPath}`;
}

/** Resolves ordered visible card fields from the shared catalog and board preferences. */
export function projectKanbanCardFields(
  project: Project,
  settings: ProjectKanbanSettings,
  fields: readonly ProjectFieldCatalogItem[],
): ReturnType<typeof projectCardFields> {
  return projectCardFields(project, settings, fields);
}

export function projectKanbanDescription(
  project: Project,
  field: ProjectFieldCatalogItem | undefined,
): string {
  return projectCardDescription(project, field);
}
