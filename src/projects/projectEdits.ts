import { parseLinks } from '../markdown/links';
import type { ProjectsSettings } from '../settings/types';
import type { ProjectNativePropertySnapshot } from './ObsidianProjectProperties';
import { ProjectEditValidationError } from './projectEditError';
import {
  findFrontmatterProperty,
  type ProjectField,
  type ProjectFieldCatalogItem,
  type ProjectPropertyType,
} from './projectFields';
import type { Project } from './types';

const ownedInferredPropertyClear = Symbol('OwnedInferredPropertyClear');

/** Session-only proof that this exact cell owned the disappearance of an inferred property. */
export interface OwnedInferredPropertyClear {
  readonly path: string;
  readonly fieldId: string;
  readonly sourceProperty: string;
  readonly sourceKey: string;
  readonly type: ProjectPropertyType;
  readonly nativeSource: 'inferred';
  readonly [ownedInferredPropertyClear]: true;
}

export function createOwnedInferredPropertyClear(
  value: Omit<OwnedInferredPropertyClear, typeof ownedInferredPropertyClear | 'nativeSource'>,
): OwnedInferredPropertyClear {
  return Object.freeze({
    ...value,
    nativeSource: 'inferred' as const,
    [ownedInferredPropertyClear]: true as const,
  });
}

export function copyOwnedInferredPropertyClear(
  value: OwnedInferredPropertyClear | undefined,
): OwnedInferredPropertyClear | undefined {
  return isOwnedInferredPropertyClear(value)
    ? createOwnedInferredPropertyClear({
        path: value.path,
        fieldId: value.fieldId,
        sourceProperty: value.sourceProperty,
        sourceKey: value.sourceKey,
        type: value.type,
      })
    : undefined;
}

export function isOwnedInferredPropertyClear(value: unknown): value is OwnedInferredPropertyClear {
  return (
    typeof value === 'object' &&
    value !== null &&
    ownedInferredPropertyClear in value &&
    (value as { [ownedInferredPropertyClear]?: unknown })[ownedInferredPropertyClear] === true
  );
}

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
  ownedClear?: OwnedInferredPropertyClear;
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

function samePropertyName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

/** Restores the editor type only for the exact absent cell owned by a clear receipt. */
export function projectFieldWithOwnedClear(
  project: Project,
  field: ProjectFieldCatalogItem,
  native: ProjectNativePropertySnapshot,
  ownedClear: OwnedInferredPropertyClear | undefined,
): ProjectFieldCatalogItem {
  if (field.type !== null || native.kind !== 'available') return field;
  if (!isOwnedInferredPropertyClear(ownedClear)) return field;
  const invalid = [
    native.property !== undefined,
    native.assignment.kind !== 'none',
    ownedClear.path !== project.path,
    ownedClear.fieldId !== field.id,
    !samePropertyName(ownedClear.sourceProperty, field.property),
    !samePropertyName(ownedClear.sourceKey, field.property),
    findFrontmatterProperty(project.frontmatter, field.property) !== undefined,
  ].some(Boolean);
  if (invalid) return field;
  return { ...field, type: ownedClear.type };
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

function isEmptyProjectAssignment(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalizeProjectAssignmentLinks(value: unknown): unknown {
  if (typeof value === 'string') return normalizeProjectLinkInput(value);
  if (!Array.isArray(value)) return value;
  return (value as unknown[]).map((entry) =>
    typeof entry === 'string' ? normalizeProjectLinkInput(entry) : entry,
  );
}

/** Normalizes the value/presence pair shared by project writes and drop forecasts. */
export function normalizeProjectCellAssignment(
  change: Pick<ProjectCellChange, 'field' | 'value' | 'restoreSourceValue' | 'valueExists'>,
): { readonly value: unknown; readonly exists: boolean } {
  if (change.restoreSourceValue === true) {
    if (change.valueExists === undefined) {
      const subject = change.field.type === 'status' ? 'Status' : 'Project';
      throw new ProjectEditValidationError(
        `${subject} history receipt is missing source provenance.`,
      );
    }
    return {
      value: change.valueExists ? change.value : undefined,
      exists: change.valueExists,
    };
  }
  const { value } = change;
  if (isEmptyProjectAssignment(value)) {
    return { value: undefined, exists: false };
  }
  return {
    value: change.field.type === 'status' ? value : normalizeProjectAssignmentLinks(value),
    exists: true,
  };
}
