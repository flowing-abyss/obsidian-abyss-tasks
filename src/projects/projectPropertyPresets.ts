import { normalizeTag } from '../tags/markdownTagRename';
import type { ProjectPropertyType } from './projectFields';
import {
  isProjectPropertyDefinition,
  type ProjectPropertyPreset,
  type ProjectValuePresentation,
} from './projectPropertyDefinitions';

const TYPE_LABELS: Readonly<Record<ProjectPropertyType, string>> = {
  text: 'Text',
  list: 'List',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  datetime: 'Date & time',
  tags: 'Tags',
};
const PRESET_TYPES = new Set<ProjectPropertyType>(['text', 'list', 'number', 'tags']);

export interface CompiledProjectPropertyPresets {
  readonly presets: readonly ProjectPropertyPreset[];
  readonly presentations: ReadonlyMap<string, ProjectValuePresentation>;
}

const EMPTY_COMPILED_PRESETS: CompiledProjectPropertyPresets = {
  presets: [],
  presentations: new Map(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

const VALUE_COMPATIBILITY: Readonly<Record<ProjectPropertyType, (value: unknown) => boolean>> = {
  text: isNonemptyString,
  list: (value) => isNonemptyString(value) || isFiniteNumber(value),
  number: isFiniteNumber,
  tags: (value) => typeof value === 'string' && normalizeTag(value) !== null,
  checkbox: () => false,
  date: () => false,
  datetime: () => false,
};

function valueIssue(type: ProjectPropertyType, value: unknown): string | undefined {
  if (VALUE_COMPATIBILITY[type](value)) return undefined;
  if (type === 'number') return 'Raw value must be a finite number.';
  if (type === 'tags') return 'Raw value must be a valid tag.';
  if ((type === 'text' || type === 'list') && typeof value === 'string') {
    return 'Raw value cannot be empty.';
  }
  return `Raw value is incompatible with ${TYPE_LABELS[type]}.`;
}

function presentationIsValid(preset: Record<string, unknown>): boolean {
  const display = preset['display'];
  return (
    (preset['displayName'] === undefined || typeof preset['displayName'] === 'string') &&
    (preset['color'] === undefined || typeof preset['color'] === 'string') &&
    (display === undefined || display === 'badge' || display === 'text')
  );
}

function duplicateValue(value: unknown, others: readonly unknown[]): boolean {
  const identity = projectPropertyPresetIdentity(value);
  return others.some((candidate) => {
    if (!isRecord(candidate) || !('value' in candidate)) return false;
    return projectPropertyPresetIdentity(candidate['value']) === identity;
  });
}

function presetIdentityCounts(presets: readonly unknown[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const preset of presets) {
    if (!isRecord(preset) || !('value' in preset)) continue;
    const identity = projectPropertyPresetIdentity(preset['value']);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function presetIssueFromCounts(
  type: ProjectPropertyType,
  preset: unknown,
  counts: ReadonlyMap<string, number>,
): string | undefined {
  if (!isRecord(preset) || !('value' in preset)) return 'Raw value is invalid.';
  const issue = valueIssue(type, preset['value']);
  if (issue !== undefined) return issue;
  if (!presentationIsValid(preset)) return 'Presentation values are invalid.';
  return (counts.get(projectPropertyPresetIdentity(preset['value'])) ?? 0) > 1
    ? 'Raw values must be unique.'
    : undefined;
}

export function projectPropertyPresetIdentity(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

export function projectPropertyPresetIssue(
  type: ProjectPropertyType,
  preset: unknown,
  others: readonly unknown[],
): string | undefined {
  if (!isRecord(preset) || !('value' in preset)) return 'Raw value is invalid.';
  const value = preset['value'];
  const issue = valueIssue(type, value);
  if (issue !== undefined) return issue;
  if (!presentationIsValid(preset)) return 'Presentation values are invalid.';
  if (duplicateValue(value, others)) return 'Raw values must be unique.';
  return undefined;
}

/** Selectable presets; malformed stored entries remain available to the settings repair UI. */
export function compatibleProjectPropertyPresets(definition: unknown): ProjectPropertyPreset[] {
  return [...compileProjectPropertyPresets(definition).presets];
}

/** Compiles validation and exact typed-identity lookup once for a render/model revision. */
export function compileProjectPropertyPresets(definition: unknown): CompiledProjectPropertyPresets {
  if (!isProjectPropertyDefinition(definition) || !PRESET_TYPES.has(definition.type)) {
    return EMPTY_COMPILED_PRESETS;
  }
  const presets: unknown = definition.presets;
  if (!Array.isArray(presets)) return EMPTY_COMPILED_PRESETS;
  const counts = presetIdentityCounts(presets);
  const compatible = presets.filter(
    (preset) => presetIssueFromCounts(definition.type, preset, counts) === undefined,
  ) as ProjectPropertyPreset[];
  const presentations = new Map<string, ProjectValuePresentation>();
  for (const preset of compatible) {
    presentations.set(projectPropertyPresetIdentity(preset.value), preset);
  }
  return { presets: compatible, presentations };
}

export function compiledProjectPropertyPresentation(
  compiled: CompiledProjectPropertyPresets | undefined,
  value: unknown,
): ProjectValuePresentation | undefined {
  return compiled?.presentations.get(projectPropertyPresetIdentity(value));
}
