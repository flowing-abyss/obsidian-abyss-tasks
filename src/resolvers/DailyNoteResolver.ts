import { TFile, normalizePath, type App } from 'obsidian';
import type { CalendarSettings } from '../settings/types';
import type { TaskDestinationPlan } from '../tasks/application/TaskDestinationProvider';
import type { TaskDestination } from '../tasks/domain/types';
import { CoreDailyNotesAdapter } from './adapters/CoreDailyNotesAdapter';
import { JournalAdapter } from './adapters/JournalAdapter';
import { ManualAdapter } from './adapters/ManualAdapter';
import { PeriodicNotesAdapter } from './adapters/PeriodicNotesAdapter';
import type { DailyNoteAdapter, DailyNoteProviderSettings, ProviderId } from './types';

const ADAPTER_CHAIN: DailyNoteAdapter[] = [
  new PeriodicNotesAdapter(),
  new JournalAdapter(),
  new CoreDailyNotesAdapter(),
  new ManualAdapter(),
];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  'periodic-notes': 'Periodic Notes',
  core: 'Core Daily Notes',
  'obsidian-journal': 'Obsidian Journal',
  manual: 'Manual',
};

/** Signals that note creation succeeded but applying its Templater template did not. */
export class CreatedNoteTemplateError extends Error {
  readonly createdPath: string;
  readonly cause: unknown;

  constructor(createdPath: string, cause: unknown) {
    super(`Could not apply the template to ${createdPath}.`);
    this.name = 'CreatedNoteTemplateError';
    this.createdPath = createdPath;
    this.cause = cause;
  }
}

function fallbackAdapter(): DailyNoteAdapter {
  const adapter = ADAPTER_CHAIN[ADAPTER_CHAIN.length - 1];
  if (adapter === undefined) throw new Error('Daily note adapter chain is empty');
  return adapter;
}

export class DailyNoteResolver {
  constructor(
    private readonly app: App,
    private readonly settings: CalendarSettings,
  ) {}

  getActiveAdapter(): DailyNoteAdapter {
    const { dailyNoteProvider } = this.settings;
    if (dailyNoteProvider === 'auto') {
      return ADAPTER_CHAIN.find((adapter) => adapter.isAvailable(this.app)) ?? fallbackAdapter();
    }
    const match = ADAPTER_CHAIN.find((adapter) => adapter.id === dailyNoteProvider);
    return match?.isAvailable(this.app) === true ? match : fallbackAdapter();
  }

  getAvailableProviders(): Array<{ id: ProviderId | 'auto'; label: string }> {
    const result: Array<{ id: ProviderId | 'auto'; label: string }> = [
      { id: 'auto', label: this.autoLabel() },
    ];
    for (const a of ADAPTER_CHAIN) {
      if (a.isAvailable(this.app)) {
        result.push({ id: a.id, label: PROVIDER_LABELS[a.id] });
      }
    }
    return result;
  }

  async resolveDailyNoteDestination(): Promise<TaskDestination> {
    const resolution = await this.planDailyNoteDestination().prepare();
    if (resolution.type === 'unavailable') throw new Error('daily-note-unavailable');
    return resolution.destination;
  }

  planDailyNoteDestination(): TaskDestinationPlan {
    const providerSettings = { ...this.getActiveAdapter().getSettings(this.app, this.settings) };
    const destination = this.destinationFor(providerSettings);
    return {
      destination,
      prepare: async () => ({
        type: 'resolved',
        destination: await this.ensurePlannedDestination(providerSettings, destination),
      }),
    };
  }

  private destinationFor(ps: DailyNoteProviderSettings): TaskDestination {
    const fileName = window.moment().format(ps.format);
    const filePath = normalizePath(
      ps.folder.length > 0 ? `${ps.folder}/${fileName}.md` : `${fileName}.md`,
    );
    return {
      filePath,
      insertion:
        this.settings.taskInsertionMode === 'section' &&
        this.settings.taskInsertionSection.trim().length > 0
          ? { type: 'section', heading: this.settings.taskInsertionSection }
          : { type: 'append' },
    };
  }

  private async ensurePlannedDestination(
    ps: DailyNoteProviderSettings,
    destination: TaskDestination,
  ): Promise<TaskDestination> {
    const existing = this.app.vault.getAbstractFileByPath(destination.filePath);
    if (existing instanceof TFile) {
      return { filePath: existing.path, insertion: destination.insertion };
    }

    const folderPath = destination.filePath.substring(0, destination.filePath.lastIndexOf('/'));
    if (folderPath.length > 0 && this.app.vault.getAbstractFileByPath(folderPath) == null) {
      await this.app.vault.createFolder(folderPath);
    }

    const fileName = destination.filePath.slice(
      destination.filePath.lastIndexOf('/') + 1,
      -'.md'.length,
    );
    const file = await this.createNoteWithTemplate(destination.filePath, ps.template, fileName);
    return { filePath: file.path, insertion: destination.insertion };
  }

  /**
   * Public wrapper so other subsystems (e.g. Projects) can create a note from
   * a template using the same Templater-aware path as daily notes.
   */
  async createNoteFromTemplate(
    filePath: string,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    return this.createNoteWithTemplate(filePath, templatePath, title);
  }

  private async createNoteWithTemplate(
    filePath: string,
    templatePath: string,
    dateTitle: string,
  ): Promise<TFile> {
    const templater = this.getTemplaterPlugin();
    if (templater != null && templatePath.length > 0) {
      const newFile = await this.app.vault.create(filePath, '');
      const templateTFile = this.app.metadataCache.getFirstLinkpathDest(templatePath, '');
      if (templateTFile instanceof TFile) {
        try {
          await (
            templater as {
              templater: { write_template_to_file(t: TFile, f: TFile): Promise<void> };
            }
          ).templater.write_template_to_file(templateTFile, newFile);
        } catch (cause) {
          throw new CreatedNoteTemplateError(newFile.path, cause);
        }
      }
      return newFile;
    }

    if (templatePath.length > 0) {
      const content = await this.readRawTemplate(templatePath, dateTitle);
      return this.app.vault.create(filePath, content);
    }

    return this.app.vault.create(filePath, '');
  }

  private async readRawTemplate(templatePath: string, dateTitle: string): Promise<string> {
    const tfile = this.app.metadataCache.getFirstLinkpathDest(templatePath, '');
    if (!(tfile instanceof TFile)) return '';
    const raw = await this.app.vault.cachedRead(tfile);
    const now = window.moment();
    return raw
      .replace(/\{\{\s*date\s*\}\}/gi, dateTitle)
      .replace(/\{\{\s*time\s*\}\}/gi, now.format('HH:mm'))
      .replace(/\{\{\s*title\s*\}\}/gi, dateTitle);
  }

  private getTemplaterPlugin(): unknown {
    try {
      return (
        this.app as unknown as { plugins: { getPlugin(id: string): unknown } }
      ).plugins.getPlugin('templater-obsidian');
    } catch {
      return null;
    }
  }

  private autoLabel(): string {
    const detected = ADAPTER_CHAIN.find((a) => a.isAvailable(this.app));
    if (detected == null || detected.id === 'manual') return 'Auto-detect';
    return `Auto-detect (${PROVIDER_LABELS[detected.id]} detected)`;
  }
}
