import type {
  TaskOrganizationBatch,
  TaskOrganizationRequest,
  TaskSearchHit,
  TaskSearchHydratedHit,
} from '../domain/taskSearchTypes';
export { TaskSearchError } from '../domain/taskSearchTypes';
export interface TaskReadProjectionApi {
  organization(
    request: TaskOrganizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<TaskOrganizationBatch>;
  resolveSearchPage(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]>;
  observedTags(): readonly string[];
}
