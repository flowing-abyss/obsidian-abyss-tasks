import {
  bucketAt,
  dateInterval,
  dateOf,
  dayOf,
  type StatisticsCalendar,
} from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
  type StatisticsObservation,
} from './statisticsChartModel';
import { active, inScope } from './statisticsDataset';
import { dependencySections } from './statisticsDependencies';
import { age, ageBand, datedEvent, dateEligibility, inPeriod, overdue } from './statisticsFlow';
import { contribution } from './statisticsIntervals';
import { finish, metric, pageActions } from './statisticsViews';
import { rankedNumber, required, sorted } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsSection,
  StatisticsTask,
  StatisticsViewModel,
} from './types';
const EVENTS = ['created', 'completed', 'cancelled'] as const;
type EventKind = (typeof EVENTS)[number];
const EVENT_NAMES = { created: 'creation', completed: 'completion', cancelled: 'cancellation' };
function eventApplies(task: StatisticsTask, event: EventKind): boolean {
  return (
    event === 'created' ||
    task.status === ({ completed: 'done', cancelled: 'cancelled', created: 'open' } as const)[event]
  );
}
function axisExtent(maximum: number): number {
  return maximum === 0 ? 1 : maximum;
}
function positions(page: number, count: number): string {
  return `Projects ${count === 0 ? 0 : page * 12 + 1}–${Math.min(count, (page + 1) * 12)} of ${count}`;
}
function unavailableDescription(unavailable: MovementGroup['unavailable']): string | undefined {
  if (unavailable.size === 0) return undefined;
  return [...unavailable]
    .map(
      ([event, indices]) =>
        `${indices.length} ${EVENT_NAMES[event]} date${indices.length === 1 ? '' : 's'} unavailable`,
    )
    .join(' · ');
}
interface MovementGroup {
  label: string;
  unavailable: Map<EventKind, number[]>;
  origins: Map<string, number[]>;
  count: number;
  events: Map<EventKind, Map<number, number>>;
}
function completionOrigin(
  task: StatisticsTask,
  completed: number,
  calendar: StatisticsCalendar,
): string {
  if (task.created === undefined) return 'unknown';
  if (dayOf(task.created) > completed) return 'before-created';
  return dayOf(task.created) < calendar.fromDay ? 'before' : 'new';
}
function projectLabels(ctx: StatisticsContext): Map<string, string> {
  const names = new Map<string, number>();
  for (const project of ctx.dataset.projects)
    names.set(project.name, (names.get(project.name) ?? 0) + 1);
  return new Map(
    ctx.dataset.projects.map((project) => [
      `project:${project.path}`,
      (names.get(project.name) ?? 0) > 1 ? `${project.name} · ${project.path}` : project.name,
    ]),
  );
}
function groupPage(page: number | undefined, count: number): number {
  return Math.min(Math.max(0, Math.floor(page ?? 0)), Math.max(0, Math.ceil(count / 12) - 1));
}
const ORIGINS = [
  { key: 'before', label: 'Created before period', tone: 'completed' as const },
  { key: 'new', label: 'Created in period', tone: 'created' as const },
  { key: 'unknown', label: 'Creation date unavailable', tone: 'muted' as const },
  { key: 'before-created', label: 'Completion before creation', tone: 'cancelled' as const },
];
class Movement {
  readonly groups = new Map<string, MovementGroup>();
  readonly origins = new Map<string, number[]>();
  maximum = 0;
  originMaximum = 0;
  private readonly labels = projectLabels(this.ctx);
  constructor(private readonly ctx: StatisticsContext) {}
  private event(group: MovementGroup, task: StatisticsTask, event: EventKind): void {
    const day = datedEvent(task, event, this.ctx.calendar);
    if (day === undefined) {
      if (eventApplies(task, event)) {
        const indices = group.unavailable.get(event) ?? [];
        indices.push(task.index);
        group.unavailable.set(event, indices);
      }
      return;
    }
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
      const projectOrigins = group.origins.get(origin) ?? [];
      projectOrigins.push(task.index);
      group.origins.set(origin, projectOrigins);
    }
  }
  async prepare(): Promise<void> {
    for (const task of this.ctx.dataset.tasks) {
      if (inScope(task, this.ctx.request.scope)) {
        const group = this.groups.get(task.projectKey) ?? {
          label: this.labels.get(task.projectKey) ?? task.projectName,
          unavailable: new Map<EventKind, number[]>(),
          origins: new Map<string, number[]>(),
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
    for (const group of this.groups.values()) {
      let originTotal = 0;
      for (const indices of group.origins.values()) originTotal += indices.length;
      this.originMaximum = Math.max(this.originMaximum, originTotal);
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
      { key: `${key}:${event}:origin`, x: 0, y: 0, series: event, label: 'Before period' },
    ];
    let total = 0;
    for (let i = 0; i < this.ctx.calendar.buckets.length; i++) {
      total += counts.get(i) ?? 0;
      const bucket = required(this.ctx.calendar.buckets[i]),
        endpoint = dateOf(bucket.toDay - 1);
      marks.push({
        key: `${key}:${event}:${i}`,
        x: bucket.toDay - this.ctx.calendar.fromDay,
        y: total,
        series: event,
        label: `Through ${endpoint}`,
        observation: {
          title: `${required(this.groups.get(key)).label} · Through ${endpoint}`,
          values: [
            { label: event[0]?.toUpperCase() + event.slice(1), value: total, unit: 'tasks' },
            {
              label: 'Period prefix',
              value: dateInterval(this.ctx.calendar.fromDay, bucket.toDay),
            },
          ],
        },
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
    const hasDates = group.events.size > 0;
    for (const event of EVENTS) {
      const counts = group.events.get(event);
      if (hasDates && (counts !== undefined || !group.unavailable.has(event))) {
        series.push({ key: event, label: event, tone: event });
        marks.push(...(await this.seriesMarks(key, event, counts ?? new Map<number, number>())));
      }
    }
    return {
      id: `movement:${key}`,
      accessibleLabel: `Cumulative retained events · ${group.label}`,
      kind: 'lines',
      layout: 'facets',
      emptyMessage: hasDates ? undefined : 'No usable event dates',
      facet: {
        key,
        label: group.label,
        actionId: `focus:${key}`,
        description: unavailableDescription(group.unavailable),
      },
      x: {
        ...numeric('Through date', this.ctx.calendar.toDay - this.ctx.calendar.fromDay),
        tickLabels: this.ctx.calendar.buckets.map(
          (bucket) => [bucket.toDay - this.ctx.calendar.fromDay, dateOf(bucket.toDay - 1)] as const,
        ),
      },
      y: numeric('Cumulative tasks', this.maximum, 0, 'count'),
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
    page = groupPage(ctx.request.page, keys.length),
    charts: StatisticsChartModel[] = [];
  const focused =
    ctx.request.focusKey !== undefined && model.groups.has(ctx.request.focusKey)
      ? ctx.request.focusKey
      : undefined;
  const visible = focused === undefined ? keys.slice(page * 12, (page + 1) * 12) : [focused];
  const chartActions: Array<readonly [string, StatisticsAction]> = [];
  const originMarks: StatisticsMark[] = [];
  const coverage = [];
  for (const key of visible) {
    charts.push(await model.chart(key));
    const group = required(model.groups.get(key));
    chartActions.push([`focus:${key}`, { type: 'focus', label: group.label, focusKey: key }]);
    originMarks.push(...projectOrigins(ctx, key, group));
    for (const [event, indices] of group.unavailable)
      coverage.push(
        metric(
          `movement-unavailable:${key}:${event}`,
          `${group.label} · ${event} dates unavailable`,
          indices.length,
          {
            role: 'coverage',
            selectionId: ctx.evidence.tasks(`movement-unavailable:${key}:${event}`, indices),
          },
        ),
      );
  }
  const originSeries = ORIGINS;
  const metrics = originMetrics(ctx, model);
  return finish(
    ctx,
    [
      {
        id: 'movement',
        title:
          focused === undefined
            ? 'Project movement'
            : `Project movement · ${required(model.groups.get(focused)).label}`,
        reading: `Recorded task events by current project · tasks and subtasks · ${focused === undefined ? positions(page, keys.length) : 'Within selected scope'}. Zero precedes this period; points show bucket endpoints.`,
        context:
          'Cumulative retained events classified by current project. Zero origin precedes the period. Missing date series are unavailable; this does not reconstruct historical backlog.',
        metrics: [...(await dateEligibility(ctx, EVENTS)), ...coverage],
        charts,
        legend: EVENTS.map((key) => ({
          key,
          label: key[0]?.toUpperCase() + key.slice(1),
          tone: key,
        })),
      },
      {
        ...originSection({
          model,
          visible,
          originMax: model.originMaximum,
          originSeries,
          originMarks,
        }),
        metrics,
      },
    ],
    movementActions(focused, page, keys.length),
    chartActions,
  );
}
function originMetrics(ctx: StatisticsContext, model: Movement): StatisticsSection['metrics'] {
  return ORIGINS.map((origin) =>
    metric(
      `completion-origin:${origin.key}`,
      `All projects in scope · ${origin.label}`,
      (model.origins.get(origin.key) ?? []).length,
      ctx.evidence.tasks(`completion-origin:${origin.key}`, model.origins.get(origin.key) ?? []),
    ),
  );
}
function movementActions(
  focused: string | undefined,
  page: number,
  total: number,
): StatisticsAction[] {
  return focused === undefined
    ? pageActions(page, total, 12)
    : [{ type: 'focus', label: 'Back to projects', focusKey: undefined }];
}
function projectOrigins(
  ctx: StatisticsContext,
  key: string,
  group: MovementGroup,
): StatisticsMark[] {
  let base = 0;
  return ORIGINS.map((origin) => {
    const indices = group.origins.get(origin.key) ?? [],
      x = base;
    base += indices.length;
    return {
      key: `${key}:${origin.key}`,
      x,
      x2: base,
      y: key,
      series: origin.key,
      weight: indices.length,
      label: group.label,
      observation: {
        title: group.label,
        values: [{ label: origin.label, value: indices.length, unit: 'tasks' }],
      },
      selectionId: ctx.evidence.tasks(`origin:${key}:${origin.key}`, indices),
    };
  });
}
function originSection({
  model,
  visible,
  originMax,
  originSeries,
  originMarks,
}: {
  model: Movement;
  visible: string[];
  originMax: number;
  originSeries: StatisticsChartModel['series'];
  originMarks: StatisticsMark[];
}): StatisticsSection {
  return {
    id: 'completion-origins',
    title: 'Completions: new work or older work?',
    context: 'Current project membership; same project page as Movement.',
    metrics: [],
    legend: originSeries,
    charts: [
      {
        id: 'completion-origins',
        accessibleLabel: 'Completed tasks by project and creation origin',
        kind: 'bars',
        layout: 'stacked',
        x: numeric('Completed tasks', originMax, 0, 'count'),
        y: {
          type: 'band',
          label: 'Project',
          categories: visible,
          tickLabels: visible.map((key) => [key, required(model.groups.get(key)).label] as const),
        },
        series: originSeries,
        marks: originMarks,
      },
    ],
  };
}
function overdueSeries(overdue: number, count: number): string {
  if (overdue === count) return 'overdue';
  return overdue > 0 ? 'mixed' : 'not-overdue';
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
const AGE_LABELS = ['0–7', '8–14', '15–30', '31–60', '61+', 'Age unavailable'];
class Aging {
  readonly open: number[] = [];
  readonly unknown: number[] = [];
  readonly projects = new Map<string, AgeGroup>();
  private readonly labels = projectLabels(this.ctx);
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
        label: this.labels.get(task.projectKey) ?? task.projectName,
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
      const x = Math.min(29, Math.floor((point.age / axisExtent(this.maxAge)) * 30)),
        y = Math.min(19, Math.floor((point.minutes / axisExtent(this.maxMinutes)) * 20)),
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
  private mark(key: string, point: AgePoint): StatisticsMark {
    return {
      key,
      x: point.age,
      y: point.minutes,
      x2: this.dense ? point.age + axisExtent(this.maxAge) / 30 : undefined,
      y2: this.dense ? point.minutes + axisExtent(this.maxMinutes) / 20 : undefined,
      weight: point.indices.length,
      overdue: point.overdue,
      series: overdueSeries(point.overdue, point.indices.length),
      selectionId: this.ctx.evidence.tasks(`aging:${key}`, point.indices),
      observation: {
        title: this.dense ? 'Open tasks in range' : 'Current open tasks',
        values: [
          this.coordinate('Days since creation', point.age, {
            maximum: this.maxAge,
            bins: 30,
            unit: 'days',
          }),
          this.coordinate('Recorded time (all time)', point.minutes, {
            maximum: this.maxMinutes,
            bins: 20,
            unit: 'minutes',
          }),
          { label: 'Tasks', value: point.indices.length, unit: 'tasks' },
          ...(point.overdue > 0 ? [{ label: 'Overdue', value: point.overdue, unit: 'tasks' }] : []),
        ],
      },
    };
  }
  emptyMessage(): string | undefined {
    if (this.open.length === 0) return 'No current open tasks in scope';
    if (this.open.length === this.unknown.length)
      return 'All current open tasks have age unavailable';
    return undefined;
  }
  chart(): StatisticsChartModel {
    const marks = [...this.points].map(([key, point]) => this.mark(key, point));
    return {
      id: 'aging',
      accessibleLabel: 'Current task age versus all-time recorded minutes',
      kind: 'scatter',
      layout: this.dense ? 'density' : undefined,
      intensityScale: this.dense
        ? { domain: [0, Math.max(0, ...marks.map((mark) => mark.weight ?? 0))], unit: 'tasks' }
        : undefined,
      x: {
        ...numeric('Days since creation', this.maxAge, 0, 'days'),
        ticks: this.maxAge === 0 ? [0] : undefined,
      },
      y: {
        ...numeric('Recorded time (all time)', this.maxMinutes, 0, 'minutes'),
        ticks: this.maxMinutes === 0 ? [0] : undefined,
      },
      series: [
        { key: 'overdue', label: 'Overdue', tone: 'overdue' },
        { key: 'mixed', label: 'Mixed group', tone: 'cancelled' },
        { key: 'not-overdue', label: 'Not overdue', tone: 'accent' },
      ],
      marks,
    };
  }
  private coordinate(
    label: string,
    value: number,
    axis: { maximum: number; bins: number; unit: string },
  ): StatisticsObservation['values'][number] {
    const { maximum, bins, unit } = axis,
      inclusiveMaximum = value >= ((bins - 1) * maximum) / bins,
      to = inclusiveMaximum ? maximum : value + maximum / bins;
    return {
      label,
      value,
      unit,
      range: this.dense ? { from: value, to, inclusiveMaximum } : undefined,
    };
  }
  async composition(): Promise<{ charts: StatisticsChartModel[]; keys: string[]; page: number }> {
    const keys = await sorted(
        [...this.projects.keys()],
        (a, z) => a.localeCompare(z),
        this.ctx.budget,
      ),
      page = groupPage(this.ctx.request.page, keys.length);
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
      x: { ...bands('Age days', AGE_LABELS), finite: true },
      y: numeric('Tasks', maximum, 0, 'count'),
      series: [
        { key: 'known', label: 'Known age', tone: 'accent' },
        { key: 'unavailable', label: 'Age unavailable', tone: 'muted' },
      ],
      marks: group.bands.map((indices, i) => ({
        key: `${key}:${i}`,
        x: required(AGE_LABELS[i]),
        y: indices.length,
        series: i === 5 ? 'unavailable' : 'known',
        selectionId: this.ctx.evidence.tasks(`age-project:${key}:${i}`, indices),
      })),
    };
  }
}
async function aging(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  const model = new Aging(ctx);
  await model.prepare();
  const composition = await model.composition(),
    chart = model.chart();
  return finish(
    ctx,
    [
      {
        id: 'aging',
        title: 'Current open task age and recorded time',
        reading: `Live tasks and subtasks · each node’s own recorded time. ${chart.layout === 'density' ? 'Fill shows task count; outlines show overdue status.' : 'Point size shows task count; color shows overdue status.'}`,
        emptyMessage: model.emptyMessage(),
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
            'Age unavailable',
            model.unknown.length,
            ctx.evidence.tasks('unknown-age', model.unknown),
          ),
        ],
        charts: [chart],
        legend: chart.series.map((series) => ({
          ...series,
          label: chart.layout === 'density' ? `${series.label} outline` : series.label,
        })),
      },
      {
        id: 'age-composition',
        title: 'Age composition by project',
        reading: positions(composition.page, composition.keys.length),
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
  return finish(ctx, result.sections, result.actions, result.chartActions);
}
