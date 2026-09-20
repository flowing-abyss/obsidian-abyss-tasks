import type { ProjectsSettings } from '../settings/types';
import type { ProjectPropertyCatalog } from './ObsidianProjectProperties';
import {
  captureMissingProjectPropertyDefinitions,
  PROJECT_PROPERTY_DEFINITIONS_VERSION,
} from './projectPropertyDefinitions';
import { sameProjectPropertyName } from './projectPropertyNames';

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
  return Object.keys(definitions).some((key) => sameProjectPropertyName(key, fieldId));
}

/** Merges into the shared draft before its first await, then persists that current object. */
export async function initializeProjectPropertyDefinitions(
  options: InitializeProjectPropertyDefinitionsOptions,
): Promise<boolean> {
  if (options.projects.propertyDefinitionsVersion !== undefined || options.catalog.list() === null)
    return false;
  const missing = captureMissingProjectPropertyDefinitions(options.projects, options.catalog);
  const definitions = options.projects.propertyDefinitions;
  for (const [fieldId, definition] of Object.entries(missing)) {
    if (!hasDefinition(options.projects, fieldId)) definitions[fieldId] = definition;
  }
  options.projects.propertyDefinitionsVersion = PROJECT_PROPERTY_DEFINITIONS_VERSION;
  await options.save();
  return true;
}
