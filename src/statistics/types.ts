import type {
  LocalDate,
  OffsetAt,
  TaskNodeRef,
  TaskPriority,
  TaskSnapshot,
  TaskStatisticsSnapshot,
  TimeEntryRef,
} from '../tasks';
import type { StatisticsCalendar } from './statisticsCalendar';
import type { StatisticsChartModel } from './statisticsChartModel';
import type { EvidenceRegistry } from './statisticsEvidence';
import type { WorkBudget } from './statisticsWork';
export type StatisticsViewId =
  | 'rhythm'
  | 'completion'
  | 'deadlines'
  | 'cohorts'
  | 'allocation'
  | 'timeline'
  | 'sessions'
  | 'patterns'
  | 'movement'
  | 'aging'
  | 'dependencies';
export type StatisticsPeriod =
  'today' | 'week' | '7d' | 'month' | '30d' | '90d' | 'year' | '6m' | '12m' | 'all';
export type StatisticsScope =
  | {
      readonly type: 'all';
    }
  | {
      readonly type: 'project';
      readonly path: string;
    }
  | {
      readonly type: 'tag';
      readonly tag: string;
    }
  | {
      readonly type: 'priority';
      readonly priority: TaskPriority;
    }
  | {
      readonly type: 'unassigned';
    }
  | {
      readonly type: 'archive';
    };
export interface StatisticsRequest {
  readonly view: StatisticsViewId;
  readonly period: StatisticsPeriod;
  readonly scope: StatisticsScope;
  readonly group: 'project' | 'tag' | 'priority';
  readonly nowMs: number;
  readonly offsetAt: OffsetAt;
  readonly firstDayOfWeek: number;
  readonly calendarTransitions?: readonly number[] | undefined;
  readonly weekStart?: LocalDate | undefined;
  readonly page?: number | undefined;
  readonly focusKey?: string | undefined;
}
export interface StatisticsWork {
  readonly yieldControl: () => Promise<void>;
  readonly isCancelled: () => boolean;
}
export interface StatisticsProject {
  readonly path: string;
  readonly name: string;
}
export interface StatisticsTask {
  readonly index: number;
  readonly key: string;
  readonly ref: TaskNodeRef;
  readonly filePath: string;
  readonly fileKind: 'live' | 'archive';
  readonly sourceRevision: number;
  readonly dateIssueCount: number;
  readonly nodePath: readonly number[];
  readonly title: string;
  readonly status: TaskSnapshot['status'];
  readonly priority: TaskPriority;
  readonly tags: readonly string[];
  readonly recurring: boolean;
  readonly projectKey: string;
  readonly projectName: string;
  readonly created?: LocalDate | undefined;
  readonly completion?: LocalDate | undefined;
  readonly cancelled?: LocalDate | undefined;
  readonly due?: LocalDate | undefined;
  readonly dependencyId?: string | undefined;
  readonly dependsOn: readonly string[];
}
export interface StatisticsEntry {
  readonly index: number;
  readonly key: string;
  readonly owner: number;
  readonly ref: TimeEntryRef;
  readonly state: 'closed' | 'running' | 'broken';
  readonly startMs?: number | undefined;
  readonly endMs?: number | undefined;
}
export interface StatisticsCoverage {
  readonly countingUnit: 'Tasks & subtasks';
  readonly recurrence: 'Node or ancestor; retained instances only';
  readonly nodes: number;
  readonly live: number;
  readonly archive: number;
  readonly entries: number;
  readonly brokenEntries: number;
  readonly dateIssues: number;
  readonly ready: boolean;
  readonly sourceIssues: TaskStatisticsSnapshot['issues'];
}
export interface StatisticsScopedCoverage {
  readonly nodes: number;
  readonly live: number;
  readonly archive: number;
  readonly entries: number;
  readonly brokenEntries: number;
  readonly dateIssues: number;
}
export interface StatisticsDataset {
  readonly revision: number;
  readonly tasks: readonly StatisticsTask[];
  readonly entries: readonly StatisticsEntry[];
  readonly projects: readonly StatisticsProject[];
  readonly coverage: StatisticsCoverage;
}
export interface StatisticsMetric {
  readonly role?: 'coverage' | undefined;
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit?: 'tasks' | 'entries' | 'minutes' | 'days' | 'percent' | 'changes' | undefined;
  readonly selectionId?: string | undefined;
  readonly context?: string | undefined;
}
export interface StatisticsLegend {
  readonly muted?: boolean | undefined;
  readonly key: string;
  readonly label: string;
  readonly tone: StatisticsTone;
  readonly value?: number | undefined;
  readonly selectionId?: string | undefined;
}
export type StatisticsTone =
  'created' | 'completed' | 'cancelled' | 'overdue' | 'neutral' | 'muted' | 'accent';
export interface StatisticsSection {
  readonly id: string;
  readonly title: string;
  readonly context: string;
  readonly metrics: readonly StatisticsMetric[];
  readonly charts: readonly StatisticsChartModel[];
  readonly legend: readonly StatisticsLegend[];
}
export type StatisticsAction =
  | {
      readonly type: 'period';
      readonly label: string;
      readonly period: StatisticsPeriod;
    }
  | {
      readonly type: 'scope';
      readonly label: string;
      readonly scope: StatisticsScope;
    }
  | {
      readonly type: 'week';
      readonly label: string;
      readonly weekStart: LocalDate;
    }
  | {
      readonly type: 'page';
      readonly label: string;
      readonly page: number;
    }
  | {
      readonly type: 'chain';
      readonly label: string;
      readonly focusKey: string;
    };
export interface StatisticsEvidenceRow {
  readonly key: string;
  readonly title: string;
  readonly fileKind: 'live' | 'archive';
  readonly filePath: string;
  readonly node: TaskNodeRef;
  readonly entry?: TimeEntryRef | undefined;
  readonly relatedNode?: TaskNodeRef | undefined;
  readonly atMs?: number | undefined;
  readonly contributionMinutes?: number | undefined;
  readonly context?: string | undefined;
}
export interface StatisticsEvidencePage {
  readonly total: number;
  readonly rows: readonly StatisticsEvidenceRow[];
  readonly nextOffset?: number | undefined;
}
export interface StatisticsViewModel {
  readonly view: StatisticsViewId;
  readonly title: string;
  readonly dateLabel: string;
  readonly currentState: boolean;
  readonly asOfMs: number;
  readonly coverage: {
    readonly source: StatisticsCoverage;
    readonly scope: StatisticsScopedCoverage;
  };
  readonly sections: readonly StatisticsSection[];
  readonly actions: readonly StatisticsAction[];
  readonly chartActions: ReadonlyArray<readonly [string, StatisticsAction]>;
  readonly evidence: (selectionId: string, offset: number, limit: number) => StatisticsEvidencePage;
}
export interface StatisticsContext {
  readonly dataset: StatisticsDataset;
  readonly request: StatisticsRequest;
  readonly calendar: StatisticsCalendar;
  readonly evidence: EvidenceRegistry;
  readonly budget: WorkBudget;
}
