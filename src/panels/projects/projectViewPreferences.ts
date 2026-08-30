import {
  buildBoardPreference,
  migrateBoardPreference,
  reconcileBoardPreference,
  resetBoardPreference,
  type BoardViewPreference,
} from './boardPreferences';
import {
  DEFAULT_TIMELINE_IDENTITY_WIDTH,
  reconcileTimelinePreference,
  type PortfolioTimelineScale,
  type TaskTimelineScale,
  type WorkNoteTimelineScale,
} from './timelinePreferences';

export type { BoardViewPreference as ProjectBoardPreference } from './boardPreferences';

const DEFAULT_PROJECT_IDENTITY_WIDTH = DEFAULT_TIMELINE_IDENTITY_WIDTH;

type WorkNotesDateRange = WorkNoteTimelineScale;

export interface ProjectTimelinePreferences {
  readonly version: 1;
  readonly portfolio: {
    readonly scale: PortfolioTimelineScale;
    readonly identityWidth: number;
  };
  readonly tasks: {
    readonly scale: TaskTimelineScale;
    readonly identityWidth: number;
  };
  readonly workNotes: {
    readonly dateRange: WorkNotesDateRange;
    readonly identityWidth: number;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildProjectBoardPreference(
  statusIds: readonly string[],
  initiallyCollapsedIds: readonly string[] = [],
): BoardViewPreference {
  return {
    ...buildBoardPreference(statusIds),
    collapsedColumnIds: [...new Set(initiallyCollapsedIds.filter((id) => statusIds.includes(id)))],
  };
}

export function buildProjectTimelinePreferences(): ProjectTimelinePreferences {
  return {
    version: 1,
    portfolio: { scale: 'quarter', identityWidth: DEFAULT_PROJECT_IDENTITY_WIDTH },
    tasks: { scale: 'week', identityWidth: DEFAULT_PROJECT_IDENTITY_WIDTH },
    workNotes: { dateRange: 'month', identityWidth: DEFAULT_PROJECT_IDENTITY_WIDTH },
  };
}

/** Separates temporarily unknown IDs so a later status restoration can recover them. */
export function reconcileProjectBoardPreference(
  preference: BoardViewPreference,
  configuredStatusIds: readonly string[],
): BoardViewPreference {
  return reconcileBoardPreference(preference, configuredStatusIds);
}

/** Resets only the active columns; dormant IDs remain available for future restoration. */
export function resetProjectBoardStatusOrder(
  preference: BoardViewPreference,
  configuredStatusIds: readonly string[],
): BoardViewPreference {
  return resetBoardPreference(preference, configuredStatusIds);
}

export function migrateProjectBoardPreference(
  value: unknown,
  configuredStatusIds: readonly string[],
): BoardViewPreference {
  return migrateBoardPreference(value, configuredStatusIds);
}

/** Migrates independently-scoped timeline preferences without accepting another scope's scale. */
export function migrateProjectTimelinePreferences(value: unknown): ProjectTimelinePreferences {
  const candidate = record(value);
  const portfolio = record(candidate?.['portfolio']);
  const tasks = record(candidate?.['tasks']);
  const workNotes = record(candidate?.['workNotes']);
  const portfolioPreference = reconcileTimelinePreference('portfolio', portfolio);
  const taskPreference = reconcileTimelinePreference('tasks', tasks);
  const workNotePreference = reconcileTimelinePreference('workNotes', {
    scale: workNotes?.['dateRange'],
    identityWidth: workNotes?.['identityWidth'],
  });
  return {
    version: 1,
    portfolio: {
      scale: portfolioPreference.scale,
      identityWidth: portfolioPreference.identityWidth,
    },
    tasks: {
      scale: taskPreference.scale,
      identityWidth: taskPreference.identityWidth,
    },
    workNotes: {
      dateRange: workNotePreference.scale,
      identityWidth: workNotePreference.identityWidth,
    },
  };
}
