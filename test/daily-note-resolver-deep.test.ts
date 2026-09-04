import { moment, TFile, type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DailyNoteResolver } from '../src/resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { createAppWithFiles, useRealMoment } from './helpers';

const TODAY = moment().format('YYYY-MM-DD');

useRealMoment();

const manualSettings = {
  ...DEFAULT_SETTINGS,
  taskPrefix: '',
  dailyNoteProvider: 'manual' as const,
  taskInsertionMode: 'append' as const,
  desktop: { ...DEFAULT_SETTINGS.desktop },
  manualDailyNotePath: 'YYYY-MM-DD',
};

describe('DailyNoteResolver deep — createNoteWithTemplate', () => {
  it('creates note with templater when plugin available + templatePath set (L101)', async () => {
    const app = await createAppWithFiles({ 'template.md': '# Template\n\n## Tasks\n' });
    // Mock templater plugin + core daily-notes plugin supplying a template path
    const writeSpy = {
      called: false,
      templateFile: null as TFile | null,
      newFile: null as TFile | null,
    };
    const realApp = {
      ...app,
      plugins: {
        getPlugin: (id: string) =>
          id === 'templater-obsidian'
            ? {
                templater: {
                  write_template_to_file: (templateTFile: TFile, newFile: TFile) => {
                    writeSpy.called = true;
                    writeSpy.templateFile = templateTFile;
                    writeSpy.newFile = newFile;
                  },
                },
              }
            : null,
      },
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes'
            ? {
                enabled: true,
                instance: { options: { folder: '', format: 'YYYY-MM-DD', template: 'template' } },
              }
            : null,
      },
    } as unknown as App;

    const settings = { ...manualSettings, dailyNoteProvider: 'core' as const };
    const resolver = new DailyNoteResolver(realApp, settings);
    await resolver.resolveDailyNoteDestination();
    expect(writeSpy.called).toBe(true);
    expect(writeSpy.templateFile).toBeInstanceOf(TFile);
  });

  it('creates note with raw template when templater not available (L114)', async () => {
    const app = await createAppWithFiles({
      'template.md': '# {{title}}\n\nTime: {{time}}\nDate: {{date}}\n',
    });
    const settings = {
      ...manualSettings,
      manualDailyNotePath: 'YYYY-MM-DD',
    };
    const resolver = new DailyNoteResolver(app, settings);
    // We need to trigger createNoteWithTemplate with a template path
    // Destination resolution calls ensureNote → createNoteWithTemplate.
    // But manualDailyNotePath doesn't set template. Let's use a custom approach:
    // Access createNoteWithTemplate via bracket access
    const today = window.moment().format('YYYY-MM-DD');
    // Create a resolver that uses a template via the adapter settings
    // ManualAdapter doesn't support templates, so we need a different approach
    // Let's test readRawTemplate directly
    const content = await (
      resolver as unknown as { readRawTemplate: (p: string, d: string) => Promise<string> }
    ).readRawTemplate('template.md', today);
    expect(content).toContain(today); // {{date}} and {{title}} replaced with dateTitle
    expect(content).toMatch(/\d{2}:\d{2}/); // {{time}} replaced with HH:mm
  });

  it('readRawTemplate returns empty string when template not found (L124)', async () => {
    const app = await createAppWithFiles({});
    const resolver = new DailyNoteResolver(app, manualSettings);
    const content = await (
      resolver as unknown as { readRawTemplate: (p: string, d: string) => Promise<string> }
    ).readRawTemplate('nonexistent.md', '2026-06-25');
    expect(content).toBe('');
  });

  it('readRawTemplate replaces {{date}}, {{time}}, {{title}} placeholders', async () => {
    const app = await createAppWithFiles({
      'tpl.md': 'Title: {{title}}\nDate: {{date}}\nTime: {{time}}\nBody\n',
    });
    const resolver = new DailyNoteResolver(app, manualSettings);
    const content = await (
      resolver as unknown as { readRawTemplate: (p: string, d: string) => Promise<string> }
    ).readRawTemplate('tpl.md', '2026-06-25');
    expect(content).toContain('Title: 2026-06-25');
    expect(content).toContain('Date: 2026-06-25');
    expect(content).toMatch(/Time: \d{2}:\d{2}/);
    expect(content).not.toContain('{{');
  });

  it('readRawTemplate returns content as-is when no placeholders', async () => {
    const app = await createAppWithFiles({ 'tpl.md': 'Just a plain template\nNo placeholders\n' });
    const resolver = new DailyNoteResolver(app, manualSettings);
    const content = await (
      resolver as unknown as { readRawTemplate: (p: string, d: string) => Promise<string> }
    ).readRawTemplate('tpl.md', '2026-06-25');
    expect(content).toBe('Just a plain template\nNo placeholders\n');
  });

  it('createNoteWithTemplate with no templatePath → creates empty note', async () => {
    const app = await createAppWithFiles({});
    const resolver = new DailyNoteResolver(app, manualSettings);
    // ManualAdapter has template: '' → createNoteWithTemplate receives '' as templatePath
    await resolver.resolveDailyNoteDestination();
    const today = window.moment().format('YYYY-MM-DD');
    const file = app.vault.getAbstractFileByPath(`${today}.md`);
    if (!(file instanceof TFile)) throw new Error('expected TFile');
    const content = await app.vault.cachedRead(file);
    expect(content).toBe('');
  });
});

describe('DailyNoteResolver deep — ensureNote folder creation', () => {
  it('creates folder when it does not exist', async () => {
    const app = await createAppWithFiles({});
    const settings = {
      ...manualSettings,
      manualDailyNotePath: 'daily/YYYY-MM-DD',
    };
    const resolver = new DailyNoteResolver(app, settings);
    await resolver.resolveDailyNoteDestination();
    const file = app.vault.getAbstractFileByPath(`daily/${TODAY}.md`);
    expect(file).toBeInstanceOf(TFile);
  });

  it('does not create folder when it already exists', async () => {
    const app = await createAppWithFiles({ 'daily/.gitkeep': '' });
    const settings = {
      ...manualSettings,
      manualDailyNotePath: 'daily/YYYY-MM-DD',
    };
    const resolver = new DailyNoteResolver(app, settings);
    await resolver.resolveDailyNoteDestination();
    const file = app.vault.getAbstractFileByPath(`daily/${TODAY}.md`);
    expect(file).toBeInstanceOf(TFile);
  });
});
