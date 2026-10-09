import { dateInterval } from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { BucketDurations, contribution, type RecordedSpan } from './statisticsIntervals';
import { metric } from './statisticsViews';
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
  groups: Group[] = [];
  total = 0;
  focusedMaximum = 0;
  focused: Group | undefined;
  private readonly buckets: BucketDurations;
  constructor(
    private readonly ctx: StatisticsContext,
    private readonly spans: readonly RecordedSpan[],
  ) {
    this.buckets = new BucketDurations(ctx.calendar);
  }
  private label(group: { key: string; label: string }, names: ReadonlyMap<string, number>): string {
    if (this.ctx.request.group === 'tag' && group.key !== 'untagged') return `#${group.label}`;
    if (this.ctx.request.group === 'priority') return `Priority ${group.label}`;
    return group.key.startsWith('project:') && (names.get(group.label) ?? 0) > 1
      ? `${group.label} · ${group.key.slice(8)}`
      : group.label;
  }
  private async initialize(): Promise<void> {
    const names = new Map<string, number>();
    for (const project of this.ctx.dataset.projects) {
      names.set(project.name, (names.get(project.name) ?? 0) + 1);
      await this.ctx.budget.step();
    }
    for (const task of this.ctx.dataset.tasks) {
      if (inScope(task, this.ctx.request.scope)) await this.initializeTask(task, names);
      await this.ctx.budget.step();
    }
  }
  private async initializeTask(
    task: StatisticsTask,
    names: ReadonlyMap<string, number>,
  ): Promise<void> {
    this.nodeTime.set(task.index, 0);
    for (const group of groupsFor(task, this.ctx.request.group)) {
      if (!this.totals.has(group.key))
        this.totals.set(group.key, { ...group, label: this.label(group, names), value: 0 });
      await this.ctx.budget.step();
    }
  }
  async prepare(): Promise<void> {
    await this.initialize();
    for (const span of this.spans) {
      const value = (span.end - span.start) / 60000;
      this.total += value;
      this.nodeTime.set(span.owner, (this.nodeTime.get(span.owner) ?? 0) + value);
      const memberships = groupsFor(
        required(this.ctx.dataset.tasks[span.owner]),
        this.ctx.request.group,
      );
      for (const group of memberships) {
        required(this.totals.get(group.key)).value += value;
        await this.ctx.budget.step();
      }
      if (memberships.some((group) => group.key === this.ctx.request.focusKey))
        this.buckets.add(span);
      await this.ctx.budget.step();
    }
    this.focusedMaximum = Math.max(0, ...this.buckets.values());
    this.groups = await sorted(
      this.totals.values(),
      (a, z) => rankedNumber(z.value, a.value, () => a.key.localeCompare(z.key)),
      this.ctx.budget,
    );
    this.focused = this.totals.get(this.ctx.request.focusKey ?? '');
  }
  private entryAmount(
    entry: StatisticsEntry,
    key: string,
    window: readonly [number, number],
  ): number | undefined {
    const task = required(this.ctx.dataset.tasks[entry.owner]);
    if (
      !inScope(task, this.ctx.request.scope) ||
      !groupsFor(task, this.ctx.request.group).some((group) => group.key === key)
    )
      return undefined;
    const amount = contribution(entry, window[0], window[1], this.ctx.request.nowMs);
    return amount > 0 ? amount : undefined;
  }
  private async ranking(): Promise<StatisticsChartModel> {
    const marks: StatisticsMark[] = [];
    for (const group of this.groups) {
      marks.push({
        key: group.key,
        x: group.value,
        x2: 0,
        y: group.key,
        weight: group.value,
        label: group.label,
        selectionId: `allocation-focus:${group.key}`,
        observation: {
          title: group.label,
          values: [{ label: 'Recorded time', value: group.value, unit: 'min' }],
          ...(group.value === 0 ? { note: 'No recorded time in this period' } : {}),
        },
      });
      await this.ctx.budget.step();
    }
    return {
      id: `allocation-ranking:${this.ctx.request.group}`,
      accessibleLabel: 'Groups ranked by recorded minutes',
      kind: 'bars',
      rowViewport: true,
      x: numeric('Recorded minutes', this.groups[0]?.value ?? 0, 0, 'minutes'),
      y: {
        ...bands(
          '',
          this.groups.map((group) => group.key),
        ),
        tickLabels: this.groups.map((group) => [group.key, group.label]),
      },
      series: [],
      marks,
    };
  }
  async chart(): Promise<StatisticsChartModel> {
    if (this.focused === undefined) return this.ranking();
    const group = this.focused,
      marks: StatisticsMark[] = [],
      values = this.buckets.values();
    for (let i = 0; i < values.length; i++) {
      const value = required(values[i]),
        bucket = required(this.ctx.calendar.buckets[i]),
        id = `allocation:${group.key}:${i}`;
      const label = dateInterval(bucket.fromDay, bucket.toDay);
      marks.push({
        key: id,
        x: bucket.key,
        y: value,
        weight: value,
        observation: {
          title: label,
          values: [{ label: 'Recorded time', value, unit: 'min' }],
          ...(bucket.partial === true ? { note: 'Through observation time' } : {}),
        },
        selectionId:
          value > 0
            ? this.ctx.evidence.entryQuery(id, (entry) =>
                this.entryAmount(entry, group.key, [bucket.startMs, bucket.endMs]),
              )
            : undefined,
      });
      await this.ctx.budget.step();
    }
    return {
      id: 'allocation-focus',
      accessibleLabel: `Recorded time · ${group.label}`,
      kind: 'bars',
      x: {
        ...bands(
          '',
          this.ctx.calendar.buckets.map((bucket) => bucket.key),
        ),
        tickLabels: this.ctx.calendar.buckets.map((bucket) => [
          bucket.key,
          dateInterval(bucket.fromDay, bucket.toDay),
        ]),
      },
      y: numeric('Recorded minutes', this.focusedMaximum, 0, 'minutes'),
      series: [],
      marks: group.value === 0 ? [] : marks,
    };
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
    share = model.total === 0 ? [] : await shareMarks(ctx, ranks, model.total);
  return {
    id: 'concentration',
    title: 'Time across tasks',
    reading:
      'All tasks and subtasks in scope, ordered by recorded time, including those with none in this period.',
    ...(model.total === 0 ? { emptyMessage: 'No recorded time in this period' } : {}),
    metrics: [metric('task-denominator', 'Tasks and subtasks', ranks.length)],
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
    y: (amount.cumulative / amount.total) * 100,
    observation: {
      title: `Top ${end} of ${ranks.length} tasks and subtasks`,
      values: [
        { label: 'Recorded time', value: amount.cumulative, unit: 'min' },
        { label: 'Total recorded time', value: amount.total, unit: 'min' },
        { label: 'Share', value: (amount.cumulative / amount.total) * 100, unit: '%' },
      ],
    },
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
): Promise<{
  sections: StatisticsSection[];
  actions: StatisticsAction[];
  chartActions: ReadonlyArray<readonly [string, StatisticsAction]>;
}> {
  const model = new Allocation(ctx, spans);
  await model.prepare();
  const chart = await model.chart();
  const chartActions: Array<readonly [string, StatisticsAction]> = [];
  for (const group of model.groups) {
    chartActions.push([
      `allocation-focus:${group.key}`,
      { type: 'focus', label: group.label, focusKey: group.key },
    ]);
    await ctx.budget.step();
  }
  return {
    sections: [
      {
        id: 'allocation',
        title:
          model.focused === undefined
            ? 'Recorded time allocation'
            : `Recorded time · ${model.focused.label}`,
        reading:
          ctx.request.group === 'tag'
            ? 'Tags overlap; time can appear under more than one tag.'
            : 'Each recording belongs to one group.',
        ...(model.focused?.value === 0 ? { emptyMessage: 'No recorded time in this period' } : {}),
        metrics: [metric('group-count', 'Groups', model.groups.length)],
        charts: [chart],
        legend: [],
      },
      await concentration(ctx, model),
    ],
    actions:
      model.focused === undefined
        ? []
        : [
            {
              type: 'focus',
              label: `All ${{ project: 'projects', tag: 'tags', priority: 'priorities' }[ctx.request.group]}`,
              focusKey: undefined,
            },
          ],
    chartActions,
  };
}
