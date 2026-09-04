import type { App } from 'obsidian';
import type { CalendarSettings } from '../../settings/types';
import type { DailyNoteAdapter, DailyNoteProviderSettings, ProviderId } from '../types';

type PeriodicPlugin = {
  settings?: { daily?: { folder?: string; format?: string; template?: string; enabled?: boolean } };
};

function getPlugin(app: App): PeriodicPlugin | null {
  return (
    app as unknown as { plugins: { getPlugin(id: string): PeriodicPlugin | null } }
  ).plugins.getPlugin('periodic-notes');
}

export class PeriodicNotesAdapter implements DailyNoteAdapter {
  readonly id: ProviderId = 'periodic-notes';

  isAvailable(app: App): boolean {
    return getPlugin(app)?.settings?.daily?.enabled === true;
  }

  getSettings(app: App, calSettings: CalendarSettings): DailyNoteProviderSettings {
    const daily = getPlugin(app)?.settings?.daily ?? {};
    return {
      folder:
        typeof daily.folder === 'string' && daily.folder.trim().length > 0
          ? daily.folder.trim()
          : calSettings.desktop.dailyNoteFolder,
      format:
        typeof daily.format === 'string' && daily.format.length > 0 ? daily.format : 'YYYY-MM-DD',
      template: daily.template?.trim() ?? '',
    };
  }
}
