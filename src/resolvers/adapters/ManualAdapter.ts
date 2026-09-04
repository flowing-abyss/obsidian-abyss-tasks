import type { App } from 'obsidian';
import type { CalendarSettings } from '../../settings/types';
import type { DailyNoteAdapter, DailyNoteProviderSettings, ProviderId } from '../types';

function parseManualPath(pattern: string): { folder: string; format: string } {
  // Find where the date format starts (first date token: YYYY, YY, MMMM, MMM, MM, M, DDDD, DDD, DD, D, ddd, ww)
  const match = /Y{2,4}|M{1,4}|D{1,4}|ddd|ww/.exec(pattern);
  if (match == null || match.index === 0) return { folder: '', format: pattern };
  const slashBefore = pattern.lastIndexOf('/', match.index - 1);
  if (slashBefore === -1) return { folder: '', format: pattern };
  return { folder: pattern.slice(0, slashBefore), format: pattern.slice(slashBefore + 1) };
}

export class ManualAdapter implements DailyNoteAdapter {
  readonly id: ProviderId = 'manual';

  isAvailable(_app: App): boolean {
    return true;
  }

  getSettings(_app: App, calSettings: CalendarSettings): DailyNoteProviderSettings {
    const configuredPath: unknown = calSettings.manualDailyNotePath;
    const pattern = typeof configuredPath === 'string' ? configuredPath : 'YYYY-MM-DD';
    const { folder, format } = parseManualPath(pattern);
    return { folder, format, template: '' };
  }
}
