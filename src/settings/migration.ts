import {
  migrateProjectBoardPreference,
  migrateProjectTimelinePreferences,
} from '../panels/projects/projectViewPreferences';
import { inferLifecycleBehavior } from '../projects/lifecycle';
import {
  buildDisabledWorkNotePreset,
  isAuditAccepted,
  isWorkNotePreset,
} from '../projects/work-notes/compatibility';
import { ACTIVE_STATUS_GROUPS, TYPE_ORDER } from '../status/statusConstants';
import {
  buildDefaultProjectsSettings,
  buildDefaultProjectsTablePreference,
  buildDefaultProjectsView,
  buildDefaultProjectTasksTablePreference,
  buildDefaultTaskStatuses,
} from './defaults';
import { migrateShortcuts } from './shortcuts';
import type { ProjectTableColumnPreference } from './types';

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
  if (inbox && typeof inbox === 'object') {
    const box = inbox as Record<string, unknown>;
    if ('showUntagged' in box) {
      if (box['showUntagged'] === true && box['mode'] === 'tag') box['mode'] = 'both';
      delete box['showUntagged'];
    }
  }
}

function migrateProjects(raw: Record<string, unknown>): void {
  if (!('projects' in raw)) raw['projects'] = buildDefaultProjectsSettings();
  const projects = raw['projects'];
  if (projects && typeof projects === 'object') {
    const p = projects as {
      statuses?: Array<{ id: string; label?: unknown; behavior?: unknown }>;
      defaultStatusId?: string;
      taskInsertionMode?: string;
      taskInsertionSection?: string;
      workNoteCompatibility?: unknown;
      view?: unknown;
    };
    const ids = (p.statuses ?? []).map((s) => s.id);
    for (const status of p.statuses ?? []) {
      if (
        status.behavior !== 'regular' &&
        status.behavior !== 'completed' &&
        status.behavior !== 'dropped' &&
        status.behavior !== 'published'
      ) {
        status.behavior = inferLifecycleBehavior(
          typeof status.label === 'string' ? status.label : '',
        );
      }
    }
    if (!p.defaultStatusId || !ids.includes(p.defaultStatusId)) {
      p.defaultStatusId = ids[0] ?? '';
    }
    // Backfill project-specific insertion settings for pre-existing configs.
    const defaults = buildDefaultProjectsSettings();
    if (p.taskInsertionMode !== 'append' && p.taskInsertionMode !== 'section') {
      p.taskInsertionMode = defaults.taskInsertionMode;
    }
    if (typeof p.taskInsertionSection !== 'string') {
      p.taskInsertionSection = defaults.taskInsertionSection;
    }
    if (!isWorkNotePreset(p.workNoteCompatibility)) {
      p.workNoteCompatibility = buildDisabledWorkNotePreset();
    } else if (
      'acceptedAudit' in p.workNoteCompatibility &&
      !isAuditAccepted(p.workNoteCompatibility)
    ) {
      delete (p.workNoteCompatibility as { acceptedAudit?: unknown }).acceptedAudit;
    }
    migrateProjectsView(p);
  }
}

const PROJECT_TASK_GROUPS = new Set(['none', 'date', 'priority', 'tag', 'status']);
const PROJECT_TASK_SORTS = new Set(['date', 'priority', 'title', 'tag', 'status']);
const WORK_NOTE_GROUPS = new Set(['none', 'status', 'priority', 'milestone']);
const WORK_NOTE_SORTS = new Set(['title', 'status', 'priority', 'start', 'end', 'updated']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validSort(
  value: unknown,
  fields: ReadonlySet<string>,
): value is { field: string; dir: string } {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate['field'] === 'string' &&
    fields.has(candidate['field']) &&
    typeof candidate['dir'] === 'string' &&
    SORT_DIRECTIONS.has(candidate['dir'])
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function tableColumn(value: unknown): value is ProjectTableColumnPreference {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate['propertyId'] === 'string' &&
    typeof candidate['visible'] === 'boolean' &&
    (candidate['width'] === undefined || typeof candidate['width'] === 'number')
  );
}

function migrateTableColumns(
  value: unknown,
  defaults: readonly ProjectTableColumnPreference[],
): readonly ProjectTableColumnPreference[] {
  if (!Array.isArray(value)) return defaults.map((column) => ({ ...column }));
  const columns = value.filter(tableColumn);
  if (columns.length > 0 || value.length === 0) return columns;
  return defaults.map((column) => ({ ...column }));
}

function migrateTablePreference(
  value: unknown,
  defaults: { readonly version: 1; readonly columns: readonly ProjectTableColumnPreference[] },
): Record<string, unknown> {
  const preference = record(value);
  if (!preference) {
    return {
      ...defaults,
      columns: defaults.columns.map((column) => ({ ...column })),
      collapsedGroups: [],
    };
  }
  if (preference['version'] !== 1) preference['version'] = 1;
  preference['columns'] = migrateTableColumns(preference['columns'], defaults.columns);
  if (!stringArray(preference['collapsedGroups'])) preference['collapsedGroups'] = [];
  return preference;
}

const PROJECT_TASK_COLLECTION_LAYOUTS = new Set(['list', 'table', 'board', 'timeline']);
const PROJECT_COLLECTION_LAYOUTS = new Set(['list', 'board', 'timeline']);
const TASK_PRIORITIES = new Set(['A', 'B', 'C', 'D', 'E', 'F']);

function validTaskFilters(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    const filter = record(entry);
    if (!filter || typeof filter['type'] !== 'string') return false;
    if (filter['type'] === 'file') return typeof filter['filePath'] === 'string';
    if (filter['type'] === 'priority')
      return typeof filter['value'] === 'string' && TASK_PRIORITIES.has(filter['value']);
    return (
      ['tag', 'time', 'status', 'date'].includes(filter['type']) &&
      typeof filter['value'] === 'string'
    );
  });
}

function taskCollectionBaseline(tasks: Record<string, unknown>): Record<string, unknown> {
  const table = migrateTablePreference(
    structuredClone(tasks['table']),
    buildDefaultProjectTasksTablePreference(),
  );
  const columns = table['columns'] as readonly ProjectTableColumnPreference[];
  const statusGroups = stringArray(tasks['statusGroups']) ? tasks['statusGroups'] : [];
  return {
    version: 1,
    layout: 'list',
    filters: validTaskFilters(tasks['filters']) ? structuredClone(tasks['filters']) : [],
    group: PROJECT_TASK_GROUPS.has(String(tasks['groupBy'])) ? tasks['groupBy'] : 'none',
    sort: validSort(tasks['sortBy'], PROJECT_TASK_SORTS)
      ? structuredClone(tasks['sortBy'])
      : { field: 'date', dir: 'asc' },
    visibleFields: columns.filter((column) => column.visible).map((column) => column.propertyId),
    layoutPreferences: {
      primary: { table, statusGroups: [...statusGroups] },
    },
  };
}

function workNotesCollectionBaseline(workNotes: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    layout: 'list',
    filters: stringArray(workNotes['statusIds']) ? [...workNotes['statusIds']] : [],
    group: WORK_NOTE_GROUPS.has(String(workNotes['groupBy'])) ? workNotes['groupBy'] : 'none',
    sort: validSort(workNotes['sortBy'], WORK_NOTE_SORTS)
      ? structuredClone(workNotes['sortBy'])
      : { field: 'updated', dir: 'desc' },
    visibleFields: [],
    layoutPreferences: {},
  };
}

function normalizeTaskCollectionPreference(
  value: unknown,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  const current = record(value) ?? {};
  const layouts = record(current['layoutPreferences']) ?? {};
  const primary = record(layouts['primary']) ?? {};
  const baselinePrimary = baseline['layoutPreferences'] as Record<string, Record<string, unknown>>;
  const fallbackPrimary = baselinePrimary['primary']!;
  const statusGroups = stringArray(primary['statusGroups'])
    ? primary['statusGroups']
    : (fallbackPrimary['statusGroups'] as string[]);
  return {
    ...current,
    version: 1,
    layout: PROJECT_TASK_COLLECTION_LAYOUTS.has(String(current['layout']))
      ? current['layout']
      : baseline['layout'],
    filters: validTaskFilters(current['filters'])
      ? structuredClone(current['filters'])
      : structuredClone(baseline['filters']),
    group: PROJECT_TASK_GROUPS.has(String(current['group'])) ? current['group'] : baseline['group'],
    sort: validSort(current['sort'], PROJECT_TASK_SORTS)
      ? structuredClone(current['sort'])
      : structuredClone(baseline['sort']),
    visibleFields: stringArray(current['visibleFields'])
      ? [...current['visibleFields']]
      : structuredClone(baseline['visibleFields']),
    layoutPreferences: {
      ...layouts,
      primary: {
        ...primary,
        table: migrateTablePreference(
          structuredClone(primary['table']),
          fallbackPrimary['table'] as {
            readonly version: 1;
            readonly columns: readonly ProjectTableColumnPreference[];
          },
        ),
        statusGroups: [...statusGroups],
      },
    },
  };
}

function normalizeWorkNotesCollectionPreference(
  value: unknown,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  const current = record(value) ?? {};
  return {
    ...current,
    version: 1,
    layout: PROJECT_COLLECTION_LAYOUTS.has(String(current['layout']))
      ? current['layout']
      : baseline['layout'],
    filters: stringArray(current['filters'])
      ? [...current['filters']]
      : structuredClone(baseline['filters']),
    group: WORK_NOTE_GROUPS.has(String(current['group'])) ? current['group'] : baseline['group'],
    sort: validSort(current['sort'], WORK_NOTE_SORTS)
      ? structuredClone(current['sort'])
      : structuredClone(baseline['sort']),
    visibleFields: stringArray(current['visibleFields'])
      ? [...current['visibleFields']]
      : structuredClone(baseline['visibleFields']),
    layoutPreferences: record(current['layoutPreferences']) ?? {},
  };
}

/** Ensures every persisted Project scope is safe before collection coordinators read it. */
export function normalizeProjectCollectionPreferences(view: Record<string, unknown>): void {
  const tasks = record(view['tasks']);
  const workNotes = record(view['workNotes']);
  if (!tasks || !workNotes) return;
  const taskBaseline = taskCollectionBaseline(tasks);
  const workNotesBaseline = workNotesCollectionBaseline(workNotes);
  const collectionPreferences = record(view['collectionPreferences']) ?? {};
  for (const [path, rawEntry] of Object.entries(collectionPreferences)) {
    const entry = record(rawEntry) ?? {};
    collectionPreferences[path] = {
      ...entry,
      tasks: normalizeTaskCollectionPreference(entry['tasks'], taskBaseline),
      workNotes: normalizeWorkNotesCollectionPreference(entry['workNotes'], workNotesBaseline),
    };
  }
  view['collectionPreferences'] = collectionPreferences;
}

function migrateProjectsView(projects: { statuses?: Array<{ id: string }>; view?: unknown }): void {
  const ids = (projects.statuses ?? []).map(({ id }) => id);
  const defaults = buildDefaultProjectsView(ids);
  const view = record(projects.view);
  if (!view) {
    projects.view = defaults;
    return;
  }

  if (!['overview', 'board', 'timeline'].includes(String(view['portfolioLayout']))) {
    view['portfolioLayout'] = defaults.portfolioLayout;
  }
  if (!['none', 'status', 'priority'].includes(String(view['portfolioGroupBy']))) {
    view['portfolioGroupBy'] = defaults.portfolioGroupBy;
  }
  if (
    !validSort(
      view['portfolioSortBy'],
      new Set(['title', 'status', 'priority', 'progress', 'start', 'end']),
    )
  ) {
    view['portfolioSortBy'] = structuredClone(defaults.portfolioSortBy);
  }
  if (!stringArray(view['visibleStatusIds'])) {
    view['visibleStatusIds'] = [...defaults.visibleStatusIds];
  }
  if (typeof view['includeUnmapped'] !== 'boolean') {
    view['includeUnmapped'] = defaults.includeUnmapped;
  }
  view['table'] = migrateTablePreference(view['table'], buildDefaultProjectsTablePreference());
  view['board'] = migrateProjectBoardPreference(view['board'], ids);
  view['timeline'] = migrateProjectTimelinePreferences(view['timeline']);

  const tasks = record(view['tasks']);
  if (!tasks) {
    view['tasks'] = defaults.tasks;
  } else {
    if (typeof tasks['groupBy'] !== 'string' || !PROJECT_TASK_GROUPS.has(tasks['groupBy'])) {
      tasks['groupBy'] = defaults.tasks.groupBy;
    }
    if (!validSort(tasks['sortBy'], PROJECT_TASK_SORTS)) {
      tasks['sortBy'] = { ...defaults.tasks.sortBy };
    }
    if (!Array.isArray(tasks['filters'])) tasks['filters'] = [];
    if ('statusGroups' in tasks && !stringArray(tasks['statusGroups'])) {
      tasks['statusGroups'] = [...(defaults.tasks.statusGroups ?? [])];
    }
    tasks['table'] = migrateTablePreference(
      tasks['table'],
      buildDefaultProjectTasksTablePreference(),
    );
  }

  const workNotes = record(view['workNotes']);
  if (!workNotes) {
    view['workNotes'] = defaults.workNotes;
  } else {
    if (typeof workNotes['groupBy'] !== 'string' || !WORK_NOTE_GROUPS.has(workNotes['groupBy'])) {
      workNotes['groupBy'] = defaults.workNotes.groupBy;
    }
    if (!validSort(workNotes['sortBy'], WORK_NOTE_SORTS)) {
      workNotes['sortBy'] = { ...defaults.workNotes.sortBy };
    }
    if (!stringArray(workNotes['statusIds'])) {
      workNotes['statusIds'] = [...defaults.workNotes.statusIds];
    }
  }
  normalizeProjectCollectionPreferences(view);
}

/**
 * Per-status color/iconKind were folded into the priority-color + lucide-only
 * visual contract: color is no longer stored per status, and glyph icons are
 * no longer supported (Lucide only). Check iconKind BEFORE deleting it.
 */
function stripLegacyStatusFields(taskStatuses: unknown[]): void {
  for (const entry of taskStatuses) {
    if (!entry || typeof entry !== 'object') continue;
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
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['core'] !== true) continue;
    const canonical = canonicalCore.find((c) => c.type === e['type']);
    if (!canonical) continue;
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
function migrateListViewStates(raw: Record<string, unknown>): void {
  const states = raw['listViewStates'];
  if (!states || typeof states !== 'object') return;
  for (const key of Object.keys(states)) {
    const entry = (states as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const vs = entry as Record<string, unknown>;
    if ('show' in vs) {
      if (!('statusGroups' in vs) || vs['statusGroups'] === undefined) {
        switch (vs['show']) {
          case 'active':
            vs['statusGroups'] = [...ACTIVE_STATUS_GROUPS];
            break;
          case 'completed':
            vs['statusGroups'] = [...DONE_CANCELLED_STATUS_GROUPS];
            break;
          case 'all':
          default:
            vs['statusGroups'] = undefined;
            break;
        }
      }
      delete vs['show'];
    }
  }
}

function migrateTaskLifecycle(raw: Record<string, unknown>): void {
  if (!raw['taskLifecycle'] || typeof raw['taskLifecycle'] !== 'object') {
    raw['taskLifecycle'] = { addCreatedDate: true, addCompletionDate: true };
    return;
  }
  const lifecycle = raw['taskLifecycle'] as Record<string, unknown>;
  if (typeof lifecycle['addCreatedDate'] !== 'boolean') lifecycle['addCreatedDate'] = true;
  if (typeof lifecycle['addCompletionDate'] !== 'boolean') lifecycle['addCompletionDate'] = true;
}

function migrateRecurrence(raw: Record<string, unknown>): void {
  if (!raw['recurrence'] || typeof raw['recurrence'] !== 'object') {
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

export function migrateSettings(raw: Record<string, unknown>): void {
  migrateInbox(raw);
  if (!('pinnedTags' in raw)) raw['pinnedTags'] = [];
  if (!('archivedTags' in raw)) raw['archivedTags'] = [];
  migrateProjects(raw);
  if (!('sectionCollapse' in raw)) {
    raw['sectionCollapse'] = { pinned: false, projects: false, tags: false };
  }
  migrateTaskStatuses(raw);
  migrateListViewStates(raw);
  migrateTaskLifecycle(raw);
  migrateRecurrence(raw);
  migrateShortcuts(raw);
}
