import { prepareCalendar, type StatisticsCalendar } from './statisticsCalendar';
import { scopedCoverage } from './statisticsDataset';
import { EvidenceRegistry } from './statisticsEvidence';
import { flowView } from './statisticsFlow';
import { projectView } from './statisticsProjects';
import { timeView } from './statisticsTime';
import { StatisticsCancelled, WorkBudget } from './statisticsWork';
import type {
  StatisticsDataset,
  StatisticsRequest,
  StatisticsScopedCoverage,
  StatisticsViewModel,
  StatisticsWork,
} from './types';
export class StatisticsSession {
  private generation = 0;
  private scopeCache: { key: string; coverage: StatisticsScopedCoverage } | undefined;
  private calendarCache:
    | {
        request: StatisticsRequest;
        calendar: StatisticsCalendar;
      }
    | undefined;
  private readonly cache = new Map<
    string,
    {
      request: StatisticsRequest;
      view: StatisticsViewModel;
    }
  >();
  constructor(private readonly dataset: StatisticsDataset) {}
  async view(
    request: StatisticsRequest,
    work: StatisticsWork,
  ): Promise<StatisticsViewModel | undefined> {
    try {
      const budget = new WorkBudget(work);
      budget.check();
      const cached = this.cache.get(request.view);
      if (cached !== undefined && sameRequest(cached.request, request)) return cached.view;
      const generation = ++this.generation;
      const calendar = await this.calendar(request, work);
      if (calendar === undefined) return undefined;
      if (generation === this.generation)
        this.calendarCache = { request: { ...request }, calendar };
      const builder = builderFor(request.view);
      const view = await builder({
        dataset: this.dataset,
        request,
        calendar,
        evidence: new EvidenceRegistry(this.dataset, await this.coverage(request, budget)),
        budget,
      });
      budget.check();
      if (generation === this.generation)
        this.cache.set(request.view, {
          request: { ...request, scope: { ...request.scope } },
          view,
        });
      return view;
    } catch (error) {
      if (error instanceof StatisticsCancelled) return undefined;
      throw error;
    }
  }
  private async coverage(
    request: StatisticsRequest,
    budget: WorkBudget,
  ): Promise<StatisticsScopedCoverage> {
    const key = JSON.stringify(request.scope);
    if (this.scopeCache?.key === key) return this.scopeCache.coverage;
    const coverage = await scopedCoverage(this.dataset, request.scope, budget);
    this.scopeCache = { key, coverage };
    return coverage;
  }
  private async calendar(
    request: StatisticsRequest,
    work: StatisticsWork,
  ): Promise<StatisticsCalendar | undefined> {
    if (this.calendarCache !== undefined && sameCalendar(this.calendarCache.request, request))
      return this.calendarCache.calendar;
    return prepareCalendar(this.dataset, request, work);
  }
}
function sameRequest(a: StatisticsRequest, b: StatisticsRequest): boolean {
  return (
    a.offsetAt === b.offsetAt &&
    a.calendarTransitions === b.calendarTransitions &&
    a.nowMs === b.nowMs &&
    a.firstDayOfWeek === b.firstDayOfWeek &&
    a.period === b.period &&
    a.group === b.group &&
    a.page === b.page &&
    a.weekStart === b.weekStart &&
    a.focusKey === b.focusKey &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope)
  );
}
function sameCalendar(a: StatisticsRequest, b: StatisticsRequest): boolean {
  return (
    a.nowMs === b.nowMs &&
    a.period === b.period &&
    a.firstDayOfWeek === b.firstDayOfWeek &&
    a.offsetAt === b.offsetAt &&
    a.calendarTransitions === b.calendarTransitions
  );
}

function builderFor(view: StatisticsRequest['view']): typeof flowView {
  if (['allocation', 'timeline', 'sessions', 'patterns'].includes(view)) return timeView;
  if (['movement', 'aging', 'dependencies'].includes(view)) return projectView;
  return flowView;
}
