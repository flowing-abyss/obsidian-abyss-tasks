export const DEFAULT_TIMELINE_IDENTITY_WIDTH = 240;
export const TIMELINE_IDENTITY_WIDTH_MIN = 160;
export const TIMELINE_IDENTITY_WIDTH_MAX = 360;
export const TIMELINE_PREFERENCE_VERSION = 1;

export type TimelineScope = 'portfolio' | 'tasks' | 'workNotes';
export type PortfolioTimelineScale = 'week' | 'month' | 'quarter' | 'year';
export type TaskTimelineScale = 'day' | 'week' | 'month';
export type WorkNoteTimelineScale = 'day' | 'week' | 'month' | 'quarter' | 'year';
interface TimelineScaleByScope {
  readonly portfolio: PortfolioTimelineScale;
  readonly tasks: TaskTimelineScale;
  readonly workNotes: WorkNoteTimelineScale;
}
export type TimelineScale<S extends TimelineScope> = TimelineScaleByScope[S];

export interface TimelineViewPreference<S extends TimelineScope> {
  readonly version: 1;
  readonly scale: TimelineScale<S>;
  readonly identityWidth: number;
}

const SCALES = {
  portfolio: ['week', 'month', 'quarter', 'year'],
  tasks: ['day', 'week', 'month'],
  workNotes: ['day', 'week', 'month', 'quarter', 'year'],
} as const satisfies Readonly<Record<TimelineScope, readonly string[]>>;

const DEFAULT_SCALES = {
  portfolio: 'quarter',
  tasks: 'week',
  workNotes: 'month',
} as const satisfies { readonly [S in TimelineScope]: TimelineScale<S> };

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function clampTimelineIdentityWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMELINE_IDENTITY_WIDTH;
  }
  return Math.max(TIMELINE_IDENTITY_WIDTH_MIN, Math.min(TIMELINE_IDENTITY_WIDTH_MAX, value));
}

export function isTimelineScale<S extends TimelineScope>(
  scope: S,
  value: unknown,
): value is TimelineScale<S> {
  return typeof value === 'string' && (SCALES[scope] as readonly string[]).includes(value);
}

export function defaultTimelineScale<S extends TimelineScope>(scope: S): TimelineScale<S> {
  return DEFAULT_SCALES[scope];
}

export function reconcileTimelinePreference<S extends TimelineScope>(
  scope: S,
  value: unknown,
): TimelineViewPreference<S> {
  const candidate = record(value);
  const scale = candidate?.['scale'];
  return {
    version: TIMELINE_PREFERENCE_VERSION,
    scale: isTimelineScale(scope, scale) ? scale : defaultTimelineScale(scope),
    identityWidth: clampTimelineIdentityWidth(candidate?.['identityWidth']),
  };
}
