import { compileNotePathPattern } from '../markdown/notePathPattern';
import { validateQuerySyntax } from '../query/evaluateQuery';

export interface TaskStorageSettings {
  readonly taskArchivePath: string;
  readonly taskIgnoreQuery: string;
}

export type TaskStorageDraftResult =
  | { readonly type: 'valid'; readonly settings: TaskStorageSettings }
  | {
      readonly type: 'invalid';
      readonly field: keyof TaskStorageSettings;
      readonly message: string;
    };

function quotedPath(path: string): string {
  return `"${path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function combineQueries(query: string, path: string): string {
  const retained = quotedPath(path);
  return query.trim().length === 0 ? retained : `(${query.trim()}) OR (${retained})`;
}

export function taskSourceIgnoreQuery(settings: TaskStorageSettings): string {
  return combineQueries(settings.taskIgnoreQuery, settings.taskArchivePath.trim());
}

export function validateTaskStorageDraft(
  current: TaskStorageSettings,
  draft: TaskStorageSettings,
): TaskStorageDraftResult {
  const taskArchivePath = draft.taskArchivePath.trim();
  try {
    compileNotePathPattern(taskArchivePath);
  } catch (error) {
    return {
      type: 'invalid',
      field: 'taskArchivePath',
      message: error instanceof Error ? error.message : 'Invalid archive path.',
    };
  }
  const taskIgnoreQuery = draft.taskIgnoreQuery.trim();
  const validation = validateQuerySyntax(taskIgnoreQuery);
  if (validation.type === 'invalid') {
    return {
      type: 'invalid',
      field: 'taskIgnoreQuery',
      message: validation.message,
    };
  }
  const previousArchivePath = current.taskArchivePath.trim();
  return {
    type: 'valid',
    settings: {
      taskArchivePath,
      taskIgnoreQuery:
        previousArchivePath === taskArchivePath
          ? taskIgnoreQuery
          : combineQueries(taskIgnoreQuery, previousArchivePath),
    },
  };
}
