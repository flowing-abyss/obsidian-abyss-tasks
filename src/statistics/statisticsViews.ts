import { dateOf } from './statisticsCalendar';
import { required } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsMetric,
  StatisticsSection,
  StatisticsViewId,
  StatisticsViewModel,
} from './types';
export const STATISTICS_VIEWS: ReadonlyArray<{
  readonly id: StatisticsViewId;
  readonly title: string;
  readonly family: 'Flow' | 'Time' | 'Projects';
}> = [
  { id: 'rhythm', title: 'Rhythm', family: 'Flow' },
  { id: 'completion', title: 'Completion', family: 'Flow' },
  { id: 'deadlines', title: 'Deadlines', family: 'Flow' },
  { id: 'cohorts', title: 'Cohorts', family: 'Flow' },
  { id: 'allocation', title: 'Allocation', family: 'Time' },
  { id: 'timeline', title: 'Timeline', family: 'Time' },
  { id: 'sessions', title: 'Sessions', family: 'Time' },
  { id: 'patterns', title: 'Patterns', family: 'Time' },
  { id: 'movement', title: 'Movement', family: 'Projects' },
  { id: 'aging', title: 'Aging', family: 'Projects' },
  { id: 'dependencies', title: 'Dependencies', family: 'Projects' },
];
export function metric(
  id: string,
  label: string,
  value: number | null,
  options: string | { selectionId?: string | undefined; unit?: StatisticsMetric['unit'] } = {},
): StatisticsMetric {
  const details = typeof options === 'string' ? { selectionId: options } : options;
  return { id, label, value, unit: 'tasks', ...details };
}
export function finish(
  ctx: Pick<StatisticsContext, 'dataset' | 'request' | 'calendar' | 'evidence'>,
  sections: readonly StatisticsSection[],
  actions: readonly StatisticsAction[] = [],
): StatisticsViewModel {
  const { request, calendar, evidence } = ctx;
  return Object.freeze({
    view: request.view,
    title: required(STATISTICS_VIEWS.find((v) => v.id === request.view)).title,
    dateLabel: `${calendar.fromDate} – ${dateOf(calendar.toDay - 1)}`,
    currentState: request.view === 'aging' || request.view === 'dependencies',
    asOfMs: request.nowMs,
    coverage: evidence.coverage,
    sections,
    actions,
    evidence: evidence.page,
  });
}
export function pageActions(page: number, total: number, size: number): StatisticsAction[] {
  const actions: StatisticsAction[] = [];
  if (page > 0) actions.push({ type: 'page', label: 'Previous groups', page: page - 1 });
  if ((page + 1) * size < total)
    actions.push({ type: 'page', label: 'Next groups', page: page + 1 });
  return actions;
}
