import type {
  CreateProjectV1,
  EffectStateV1,
  ProjectDtoV1,
  ProjectSchemaV1,
  ProjectSummaryV1,
} from '../../api';
import type {
  ProjectTaskExecution,
  TaskReadNode,
  TaskReadObservation,
  TaskReadResult,
} from '../tasks';

/** The integrations layer receives allowlisted values and opaque file evidence only. */
export interface ProjectReadSummary extends Omit<ProjectSummaryV1, 'target' | 'revision'> {
  readonly identity: object;
  readonly version: number;
  readonly semantics: object;
}
export interface ProjectReadRecord
  extends ProjectReadSummary, Pick<ProjectDtoV1, 'fields' | 'tags'> {}
export interface ProjectIntegrationReads {
  semantics(): object;
  schema(): Omit<
    ProjectSchemaV1,
    'providerEpoch' | 'revision' | 'generation' | 'scopeRevision' | 'semanticsRevision'
  >;
  coverage(): TaskReadResult<true>;
  paths(): readonly string[];
  summary(path: string, semantics?: object): TaskReadResult<ProjectReadSummary | undefined>;
  get(path: string): TaskReadResult<ProjectReadRecord | undefined>;
  matchesFile(proof: ProjectReadSummary, file: object): boolean;
  guard(proof: ProjectReadSummary, live: string, candidate: string): TaskReadResult<true>;
  prospective(path: string, candidate: string): TaskReadResult<true>;
}

export type ProjectAssignments = Pick<CreateProjectV1, 'statusId' | 'fields'>;
export type ProjectCreation = Pick<CreateProjectV1, 'name'> & ProjectAssignments;
export type ProjectWriteReason =
  Extract<TaskReadResult<true>, { type: 'error' }>['reason'] | 'invalid' | 'unsupported' | 'io';
export type ProjectWriteResult =
  | {
      readonly outcome: 'changed' | 'noop';
      readonly effects: 'committed' | 'unchanged';
      readonly project?: ProjectReadSummary;
    }
  | {
      readonly outcome: 'failed';
      readonly effects: EffectStateV1;
      readonly reason: ProjectWriteReason;
      readonly project?: ProjectReadSummary;
    };
export interface ProjectIntegrationWrites {
  create(input: ProjectCreation): Promise<ProjectWriteResult>;
  update(proof: ProjectReadSummary, input: ProjectAssignments): Promise<ProjectWriteResult>;
}

export interface ProjectTaskCommands {
  prepareCreate(proof: ProjectReadSummary, title: string): ProjectTaskExecution;
  prepareMove(
    proof: ProjectReadSummary,
    node: TaskReadNode,
    observation: TaskReadObservation,
  ): ProjectTaskExecution;
}
