import { type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { CoreDailyNotesAdapter } from '../src/resolvers/adapters/CoreDailyNotesAdapter';
import { ManualAdapter } from '../src/resolvers/adapters/ManualAdapter';
import { PeriodicNotesAdapter } from '../src/resolvers/adapters/PeriodicNotesAdapter';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function appWith(overrides: Record<string, unknown>): App {
  return overrides as unknown as App;
}

describe('CoreDailyNotesAdapter deep', () => {
  const adapter = new CoreDailyNotesAdapter();

  it('isAvailable returns false when plugin not installed (L24)', () => {
    const app = appWith({
      internalPlugins: { getPluginById: () => null },
    });
    expect(adapter.isAvailable(app)).toBe(false);
  });

  it('getSettings with no options → defaults (L26, L27, L28)', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: () => ({ enabled: true, instance: {} }),
      },
    });
    // instance.options is undefined → opts = {}
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    expect(result.folder).toBe('');
    expect(result.format).toBe('YYYY-MM-DD');
    expect(result.template).toBe('');
  });

  it('getSettings with empty string options → trimmed to empty (L26)', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: () => ({
          enabled: true,
          instance: { options: { folder: '  ', format: '', template: '  ' } },
        }),
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    expect(result.folder).toBe('');
    expect(result.format).toBe('YYYY-MM-DD');
    expect(result.template).toBe('');
  });

  it('getSettings with non-string folder → throws (L26 typeof check)', () => {
    // CURRENT BEHAVIOR (follow-up: FU-34): opts.folder?.trim() does not guard
    // against non-string values; a number has no trim() method and throws
    // TypeError. The adapter should either coerce or reject non-strings.
    const app = appWith({
      internalPlugins: {
        getPluginById: () => ({
          enabled: true,
          instance: { options: { folder: 123 } },
        }),
      },
    });
    expect(() => adapter.getSettings(app, DEFAULT_SETTINGS)).toThrow();
  });

  it('getSettings with undefined folder → empty string', () => {
    const app = appWith({
      internalPlugins: {
        getPluginById: () => ({
          enabled: true,
          instance: { options: { folder: undefined, format: undefined, template: undefined } },
        }),
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    expect(result.folder).toBe('');
    expect(result.format).toBe('YYYY-MM-DD');
    expect(result.template).toBe('');
  });
});

describe('ManualAdapter deep', () => {
  const adapter = new ManualAdapter();

  it.each([
    ['just-a-name', '', 'just-a-name'],
    ['YYYY-MM-DD', '', 'YYYY-MM-DD'],
    ['notes/daily/YYYY-MM-DD', 'notes/daily', 'YYYY-MM-DD'],
  ] as const)(
    'parses manual path %s into folder %s and format %s',
    (manualDailyNotePath, expectedFolder, expectedFormat) => {
      const settings = { ...DEFAULT_SETTINGS, manualDailyNotePath };
      const result = adapter.getSettings({} as App, settings);
      expect(result.folder).toBe(expectedFolder);
      expect(result.format).toBe(expectedFormat);
    },
  );

  it('getSettings with null manualDailyNotePath → defaults (L22)', () => {
    const settings = { ...DEFAULT_SETTINGS, manualDailyNotePath: null as unknown as string };
    // parseManualPath(null ?? 'YYYY-MM-DD') → parseManualPath('YYYY-MM-DD')
    const result = adapter.getSettings({} as App, settings);
    expect(result.folder).toBe('');
    expect(result.format).toBe('YYYY-MM-DD');
  });
});

describe('PeriodicNotesAdapter deep', () => {
  const adapter = new PeriodicNotesAdapter();

  it('getSettings with daily undefined → fallback to calSettings (L23)', () => {
    const app = appWith({
      plugins: {
        getPlugin: () => ({ settings: {} }), // no daily key
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    // daily = {} → folder: undefined?.trim() || calSettings.desktop.dailyNoteFolder
    expect(result.folder).toBe(DEFAULT_SETTINGS.desktop.dailyNoteFolder);
    expect(result.format).toBe('YYYY-MM-DD');
    expect(result.template).toBe('');
  });

  it('getSettings with empty string daily.folder → fallback (L23 falsy)', () => {
    const app = appWith({
      plugins: {
        getPlugin: () => ({ settings: { daily: { folder: '', enabled: true } } }),
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    // folder: ''.trim() || calSettings.desktop.dailyNoteFolder → falsy → fallback
    expect(result.folder).toBe(DEFAULT_SETTINGS.desktop.dailyNoteFolder);
  });

  it('getSettings with daily.folder = null → fallback', () => {
    const app = appWith({
      plugins: {
        getPlugin: () => ({ settings: { daily: { folder: null, enabled: true } } }),
      },
    });
    const result = adapter.getSettings(app, DEFAULT_SETTINGS);
    // null?.trim() → undefined → undefined || fallback
    expect(result.folder).toBe(DEFAULT_SETTINGS.desktop.dailyNoteFolder);
  });
});
