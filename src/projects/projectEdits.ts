import { parseLinks } from '../markdown/links';
import type { ProjectsSettings } from '../settings/types';
import { findFrontmatterProperty, type ProjectField } from './projectFields';
import type { Project } from './types';

export interface ProjectCellChange {
  path: string;
  field: ProjectField;
  value: unknown;
  expectedValue: unknown;
  /** Exact source provenance used by guarded history operations. */
  sourceProperty?: string;
  sourceKey?: string;
  expectedExists?: boolean;
  valueExists?: boolean;
  restoreSourceValue?: boolean;
}

export interface AppliedProjectCellChange extends ProjectCellChange {
  previousValue: unknown;
  sourceProperty: string;
  sourceKey: string;
  previousExists: boolean;
  appliedExists: boolean;
}

export interface ProjectEditResult {
  applied: AppliedProjectCellChange[];
  failed: Array<{ path: string; message: string }>;
}

/** Returns the source value used for optimistic project-cell guards. */
export function projectCellSourceValue(
  project: Project,
  field: ProjectField,
  settings: ProjectsSettings,
): unknown {
  if (field.type === 'name') return project.name;
  if (field.type === 'progress') return project.stats;
  const property = field.type === 'status' ? settings.statusProperty : field.property;
  if (property === undefined) return undefined;
  return findFrontmatterProperty(project.frontmatter, property)?.value;
}

/** Removes YAML quote wrappers only when they enclose exactly one complete project link. */
export function normalizeProjectLinkInput(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return value;
  const inner = value.slice(1, -1);
  const links = parseLinks(inner);
  if (links.length !== 1 || links[0]?.index !== 0 || links[0].raw.length !== inner.length) {
    return value;
  }
  return inner;
}
