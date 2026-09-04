import { TFile, normalizePath, type App } from 'obsidian';
import type {
  TaskDestinationPlan,
  TaskDestinationProvider,
  TaskDestinationResolution,
} from '../../application/TaskDestinationProvider';
import type { TaskDestination, TaskInsertionPolicy } from '../../domain/types';

export interface ConfiguredTaskDestination {
  readonly addToToday: boolean;
  readonly customFilePath: string;
  readonly insertion: TaskInsertionPolicy;
}

type CurrentTaskDestinationConfiguration = () => ConfiguredTaskDestination;
type PlanDailyNoteDestination = () => TaskDestinationPlan;

export class ObsidianTaskDestinationProvider implements TaskDestinationProvider {
  constructor(
    private readonly app: App,
    private readonly currentConfiguration: CurrentTaskDestinationConfiguration,
    private readonly planDailyNoteDestination: PlanDailyNoteDestination,
  ) {}

  planConfiguredDefault(): Promise<TaskDestinationPlan | undefined> {
    try {
      const configuration = this.currentConfiguration();
      if (configuration.addToToday) {
        return Promise.resolve(this.safePlan(this.planDailyNoteDestination()));
      }
      const configuredPath = configuration.customFilePath.trim();
      if (configuredPath.length === 0) return Promise.resolve(undefined);
      return this.planExplicit({
        filePath: configuredPath,
        insertion: { ...configuration.insertion },
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
    return plan != null ? await plan.prepare() : { type: 'unavailable' };
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
