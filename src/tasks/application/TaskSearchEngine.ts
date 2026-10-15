import type { PreparedSearchQuery } from '../domain/searchMatchPolicy';
import type { TaskSearchDocument, TaskSearchEngineHit } from './TaskSearchSource';
export type TaskSearchEngineRequest = (
  { readonly kind: 'roots' } | { readonly kind: 'nodes'; readonly matchScope?: 'node' | 'subtree' }
) & {
  readonly query: PreparedSearchQuery;
  readonly includeSourcePath: boolean;
  readonly preferFilePath?: string;
  readonly filePath?: string;
};
/** Scope is opt-in and valid only for exact-node retrieval. */
export function validTaskSearchMatchScope(request: {
  readonly kind: unknown;
  readonly matchScope?: unknown;
}): boolean {
  return request.kind === 'nodes'
    ? request.matchScope === undefined ||
        request.matchScope === 'node' ||
        request.matchScope === 'subtree'
    : request.kind === 'roots' && request.matchScope === undefined;
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
