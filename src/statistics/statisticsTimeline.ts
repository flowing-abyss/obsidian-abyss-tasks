import { dateOf, dayOf, midnight, weekFloor, type StatisticsBucket } from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { BucketDurations, contribution, type RecordedSpan } from './statisticsIntervals';
import { metric } from './statisticsViews';
import { required } from './statisticsWork';
import type { StatisticsAction, StatisticsContext, StatisticsSection } from './types';
interface Lane {
  day: number;
  start: number;
  end: number;
}
interface Fragment {
  span: RecordedSpan;
  lane: Lane;
  start: number;
  end: number;
}
class Timeline {
  readonly week: number;
  readonly days: Lane[];
  readonly densityBuckets: StatisticsBucket[] = [];
  readonly dayTotals: number[] = [];
  private readonly fragments: Fragment[] = [];
  private fragmentCount = 0;
  private readonly daily: BucketDurations;
  private readonly density: BucketDurations;
  private readonly overview: BucketDurations;
  constructor(private readonly ctx: StatisticsContext) {
    const { request: r, calendar: c } = ctx;
    const requested =
      r.weekStart === undefined
        ? weekFloor(c.todayDay, r.firstDayOfWeek)
        : weekFloor(dayOf(r.weekStart), r.firstDayOfWeek);
    this.week = Math.max(
      weekFloor(c.fromDay, r.firstDayOfWeek),
      Math.min(requested, weekFloor(c.todayDay, r.firstDayOfWeek)),
    );
    this.days = Array.from({ length: 7 }, (_, i) => ({
      day: this.week + i,
      start: midnight(this.week + i, r),
      end: midnight(this.week + i + 1, r),
    }));
    this.makeDensityBuckets();
    const dayBuckets = this.days.map((lane) => ({
      key: dateOf(lane.day),
      fromDay: lane.day,
      toDay: lane.day + 1,
      startMs: lane.start,
      endMs: lane.end,
    }));
    this.daily = new BucketDurations({ ...c, buckets: dayBuckets });
    this.density = new BucketDurations({ ...c, buckets: this.densityBuckets });
    this.overview = new BucketDurations(c);
  }
  private makeDensityBuckets(): void {
    for (const lane of this.days)
      for (let start = lane.start; start < lane.end; start += 3600000)
        this.densityBuckets.push({
          key: `${lane.day}:${start}`,
          fromDay: lane.day,
          toDay: lane.day + 1,
          startMs: start,
          endMs: Math.min(start + 3600000, lane.end),
        });
  }
  async prepare(spans: readonly RecordedSpan[]): Promise<void> {
    for (const span of spans) {
      this.overview.add(span);
      const clipped = {
        ...span,
        start: Math.max(span.start, required(this.days[0]).start),
        end: Math.min(span.end, required(this.days[6]).end),
      };
      if (clipped.end > clipped.start) {
        this.daily.add(clipped);
        this.density.add(clipped);
        await this.fragmentsFor(clipped);
      }
      await this.ctx.budget.step();
    }
    this.dayTotals.push(...this.daily.values());
  }
  private async fragmentsFor(span: RecordedSpan): Promise<void> {
    for (const lane of this.days) {
      const start = Math.max(span.start, lane.start),
        end = Math.min(span.end, lane.end);
      if (end > start) {
        this.fragmentCount++;
        if (this.fragments.length < 701) this.fragments.push({ span, lane, start, end });
      }
      await this.ctx.budget.step();
    }
  }
  private intervalMarks(): StatisticsMark[] {
    return this.fragments.map((fragment) => {
      const entry = required(this.ctx.dataset.entries[fragment.span.entry]),
        key = `timeline:${entry.key}:${fragment.lane.day}`,
        duration = (fragment.end - fragment.start) / 60000;
      return {
        key,
        x: (fragment.start - fragment.lane.start) / 60000,
        x2: (fragment.end - fragment.lane.start) / 60000,
        y: dateOf(fragment.lane.day),
        weight: duration,
        label: required(this.ctx.dataset.tasks[fragment.span.owner]).title,
        selectionId: this.ctx.evidence.rows(key, 1, () =>
          this.ctx.evidence.entryRow(entry, duration),
        ),
      };
    });
  }
  private selection(id: string, window: readonly [number, number]): string {
    return this.ctx.evidence.entryQuery(id, (entry) => {
      if (!inScope(required(this.ctx.dataset.tasks[entry.owner]), this.ctx.request.scope))
        return undefined;
      const amount = contribution(
        entry,
        Math.max(this.ctx.calendar.startMs, window[0]),
        Math.min(this.ctx.calendar.endMs, window[1]),
        this.ctx.request.nowMs,
      );
      return amount > 0 ? amount : undefined;
    });
  }
  private densityMarks(): StatisticsMark[] {
    const marks: StatisticsMark[] = [];
    const values = this.density.values();
    for (let i = 0; i < values.length; i++) {
      const value = required(values[i]);
      if (value === 0) continue;
      const bucket = required(this.densityBuckets[i]),
        lane = required(this.days[bucket.fromDay - this.week]);
      marks.push({
        key: bucket.key,
        x: (bucket.startMs - lane.start) / 60000,
        x2: (bucket.endMs - lane.start) / 60000,
        y: dateOf(lane.day),
        weight: value,
        selectionId: this.selection(`timeline-density:${bucket.key}`, [
          bucket.startMs,
          bucket.endMs,
        ]),
      });
    }
    return marks;
  }
  charts(): StatisticsChartModel[] {
    const dense = this.fragmentCount > 700,
      values = this.overview.values();
    return [
      {
        id: 'timeline',
        accessibleLabel: 'Recorded intervals in the selected local week',
        kind: 'timeline',
        layout: dense ? 'density' : undefined,
        x: numeric(
          'Elapsed minutes since local midnight',
          Math.max(...this.days.map((lane) => (lane.end - lane.start) / 60000)),
        ),
        y: bands(
          'Local day',
          this.days.map((lane) => dateOf(lane.day)),
        ),
        series: [],
        marks: dense ? this.densityMarks() : this.intervalMarks(),
      },
      {
        id: 'timeline-overview',
        accessibleLabel: 'Recorded time across the selected period',
        kind: 'bars',
        x: bands(
          'Date',
          this.ctx.calendar.buckets.map((bucket) => bucket.key),
        ),
        y: numeric('Minutes', Math.max(0, ...values)),
        series: [],
        marks: values.map((value, i) => {
          const bucket = required(this.ctx.calendar.buckets[i]);
          return {
            key: bucket.key,
            x: bucket.key,
            y: value,
            selectionId: this.selection(`overview:${i}`, [bucket.startMs, bucket.endMs]),
          };
        }),
      },
    ];
  }
  actions(): StatisticsAction[] {
    const result: StatisticsAction[] = [],
      { calendar: c, request: r } = this.ctx;
    if (this.week > weekFloor(c.fromDay, r.firstDayOfWeek))
      result.push({ type: 'week', label: 'Previous week', weekStart: dateOf(this.week - 7) });
    if (this.week + 7 <= c.todayDay)
      result.push({ type: 'week', label: 'Next week', weekStart: dateOf(this.week + 7) });
    return result;
  }
}
export async function timeline(
  ctx: StatisticsContext,
  spans: readonly RecordedSpan[],
): Promise<{ sections: StatisticsSection[]; actions: StatisticsAction[] }> {
  const model = new Timeline(ctx);
  await model.prepare(spans);
  return {
    sections: [
      {
        id: 'timeline',
        title: 'Recorded intervals',
        context:
          'Local dated lanes; horizontal position is actual elapsed minutes since local midnight, including DST repeats/gaps.',
        metrics: [
          metric(
            'week-minutes',
            'This week',
            model.dayTotals.reduce((a, z) => a + z, 0),
            { unit: 'minutes' },
          ),
          ...model.days.map((lane, i) =>
            metric(`day:${i}`, dateOf(lane.day), required(model.dayTotals[i]), { unit: 'minutes' }),
          ),
        ],
        charts: model.charts(),
        legend: [],
      },
    ],
    actions: model.actions(),
  };
}
