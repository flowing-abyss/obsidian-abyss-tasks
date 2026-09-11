import { normalizeProjectKanbanSettings } from '../projects/projectKanbanSettings';
import {
  hasMalformedProjectPropertyDefinitionPresentation,
  isProjectPropertyDefinition,
} from '../projects/projectPropertyDefinitions';
import { normalizeProjectTableSettings } from '../projects/projectTableSettings';
import { ACTIVE_STATUS_GROUPS, TYPE_ORDER } from '../status/statusConstants';
import { buildDefaultProjectsSettings, buildDefaultTaskStatuses } from './defaults';
import { migrateShortcuts } from './shortcuts';

const DONE_CANCELLED_STATUS_GROUPS = TYPE_ORDER.filter(
  (t) => !(ACTIVE_STATUS_GROUPS as string[]).includes(t),
);

function migrateInbox(raw: Record<string, unknown>): void {
  if (!('inbox' in raw)) {
    raw['inbox'] = {
      mode: raw['inboxMode'] ?? 'tag',
      tag: raw['inboxTag'] ?? '#task/inbox',
      removeTagOnAssign: true,
    };
    delete raw['inboxMode'];
    delete raw['inboxTag'];
  }
  // The old `showUntagged` toggle was folded into `mode`: tag + showUntagged === both.
  const inbox = raw['inbox'];
  if (inbox !== null && typeof inbox === 'object') {
    const box = inbox as Record<string, unknown>;
    if ('showUntagged' in box) {
      if (box['showUntagged'] === true && box['mode'] === 'tag') box['mode'] = 'both';
      delete box['showUntagged'];
    }
  }
}

interface MigratedProjectSettings {
  statusProperty?: string;
  startProperty?: string;
  endProperty?: string;
  propertyDefinitions?: unknown;
  propertyDefinitionMigration?: unknown;
  statuses?: unknown[];
  statusMigration?: unknown;
  defaultStatusId?: string;
  taskInsertionMode?: string;
  taskInsertionSection?: string;
  table?: unknown;
  kanban?: unknown;
  overviewView?: unknown;
}

interface SettingsMigrationResult {
  notices: string[];
}

interface LegacyPropertyStatus {
  id: string;
  name: string;
  color?: string;
  onLeftPanel: boolean;
  property: string;
}

const TAG_STATUS_NOTICE =
  'Project tag statuses were removed. Their note tags are unchanged; choose a Status property in Projects settings.';
const PROPERTY_DEFINITION_NOTICE =
  'Some project property definitions could not be loaded. Repair or remove the conflicting definitions in Projects settings; their original values were preserved.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function isNewProjectStatus(value: unknown): value is { id: string; name: string } {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length > 0
  );
}

function legacyPropertyStatus(value: unknown): LegacyPropertyStatus | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !isRecord(value['match'])) {
    return undefined;
  }
  const match = value['match'];
  if (
    match['kind'] !== 'property' ||
    typeof match['property'] !== 'string' ||
    match['property'].trim().length === 0 ||
    typeof match['value'] !== 'string' ||
    match['value'].trim().length === 0
  ) {
    return undefined;
  }
  return {
    id: value['id'],
    name: match['value'],
    ...(typeof value['color'] === 'string' ? { color: value['color'] } : {}),
    onLeftPanel: value['onLeftPanel'] === true,
    property: match['property'],
  };
}

interface LegacyProjectStatusAnalysis {
  readonly converted: Array<Omit<LegacyPropertyStatus, 'property'>>;
  readonly invalid: boolean;
  readonly propertyCandidates: string[];
  readonly removedTagCount: number;
}

function isLegacyTagStatus(status: unknown): boolean {
  return isRecord(status) && isRecord(status['match']) && status['match']['kind'] === 'tag';
}

function analyzeLegacyProjectStatuses(
  rawStatuses: readonly unknown[],
): LegacyProjectStatusAnalysis {
  const propertyStatuses = rawStatuses.flatMap((status) => {
    const converted = legacyPropertyStatus(status);
    return converted === undefined ? [] : [converted];
  });
  const removedTagCount = rawStatuses.filter(isLegacyTagStatus).length;
  const propertyCandidates = propertyStatuses.reduce<string[]>((candidates, status) => {
    if (!candidates.some((candidate) => sameProperty(candidate, status.property))) {
      candidates.push(status.property);
    }
    return candidates;
  }, []);
  const names = new Set<string>();
  const converted = propertyStatuses.flatMap(({ property: _property, ...status }) => {
    if (names.has(status.name)) return [];
    names.add(status.name);
    return [status];
  });
  return {
    converted,
    invalid:
      rawStatuses.length - propertyStatuses.length - removedTagCount > 0 ||
      propertyStatuses.length !== converted.length,
    propertyCandidates,
    removedTagCount,
  };
}

function migrateProjectStatuses(
  projects: MigratedProjectSettings,
  result: SettingsMigrationResult,
): void {
  const rawStatuses = Array.isArray(projects.statuses) ? projects.statuses : [];
  if (rawStatuses.length === 0) {
    projects.statuses = buildDefaultProjectsSettings().statuses;
    return;
  }
  if (rawStatuses.every(isNewProjectStatus)) return;

  const { converted, invalid, propertyCandidates, removedTagCount } =
    analyzeLegacyProjectStatuses(rawStatuses);
  if (removedTagCount > 0) result.notices.push(TAG_STATUS_NOTICE);
  const unresolved = propertyCandidates.length > 1 || invalid;

  if (unresolved) {
    projects.statusMigration = {
      issue: propertyCandidates.length > 1 ? 'conflicting-properties' : 'invalid-statuses',
      legacyStatuses: structuredClone(rawStatuses),
      propertyCandidates,
    };
    projects.statusProperty = '';
  } else if (propertyCandidates[0] !== undefined) {
    projects.statusProperty = propertyCandidates[0];
    delete projects.statusMigration;
  }

  projects.statuses = converted.length > 0 ? converted : buildDefaultProjectsSettings().statuses;
}

function normalizeProjectSources(
  projects: MigratedProjectSettings,
  defaults: ReturnType<typeof buildDefaultProjectsSettings>,
): void {
  if (typeof projects.statusProperty !== 'string')
    projects.statusProperty = defaults.statusProperty;
  if (typeof projects.startProperty !== 'string') projects.startProperty = defaults.startProperty;
  if (typeof projects.endProperty !== 'string') projects.endProperty = defaults.endProperty;
}

function normalizeDefaultProjectStatus(projects: MigratedProjectSettings): void {
  const ids = (projects.statuses ?? []).flatMap((status) =>
    isRecord(status) && typeof status['id'] === 'string' ? [status['id']] : [],
  );
  const selected = projects.defaultStatusId;
  if (selected === undefined || selected.length === 0 || !ids.includes(selected)) {
    projects.defaultStatusId = ids[0] ?? '';
  }
}

function propertyDefinitionIsInvalid(key: string, definition: unknown): boolean {
  const property = key.startsWith('property:') ? key.slice('property:'.length) : '';
  if (property.length === 0) return true;
  if (!isProjectPropertyDefinition(definition)) return true;
  if (hasMalformedProjectPropertyDefinitionPresentation(definition)) return true;
  if (sameProperty(property, 'tags')) return definition.type !== 'tags';
  return definition.type === 'tags';
}

function ambiguousPropertyDefinitionKeys(definitions: Record<string, unknown>): string[][] {
  const groups: string[][] = [];
  for (const key of Object.keys(definitions)) {
    const group = groups.find(
      (candidate) => candidate[0] !== undefined && sameProperty(candidate[0], key),
    );
    if (group === undefined) groups.push([key]);
    else group.push(key);
  }
  return groups.filter((group) => group.length > 1);
}

function preserveInvalidPropertyDefinitions(
  projects: MigratedProjectSettings,
  result: SettingsMigrationResult,
  recovery: {
    definitions: unknown;
    invalidKeys: string[];
    ambiguousKeys: string[][];
  },
): void {
  const { definitions, invalidKeys, ambiguousKeys } = recovery;
  projects.propertyDefinitionMigration = {
    issue: 'invalid-property-definitions',
    propertyDefinitions: structuredClone(definitions),
    invalidKeys,
    ambiguousKeys,
  };
  result.notices.push(PROPERTY_DEFINITION_NOTICE);
}

function normalizeProjectPropertyDefinitions(
  projects: MigratedProjectSettings,
  result: SettingsMigrationResult,
): void {
  const definitions = projects.propertyDefinitions;
  if (definitions === undefined) {
    projects.propertyDefinitions = {};
    return;
  }
  if (!isRecord(definitions)) {
    preserveInvalidPropertyDefinitions(projects, result, {
      definitions,
      invalidKeys: [],
      ambiguousKeys: [],
    });
    projects.propertyDefinitions = {};
    return;
  }
  const invalidKeys = Object.entries(definitions).flatMap(([key, definition]) =>
    propertyDefinitionIsInvalid(key, definition) ? [key] : [],
  );
  const ambiguousKeys = ambiguousPropertyDefinitionKeys(definitions);
  if (invalidKeys.length === 0 && ambiguousKeys.length === 0) return;
  preserveInvalidPropertyDefinitions(projects, result, {
    definitions,
    invalidKeys,
    ambiguousKeys,
  });
}

function normalizeProjectSettings(
  projects: MigratedProjectSettings,
  result: SettingsMigrationResult,
): void {
  migrateProjectStatuses(projects, result);
  const defaults = buildDefaultProjectsSettings();
  normalizeProjectSources(projects, defaults);
  normalizeDefaultProjectStatus(projects);
  normalizeProjectPropertyDefinitions(projects, result);

  if (projects.taskInsertionMode !== 'append' && projects.taskInsertionMode !== 'section') {
    projects.taskInsertionMode = defaults.taskInsertionMode;
  }
  if (typeof projects.taskInsertionSection !== 'string') {
    projects.taskInsertionSection = defaults.taskInsertionSection;
  }
  const table = normalizeProjectTableSettings(projects.table);
  projects.table = table;
  if (hasOwn(projects, 'kanban')) {
    projects.kanban = normalizeProjectKanbanSettings(projects.kanban, table);
  }
  if (projects.overviewView !== 'table' && projects.overviewView !== 'kanban') {
    delete projects.overviewView;
  }
}

function migrateProjects(raw: Record<string, unknown>, result: SettingsMigrationResult): void {
  if (!('projects' in raw)) raw['projects'] = buildDefaultProjectsSettings();
  const projects = raw['projects'];
  if (projects === null || typeof projects !== 'object') return;
  normalizeProjectSettings(projects, result);
}

/**
 * Per-status color/iconKind were folded into the priority-color + lucide-only
 * visual contract: color is no longer stored per status, and glyph icons are
 * no longer supported (Lucide only). Check iconKind BEFORE deleting it.
 */
function stripLegacyStatusFields(taskStatuses: unknown[]): void {
  for (const entry of taskStatuses) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['iconKind'] === 'glyph') e['icon'] = '';
    delete e['color'];
    delete e['iconKind'];
  }
}

/**
 * Core statuses must stay fully locked and predictable — heal any drift
 * (e.g. an older build's icon/symbol) back to the canonical default so a
 * core status's appearance never depends on when the user first installed.
 * Matched by `type`, since each of the 4 core types is unique. Non-core
 * (user-added) statuses are left untouched.
 */
function healCoreStatuses(taskStatuses: unknown[]): void {
  const canonicalCore = buildDefaultTaskStatuses().filter((s) => s.core);
  for (const entry of taskStatuses) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['core'] !== true) continue;
    const canonical = canonicalCore.find((c) => c.type === e['type']);
    if (canonical == null) continue;
    e['symbol'] = canonical.symbol;
    e['type'] = canonical.type;
    e['icon'] = canonical.icon;
  }
}

function migrateTaskStatuses(raw: Record<string, unknown>): void {
  if (
    !('taskStatuses' in raw) ||
    !Array.isArray(raw['taskStatuses']) ||
    (raw['taskStatuses'] as unknown[]).length === 0
  ) {
    raw['taskStatuses'] = buildDefaultTaskStatuses();
  }
  const taskStatuses = raw['taskStatuses'];
  if (!Array.isArray(taskStatuses)) return;
  stripLegacyStatusFields(taskStatuses);
  healCoreStatuses(taskStatuses);
}

/**
 * The old separate "Show" (active/completed/all) single-select and "Status
 * group" multi-select were unified into one statusGroups-only filter. Fold
 * each persisted list view state's legacy `show` into `statusGroups` (unless
 * statusGroups was already explicitly set) and drop the `show` key.
 */
function legacyStatusGroups(show: unknown): string[] | undefined {
  if (show === 'active') return [...ACTIVE_STATUS_GROUPS];
  if (show === 'completed') return [...DONE_CANCELLED_STATUS_GROUPS];
  return undefined;
}

function migrateListViewState(entry: unknown): void {
  if (entry === null || entry === undefined || typeof entry !== 'object') return;
  const viewState = entry as Record<string, unknown>;
  if (!('show' in viewState)) return;
  if (!('statusGroups' in viewState) || viewState['statusGroups'] === undefined) {
    viewState['statusGroups'] = legacyStatusGroups(viewState['show']);
  }
  delete viewState['show'];
}

function migrateListViewStates(raw: Record<string, unknown>): void {
  const states = raw['listViewStates'];
  if (states === null || states === undefined || typeof states !== 'object') return;
  for (const entry of Object.values(states)) migrateListViewState(entry);
}

function migrateTaskLifecycle(raw: Record<string, unknown>): void {
  if (raw['taskLifecycle'] === null || typeof raw['taskLifecycle'] !== 'object') {
    raw['taskLifecycle'] = { addCreatedDate: true, addCompletionDate: true };
    return;
  }
  const lifecycle = raw['taskLifecycle'] as Record<string, unknown>;
  if (typeof lifecycle['addCreatedDate'] !== 'boolean') lifecycle['addCreatedDate'] = true;
  if (typeof lifecycle['addCompletionDate'] !== 'boolean') lifecycle['addCompletionDate'] = true;
}

function migrateRecurrence(raw: Record<string, unknown>): void {
  if (raw['recurrence'] === null || typeof raw['recurrence'] !== 'object') {
    raw['recurrence'] = { newOccurrencePlacement: 'before', removeScheduledDate: false };
    return;
  }
  const recurrence = raw['recurrence'] as Record<string, unknown>;
  if (
    recurrence['newOccurrencePlacement'] !== 'before' &&
    recurrence['newOccurrencePlacement'] !== 'after'
  ) {
    recurrence['newOccurrencePlacement'] = 'before';
  }
  if (typeof recurrence['removeScheduledDate'] !== 'boolean') {
    recurrence['removeScheduledDate'] = false;
  }
}

export function migrateSettings(raw: Record<string, unknown>): SettingsMigrationResult {
  const result: SettingsMigrationResult = { notices: [] };
  migrateInbox(raw);
  if (!('pinnedTags' in raw)) raw['pinnedTags'] = [];
  if (!('archivedTags' in raw)) raw['archivedTags'] = [];
  migrateProjects(raw, result);
  if (!('sectionCollapse' in raw)) {
    raw['sectionCollapse'] = { pinned: false, projects: false, tags: false };
  }
  migrateTaskStatuses(raw);
  migrateListViewStates(raw);
  migrateTaskLifecycle(raw);
  migrateRecurrence(raw);
  migrateShortcuts(raw);
  return result;
}
