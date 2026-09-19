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
  readonly taskArchivePath?: string;
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

interface DestinationPlanOptions {
  readonly allowExcluded: boolean;
  readonly provisionDestination?: boolean;
}

function titleFor(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

export class ObsidianTaskDestinationProvider implements TaskDestinationProvider {
  constructor(
    private readonly currentConfiguration: CurrentTaskDestinationConfiguration,
    private readonly provision: ProvisionTaskNote,
    private readonly isExcludedDestination: (filePath: string) => boolean | Promise<boolean> = () =>
      false,
    private readonly canonicalizePath: (filePath: string) => string = (filePath) => filePath,
  ) {}

  planConfiguredDefault(): Promise<TaskDestinationPlan> {
    const configuration = this.currentConfiguration();
    const pattern = compileNotePathPattern(configuration.taskFilePath);
    const destination: TaskDestination = {
      filePath: this.canonicalizePath(pattern.resolve(configuration.capturedToday)),
      insertion: { ...configuration.insertion },
    };
    return Promise.resolve(
      this.plan(destination, configuration.taskTemplatePath, titleFor(destination.filePath), {
        allowExcluded: false,
      }),
    );
  }

  planArchive(): Promise<TaskDestinationPlan> {
    const configuration = this.currentConfiguration();
    const pattern = compileNotePathPattern(configuration.taskArchivePath ?? 'tasks/archive.md');
    const destination: TaskDestination = {
      filePath: this.canonicalizePath(pattern.resolve(configuration.capturedToday)),
      insertion: { type: 'append' },
    };
    return Promise.resolve(
      this.plan(destination, '', titleFor(destination.filePath), { allowExcluded: true }),
    );
  }

  planExplicit(
    destination: TaskDestination,
    options: { readonly provision: boolean } = { provision: true },
  ): Promise<TaskDestinationPlan> {
    const planned: TaskDestination = {
      filePath: this.canonicalizePath(normalizePath(destination.filePath.trim())),
      insertion: { ...destination.insertion },
    };
    return Promise.resolve(
      this.plan(planned, '', titleFor(planned.filePath), {
        allowExcluded: false,
        provisionDestination: options.provision,
      }),
    );
  }

  async resolveConfiguredDefault(): Promise<TaskDestinationResolution> {
    return await (await this.planConfiguredDefault()).prepare();
  }

  async prepare(destination: TaskDestination): Promise<TaskDestinationResolution> {
    return await (await this.planExplicit(destination, { provision: true })).prepare();
  }

  private plan(
    destination: TaskDestination,
    templatePath: string,
    title: string,
    options: DestinationPlanOptions,
  ): TaskDestinationPlan {
    return {
      destination,
      validate: async (prepared) =>
        options.allowExcluded || !(await this.isExcludedDestination(prepared.filePath)),
      prepare: async () => {
        if (!options.allowExcluded && (await this.isExcludedDestination(destination.filePath))) {
          return { type: 'unavailable' };
        }
        if (options.provisionDestination === false) return { type: 'resolved', destination };
        const file = await this.provision(destination.filePath, templatePath, title);
        if (!options.allowExcluded && (await this.isExcludedDestination(file.path))) {
          return { type: 'unavailable' };
        }
        return {
          type: 'resolved',
          destination: { filePath: file.path, insertion: destination.insertion },
        };
      },
    };
  }
}
