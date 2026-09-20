import type { ProjectTableSettings } from '../projects/projectFields';
import type { ProjectKanbanSettings, ProjectOverviewMode } from '../projects/projectKanbanSettings';
import type {
  ProjectPropertyDefinition,
  ProjectValuePresentation,
} from '../projects/projectPropertyDefinitions';
import type { ProjectTimelineSettings } from '../projects/projectTimelineSettings';
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

export interface ResolvedConfig {
  firstDayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startPosition: string;
}

export interface TagGroup {
  id: string;
  name: string;
  color?: string;
  archived?: boolean;
  mode: 'prefix' | 'manual';
  prefix?: string; // prefix mode: 'work' matches #work and #work/*
  tags?: string[]; // manual mode: explicit tag list
}

interface InboxSettings {
  mode: 'tag' | 'untagged' | 'both';
  tag: string;
  removeTagOnAssign: boolean;
}

export interface ProjectStatus extends ProjectValuePresentation {
  id: string;
  name: string;
  color?: string;
  onLeftPanel: boolean;
}

interface ProjectStatusMigration {
  issue: 'conflicting-properties' | 'invalid-statuses';
  legacyStatuses: unknown[];
  propertyCandidates: string[];
}

export interface ProjectsSettings {
  membershipQuery: string;
  createFolder: string;
  templatePath: string;
  statusProperty: string;
  startProperty: string;
  endProperty: string;
  propertyDefinitions: Record<string, ProjectPropertyDefinition>;
  statuses: ProjectStatus[];
  statusMigration?: ProjectStatusMigration;
  defaultStatusId: string;
  // Where a task lands inside a project note when it is created there or moved
  // in (drag-and-drop). Independent of the global task-insertion setting so
  // project notes can keep tasks under a dedicated heading.
  taskInsertionMode: 'append' | 'prepend' | 'section';
  taskInsertionSection: string;
  taskInsertionSectionPosition: 'top' | 'bottom';
  table: ProjectTableSettings;
  kanban?: ProjectKanbanSettings;
  timeline?: ProjectTimelineSettings;
  overviewView?: ProjectOverviewMode;
}

export interface CalendarSettings {
  firstDayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  taskPrefix: string;
  taskFilePath: string;
  taskArchivePath: string;
  taskIgnoreQuery: string;
  taskTemplatePath: string;
  inbox: InboxSettings;
  pinnedTags: string[];
  archivedTags: string[];
  archivedTagPrefixes: string[];
  tagGroups: TagGroup[];
  taskInsertionMode: 'append' | 'prepend' | 'section';
  taskInsertionSection: string;
  taskInsertionSectionPosition: 'top' | 'bottom';
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

/** Saved view preferences composed into CalendarSettings at runtime. */
export interface SavedViewState {
  listViewStates?: Record<string, ListViewState>;
  sectionCollapse: CalendarSettings['sectionCollapse'];
  projects: {
    table: ProjectTableSettings;
    kanban?: ProjectKanbanSettings;
    timeline?: ProjectTimelineSettings;
    overviewView?: ProjectOverviewMode;
  };
}

export interface SavedViewStateRecovery {
  /** Exact data.json value captured once before the settings/state split. */
  preSplitData?: unknown;
  /** Invalid nested values omitted from the active runtime representation. */
  malformedViews?: {
    listViewStates?: Record<string, unknown>;
    sectionCollapse?: unknown;
    projectTable?: unknown;
    projectTableColumns?: unknown[];
    projectKanban?: unknown;
    projectTimeline?: unknown;
    projectOverviewView?: unknown;
  };
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
  sortBy: {
    field: 'date' | 'priority' | 'title' | 'tag' | 'status' | 'tracked';
    dir: 'asc' | 'desc';
  };
  filters: PropertyFilter[];
  // The single "Show" status filter. undefined, or all 4 groups present, means
  // "no filtering" (show all groups). A real subset (1-3 groups) restricts
  // tasks to those status groups.
  statusGroups?: TaskStatusType[];
}
