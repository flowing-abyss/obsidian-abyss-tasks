import { buildDefaultProjectTableSettings } from '../projects/projectTableSettings';
import { ACTIVE_STATUS_GROUPS } from '../status/statusConstants';
import { defaultShortcuts } from './shortcuts';
import type { CalendarSettings, ListViewState, ProjectsSettings, TaskStatusDef } from './types';

export function buildDefaultProjectsSettings(): ProjectsSettings {
  let n = 0;
  const statusId = (): string => {
    n += 1;
    return `status-${n}`;
  };

  const inbox: ProjectsSettings['statuses'][number] = {
    id: statusId(),
    name: 'inbox',
    color: 'orange',
    display: 'badge',
    onLeftPanel: false,
  };
  const todo: ProjectsSettings['statuses'][number] = {
    id: statusId(),
    name: 'todo',
    color: 'red',
    display: 'badge',
    onLeftPanel: false,
  };
  const wip: ProjectsSettings['statuses'][number] = {
    id: statusId(),
    name: 'wip',
    color: 'blue',
    display: 'badge',
    onLeftPanel: true,
  };
  const done: ProjectsSettings['statuses'][number] = {
    id: statusId(),
    name: 'done',
    color: 'green',
    display: 'badge',
    onLeftPanel: false,
  };
  return {
    membershipQuery: 'projects/',
    createFolder: 'projects',
    templatePath: '',
    statusProperty: 'status',
    startProperty: 'start',
    endProperty: 'end',
    propertyDefinitions: {},
    statuses: [inbox, todo, wip, done],
    defaultStatusId: inbox.id,
    taskInsertionMode: 'section',
    taskInsertionSection: '# Tasks',
    taskInsertionSectionPosition: 'top',
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
  firstDayOfWeek: 1,
  taskPrefix: '',
  taskFilePath: 'tasks/active.md',
  taskArchivePath: 'tasks/archive.md',
  taskIgnoreQuery: '',
  taskTemplatePath: '',
  inbox: {
    mode: 'untagged',
    tag: '',
    removeTagOnAssign: true,
  },
  pinnedTags: [],
  archivedTags: [],
  archivedTagPrefixes: [],
  tagGroups: [],
  taskInsertionMode: 'append',
  taskInsertionSection: '## Tasks',
  taskInsertionSectionPosition: 'top',
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
