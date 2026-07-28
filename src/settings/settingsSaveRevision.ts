import type { CalendarSettings } from './types';

const revisions = new WeakMap<CalendarSettings, number>();

export function beginSettingsSave(settings: CalendarSettings): void {
  revisions.set(settings, (revisions.get(settings) ?? 0) + 1);
}

export function latestSettingsSaveRevision(settings: CalendarSettings): number {
  return revisions.get(settings) ?? 0;
}
