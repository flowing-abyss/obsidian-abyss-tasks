import type {
  TaskOrganizationBatch,
  TaskOrganizationRequest,
  TaskSearchHit,
  TaskSearchHydratedHit,
} from '../domain/taskSearchTypes';
import type { TaskQueryApi } from './TaskApplicationApi';
export { TaskSearchError } from '../domain/taskSearchTypes';
export interface TaskReadProjectionApi extends Pick<TaskQueryApi, 'observedTags'> {
  organization(
    request: TaskOrganizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<TaskOrganizationBatch>;
  resolveSearchPage(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]>;
}
