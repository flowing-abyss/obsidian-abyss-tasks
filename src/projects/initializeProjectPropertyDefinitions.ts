import type { ProjectsSettings } from '../settings/types';
import type { ProjectPropertyCatalog } from './ObsidianProjectProperties';
import { captureMissingProjectPropertyDefinitions } from './projectPropertyDefinitions';

interface InitializeProjectPropertyDefinitionsOptions {
  readonly projects: ProjectsSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly save: () => Promise<void>;
}

function hasDefinition(projects: ProjectsSettings, fieldId: string): boolean {
  const definitions: unknown = projects.propertyDefinitions;
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
    return false;
  }
  return Object.keys(definitions).some(
    (key) => key.localeCompare(fieldId, undefined, { sensitivity: 'accent' }) === 0,
  );
}

/** Merges into the shared draft before its first await, then persists that current object. */
export async function initializeProjectPropertyDefinitions(
  options: InitializeProjectPropertyDefinitionsOptions,
): Promise<boolean> {
  const missing = captureMissingProjectPropertyDefinitions(options.projects, options.catalog);
  const definitions = options.projects.propertyDefinitions;
  for (const [fieldId, definition] of Object.entries(missing)) {
    if (!hasDefinition(options.projects, fieldId)) definitions[fieldId] = definition;
  }
  if (Object.keys(missing).length === 0) return false;
  await options.save();
  return true;
}
