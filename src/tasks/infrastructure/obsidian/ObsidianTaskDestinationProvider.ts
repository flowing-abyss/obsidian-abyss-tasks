import { normalizePath } from 'obsidian';
import { noteNameOfPath } from '../../../markdown/noteName';
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

export type TaskNotePreparation =
  | { readonly type: 'unsupported-template' }
  | {
      readonly type: 'ready';
      readonly content: string;
      validate(): Promise<boolean>;
      check(file: object, live: string): boolean;
      provision(validate: () => Promise<boolean>): Promise<{
        readonly path?: string;
        readonly effects: 'unchanged' | 'committed' | 'unknown';
      }>;
    };
interface DestinationPlanOptions {
  readonly allowExcluded: boolean;
  readonly configuration?: ConfiguredTaskDestination;
  readonly provisionDestination?: boolean;
}

export class ObsidianTaskDestinationProvider implements TaskDestinationProvider {
  constructor(
    private readonly currentConfiguration: CurrentTaskDestinationConfiguration,
    private readonly provision: ProvisionTaskNote,
    private readonly isExcludedDestination: (filePath: string) => boolean | Promise<boolean> = () =>
      false,
    private readonly paths:
      | ((filePath: string) => string)
      | {
          canonicalize(filePath: string): string;
          planNote(
            filePath: string,
            templatePath: string,
            title: string,
          ): Promise<TaskNotePreparation>;
        } = (filePath) => filePath,
  ) {}

  planConfiguredDefault(): Promise<TaskDestinationPlan> {
    const configuration = this.currentConfiguration();
    const pattern = compileNotePathPattern(configuration.taskFilePath);
    const destination: TaskDestination = {
      filePath: this.canonicalizePath(pattern.resolve(configuration.capturedToday)),
      insertion: { ...configuration.insertion },
    };
    return Promise.resolve(
      this.plan(destination, configuration.taskTemplatePath, noteNameOfPath(destination.filePath), {
        allowExcluded: false,
        configuration: structuredClone(configuration),
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
      this.plan(destination, '', noteNameOfPath(destination.filePath), { allowExcluded: true }),
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
      this.plan(planned, '', noteNameOfPath(planned.filePath), {
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
    const plan: TaskDestinationPlan = {
      destination,
      ...(typeof this.paths === 'function'
        ? {}
        : {
            seal: async () => this.sealedPlan({ destination, templatePath, title, options }, plan),
          }),
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
    return plan;
  }

  private canonicalizePath(filePath: string): string {
    return typeof this.paths === 'function'
      ? this.paths(filePath)
      : this.paths.canonicalize(filePath);
  }

  private async sealedPlan(
    input: {
      destination: TaskDestination;
      templatePath: string;
      title: string;
      options: DestinationPlanOptions;
    },
    legacy: TaskDestinationPlan,
  ): Promise<TaskDestinationPlan> {
    if (typeof this.paths === 'function') return legacy;
    const { destination, templatePath, title, options } = input;
    const note = await this.paths.planNote(destination.filePath, templatePath, title);
    if (note.type === 'unsupported-template') return { ...legacy, preparedFailure: note.type };
    const configurationCurrent = (): boolean => {
      const expected = options.configuration;
      if (expected === undefined)
        return this.canonicalizePath(destination.filePath) === destination.filePath;
      const current = this.currentConfiguration();
      return (
        current.taskFilePath === expected.taskFilePath &&
        current.taskTemplatePath === expected.taskTemplatePath &&
        JSON.stringify(current.insertion) === JSON.stringify(expected.insertion) &&
        this.canonicalizePath(
          compileNotePathPattern(current.taskFilePath).resolve(current.capturedToday),
        ) === destination.filePath
      );
    };
    const validate = async (): Promise<boolean> =>
      configurationCurrent() &&
      !(await this.isExcludedDestination(destination.filePath)) &&
      (await note.validate());
    return {
      ...legacy,
      plannedContent: note.content,
      validatePrepared: validate,
      checkPrepared: (file, live) => configurationCurrent() && note.check(file, live),
      prepareGuarded: async (validateOuter) => {
        if (!(await validateOuter()) || !(await validate()))
          return { resolution: { type: 'unavailable' }, effects: 'unchanged' };
        if (options.provisionDestination === false)
          return { resolution: { type: 'resolved', destination }, effects: 'unchanged' };
        const result = await note.provision(
          async () => (await validateOuter()) && (await validate()),
        );
        return {
          resolution:
            result.path === destination.filePath
              ? { type: 'resolved', destination }
              : { type: 'unavailable' },
          effects: result.effects,
        };
      },
    };
  }
}
