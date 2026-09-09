import { buildDefaultProjectTableSettings } from '../projects/projectTableSettings';
import { ACTIVE_STATUS_GROUPS } from '../status/statusConstants';
import { defaultShortcuts } from './shortcuts';
import type {
  CalendarSettings,
  ListViewState,
  ProjectsSettings,
  TaskStatusDef,
  ViewConfig,
} from './types';

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
    name: 'active',
    color: '#4caf50',
    onLeftPanel: true,
  };
  const planned = {
    id: statusId(),
    name: 'planned',
    color: '#2196f3',
    onLeftPanel: false,
  };
  const done = {
    id: statusId(),
    name: 'done',
    color: '#888888',
    onLeftPanel: false,
  };
  return {
    membershipQuery: 'Projects/',
    createFolder: 'Projects',
    templatePath: '',
    statusProperty: 'status',
    startProperty: 'start',
    endProperty: 'end',
    statuses: [active, planned, done],
    defaultStatusId: active.id,
    taskInsertionMode: 'append',
    taskInsertionSection: '## Tasks',
    table: buildDefaultProjectTableSettings(),
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
