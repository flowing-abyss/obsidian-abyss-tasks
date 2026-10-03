import type { PreparedSearchQuery } from '../domain/searchMatchPolicy';
import type { TaskSearchDocument, TaskSearchEngineHit } from './TaskSearchSource';
export interface TaskSearchEngineRequest {
  readonly kind: 'roots' | 'nodes';
  readonly query: PreparedSearchQuery;
  readonly includeSourcePath: boolean;
  readonly preferFilePath?: string;
  readonly filePath?: string;
}
export interface TaskSearchEngine {
  replaceBegin(path: string): void;
  add(documents: readonly TaskSearchDocument[]): void;
  replaceCommit(path: string): void;
  remove(path: string): void;
  search(request: TaskSearchEngineRequest): readonly TaskSearchEngineHit[];
  vacuum(): Promise<void>;
  dispose(): void;
}
