import type { StatisticsRequest } from '../../src/statistics/types';
import { localDate, type TaskSnapshot, type TimeEntrySnapshot } from '../../src/tasks';
import type { TaskStatisticsSnapshot } from '../../src/tasks/application/TaskStatisticsSource';
export const utc = (): number => 0;
export const work = {
  yieldControl: async (): Promise<void> => {},
  isCancelled: (): boolean => false,
};
export function task(title: string, options: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const ref = { filePath: `${title}.md`, line: 0, revision: '1' };
  return {
    ref,
    title,
    markdownTitle: title,
    status: 'open',
    statusSymbol: ' ',
    priority: 'C',
    planning: {},
    tags: [],
    dependsOn: [],
    onCompletion: 'keep',
    onCompletionExplicit: false,
    subtasks: [],
    comments: [],
    timeEntries: [],
    source: {
      filePath: ref.filePath,
      line: 0,
      originalMarkdown: `- [ ] ${title}`,
      originalBlock: `- [ ] ${title}`,
    },
    presentation: { linkCount: 0 },
    ...options,
  };
}
export function source(
  tasks: readonly TaskSnapshot[],
  archive: readonly TaskSnapshot[] = [],
): TaskStatisticsSnapshot {
  return {
    revision: 1,
    ready: true,
    issues: [],
    files: [
      ...tasks.map((t) => ({
        path: t.ref.filePath,
        revision: 1,
        kind: 'live' as const,
        roots: [t],
        dateIssues: [],
      })),
      ...archive.map((t) => ({
        path: t.ref.filePath,
        revision: 1,
        kind: 'archive' as const,
        roots: [t],
        dateIssues: [],
      })),
    ],
  };
}
export function closed(start: string, end: string, line = 1): TimeEntrySnapshot {
  return {
    state: 'closed',
    startMs: Date.parse(start),
    endMs: Date.parse(end),
    relativeLine: line,
    originalMarkdown: `${start} → ${end}`,
  };
}
export function request(options: Partial<StatisticsRequest> = {}): StatisticsRequest {
  return {
    view: 'rhythm',
    period: 'month',
    scope: { type: 'all' },
    group: 'project',
    nowMs: Date.parse('2026-10-04T12:00Z'),
    offsetAt: utc,
    firstDayOfWeek: 1,
    ...options,
  };
}
export const date = localDate;
