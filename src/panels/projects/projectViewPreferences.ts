export const PROJECT_IDENTITY_WIDTH_MIN = 160;
export const PROJECT_IDENTITY_WIDTH_MAX = 360;
export const DEFAULT_PROJECT_IDENTITY_WIDTH = 240;

export type PortfolioTimelineScale = 'week' | 'month' | 'quarter' | 'year';
export type TaskTimelineScale = 'day' | 'week' | 'month';
export type WorkNotesDateRange = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ProjectBoardPreference {
  readonly version: 1;
  readonly statusIds: readonly string[];
  readonly dormantStatusIds: readonly string[];
}

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

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function clampProjectIdentityWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PROJECT_IDENTITY_WIDTH;
  return Math.max(PROJECT_IDENTITY_WIDTH_MIN, Math.min(PROJECT_IDENTITY_WIDTH_MAX, value));
}

export function buildProjectBoardPreference(statusIds: readonly string[]): ProjectBoardPreference {
  return { version: 1, statusIds: unique(statusIds), dormantStatusIds: [] };
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
  preference: ProjectBoardPreference,
  configuredStatusIds: readonly string[],
): ProjectBoardPreference {
  const configured = unique(configuredStatusIds);
  const configuredSet = new Set(configured);
  const stored = unique([...preference.statusIds, ...preference.dormantStatusIds]);
  const active = stored.filter((id) => configuredSet.has(id));
  const activeSet = new Set(active);
  active.push(...configured.filter((id) => !activeSet.has(id)));
  return {
    version: 1,
    statusIds: active,
    dormantStatusIds: stored.filter((id) => !configuredSet.has(id)),
  };
}

/** Resets only the active columns; dormant IDs remain available for future restoration. */
export function resetProjectBoardStatusOrder(
  preference: ProjectBoardPreference,
  configuredStatusIds: readonly string[],
): ProjectBoardPreference {
  const reconciled = reconcileProjectBoardPreference(preference, configuredStatusIds);
  return {
    version: 1,
    statusIds: unique(configuredStatusIds),
    dormantStatusIds: reconciled.dormantStatusIds,
  };
}

export function migrateProjectBoardPreference(
  value: unknown,
  configuredStatusIds: readonly string[],
): ProjectBoardPreference {
  const candidate = record(value);
  if (!candidate) return buildProjectBoardPreference(configuredStatusIds);
  return reconcileProjectBoardPreference(
    {
      version: 1,
      statusIds: stringArray(candidate['statusIds']),
      dormantStatusIds: stringArray(candidate['dormantStatusIds']),
    },
    configuredStatusIds,
  );
}

function isPortfolioTimelineScale(value: unknown): value is PortfolioTimelineScale {
  return value === 'week' || value === 'month' || value === 'quarter' || value === 'year';
}

function isTaskTimelineScale(value: unknown): value is TaskTimelineScale {
  return value === 'day' || value === 'week' || value === 'month';
}

function isWorkNotesDateRange(value: unknown): value is WorkNotesDateRange {
  return (
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'quarter' ||
    value === 'year'
  );
}

/** Migrates independently-scoped timeline preferences without accepting another scope's scale. */
export function migrateProjectTimelinePreferences(value: unknown): ProjectTimelinePreferences {
  const defaults = buildProjectTimelinePreferences();
  const candidate = record(value);
  const portfolio = record(candidate?.['portfolio']);
  const tasks = record(candidate?.['tasks']);
  const workNotes = record(candidate?.['workNotes']);
  return {
    version: 1,
    portfolio: {
      scale: isPortfolioTimelineScale(portfolio?.['scale'])
        ? portfolio['scale']
        : defaults.portfolio.scale,
      identityWidth: clampProjectIdentityWidth(portfolio?.['identityWidth']),
    },
    tasks: {
      scale: isTaskTimelineScale(tasks?.['scale']) ? tasks['scale'] : defaults.tasks.scale,
      identityWidth: clampProjectIdentityWidth(tasks?.['identityWidth']),
    },
    workNotes: {
      dateRange: isWorkNotesDateRange(workNotes?.['dateRange'])
        ? workNotes['dateRange']
        : defaults.workNotes.dateRange,
      identityWidth: clampProjectIdentityWidth(workNotes?.['identityWidth']),
    },
  };
}
