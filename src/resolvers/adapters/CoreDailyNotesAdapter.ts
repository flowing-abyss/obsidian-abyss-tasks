import type { App } from 'obsidian';
import type { CalendarSettings } from '../../settings/types';
import type { DailyNoteAdapter, DailyNoteProviderSettings, ProviderId } from '../types';

type CorePlugin = {
  enabled: boolean;
  instance?: {
    options?: {
      folder?: string | null;
      format?: string | null;
      template?: string | null;
    };
  };
};

function getPlugin(app: App): CorePlugin | null {
  return (
    app as unknown as { internalPlugins: { getPluginById(id: string): CorePlugin | null } }
  ).internalPlugins.getPluginById('daily-notes');
}

export class CoreDailyNotesAdapter implements DailyNoteAdapter {
  readonly id: ProviderId = 'core';

  isAvailable(app: App): boolean {
    return getPlugin(app)?.enabled === true;
  }

  getSettings(app: App, _calSettings: CalendarSettings): DailyNoteProviderSettings {
    const opts = getPlugin(app)?.instance?.options ?? {};
    return {
      folder: opts.folder?.trim() ?? '',
      format:
        typeof opts.format === 'string' && opts.format.length > 0 ? opts.format : 'YYYY-MM-DD',
      template: opts.template?.trim() ?? '',
    };
  }
}
