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
  buildDefaultProjectsView,
  buildDefaultTaskStatuses,
} from './defaults';
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
  if (!stringArray(view['visibleStatusIds'])) {
    view['visibleStatusIds'] = [...defaults.visibleStatusIds];
  }
  if (typeof view['includeUnmapped'] !== 'boolean') {
    view['includeUnmapped'] = defaults.includeUnmapped;
  }
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
