import type { CalendarSettings, ProjectsSettings } from '../../src/settings/types';

type SettingsOwner = 'static' | 'view' | 'partitioned';

// Test-side obligations for known keys only: unknown persisted extensions remain
// the serializer's compatibility responsibility, never a runtime whitelist.
export const CALENDAR_SETTINGS_OWNERS = {
  firstDayOfWeek: 'static',
  taskPrefix: 'static',
  taskFilePath: 'static',
  taskArchivePath: 'static',
  taskIgnoreQuery: 'static',
  taskTemplatePath: 'static',
  inbox: 'static',
  pinnedTags: 'static',
  archivedTags: 'static',
  archivedTagPrefixes: 'static',
  tagGroups: 'static',
  taskInsertionMode: 'static',
  taskInsertionSection: 'static',
  taskInsertionSectionPosition: 'static',
  sourceNoteDisplay: 'static',
  listViewStates: 'view',
  projects: 'partitioned',
  sectionCollapse: 'view',
  taskStatuses: 'static',
  taskLifecycle: 'static',
  recurrence: 'static',
  shortcuts: 'static',
} satisfies Record<keyof CalendarSettings, SettingsOwner>;

export const PROJECT_SETTINGS_OWNERS = {
  membershipQuery: 'static',
  createFolder: 'static',
  templatePath: 'static',
  statusProperty: 'static',
  startProperty: 'static',
  endProperty: 'static',
  propertyDefinitions: 'static',
  propertyDefinitionsVersion: 'static',
  statuses: 'static',
  statusMigration: 'static',
  defaultStatusId: 'static',
  taskInsertionMode: 'static',
  taskInsertionSection: 'static',
  taskInsertionSectionPosition: 'static',
  table: 'view',
  kanban: 'view',
  timeline: 'view',
  overviewView: 'view',
} satisfies Record<keyof ProjectsSettings, SettingsOwner>;
