import { indexedRows } from '../../src/panels/task-list/taskListRows';
import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../../src/task-lists/taskSearchOrganization';
/** Finite legacy fixture inspection only: production never enumerates a complete daily index. */
export function finiteOccurrences(organization: TaskSearchOrganization): TaskSearchOccurrence[] {
  return Array.from(organization.rows.slice(0, organization.rows.rowCount)).flatMap((row) =>
    row.kind === 'task' ? [row.task] : [],
  );
}
export function finiteGroupCounts(organization: TaskSearchOrganization): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of organization.rows.slice(0, organization.rows.rowCount)) {
    if (row.kind !== 'group') continue;
    const key = row.key.startsWith('group:') ? row.key.slice(row.key.indexOf(':', 6) + 1) : row.key;
    counts.set(key, row.count);
  }

  return counts;
}
export function occurrenceRows(occurrences: readonly TaskSearchOccurrence[]) {
  return indexedRows(
    occurrences.map((task) => ({
      kind: 'task' as const,
      key: task.key,
      taskKey: task.taskKey,
      task,
      presentation: task.presentation,
    })),
  );
}
