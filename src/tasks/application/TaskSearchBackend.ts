import type { SearchWordSegmenter } from '../domain/searchMatchPolicy';
import type { TaskSearchErrorCode } from '../domain/taskSearchTypes';
import type { TaskReadProjectionApi, TaskSearchCursor } from './TaskSearchApi';
import type { TaskSearchEngineRequest } from './TaskSearchEngine';
import type { TaskSearchDocument, TaskSearchEngineHit, TaskSearchSource } from './TaskSearchSource';
export type TaskSearchMutation =
  | { readonly type: 'begin'; readonly path: string }
  | { readonly type: 'add'; readonly documents: readonly TaskSearchDocument[] }
  | { readonly type: 'commit'; readonly path: string }
  | { readonly type: 'remove'; readonly path: string }
  | { readonly type: 'publish'; readonly generation: number };
export interface TaskSearchBackendPage {
  readonly cursor: TaskSearchCursor;
  readonly offset: number;
  readonly hits: readonly TaskSearchEngineHit[];
  readonly done: boolean;
}
export interface TaskSearchBackend {
  subscribeFailure(listener: (cause: unknown) => void): () => void;
  mutate(operation: TaskSearchMutation): Promise<void>;
  open(request: TaskSearchEngineRequest, generation: number): Promise<TaskSearchCursor>;
  read(cursor: TaskSearchCursor, offset: number, limit: number): Promise<TaskSearchBackendPage>;
  release(cursor: TaskSearchCursor): void;
  dispose(): void;
}
export interface TaskSearchScheduler {
  now(): number;
  yield(signal: AbortSignal): Promise<void>;
  delay(ms: number, signal: AbortSignal): Promise<void>;
}
export interface TaskSearchDiagnostic {
  readonly phase: string;
  readonly backend: 'worker' | 'inline';
  readonly generation: number;
  readonly pathCount: number;
  readonly error: unknown;
}
export interface TaskSearchServiceOptions {
  readonly source: TaskSearchSource;
  readonly reads: TaskReadProjectionApi;
  readonly segment: SearchWordSegmenter;
  readonly scheduler: TaskSearchScheduler;
  readonly createBackend: (mode: 'worker' | 'inline') => Promise<TaskSearchBackend>;
  readonly diagnose: (value: TaskSearchDiagnostic) => void;
}
// new TaskSearchService(options): TaskSearchApi plus dispose():void

export type TaskSearchOperation =
  | { readonly type: 'init' }
  | { readonly type: 'mutate'; readonly operation: TaskSearchMutation }
  | {
      readonly type: 'open';
      readonly request: TaskSearchEngineRequest;
      readonly generation: number;
    }
  | {
      readonly type: 'read';
      readonly cursor: TaskSearchCursor;
      readonly offset: number;
      readonly limit: number;
    }
  | { readonly type: 'release'; readonly cursor: TaskSearchCursor };
export type TaskSearchMessage = TaskSearchOperation & {
  readonly epoch: number;
  readonly id: number;
};
export type TaskSearchReply =
  | { readonly epoch: number; readonly type: 'ready' }
  | {
      readonly epoch: number;
      readonly id: number;
      readonly type: 'success';
      readonly value: TaskSearchCursor | TaskSearchBackendPage | undefined;
    }
  | {
      readonly epoch: number;
      readonly id: number;
      readonly type: 'failure';
      readonly code: TaskSearchErrorCode;
      readonly message: string;
    };
