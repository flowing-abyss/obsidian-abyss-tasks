import type { ProjectTimelineScale } from '../projects/projectTimelineSettings';
import type { ListViewState } from '../settings/types';
import { isMalformedTaskKanbanSettings, normalizeTaskKanbanSettings } from './taskKanbanSettings';

export interface TaskTimelineSettings {
  groupBy: ListViewState['groupBy'];
  sortBy: ListViewState['sortBy'];
  hiddenStatuses: string[];
  scale: ProjectTimelineScale;
  descriptionLines: 0 | 1 | 2 | 'full';
  showMetadata: boolean;
  showScheduled: boolean;
  showUnscheduled: boolean;
}
export function defaultTaskTimelineSettings(): TaskTimelineSettings {
  return {
    groupBy: 'none',
    sortBy: { field: 'date', dir: 'asc' },
    hiddenStatuses: [],
    scale: 'month',
    descriptionLines: 1,
    showMetadata: true,
    showScheduled: true,
    showUnscheduled: true,
  };
}
export function normalizeTaskTimelineSettings(value: unknown): TaskTimelineSettings {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const normalized = normalizeTaskKanbanSettings(
    {
      ...raw,
      sortBy: raw['sortBy'] ?? { field: 'date', dir: 'asc' },
    },
    'date',
  );
  const scale = raw['scale'];
  return {
    groupBy: raw['groupBy'] === 'status' ? 'status' : normalized.groupBy,
    sortBy: normalized.sortBy,
    hiddenStatuses: normalized.hiddenStatuses,
    descriptionLines: normalized.descriptionLines,
    showMetadata: normalized.showMetadata,
    scale:
      scale === 'day' || scale === 'week' || scale === 'quarter' || scale === 'year'
        ? scale
        : 'month',
    showScheduled: raw['showScheduled'] !== false,
    showUnscheduled: raw['showUnscheduled'] !== false,
  };
}
export function isMalformedTaskTimelineSettings(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const raw = value as Record<string, unknown>;
  if (isMalformedTaskKanbanSettings({ sortBy: raw['sortBy'] })) return true;
  return Object.entries(normalizeTaskTimelineSettings(raw)).some(
    ([key, expected]) =>
      key !== 'sortBy' &&
      raw[key] !== undefined &&
      JSON.stringify(raw[key]) !== JSON.stringify(expected),
  );
}
export function taskTimelineCustomized(view: ListViewState): boolean {
  return (
    JSON.stringify(normalizeTaskTimelineSettings(view.timeline)) !==
    JSON.stringify(normalizeTaskTimelineSettings(defaultTaskTimelineSettings()))
  );
}
