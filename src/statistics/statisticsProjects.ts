import { bucketAt, dayOf, type StatisticsCalendar } from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { active, inScope } from './statisticsDataset';
import { dependencySections } from './statisticsDependencies';
import { age, ageBand, dateEligibility, datedEvent, inPeriod, overdue } from './statisticsFlow';
import { contribution } from './statisticsIntervals';
import { finish, metric, pageActions } from './statisticsViews';
import { rankedNumber, required, sorted } from './statisticsWork';
import type { StatisticsContext, StatisticsTask, StatisticsViewModel } from './types';
const EVENTS = ['created', 'completed', 'cancelled'] as const;
type EventKind = (typeof EVENTS)[number];
interface MovementGroup {
  label: string;
  count: number;
  events: Map<EventKind, Map<number, number>>;
}
function completionOrigin(
  task: StatisticsTask,
  completed: number,
  calendar: StatisticsCalendar,
): string {
  if (task.created === undefined || dayOf(task.created) > completed) return 'unknown';
  return dayOf(task.created) < calendar.fromDay ? 'before' : 'new';
}
class Movement {
  readonly groups = new Map<string, MovementGroup>();
  readonly origins = new Map<string, number[]>();
  maximum = 0;
  constructor(private readonly ctx: StatisticsContext) {}
  private event(group: MovementGroup, task: StatisticsTask, event: EventKind): void {
    const day = datedEvent(task, event, this.ctx.calendar);
    if (day === undefined) return;
    const counts = group.events.get(event) ?? new Map<number, number>();
    group.events.set(event, counts);
    if (!inPeriod(day, this.ctx.calendar)) return;
    const bucket = bucketAt(this.ctx.calendar, day);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    if (event === 'completed') {
      const origin = completionOrigin(task, day, this.ctx.calendar),
        list = this.origins.get(origin) ?? [];
      list.push(task.index);
      this.origins.set(origin, list);
    }
  }
  async prepare(): Promise<void> {
    for (const task of this.ctx.dataset.tasks) {
      if (inScope(task, this.ctx.request.scope)) {
        const group = this.groups.get(task.projectKey) ?? {
          label: task.projectName,
          count: 0,
          events: new Map<EventKind, Map<number, number>>(),
        };
        group.count++;
        this.groups.set(task.projectKey, group);
        for (const event of EVENTS) {
          this.event(group, task, event);
          await this.ctx.budget.step();
        }
      }
      await this.ctx.budget.step();
    }
    await this.measure();
  }
  private async measure(): Promise<void> {
    for (const group of this.groups.values())
      for (const counts of group.events.values()) {
        let total = 0;
        for (const value of counts.values()) {
          total += value;
          await this.ctx.budget.step();
        }
        this.maximum = Math.max(this.maximum, total);
        await this.ctx.budget.step();
      }
  }
  private selection(key: string, event: EventKind, bucket: number): string {
    const { calendar, request, evidence } = this.ctx,
      to = required(calendar.buckets[bucket]).toDay;
    return evidence.taskQuery(`movement:${key}:${event}:${bucket}`, (task) => {
      const day = datedEvent(task, event, calendar);
      return (
        task.projectKey === key &&
        inScope(task, request.scope) &&
        day !== undefined &&
        day >= calendar.fromDay &&
        day < to
      );
    });
  }
  private async seriesMarks(
    key: string,
    event: EventKind,
    counts: Map<number, number>,
  ): Promise<StatisticsMark[]> {
    const marks: StatisticsMark[] = [
      { key: `${key}:${event}:origin`, x: 0, y: 0, series: event, label: 'Before first bucket' },
    ];
    let total = 0;
    for (let i = 0; i < this.ctx.calendar.buckets.length; i++) {
      total += counts.get(i) ?? 0;
      marks.push({
        key: `${key}:${event}:${i}`,
        x: i + 1,
        y: total,
        series: event,
        label: required(this.ctx.calendar.buckets[i]).key,
        selectionId: this.selection(key, event, i),
      });
      await this.ctx.budget.step();
    }
    return marks;
  }
  async chart(key: string): Promise<StatisticsChartModel> {
    const group = required(this.groups.get(key)),
      marks: StatisticsMark[] = [],
      series: Array<StatisticsChartModel['series'][number]> = [];
    for (const event of EVENTS) {
      const counts = group.events.get(event);
      if (counts !== undefined) {
        series.push({ key: event, label: event, tone: event });
        marks.push(...(await this.seriesMarks(key, event, counts)));
      }
    }
    return {
      id: `movement:${key}`,
      accessibleLabel: `Cumulative retained events · ${group.label}`,
      kind: 'lines',
      layout: 'facets',
      facet: { key, label: group.label },
      x: {
        ...numeric('Date', this.ctx.calendar.buckets.length),
        tickLabels: this.ctx.calendar.buckets.map(
          (bucket, index) => [index + 1, bucket.key] as const,
        ),
      },
      y: numeric('Cumulative tasks', this.maximum),
      series,
      marks,
    };
  }
}
async function movement(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  const model = new Movement(ctx);
  await model.prepare();
  const keys = await sorted(
      [...model.groups.keys()],
      (a, z) =>
        rankedNumber(required(model.groups.get(z)).count, required(model.groups.get(a)).count, () =>
          a.localeCompare(z),
        ),
      ctx.budget,
    ),
    page = Math.max(0, Math.floor(ctx.request.page ?? 0)),
    charts: StatisticsChartModel[] = [];
  for (const key of keys.slice(page * 12, (page + 1) * 12)) charts.push(await model.chart(key));
  const metrics = ['before', 'new', 'unknown'].map((origin) =>
    metric(
      `completion-origin:${origin}`,
      `Completed · ${origin} creation`,
      (model.origins.get(origin) ?? []).length,
      ctx.evidence.tasks(`completion-origin:${origin}`, model.origins.get(origin) ?? []),
    ),
  );
  return finish(
    ctx,
    [
      {
        id: 'movement',
        title: 'Project movement',
        context:
          'Cumulative retained events classified by current project. Zero origin precedes the period. Missing date series are unavailable; this does not reconstruct historical backlog.',
        metrics: [...metrics, ...(await dateEligibility(ctx, EVENTS))],
        charts,
        legend: [],
      },
    ],
    pageActions(page, keys.length, 12),
  );
}
interface AgePoint {
  age: number;
  minutes: number;
  overdue: number;
  indices: number[];
}
interface AgeGroup {
  label: string;
  bands: number[][];
}
const AGE_LABELS = ['0–7', '8–14', '15–30', '31–60', '61+', 'Unknown'];
class Aging {
  readonly open: number[] = [];
  readonly unknown: number[] = [];
  readonly projects = new Map<string, AgeGroup>();
  private readonly durations = new Map<number, number>();
  private points = new Map<string, AgePoint>();
  private maxAge = 0;
  private maxMinutes = 0;
  private dense = false;
  constructor(private readonly ctx: StatisticsContext) {}
  async prepare(): Promise<void> {
    for (const entry of this.ctx.dataset.entries) {
      const value = contribution(entry, -Infinity, this.ctx.request.nowMs, this.ctx.request.nowMs);
      this.durations.set(entry.owner, (this.durations.get(entry.owner) ?? 0) + value);
      await this.ctx.budget.step();
    }
    for (const task of this.ctx.dataset.tasks) {
      if (task.fileKind === 'live' && active(task) && inScope(task, this.ctx.request.scope))
        this.addTask(task);
      await this.ctx.budget.step();
    }
    await this.bin();
  }
  private addTask(task: StatisticsTask): void {
    this.open.push(task.index);
    const days = age(task, this.ctx.calendar),
      minutes = this.durations.get(task.index) ?? 0,
      group = this.projects.get(task.projectKey) ?? {
        label: task.projectName,
        bands: Array.from({ length: 6 }, () => [] as number[]),
      };
    required(group.bands[ageBand(days)]).push(task.index);
    this.projects.set(task.projectKey, group);
    if (days === undefined) {
      this.unknown.push(task.index);
      return;
    }
    this.maxAge = Math.max(this.maxAge, days);
    this.maxMinutes = Math.max(this.maxMinutes, minutes);
    const key = `${days}:${minutes}`,
      point = this.points.get(key) ?? { age: days, minutes, overdue: 0, indices: [] };
    point.indices.push(task.index);
    if (overdue(task, this.ctx.calendar)) point.overdue++;
    this.points.set(key, point);
  }
  private async bin(): Promise<void> {
    this.dense = this.points.size > 600;
    if (!this.dense) return;
    const bins = new Map<string, AgePoint>();
    for (const point of this.points.values()) {
      const x = Math.min(29, Math.floor((point.age / Math.max(1, this.maxAge)) * 30)),
        y = Math.min(19, Math.floor((point.minutes / Math.max(1, this.maxMinutes)) * 20)),
        key = `${x}:${y}`,
        cell = bins.get(key) ?? {
          age: (x * this.maxAge) / 30,
          minutes: (y * this.maxMinutes) / 20,
          overdue: 0,
          indices: [],
        };
      cell.overdue += point.overdue;
      for (const index of point.indices) {
        cell.indices.push(index);
        await this.ctx.budget.step();
      }
      bins.set(key, cell);
      await this.ctx.budget.step();
    }
    this.points = bins;
  }
  chart(): StatisticsChartModel {
    const marks: StatisticsMark[] = [];
    for (const [key, point] of this.points)
      marks.push({
        key,
        x: point.age,
        y: point.minutes,
        x2: this.dense ? point.age + this.maxAge / 30 : undefined,
        y2: this.dense ? point.minutes + this.maxMinutes / 20 : undefined,
        weight: point.indices.length,
        overdue: point.overdue,
        selectionId: this.ctx.evidence.tasks(`aging:${key}`, point.indices),
        detail: `${point.indices.length} tasks; ${point.overdue} overdue`,
      });
    return {
      id: 'aging',
      accessibleLabel: 'Current task age versus all-time recorded minutes',
      kind: 'scatter',
      layout: this.dense ? 'density' : undefined,
      x: numeric('Age', this.maxAge, 0, 'days'),
      y: numeric('Recorded time', this.maxMinutes, 0, 'minutes'),
      series: [],
      marks,
    };
  }
  async composition(): Promise<{ charts: StatisticsChartModel[]; keys: string[]; page: number }> {
    const keys = await sorted(
        [...this.projects.keys()],
        (a, z) => a.localeCompare(z),
        this.ctx.budget,
      ),
      page = Math.max(0, Math.floor(this.ctx.request.page ?? 0));
    let maximum = 0;
    for (const group of this.projects.values()) {
      for (const indices of group.bands) maximum = Math.max(maximum, indices.length);
      await this.ctx.budget.step();
    }
    const charts = keys
      .slice(page * 12, (page + 1) * 12)
      .map((key) => this.projectChart(key, maximum));
    return { charts, keys, page };
  }
  private projectChart(key: string, maximum: number): StatisticsChartModel {
    const group = required(this.projects.get(key));
    return {
      id: `age-project:${key}`,
      accessibleLabel: `Current task ages · ${group.label}`,
      kind: 'bars',
      layout: 'facets',
      facet: { key, label: group.label },
      x: bands('Age days', AGE_LABELS),
      y: numeric('Tasks', maximum),
      series: [],
      marks: group.bands.map((indices, i) => ({
        key: `${key}:${i}`,
        x: required(AGE_LABELS[i]),
        y: indices.length,
        selectionId: this.ctx.evidence.tasks(`age-project:${key}:${i}`, indices),
      })),
    };
  }
}
async function aging(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  const model = new Aging(ctx);
  await model.prepare();
  const composition = await model.composition();
  return finish(
    ctx,
    [
      {
        id: 'aging',
        title: 'Current open task age and recorded time',
        context:
          'Live tasks; all-time node-own recorded time. Missing recorded time does not mean unstarted.',
        metrics: [
          metric(
            'open-now',
            'Open now',
            model.open.length,
            ctx.evidence.tasks('open-now', model.open),
          ),
          metric(
            'unknown-age',
            'Unknown age',
            model.unknown.length,
            ctx.evidence.tasks('unknown-age', model.unknown),
          ),
        ],
        charts: [model.chart()],
        legend: [],
      },
      {
        id: 'age-composition',
        title: 'Age composition by project',
        context: 'Current containing project; missing ages stay explicit.',
        metrics: [],
        charts: composition.charts,
        legend: [],
      },
    ],
    pageActions(composition.page, composition.keys.length, 12),
  );
}
export async function projectView(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  if (ctx.request.view === 'movement') return movement(ctx);
  if (ctx.request.view === 'aging') return aging(ctx);
  const result = await dependencySections(ctx);
  return finish(ctx, result.sections, result.actions);
}
