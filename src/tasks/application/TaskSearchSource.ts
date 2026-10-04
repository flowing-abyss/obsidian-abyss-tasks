import type { TaskSearchAddress } from '../domain/taskSearchTypes';
export type TaskSearchField =
  'title' | 'description' | 'comments' | 'tags' | 'metadata' | 'links' | 'sourcePath';
export interface TaskSearchSourceNode {
  readonly id: number;
  readonly rootId: number;
  readonly order: {
    readonly filePath: string;
    readonly line: number;
    readonly childLines: readonly number[];
  };
}
export interface TaskSearchDocument extends TaskSearchSourceNode, Record<TaskSearchField, string> {}
export interface TaskSearchEngineHit {
  readonly id: number;
  readonly score: number;
}
export type TaskSearchSourceState =
  | { readonly type: 'initializing'; readonly generation: number }
  | { readonly type: 'ready'; readonly generation: number }
  | { readonly type: 'failed'; readonly generation: number; readonly cause: unknown }
  | { readonly type: 'disposed'; readonly generation: number };
export interface TaskSearchFileVersion {
  readonly path: string;
  readonly version: number;
}
export type TaskSearchSourceEvent =
  | { readonly type: 'state'; readonly state: TaskSearchSourceState }
  | {
      readonly type: 'files';
      readonly generation: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly version: number | null }>;
    }
  | { readonly type: 'semantics'; readonly generation: number };
export interface TaskSearchSource {
  ensureReady(): Promise<void>;
  subscribe(listener: (event: TaskSearchSourceEvent) => void): {
    readonly state: TaskSearchSourceState;
    readonly unsubscribe: () => void;
  };
  files(): readonly TaskSearchFileVersion[];
  nodes(file: TaskSearchFileVersion): Iterable<TaskSearchSourceNode>;
  address(id: number): TaskSearchAddress | undefined;
  documents(file: TaskSearchFileVersion): Iterable<TaskSearchDocument>;
}
