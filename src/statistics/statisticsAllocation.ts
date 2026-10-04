import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { BucketDurations, contribution, type RecordedSpan } from './statisticsIntervals';
import { metric, pageActions } from './statisticsViews';
import { rankedNumber, required, sorted } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsEntry,
  StatisticsRequest,
  StatisticsSection,
  StatisticsTask,
} from './types';
interface Group {
  key: string;
  label: string;
  value: number;
}
interface RenderedGroup extends Group {
  values: number[];
}
interface RankedTask {
  owner: number;
  value: number;
}
function groupsFor(
  task: StatisticsTask,
  group: StatisticsRequest['group'],
): Array<{ key: string; label: string }> {
  if (group === 'project') return [{ key: task.projectKey, label: task.projectName }];
  if (group === 'priority') return [{ key: `priority:${task.priority}`, label: task.priority }];
  return task.tags.length === 0
    ? [{ key: 'untagged', label: 'Untagged' }]
    : task.tags.map((tag) => ({ key: `tag:${tag}`, label: tag }));
}
class Allocation {
  readonly totals = new Map<string, Group>();
  readonly nodeTime = new Map<number, number>();
  readonly rendered: RenderedGroup[] = [];
  groups: Group[] = [];
  total = 0;
  maximum = 0;
  private readonly visible = new Set<string>();
  private readonly accumulators = new Map<string, BucketDurations>();
  readonly page: number;
  constructor(
    private readonly ctx: StatisticsContext,
    private readonly spans: readonly RecordedSpan[],
  ) {
    this.page = Math.max(0, Math.floor(ctx.request.page ?? 0));
  }
  private async initialize(): Promise<void> {
    for (const task of this.ctx.dataset.tasks) {
      if (inScope(task, this.ctx.request.scope)) {
        this.nodeTime.set(task.index, 0);
        for (const group of groupsFor(task, this.ctx.request.group)) {
          if (!this.totals.has(group.key)) this.totals.set(group.key, { ...group, value: 0 });
          await this.ctx.budget.step();
        }
      }
      await this.ctx.budget.step();
    }
  }
  private async totalsFromEntries(): Promise<void> {
    for (const span of this.spans) {
      const value = (span.end - span.start) / 60000;
      this.total += value;
      this.nodeTime.set(span.owner, (this.nodeTime.get(span.owner) ?? 0) + value);
      for (const group of groupsFor(
        required(this.ctx.dataset.tasks[span.owner]),
        this.ctx.request.group,
      )) {
        required(this.totals.get(group.key)).value += value;
        await this.ctx.budget.step();
      }
      await this.ctx.budget.step();
    }
  }
  async prepare(): Promise<void> {
    await this.initialize();
    await this.totalsFromEntries();
    this.groups = await sorted(
      this.totals.values(),
      (a, z) => rankedNumber(z.value, a.value, () => a.key.localeCompare(z.key)),
      this.ctx.budget,
    );
    const shown = this.groups.slice(this.page * 12, (this.page + 1) * 12);
    for (const group of shown) {
      this.visible.add(group.key);
      this.accumulators.set(group.key, new BucketDurations(this.ctx.calendar));
    }
    const remainder = await this.bucketDurations();
    for (const group of shown)
      this.rendered.push({ ...group, values: required(this.accumulators.get(group.key)).values() });
    if (this.ctx.request.group !== 'tag' && this.groups.length > shown.length) {
      let total = 0;
      for (const group of this.groups) {
        if (!this.visible.has(group.key)) total += group.value;
        await this.ctx.budget.step();
      }
      this.rendered.push({
        key: 'remainder',
        label: 'Remaining groups',
        value: total,
        values: remainder.values(),
      });
    }
  }
  private async bucketDurations(): Promise<BucketDurations> {
    const remainder = new BucketDurations(this.ctx.calendar),
      grand = new BucketDurations(this.ctx.calendar);
    for (const span of this.spans) {
      grand.add(span);
      for (const group of groupsFor(
        required(this.ctx.dataset.tasks[span.owner]),
        this.ctx.request.group,
      )) {
        const accumulator = this.accumulators.get(group.key);
        if (accumulator !== undefined) accumulator.add(span);
        else if (this.ctx.request.group !== 'tag') remainder.add(span);
        await this.ctx.budget.step();
      }
      await this.ctx.budget.step();
    }
    this.maximum = Math.max(0, ...grand.values());
    return remainder;
  }
  private matches(task: StatisticsTask, key: string): boolean {
    if (!inScope(task, this.ctx.request.scope)) return false;
    const membership = groupsFor(task, this.ctx.request.group);
    return key === 'remainder'
      ? membership.some((group) => !this.visible.has(group.key))
      : membership.some((group) => group.key === key);
  }
  private entryAmount(
    entry: StatisticsEntry,
    key: string,
    window: readonly [number, number],
  ): number | undefined {
    if (!this.matches(required(this.ctx.dataset.tasks[entry.owner]), key)) return undefined;
    const amount = contribution(entry, window[0], window[1], this.ctx.request.nowMs);
    return amount > 0 ? amount : undefined;
  }
  selection(key: string): string {
    return this.ctx.evidence.entryQuery(`allocation-group:${key}`, (entry) =>
      this.entryAmount(entry, key, [this.ctx.calendar.startMs, this.ctx.calendar.endMs]),
    );
  }
  private async marks(group: RenderedGroup, base: number[]): Promise<StatisticsMark[]> {
    const marks: StatisticsMark[] = [];
    for (let i = 0; i < group.values.length; i++) {
      const value = required(group.values[i]),
        bucket = required(this.ctx.calendar.buckets[i]),
        id = `allocation:${group.key}:${i}`,
        previous = this.ctx.request.group === 'tag' ? 0 : required(base[i]);
      base[i] = previous + value;
      marks.push({
        key: id,
        x: bucket.key,
        y: previous + value,
        y2: previous,
        weight: value,
        series: group.key,
        selectionId: this.ctx.evidence.entryQuery(id, (entry) =>
          this.entryAmount(entry, group.key, [bucket.startMs, bucket.endMs]),
        ),
      });
      await this.ctx.budget.step();
    }
    return marks;
  }
  private chart(marks: readonly StatisticsMark[], group?: RenderedGroup): StatisticsChartModel {
    const series = this.rendered.map((g) => ({
      key: g.key,
      label: g.label,
      tone: 'accent' as const,
    }));
    return {
      id: group === undefined ? 'allocation' : `allocation:${group.key}`,
      accessibleLabel:
        group === undefined ? 'Recorded time by date and group' : `Recorded time · ${group.label}`,
      kind: 'bars',
      layout: group === undefined ? 'stacked' : 'facets',
      ...(group === undefined ? {} : { facet: { key: group.key, label: group.label } }),
      x: bands(
        'Date',
        this.ctx.calendar.buckets.map((v) => v.key),
      ),
      y: numeric('Recorded minutes', this.maximum),
      series,
      marks,
    };
  }
  async charts(): Promise<StatisticsChartModel[]> {
    const charts: StatisticsChartModel[] = [],
      allMarks: StatisticsMark[] = [],
      base = Array<number>(this.ctx.calendar.buckets.length).fill(0);
    for (const group of this.rendered) {
      const marks = await this.marks(group, base);
      if (this.ctx.request.group === 'tag') charts.push(this.chart(marks, group));
      else allMarks.push(...marks);
    }
    if (this.ctx.request.group !== 'tag') charts.push(this.chart(allMarks));
    return charts;
  }
}
async function concentration(
  ctx: StatisticsContext,
  model: Allocation,
): Promise<StatisticsSection> {
  const items: RankedTask[] = [];
  for (const [owner, value] of model.nodeTime) {
    items.push({ owner, value });
    await ctx.budget.step();
  }
  const ranks = await sorted(
      items,
      (a, z) => rankedNumber(z.value, a.value, () => a.owner - z.owner),
      ctx.budget,
    ),
    share = await shareMarks(ctx, ranks, model.total);
  return {
    id: 'concentration',
    title: 'Time across tasks',
    context:
      'Includes eligible zero-time tasks. Recorded time does not establish whether a task was started.',
    metrics: [metric('task-denominator', 'Eligible tasks', ranks.length)],
    charts: [
      {
        id: 'time-share',
        accessibleLabel: 'Cumulative recorded time share across tasks',
        kind: 'lines',
        x: numeric('Task share', 100, 0, '%'),
        y: numeric('Recorded time share', 100, 0, '%'),
        series: [{ key: 'share', label: 'Recorded time share', tone: 'accent' }],
        marks: share,
        guides: [{ axis: 'y', value: 50, label: '50% of time' }],
      },
    ],
    legend: [],
  };
}
async function shareMarks(
  ctx: StatisticsContext,
  ranks: readonly RankedTask[],
  total: number,
): Promise<StatisticsMark[]> {
  const points: Array<{ end: number; cumulative: number }> = [];
  let cumulative = 0;
  for (let i = 0; i < ranks.length; i++) {
    cumulative += required(ranks[i]).value;
    if (i === ranks.length - 1 || required(ranks[i + 1]).value !== required(ranks[i]).value)
      points.push({ end: i + 1, cumulative });
    await ctx.budget.step();
  }
  const marks: StatisticsMark[] = [{ key: 'origin', x: 0, y: 0 }],
    stride = Math.max(1, Math.ceil(points.length / 598));
  for (let i = 0; i < points.length; i++) {
    if (i % stride === 0 || i === points.length - 1) {
      const point = required(points[i]);
      marks.push(shareMark(ctx, ranks, point.end, { cumulative: point.cumulative, total }));
    }
    await ctx.budget.step();
  }
  return marks;
}
function shareMark(
  ctx: StatisticsContext,
  ranks: readonly RankedTask[],
  end: number,
  amount: { cumulative: number; total: number },
): StatisticsMark {
  return {
    key: `share:${end}`,
    x: (end / ranks.length) * 100,
    y: amount.total === 0 ? 0 : (amount.cumulative / amount.total) * 100,
    denominator: ranks.length,
    numerator: end,
    selectionId: ctx.evidence.rows(`share:${end}`, end, (index) =>
      ctx.evidence.taskRow(required(ctx.dataset.tasks[required(ranks[index]).owner])),
    ),
  };
}
export async function allocation(
  ctx: StatisticsContext,
  spans: readonly RecordedSpan[],
): Promise<{ sections: StatisticsSection[]; actions: StatisticsAction[] }> {
  const model = new Allocation(ctx, spans);
  await model.prepare();
  const charts = await model.charts();
  return {
    sections: [
      {
        id: 'allocation',
        title: 'Recorded time allocation',
        context:
          ctx.request.group === 'tag'
            ? 'Tags overlap: each unique normalized tag receives the full duration. Grand total counts each entry once.'
            : 'Projects and priorities partition recorded time. Remaining groups are inspectable and pageable.',
        metrics: [metric('group-count', 'Groups', model.groups.length)],
        charts,
        legend: model.rendered.map((group) => ({
          key: group.key,
          label: group.label,
          tone: 'accent',
          value: group.value,
          selectionId: model.selection(group.key),
        })),
      },
      await concentration(ctx, model),
    ],
    actions: pageActions(model.page, model.groups.length, 12),
  };
}
