import { type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { CoreDailyNotesAdapter } from '../src/resolvers/adapters/CoreDailyNotesAdapter';
import { JournalAdapter } from '../src/resolvers/adapters/JournalAdapter';
import { ManualAdapter } from '../src/resolvers/adapters/ManualAdapter';
import { PeriodicNotesAdapter } from '../src/resolvers/adapters/PeriodicNotesAdapter';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function appWith(overrides: Record<string, unknown>): App {
  return overrides as unknown as App;
}

// ── PeriodicNotesAdapter ──────────────────────────────────────────────────────

describe('PeriodicNotesAdapter', () => {
  const adapter = new PeriodicNotesAdapter();

  it('id is "periodic-notes"', () => {
    expect(adapter.id).toBe('periodic-notes');
  });

  it('isAvailable returns true when plugin enabled', () => {
    const app = appWith({
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes' ? { settings: { daily: { enabled: true } } } : null,
      },
    });
    expect(adapter.isAvailable(app)).toBe(true);
  });

  it('isAvailable returns false when plugin missing', () => {
    const app = appWith({ plugins: { getPlugin: () => null } });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('isAvailable returns false when daily disabled', () => {
    const app = appWith({
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes' ? { settings: { daily: { enabled: false } } } : null,
      },
    });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('getSettings reads from plugin settings', () => {
    const app = appWith({
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes'
            ? {
                settings: {
                  daily: {
                    folder: 'notes/daily',
                    format: 'YYYY/MM/DD',
                    template: 'templates/day.md',
                    enabled: true,
                  },
                },
              }
            : null,
      },
    });
    expect(adapter.getSettings(app, DEFAULT_SETTINGS)).toEqual({
      folder: 'notes/daily',
      format: 'YYYY/MM/DD',
      template: 'templates/day.md',
    });
  });

  it('getSettings falls back to defaults when plugin values missing', () => {
    const app = appWith({
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes' ? { settings: { daily: { enabled: true } } } : null,
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    expect(result.format).toBe('YYYY-MM-DD');
    expect(result.folder).toBe('periodic/daily');
    expect(result.template).toBe('');
  });
});

// ── CoreDailyNotesAdapter ─────────────────────────────────────────────────────

describe('CoreDailyNotesAdapter', () => {
  const adapter = new CoreDailyNotesAdapter();

  it('id is "core"', () => {
    expect(adapter.id).toBe('core');
  });

  it('isAvailable returns true when core plugin enabled', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { enabled: true, instance: { options: {} } } : null,
      },
    });
    expect(adapter.isAvailable(app)).toBe(true);
  });

  it('isAvailable returns false when disabled', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { enabled: false, instance: { options: {} } } : null,
      },
    });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('isAvailable returns false when plugin not found', () => {
    const app = appWith({ internalPlugins: { getPluginById: () => null } });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('getSettings reads from core plugin options', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes'
            ? {
                enabled: true,
                instance: {
                  options: { folder: 'journal', format: 'DD-MM-YYYY', template: 'tpl/day.md' },
                },
              }
            : null,
      },
    });
    expect(adapter.getSettings(app, DEFAULT_SETTINGS)).toEqual({
      folder: 'journal',
      format: 'DD-MM-YYYY',
      template: 'tpl/day.md',
    });
  });
});

// ── JournalAdapter ────────────────────────────────────────────────────────────

describe('JournalAdapter', () => {
  const adapter = new JournalAdapter();

  it('id is "obsidian-journal"', () => {
    expect(adapter.id).toBe('obsidian-journal');
  });

  it('isAvailable returns true when plugin present', () => {
    const app = appWith({
      plugins: { getPlugin: (id: string) => (id === 'obsidian-journal' ? {} : null) },
    });
    expect(adapter.isAvailable(app)).toBe(true);
  });

  it('isAvailable returns false when plugin absent', () => {
    const app = appWith({ plugins: { getPlugin: () => null } });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('getSettings returns stub settings', () => {
    const result = adapter.getSettings({} as App, DEFAULT_SETTINGS);
    expect(result.format).toBe('YYYY-MM-DD');
    expect(typeof result.folder).toBe('string');
    expect(typeof result.template).toBe('string');
  });
});

// ── ManualAdapter ─────────────────────────────────────────────────────────────

describe('ManualAdapter', () => {
  const adapter = new ManualAdapter();

  it('id is "manual"', () => {
    expect(adapter.id).toBe('manual');
  });

  it('isAvailable always returns true', () => {
    expect(adapter.isAvailable({} as App)).toBe(true);
  });

  it('getSettings parses manualDailyNotePath into folder + format', () => {
    const settings = { ...DEFAULT_SETTINGS, manualDailyNotePath: 'my/notes/YYYY-MM-DD' };
    expect(adapter.getSettings({} as App, settings)).toEqual({
      folder: 'my/notes',
      format: 'YYYY-MM-DD',
      template: '',
    });
  });

  it('getSettings handles path with no folder prefix', () => {
    const settings = { ...DEFAULT_SETTINGS, manualDailyNotePath: 'YYYY-MM-DD' };
    expect(adapter.getSettings({} as App, settings)).toEqual({
      folder: '',
      format: 'YYYY-MM-DD',
      template: '',
    });
  });
});
