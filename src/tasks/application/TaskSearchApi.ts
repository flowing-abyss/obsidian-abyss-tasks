import type {
  TaskOrganizationBatch,
  TaskOrganizationRequest,
  TaskSearchHit,
  TaskSearchHydratedHit,
} from '../domain/taskSearchTypes';
import type { TaskQueryApi } from './TaskApplicationApi';
export interface TaskReadProjectionApi extends Pick<TaskQueryApi, 'observedTags'> {
  organization(
    request: TaskOrganizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<TaskOrganizationBatch>;
  resolveSearchHits(
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
export interface TaskSearchBatch {
  readonly cursor: TaskSearchCursor;
  readonly offset: number;
  readonly hits: readonly TaskSearchHit[];
  readonly done: boolean;
}
export type TaskSearchState =
  | {
      readonly phase: 'idle' | 'waiting' | 'building' | 'updating' | 'recovering';
      readonly generation: number;
      readonly semanticsRevision: number;
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | {
      readonly phase: 'ready';
      readonly generation: number;
      readonly semanticsRevision: number;
      readonly compatibility: boolean;
    }
  | {
      readonly phase: 'failed';
      readonly generation: number;
      readonly semanticsRevision: number;
      readonly episode: number;
    }
  | { readonly phase: 'disposed'; readonly generation: number; readonly semanticsRevision: number };
export interface TaskSearchApi {
  prepare(signal: AbortSignal): Promise<void>;
  open(request: TaskSearchRequest, signal: AbortSignal): Promise<TaskSearchCursor>;
  read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TaskSearchBatch>;
  release(cursor: TaskSearchCursor): void;
  resolveHits(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]>;
  subscribe(listener: (state: TaskSearchState) => void): () => void;
}
