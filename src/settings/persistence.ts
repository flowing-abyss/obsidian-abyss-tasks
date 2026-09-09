import { normalizeProjectTableSettings } from '../projects/projectTableSettings';
import { ACTIVE_STATUS_GROUPS, TYPE_ORDER } from '../status/statusConstants';
import type { TaskStatusType } from '../tasks/domain/types';
import { getListViewDefaults } from './defaults';
import { migrateSettings } from './migration';
import type {
  CalendarSettings,
  ListViewState,
  SavedViewState,
  SavedViewStateRecovery,
} from './types';

export const SAVED_VIEW_STATE_SCHEMA_VERSION = 1 as const;
export const STATIC_SAVED_VIEW_STATE_MARKER = 'savedViewStateSchemaVersion' as const;

interface SavedViewStatePort {
  readonly path: string;
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
}

export interface SettingsPersistencePort {
  loadStatic: () => Promise<unknown>;
  saveStatic: (data: unknown) => Promise<void>;
  readonly state: SavedViewStatePort;
}

interface SettingsPersistenceIssue {
  readonly message: string;
  readonly cause: unknown;
}

export interface SettingsLoadResult {
  readonly settings: CalendarSettings;
  readonly notices: readonly string[];
  readonly issues: readonly SettingsPersistenceIssue[];
}

interface DecodedViews {
  readonly views: SavedViewState;
  readonly recovery: SavedViewStateRecovery | undefined;
}

interface LoadedState {
  readonly envelope: Record<string, unknown>;
  readonly decoded: DecodedViews;
}

interface StateLoadOutcome {
  readonly kind: 'missing' | 'valid' | 'unavailable';
  readonly loaded?: LoadedState;
  readonly issue?: SettingsPersistenceIssue;
}

const GROUP_BY_VALUES = new Set<ListViewState['groupBy']>([
  'none',
  'date',
  'priority',
  'tag',
  'status',
]);
const SORT_FIELD_VALUES = new Set<ListViewState['sortBy']['field']>([
  'date',
  'priority',
  'title',
  'tag',
  'status',
]);
const STATUS_VALUES = new Set(TYPE_ORDER);
const MALFORMED_VIEW_NOTICE =
  'Saved view preferences contained invalid values. Safe defaults were used and the original values were retained for recovery.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function migratedStatusGroups(show: unknown): ListViewState['statusGroups'] {
  if (show === 'active') return [...ACTIVE_STATUS_GROUPS];
  if (show === 'completed') {
    return TYPE_ORDER.filter((status) => !ACTIVE_STATUS_GROUPS.includes(status));
  }
  return undefined;
}

function normalizeListViewState(value: Record<string, unknown>, key: string): ListViewState {
  const defaults = getListViewDefaults(key);
  const sortBy = isRecord(value['sortBy']) ? value['sortBy'] : {};
  const groupBy = GROUP_BY_VALUES.has(value['groupBy'] as ListViewState['groupBy'])
    ? (value['groupBy'] as ListViewState['groupBy'])
    : defaults.groupBy;
  const field = SORT_FIELD_VALUES.has(sortBy['field'] as ListViewState['sortBy']['field'])
    ? (sortBy['field'] as ListViewState['sortBy']['field'])
    : defaults.sortBy.field;
  const dir = sortBy['dir'] === 'desc' ? 'desc' : 'asc';
  const statusGroups = Array.isArray(value['statusGroups'])
    ? value['statusGroups'].filter(
        (status): status is TaskStatusType =>
          typeof status === 'string' && STATUS_VALUES.has(status as TaskStatusType),
      )
    : migratedStatusGroups(value['show']);
  return {
    groupBy,
    sortBy: { field, dir },
    filters: Array.isArray(value['filters'])
      ? (detached(value['filters']) as ListViewState['filters'])
      : [],
    ...(statusGroups === undefined ? {} : { statusGroups }),
  };
}

function isValidPropertyFilter(value: unknown): boolean {
  if (!isRecord(value) || typeof value['type'] !== 'string') return false;
  if (value['type'] === 'file') return typeof value['filePath'] === 'string';
  if (value['type'] === 'priority') {
    return (
      typeof value['value'] === 'string' && ['A', 'B', 'C', 'D', 'E', 'F'].includes(value['value'])
    );
  }
  return (
    ['tag', 'time', 'status', 'date'].includes(value['type']) && typeof value['value'] === 'string'
  );
}

function isMalformedSort(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) return true;
  return (
    !SORT_FIELD_VALUES.has(value['field'] as ListViewState['sortBy']['field']) ||
    (value['dir'] !== 'asc' && value['dir'] !== 'desc')
  );
}

function isMalformedStatusGroups(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.some(
        (status) => typeof status !== 'string' || !STATUS_VALUES.has(status as TaskStatusType),
      ))
  );
}

function isMalformedListViewState(value: Record<string, unknown>): boolean {
  return (
    (value['groupBy'] !== undefined &&
      !GROUP_BY_VALUES.has(value['groupBy'] as ListViewState['groupBy'])) ||
    isMalformedSort(value['sortBy']) ||
    (value['filters'] !== undefined &&
      (!Array.isArray(value['filters']) ||
        value['filters'].some((filter) => !isValidPropertyFilter(filter)))) ||
    isMalformedStatusGroups(value['statusGroups'])
  );
}

function decodeListViewStates(value: unknown): {
  readonly states: Record<string, ListViewState> | undefined;
  readonly malformed: Record<string, unknown> | undefined;
} {
  if (value === undefined) return { states: undefined, malformed: undefined };
  if (!isRecord(value)) return { states: {}, malformed: { $root: detached(value) } };
  const states: Record<string, ListViewState> = {};
  const malformed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry) && !isMalformedListViewState(entry)) {
      states[key] = normalizeListViewState(entry, key);
    } else {
      malformed[key] = detached(entry);
    }
  }
  return {
    states,
    malformed: Object.keys(malformed).length === 0 ? undefined : malformed,
  };
}

function decodeSectionCollapse(
  value: unknown,
  defaults: CalendarSettings['sectionCollapse'],
): CalendarSettings['sectionCollapse'] {
  const record = isRecord(value) ? value : {};
  return {
    pinned: typeof record['pinned'] === 'boolean' ? record['pinned'] : defaults.pinned,
    projects: typeof record['projects'] === 'boolean' ? record['projects'] : defaults.projects,
    tags: typeof record['tags'] === 'boolean' ? record['tags'] : defaults.tags,
  };
}

function hasMalformedColumnPresentation(value: Record<string, unknown>): boolean {
  return (
    (value['visible'] !== undefined && typeof value['visible'] !== 'boolean') ||
    (value['label'] !== undefined && typeof value['label'] !== 'string') ||
    (value['width'] !== undefined &&
      (typeof value['width'] !== 'number' ||
        !Number.isFinite(value['width']) ||
        value['width'] <= 0))
  );
}

function isMalformedColumn(value: unknown): boolean {
  if (!isRecord(value)) return true;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return true;
  return hasMalformedColumnPresentation(value);
}

function malformedColumns(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return value === undefined ? undefined : [detached(value)];
  const malformed = value.filter(isMalformedColumn);
  return malformed.length === 0 ? undefined : detached(malformed);
}

function isMalformedSectionCollapse(value: unknown): boolean {
  if (!isRecord(value)) return value !== undefined;
  return ['pinned', 'projects', 'tags'].some(
    (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
  );
}

function isMalformedProjectTableSort(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) return true;
  return typeof value['field'] !== 'string' || (value['dir'] !== 'asc' && value['dir'] !== 'desc');
}

function isMalformedHiddenStatuses(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) || value.some((status) => typeof status !== 'string'))
  );
}

function isMalformedProjectTable(value: unknown): boolean {
  if (!isRecord(value)) return value !== undefined;
  return (
    (value['columns'] !== undefined && !Array.isArray(value['columns'])) ||
    (value['showDescription'] !== undefined && typeof value['showDescription'] !== 'boolean') ||
    (value['groupBy'] !== undefined && typeof value['groupBy'] !== 'string') ||
    isMalformedProjectTableSort(value['sortBy']) ||
    isMalformedHiddenStatuses(value['hiddenStatuses'])
  );
}

function mergeRecovery(
  current: unknown,
  additions: SavedViewStateRecovery | undefined,
): Record<string, unknown> | undefined {
  const recovery = isRecord(current) ? detached(current) : {};
  if (additions?.preSplitData !== undefined) recovery['preSplitData'] = additions.preSplitData;
  if (additions?.malformedViews !== undefined) {
    const existing = isRecord(recovery['malformedViews']) ? recovery['malformedViews'] : {};
    recovery['malformedViews'] = { ...existing, ...detached(additions.malformedViews) };
  }
  return Object.keys(recovery).length === 0 ? undefined : recovery;
}

function collectMalformedViews(
  views: Record<string, unknown>,
  projects: Record<string, unknown>,
  listViewStates: Record<string, unknown> | undefined,
  badColumns: unknown[] | undefined,
): NonNullable<SavedViewStateRecovery['malformedViews']> | undefined {
  const malformed: NonNullable<SavedViewStateRecovery['malformedViews']> = {};
  if (listViewStates !== undefined) malformed.listViewStates = listViewStates;
  if (isMalformedSectionCollapse(views['sectionCollapse'])) {
    malformed.sectionCollapse = detached(views['sectionCollapse']);
  }
  if (isMalformedProjectTable(projects['table'])) {
    malformed.projectTable = detached(projects['table']);
  }
  if (badColumns !== undefined) malformed.projectTableColumns = badColumns;
  return Object.keys(malformed).length === 0 ? undefined : malformed;
}

function decodeViews(raw: unknown, defaults: CalendarSettings): DecodedViews {
  const views: Record<string, unknown> = isRecord(raw) ? raw : {};
  const list = decodeListViewStates(views['listViewStates']);
  const projects: Record<string, unknown> = isRecord(views['projects']) ? views['projects'] : {};
  const table: Record<string, unknown> = isRecord(projects['table']) ? projects['table'] : {};
  const badColumns = malformedColumns(table['columns']);
  const malformedViews = collectMalformedViews(views, projects, list.malformed, badColumns);
  return {
    views: {
      ...(list.states === undefined ? {} : { listViewStates: list.states }),
      sectionCollapse: decodeSectionCollapse(views['sectionCollapse'], defaults.sectionCollapse),
      projects: { table: normalizeProjectTableSettings(table) },
    },
    recovery: malformedViews === undefined ? undefined : { malformedViews },
  };
}

function movedViewSource(raw: Record<string, unknown>): Record<string, unknown> {
  const projects = isRecord(raw['projects']) ? raw['projects'] : {};
  return {
    ...(raw['listViewStates'] === undefined
      ? {}
      : { listViewStates: detached(raw['listViewStates']) }),
    ...(raw['sectionCollapse'] === undefined
      ? {}
      : { sectionCollapse: detached(raw['sectionCollapse']) }),
    projects: {
      ...(projects['table'] === undefined ? {} : { table: detached(projects['table']) }),
    },
  };
}

function stripMovedFields(raw: Record<string, unknown>): void {
  delete raw['listViewStates'];
  delete raw['sectionCollapse'];
  if (!isRecord(raw['projects'])) return;
  delete raw['projects']['table'];
}

function hasMovedFields(raw: Record<string, unknown>): boolean {
  return (
    'listViewStates' in raw ||
    'sectionCollapse' in raw ||
    (isRecord(raw['projects']) && 'table' in raw['projects'])
  );
}

function composeSettings(
  rawStatic: Record<string, unknown>,
  decoded: DecodedViews,
  defaults: CalendarSettings,
): { readonly settings: CalendarSettings; readonly notices: readonly string[] } {
  const staticData = detached(rawStatic);
  stripMovedFields(staticData);
  const migration = migrateSettings(staticData);
  const settings = Object.assign(detached(defaults), staticData) as CalendarSettings;
  if (decoded.views.listViewStates === undefined) delete settings.listViewStates;
  else settings.listViewStates = decoded.views.listViewStates;
  settings.sectionCollapse = decoded.views.sectionCollapse;
  settings.projects.table = decoded.views.projects.table;
  const notices =
    decoded.recovery?.malformedViews === undefined
      ? migration.notices
      : [...migration.notices, MALFORMED_VIEW_NOTICE];
  return { settings, notices };
}

function mergeListViewStates(
  raw: unknown,
  current: CalendarSettings['listViewStates'],
): Record<string, unknown> | undefined {
  if (current === undefined) return undefined;
  const base = isRecord(raw) ? raw : {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const entry = isRecord(base[key]) ? detached(base[key]) : {};
    delete entry['show'];
    entry['groupBy'] = value.groupBy;
    entry['sortBy'] = detached(value.sortBy);
    entry['filters'] = detached(value.filters);
    if (value.statusGroups === undefined) delete entry['statusGroups'];
    else entry['statusGroups'] = detached(value.statusGroups);
    merged[key] = entry;
  }
  return merged;
}

function mergeColumns(
  raw: unknown,
  current: CalendarSettings['projects']['table']['columns'],
): unknown[] {
  const saved: readonly unknown[] = Array.isArray(raw) ? raw : [];
  return current.map((column) => {
    const base: unknown = saved.find(
      (candidate) => isRecord(candidate) && candidate['id'] === column.id,
    );
    const merged = isRecord(base) ? detached(base) : {};
    merged['id'] = column.id;
    merged['visible'] = column.visible;
    if (column.label === undefined) delete merged['label'];
    else merged['label'] = column.label;
    if (column.width === undefined) delete merged['width'];
    else merged['width'] = column.width;
    return merged;
  });
}

function createStateEnvelope(
  settings: CalendarSettings,
  rawBase: Record<string, unknown> | undefined,
  recoveryAdditions?: SavedViewStateRecovery,
): Record<string, unknown> {
  const envelope = rawBase === undefined ? {} : detached(rawBase);
  const rawViews = isRecord(envelope['views']) ? envelope['views'] : {};
  const rawProjects = isRecord(rawViews['projects']) ? rawViews['projects'] : {};
  const rawTable = isRecord(rawProjects['table']) ? rawProjects['table'] : {};
  const listViewStates = mergeListViewStates(rawViews['listViewStates'], settings.listViewStates);
  const table = detached(rawTable);
  table['columns'] = mergeColumns(rawTable['columns'], settings.projects.table.columns);
  table['showDescription'] = settings.projects.table.showDescription;
  table['groupBy'] = settings.projects.table.groupBy;
  table['sortBy'] = detached(settings.projects.table.sortBy);
  table['hiddenStatuses'] = detached(settings.projects.table.hiddenStatuses);
  const projects = detached(rawProjects);
  projects['table'] = table;
  const views = detached(rawViews);
  if (listViewStates === undefined) delete views['listViewStates'];
  else views['listViewStates'] = listViewStates;
  views['sectionCollapse'] = {
    ...(isRecord(rawViews['sectionCollapse']) ? detached(rawViews['sectionCollapse']) : {}),
    ...detached(settings.sectionCollapse),
  };
  views['projects'] = projects;
  envelope['schemaVersion'] = SAVED_VIEW_STATE_SCHEMA_VERSION;
  envelope['views'] = views;
  const recovery = mergeRecovery(envelope['recovery'], recoveryAdditions);
  if (recovery === undefined) delete envelope['recovery'];
  else envelope['recovery'] = recovery;
  return envelope;
}

function createStaticDocument(settings: CalendarSettings): Record<string, unknown> {
  const data = detached(settings) as unknown as Record<string, unknown>;
  stripMovedFields(data);
  data[STATIC_SAVED_VIEW_STATE_MARKER] = SAVED_VIEW_STATE_SCHEMA_VERSION;
  return data;
}

function restoreLegacyViewFields(
  data: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ['listViewStates', 'sectionCollapse'] as const) {
    if (key in legacy) data[key] = detached(legacy[key]);
  }
  const legacyProjects = isRecord(legacy['projects']) ? legacy['projects'] : undefined;
  if (legacyProjects !== undefined && 'table' in legacyProjects) {
    const projects = isRecord(data['projects']) ? data['projects'] : {};
    projects['table'] = detached(legacyProjects['table']);
    data['projects'] = projects;
  }
  if (STATIC_SAVED_VIEW_STATE_MARKER in legacy) {
    data[STATIC_SAVED_VIEW_STATE_MARKER] = detached(legacy[STATIC_SAVED_VIEW_STATE_MARKER]);
  } else {
    delete data[STATIC_SAVED_VIEW_STATE_MARKER];
  }
  return data;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function parseState(text: string, defaults: CalendarSettings): LoadedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw errorWithCause('Could not parse saved view state.', cause);
  }
  if (!isRecord(parsed)) throw new Error('Saved view state is not a JSON object.');
  if (parsed['schemaVersion'] !== SAVED_VIEW_STATE_SCHEMA_VERSION) {
    const version = parsed['schemaVersion'];
    if (typeof version === 'number' && version > SAVED_VIEW_STATE_SCHEMA_VERSION) {
      throw new Error(`Saved view state uses unsupported future schema ${String(version)}.`);
    }
    throw new Error('Saved view state schema is missing or invalid.');
  }
  if (!isRecord(parsed['views'])) throw new Error('Saved view state views are missing or invalid.');
  const decoded = decodeViews(parsed['views'], defaults);
  return { envelope: parsed, decoded };
}

function staticRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error('Static plugin settings are not a JSON object.');
  return detached(value);
}

/** Owns the two settings documents and serializes every durable write. */
export class SettingsPersistenceCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private lastStaticSerialized: string | undefined;
  private lastStateSerialized: string | undefined;
  private rawStateEnvelope: Record<string, unknown> | undefined;
  private stateRecovery: SavedViewStateRecovery | undefined;
  private guardedLegacyStatic: Record<string, unknown> | undefined;
  private stateWritesSuspended = false;

  constructor(private readonly port: SettingsPersistencePort) {}

  async loadSettings(defaults: CalendarSettings): Promise<SettingsLoadResult> {
    let rawStatic: Record<string, unknown>;
    try {
      rawStatic = staticRecord(await this.port.loadStatic());
    } catch (cause) {
      throw errorWithCause('Could not read static plugin settings.', cause);
    }
    const state = await this.loadState(defaults);
    if (state.kind === 'valid' && state.loaded !== undefined) {
      return this.installRecognizedState(rawStatic, state.loaded, defaults);
    }
    if (state.kind === 'unavailable' && state.issue !== undefined) {
      this.stateWritesSuspended = true;
      if (rawStatic[STATIC_SAVED_VIEW_STATE_MARKER] !== SAVED_VIEW_STATE_SCHEMA_VERSION) {
        this.guardedLegacyStatic = detached(rawStatic);
      }
      const composed = composeSettings(rawStatic, decodeViews({}, defaults), defaults);
      this.lastStaticSerialized = serialize(this.staticDocument(composed.settings));
      return { ...composed, issues: [state.issue] };
    }
    if (rawStatic[STATIC_SAVED_VIEW_STATE_MARKER] === SAVED_VIEW_STATE_SCHEMA_VERSION) {
      const composed = composeSettings(rawStatic, decodeViews({}, defaults), defaults);
      this.lastStaticSerialized = serialize(createStaticDocument(composed.settings));
      return { ...composed, issues: [] };
    }
    return this.migrateLegacyState(rawStatic, defaults);
  }

  saveSettings(settings: CalendarSettings): Promise<void> {
    const payload = this.staticDocument(settings);
    const serialized = serialize(payload);
    return this.enqueue(async () => {
      if (serialized === this.lastStaticSerialized) return;
      await this.port.saveStatic(payload);
      this.lastStaticSerialized = serialized;
    });
  }

  saveViewState(settings: CalendarSettings): Promise<void> {
    if (this.stateWritesSuspended)
      return Promise.reject(new Error('Saved view state writes are suspended.'));
    const payload = createStateEnvelope(settings, this.rawStateEnvelope, this.stateRecovery);
    const serialized = serialize(payload);
    return this.enqueue(async () => {
      if (serialized === this.lastStateSerialized) return;
      await this.port.state.write(this.port.state.path, serialized);
      this.rawStateEnvelope = payload;
      this.lastStateSerialized = serialized;
    });
  }

  private async loadState(defaults: CalendarSettings): Promise<StateLoadOutcome> {
    let exists: boolean;
    try {
      exists = await this.port.state.exists(this.port.state.path);
    } catch (cause) {
      return {
        kind: 'unavailable',
        issue: { message: 'Could not check for saved view state.', cause },
      };
    }
    if (!exists) return { kind: 'missing' };
    let text: string;
    try {
      text = await this.port.state.read(this.port.state.path);
    } catch (cause) {
      return {
        kind: 'unavailable',
        issue: { message: 'Could not read saved view state.', cause },
      };
    }
    try {
      return { kind: 'valid', loaded: parseState(text, defaults) };
    } catch (cause) {
      return {
        kind: 'unavailable',
        issue: {
          message: cause instanceof Error ? cause.message : 'Could not decode saved view state.',
          cause,
        },
      };
    }
  }

  private staticDocument(settings: CalendarSettings): Record<string, unknown> {
    const data = createStaticDocument(settings);
    return this.guardedLegacyStatic === undefined
      ? data
      : restoreLegacyViewFields(data, this.guardedLegacyStatic);
  }

  private async installRecognizedState(
    rawStatic: Record<string, unknown>,
    loaded: LoadedState,
    defaults: CalendarSettings,
  ): Promise<SettingsLoadResult> {
    const composed = composeSettings(rawStatic, loaded.decoded, defaults);
    this.stateRecovery = mergeRecovery(loaded.envelope['recovery'], loaded.decoded.recovery);
    this.rawStateEnvelope = createStateEnvelope(
      composed.settings,
      loaded.envelope,
      this.stateRecovery,
    );
    this.lastStateSerialized = serialize(loaded.envelope);
    const staticPayload = createStaticDocument(composed.settings);
    this.lastStaticSerialized = serialize(staticPayload);
    if (
      rawStatic[STATIC_SAVED_VIEW_STATE_MARKER] !== SAVED_VIEW_STATE_SCHEMA_VERSION ||
      hasMovedFields(rawStatic)
    ) {
      this.lastStaticSerialized = undefined;
      await this.saveSettings(composed.settings);
    }
    return { ...composed, issues: [] };
  }

  private async migrateLegacyState(
    rawStatic: Record<string, unknown>,
    defaults: CalendarSettings,
  ): Promise<SettingsLoadResult> {
    const originalRawData = detached(rawStatic);
    const legacyViews = movedViewSource(originalRawData);
    const decoded = decodeViews(legacyViews, defaults);
    const composed = composeSettings(rawStatic, decoded, defaults);
    this.stateRecovery = mergeRecovery(decoded.recovery, { preSplitData: originalRawData });
    const statePayload = createStateEnvelope(
      composed.settings,
      { schemaVersion: SAVED_VIEW_STATE_SCHEMA_VERSION, views: legacyViews },
      this.stateRecovery,
    );
    const stateSerialized = serialize(statePayload);
    await this.port.state.write(this.port.state.path, stateSerialized);
    const verified = await this.port.state.read(this.port.state.path);
    if (verified !== stateSerialized)
      throw new Error('Could not verify initial saved view state write.');
    this.rawStateEnvelope = statePayload;
    this.lastStateSerialized = stateSerialized;
    const staticPayload = createStaticDocument(composed.settings);
    await this.port.saveStatic(staticPayload);
    this.lastStaticSerialized = serialize(staticPayload);
    return { ...composed, issues: [] };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
