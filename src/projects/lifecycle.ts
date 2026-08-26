import type { ProjectStatus } from '../settings/types';

export type ProjectLifecycleBehavior = 'regular' | 'completed' | 'dropped' | 'published';

export interface ProjectLifecycleObservation {
  readonly path: string;
  readonly statusId: string | null;
  readonly rawStatus: string | null;
  readonly ownedField:
    | { readonly kind: 'property'; readonly property: string; readonly rawValue: unknown }
    | { readonly kind: 'frontmatter-tags'; readonly canonicalLifecycleTags: readonly string[] };
}

interface ProjectLifecycleDiagnostic {
  readonly behavior: 'dropped' | 'published';
  readonly statusIds: readonly string[];
  readonly message: string;
}

export interface ProjectLifecycleConfigurationValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly ProjectLifecycleDiagnostic[];
}

export interface ResolvedProjectLifecycle {
  readonly statusId: string | null;
  readonly rawStatus: string | null;
  readonly ownedField: ProjectLifecycleObservation['ownedField'];
}

export interface ProjectLifecycleFrontmatterInspection {
  readonly lifecycle: ResolvedProjectLifecycle;
  readonly ambiguous: boolean;
}

const BEHAVIORS = new Set<ProjectLifecycleBehavior>([
  'regular',
  'completed',
  'dropped',
  'published',
]);

function normalizedLabel(label: string): string {
  return label
    .normalize('NFKC')
    .trim()
    .replace(/^(?:\p{Extended_Pictographic}|\u200d|\ufe0f|\s)+/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

export function inferLifecycleBehavior(label: string): ProjectLifecycleBehavior {
  switch (normalizedLabel(label)) {
    case 'complete':
    case 'completed':
    case 'done':
      return 'completed';
    case 'drop':
    case 'dropped':
      return 'dropped';
    case 'publish':
    case 'published':
      return 'published';
    default:
      return 'regular';
  }
}

function projectStatusBehavior(status: ProjectStatus): ProjectLifecycleBehavior {
  return status.behavior && BEHAVIORS.has(status.behavior)
    ? status.behavior
    : inferLifecycleBehavior(status.label);
}

export function validateLifecycleConfiguration(
  statuses: readonly ProjectStatus[],
): ProjectLifecycleConfigurationValidation {
  const diagnostics: ProjectLifecycleDiagnostic[] = [];
  for (const behavior of ['dropped', 'published'] as const) {
    const statusIds = statuses
      .filter((status) => projectStatusBehavior(status) === behavior)
      .map((status) => status.id);
    if (statusIds.length > 1) {
      diagnostics.push({
        behavior,
        statusIds,
        message: `Only one project status may use the ${behavior} lifecycle behavior.`,
      });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function projectBoardMutationEnabled(statuses: readonly ProjectStatus[]): boolean {
  return validateLifecycleConfiguration(statuses).valid;
}

export function toProjectPropertyString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function frontmatterTagValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((tag) => String(tag));
  if (typeof raw === 'string') return [raw];
  return [];
}

function normalizedTag(tag: string): string {
  return tag.replace(/^#/u, '').toLowerCase();
}

function tagMatches(candidate: string, configured: string): boolean {
  const tag = normalizedTag(candidate);
  const wanted = normalizedTag(configured);
  return tag === wanted || tag.startsWith(`${wanted}/`);
}

export function canonicalLifecycleTags(
  statuses: readonly ProjectStatus[],
  frontmatter: Readonly<Record<string, unknown>>,
): string[] {
  const configured = statuses
    .filter((status) => status.match.kind === 'tag')
    .map((status) => (status.match as { tag: string }).tag);
  return frontmatterTagValues(frontmatter['tags']).filter((tag) =>
    configured.some((wanted) => tagMatches(tag, wanted)),
  );
}

function propertyNames(statuses: readonly ProjectStatus[]): string[] {
  return Array.from(
    new Set(
      statuses
        .filter((status) => status.match.kind === 'property')
        .map((status) => (status.match as { property: string }).property),
    ),
  );
}

function propertyHasValue(
  frontmatter: Readonly<Record<string, unknown>>,
  property: string,
): boolean {
  return toProjectPropertyString(frontmatter[property]) !== '';
}

function canonicalStatus(
  statuses: readonly ProjectStatus[],
  frontmatter: Readonly<Record<string, unknown>>,
  tags: readonly string[],
): ProjectStatus | undefined {
  const normalizedTags = new Set(tags.map(normalizedTag));
  return statuses.find((status) => {
    if (status.match.kind === 'property') {
      return toProjectPropertyString(frontmatter[status.match.property]) === status.match.value;
    }
    const wanted = status.match.tag;
    return [...normalizedTags].some((tag) => tagMatches(tag, wanted));
  });
}

function legacyTagStatus(
  statuses: readonly ProjectStatus[],
  tags: readonly string[],
): ProjectStatus | undefined {
  const normalizedTags = tags.map(normalizedTag);
  return statuses.find((status) => {
    if (status.match.kind !== 'tag') return false;
    const wanted = normalizedTag(status.match.tag);
    return normalizedTags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
  });
}

export function inspectProjectLifecycleFrontmatter(
  statuses: readonly ProjectStatus[],
  frontmatter: Readonly<Record<string, unknown>>,
): ProjectLifecycleFrontmatterInspection {
  const statusTags = canonicalLifecycleTags(statuses, frontmatter);
  const properties = propertyNames(statuses);
  const populatedProperties = properties.filter((property) =>
    propertyHasValue(frontmatter, property),
  );
  const matchedStatuses = statuses.filter((status) => {
    if (status.match.kind === 'property') {
      return toProjectPropertyString(frontmatter[status.match.property]) === status.match.value;
    }
    const wanted = status.match.tag;
    return statusTags.some((tag) => tagMatches(tag, wanted));
  });
  const markerCount = populatedProperties.length + statusTags.length;
  const ambiguous = markerCount > 1 || matchedStatuses.length > 1;
  const selected = canonicalStatus(statuses, frontmatter, statusTags);

  if (selected?.match.kind === 'property') {
    return {
      lifecycle: {
        statusId: selected.id,
        rawStatus: null,
        ownedField: {
          kind: 'property',
          property: selected.match.property,
          rawValue: frontmatter[selected.match.property],
        },
      },
      ambiguous,
    };
  }
  if (selected?.match.kind === 'tag') {
    return {
      lifecycle: {
        statusId: selected.id,
        rawStatus: null,
        ownedField: { kind: 'frontmatter-tags', canonicalLifecycleTags: statusTags },
      },
      ambiguous,
    };
  }

  const discoveredProperty = populatedProperties[0];
  if (discoveredProperty !== undefined) {
    return {
      lifecycle: {
        statusId: null,
        rawStatus: toProjectPropertyString(frontmatter[discoveredProperty]),
        ownedField: {
          kind: 'property',
          property: discoveredProperty,
          rawValue: frontmatter[discoveredProperty],
        },
      },
      ambiguous,
    };
  }

  const defaultProperty = properties[0];
  return {
    lifecycle: {
      statusId: null,
      rawStatus: null,
      ownedField:
        defaultProperty !== undefined
          ? {
              kind: 'property',
              property: defaultProperty,
              rawValue: frontmatter[defaultProperty],
            }
          : { kind: 'frontmatter-tags', canonicalLifecycleTags: statusTags },
    },
    ambiguous,
  };
}

export function resolveProjectLifecycle(
  statuses: readonly ProjectStatus[],
  tags: readonly string[],
  frontmatter: Readonly<Record<string, unknown>>,
): ResolvedProjectLifecycle {
  const inspected = inspectProjectLifecycleFrontmatter(statuses, frontmatter).lifecycle;
  const hasCanonicalMarker =
    inspected.rawStatus !== null ||
    (inspected.ownedField.kind === 'property'
      ? propertyHasValue(frontmatter, inspected.ownedField.property)
      : inspected.ownedField.canonicalLifecycleTags.length > 0);
  if (hasCanonicalMarker || inspected.statusId !== null) return inspected;

  const legacy = legacyTagStatus(statuses, tags);
  if (!legacy) return inspected;
  return {
    statusId: legacy.id,
    rawStatus: null,
    ownedField: { kind: 'frontmatter-tags', canonicalLifecycleTags: [] },
  };
}
