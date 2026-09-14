import { normalizePath } from 'obsidian';
import { compileNotePathPattern } from '../../../markdown/notePathPattern';
import type {
  TaskDestinationPlan,
  TaskDestinationProvider,
  TaskDestinationResolution,
} from '../../application/TaskDestinationProvider';
import type { TaskDestination, TaskInsertionPolicy } from '../../domain/types';

export interface ConfiguredTaskDestination {
  readonly taskFilePath: string;
  readonly taskTemplatePath: string;
  readonly capturedToday: string;
  readonly insertion: TaskInsertionPolicy;
}

interface ProvisionedNote {
  readonly path: string;
}

type CurrentTaskDestinationConfiguration = () => ConfiguredTaskDestination;
type ProvisionTaskNote = (
  filePath: string,
  templatePath: string,
  title: string,
) => Promise<ProvisionedNote>;

function titleFor(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

export class ObsidianTaskDestinationProvider implements TaskDestinationProvider {
  constructor(
    private readonly currentConfiguration: CurrentTaskDestinationConfiguration,
    private readonly provision: ProvisionTaskNote,
  ) {}

  planConfiguredDefault(): Promise<TaskDestinationPlan> {
    const configuration = this.currentConfiguration();
    const pattern = compileNotePathPattern(configuration.taskFilePath);
    const destination: TaskDestination = {
      filePath: pattern.resolve(configuration.capturedToday),
      insertion: { ...configuration.insertion },
    };
    return Promise.resolve(
      this.plan(destination, configuration.taskTemplatePath, titleFor(destination.filePath)),
    );
  }

  planExplicit(destination: TaskDestination): Promise<TaskDestinationPlan> {
    const planned: TaskDestination = {
      filePath: normalizePath(destination.filePath.trim()),
      insertion: { ...destination.insertion },
    };
    return Promise.resolve(this.plan(planned, '', titleFor(planned.filePath)));
  }

  async resolveConfiguredDefault(): Promise<TaskDestinationResolution> {
    return await (await this.planConfiguredDefault()).prepare();
  }

  async prepare(destination: TaskDestination): Promise<TaskDestinationResolution> {
    return await (await this.planExplicit(destination)).prepare();
  }

  private plan(
    destination: TaskDestination,
    templatePath: string,
    title: string,
  ): TaskDestinationPlan {
    return {
      destination,
      prepare: async () => {
        const file = await this.provision(destination.filePath, templatePath, title);
        return {
          type: 'resolved',
          destination: { filePath: file.path, insertion: destination.insertion },
        };
      },
    };
  }
}
