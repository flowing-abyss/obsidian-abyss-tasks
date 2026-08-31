import type {
  ProjectBoardPreference,
  ProjectTimelinePreferences,
} from '../panels/projects/projectViewPreferences';
import type { ProjectLifecycleBehavior } from '../projects/lifecycle';
import type { WorkNoteCompatibilityPreset } from '../projects/work-notes/types';
import type { TaskPriority, TaskStatusType } from '../tasks/domain/types';
import type { ShortcutSettings } from './shortcuts';

export interface TaskStatusDef {
  id: string;
  symbol: string; // exactly one character written inside [ ]
  name: string;
  type: TaskStatusType;
  icon: string; // Lucide icon id; '' = empty chip
  core: boolean; // symbol+type locked, not deletable
}

export interface ViewConfig {
  defaultView: 'month' | 'week' | 'list';
  firstDayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  dailyNoteFolder: string;
  dailyNoteFormat: string; // moment format, e.g. 'YYYY-MM-DD'
  upcomingDays: number;
  style: string; // CSS class, e.g. 'style1'–'style11'
  globalTaskFilter: string; // tag to strip, e.g. '#task' or ''
  startPosition: string; // month 'YYYY-MM', exact week start 'YYYY-MM-DD', legacy week 'YYYY-ww', or ''
  tag: string; // scope to vault tag or ''
  folder: string; // scope to vault folder prefix or ''
}

// Fully resolved view config — produced by merging defaults → platform settings → code-block params
export interface ResolvedConfig extends ViewConfig {
  isMobile: boolean;
  sourceNoteDisplay: 'never' | 'always' | 'non-default';
  customFilePath: string;
}

export interface TagGroup {
  id: string;
  name: string;
  color?: string;
  mode: 'prefix' | 'manual';
  prefix?: string; // prefix mode: 'work' matches #work and #work/*
  tags?: string[]; // manual mode: explicit tag list
}

interface InboxSettings {
  mode: 'tag' | 'untagged' | 'both';
  tag: string;
  removeTagOnAssign: boolean;
}

type StatusMatch =
  | { kind: 'property'; property: string; value: string }
  | { kind: 'tag'; tag: string };

export interface ProjectStatus {
  id: string;
  label: string;
  color?: string;
  onLeftPanel: boolean;
  behavior: ProjectLifecycleBehavior;
  match: StatusMatch;
}

type ProjectsPortfolioLayout = 'overview' | 'board' | 'timeline';

export interface ProjectTableColumnPreference {
  readonly propertyId: string;
  readonly visible: boolean;
  readonly width?: number;
}

export interface ProjectsTablePreference {
  readonly version: 1;
  readonly columns: readonly ProjectTableColumnPreference[];
  readonly collapsedGroups: readonly string[];
}

export interface ProjectTasksTablePreference {
  readonly version: 1;
  readonly columns: readonly ProjectTableColumnPreference[];
  readonly collapsedGroups: readonly string[];
}

export interface PersistedCollectionPreference<TFilter, TGroup, TSort, TLayout, TLayoutPreference> {
  readonly version: 1;
  readonly layout: TLayout;
  readonly filters: readonly TFilter[];
  readonly group: TGroup;
  readonly sort: TSort;
  readonly visibleFields: readonly string[];
  readonly layoutPreferences: Readonly<Record<string, TLayoutPreference>>;
}

export interface CollectionSessionState {
  readonly query: string;
  readonly selectionKey: string | null;
  readonly focusedKey: string | null;
  readonly scrollAnchor: string | null;
  readonly openSurface: string | null;
}

export interface ProjectTasksViewState {
  readonly groupBy: ListViewState['groupBy'];
  readonly sortBy: ListViewState['sortBy'];
  readonly filters: readonly PropertyFilter[];
  readonly statusGroups?: readonly TaskStatusType[];
  readonly table?: ProjectTasksTablePreference;
}

export interface WorkNotesViewState {
  readonly groupBy: 'none' | 'status' | 'priority' | 'milestone';
  readonly sortBy: {
    field: 'title' | 'status' | 'priority' | 'start' | 'end' | 'updated';
    dir: 'asc' | 'desc';
  };
  readonly statusIds: readonly string[];
}

export interface ProjectsViewSettings {
  portfolioLayout: ProjectsPortfolioLayout;
  visibleStatusIds: string[];
  includeUnmapped: boolean;
  table?: ProjectsTablePreference;
  board: ProjectBoardPreference;
  timeline: ProjectTimelinePreferences;
  tasks: ProjectTasksViewState;
  workNotes: WorkNotesViewState;
}

export interface ProjectsSettings {
  membershipQuery: string;
  createFolder: string;
  templatePath: string;
  statuses: ProjectStatus[];
  defaultStatusId: string;
  // Where a task lands inside a project note when it is created there or moved
  // in (drag-and-drop). Independent of the global task-insertion setting so
  // project notes can keep tasks under a dedicated heading.
  taskInsertionMode: 'append' | 'section';
  taskInsertionSection: string;
  workNoteCompatibility: WorkNoteCompatibilityPreset;
  view: ProjectsViewSettings;
}

export interface CalendarSettings {
  desktop: ViewConfig;
  mobile: ViewConfig;
  taskPrefix: string;
  addToToday: boolean;
  customFilePath: string;
  inbox: InboxSettings;
  pinnedTags: string[];
  archivedTags: string[];
  tagGroups: TagGroup[];
  dailyNoteProvider: 'auto' | 'periodic-notes' | 'core' | 'obsidian-journal' | 'manual';
  manualDailyNotePath: string; // e.g. 'Daily/YYYY-MM-DD' or just 'YYYY-MM-DD'
  taskInsertionMode: 'append' | 'section';
  taskInsertionSection: string;
  sourceNoteDisplay: 'never' | 'always' | 'non-default';
  listViewStates?: Record<string, ListViewState>;
  projects: ProjectsSettings;
  sectionCollapse: { pinned: boolean; projects: boolean; tags: boolean };
  taskStatuses: TaskStatusDef[];
  taskLifecycle: {
    addCreatedDate: boolean;
    addCompletionDate: boolean;
  };
  recurrence: {
    newOccurrencePlacement: 'before' | 'after';
    removeScheduledDate: boolean;
  };
  shortcuts: ShortcutSettings;
}

// Params parsed from a task-calendar code block (all optional overrides of ViewConfig)
export interface CodeBlockParams {
  view?: 'month' | 'week' | 'list';
  firstDayOfWeek?: number;
  dailyNoteFolder?: string;
  dailyNoteFormat?: string;
  upcomingDays?: number;
  style?: string;
  globalTaskFilter?: string;
  startPosition?: string;
  tag?: string;
  folder?: string;
}

export type PropertyFilter =
  | { type: 'tag'; value: string }
  | { type: 'file'; filePath: string }
  | { type: 'time'; value: string }
  | { type: 'priority'; value: TaskPriority }
  | { type: 'status'; value: string }
  | { type: 'date'; value: string };

export interface ListViewState {
  groupBy: 'none' | 'date' | 'priority' | 'tag' | 'status';
  sortBy: { field: 'date' | 'priority' | 'title' | 'tag' | 'status'; dir: 'asc' | 'desc' };
  filters: PropertyFilter[];
  // The single "Show" status filter. undefined, or all 4 groups present, means
  // "no filtering" (show all groups). A real subset (1-3 groups) restricts
  // tasks to those status groups.
  statusGroups?: TaskStatusType[];
}
