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

export type TaskSearchRequest =
  | {
      readonly kind: 'roots';
      readonly query: string;
      readonly includeSourcePath?: boolean;
      readonly filePath?: string;
    }
  | {
      readonly kind: 'nodes';
      readonly query: string;
      readonly includeSourcePath?: boolean;
      readonly preferFilePath?: string;
      readonly filePath?: string;
    }; // empty nodes request = bounded canonical browse
export type TaskSearchCursor =
  | {
      readonly id: string;
      readonly generation: number;
      readonly total: number;
      readonly kind: 'roots';
      readonly access: 'forward';
    }
  | {
      readonly id: string;
      readonly generation: number;
      readonly total: number;
      readonly kind: 'nodes';
      readonly access: 'random';
    };
export interface TaskSearchPage {
  readonly cursor: TaskSearchCursor;
  readonly offset: number;
  readonly hits: readonly TaskSearchHit[];
  readonly done: boolean;
}
export type TaskSearchState =
  | {
      readonly phase: 'idle' | 'waiting' | 'building' | 'updating' | 'recovering';
      readonly generation: number;
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | { readonly phase: 'ready'; readonly generation: number; readonly compatibility: boolean }
  | { readonly phase: 'failed'; readonly generation: number; readonly episode: number }
  | { readonly phase: 'disposed'; readonly generation: number };
export interface TaskSearchApi {
  open(request: TaskSearchRequest, signal: AbortSignal): Promise<TaskSearchCursor>;
  read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TaskSearchPage>;
  release(cursor: TaskSearchCursor): void;
  resolvePage(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]>;
  subscribe(listener: (state: TaskSearchState) => void): () => void;
  retry(): Promise<void>;
}
