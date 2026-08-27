import { evaluateQuery } from '../../query/evaluateQuery';
import { parseProjectRange } from '../projectDates';
import type {
  AcceptedWorkNoteAudit,
  WorkNoteAuditResult,
  WorkNoteAuditSource,
  WorkNoteCompatibilityPreset,
  WorkNoteDiagnostic,
  WorkNoteKindMarker,
  WorkNoteSnapshot,
  WorkNoteSourceFile,
} from './types';

export type { WorkNoteAuditSource } from './types';

const FIELD_KEYS: readonly (keyof WorkNoteCompatibilityPreset['fields'])[] = [
  'project',
  'status',
  'priority',
  'description',
  'start',
  'end',
  'created',
  'updated',
  'id',
  'milestone',
  'blockedBy',
  'related',
];

const DEFAULT_FIELDS: WorkNoteCompatibilityPreset['fields'] = {
  project: 'Project',
  status: 'Status',
  priority: 'Priority',
  description: 'Description',
  start: 'Start',
  end: 'End',
  created: 'Created',
  updated: 'Updated',
  id: 'ID',
  milestone: 'Milestone',
  blockedBy: 'Blocked by',
  related: 'Related',
};

export function buildDisabledWorkNotePreset(): WorkNoteCompatibilityPreset {
  return {
    revision: 1,
    enabled: false,
    membershipQuery: '',
    ordinaryKindQuery: '',
    milestoneKindQuery: '',
    folder: '',
    fields: { ...DEFAULT_FIELDS },
    rawStatusByStatusId: {},
  };
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableObject(entry)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function computeWorkNotePresetFingerprint(preset: WorkNoteCompatibilityPreset): string {
  const audited = {
    revision: preset.revision,
    enabled: preset.enabled,
    membershipQuery: preset.membershipQuery,
    ordinaryKindQuery: preset.ordinaryKindQuery,
    milestoneKindQuery: preset.milestoneKindQuery,
    folder: preset.folder,
    fields: preset.fields,
    rawStatusByStatusId: preset.rawStatusByStatusId,
    creation: preset.creation ?? null,
  };
  return `work-note-preset:v2:${JSON.stringify(stableObject(audited))}`;
}

export function isAuditAccepted(preset: WorkNoteCompatibilityPreset): boolean {
  const accepted = preset.acceptedAudit;
  return (
    preset.enabled &&
    validAcceptedAudit(accepted) &&
    accepted.acceptedRevision === preset.revision &&
    accepted.presetFingerprint === computeWorkNotePresetFingerprint(preset)
  );
}

function validAcceptedAudit(value: unknown): value is AcceptedWorkNoteAudit {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const accepted = value as Record<string, unknown>;
  const capabilities = accepted['capabilities'];
  return (
    typeof accepted['presetFingerprint'] === 'string' &&
    accepted['presetFingerprint'].length > 0 &&
    typeof accepted['acceptedRevision'] === 'number' &&
    typeof accepted['acceptedAt'] === 'string' &&
    accepted['acceptedAt'].length > 0 &&
    capabilities !== null &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    typeof (capabilities as Record<string, unknown>)['update'] === 'boolean' &&
    typeof (capabilities as Record<string, unknown>)['create'] === 'boolean'
  );
}

export function acceptWorkNoteAudit(
  preset: WorkNoteCompatibilityPreset,
  capabilities: AcceptedWorkNoteAudit['capabilities'],
  acceptedAt: string,
): WorkNoteCompatibilityPreset {
  return {
    ...preset,
    acceptedAudit: {
      presetFingerprint: computeWorkNotePresetFingerprint(preset),
      acceptedRevision: preset.revision,
      acceptedAt,
      capabilities: { ...capabilities },
    },
  };
}

function normalizeTag(tag: string): string {
  return tag.startsWith('#') ? tag.toLowerCase() : `#${tag.toLowerCase()}`;
}

function inFolder(path: string, folder: string): boolean {
  if (!folder) return true;
  let normalized = folder;
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return path.startsWith(`${normalized}/`);
}

function wikilinkPath(raw: string): string | null {
  const match = /^!?\[\[([^\]]+)\]\]$/u.exec(raw.trim());
  if (!match?.[1]) return null;
  const target = match[1].split('|', 1)[0]?.split('#', 1)[0]?.trim();
  return target || null;
}

function rawEntries(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function duplicateBasename(source: WorkNoteAuditSource, linkpath: string): boolean {
  if (linkpath.includes('/')) return false;
  const expected = linkpath.replace(/\.md$/u, '');
  let count = 0;
  const paths = source.allPaths?.() ?? source.files().map(({ path }) => path);
  for (const path of paths) {
    const basename = path.split('/').pop()?.replace(/\.md$/u, '');
    if (basename === expected) count += 1;
    if (count > 1) return true;
  }
  return false;
}

interface ResolvedLinks {
  readonly paths: readonly string[];
  readonly diagnostics: readonly WorkNoteDiagnostic[];
  readonly linkCount: number;
}

function resolveLinks(
  raw: unknown,
  sourcePath: string,
  field: string,
  source: WorkNoteAuditSource,
  relation: boolean,
): ResolvedLinks {
  const paths: string[] = [];
  const diagnostics: WorkNoteDiagnostic[] = [];
  let linkCount = 0;
  for (const entry of rawEntries(raw)) {
    if (typeof entry !== 'string') {
      diagnostics.push({
        type: relation ? 'invalid-relation-entry' : 'invalid-project-entry',
        field,
        rawValue: entry,
      });
      continue;
    }
    const linkpath = wikilinkPath(entry);
    if (!linkpath) {
      diagnostics.push({
        type: relation ? 'invalid-relation-entry' : 'invalid-project-entry',
        field,
        rawValue: entry,
      });
      continue;
    }
    linkCount += 1;
    if (duplicateBasename(source, linkpath)) {
      diagnostics.push({
        type: relation ? 'ambiguous-relation' : 'ambiguous-project',
        field,
        rawValue: entry,
      });
      continue;
    }
    const resolved = source.resolveLink(linkpath, sourcePath);
    if (resolved) {
      paths.push(resolved);
      continue;
    }
    let type: WorkNoteDiagnostic['type'];
    if (relation) type = 'broken-relation';
    else type = 'broken-project';
    diagnostics.push({
      type,
      field,
      rawValue: entry,
    });
  }
  return { paths, diagnostics, linkCount };
}

function reverseStatusMap(preset: WorkNoteCompatibilityPreset): {
  readonly reverse: ReadonlyMap<string, string>;
  readonly issues: readonly WorkNoteDiagnostic[];
} {
  const reverse = new Map<string, string>();
  const issues: WorkNoteDiagnostic[] = [];
  const mappings = Object.entries(preset.rawStatusByStatusId);
  if (mappings.length === 0) issues.push({ type: 'invalid-status-mapping' });
  for (const [statusId, rawStatus] of mappings) {
    if (!statusId.trim() || !rawStatus.trim()) {
      issues.push({ type: 'invalid-status-mapping', rawValue: { statusId, rawStatus } });
      continue;
    }
    if (reverse.has(rawStatus)) {
      issues.push({ type: 'ambiguous-status-mapping', rawValue: rawStatus });
      continue;
    }
    reverse.set(rawStatus, statusId);
  }
  return { reverse, issues };
}

function scalarString(
  raw: unknown,
  field: string,
  type: 'non-scalar-status' | 'non-scalar-date',
  diagnostics: WorkNoteDiagnostic[],
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw;
  diagnostics.push({ type, field, rawValue: raw });
  return undefined;
}

function projectSnapshot(
  file: WorkNoteSourceFile,
  preset: WorkNoteCompatibilityPreset,
  source: WorkNoteAuditSource,
  reverseStatuses: ReadonlyMap<string, string>,
): {
  readonly snapshot?: WorkNoteSnapshot;
  readonly diagnostics: readonly WorkNoteDiagnostic[];
  readonly candidate: boolean;
} {
  const diagnostics: WorkNoteDiagnostic[] = [];
  const tags = file.tags.map(normalizeTag);
  const frontmatter = file.frontmatter as Record<string, unknown>;
  const folderMatch = inFolder(file.path, preset.folder);
  if (!folderMatch) {
    diagnostics.push({ type: 'outside-folder' });
  }
  const membershipMatch = evaluateQuery(preset.membershipQuery, file.path, tags, frontmatter);
  if (!membershipMatch) {
    diagnostics.push({ type: 'membership-mismatch' });
  }
  const ordinary = evaluateQuery(preset.ordinaryKindQuery, file.path, tags, frontmatter);
  const milestone = evaluateQuery(preset.milestoneKindQuery, file.path, tags, frontmatter);
  if (ordinary === milestone) {
    diagnostics.push({ type: ordinary ? 'ambiguous-kind' : 'missing-kind' });
  }

  const project = resolveLinks(
    frontmatter[preset.fields.project],
    file.path,
    'project',
    source,
    false,
  );
  diagnostics.push(...project.diagnostics);
  if (project.linkCount === 0) diagnostics.push({ type: 'missing-project' });
  if (project.linkCount > 1 || project.paths.length > 1) {
    diagnostics.push({ type: 'multiple-projects', rawValue: frontmatter[preset.fields.project] });
  }

  const blockedBy = resolveLinks(
    frontmatter[preset.fields.blockedBy],
    file.path,
    'blockedBy',
    source,
    true,
  );
  const related = resolveLinks(
    frontmatter[preset.fields.related],
    file.path,
    'related',
    source,
    true,
  );
  const milestoneLink = resolveLinks(
    frontmatter[preset.fields.milestone],
    file.path,
    'milestone',
    source,
    true,
  );
  diagnostics.push(...blockedBy.diagnostics, ...related.diagnostics, ...milestoneLink.diagnostics);
  if (milestoneLink.linkCount > 1 || milestoneLink.paths.length > 1) {
    diagnostics.push({
      type: 'multiple-milestones',
      field: 'milestone',
      rawValue: frontmatter[preset.fields.milestone],
    });
  }

  const statusRawValue = frontmatter[preset.fields.status];
  const rawStatus = scalarString(statusRawValue, 'status', 'non-scalar-status', diagnostics);
  const statusId = rawStatus === undefined ? null : (reverseStatuses.get(rawStatus) ?? null);
  if (rawStatus !== undefined && statusId === null) {
    diagnostics.push({ type: 'unknown-status', field: 'status', rawValue: rawStatus });
  }

  const startRaw = frontmatter[preset.fields.start];
  const endRaw = frontmatter[preset.fields.end];
  scalarString(startRaw, 'start', 'non-scalar-date', diagnostics);
  scalarString(endRaw, 'end', 'non-scalar-date', diagnostics);
  const range = parseProjectRange(startRaw, endRaw);
  const priorityRaw = frontmatter[preset.fields.priority];
  const idRaw = frontmatter[preset.fields.id];

  const eligible =
    diagnostics.every(
      ({ type }) =>
        type !== 'outside-folder' &&
        type !== 'membership-mismatch' &&
        type !== 'ambiguous-kind' &&
        type !== 'missing-kind' &&
        type !== 'missing-project' &&
        type !== 'multiple-projects' &&
        type !== 'ambiguous-project' &&
        type !== 'broken-project',
    ) && project.paths.length === 1;
  if (!eligible) return { diagnostics, candidate: folderMatch && membershipMatch };

  const snapshot: WorkNoteSnapshot = {
    path: file.path,
    presetRevision: preset.revision,
    kind: milestone ? 'milestone' : 'ordinary',
    projectPath: project.paths[0]!,
    statusId,
    rawStatus: rawStatus ?? null,
    writableStatusShape: statusRawValue === undefined || typeof statusRawValue === 'string',
    ...(typeof priorityRaw === 'string' && { priority: priorityRaw }),
    range,
    ...(typeof idRaw === 'string' && { id: idRaw }),
    ...(milestoneLink.paths.length === 1 && { milestonePath: milestoneLink.paths[0] }),
    blockedByPaths: [...blockedBy.paths],
    relatedPaths: [...related.paths],
    diagnostics,
  };
  return { snapshot, diagnostics, candidate: true };
}

function safeFolder(folder: string): boolean {
  if (!folder || folder !== folder.trim() || folder.startsWith('/') || folder.endsWith('/')) {
    return false;
  }
  if (folder.includes('\\') || folder.includes('//')) return false;
  return folder.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function markerContext(marker: WorkNoteKindMarker): {
  readonly tags: string[];
  readonly frontmatter: Record<string, unknown>;
} {
  if (marker.kind === 'frontmatter-tag') {
    return { tags: [normalizeTag(marker.value)], frontmatter: {} };
  }
  return { tags: [], frontmatter: { [marker.property]: marker.value } };
}

function markerSatisfies(
  marker: WorkNoteKindMarker,
  kind: 'ordinary' | 'milestone',
  preset: WorkNoteCompatibilityPreset,
  folder: string,
): boolean {
  const context = markerContext(marker);
  const path = `${folder}/New work note.md`;
  const membership = evaluateQuery(preset.membershipQuery, path, context.tags, context.frontmatter);
  const expected = evaluateQuery(
    kind === 'ordinary' ? preset.ordinaryKindQuery : preset.milestoneKindQuery,
    path,
    context.tags,
    context.frontmatter,
  );
  const other = evaluateQuery(
    kind === 'ordinary' ? preset.milestoneKindQuery : preset.ordinaryKindQuery,
    path,
    context.tags,
    context.frontmatter,
  );
  return membership && expected && !other;
}

function creationCapability(
  source: WorkNoteAuditSource,
  preset: WorkNoteCompatibilityPreset,
  statusMappingValid: boolean,
): boolean {
  const creation = preset.creation;
  if (!creation || !statusMappingValid || !safeFolder(creation.folder)) return false;
  if (!inFolder(`${creation.folder}/New work note.md`, preset.folder)) return false;
  if (!preset.rawStatusByStatusId[creation.defaultStatusId]?.trim()) return false;
  if (
    !markerSatisfies(creation.kindMarkers.ordinary, 'ordinary', preset, creation.folder) ||
    !markerSatisfies(creation.kindMarkers.milestone, 'milestone', preset, creation.folder)
  ) {
    return false;
  }
  const templatePath = creation.templatePath;
  return (
    templatePath === undefined ||
    (safeFolder(templatePath.replace(/\/[^/]+$/u, '')) &&
      templatePath.endsWith('.md') &&
      source.fileExists(templatePath))
  );
}

export function auditWorkNotes(
  source: WorkNoteAuditSource,
  preset: WorkNoteCompatibilityPreset,
): WorkNoteAuditResult {
  const { reverse, issues } = reverseStatusMap(preset);
  const snapshots: WorkNoteSnapshot[] = [];
  const diagnosticsByPath: Record<string, readonly WorkNoteDiagnostic[]> = {};
  let candidatesUpdateSafe = true;
  const updateBlockingDiagnostics = new Set<WorkNoteDiagnostic['type']>([
    'ambiguous-kind',
    'missing-kind',
    'missing-project',
    'multiple-projects',
    'ambiguous-project',
    'broken-project',
    'non-scalar-status',
  ]);
  for (const file of source.files()) {
    const result = projectSnapshot(file, preset, source, reverse);
    if (
      result.candidate &&
      result.diagnostics.some(({ type }) => updateBlockingDiagnostics.has(type))
    ) {
      candidatesUpdateSafe = false;
    }
    if (result.diagnostics.length > 0) diagnosticsByPath[file.path] = result.diagnostics;
    if (result.snapshot) snapshots.push(result.snapshot);
  }
  snapshots.sort((left, right) => left.path.localeCompare(right.path));
  const mappingValid = issues.length === 0;
  const update =
    preset.enabled &&
    mappingValid &&
    candidatesUpdateSafe &&
    snapshots.every((snapshot) => snapshot.writableStatusShape);
  return {
    presetFingerprint: computeWorkNotePresetFingerprint(preset),
    eligiblePaths: snapshots.map(({ path }) => path),
    snapshots,
    diagnosticsByPath,
    issues,
    capabilities: {
      update,
      create: preset.enabled && creationCapability(source, preset, mappingValid),
    },
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mostCommon(counts: Readonly<Record<string, number>>): string {
  return (
    Object.entries(counts).sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || leftKey.localeCompare(rightKey),
    )[0]?.[0] ?? ''
  );
}

function slug(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'status'
  );
}

export interface WorkNotePresetSuggestion {
  readonly preset: WorkNoteCompatibilityPreset;
  readonly observations: {
    readonly fileCount: number;
    readonly folderCounts: Readonly<Record<string, number>>;
    readonly propertyCounts: Readonly<Record<string, number>>;
    readonly tagCounts: Readonly<Record<string, number>>;
    readonly statusValueCounts: Readonly<Record<string, number>>;
  };
  readonly preview: {
    readonly eligibleCount: number;
    readonly rejectedCandidateCount: number;
    readonly issueCounts: Readonly<Record<string, number>>;
  };
}

function sharedTagPrefix(tags: readonly string[]): string {
  const parts = tags.map((tag) => normalizeTag(tag).slice(1).split('/'));
  const first = parts[0];
  if (!first) return '';
  const shared: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const part = first[index];
    if (!part || parts.some((candidate) => candidate[index] !== part)) break;
    shared.push(part);
  }
  return shared.length > 0 ? `#${shared.join('/')}` : '';
}

function deriveFields(
  propertyCounts: Readonly<Record<string, number>>,
): WorkNoteCompatibilityPreset['fields'] {
  const aliases: Readonly<Record<keyof WorkNoteCompatibilityPreset['fields'], readonly string[]>> =
    {
      project: ['project', 'up'],
      status: ['status', 'state'],
      priority: ['priority'],
      description: ['description'],
      start: ['start'],
      end: ['end'],
      created: ['created'],
      updated: ['updated'],
      id: ['id'],
      milestone: ['milestone'],
      blockedBy: ['blockedby'],
      related: ['related'],
    };
  const observed = Object.keys(propertyCounts).sort(
    (left, right) =>
      (propertyCounts[right] ?? 0) - (propertyCounts[left] ?? 0) || left.localeCompare(right),
  );
  return Object.fromEntries(
    FIELD_KEYS.map((field) => {
      const match = observed.find((property) =>
        aliases[field].includes(property.toLowerCase().replace(/[^a-z0-9]/gu, '')),
      );
      return [field, match ?? DEFAULT_FIELDS[field]];
    }),
  ) as unknown as WorkNoteCompatibilityPreset['fields'];
}

export function suggestWorkNotePreset(source: WorkNoteAuditSource): WorkNotePresetSuggestion {
  const folderCounts: Record<string, number> = {};
  const propertyCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  const statusValueCounts: Record<string, number> = {};
  const files = source.files();
  for (const file of files) {
    for (const key of Object.keys(file.frontmatter)) increment(propertyCounts, key);
  }
  const fields = deriveFields(propertyCounts);
  const structuralSeeds = files.filter(
    (file) =>
      file.frontmatter[fields.project] !== undefined &&
      file.frontmatter[fields.status] !== undefined,
  );
  const observedFiles = structuralSeeds.length > 0 ? structuralSeeds : files;
  for (const file of observedFiles) {
    increment(folderCounts, file.path.includes('/') ? file.path.split('/')[0]! : '');
    for (const tag of file.tags) increment(tagCounts, normalizeTag(tag));
    const status = file.frontmatter[fields.status];
    if (typeof status === 'string') increment(statusValueCounts, status);
  }
  const milestoneTag =
    Object.keys(tagCounts).find((tag) => tag.toLowerCase().includes('milestone')) ?? '';
  const ordinaryTag =
    Object.keys(tagCounts).find((tag) => tag !== milestoneTag) ?? mostCommon(tagCounts);
  const commonTag = milestoneTag
    ? sharedTagPrefix([ordinaryTag, milestoneTag]) || mostCommon(tagCounts)
    : ordinaryTag;
  const rawStatusByStatusId: Record<string, string> = {};
  for (const rawStatus of Object.keys(statusValueCounts).sort((left, right) =>
    left.localeCompare(right),
  )) {
    let id = slug(rawStatus);
    let suffix = 2;
    while (rawStatusByStatusId[id] !== undefined) {
      id = `${slug(rawStatus)}-${String(suffix)}`;
      suffix += 1;
    }
    rawStatusByStatusId[id] = rawStatus;
  }
  const preset: WorkNoteCompatibilityPreset = {
    revision: 1,
    enabled: false,
    membershipQuery: commonTag,
    ordinaryKindQuery: ordinaryTag,
    milestoneKindQuery: milestoneTag,
    folder: mostCommon(folderCounts),
    fields,
    rawStatusByStatusId,
  };
  const preview = auditWorkNotes(source, preset);
  const eligiblePaths = new Set(preview.eligiblePaths);
  const issueCounts: Record<string, number> = {};
  let rejectedCandidateCount = 0;
  for (const [path, diagnostics] of Object.entries(preview.diagnosticsByPath)) {
    const candidate = diagnostics.every(
      ({ type }) => type !== 'membership-mismatch' && type !== 'outside-folder',
    );
    if (!eligiblePaths.has(path) && candidate) {
      rejectedCandidateCount += 1;
    }
    for (const { type } of diagnostics) increment(issueCounts, type);
  }
  for (const { type } of preview.issues) increment(issueCounts, type);
  return {
    preset,
    observations: {
      fileCount: files.length,
      folderCounts,
      propertyCounts,
      tagCounts,
      statusValueCounts,
    },
    preview: {
      eligibleCount: preview.eligiblePaths.length,
      rejectedCandidateCount,
      issueCounts,
    },
  };
}

export function isWorkNotePreset(value: unknown): value is WorkNoteCompatibilityPreset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['revision'] !== 'number' ||
    typeof candidate['enabled'] !== 'boolean' ||
    typeof candidate['membershipQuery'] !== 'string' ||
    typeof candidate['ordinaryKindQuery'] !== 'string' ||
    typeof candidate['milestoneKindQuery'] !== 'string' ||
    typeof candidate['folder'] !== 'string'
  ) {
    return false;
  }
  const fields = candidate['fields'];
  const mapping = candidate['rawStatusByStatusId'];
  const baseValid =
    fields !== null &&
    typeof fields === 'object' &&
    !Array.isArray(fields) &&
    FIELD_KEYS.every((key) => typeof (fields as Record<string, unknown>)[key] === 'string') &&
    mapping !== null &&
    typeof mapping === 'object' &&
    !Array.isArray(mapping) &&
    Object.values(mapping as Record<string, unknown>).every((entry) => typeof entry === 'string');
  if (!baseValid) return false;
  const creation = candidate['creation'];
  if (creation === undefined) return true;
  if (creation === null || typeof creation !== 'object' || Array.isArray(creation)) return false;
  const contract = creation as Record<string, unknown>;
  const markers = contract['kindMarkers'];
  if (
    typeof contract['folder'] !== 'string' ||
    !safeFolder(contract['folder']) ||
    (contract['templatePath'] !== undefined && typeof contract['templatePath'] !== 'string') ||
    (contract['defaultKind'] !== 'ordinary' && contract['defaultKind'] !== 'milestone') ||
    typeof contract['defaultStatusId'] !== 'string' ||
    markers === null ||
    typeof markers !== 'object' ||
    Array.isArray(markers)
  ) {
    return false;
  }
  return ['ordinary', 'milestone'].every((kind) => {
    const marker = (markers as Record<string, unknown>)[kind];
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const candidateMarker = marker as Record<string, unknown>;
    return candidateMarker['kind'] === 'frontmatter-tag'
      ? typeof candidateMarker['value'] === 'string'
      : candidateMarker['kind'] === 'property' &&
          typeof candidateMarker['property'] === 'string' &&
          typeof candidateMarker['value'] === 'string';
  });
}
