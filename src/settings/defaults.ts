import {
  buildProjectBoardPreference,
  buildProjectTimelinePreferences,
} from '../panels/projects/projectViewPreferences';
import { buildDisabledWorkNotePreset } from '../projects/work-notes/compatibility';
import { ACTIVE_STATUS_GROUPS } from '../status/statusConstants';
import { defaultShortcuts } from './shortcuts';
import type {
  CalendarSettings,
  ListViewState,
  ProjectsSettings,
  ProjectsTablePreference,
  ProjectsViewSettings,
  ProjectTasksTablePreference,
  TaskStatusDef,
  ViewConfig,
} from './types';

export function buildDefaultProjectsTablePreference(): ProjectsTablePreference {
  return {
    version: 1,
    columns: [
      { propertyId: 'project', visible: true },
      { propertyId: 'status', visible: true },
      { propertyId: 'priority', visible: true },
      { propertyId: 'progress', visible: true },
      { propertyId: 'nextAction', visible: true },
      { propertyId: 'start', visible: true },
      { propertyId: 'end', visible: true },
    ],
    collapsedGroups: [],
  };
}

export function buildDefaultProjectTasksTablePreference(): ProjectTasksTablePreference {
  return {
    version: 1,
    columns: [
      { propertyId: 'task', visible: true },
      { propertyId: 'status', visible: true },
      { propertyId: 'priority', visible: true },
      { propertyId: 'due', visible: true },
      { propertyId: 'nextAction', visible: true },
    ],
    collapsedGroups: [],
  };
}

export function buildDefaultProjectsView(statusIds: readonly string[]): ProjectsViewSettings {
  return {
    portfolioLayout: 'overview',
    visibleStatusIds: [...statusIds],
    includeUnmapped: true,
    table: buildDefaultProjectsTablePreference(),
    board: buildProjectBoardPreference(statusIds),
    timeline: buildProjectTimelinePreferences(),
    tasks: {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [],
      statusGroups: [...ACTIVE_STATUS_GROUPS],
      table: buildDefaultProjectTasksTablePreference(),
    },
    workNotes: {
      groupBy: 'none',
      sortBy: { field: 'updated', dir: 'desc' },
      statusIds: [...statusIds],
    },
  };
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  defaultView: 'month',
  firstDayOfWeek: 1,
  dailyNoteFolder: 'periodic/daily',
  dailyNoteFormat: 'YYYY-MM-DD',
  upcomingDays: 7,
  style: 'style1',
  globalTaskFilter: '',
  startPosition: '',
  tag: '',
  folder: '',
};

export function buildDefaultProjectsSettings(): ProjectsSettings {
  let n = 0;
  const statusId = (): string => {
    n += 1;
    return `status-${n}`;
  };

  const active: ProjectsSettings['statuses'][number] = {
    id: statusId(),
    label: 'Active',
    color: '#4caf50',
    onLeftPanel: true,
    behavior: 'regular',
    match: { kind: 'property', property: 'status', value: 'active' },
  };
  const planned = {
    id: statusId(),
    label: 'Planned',
    color: '#2196f3',
    onLeftPanel: false,
    behavior: 'regular' as const,
    match: { kind: 'property' as const, property: 'status', value: 'planned' },
  };
  const done = {
    id: statusId(),
    label: 'Done',
    color: '#888888',
    onLeftPanel: false,
    behavior: 'completed' as const,
    match: { kind: 'property' as const, property: 'status', value: 'done' },
  };
  return {
    membershipQuery: 'Projects/',
    createFolder: 'Projects',
    templatePath: '',
    statuses: [active, planned, done],
    defaultStatusId: active.id,
    taskInsertionMode: 'append',
    taskInsertionSection: '## Tasks',
    workNoteCompatibility: buildDisabledWorkNotePreset(),
    view: buildDefaultProjectsView([active.id, planned.id, done.id]),
  };
}

/**
 * The 4 core group statuses: fully locked (symbol, type, and icon are fixed)
 * so the calendar looks predictable out of the box. Marker shape already
 * conveys in-progress (circle) vs. the rest (rounded square), so in-progress
 * intentionally carries no icon on top of that.
 */
export function buildDefaultTaskStatuses(): TaskStatusDef[] {
  return [
    {
      id: 'status-1',
      symbol: ' ',
      name: 'To-do',
      type: 'todo',
      icon: '',
      core: true,
    },
    {
      id: 'status-2',
      symbol: '/',
      name: 'In progress',
      type: 'in-progress',
      icon: '',
      core: true,
    },
    {
      id: 'status-3',
      symbol: 'x',
      name: 'Done',
      type: 'done',
      icon: 'check',
      core: true,
    },
    {
      id: 'status-4',
      symbol: '-',
      name: 'Cancelled',
      type: 'cancelled',
      icon: 'x',
      core: true,
    },
  ];
}

export const DEFAULT_SETTINGS: CalendarSettings = {
  desktop: { ...DEFAULT_VIEW_CONFIG },
  mobile: { ...DEFAULT_VIEW_CONFIG, defaultView: 'list' },
  taskPrefix: '#task/one-off',
  addToToday: true,
  customFilePath: '',
  inbox: {
    mode: 'tag',
    tag: '#task/inbox',
    removeTagOnAssign: true,
  },
  pinnedTags: [],
  archivedTags: [],
  tagGroups: [],
  dailyNoteProvider: 'auto',
  manualDailyNotePath: 'YYYY-MM-DD',
  taskInsertionMode: 'append',
  taskInsertionSection: '## Tasks',
  sourceNoteDisplay: 'non-default' as const,
  projects: buildDefaultProjectsSettings(),
  sectionCollapse: { pinned: false, projects: false, tags: false },
  taskStatuses: buildDefaultTaskStatuses(),
  taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
  recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
  shortcuts: defaultShortcuts(),
};

export function getListViewDefaults(listKey: string): ListViewState {
  const useDateGrouping = listKey === 'today' || listKey === 'upcoming';
  return {
    groupBy: useDateGrouping ? 'date' : 'none',
    sortBy: { field: 'date', dir: 'asc' },
    filters: [],
    // Default "Show" is Active (open + in-progress) — preserves the old
    // show:'active' default under the unified statusGroups filter.
    statusGroups: [...ACTIVE_STATUS_GROUPS],
  };
}
