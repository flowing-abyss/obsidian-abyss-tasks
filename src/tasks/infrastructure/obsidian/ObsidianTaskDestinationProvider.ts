import { TFile, normalizePath, type App } from 'obsidian';
import type { DailyNoteResolver } from '../../../resolvers/DailyNoteResolver';
import type { CalendarSettings } from '../../../settings/types';
import type {
  TaskDestinationPlan,
  TaskDestinationProvider,
  TaskDestinationResolution,
} from '../../application/TaskDestinationProvider';
import type { TaskDestination, TaskInsertionPolicy } from '../../domain/types';

function configuredInsertion(settings: CalendarSettings): TaskInsertionPolicy {
  return settings.taskInsertionMode === 'section' && settings.taskInsertionSection.trim().length > 0
    ? { type: 'section', heading: settings.taskInsertionSection }
    : { type: 'append' };
}

export class ObsidianTaskDestinationProvider implements TaskDestinationProvider {
  constructor(
    private readonly app: App,
    private readonly settings: CalendarSettings,
    private readonly dailyNotes: DailyNoteResolver,
  ) {}

  planConfiguredDefault(): Promise<TaskDestinationPlan | undefined> {
    try {
      if (this.settings.addToToday) {
        return Promise.resolve(this.safePlan(this.dailyNotes.planDailyNoteDestination()));
      }
      const configuredPath = this.settings.customFilePath.trim();
      if (configuredPath.length === 0) return Promise.resolve(undefined);
      return this.planExplicit({
        filePath: configuredPath,
        insertion: configuredInsertion(this.settings),
      });
    } catch {
      return Promise.resolve(undefined);
    }
  }

  planExplicit(destination: TaskDestination): Promise<TaskDestinationPlan> {
    const planned: TaskDestination = {
      filePath: normalizePath(destination.filePath),
      insertion: { ...destination.insertion },
    };
    return Promise.resolve({
      destination: planned,
      prepare: async () => {
        try {
          const existing = this.app.vault.getAbstractFileByPath(planned.filePath);
          if (!(existing instanceof TFile)) await this.app.vault.create(planned.filePath, '');
          const prepared = this.app.vault.getAbstractFileByPath(planned.filePath);
          if (!(prepared instanceof TFile)) return { type: 'unavailable' };
          return {
            type: 'resolved',
            destination: { filePath: prepared.path, insertion: planned.insertion },
          };
        } catch {
          return { type: 'unavailable' };
        }
      },
    });
  }

  async resolveConfiguredDefault(): Promise<TaskDestinationResolution> {
    const plan = await this.planConfiguredDefault();
    return plan ? await plan.prepare() : { type: 'unavailable' };
  }

  async prepare(destination: TaskDestination): Promise<TaskDestinationResolution> {
    return await (await this.planExplicit(destination)).prepare();
  }

  private safePlan(plan: TaskDestinationPlan): TaskDestinationPlan {
    return {
      destination: {
        filePath: plan.destination.filePath,
        insertion: { ...plan.destination.insertion },
      },
      prepare: async () => {
        try {
          return await plan.prepare();
        } catch {
          return { type: 'unavailable' };
        }
      },
    };
  }
}
