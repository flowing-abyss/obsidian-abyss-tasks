import type { ProjectDtoV1, ProjectSchemaV1, ProjectSummaryV1 } from '../../api';
import type { TaskReadResult } from '../tasks';

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
}
