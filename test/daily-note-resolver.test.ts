import { type App, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DailyNoteResolver } from '../src/resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { createAppWithFiles, useRealMoment } from './helpers';

useRealMoment();

function appWithPlugins(
  communityPlugins: Record<string, unknown> = {},
  internalPlugins: Record<string, unknown> = {},
): App {
  return {
    plugins: { getPlugin: (id: string) => communityPlugins[id] ?? null },
    internalPlugins: { getPluginById: (id: string) => internalPlugins[id] ?? null },
  } as unknown as App;
}

// ── getActiveAdapter ──────────────────────────────────────────────────────────

describe('DailyNoteResolver.getActiveAdapter', () => {
  it('auto selects periodic-notes when available', () => {
    const app = appWithPlugins({
      'periodic-notes': { settings: { daily: { enabled: true } } },
    });
    const resolver = new DailyNoteResolver(app, { ...DEFAULT_SETTINGS, dailyNoteProvider: 'auto' });
    expect(resolver.getActiveAdapter().id).toBe('periodic-notes');
  });

  it('auto falls back to core when periodic-notes not available', () => {
    const app = appWithPlugins({}, { 'daily-notes': { enabled: true, instance: { options: {} } } });
    const resolver = new DailyNoteResolver(app, { ...DEFAULT_SETTINGS, dailyNoteProvider: 'auto' });
    expect(resolver.getActiveAdapter().id).toBe('core');
  });

  it('auto falls back to ManualAdapter when no plugin available', () => {
    const app = appWithPlugins({}, {});
    const resolver = new DailyNoteResolver(app, { ...DEFAULT_SETTINGS, dailyNoteProvider: 'auto' });
    expect(resolver.getActiveAdapter().id).toBe('manual');
  });

  it('explicit provider selects that adapter', () => {
    const app = appWithPlugins(
      {
        'periodic-notes': { settings: { daily: { enabled: true } } },
      },
      {
        'daily-notes': { enabled: true, instance: { options: {} } },
      },
    );
    const resolver = new DailyNoteResolver(app, { ...DEFAULT_SETTINGS, dailyNoteProvider: 'core' });
    expect(resolver.getActiveAdapter().id).toBe('core');
  });

  it('explicit provider falls back to manual when that plugin not available', () => {
    const app = appWithPlugins({}, {});
    const resolver = new DailyNoteResolver(app, {
      ...DEFAULT_SETTINGS,
      dailyNoteProvider: 'periodic-notes',
    });
    expect(resolver.getActiveAdapter().id).toBe('manual');
  });
});

// ── getAvailableProviders ─────────────────────────────────────────────────────

describe('DailyNoteResolver.getAvailableProviders', () => {
  it('always includes auto and manual', () => {
    const app = appWithPlugins({}, {});
    const resolver = new DailyNoteResolver(app, DEFAULT_SETTINGS);
    const ids = resolver.getAvailableProviders().map((p) => p.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('manual');
  });

  it('includes periodic-notes when available', () => {
    const app = appWithPlugins({
      'periodic-notes': { settings: { daily: { enabled: true } } },
    });
    const resolver = new DailyNoteResolver(app, DEFAULT_SETTINGS);
    const ids = resolver.getAvailableProviders().map((p) => p.id);
    expect(ids).toContain('periodic-notes');
  });

  it('auto label shows detected plugin name', () => {
    const app = appWithPlugins({
      'periodic-notes': { settings: { daily: { enabled: true } } },
    });
    const resolver = new DailyNoteResolver(app, DEFAULT_SETTINGS);
    const autoEntry = resolver.getAvailableProviders().find((p) => p.id === 'auto');
    expect(autoEntry?.label).toContain('Periodic Notes');
  });
});

describe('DailyNoteResolver destination planning', () => {
  it('plans without writes and prepares from frozen provider and insertion settings', async () => {
    const app = await createAppWithFiles({
      'templates/first.md': '# {{title}}\n\n## Captured\n',
      'templates/second.md': '# changed\n',
    });
    (app as unknown as { plugins: unknown }).plugins = { getPlugin: () => null };
    const options = {
      folder: 'daily/original',
      format: 'YYYY-MM-DD',
      template: 'templates/first',
    };
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      getPluginById: (id: string) =>
        id === 'daily-notes' ? { enabled: true, instance: { options } } : null,
    };
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      dailyNoteProvider: 'core' as const,
      taskInsertionMode: 'section' as const,
      taskInsertionSection: '## Captured',
    };
    const create = vi.spyOn(app.vault, 'create');
    const createFolder = vi.spyOn(app.vault, 'createFolder');
    const resolver = new DailyNoteResolver(app, settings);

    const plan = resolver.planDailyNoteDestination();
    const today = window.moment().format('YYYY-MM-DD');

    expect(plan.destination).toEqual({
      filePath: `daily/original/${today}.md`,
      insertion: { type: 'section', heading: '## Captured' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();

    options.folder = 'daily/changed';
    options.template = 'templates/second';
    settings.taskInsertionMode = 'append';
    settings.taskInsertionSection = '## Changed';

    await expect(plan.prepare()).resolves.toEqual({
      type: 'resolved',
      destination: {
        filePath: `daily/original/${today}.md`,
        insertion: { type: 'section', heading: '## Captured' },
      },
    });
    expect(createFolder).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    const file = app.vault.getAbstractFileByPath(`daily/original/${today}.md`);
    if (!(file instanceof TFile)) throw new Error('Expected a daily note file');
    expect(await app.vault.cachedRead(file)).toContain(`# ${today}`);
  });

  it('keeps the legacy resolver adapter returning a TaskDestination', async () => {
    const app = await createAppWithFiles({});
    (app as unknown as { plugins: unknown }).plugins = { getPlugin: () => null };
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      getPluginById: () => null,
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      dailyNoteProvider: 'manual' as const,
      manualDailyNotePath: 'legacy/YYYY-MM-DD',
    };

    const destination = await new DailyNoteResolver(app, settings).resolveDailyNoteDestination();

    expect(destination).toEqual({
      filePath: `legacy/${window.moment().format('YYYY-MM-DD')}.md`,
      insertion: { type: 'append' },
    });
  });
});
